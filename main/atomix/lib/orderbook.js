/**
 * orderbook — port of native swap/SwapOrderBook.java + the MainActivity routing (bestMakers/aggSide quote helpers).
 * Publishes/scans the shared on-chain order book (Ed25519-signed 1-nano coins at the currency's sentinel),
 * freshest-per-signer, tombstone-aware, largest-cap-first at equal price. Attaches to AX.book.
 * Requires AX.mds, AX.identity, AX.sodium, AX.hex, AX.order, AX.trading, AX.htlc, AX.flow.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, ID = AX.identity, S = AX.sodium, H = AX.hex, O = AX.order, TR = AX.trading;

    var SCAN_DEPTH = Math.floor(3600 / 50);   // 72 blocks (~1h)
    var SYM = O.SYM;

    function sentinel() { return TR.active().orderBookAddr; }

    // ---------- publish ----------
    /** Sign the order's canonical JSON with the identity's signSk and post it as a 1-nano coin at the sentinel. */
    function publish(me, order, cb) {
        order.ts = nowMs();
        order.cid = me.publicId();
        var msg = H.utf8(O.canonicalJson(order));
        var sig = S.signDetached(msg, me.signSk);
        var state = { '1': '0x' + H.to(me.signPk), '2': '0x' + H.to(sig), '99': '0x' + H.to(msg) };
        var cmd = 'send amount:0.000000001 address:' + sentinel() + ' tokenid:0x00 state:' + JSON.stringify(state);
        M.cmdR(cmd, function (err, resp, full) { cb(err, full); });
    }

    /** publishFresh: stamp the sendable balance (contract-locked coins excluded), then publish. */
    function publishFresh(me, order, cb) {
        M.cmdR('balance tokenid:' + TR.active().tokenId, function (err, r) {
            if (!err && r && r[0]) order.minimaAvail = Number(r[0].sendable) || 0;
            publish(me, order, cb);
        });
    }

    // ---------- scan + verify ----------
    /** scan(cb(err, bookMap)) — bookMap: signerPk(0x…) → freshest verified Order. */
    function scan(cb) {
        var addr = sentinel();
        M.cmd('coinnotify action:add address:' + addr, function () {
            M.cmd('coins simplestate:true order:desc depth:' + SCAN_DEPTH + ' address:' + addr, function (r) {
                var coins = (r && r.response instanceof Array) ? r.response : [];
                var book = {};
                for (var i = 0; i < coins.length; i++) {
                    var o = verifyCoin(coins[i]);
                    if (o) mergeFreshest(book, o);
                }
                cb(null, book);
            });
        });
    }

    /** Recover signer from state[1], verify the detached Ed25519 sig over state[99], parse the order. */
    function verifyCoin(coin) {
        try {
            var orderHex = stateVal(coin, 99), pkHex = stateVal(coin, 1), sigHex = stateVal(coin, 2);
            if (!orderHex || !pkHex || !sigHex) return null;
            var msg = H.from(orderHex), pk = H.from(pkHex), sig = H.from(sigHex);
            if (sig.length !== 64 || pk.length !== 32) return null;
            if (!S.signVerify(sig, msg, pk)) return null;
            var o = O.fromJson(JSON.parse(H.utf8Decode(msg)));
            o.signerPk = '0x' + H.to(pk);
            o.coinid = coin.coinid || '';
            return o;
        } catch (e) { return null; }
    }

    function stateVal(coin, port) { return AX.htlc.stateAt(coin, port); }

    /** Freshest-per-signer by ts — a newer tombstone (no liquidity) suppresses older live orders. */
    function mergeFreshest(book, o) {
        var prev = book[o.signerPk];
        if (!prev || o.ts > prev.ts) book[o.signerPk] = o;
    }

    // ---------- routing helpers (native SwapOrderBook.levelCap/pxKey/compareForFill + makerLive) ----------
    /** Balance-clamped take cap of a level, in mxUSDT. sell → usdtAvail/price; buy → minimaAvail. 0 if price ≤ 0. */
    function levelCap(o, l, sell) {
        if (!o || !l || l.p <= 0) return 0;
        return sell ? Math.min(l.a, o.usdtAvail / l.p) : Math.min(l.a, o.minimaAvail);
    }
    /** Quantized 8dp price key so equal quotes tie exactly (transitive comparator). */
    function pxKey(price) { return Math.round(price * 1e8); }
    /** Fill order: best price first (sell → highest bid, buy → lowest ask), then DEEPEST maker first at equal price. */
    function compareForFill(oa, la, ob, lb, sell) {
        var ka = la ? pxKey(la.p) : 0, kb = lb ? pxKey(lb.p) : 0;
        var byPrice = sell ? cmp(kb, ka) : cmp(ka, kb);
        if (byPrice !== 0) return byPrice;
        return cmp(levelCap(ob, lb, sell), levelCap(oa, la, sell));   // larger cap first
    }
    function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    /** Take-time guard: is a maker still live on the side a taker needs? sell → its bids; buy → its asks. */
    function makerLive(cur, sell) {
        if (!cur) return false;
        return (sell ? O.effectiveBids(cur, SYM) : O.effectiveAsks(cur, SYM)).length > 0;
    }

    // ---------- quote (native bestMakers): best non-own bid/ask across the book, deepest-first at equal price ----
    function bestMakers(book, myPublicId) {
        var r = { bidMaker: null, askMaker: null, bidLevel: null, askLevel: null,
                  bestBid: 0, bestAsk: 0, bidCap: 0, askCap: 0 };
        for (var pk in book) {
            var o = book[pk];
            if (isMine(o, myPublicId)) continue;
            var b = O.effectiveBids(o, SYM), a = O.effectiveAsks(o, SYM), i;
            for (i = 0; i < b.length; i++) {
                var bc = levelCap(o, b[i], true);
                if (bc > 0 && (r.bidMaker == null || compareForFill(o, b[i], r.bidMaker, r.bidLevel, true) < 0)) {
                    r.bestBid = b[i].p; r.bidMaker = o; r.bidLevel = b[i]; r.bidCap = bc;
                }
            }
            for (i = 0; i < a.length; i++) {
                var ac = levelCap(o, a[i], false);
                if (ac > 0 && (r.askMaker == null || compareForFill(o, a[i], r.askMaker, r.askLevel, false) < 0)) {
                    r.bestAsk = a[i].p; r.askMaker = o; r.askLevel = a[i]; r.askCap = ac;
                }
            }
        }
        return r;
    }

    /** aggSide (native): all (maker, level) rows for one side, sorted best-price-first then deepest-first. */
    function aggSide(book, sell, myPublicId) {
        var agg = [];
        for (var pk in book) {
            var o = book[pk];
            if (isMine(o, myPublicId)) continue;
            var lv = sell ? O.effectiveBids(o, SYM) : O.effectiveAsks(o, SYM);
            for (var i = 0; i < lv.length; i++) agg.push({ maker: o, level: lv[i] });
        }
        agg.sort(function (x, y) { return compareForFill(x.maker, x.level, y.maker, y.level, sell); });
        return agg;
    }

    function isMine(o, myPublicId) {
        return !!(myPublicId && o.signerPk && o.signerPk.toLowerCase() === signerFromId(myPublicId));
    }
    /** the signer of a publicId is its signPk (second 32 bytes) — matches how verifyCoin sets signerPk. */
    function signerFromId(publicId) { return ('0x' + H.to(ID.signPkOf(publicId))).toLowerCase(); }

    function nowMs() { return (new Date()).getTime(); }

    AX.book = {
        SCAN_DEPTH: SCAN_DEPTH, sentinel: sentinel,
        publish: publish, publishFresh: publishFresh, scan: scan, verifyCoin: verifyCoin, mergeFreshest: mergeFreshest,
        levelCap: levelCap, pxKey: pxKey, compareForFill: compareForFill, makerLive: makerLive,
        bestMakers: bestMakers, aggSide: aggSide, isMine: isMine, signerFromId: signerFromId
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
