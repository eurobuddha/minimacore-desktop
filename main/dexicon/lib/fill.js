/**
 * fill — the two-party fill (SPEC §5) for MINIMA/MxUSD: exact amount math, the taker's transaction plan, the
 * maker's verification of a decoded (txnview) transaction, and the node command sequences that build/export
 * (taker) and import/co-sign/post (maker). Pure parts take plain data and are unit-tested; node parts take
 * AX.mds and callbacks. Rhino-safe (ES5). Requires Decimal (vendor/decimal.js), AX.mds, AX.flow. Attaches to AX.fill.
 *
 * Rounding is always in the MAKER's favour: a taker pays MxUSD rounded UP (sell order) and receives MxUSD
 * rounded DOWN (buy order), to the 8-dp MxUSD grain. MINIMA amounts are quantised to 8 dp as well (book grain).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var D = g.Decimal;
    // 64 significant digits: the node reports amounts with up to 64 digits / 44 dp, and the probe on 2026-10-21 showed
    // txnoutput stores a 45-digit amount exactly — so every sum/difference here must stay EXACT (no rounding of change).
    D.set({ precision: 64, rounding: D.ROUND_DOWN, toExpNeg: -1000000000, toExpPos: 1000000000 });

    var MINIMA = '0x00';
    var MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';   // mainnet MxUSD; dev chains override via setMxUsd
    var GRAIN = 8;

    function d(v) { return new D(v === undefined || v === null || v === '' ? 0 : String(v)); }
    function up8(x) { return x.toDecimalPlaces(GRAIN, D.ROUND_UP); }
    function down8(x) { return x.toDecimalPlaces(GRAIN, D.ROUND_DOWN); }
    function plain(x) { return d(x).toFixed(); }
    /** Change outputs are EXACT (inputs == outputs); if an amount ever exceeded 64 digits we round DOWN (dust burns), never up. */
    function fit44(x) { return d(x).toSignificantDigits(64, D.ROUND_DOWN); }
    /** The human value of a coin: MINIMA uses amount, a token uses tokenamount. */
    function coinValue(c) { return d(c.tokenid === MINIMA ? c.amount : (c.tokenamount !== undefined ? c.tokenamount : c.amount)); }
    function eqTok(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
    function eqAddr(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

    /** Pick coins (largest first) until sum >= need; returns {coins, sum} or null. */
    function pick(coins, need, max, spreadKey) {
        var sorted = coins.slice().sort(function (a, b) { return coinValue(b).cmp(coinValue(a)); });
        // Concurrent takers: every coin that covers the take on its own is a candidate, and the taker's own key picks
        // one deterministically — two takers arriving at once land on DIFFERENT backing coins and both fills mine in
        // the same block, instead of both choosing the largest coin and the second being refused as already spent.
        if (spreadKey) {
            var single = sorted.filter(function (c) { return coinValue(c).gte(need); });
            if (single.length > 1) { var c1 = single[spreadIndex(spreadKey, single.length)]; return { coins: [c1], sum: coinValue(c1) }; }
        }
        var chosen = [], sum = d(0);
        for (var i = 0; i < sorted.length && chosen.length < (max || 32); i++) {
            chosen.push(sorted[i]); sum = sum.plus(coinValue(sorted[i]));
            if (sum.gte(need)) return { coins: chosen, sum: sum };
        }
        return null;
    }
    /** Stable small hash of a hex key → [0, n). */
    function spreadIndex(key, n) {
        var h = 0, s = String(key).toLowerCase();
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % n;
    }

    /**
     * plan(order, takeMinima, makerCoins, takerCoins, takerAddress) → the taker's transaction.
     *   order: a verified order envelope (side = side of MINIMA the MAKER takes: 'sell' = maker sells MINIMA).
     *   makerCoins: the maker's advertised coins as fetched from the chain (objects with coinid/address/tokenid/amount/tokenamount).
     *   takerCoins: the taker's own spendable, state-free coins of the token the taker pays.
     * Returns { inputs:[coinid], outputs:[{address, amount, tokenid}], filled, pay, payToken, recvToken, makerChange, takerChange }.
     */
    function plan(order, takeMinima, makerCoins, takerCoins, takerAddress) {
        var take = down8(d(takeMinima));
        if (take.lte(0)) throw new Error('take must be positive');
        if (take.gt(d(order.amount))) throw new Error('take exceeds order amount');
        var price = d(order.price);
        var sell = order.side === 'sell';
        var makerTok = sell ? MINIMA : MXUSD, takerTok = sell ? MXUSD : MINIMA;
        var makerGives = sell ? take : down8(take.times(price));          // buy: maker pays MxUSD rounded DOWN
        var takerGives = sell ? up8(take.times(price)) : take;             // sell: taker pays MxUSD rounded UP
        if (makerGives.lte(0) || takerGives.lte(0)) throw new Error('amount below grain');
        var mc = [];
        for (var i = 0; i < makerCoins.length; i++) {
            var c = makerCoins[i];
            if (!eqTok(c.tokenid, makerTok)) throw new Error('maker coin ' + c.coinid + ' is not ' + (sell ? 'MINIMA' : 'MxUSD'));
            if (c.spent === true || (c.state && c.state.length)) throw new Error('maker coin ' + c.coinid + ' spent or carries state');
            mc.push(c);
        }
        var m = pick(mc, makerGives, 32, takerAddress);
        if (!m) throw new Error('maker coins do not cover ' + plain(makerGives));
        var t = pick(takerCoins.filter(function (c) { return eqTok(c.tokenid, takerTok) && !(c.state && c.state.length) && c.spent !== true; }), takerGives, 20);
        if (!t) throw new Error('your wallet does not cover ' + plain(takerGives) + (sell ? ' MxUSD' : ' MINIMA'));
        var inputs = [], outputs = [], makerAddrs = [], takerAddrs = [];
        for (i = 0; i < m.coins.length; i++) { inputs.push(m.coins[i].coinid); makerAddrs.push(String(m.coins[i].address).toLowerCase()); }
        for (i = 0; i < t.coins.length; i++) { inputs.push(t.coins[i].coinid); takerAddrs.push(String(t.coins[i].address).toLowerCase()); }
        for (i = 0; i < makerAddrs.length; i++) if (takerAddrs.indexOf(makerAddrs[i]) >= 0) throw new Error('the order lists a coin at one of your own addresses');
        // maker → taker
        outputs.push({ address: takerAddress, amount: plain(makerGives), tokenid: makerTok });
        var makerChange = fit44(m.sum.minus(makerGives));
        if (makerChange.gt(0)) outputs.push({ address: m.coins[0].address, amount: plain(makerChange), tokenid: makerTok });
        // taker → maker (the order's pay-to address)
        outputs.push({ address: order.address, amount: plain(takerGives), tokenid: takerTok });
        var takerChange = fit44(t.sum.minus(takerGives));
        if (takerChange.gt(0)) outputs.push({ address: takerAddress, amount: plain(takerChange), tokenid: takerTok });
        return { inputs: inputs, outputs: outputs, scripts: order.scripts || [], makerAddrs: makerAddrs, takerAddrs: takerAddrs, filled: plain(take), makerGives: plain(makerGives), takerGives: plain(takerGives),
                 payToken: takerTok, recvToken: makerTok, makerChange: plain(makerChange), takerChange: plain(takerChange) };
    }

    /**
     * verifyAsMaker(txn, order, advertisedCoinIds, remaining, myAddresses) — txn is txnview's `transaction`.
     * Returns { ok:true, filled, received } or { ok:false, reason }. Every input the taker spends on my behalf
     * must be one I advertised; what I net out (inputs minus change back to my input addresses) is the fill;
     * what lands on the order's pay-to address in the other token must cover it at my price, rounded my way.
     */
    function verifyAsMaker(txn, order, advertisedCoinIds, remaining, myAddresses) {
        var sell = order.side === 'sell';
        var myTok = sell ? MINIMA : MXUSD, wantTok = sell ? MXUSD : MINIMA;
        var adv = {}, mine = {}, i;
        for (i = 0; i < advertisedCoinIds.length; i++) adv[String(advertisedCoinIds[i]).toLowerCase()] = true;
        for (i = 0; i < (myAddresses || []).length; i++) mine[String(myAddresses[i]).toLowerCase()] = true;
        if (order.address) mine[String(order.address).toLowerCase()] = true;   // my pay-to address is mine for inputs too
        var myIn = d(0), myInAddrs = {};
        for (i = 0; i < txn.inputs.length; i++) {
            var inp = txn.inputs[i];
            // security review 7 Nov (mirror of APK): a FAST fill spends plain coins only — a stateful input (an expired HTLC
            // lock, a resting-order coin) my order key could unlock is refused even when its script row is missing
            if (inp.state && inp.state.length) return bad('input ' + inp.coinid + ' carries state');
            var isAdv = adv[String(inp.coinid).toLowerCase()] === true;
            var isMineAddr = mine[String(inp.address).toLowerCase()] === true;
            if (!isAdv && !isMineAddr) continue;                                  // the taker's own input
            if (!isAdv) return bad('input ' + inp.coinid + ' is mine but was not advertised');
            if (!eqTok(inp.tokenid, myTok)) return bad('advertised coin has the wrong token');
            myIn = myIn.plus(coinValue(inp)); myInAddrs[String(inp.address).toLowerCase()] = true;
        }
        if (myIn.lte(0)) return bad('none of my coins are spent');
        var myChange = d(0), received = d(0);
        for (i = 0; i < txn.outputs.length; i++) {
            var out = txn.outputs[i];
            var addr = String(out.address).toLowerCase();
            // Security review 7 Nov (CRITICAL, mirror of APK 0.2.42): change counts ONLY at my spent inputs' addresses or my
            // pay-to address. `mine` (the whole scripts table) also holds the AtomiX HTLC and every counterparty script
            // newscript registered — it classifies INPUTS only, never change.
            if (eqTok(out.tokenid, myTok) && (myInAddrs[addr] || eqAddr(out.address, order.address))) myChange = myChange.plus(coinValue(out));
            if (eqTok(out.tokenid, wantTok) && eqAddr(out.address, order.address)) received = received.plus(coinValue(out));
        }
        var filled = myIn.minus(myChange);
        if (filled.lte(0)) return bad('nothing filled');
        var price = d(order.price);
        if (sell) {
            if (filled.gt(d(remaining))) return bad('fill ' + plain(filled) + ' exceeds remaining ' + plain(remaining));
            if (received.lt(up8(filled.times(price)))) return bad('payment ' + plain(received) + ' MxUSD below ' + plain(up8(filled.times(price))));
        } else {
            // I pay MxUSD (filled), I must receive MINIMA worth at least filled / price, i.e. filled <= down8(minima * price)
            if (received.gt(d(remaining))) return bad('fill ' + plain(received) + ' MINIMA exceeds remaining ' + plain(remaining));
            if (filled.gt(down8(received.times(price)))) return bad('I would pay ' + plain(filled) + ' MxUSD for ' + plain(received) + ' MINIMA, above my price');
        }
        // PandaDEX's min-remainder floor (port 8, default 1 MINIMA): a partial fill may not leave less than MIN_REM behind
        // review 7 Nov (L-1, mirror of APK 0.2.67): relays carry 8 decimals; a finer fill made the order vanish from the book
        if ((sell ? filled : received).decimalPlaces() > 8) return bad('the fill size has more than 8 decimals');
        var left = d(remaining).minus(sell ? filled : received);
        if (left.gt(0) && left.lt(d(MIN_REM))) return bad('the fill would leave ' + plain(left) + ' MINIMA, below the ' + MIN_REM + ' MINIMA minimum remainder — take it all or leave at least ' + MIN_REM);
        for (i = 0; i < (txn.state || []).length; i++) if (txn.state[i]) return bad('unexpected transaction state');
        return { ok: true, filled: sell ? plain(filled) : plain(received), received: plain(received), paid: plain(filled) };
    }
    function bad(r) { return { ok: false, reason: r }; }
    /** PandaDEX's default minimum remainder (TradeView "Minimum left on the book after a partial fill" = 1): a partial take
     *  is SHRUNK to leave exactly this much (never inflated past what the taker asked), and the maker refuses one that
     *  leaves less — so nobody can nibble an order down to unsellable dust. */
    var MIN_REM = '1';
    /** The MINIMA a taker may take from an order with `available` left when it wants `want` (SweepPlanner rule). 0 = none. */
    function floorTake(want, available) {
        var w = d(want), a = d(available);
        if (w.gte(a)) return a;
        if (a.minus(w).gte(d(MIN_REM))) return w;
        var t = a.minus(d(MIN_REM));
        return t.gt(0) ? t : d(0);
    }

    // ---- node command sequences (callback style; AX.mds.cmdR gates signing) ----

    function txnId(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

    /** Taker: register the maker's address scripts, build, sign own inputs, export. cb(err, hex). Always txndelete the temp id.
     *  `txninput scriptmmr:true` attaches script + MMR proof for every input, so the export carries a complete
     *  witness and the maker must NOT run txnbasics (it duplicates the proofs and invalidates the witness). */
    /** Security review 7 Nov (CRITICAL, mirror of APK 0.2.42): a hostile order could list MY coins (publickey:auto signed
     *  them; the take came back complete) or MY script (newscript REPLACES the row as non-simple, key 0x00). Against the
     *  fresh scripts table: refuse both, and return the keys of MY input addresses — the only keys I sign with.
     *  Returns { err } or { keys }. */
    function takerGuard(rows, p) {
        var byAddr = {}, mine = {}, keys = [], i, r, norm = function (x) { return String(x || '').trim().replace(/\s+/g, ' ').toUpperCase(); };
        for (i = 0; i < (rows || []).length; i++) {
            r = rows[i];
            if (!r || !(r.simple === true || r.simple === 'true') || !/^0x[0-9A-Fa-f]{64}$/.test(String(r.publickey || ''))) continue;
            byAddr[String(r.address).toLowerCase()] = r.publickey; mine[norm(r.script)] = true;
        }
        for (i = 0; i < (p.scripts || []).length; i++) if (mine[norm(p.scripts[i])]) return { err: 'refused: the order lists one of your own scripts' };
        for (i = 0; i < (p.makerAddrs || []).length; i++) if (byAddr[p.makerAddrs[i]]) return { err: 'refused: the order lists a coin at one of your own addresses' };
        for (i = 0; i < (p.takerAddrs || []).length; i++) {
            var pk = byAddr[p.takerAddrs[i]];
            if (!pk) return { err: 'refused: no signing key for your coin address ' + p.takerAddrs[i] };
            if (keys.indexOf(pk) < 0) keys.push(pk);
        }
        return keys.length ? { keys: keys } : { err: 'refused: none of your coins to sign' };
    }

    function build(mds, p, cb) {
        mds.cmdR('scripts', function (es, rows) {
            if (es) return cb(new Error('cannot read your wallet scripts: ' + es.message));
            var g = takerGuard(Object.prototype.toString.call(rows) === '[object Array]' ? rows : [], p);
            if (g.err) return cb(new Error(g.err));
            buildSigned(mds, p, g.keys, cb);
        });
    }

    function buildSigned(mds, p, keys, cb) {
        var id = txnId('dx');
        var steps = [];
        for (var s = 0; s < (p.scripts || []).length; s++) steps.push('newscript script:"' + p.scripts[s] + '" trackall:false');
        steps.push('txncreate id:' + id);
        for (var i = 0; i < p.inputs.length; i++) steps.push('txninput id:' + id + ' coinid:' + p.inputs[i] + ' scriptmmr:true');
        for (i = 0; i < p.outputs.length; i++) {
            var o = p.outputs[i];
            steps.push('txnoutput id:' + id + ' amount:' + o.amount + ' address:' + o.address + (eqTok(o.tokenid, MINIMA) ? '' : ' tokenid:' + o.tokenid));
        }
        for (var k = 0; k < keys.length; k++) steps.push('txnsign id:' + id + ' publickey:' + keys[k]);   // never auto: only MY input keys
        var hex = null;
        runSeq(mds, steps, function (err) {
            if (err) return finish(err);
            mds.cmdR('txnexport id:' + id, function (e2, r) {
                if (e2) return finish(e2);
                hex = r && (r.data || r.txn || (typeof r === 'string' ? r : null));
                finish(hex ? null : new Error('txnexport returned no data'));
            });
        });
        function finish(err) { mds.cmd('txndelete id:' + id, function () { cb(err, hex); }); }
    }

    /**
     * Maker: decode (txnview), verify via verifyFn(txn) → {ok, reason}, then import, sign, check, post.
     * cb(err, txpowid, verdict, outputCoinIds). Any failure after import ends with txndelete.
     * NOTE the txpowid txnpost returns is the PRE-MINING id; the mined TxPoW has a different id, so settlement is
     * tracked by the deterministic output coin ids (`coins coinid:` finds them once the fill is in a block).
     */
    /** The public keys of an order's own simple scripts — the only keys the maker signs a take with. */
    function signKeys(scripts) {
        var out = [], m, i;
        for (i = 0; scripts && i < scripts.length; i++) {
            m = /^RETURN SIGNEDBY\((0x[0-9A-Fa-f]{64})\)$/.exec(String(scripts[i] || '').trim());
            if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
        }
        return out;
    }

    /** Security review 30 Oct (mirror of the APK 0.1.48): inputs are classified against the wallet's FULL, fresh script
     *  table (a cached address list let a taker pass off a coin of mine as its own), and only `keys` — the order's
     *  own — sign, never publickey:auto (which signs every input the node holds a key for). verifyFn(txn, wallet). */
    function cosign(mds, hex, keys, verifyFn, cb) {
        if (!keys || !keys.length) return cb(new Error('refused: order has no signing key'));
        mds.cmdR('scripts', function (es, rows) {
            var wallet = {}, i, list = Object.prototype.toString.call(rows) === '[object Array]' ? rows : [];
            for (i = 0; i < list.length; i++) if (list[i] && list[i].address) wallet[String(list[i].address).toLowerCase()] = true;
            if (es || !Object.keys(wallet).length) return cb(new Error('refused: cannot read my wallet addresses'));
            cosignWith(mds, hex, keys, wallet, verifyFn, cb);
        });
    }

    /** Review 7 Nov (H-1): every input not at one of my addresses must sit at a witness script of exactly
     *  RETURN SIGNEDBY(0x..) whose key already carries a VALID signature; no invalid signature; at least one taker input.
     *  view = txnview response, pre = pre-sign txncheck response, wallet = {lowercase address: true}. */
    function takerAuthorised(view, pre, wallet) {
        var txn = view && view.transaction, wit = view && view.witness, v = pre && pre.valid;
        var ins = txn && txn.inputs, scripts = wit && wit.scripts, sigs = v && v.signatures, at = {}, signed = {}, coins = [], i, m;
        if (!ins || !scripts || !sigs) return { err: 'the take carries no taker signature' };
        for (i = 0; i < scripts.length; i++) if (scripts[i]) at[String(scripts[i].address || '').toLowerCase()] = String(scripts[i].script || '').trim();
        for (i = 0; i < sigs.length; i++) {
            if (!sigs[i] || sigs[i].valid !== true) return { err: 'a signature on the take is not valid' };
            signed[String(sigs[i].publickey || '').toUpperCase()] = true;
        }
        for (i = 0; i < ins.length; i++) {
            var addr = String((ins[i] && ins[i].address) || '').toLowerCase();
            if (!addr) return { err: 'an input has no address' };
            if (wallet[addr]) continue;
            m = /^RETURN SIGNEDBY\(0[xX]([0-9A-Fa-f]+)\)$/.exec(at[addr] || '');
            if (!m) return { err: 'a taker input is not a plain signed coin' };
            if (!signed['0X' + m[1].toUpperCase()]) return { err: 'the taker has not signed its input' };
            coins.push(ins[i].coinid);
        }
        if (!coins.length) return { err: 'the take has no taker input' };
        return { coins: coins };
    }

    function cosignWith(mds, hex, keys, wallet, verifyFn, cb) {
        mds.cmdR('txnview data:' + hex, function (err, view) {
            if (err) return cb(err);
            var txn = view && view.transaction;
            if (!txn || !txn.inputs || !txn.outputs) return cb(new Error('txnview returned no transaction'));
            // review 7 Nov (R2-3, mirror of APK): scripts run on the MMR-proof coin; core does not tie the state shown in
            // transaction.inputs to it, so read state from the witness proofs themselves
            var proofs = (view.witness && view.witness.mmrproofs) || [];
            for (var pi = 0; pi < proofs.length; pi++) { var pc = proofs[pi] && proofs[pi].coin; if (pc && pc.state && pc.state.length) return cb(new Error('refused: an input carries state')); }
            var verdict = verifyFn(txn, Object.keys(wallet));
            if (!verdict || !verdict.ok) return cb(new Error('refused: ' + (verdict ? verdict.reason : 'no verdict')), null, verdict);
            var outCoins = []; for (var oi = 0; oi < txn.outputs.length; oi++) if (txn.outputs[oi] && txn.outputs[oi].coinid) outCoins.push(txn.outputs[oi].coinid);
            var id = txnId('dm');
            mds.cmdR('txnimport id:' + id + ' data:' + hex, function (e1) {
                if (e1) return cb(e1, null, verdict);
                // security review 7 Nov: check BEFORE signing — invented inputs used to cost a one-time key leaf per order key
                mds.cmdR('txncheck id:' + id, function (e0, pre) {
                    if (e0) return fail(e0);
                    var pv = pre && pre.valid;
                    if (!(pv && pv.basic && pv.mmrproofs && pre.validamounts)) return fail(new Error('refused: the take\'s inputs or amounts are not valid'));
                    // review 7 Nov (H-1, mirror of APK 0.2.67): never sign for a taker who has not, nor against a taker input
                    // already spent or in the mempool - each try cost a one-time key use per order key
                    var gate = takerAuthorised(view, pre, wallet);
                    if (gate.err) return fail(new Error('refused: ' + gate.err));
                    // `coins coinid:` only sees my node's unpruned window (~1024 blocks): a coin older than that is not found
                    // at all, and valid.mmrproofs (required above) proves it unspent on chain. Only a coin I CAN see must also
                    // be out of the mempool.
                    (function free(i) {
                        if (i >= gate.coins.length) return signAndPost();
                        mds.cmdR('coins coinid:' + gate.coins[i], function (ea, seen) {
                            if (ea) return fail(new Error('refused: cannot check the taker\'s inputs (' + (ea.message || ea) + ')'));
                            if (!seen || !seen.length) return free(i + 1);   // outside my window
                            mds.cmdR('coins coinid:' + gate.coins[i] + ' checkmempool:true', function (ec, rows) {
                                if (ec) return fail(new Error('refused: cannot check the taker\'s inputs (' + (ec.message || ec) + ')'));
                                if (!rows || !rows.length) return fail(new Error('refused: a taker input is already being spent (mempool)'));
                                free(i + 1);
                            });
                        });
                    })(0);
                });
            });
            function signAndPost() {
                runSeq(mds, keys.map(function (k) { return 'txnsign id:' + id + ' publickey:' + k; }), function (e2) {
                    if (e2) return fail(e2);
                    mds.cmdR('txncheck id:' + id, function (e3, chk) {
                        if (e3) return fail(e3);
                        var v = chk && chk.valid, sigs = v && v.signatures, allSigs = true;
                        for (var i = 0; sigs && i < sigs.length; i++) if (!sigs[i].valid) allSigs = false;
                        if (!(v && v.basic && v.mmrproofs && v.scripts && chk.validamounts && allSigs)) return fail(new Error('txncheck not valid: ' + JSON.stringify(v)));
                        mds.cmdR('txnpost id:' + id, function (e4, post) {
                            if (e4) return fail(e4);
                            // A successful txnpost IS success: the txpowid (top-level on RPC/MDS, or under txpow) is display-only.
                            var txpowid = (post && (post.txpowid || (post.txpow && post.txpow.txpowid))) || ('posted-' + id);
                            mds.cmd('txndelete id:' + id, function () { cb(null, txpowid, verdict, outCoins); });
                        });
                    });
                });
            }
            function fail(e) { mds.cmd('txndelete id:' + id, function () { cb(e, null, verdict); }); }
        });
    }

    function runSeq(mds, cmds, cb) {
        var i = 0;
        function step() {
            if (i >= cmds.length) return cb(null);
            var c = cmds[i++];
            mds.cmdR(c, function (err) { if (err) return cb(new Error(c.split(' ')[0] + ': ' + err.message)); step(); });
        }
        step();
    }

    /** Dev/test chains have no mainnet MxUSD: point the dollar leg at a test token (kv 'mxusd_tokenid'). Never on mainnet. */
    function setMxUsd(tokenid) { if (tokenid && /^0x[0-9a-fA-F]{64}$/.test(tokenid)) { MXUSD = tokenid; AX.fill.MXUSD = tokenid; } }
    /** Security review 30 Oct (mirror of the APK 0.1.56): the override applies only on a PROVEN test chain (tip below
     *  1 000 000 — mainnet is past 2.39 M; the node exposes no network flag), else the mainnet MxUSD is restored.
     *  cb(applied). Callers use this, never setMxUsd directly. */
    var MAINNET_MIN_BLOCK = 1000000, MAINNET_MXUSD = MXUSD;
    function overrideOnTestChain(mds, tokenid, cb) {
        if (!tokenid) { MXUSD = AX.fill.MXUSD = MAINNET_MXUSD; return cb && cb(false); }
        mds.cmdR('block', function (e, r) {
            var tip = Number((r && r.block) || 0);
            var ok = !e && tip > 0 && tip < MAINNET_MIN_BLOCK && /^0x[0-9a-fA-F]{64}$/.test(tokenid);
            if (ok) setMxUsd(tokenid); else { MXUSD = AX.fill.MXUSD = MAINNET_MXUSD; }
            if (cb) cb(ok);
        });
    }
    AX.fill = { MIN_REM: MIN_REM, floorTake: floorTake, MINIMA: MINIMA, MXUSD: MXUSD, d: d, up8: up8, down8: down8, fit44: fit44, plain: plain, coinValue: coinValue, pick: pick,
                spreadIndex: spreadIndex, plan: plan, verifyAsMaker: verifyAsMaker, build: build, takerGuard: takerGuard, cosign: cosign, takerAuthorised: takerAuthorised, signKeys: signKeys, setMxUsd: setMxUsd, overrideOnTestChain: overrideOnTestChain };
})(typeof globalThis !== 'undefined' ? globalThis : this);
