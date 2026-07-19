/**
 * otc — the OTC (negotiated peer-to-peer) engine, a faithful port of native OtcOffer/OtcMessage/OtcDb/OtcController.
 * An LP advertises standing availability (two-sided sell/buy caps) on the OTC board; an instigator PROPOSEs a deal
 * (amount + price); the two negotiate PROPOSE→COUNTER/ACCEPT/REJECT until AGREED; the instigator then locks leg 1
 * with otc=TRUE and EXECUTEs (sends the hashlock); the LP's responder locks the counter-leg ONLY if the on-chain
 * lock EXACTLY matches the agreed terms (otcVerifyBuy/Sell — the fund-safety boundary that REPLACES the ladder gate).
 *
 * All deal/turn state is durable in kv-SQL (otc_deals + otc_msgs), correlated by ref, deduped by randomid — the
 * comms transport is stateless 1-nano coins. Every non-PROPOSE transition is authenticated (must come from the
 * deal's counterparty) and consent-gated (only legal on your turn). Fund-safety carried verbatim: an OTC response
 * fires ONLY while the deal's negotiating currency is active; otcVerify* requires exact amount/token/address match.
 *
 * configure({ identity, myMinimaPk, ethAddr, notify?, onDealsChanged?, onExecute?(deal), onIncomingHash?(hash) }).
 * Requires AX.swapdb(? no) AX.mds, AX.identity, AX.order, AX.orderbook, AX.trading, AX.dec, AX.flow, AX.hex. Attaches to AX.otc.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, ID = AX.identity, TR = AX.trading, D = AX.dec, F = AX.flow, H = AX.hex, EO = AX.ethops;

    // sides (LP perspective) + roles + statuses + turns
    var SELL = 'SELL', BUY = 'BUY';   // LP sells mxUSDT (instigator buys) / LP buys mxUSDT (instigator sells)
    var ROLE_INSTIGATOR = 'INSTIGATOR', ROLE_LP = 'LP';
    var ST_PROPOSED = 'PROPOSED', ST_COUNTERED = 'COUNTERED', ST_AGREED = 'AGREED', ST_EXECUTING = 'EXECUTING',
        ST_COMPLETE = 'COMPLETE', ST_REJECTED = 'REJECTED', ST_EXPIRED = 'EXPIRED';
    var TURN_ME = 'ME', TURN_PEER = 'PEER';
    var PROPOSE = 'PROPOSE', COUNTER = 'COUNTER', ACCEPT = 'ACCEPT', REJECT = 'REJECT', EXECUTE = 'EXECUTE';
    var EXPIRE_MS = 60 * 60 * 1000, PRUNE_MS = 24 * 60 * 60 * 1000;
    var EXEC_CLAIM_TTL_MS = 10 * 60 * 1000;   // a dead claimant's otc_exec row is stealable after this
    // Retry/re-arm pacing MUST exceed the worst-case ETH broadcast (~4 RPC calls × 9-endpoint fallback ≈ 7min):
    // a shorter window would re-execute (NEW hash → second funded HTLC) while a SLOW — not crashed — broadcast is
    // still in flight, recreating the exact double-lock the otc_exec claim exists to prevent.
    var EXEC_RETRY_MS = 10 * 60 * 1000;

    var C = null, myOffer = { enable: false, sellSize: 0, buySize: 0 };
    function configure(ctx) { C = ctx; }
    function ready() { return !!(C && C.identity && C.myMinimaPk && C.ethAddr); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    function changed() { if (C && C.onDealsChanged) C.onDealsChanged(); }
    function num(s) { var n = Number(s); return isFinite(n) ? n : 0; }
    function esc(s) { return M.esc(s == null ? '' : s); }
    function normHash(h) { if (!h) return ''; var s = String(h).trim().toLowerCase(); return s.indexOf('0x') === 0 ? s.slice(2) : s; }
    function sqlErr(r) { return (r && r.status) ? null : new Error('sql: ' + (r && r.error)); }
    function rows(r) { return (r && r.rows) ? r.rows : []; }

    // ================= durable state (kv-SQL) =================
    function initDb(cb) {
        var ddl = [
            "CREATE TABLE IF NOT EXISTS `otc_deals` (`ref` varchar(80) NOT NULL PRIMARY KEY, `role` varchar(20), `peercid` varchar(200), " +
                "`peermpk` varchar(200), `peereth` varchar(80), `side` varchar(10), `amount` text, `price` text, `status` varchar(20), " +
                "`whoseturn` varchar(10), `hash` varchar(200), `currency` varchar(20), `created` bigint, `updated` bigint)",
            "CREATE TABLE IF NOT EXISTS `otc_msgs` (`randomid` varchar(80) NOT NULL PRIMARY KEY, `ref` varchar(80), `type` varchar(20), " +
                "`sender` varchar(200), `side` varchar(10), `amount` text, `price` text, `hash` varchar(200), `date` bigint)",
            // otc_exec: a single-winner claim per deal-ref so only ONE instance (UI or service, which share this DB)
            // executes leg 1 of an AGREED deal — the atomic gate that stops a cross-instance double-lock. `ts` makes
            // a DEAD claimant's row stealable (a restart regenerates execToken; without the TTL the deal would stall
            // unexecutable until it expired).
            "CREATE TABLE IF NOT EXISTS `otc_exec` (`ref` varchar(80) NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)"
        ];
        F.each(ddl, function (s, i, n) { M.sql(s, function (r) { n(sqlErr(r)); }); }, function (e) {
            if (e) return cb(e);
            // migration probe: a pre-TTL install has otc_exec WITHOUT `ts` — recreate it (rows are transient claims;
            // losing them at upgrade is acceptable, the status check + row dedup keep execution idempotent).
            M.sql("SELECT `ts` FROM `otc_exec` LIMIT 1", function (r) {
                if (r && r.status) return cb(null);
                M.sql("DROP TABLE `otc_exec`", function () {
                    M.sql("CREATE TABLE IF NOT EXISTS `otc_exec` (`ref` varchar(80) NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)",
                        function (r2) { cb(sqlErr(r2)); });
                });
            });
        });
    }

    // Per-INSTANCE token (UI vs service differ; stable across this process's retries). Generated lazily.
    var execToken = null;
    function ensureToken(cb) { if (execToken) return cb(execToken); rndHex(8, function (t) { execToken = t || ('t' + Date.now()); cb(execToken); }); }
    /** Atomically claim the right to execute leg 1 for `ref` — INSERT-if-absent, then a steal-UPDATE (my own row →
     *  refresh, a DEAD claimant's row past EXEC_CLAIM_TTL_MS → take over), then read back the owner. Only the
     *  instance whose token stuck wins; a retry by the same instance re-wins (idempotent). cb(won). */
    function claimExecute(ref, cb) {
        ensureToken(function (tok) {
            var r = esc(ref), t = esc(tok), now = Date.now();
            M.sql("INSERT INTO `otc_exec` (`ref`,`owner`,`ts`) SELECT '" + r + "','" + t + "'," + now +
                " WHERE NOT EXISTS (SELECT 1 FROM `otc_exec` WHERE `ref`='" + r + "')", function () {
                M.sql("UPDATE `otc_exec` SET `owner`='" + t + "', `ts`=" + now + " WHERE `ref`='" + r +
                    "' AND (`owner`='" + t + "' OR `ts` IS NULL OR `ts` < " + (now - EXEC_CLAIM_TTL_MS) + ")", function () {
                    M.sql("SELECT `owner` FROM `otc_exec` WHERE `ref`='" + r + "' LIMIT 1", function (res) {
                        var rs = rows(res); cb(rs.length && rs[0].OWNER === tok);
                    });
                });
            });
        });
    }
    function readDeal(r) {
        return { ref: r.REF, role: r.ROLE, peerCommsId: r.PEERCID, peerMinimaPk: r.PEERMPK, peerEthAddr: r.PEERETH,
            side: r.SIDE, amount: r.AMOUNT, price: r.PRICE, status: r.STATUS, whoseTurn: r.WHOSETURN, hash: r.HASH,
            currency: r.CURRENCY, created: Number(r.CREATED), updated: Number(r.UPDATED) };
    }
    function upsertDeal(d, cb) {
        if (!d.created) d.created = Date.now();
        if (!d.currency) d.currency = TR.active().key;
        M.sql("MERGE INTO `otc_deals` (`ref`,`role`,`peercid`,`peermpk`,`peereth`,`side`,`amount`,`price`,`status`," +
            "`whoseturn`,`hash`,`currency`,`created`,`updated`) KEY(`ref`) VALUES ('" + esc(d.ref) + "','" + esc(d.role) + "','" +
            esc(d.peerCommsId) + "','" + esc(d.peerMinimaPk) + "','" + esc(d.peerEthAddr) + "','" + esc(d.side) + "','" + esc(d.amount) +
            "','" + esc(d.price) + "','" + esc(d.status) + "','" + esc(d.whoseTurn) + "','" + esc(normHash(d.hash)) + "','" +
            esc(d.currency) + "'," + d.created + "," + Date.now() + ")", function (r) { cb && cb(sqlErr(r)); });
    }
    function getDeal(ref, cb) {
        if (!ref) return cb(null, null);
        M.sql("SELECT * FROM `otc_deals` WHERE `ref`='" + esc(ref) + "' LIMIT 1", function (r) {
            var rs = rows(r); cb(sqlErr(r), rs.length ? readDeal(rs[0]) : null);
        });
    }
    function dealByHash(hash, cb) {
        var h = normHash(hash); if (!h) return cb(null, null);
        M.sql("SELECT * FROM `otc_deals` WHERE replace(lower(`hash`),'0x','')='" + esc(h) + "' ORDER BY `updated` DESC LIMIT 1",
            function (r) { var rs = rows(r); cb(sqlErr(r), rs.length ? readDeal(rs[0]) : null); });
    }
    function allDeals(cb) {
        M.sql("SELECT * FROM `otc_deals` ORDER BY `updated` DESC", function (r) { cb(sqlErr(r), rows(r).map(readDeal)); });
    }
    function deleteDeal(ref, cb) {
        M.sql("DELETE FROM `otc_msgs` WHERE `ref`='" + esc(ref) + "'", function () {
            M.sql("DELETE FROM `otc_deals` WHERE `ref`='" + esc(ref) + "'", function (r) { cb && cb(sqlErr(r)); });
        });
    }
    /** addMsg(m, cb(err, added)) — dedup by randomid via INSERT…WHERE NOT EXISTS (atomic + idempotent). */
    function addMsg(m, cb) {
        if (!m.randomid) return cb(null, false);
        var rid = esc(m.randomid);
        M.sql("SELECT 1 AS X FROM `otc_msgs` WHERE `randomid`='" + rid + "' LIMIT 1", function (r) {
            if (rows(r).length) return cb(null, false);
            M.sql("INSERT INTO `otc_msgs` (`randomid`,`ref`,`type`,`sender`,`side`,`amount`,`price`,`hash`,`date`) VALUES ('" +
                rid + "','" + esc(m.ref) + "','" + esc(m.type) + "','" + esc(m.from || m.sender) + "','" + esc(m.side) + "','" +
                esc(m.amount) + "','" + esc(m.price) + "','" + esc(m.hash) + "'," + (Number(m.date) || Date.now()) + ")",
                function (r2) { cb(sqlErr(r2), !sqlErr(r2)); });
        });
    }
    function msgs(ref, cb) {
        M.sql("SELECT * FROM `otc_msgs` WHERE `ref`='" + esc(ref) + "' ORDER BY `date` ASC", function (r) {
            cb(sqlErr(r), rows(r).map(function (x) { return { randomid: x.RANDOMID, ref: x.REF, type: x.TYPE, from: x.SENDER, side: x.SIDE, amount: x.AMOUNT, price: x.PRICE, hash: x.HASH, date: Number(x.DATE) }; }));
        });
    }

    // ================= offer / board =================
    function offerToJson(o) { return { sellsz: o.sellSize, buysz: o.buySize, en: o.enable, mpk: o.minimaPublicKey, eth: o.ethAddress, cid: o.commsPublicId, ts: o.ts }; }
    function offerFromJson(j) {
        var o = { enable: !!j.en, minimaPublicKey: j.mpk || '', ethAddress: j.eth || '', commsPublicId: j.cid || '', ts: Number(j.ts) || 0, sellSize: 0, buySize: 0, signerPk: '', coinid: '' };
        if (j.sellsz != null || j.buysz != null) { o.sellSize = num(j.sellsz); o.buySize = num(j.buysz); }
        else { var sz = num(j.size); if (j.side === BUY) o.buySize = sz; else o.sellSize = sz; }   // legacy single-sided
        return o;
    }
    function offerHasLiquidity(o) { return o.enable && (o.sellSize > 0 || o.buySize > 0); }
    function setMyOffer(enable, sellSize, buySize) { myOffer = { enable: !!enable, sellSize: num(sellSize), buySize: num(buySize) }; }

    /** Publish my OTC availability (signed 1-nano coin at the OTC board sentinel). cb(err). */
    function publishOffer(cb) {
        var o = { sellSize: myOffer.sellSize, buySize: myOffer.buySize, enable: myOffer.enable,
            minimaPublicKey: C.myMinimaPk, ethAddress: C.ethAddr, commsPublicId: C.identity.publicId(), ts: Date.now() };
        var msg = H.utf8(JSON.stringify(offerToJson(o)));
        var sig = AX.sodium.signDetached(msg, C.identity.signSk);
        var state = { '1': '0x' + H.to(C.identity.signPk), '2': '0x' + H.to(sig), '99': '0x' + H.to(msg) };
        M.cmdR('send amount:0.000000001 address:' + TR.active().otcBoardAddr + ' tokenid:0x00 state:' + JSON.stringify(state), function (err) { cb && cb(err); });
    }
    /** Scan the OTC board → cb(err, [offer]) freshest-per-signer with liquidity, excluding mine. */
    function scanBoard(cb) {
        var addr = TR.active().otcBoardAddr, myId = C ? C.identity.publicId() : null;
        M.cmd('coinnotify action:add address:' + addr, function () {
            M.cmd('coins simplestate:true order:desc depth:72 address:' + addr, function (r) {
                var coins = (r && r.response instanceof Array) ? r.response : [], best = {};
                for (var i = 0; i < coins.length; i++) {
                    var o = verifyOfferCoin(coins[i]); if (!o) continue;
                    var cur = best[o.signerPk];
                    if (!cur || o.ts > cur.ts) best[o.signerPk] = o;
                }
                var out = [];
                for (var k in best) { var o = best[k]; if (offerHasLiquidity(o) && o.commsPublicId !== myId) out.push(o); }
                cb(null, out);
            });
        });
    }
    function verifyOfferCoin(coin) {
        try {
            var orderHex = AX.htlc.stateAt(coin, 99), pkHex = AX.htlc.stateAt(coin, 1), sigHex = AX.htlc.stateAt(coin, 2);
            if (!orderHex || !pkHex || !sigHex) return null;
            var msg = H.from(orderHex), pk = H.from(pkHex), sig = H.from(sigHex);
            if (!AX.sodium.signVerify(sig, msg, pk)) return null;
            var o = offerFromJson(JSON.parse(H.utf8Decode(msg)));
            o.signerPk = ('0x' + H.to(pk)).toLowerCase(); o.coinid = coin.coinid || '';
            return o;
        } catch (e) { return null; }
    }

    // ================= message send =================
    function rndHex(bytes, cb) { M.cmdR('random size:' + bytes, function (e, r) { cb(e ? null : String((r && r.random) || '').replace(/^0x/i, '')); }); }
    function sendMsg(d, type, hash, cb) {
        rndHex(12, function (rid) {
            if (!rid) return cb(new Error('no random'));
            var m = { type: type, ref: d.ref, randomid: rid, from: C.identity.publicId(), to: d.peerCommsId, date: Date.now(),
                side: d.side, amount: d.amount, price: d.price, minimaPk: C.myMinimaPk, ethAddr: C.ethAddr, hash: hash || '' };
            addMsg(m, function () {
                changed();
                var blob;
                try { blob = ID.seal(C.identity, d.peerCommsId, H.utf8(JSON.stringify(wire(m)))); }
                catch (e) { return cb(new Error('otc seal: ' + e.message)); }
                M.cmdR('send amount:0.000000001 address:' + TR.active().otcChatAddr + ' tokenid:0x00 state:' + JSON.stringify({ '99': '0x' + blob }), function (err) { cb(err); });
            });
        });
    }
    function wire(m) { return { type: m.type, ref: m.ref, randomid: m.randomid, from: m.from, to: m.to, date: m.date, side: m.side, amount: m.amount, price: m.price, minimaPk: m.minimaPk, ethAddr: m.ethAddr, hash: m.hash || '' }; }

    // ================= outbound (instigator/LP actions) =================
    function isTerminal(st) { return st === ST_REJECTED || st === ST_EXPIRED || st === ST_COMPLETE; }
    function propose(lp, dealSide, amount, price, cb) {
        if (!ready()) return cb(new Error('still connecting'));
        if (num(amount) <= 0 || num(price) <= 0) return cb(new Error('enter amount + price'));
        rndHex(16, function (ref) {
            if (!ref) return cb(new Error('no random'));
            var d = { ref: ref, role: ROLE_INSTIGATOR, peerCommsId: lp.commsPublicId, peerMinimaPk: lp.minimaPublicKey,
                peerEthAddr: lp.ethAddress, side: dealSide, amount: amount, price: price, status: ST_PROPOSED, whoseTurn: TURN_PEER };
            upsertDeal(d, function () { sendMsg(d, PROPOSE, '', cb); });
        });
    }
    function counter(d, amount, price, cb) {
        if (!ready() || isTerminal(d.status) || d.whoseTurn !== TURN_ME) return cb(new Error('not your turn'));
        if (num(amount) <= 0 || num(price) <= 0) return cb(new Error('enter amount + price'));
        d.amount = amount; d.price = price; d.status = ST_COUNTERED; d.whoseTurn = TURN_PEER;
        upsertDeal(d, function () { sendMsg(d, COUNTER, '', cb); });
    }
    function accept(d, cb) {
        if (!ready() || isTerminal(d.status) || d.whoseTurn !== TURN_ME) return cb(new Error('not your turn'));
        d.status = ST_AGREED; d.whoseTurn = (d.role === ROLE_INSTIGATOR) ? TURN_ME : TURN_PEER;
        upsertDeal(d, function () { sendMsg(d, ACCEPT, '', function (e) { if (!e && d.role === ROLE_INSTIGATOR) executeDeal(d, function () {}); cb(e); }); });
    }
    function reject(d, cb) {
        if (!ready()) return cb(new Error('still connecting'));
        d.status = ST_REJECTED; upsertDeal(d, function () { sendMsg(d, REJECT, '', cb); });
    }
    /** Instigator: on AGREED, lock leg 1 (otc=TRUE) via the engine, then EXECUTE-notify the LP. Idempotent. */
    function executeDeal(d, cb) {
        cb = cb || function () {};
        if (!ready() || d.role !== ROLE_INSTIGATOR) return cb();
        getDeal(d.ref, function (e, cur) {
            if (!cur || cur.status !== ST_AGREED) return cb();   // already executing / not agreed
            // SINGLE-ACTOR: only the instance that wins the atomic claim locks leg 1 — the UI and service both drive
            // this state machine over the shared DB, so without this both could read AGREED and lock (two hashlocks,
            // two funded HTLCs, both refunding at the ~2h timelock). The winner keeps the claim across its own retries.
            claimExecute(cur.ref, function (won) {
                if (!won) return cb();   // the other instance owns this execute
                cur.status = ST_EXECUTING;
                upsertDeal(cur, function () {
                changed();
                if (!C.onExecute) return cb();
                C.onExecute(cur, function (err, hash) {
                    if (err || !hash) {   // reset so it can retry
                        getDeal(cur.ref, function (e2, c2) { if (c2 && c2.status === ST_EXECUTING && !c2.hash) { c2.status = ST_AGREED; upsertDeal(c2, function () { changed(); }); } });
                        notify('OTC execute failed', err ? err.message : 'no hash'); return cb(err);
                    }
                    getDeal(cur.ref, function (e2, c2) {
                        if (!c2) return cb();
                        c2.hash = hash; c2.status = ST_EXECUTING;
                        upsertDeal(c2, function () { sendMsg(c2, EXECUTE, hash, function () {}); notify('OTC executing', 'Locked your side — waiting for the counterparty'); changed(); cb(); });
                    });
                });
                });   // close upsertDeal(cur)
            });       // close claimExecute
        });           // close getDeal(d.ref)
    }

    // ================= inbound (route a decrypted OTC message) =================
    /** route(opened) — opened = { valid, fromPublicId, plaintext }. Authenticates + drives the state machine. cb(err, handled). */
    function route(opened, cb) {
        cb = cb || function () {};
        if (!opened || !opened.valid) return cb(null, false);
        var m; try { m = JSON.parse(H.utf8Decode(opened.plaintext)); } catch (e) { return cb(null, false); }
        if (!m || !m.ref || !m.randomid) return cb(null, false);
        if (!C || C.identity.publicId() !== m.to) return cb(null, false);            // not for me
        if (opened.fromPublicId !== m.from) return cb(null, false);                  // bind envelope sender to claimed from
        if (m.type === PROPOSE) {
            getDeal(m.ref, function (e, existing) {
                if (existing) return cb(null, false);                               // already have this deal
                applyPropose(m, function (created) { if (created) addMsg(m, function () { cb(null, true); }); else cb(null, false); });
            });
            return;
        }
        addMsg(m, function (e, added) {
            if (!added) return cb(null, false);                                     // dedup by randomid
            apply(m, function () { cb(null, true); });
        });
    }
    function applyPropose(m, done) {
        var cap = m.side === SELL ? myOffer.sellSize : myOffer.buySize;
        if (!myOffer.enable || cap <= 0) return done(false);                        // I must be a LIVE LP on THIS side
        if (num(m.amount) <= 0 || num(m.amount) > cap + 1e-9 || num(m.price) <= 0) return done(false);
        var d = { ref: m.ref, role: ROLE_LP, peerCommsId: m.from, peerMinimaPk: m.minimaPk, peerEthAddr: m.ethAddr,
            side: m.side, amount: m.amount, price: m.price, status: ST_PROPOSED, whoseTurn: TURN_ME };
        upsertDeal(d, function () { notify('OTC offer received', m.amount + ' ' + TR.active().coinLabel + ' @ ' + m.price + ' — your call'); changed(); done(true); });
    }
    function apply(m, done) {
        getDeal(m.ref, function (e, d) {
            // CONSENT + AUTHENTICITY: transition needs an existing deal AND the message must come from its counterparty.
            if (!d || m.from !== d.peerCommsId) return done();
            if (m.type === REJECT) {
                if (isTerminal(d.status)) return done();
                d.status = ST_REJECTED; return upsertDeal(d, function () { notify('OTC rejected', 'The counterparty ended the deal'); changed(); done(); });
            }
            if (m.type === EXECUTE) {
                if (d.role !== ROLE_LP || !m.hash) return done();
                var agreed = d.status === ST_AGREED, implicit = d.status === ST_COUNTERED && d.whoseTurn === TURN_PEER;
                if (!agreed && !implicit) return done();
                d.hash = m.hash; d.status = ST_EXECUTING;
                return upsertDeal(d, function () {
                    if (d.side === SELL && C && C.onIncomingHash) C.onIncomingHash(m.hash);   // instigator locked USDT → find it
                    notify('OTC executing', 'Counterparty locked — locking your side'); changed(); done();
                });
            }
            if (d.whoseTurn !== TURN_PEER) return done();   // CONSENT: COUNTER/ACCEPT only when I'm waiting on the peer
            if (m.type === COUNTER) {
                if (isTerminal(d.status) || num(m.amount) <= 0 || num(m.price) <= 0) return done();
                d.amount = m.amount; d.price = m.price; d.status = ST_COUNTERED; d.whoseTurn = TURN_ME;
                return upsertDeal(d, function () { notify('OTC counter', m.amount + ' ' + TR.active().coinLabel + ' @ ' + m.price + ' — your call'); changed(); done(); });
            }
            if (m.type === ACCEPT) {
                if (isTerminal(d.status) || d.status === ST_AGREED || d.status === ST_EXECUTING) return done();
                d.status = ST_AGREED; d.whoseTurn = (d.role === ROLE_INSTIGATOR) ? TURN_ME : TURN_PEER;
                return upsertDeal(d, function () { notify('OTC agreed', d.amount + ' ' + TR.active().coinLabel + ' @ ' + d.price); changed(); if (d.role === ROLE_INSTIGATOR) executeDeal(d, done); else done(); });
            }
            done();
        });
    }

    /** Scan the OTC chat sentinel, decrypt messages to me, route each. cb(). */
    function scanChat(cb) {
        cb = cb || function () {};
        if (!ready()) return cb();
        var addr = TR.active().otcChatAddr;
        M.cmd('coinnotify action:add address:' + addr, function () {
            M.cmd('coins simplestate:true order:desc depth:72 address:' + addr, function (r) {
                var coins = (r && r.response instanceof Array) ? r.response : [];
                F.each(coins, function (coin, i, n) {
                    var blob = AX.htlc.stateAt(coin, 99);
                    if (!blob) return n();
                    var opened = null;
                    try { opened = ID.open(C.identity, String(blob).replace(/^0x/i, '')); } catch (e) { }
                    if (!opened) return n();
                    route(opened, function () { n(); });
                }, cb);
            });
        });
    }

    // ================= LP verify (the fund-safety boundary — REPLACES the ladder gate for OTC) =================
    function approxEq(a, b) { return Math.abs(num(a) - num(b)) <= 1e-5; }
    function keyEq(a, b) { return a && b && AX.htlc.normKey(a) === AX.htlc.normKey(b); }
    /** An AGREED/EXECUTING LP deal for this hash in the ACTIVE currency; null ⇒ don't respond. cb(deal|null). */
    function otcLpDeal(hash, cb) {
        dealByHash(hash, function (e, d) {
            if (!d || d.role !== ROLE_LP) return cb(null);
            if (d.currency && d.currency !== TR.active().key) return cb(null);   // negotiated in another currency
            if (d.status !== ST_AGREED && d.status !== ST_EXECUTING) return cb(null);
            // defense-in-depth (native parity): never re-respond to a hash whose on-chain swap already finished.
            if (AX.swapdb && AX.swapdb.getSwap) {
                return AX.swapdb.getSwap(hash, function (es, s) {
                    if (s && (s.status === AX.swapdb.ST_COMPLETE || s.status === AX.swapdb.ST_REFUNDED || s.status === AX.swapdb.ST_ERROR)) return cb(null);
                    cb(d);
                });
            }
            cb(d);
        });
    }
    /** Instigator BUYS mxUSDT (I'm the LP selling): the incoming ERC20 lock must match the deal exactly. */
    function otcVerifyBuy(c, d) {
        if (d.side !== SELL) return false;
        if (!c.tokenContract || c.tokenContract.toLowerCase() !== EO.NET.usdt.toLowerCase()) return false;   // real USDT
        if (!c.receiver || c.receiver.toLowerCase() !== String(C.ethAddr).toLowerCase()) return false;        // USDT to me
        if (!keyEq(c.minimaPublicKey, d.peerMinimaPk)) return false;                                          // mxUSDT to the agreed peer
        var wantMinima = num(d.amount), wantUsdt = num(d.amount) * num(d.price);
        var gotMinima = num(D.formatUnits(c.requestAmount, 18)), gotUsdt = num(D.formatUnits(c.amount, EO.NET.usdtDecimals));
        return approxEq(gotMinima, wantMinima) && approxEq(gotUsdt, wantUsdt);
    }
    /** Instigator SELLS mxUSDT (I'm the LP buying): the incoming Minima lock must match the deal exactly. */
    function otcVerifySell(coin, d, reqTokenAddr) {
        if (d.side !== BUY) return false;
        if (String(TR.active().tokenId).toLowerCase() !== String(coin.tokenid || '0x00').toLowerCase()) return false;
        if (!keyEq(AX.htlc.stateAt(coin, 4), C.myMinimaPk)) return false;                                     // mxUSDT to me
        var payEth = AX.htlc.stateAt(coin, 6);
        if (!payEth || payEth.toLowerCase() !== String(d.peerEthAddr).toLowerCase()) return false;            // I'll pay the agreed eth
        if (!reqTokenAddr || reqTokenAddr.toLowerCase() !== EO.NET.usdt.toLowerCase()) return false;          // agreed token
        var wantMinima = num(d.amount), wantUsdt = num(d.amount) * num(d.price);
        var gotMinima = num(AX.htlc.coinAmount(coin)), gotUsdt = num(AX.htlc.stateAt(coin, 1));
        return approxEq(gotMinima, wantMinima) && approxEq(gotUsdt, wantUsdt);
    }

    /** Expire stale deals + prune long-finished ones + RE-ARM stuck executes. settleFn(hash, cb(swapStatus)) links
     *  to on-chain settlement. Re-arm paths (both idempotent via claimExecute + the AGREED status check):
     *  • INSTIGATOR + AGREED (not stale) → retry executeDeal each poll (a failed/crashed execute previously had
     *    NOTHING re-triggering it — the deal silently died at expiry).
     *  • EXECUTING with NO hash past EXEC_RETRY_MS (crashed mid-execute) → back to AGREED so the retry fires. */
    function expireStale(now, settleFn, cb) {
        cb = cb || function () {};
        allDeals(function (e, list) {
            F.each(list || [], function (d, i, n) {
                var stale = now - d.updated > EXPIRE_MS;
                function finishTerminal() { if (isTerminal(d.status) && now - d.updated > PRUNE_MS) return deleteDeal(d.ref, n); n(); }
                if (d.status === ST_EXECUTING && d.hash) {
                    settleFn(d.hash, function (ss) {
                        if (ss === 'COMPLETE') { d.status = ST_COMPLETE; upsertDeal(d, function () { changed(); finishTerminal(); }); }
                        else if (ss === 'REFUNDED' || ss === 'ERROR') { d.status = ST_REJECTED; upsertDeal(d, function () { changed(); finishTerminal(); }); }
                        else if (!ss && stale) { d.status = ST_EXPIRED; upsertDeal(d, function () { changed(); finishTerminal(); }); }
                        else finishTerminal();
                    });
                } else if (stale && (d.status === ST_AGREED || (d.status === ST_EXECUTING && !d.hash) ||
                    ((d.status === ST_PROPOSED || d.status === ST_COUNTERED) && d.whoseTurn === TURN_PEER))) {
                    d.status = ST_EXPIRED; upsertDeal(d, function () { changed(); finishTerminal(); });
                } else if (d.status === ST_AGREED && d.role === ROLE_INSTIGATOR && now - d.updated > EXEC_RETRY_MS) {
                    executeDeal(d, function () { n(); });                     // paced retry (single-actor via claim)
                } else if (d.status === ST_EXECUTING && !d.hash && now - d.updated > EXEC_RETRY_MS) {
                    d.status = ST_AGREED; upsertDeal(d, function () { changed(); n(); });   // crashed mid-execute → re-arm
                } else finishTerminal();
            }, cb);
        });
    }

    AX.otc = {
        SELL: SELL, BUY: BUY, ROLE_INSTIGATOR: ROLE_INSTIGATOR, ROLE_LP: ROLE_LP,
        ST_PROPOSED: ST_PROPOSED, ST_COUNTERED: ST_COUNTERED, ST_AGREED: ST_AGREED, ST_EXECUTING: ST_EXECUTING,
        ST_COMPLETE: ST_COMPLETE, ST_REJECTED: ST_REJECTED, ST_EXPIRED: ST_EXPIRED, TURN_ME: TURN_ME, TURN_PEER: TURN_PEER,
        configure: configure, ready: ready, initDb: initDb, setMyOffer: setMyOffer, myOffer: function () { return myOffer; },
        publishOffer: publishOffer, scanBoard: scanBoard, scanChat: scanChat, route: route,
        propose: propose, counter: counter, accept: accept, reject: reject, executeDeal: executeDeal, expireStale: expireStale,
        getDeal: getDeal, dealByHash: dealByHash, allDeals: allDeals, deleteDeal: deleteDeal, upsertDeal: upsertDeal, addMsg: addMsg, msgs: msgs,
        otcLpDeal: otcLpDeal, otcVerifyBuy: otcVerifyBuy, otcVerifySell: otcVerifySell, offerFromJson: offerFromJson, offerToJson: offerToJson,
        claimExecute: claimExecute, _setExecToken: function (t) { execToken = t; }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
