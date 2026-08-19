/*
 * poolmgr.js — PoolManager + PoolTxn + TxPost, the JS port of the native fund-moving code. Builds, signs
 * and posts every PandaPools transaction command-for-command with the proven mainnet phaseB/phaseC scripts,
 * so on-chain behaviour is identical.
 *
 *   createPool  — ONE atomic tx: fund both reserve coins at the covenant address + post the registry
 *                 announce beacon (dust at the sentinel, params in state), change back. sign: auto.
 *   deposit     — owner grow-in-place (capped at 2×KMIN). sign: auto + owner.
 *   migrate     — owner exit old reserves to $OADR + open a fresh pool (KMIN reset) at a new address +
 *                 new beacon. sign: auto + owner.
 *   close       — owner sweep both reserves to $OADR. sign: owner.
 *   swap        — ONE tx spends + recreates every pool in a route (even pool leg = MINIMA, odd = token),
 *                 funded from the wallet, proceeds to the taker, change back. sign: auto.
 *
 * Fund-critical gotchas honoured: Covenant.scriptArg (never escape `/`); ONE txnstate port per call;
 * `txncheck` gate on response.valid.scripts + validamounts + valid.mmrproofs (NOT the top-level `scripts`
 * COUNT); funding excludes every pool address AND its $OADR (owner-key self-swap trap); grain-clamped kmin;
 * parseok pre-flight before any spend; token-grain floor via Curve; change to the funding coin's OWN
 * address (not $OADR); `newscript trackall` before spending a covenant; plain (non-sci) amounts.
 *
 * RESTRICTED-MDS pending-sign: `txnsign` may return "pending" on a read-restricted dapp (the user approves
 * in the node's Pending panel). We detect it, register the txid, and resume on the next NEWBLOCK
 * (PoolMgr.onNewBlock) once the signatures populate — then finish with txnbasics → txncheck → txnpost.
 * An owner op needs BOTH auto (funding) AND owner-key signatures — both may pend and are handled in order.
 * A WRITE-permission dapp signs immediately and the same code proceeds inline.
 */
var PoolMgr = (function () {
    var D = Decimal;
    var MINIMA = "0x00";
    var ANNOUNCE_DUST = "0.000000001";
    var DUST = new D("0.000000001");
    var GROW_CAP_MULT = new D("2");

    // txid -> { baseline, onSigned, onFail } for a txnsign awaiting the user's pending approval.
    var PENDING = {};
    var statusHook = null;   // optional fn(msg) so the UI can say "approve in Pending Actions…"

    function setStatusHook(fn) { statusHook = fn; }
    function pendingMsg(m) { if (statusHook) statusHook(m); }

    // ---------------------------------------------------------------- low-level helpers
    function errOf(res) {
        if (!res) return "";
        var e = res.error || "";
        return e ? " : " + e : "";
    }
    function isPending(res) {
        if (!res) return false;
        if (res.pending === true) return true;
        if (res.status === false && res.error && String(res.error).toLowerCase().indexOf("pending") >= 0) return true;
        return false;
    }
    function extractTxpowid(res, fallback) {
        var resp = res ? res.response : null;
        if (resp) {
            if (resp.txpowid) return resp.txpowid;
            if (resp.txpow && resp.txpow.txpowid) return resp.txpow.txpowid;
        }
        return fallback;
    }
    function tag() { return Date.now() + "_" + Math.floor(Math.random() * 0xffffff).toString(16); }

    /** Run node commands sequentially, aborting (+ txndelete) on the first status:false / transport error.
     *  These are all NON-signing commands (txncreate/input/output/state) so they never pend. */
    function runChain(cmds, txid, doneCb) {   // doneCb(ok, lastRes)
        var i = 0;
        (function step() {
            if (i >= cmds.length) { doneCb(true, null); return; }
            MDS.cmd(cmds[i], function (res) {
                if (!res || res.status !== true) { MDS.cmd("txndelete id:" + txid); doneCb(false, res); return; }
                i++; step();
            });
        })();
    }

    /** Count the leaf signatures currently on a stored txn (to detect a pending sign completing). */
    function countSigs(entry) {
        try {
            var sigs = entry && entry.witness && entry.witness.signatures;
            if (!sigs || !sigs.length) return 0;
            var n = 0;
            for (var i = 0; i < sigs.length; i++) {
                var s = sigs[i];
                if (s && s.signatures && s.signatures.length) n += s.signatures.length;
                else n += 1;
            }
            return n;
        } catch (e) { return 0; }
    }
    function findTxn(res, txid) {
        if (!res || !res.status || !Array.isArray(res.response)) return null;
        for (var i = 0; i < res.response.length; i++) if (res.response[i].id === txid) return res.response[i];
        return null;
    }

    /** Sign `signers` (["auto"] and/or a hex owner pubkey) in order; each may pend and resume on NEWBLOCK. */
    function signAll(txid, signers, idx, onDone, onFail) {
        if (idx >= signers.length) { onDone(); return; }
        var pk = signers[idx];
        MDS.cmd("txnsign id:" + txid + " publickey:" + pk, function (res) {
            if (res && res.status === true && !isPending(res)) {
                signAll(txid, signers, idx + 1, onDone, onFail); return;   // WRITE fast-path
            }
            if (isPending(res)) {
                waitSign(txid, function () { signAll(txid, signers, idx + 1, onDone, onFail); }, onFail);
                return;
            }
            onFail("signing failed" + errOf(res));
        });
    }

    /** Register a txid whose sign is pending user approval; resumes via onNewBlock when the sig populates. */
    function waitSign(txid, onSigned, onFail) {
        MDS.cmd("txnlist", function (res) {
            var e = findTxn(res, txid);
            PENDING[txid] = { baseline: e ? countSigs(e) : 0, onSigned: onSigned, onFail: onFail };
            pendingMsg("Approve the signature in your node's Pending panel to continue — it will finish automatically.");
        });
    }

    /** Call on every NEWBLOCK. Completes any sign whose signatures have populated since it was queued. */
    function onNewBlock() {
        var ids = Object.keys(PENDING);
        if (!ids.length) return;
        MDS.cmd("txnlist", function (res) {
            ids.forEach(function (txid) {
                var op = PENDING[txid];
                if (!op) return;
                var e = findTxn(res, txid);
                if (!e) { delete PENDING[txid]; op.onFail("the transaction was removed before it could be signed"); return; }
                if (countSigs(e) > op.baseline) { delete PENDING[txid]; op.onSigned(); }
            });
        });
    }

    /** txnbasics → txncheck gate (valid.scripts + validamounts + valid.mmrproofs) → txnpost → txndelete. */
    function finalize(txid, done) {
        MDS.cmd("txnbasics id:" + txid, function (rb) {
            if (!rb || rb.status !== true) { MDS.cmd("txndelete id:" + txid); done.fail("txnbasics failed" + errOf(rb)); return; }
            MDS.cmd("txncheck id:" + txid, function (rc) {
                var resp = rc ? rc.response : null;
                var valid = resp ? resp.valid : null;
                var scriptsOk = PP.truthy(valid && valid.scripts);       // covenant verdict (NOT top-level `scripts` count)
                var amountsOk = PP.truthy(resp && resp.validamounts);
                var mmrOk = PP.truthy(valid && valid.mmrproofs);         // false ⇒ an input was already spent (pool moved)
                if (!scriptsOk || !amountsOk || !mmrOk) {
                    MDS.cmd("txndelete id:" + txid);
                    done.fail(!mmrOk ? "an input coin was already spent (the pool moved) — nothing was posted"
                        : !scriptsOk ? "the pool covenant rejects this transaction — nothing was posted"
                            : "the amounts don't balance — nothing was posted");
                    return;
                }
                MDS.cmd("txnpost id:" + txid, function (rp) {
                    if (rp && rp.status === true) { MDS.cmd("txndelete id:" + txid); done.ok(extractTxpowid(rp, txid)); }
                    else { MDS.cmd("txndelete id:" + txid); done.fail("post rejected" + errOf(rp)); }
                });
            });
        });
    }

    /** build (runChain) → sign (signAll, pending-aware) → finalize. `done` = { ok(txpowid), fail(msg) }. */
    function buildAndPost(txid, cmds, signers, done) {
        runChain(cmds, txid, function (ok, res) {
            if (!ok) { done.fail("building the transaction failed" + errOf(res)); return; }
            signAll(txid, signers, 0,
                function () { finalize(txid, done); },
                function (msg) { MDS.cmd("txndelete id:" + txid); done.fail(msg); });
        });
    }

    // ---------------------------------------------------------------- coin selection
    function coinAmt(c, tokenid) {
        if (PP.isMinima(tokenid)) return PP.dec(c.amount || "0");
        return PP.dec(c.tokenamount !== undefined ? c.tokenamount : (c.amount || "0"));
    }

    /** Largest-first sendable wallet coins for a token summing to >= need. `excludeLower` = {addrLower:true}
     *  (pool covenant addresses AND owner payout addresses) are never selected. cb(coins,sum) or cb(null). */
    function selectCoins(tokenid, needRaw, excludeLower, cb) {
        var need = PP.dec(needRaw);
        if (need.lte(0)) { cb([], new D(0)); return; }
        MDS.cmd("coins relevant:true sendable:true tokenid:" + tokenid, function (res) {
            var arr = (res && res.status && Array.isArray(res.response)) ? res.response : null;
            if (!arr || !arr.length) { cb(null); return; }
            var avail = [];
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i];
                if (!c) continue;
                if (excludeLower && excludeLower[(c.address || "").toLowerCase()]) continue;
                avail.push(c);
            }
            avail.sort(function (a, b) { return coinAmt(b, tokenid).cmp(coinAmt(a, tokenid)); });
            var sel = [], sum = new D(0);
            for (var j = 0; j < avail.length; j++) {
                sel.push(avail[j]);
                sum = sum.plus(coinAmt(avail[j], tokenid));
                if (sum.gte(need)) { cb(sel, sum); return; }
            }
            cb(null);
        });
    }

    // ---------------------------------------------------------------- address derivation (parseok pre-flight)
    function deriveAddress(script, ok, fail) {
        MDS.cmd("runscript script:" + Covenant.scriptArg(script), function (j) {
            var resp = j ? j.response : null;
            var parseok = PP.truthy(resp && resp.parseok);
            var sc = resp ? resp.script : null;
            var a = sc ? (sc.address || "") : "";
            var mx = sc ? (sc.mxaddress || "") : "";
            if (!a) { fail("could not derive the pool address"); return; }
            if (!parseok) { fail("the pool covenant failed to compile (parse error) — aborted before any funds moved, to protect your coins"); return; }
            ok(a, mx);
        });
    }

    // OWNER flows only (refresh/deposit/close — create/migrate register inline): the owner WANTS the pool
    // relevant, so trackall:true is correct — their reserves are their capital.
    function ensureTracked(p, then) {
        MDS.cmd("newscript trackall:true script:" + Covenant.scriptArg(Covenant.script(p.opk, p.oadr, p.tok, p.kmin)), function () { then(); });
    }
    // SWAP path: make the covenant available for txnbasics WITHOUT adopting a stranger's reserves into this
    // wallet's balance. txnbasics reads the script table regardless of the track flag, so trackall:false swaps
    // identically — but the pool's coins never become relevant. A row already on the node (ANY track value) is
    // left untouched: newscript REPLACES an existing row, so re-registering here would downgrade an LP's own
    // trackall:true. Only the node's AFFIRMATIVE "not found" ({"status":false} + its not-found error, via the
    // SUCCESS callback) registers; any AMBIGUOUS failure (timeout-shaped, dropped reply) writes NOTHING — the
    // row may exist and we merely failed to read it. A genuinely-missing row then fails closed at
    // txnbasics/txncheck (valid.scripts false → txndelete) and nothing posts. NOTE the row-exists check leans
    // on j.response being a single non-empty object — an empty-array response would also read "exists" and
    // fail closed downstream, never write a wrong track state.
    function ensureTrackedForSwap(p, then) {
        MDS.cmd("scripts address:" + p.address, function (j) {
            if (j && PP.truthy(j.status) && j.response) { then(); return; }   // row exists → never touch it
            var notFound = j && j.status === false && /not found/i.test(String(j.error || ""));
            if (!notFound) { then(); return; }   // ambiguous failure → no write (see above)
            var script = (p.covenantScript && p.covenantScript.length) ? p.covenantScript
                       : Covenant.script(p.opk, p.oadr, p.tok, p.kmin);
            MDS.cmd("newscript trackall:false script:" + Covenant.scriptArg(script), function () { then(); });
        });
    }
    function ensureTrackedAll(allocs, i, then) {
        if (i >= allocs.length) { then(); return; }
        ensureTrackedForSwap(allocs[i].pool, function () { ensureTrackedAll(allocs, i + 1, then); });
    }

    // ---------------------------------------------------------------- announce-beacon state (one port per call)
    function addAnnounceState(cmds, txid, p) {
        cmds.push("txnstate id:" + txid + " port:0 value:" + p.opk);                 // reclaim key (owner)
        cmds.push("txnstate id:" + txid + " port:1 value:" + Covenant.VERSION_HEX);  // version PP1
        cmds.push("txnstate id:" + txid + " port:2 value:" + p.tok);                 // tokenid
        cmds.push("txnstate id:" + txid + " port:3 value:" + p.oadr);                // owner payout addr
        cmds.push("txnstate id:" + txid + " port:4 value:" + p.opk);                 // owner pubkey
        cmds.push("txnstate id:" + txid + " port:5 value:" + p.kmin);                // product floor
    }

    // ================================================================ RE-ANNOUNCE (Layer 5)
    // Post ONE fresh discovery beacon (dust → sentinel, params in state) for a pool whose beacon has faded from
    // the recent registry window, so strangers' fresh nodes keep rediscovering it. Owner-WALLET funded, change
    // back; spends NO covenant coin and adds NO owner signature (sign auto = funding coins only). The covenant
    // reserves are untouched — this adds no spend authority.
    function reannounce(p, done) {   // done.ok(txpowid), done.fail(msg)
        if (!p || !p.address || !p.opk || !p.tok || !p.oadr || !p.kmin) { done.fail("incomplete pool record"); return; }
        var excl = {}; excl[p.address.toLowerCase()] = true;   // never select a covenant coin
        selectCoins(MINIMA, ANNOUNCE_DUST, excl, function (mfunds, msum) {
            if (!mfunds) { done.fail("no spare MINIMA to re-announce"); return; }
            var txid = "ppann_" + tag();
            var cmds = ["txncreate id:" + txid];
            mfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
            cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + Covenant.SENTINEL + " storestate:true");
            var chg = mfunds.length ? mfunds[0].address : p.oadr;
            var change = msum.minus(PP.dec(ANNOUNCE_DUST));
            if (change.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(change) + " address:" + chg + " storestate:false");
            addAnnounceState(cmds, txid, p);
            buildAndPost(txid, cmds, ["auto"], done);   // sign auto only = funding coins, no $OPK, no covenant coin
        });
    }

    // ================================================================ REFRESH (keep fresh in the cascade)
    // Owner-signed KEEP-FRESH: recreate the two reserve coins IN PLACE — spend coinidM/coinidT and re-output the
    // SAME amounts to the SAME covenant address (owner grow-in-place branch), plus a fresh beacon, one tx. New coin
    // IDs (young → back inside the ~1700-block cascade → visible again to every light node's `coins address:X`, so
    // cross-device discovery + swap work without megammr/server), but address/reserves/KMIN/identity unchanged and
    // NOTHING burned. It's deposit(0). The covenant's GETOUTAMT GTE @AMOUNT makes a mis-build fail CLOSED. Owner-only
    // (spends the covenant → needs $OPK), unlike the node-wide beacon re-announce. Mirrors native PoolManager.refresh.
    function refresh(p, done) {   // done.ok(txpowid), done.fail
        if (!Curve.funded(p) || !p.opk || !p.address || !p.tok || !p.oadr || !p.coinidM || !p.coinidT) {
            done.fail("incomplete pool record"); return;
        }
        var tok = p.tok, tokArg = " tokenid:" + tok;
        var excl = {}; excl[p.address.toLowerCase()] = true;   // never select a covenant coin as funding
        ensureTracked(p, function () {
            selectCoins(MINIMA, ANNOUNCE_DUST, excl, function (mfunds, msum) {   // tiny funding for the beacon dust
                if (!mfunds) { done.fail("no spare MINIMA to refresh the pool"); return; }
                var txid = "pprefresh_" + tag();
                var cmds = ["txncreate id:" + txid];
                cmds.push("txninput id:" + txid + " coinid:" + p.coinidM);   // 0 pool MINIMA (even)
                cmds.push("txninput id:" + txid + " coinid:" + p.coinidT);   // 1 pool token  (odd)
                mfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                // outputs 0/1 recreate the SAME reserves at the SAME address (owner grow branch; GTE holds at equality)
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(PP.dec(p.reserveM)) + " address:" + p.address + " storestate:false");
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(PP.dec(p.reserveT)) + " address:" + p.address + tokArg + " storestate:false");
                // fresh discovery beacon (dust at the sentinel, params in state)
                cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + Covenant.SENTINEL + " storestate:true");
                // MINIMA change to the funding coin's own (non-owner) address — NOT $OADR (see buildCreate rationale)
                var chg = mfunds.length ? mfunds[0].address : p.oadr;
                var change = msum.minus(PP.dec(ANNOUNCE_DUST));
                if (change.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(change) + " address:" + chg + " storestate:false");
                addAnnounceState(cmds, txid, p);
                buildAndPost(txid, cmds, ["auto", p.opk], done);   // sign auto (funding) + $OPK (owner grow branch)
            });
        });
    }

    // ================================================================ CREATE
    function createPool(tokenid, tokDecimals, x0Raw, y0Raw, done) {   // done.created(pool,txpowid), done.fail
        var x0 = PP.dec(x0Raw), y0 = PP.dec(y0Raw);
        if (x0.lte(0) || y0.lte(0)) { done.fail("both reserves must be greater than zero"); return; }
        var y0c = y0.toDP(tokDecimals, D.ROUND_DOWN);   // reserve must be an achievable coin amount
        if (y0c.lte(0)) { done.fail("token amount is below the token's smallest unit"); return; }
        if (!Covenant.sizeOk(x0, y0c)) { done.fail("x0 × y0 must stay under 2^64 — use smaller reserves (or split into several pools)"); return; }
        var kmin;
        try { kmin = Covenant.kmin(x0, y0c); } catch (e) { done.fail(e.message); return; }

        // 1. mint the owner identity ($OADR / $OPK)
        MDS.cmd("newaddress", function (j) {
            var r = j ? j.response : null;
            var oadr = r ? (r.address || "") : "";
            var opk = r ? (r.publickey || "") : "";
            if (!oadr || !opk) { done.fail("could not mint an owner key (grant this app write access to create pools)"); return; }
            // the reply's `total` is the key count AFTER this mint → this key's derivation index; remember
            // it so a later owner-key hunt is exact (and a foreign seed provable with zero mints)
            if (r && Number(r.total) > 0) rememberKidx(opk, Number(r.total) - 1);
            var script = Covenant.script(opk, oadr, tokenid, kmin);
            // 2. derive the canonical covenant address (+ parseok pre-flight)
            deriveAddress(script, function (address, mx) {
                // 3. register so the node tracks + can later spend the pool coins
                MDS.cmd("newscript trackall:true script:" + Covenant.scriptArg(script), function () {
                    var p = {
                        address: address, mxaddress: mx, opk: opk, oadr: oadr, tok: tokenid,
                        kmin: kmin, tokDecimals: tokDecimals, reserveM: x0, reserveT: y0c, tokName: null,
                        covenantScript: script   // authoritative script → stored in the recovery recipe
                    };
                    buildCreate(p, x0, y0c, tokenid, done);
                });
            }, done.fail);
        });
    }

    function buildCreate(p, x0, y0, tokenid, done) {
        var minimaNeed = x0.plus(ANNOUNCE_DUST);
        var excl = {}; excl[p.address.toLowerCase()] = true;
        selectCoins(MINIMA, minimaNeed, excl, function (mfunds, msum) {
            if (!mfunds) { done.fail("insufficient MINIMA to seed the pool"); return; }
            selectCoins(tokenid, y0, excl, function (tfunds, tsum) {
                if (!tfunds) { done.fail("insufficient token balance to seed the pool"); return; }
                var txid = "ppcreate_" + tag();
                var tokArg = " tokenid:" + tokenid;
                var cmds = ["txncreate id:" + txid];
                mfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                tfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                // reserves at the covenant address (no state — Variant U)
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(x0) + " address:" + p.address + " storestate:false");
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(y0) + " address:" + p.address + tokArg + " storestate:false");
                // discovery beacon — dust at the sentinel, params in state (storestate:true)
                cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + Covenant.SENTINEL + " storestate:true");
                // change → the funding coins' OWN address (NOT $OADR: an owner coin funding a later self-swap
                // would make txnsign:auto sign with $OPK and trip the covenant's owner branch).
                var mChg = mfunds.length ? mfunds[0].address : p.oadr;
                var tChg = tfunds.length ? tfunds[0].address : p.oadr;
                var mchange = msum.minus(minimaNeed);
                if (mchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(mchange) + " address:" + mChg + " storestate:false");
                var tchange = tsum.minus(y0);
                if (tchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(tchange) + " address:" + tChg + tokArg + " storestate:false");
                addAnnounceState(cmds, txid, p);
                buildAndPost(txid, cmds, ["auto"], { ok: function (txpowid) { done.created(p, txpowid); }, fail: done.fail });
            });
        });
    }

    // ================================================================ ADD LIQUIDITY (grow-in-place)
    function deposit(p, addMRaw, addTRaw, done) {   // done.ok(txpowid), done.fail
        if (!Curve.funded(p)) { done.fail("pool has no live reserves"); return; }
        var addM = PP.dec(addMRaw), addT = PP.dec(addTRaw);
        if (addM.lt(0) || addT.lt(0) || (addM.isZero() && addT.isZero())) { done.fail("enter an amount to add"); return; }
        var addTc = addT.toDP(p.tokDecimals, D.ROUND_DOWN);
        var newX = PP.dec(p.reserveM).plus(addM);
        var newY = PP.dec(p.reserveT).plus(addTc);
        var cap = PP.decOr(p.kmin, 0).times(GROW_CAP_MULT);
        if (cap.gt(0) && newX.times(newY).gt(cap)) {
            done.fail("this deposit would push K past 2×KMIN — use Migrate to add liquidity and reset the floor"); return;
        }
        var tok = p.tok, tokArg = " tokenid:" + tok;
        var excl = {}; excl[p.address.toLowerCase()] = true;
        ensureTracked(p, function () {
            selectCoins(MINIMA, addM, excl, function (mfunds, msum) {
                if (!mfunds) { done.fail("insufficient MINIMA to add"); return; }
                selectCoins(tok, addTc, excl, function (tfunds, tsum) {
                    if (!tfunds) { done.fail("insufficient token balance to add"); return; }
                    var txid = "ppdep_" + tag();
                    var cmds = ["txncreate id:" + txid];
                    cmds.push("txninput id:" + txid + " coinid:" + p.coinidM);   // 0 pool MINIMA
                    cmds.push("txninput id:" + txid + " coinid:" + p.coinidT);   // 1 pool token
                    mfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                    tfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                    // outputs 0/1 recreate the grown reserves at the SAME address (owner grow branch)
                    cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(newX) + " address:" + p.address + " storestate:false");
                    cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(newY) + " address:" + p.address + tokArg + " storestate:false");
                    var mChg = mfunds.length ? mfunds[0].address : p.oadr;
                    var tChg = tfunds.length ? tfunds[0].address : p.oadr;
                    var mchange = msum.minus(addM);
                    if (mchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(mchange) + " address:" + mChg + " storestate:false");
                    var tchange = tsum.minus(addTc);
                    if (tchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(tchange) + " address:" + tChg + tokArg + " storestate:false");
                    buildAndPost(txid, cmds, ["auto", p.opk], done);
                });
            });
        });
    }

    // ================================================================ MIGRATE (reset floor, new addr)
    function migrate(p, newXRaw, newYRaw, done) {   // done.created(newPool,txpowid), done.fail
        if (!Curve.funded(p)) { done.fail("pool has no live reserves"); return; }
        var newX = PP.dec(newXRaw), newY = PP.dec(newYRaw);
        if (newX.lte(0) || newY.lte(0)) { done.fail("enter the new reserves"); return; }
        var newYc = newY.toDP(p.tokDecimals, D.ROUND_DOWN);
        if (newYc.lte(0)) { done.fail("new token reserve below the token grain"); return; }
        if (!Covenant.sizeOk(newX, newYc)) { done.fail("new reserves too large — x×y must stay under 2^64"); return; }
        var kmin2;
        try { kmin2 = Covenant.kmin(newX, newYc); } catch (e) { done.fail(e.message); return; }
        var script2 = Covenant.script(p.opk, p.oadr, p.tok, kmin2);
        deriveAddress(script2, function (a2, mx2) {
            if (a2.toLowerCase() === (p.address || "").toLowerCase()) {
                done.fail("these reserves give the same pool — change the amounts, or use Add to grow in place"); return;
            }
            MDS.cmd("newscript trackall:true script:" + Covenant.scriptArg(script2), function () {
                var np = {
                    address: a2, mxaddress: mx2, opk: p.opk, oadr: p.oadr, tok: p.tok,
                    kmin: kmin2, tokDecimals: p.tokDecimals, reserveM: newX, reserveT: newYc, tokName: p.tokName,
                    covenantScript: script2   // authoritative script → stored in the recovery recipe
                };
                buildMigrate(p, np, newX, newYc, done);
            });
        }, done.fail);
    }

    function buildMigrate(p, np, newX, newY, done) {
        var tok = p.tok, tokArg = " tokenid:" + tok;
        var oldX = PP.dec(p.reserveM), oldY = PP.dec(p.reserveT);
        var minimaNeed = newX.plus(ANNOUNCE_DUST);
        var excl = {}; excl[p.address.toLowerCase()] = true;
        selectCoins(MINIMA, minimaNeed, excl, function (mfunds, msum) {
            if (!mfunds) { done.fail("insufficient MINIMA for the new pool"); return; }
            selectCoins(tok, newY, excl, function (tfunds, tsum) {
                if (!tfunds) { done.fail("insufficient token balance for the new pool"); return; }
                var txid = "ppmig_" + tag();
                var cmds = ["txncreate id:" + txid];
                cmds.push("txninput id:" + txid + " coinid:" + p.coinidM);   // 0 old pool MINIMA -> owner exit
                cmds.push("txninput id:" + txid + " coinid:" + p.coinidT);   // 1 old pool token  -> owner exit
                mfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                tfunds.forEach(function (c) { cmds.push("txninput id:" + txid + " coinid:" + c.coinid); });
                // outputs 0/1 = owner exit of the OLD reserves to $OADR (pinned by VERIFYOUT @INPUT)
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(oldX) + " address:" + p.oadr + " storestate:false");
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(oldY) + " address:" + p.oadr + tokArg + " storestate:false");
                // outputs 2/3 = the NEW pool reserves at the new address
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(newX) + " address:" + np.address + " storestate:false");
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(newY) + " address:" + np.address + tokArg + " storestate:false");
                // the new discovery beacon
                cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + Covenant.SENTINEL + " storestate:true");
                var mChg = mfunds.length ? mfunds[0].address : p.oadr;
                var tChg = tfunds.length ? tfunds[0].address : p.oadr;
                var mchange = msum.minus(minimaNeed);
                if (mchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(mchange) + " address:" + mChg + " storestate:false");
                var tchange = tsum.minus(newY);
                if (tchange.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(tchange) + " address:" + tChg + tokArg + " storestate:false");
                addAnnounceState(cmds, txid, np);
                buildAndPost(txid, cmds, ["auto", p.opk], { ok: function (txpowid) { done.created(np, txpowid); }, fail: done.fail });
            });
        });
    }

    // ================================================================ CLOSE (owner sweep)
    function close(p, done) {   // done.ok(txpowid), done.fail
        if (!Curve.funded(p)) { done.fail("pool has no live reserves to withdraw"); return; }
        var tokArg = " tokenid:" + p.tok;
        ensureTracked(p, function () {
            var txid = "ppclose_" + tag();
            var cmds = ["txncreate id:" + txid];
            cmds.push("txninput id:" + txid + " coinid:" + p.coinidM);   // 0 -> owner exit
            cmds.push("txninput id:" + txid + " coinid:" + p.coinidT);   // 1 -> owner exit
            cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(PP.dec(p.reserveM)) + " address:" + p.oadr + " storestate:false");
            cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(PP.dec(p.reserveT)) + " address:" + p.oadr + tokArg + " storestate:false");
            // no wallet funding inputs → only the owner signature is needed
            buildAndPost(txid, cmds, [p.opk], done);
        });
    }

    // ================================================================ FORWARD TO DEFAULT WALLET
    // Forward every sendable coin at a pool owner address ($OADR) onward to a fresh DEFAULT-64 wallet address
    // (getaddress). The covenant pins the owner exit to $OADR, so close can only land funds there; this second
    // hop moves them into the 64 seed-derived defaults a seed-only restore always regenerates — so withdrawn
    // funds are never stranded at a newaddress ($OADR) a bare seed restore wouldn't reproduce. $OADR is
    // RETURN SIGNEDBY($OPK) and the node holds $OPK, so sign auto covers it. Full amounts (zero burn); whole
    // coins move so token grain is exact. done.nothing() if nothing sendable yet (a close still confirming).
    function forwardOwnerFunds(oadr, done) {   // done.forwarded(txpowid,coins), done.nothing(), done.fail(msg)
        if (!oadr) { done.fail("no owner address"); return; }
        MDS.cmd("coins relevant:true sendable:true address:" + oadr, function (res) {
            var arr = (res && res.status && Array.isArray(res.response)) ? res.response : null;
            if (!arr || !arr.length) { done.nothing(); return; }
            var coinids = [], byTok = {}, order = [];
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i];
                if (!c || c.spent === true) continue;
                var tid = c.tokenid || "", cid = c.coinid || "";
                if (!tid || !cid) continue;
                var a = coinAmt(c, tid);
                if (a.lte(0)) continue;
                coinids.push(cid);
                if (byTok[tid] === undefined) { byTok[tid] = a; order.push(tid); }
                else byTok[tid] = byTok[tid].plus(a);
            }
            if (!coinids.length) { done.nothing(); return; }
            MDS.cmd("getaddress", function (j) {   // fresh DEFAULT-64 address (getaddress, not newaddress)
                var dest = (j && j.response) ? (j.response.address || "") : "";
                if (!dest) { done.fail("could not get a wallet address"); return; }
                var txid = "ppfwd_" + tag();
                var cmds = ["txncreate id:" + txid];
                coinids.forEach(function (cid) { cmds.push("txninput id:" + txid + " coinid:" + cid); });
                order.forEach(function (tid) {
                    var tokArg = PP.isMinima(tid) ? "" : " tokenid:" + tid;
                    cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(byTok[tid]) + " address:" + dest + tokArg + " storestate:false");
                });
                var n = coinids.length;
                buildAndPost(txid, cmds, ["auto"], {
                    ok: function (txpowid) { done.forwarded(txpowid, n); },
                    fail: done.fail
                });
            });
        });
    }

    // "Collect to wallet" sweep across a set of owner addresses → default wallet addresses. Best-effort per
    // address; reports totals. Dedups (migrate shares $OADR). Rescues funds a pre-fix close left at $OADR.
    function sweepOwnerFunds(oadrs, done) {   // done.swept(addressesForwarded, coins)
        var uniq = [], seen = {};
        (oadrs || []).forEach(function (a) { if (a && !seen[a.toLowerCase()]) { seen[a.toLowerCase()] = true; uniq.push(a); } });
        if (!uniq.length) { done.swept(0, 0); return; }
        var pending = uniq.length, addrs = 0, coins = 0;
        function tick() { if (--pending === 0) done.swept(addrs, coins); }
        uniq.forEach(function (oadr) {
            forwardOwnerFunds(oadr, {
                forwarded: function (txpowid, n) { addrs++; coins += n; tick(); },
                nothing: function () { tick(); },
                fail: function (msg) { tick(); }
            });
        });
    }

    // ================================================================ OWNER-KEY RECOVERY
    // $OPK is a `newaddress` key (index >= 64); a seed-only restore regenerates only the 64 default keys, so it
    // doesn't bring $OPK back and the node can neither close its own open pools nor spend $OADR funds. Keys are
    // derived deterministically as hash(seed, sequentialIndex), so re-issuing `newaddress` on the SAME seed
    // reproduces the historical keys IN ORDER — create new addresses until each wanted pubkey reappears. No-op
    // if the node already holds them (the normal case: the `keys` check finds them all).
    //
    // THE HUNT IS BUDGETED. An $OPK minted under a DIFFERENT seed (a backup restored from another node, a
    // recipe carried across devices) can never be re-derived here, and every minted key is a PERMANENT wallet
    // row — there is no key-delete command, and a live node was found carrying 166 junk keys from exactly this
    // runaway. So each (seed, opk) pair gets a LIFETIME budget of MAX_NEW_KEYS mints, persisted per mint
    // (pp_kv "opkhunt"), and once spent the pair is reported UNREACHABLE — "created under a different seed" —
    // and never hunted again on this seed. The seed is identified by a fingerprint: the publickey of the
    // wallet's lowest-`modifier` key (the modifier IS the derivation index; index 0 = the seed's first default
    // key). Re-seeding changes the fingerprint and re-opens the budget — load-bearing, because even the
    // CORRECT seed's restore rebuilds only the 64 defaults and still needs its hunt allowed.
    //
    // kidx: when a key's own derivation index is known (captured from newaddress's `total` at create,
    // stamped into backups since v3, remembered in pp_kv "opkidx"), the hunt is EXACT — mint precisely to
    // that index — and a wallet already PAST the index without holding the key proves a foreign seed with
    // ZERO mints.
    //
    // SERIAL: one hunt at a time; overlapping callers queue and each re-runs its own `keys` check. The rules
    // mirror the native HuntBudget.java exactly — that file's JVM tests are the spec.
    var MAX_NEW_KEYS = 256;
    var MAX_KIDX_MINT = 2048;   // a recipe pointing deeper than this looks corrupt, not busy — distrust it
    var NO_FP = "nofp";

    // pp_kv-backed maps. The LIVE copies start empty and pp_kv is MERGED in once (max wins) — never
    // replaced — so charges minted before the store came up are kept, and concurrent first callers
    // (a restore stamping many kidx entries) can't clobber each other. While the store isn't ready the
    // hunt runs on the live maps (kvSet drops writes until ready; the next durable save persists all).
    // huntLedger: {"<fp>|<opk>": mintsCharged} · kidxMap: {"<opk>": derivation index}
    var huntLedger = {}, kidxMap = {};
    var huntStateDurable = false;     // pp_kv has been merged into the live maps
    var huntStateWaiters = null;      // callbacks queued while that merge is in flight
    function loadHuntState(cb) {
        if (huntStateDurable) { cb(); return; }
        var store = (typeof Store !== "undefined" && Store.kvGet) ? Store : null;
        if (!store || (store.isReady && !store.isReady())) { cb(); return; }   // not durable yet — run on the live maps
        if (huntStateWaiters) { huntStateWaiters.push(cb); return; }           // single-flight merge
        huntStateWaiters = [cb];
        store.kvGet("opkhunt", function (h, hOk) {
            var disk = {}; try { disk = h ? JSON.parse(h) : {}; } catch (e) {}
            Object.keys(disk).forEach(function (k) {
                var v = Math.floor(Number(disk[k]));   // sanitize: a tampered value must not poison the cap
                if (isFinite(v) && v > 0 && !(huntLedger[k] >= v)) huntLedger[k] = v;
            });
            store.kvGet("opkidx", function (kv, kOk) {
                var dk = {}; try { dk = kv ? JSON.parse(kv) : {}; } catch (e2) {}
                Object.keys(dk).forEach(function (o) {
                    var v = toKidx(dk[o]);
                    if (v >= 0 && (kidxMap[o] === undefined || kidxMap[o] < v)) kidxMap[o] = v;
                });
                // Durable ONLY when both reads were confirmed: a transient SQL failure reads as "", and
                // marking that durable would let a later save clobber the persisted ledger with these
                // near-empty maps — re-opening a spent budget. Saves are gated on durable for the same reason.
                huntStateDurable = (hOk !== false && kOk !== false);
                var ws = huntStateWaiters; huntStateWaiters = null;
                ws.forEach(function (w) { w(); });
            });
        });
    }
    function saveHuntLedger() { if (huntStateDurable && typeof Store !== "undefined" && Store.kvSet) Store.kvSet("opkhunt", JSON.stringify(huntLedger)); }
    function saveKidxMap() { if (huntStateDurable && typeof Store !== "undefined" && Store.kvSet) Store.kvSet("opkidx", JSON.stringify(kidxMap)); }

    /** STRICT kidx parse: a finite number or pure digit-string, else -1. Number() coercion is not
     *  enough — Number(null)/Number("")/Number(false) are all 0, and a phantom kidx 0 with any populated
     *  wallet would falsely PROVE a legitimate key foreign (`total > 0` always). */
    function toKidx(v) {
        if (typeof v === "number" && isFinite(v)) { v = Math.floor(v); return v >= 0 ? v : -1; }
        if (typeof v === "string" && /^[0-9]+$/.test(v)) return parseInt(v, 10);
        return -1;
    }

    /** Remember an owner key's derivation index (newaddress's `total` at create; a v3 backup on restore;
     *  the node's key row at backup time). Takes effect in memory immediately; persisted once durable. */
    function rememberKidx(opk, kidx) {
        kidx = toKidx(kidx);   // a malformed backup value must never brand a legitimate key foreign
        if (!opk || kidx < 0) return;
        var k = String(opk).toLowerCase();
        // duplicates should agree; if they don't, the LARGER only delays a foreign-proof — the
        // smaller could fake one, which must never happen
        if (kidxMap[k] !== undefined && kidxMap[k] >= kidx) return;
        kidxMap[k] = kidx;
        loadHuntState(function () { saveKidxMap(); });
    }

    // --- the decision rules (byte-for-byte the logic of native HuntBudget.java) ---
    function keyRowsOf(j) {
        var resp = j ? j.response : null;
        return Array.isArray(resp) ? resp : (resp && Array.isArray(resp.keys) ? resp.keys : null);
    }
    function parseModifier(s) {
        if (s === undefined || s === null) return null;
        var h = String(s).trim();
        if (h.slice(0, 2).toLowerCase() === "0x") h = h.slice(2);
        if (!h || !/^[0-9a-fA-F]+$/.test(h)) return null;
        return parseInt(h, 16);   // NUMERIC — as strings "0xFF" sorts after "0x0100"
    }
    /** Seed fingerprint: the lowest-modifier key's pubkey (the reply is an unordered SELECT). */
    function fingerprintOf(j) {
        var arr = keyRowsOf(j); if (!arr) return NO_FP;
        var best = null, pk = null;
        for (var i = 0; i < arr.length; i++) {
            var k = arr[i]; if (!k || !k.publickey) continue;
            var m = parseModifier(k.modifier);
            if (m === null) continue;
            if (best === null || m < best) { best = m; pk = String(k.publickey).toLowerCase(); }
        }
        return pk || NO_FP;
    }
    /** Wallet key count (`response.total`, else row count) = the NEXT mint's derivation index. */
    function keyTotalOf(j) {
        var resp = j ? j.response : null;
        if (resp && !Array.isArray(resp) && resp.total !== undefined) return Number(resp.total);
        var arr = keyRowsOf(j);
        return arr ? arr.length : -1;
    }
    function mintsNeeded(kidx, total) { return Math.max(0, kidx + 1 - total); }
    /** A known-index key the wallet is already PAST, yet does not hold, is another seed's key. */
    function provenForeign(kidx, total) { return kidx >= 0 && total >= 0 && total > kidx; }
    /** A kidx trustworthy enough to drive an exact hunt (known, not passed, not absurdly deep). */
    function kidxUsable(kidx, total) { return kidx >= 0 && total >= 0 && total <= kidx && mintsNeeded(kidx, total) <= MAX_KIDX_MINT; }

    // --- the serial gate: one hunt in flight, so overlapping callers can't double-charge the ledger ---
    var huntBusy = false, huntQueue = [];
    function ensureOwnerKeys(wantedOpks, done) {   // done(regenerated, unreachable[])
        var wanted = {}; var any = false;
        (wantedOpks || []).forEach(function (o) { if (o) { wanted[o.toLowerCase()] = true; any = true; } });
        if (!any) { done(0, []); return; }
        var job = function () {
            beginHunt(wanted, function (regen, unreachable) {
                huntBusy = false;
                var next = huntQueue.shift();
                if (next) { huntBusy = true; next(); }
                done(regen, unreachable);
            });
        };
        if (huntBusy) { huntQueue.push(job); return; }
        huntBusy = true; job();
    }

    function beginHunt(wanted, done) {
        loadHuntState(function () {
            MDS.cmd("keys", function (j) {
                // Without a readable key list we don't know what's held — prove nothing, mint nothing.
                // (status:true with unreadable rows would make every wanted key "look missing".)
                if (!j || j.status === false || !keyRowsOf(j)) { done(0, []); return; }
                pubkeysOf(j).forEach(function (pk) { delete wanted[pk]; });
                if (!Object.keys(wanted).length) { done(0, []); return; }   // node holds every owner key — no-op
                var fp = fingerprintOf(j), total = keyTotalOf(j);
                // Partition: counting = inside its budget (charged per mint, drives the loop); watch =
                // budget spent, matched for FREE if a mint happens to produce it; unreachable = reported
                // as another seed's key. A kidx the wallet is already past is proven foreign RIGHT HERE —
                // zero mints (the poisoned Collect that used to re-burn 256 keys per tap now burns none).
                var counting = {}, watch = {}, unreachable = {}, kidx = {};
                Object.keys(wanted).forEach(function (opk) {
                    var ki = kidxMap[opk] === undefined ? -1 : kidxMap[opk];
                    var spent = huntLedger[fp + "|" + opk] || 0;
                    if (kidxUsable(ki, total)) { counting[opk] = true; kidx[opk] = ki; }   // exact target — the flat cap does not bind
                    else if (provenForeign(ki, total)) { huntLedger[fp + "|" + opk] = Math.max(spent, MAX_NEW_KEYS); unreachable[opk] = true; }
                    else if (spent >= MAX_NEW_KEYS) { unreachable[opk] = true; watch[opk] = true; }
                    else counting[opk] = true;
                });
                saveHuntLedger();
                if (!Object.keys(counting).length) { done(0, Object.keys(unreachable)); return; }
                huntKeys(fp, counting, watch, kidx, unreachable, total, 0, 0, done);
            });
        });
    }
    function huntKeys(fp, counting, watch, kidx, unreachable, total, regenerated, minted, done) {
        // Hard per-run backstop: termination normally comes from the per-key budgets, but no single run
        // may ever out-mint the deepest legitimate exact target, whatever state the ledger is in.
        if (!Object.keys(counting).length || minted >= MAX_KIDX_MINT) { done(regenerated, Object.keys(unreachable)); return; }
        MDS.cmd("newaddress", function (j) {
            var r = (j && j.status !== false) ? j.response : null;
            var pk = r && r.publickey ? String(r.publickey).toLowerCase() : "";
            // A FAILED mint (status:false — locked vault, denied write permission, node error) created
            // NO key, so it must not charge the ledger: charging would burn a legitimate key's whole
            // budget on 256 failed calls and falsely brand it another seed's. Stop instead — charges
            // so far are already persisted, so a resumed hunt keeps only its remainder.
            if (!pk) { done(regenerated, Object.keys(unreachable)); return; }
            // the reply's `total` is the count AFTER creation → the minted key's index is total-1
            var newIdx = (Number(r.total) > 0) ? Number(r.total) - 1 : Math.max(total, 0);
            total = newIdx + 1;
            if (pk && (counting[pk] || watch[pk])) {
                delete counting[pk]; delete watch[pk]; delete unreachable[pk];
                delete huntLedger[fp + "|" + pk];   // found — its count must not linger
                rememberKidx(pk, newIdx);           // free exactness if this key is ever wiped again
                regenerated++;
            }
            Object.keys(counting).forEach(function (opk) {
                var key = fp + "|" + opk;
                var spent = (huntLedger[key] || 0) + 1;   // this mint "passed by" every still-wanted key
                huntLedger[key] = spent;
                if (kidx[opk] !== undefined) {
                    if (newIdx >= kidx[opk]) {   // walked past its exact index without a match — foreign PROVEN
                        huntLedger[key] = Math.max(spent, MAX_NEW_KEYS);
                        unreachable[opk] = true; delete counting[opk];
                    }
                } else if (spent >= MAX_NEW_KEYS) {
                    unreachable[opk] = true; delete counting[opk];
                }
            });
            saveHuntLedger();   // per mint, so an interrupted hunt resumes with only its remainder
            huntKeys(fp, counting, watch, kidx, unreachable, total, regenerated, minted + 1, done);
        });
    }
    function pubkeysOf(j) {
        var out = [];
        var arr = keyRowsOf(j);
        if (arr) for (var i = 0; i < arr.length; i++) { var k = arr[i]; if (k && k.publickey) out.push(String(k.publickey).toLowerCase()); }
        return out;
    }

    // ============================================== KEY USES (one-time-signature counter)
    //
    // Minima signatures are STATEFUL: each key is a Winternitz tree and every signature must consume the
    // NEXT leaf. Signing one leaf twice over different data leaks that leaf's private key.
    //
    // A pool's owner key is minted with `newaddress`, so a seed-only re-sync doesn't bring it back — only
    // the 64 defaults are rebuilt. ensureOwnerKeys re-mints it (keys derive as hash(seed, index), so the
    // same seed reproduces the same keys in order) but the node inserts EVERY new key at uses = 0. Without
    // winding it forward, the next owner action re-signs leaves the pre-restore node already spent.
    //
    // There is no command to SET a counter — `keys` offers only list/genkey/checkkeys/new/createallkeys,
    // and updateAllKeyUses rewrites all 64 defaults at once. The private key can't be fetched either
    // (KeyRow.toJSON has privatekey commented out). So we advance it the one way the node exposes: each
    // `sign` call runs Wallet.signData, which increments and persists uses by one. The leaves burned are
    // exactly the ones being skipped, so nothing of value is lost — and it works on ANY node, no fork.

    var BURN_DATA = "0x00";      // constant, meaningless — never a valid transaction id
    var RECHECK_EVERY = 25;      // re-read the node's real count rather than trusting our arithmetic
    var MAX_BURN = 20000;        // a target beyond this means a bad backup, not a busy key
    // Own copy: service.js loads AFTER this file, so its REFRESH_BLOCKS isn't defined yet. Must stay in
    // step with service.js and native PoolRefresher.REFRESH_BLOCKS — it sets the keep-fresh cadence, which
    // is how many owner signatures a stretch of elapsed blocks implies.
    var KEYUSE_REFRESH_BLOCKS = 900;

    /** Current use count for one public key (null if this node doesn't hold it), plus the key's
     *  derivation index as a second argument (-1 unknown) — same row, no extra command. */
    function readKeyUses(publickey, cb) {
        if (!publickey) { cb(null, -1); return; }
        MDS.cmd("keys action:list publickey:" + publickey, function (j) {
            var arr = keyRowsOf(j);
            if (!arr) { cb(null, -1); return; }
            var want = String(publickey).toLowerCase();
            for (var i = 0; i < arr.length; i++) {
                var k = arr[i];
                if (k && String(k.publickey || "").toLowerCase() === want && k.uses !== undefined) {
                    var mod = parseModifier(k.modifier);
                    cb(Number(k.uses), mod === null ? -1 : mod);
                    return;
                }
            }
            cb(null, -1);   // absent must read as UNKNOWN, never as 0 — 0 would resume at the first leaf
        });
    }

    /** Where a restored owner key should resume: what it had spent, plus the keep-fresh signatures that
     *  could have happened since, plus slack for deposits/migrates/collects. Every term measured. */
    function restoreTarget(usesAtBackup, blockAtBackup, currentBlock, slack) {
        var gap = 0;
        if (currentBlock > blockAtBackup && blockAtBackup > 0) {
            gap = Math.ceil((currentBlock - blockAtBackup) / KEYUSE_REFRESH_BLOCKS);
        }
        return Math.max(0, usesAtBackup || 0) + gap + Math.max(0, slack || 0);
    }

    /** Advance `publickey` to at least `target` by burning leaves. NEVER lowers. done(ok, finalUses, err) */
    function advanceKeyUses(publickey, target, onProgress, done) {
        if (!publickey) { done(false, 0, "no public key"); return; }
        if (!(target > 0)) { done(true, 0, null); return; }
        readKeyUses(publickey, function (uses) {
            if (uses === null) { done(false, 0, "the node doesn't hold that key"); return; }
            if (uses >= target) { done(true, uses, null); return; }          // already past it
            if (target - uses > MAX_BURN) {
                done(false, uses, "that backup asks for " + (target - uses) + " more key uses, which looks wrong");
                return;
            }
            burnTo(publickey, target, uses, onProgress, done);
        });
    }
    function burnTo(publickey, target, uses, onProgress, done) {
        if (uses >= target) { done(true, uses, null); return; }
        if (onProgress) onProgress(uses, target);
        MDS.cmd("sign publickey:" + publickey + " data:" + BURN_DATA, function (j) {
            if (!j || !j.status) { done(false, uses, "the node refused to sign — key not advanced"); return; }
            var next = uses + 1;
            if (next % RECHECK_EVERY === 0) {
                readKeyUses(publickey, function (real) {
                    burnTo(publickey, target, real === null ? next : Math.max(real, next), onProgress, done);
                });
            } else {
                burnTo(publickey, target, next, onProgress, done);
            }
        });
    }

    // ================================================================ SWAP (routed)
    function swap(route, minimaToToken, done) {   // done.ok(txpowid), done.fail
        if (!route || !route.ok || !route.allocs.length) { done.fail("no route — trade too small for the pools"); return; }
        var tok = route.allocs[0].pool.tok;
        var fundTok = minimaToToken ? MINIMA : tok;

        // exclude EVERY pool address for the pair AND each routed pool's OADR (owner payout addr): funding a
        // swap from an owner coin makes txnsign:auto sign with $OPK → flips the covenant into its owner branch
        // and rejects the swap. Critical for an LP swapping against their own pool from the same node.
        var exclude = {};
        route.pairAddresses.forEach(function (a) { if (a) exclude[a.toLowerCase()] = true; });
        route.allocs.forEach(function (al) {
            if (al.pool.address) exclude[al.pool.address.toLowerCase()] = true;
            if (al.pool.oadr) exclude[al.pool.oadr.toLowerCase()] = true;
        });

        selectCoins(fundTok, route.totalIn, exclude, function (funds, sum) {
            if (!funds) { done.fail("insufficient " + (minimaToToken ? "MINIMA" : "token") + " in the wallet to fund this swap"); return; }
            ensureTrackedAll(route.allocs, 0, function () { buildRouted(route, minimaToToken, tok, funds, sum, done); });
        });
    }

    function buildRouted(route, minimaToToken, tok, funds, sum, done) {
        var txid = "ppswap_" + tag();
        var tokArg = " tokenid:" + tok;
        MDS.cmd("getaddress", function (j) {
            var taddr = (j && j.response) ? (j.response.address || "") : "";
            if (!taddr) { done.fail("could not get a payout address"); return; }
            var cmds = ["txncreate id:" + txid];
            // interleaved pool inputs: pool k's MINIMA leg at index 2k (even), token leg at 2k+1 (odd)
            route.allocs.forEach(function (al) {
                cmds.push("txninput id:" + txid + " coinid:" + al.pool.coinidM);
                cmds.push("txninput id:" + txid + " coinid:" + al.pool.coinidT);
            });
            funds.forEach(function (f) { cmds.push("txninput id:" + txid + " coinid:" + f.coinid); });
            // interleaved recreated reserves, index-matched to the pool inputs (covenant VERIFYOUT @INPUT)
            route.allocs.forEach(function (al) {
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(al.quote.newX) + " address:" + al.pool.address + " storestate:false");
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(al.quote.newY) + " address:" + al.pool.address + tokArg + " storestate:false");
            });
            var change = sum.minus(route.totalIn);
            if (minimaToToken) {
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(route.totalOut) + " address:" + taddr + tokArg + " storestate:false");
                if (change.gt(DUST)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(change) + " address:" + taddr + " storestate:false");
            } else {
                cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(route.totalOut) + " address:" + taddr + " storestate:false");
                if (change.gt(0)) cmds.push("txnoutput id:" + txid + " amount:" + PP.amt(change) + " address:" + taddr + tokArg + " storestate:false");
            }
            buildAndPost(txid, cmds, ["auto"], done);   // covenant swap branch needs no signature
        });
    }

    return {
        setStatusHook: setStatusHook,
        onNewBlock: onNewBlock,
        createPool: createPool,
        deposit: deposit,
        migrate: migrate,
        close: close,
        swap: swap,
        reannounce: reannounce,
        refresh: refresh,
        forwardOwnerFunds: forwardOwnerFunds,
        sweepOwnerFunds: sweepOwnerFunds,
        ensureOwnerKeys: ensureOwnerKeys, rememberKidx: rememberKidx,
        readKeyUses: readKeyUses, restoreTarget: restoreTarget, advanceKeyUses: advanceKeyUses
    };
})();
