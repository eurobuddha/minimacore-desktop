/**
 * market — the network-wide trade-history collector, a faithful port of native MarketCollector.java.
 * On-chain only shows OPEN HTLC locks and the price-bearing coin is spent on completion, so there is no
 * backfill — each poll we scan the shared HTLC address (active token, bounded depth), persist every observed
 * lock (price = reqUSDT / mxUSDT size), then reconcile locks that have since been SPENT: EXECUTED if a notify
 * coin revealed the secret, REFUNDED only once past the timelock (the KISS script forces a notify on every
 * claim — so "spent, no notify, before timelock" means the claim's notify just isn't visible yet: stay OPEN).
 *
 * Direction (taker buy vs sell) is NOT recoverable from the Minima coin — the counter-leg lives on Ethereum —
 * so this is a price feed, not green/red prints. Runs in service.js ONLY (single writer; the page reads SQL).
 * Requires AX.swapdb, AX.htlc, AX.flow. Attaches to AX.market.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var DB = AX.swapdb, H = AX.htlc, F = AX.flow;

    var HTLC_DEPTH = 256, NOTIFY_DEPTH = 256;   // bounded — the HTLC address is a shared, potentially heavy sink

    /** price = requested counter-asset / locked size; 0 (skip) unless both are positive plain decimals. */
    function price(reqAmount, sizeMinima) {
        var req = Number(reqAmount), size = Number(sizeMinima);
        if (!isFinite(req) || !isFinite(size) || req <= 0 || size <= 0) return 0;
        return req / size;
    }

    /** One collection cycle. Idempotent; safe every poll. cb(). */
    function poll(tipBlock, cb) {
        cb = F.once(cb || function () {});
        H.scanAllHtlcCoins(0, HTLC_DEPTH, function (err, coins) {
            if (err) return cb();
            ingest(coins || [], tipBlock, cb);
        });
    }

    function ingest(coins, tipBlock, cb) {
        var seen = {};
        F.each(coins, function (c, i, next) {
            if (!c || !c.coinid) return next();
            var size = H.coinAmount(c);
            var reqAmount = H.stateAt(c, 1);
            var p = price(reqAmount, size);
            if (p <= 0) return next();                       // not a priced lock — skip
            seen[c.coinid] = 1;
            DB.upsertOpenTrade({
                coinid: c.coinid, hash: H.stateAt(c, 5), price: p, sizeMinima: size,
                reqAmount: reqAmount, reqToken: H.stateAt(c, 2), owner: H.stateAt(c, 0),
                receiver: H.stateAt(c, 4), createdBlock: Number(c.created) || tipBlock,
                timelock: Number(H.stateAt(c, 3)) || 0
            }, function () { next(); });
        }, function () {
            // Any lock we had OPEN that's no longer in the scan has been spent → classify it.
            DB.openTrades(function (e, open) {
                F.each(open || [], function (t, i, next) {
                    if (seen[t.coinid]) return next();
                    reconcileSpent(t, tipBlock, next);
                }, cb);
            });
        });
    }

    /** Spent: EXECUTED if the hashlock has a notify coin; REFUNDED only past the timelock; else stay OPEN
     *  and retry (never mislabel a fill as a cancel during the confirmation window). */
    function reconcileSpent(t, tipBlock, next) {
        H.scanNotifySecret(t.hash, NOTIFY_DEPTH, function (err, notifyCoins) {
            if (err) return next();                          // node busy; retry next cycle
            var secret = null;
            for (var i = 0; i < (notifyCoins || []).length; i++) {
                var c = notifyCoins[i];
                if (c && H.normKey(H.stateAt(c, 101) || '') === H.normKey(t.hash) && H.stateAt(c, 100)) {
                    secret = H.stateAt(c, 100); break;
                }
            }
            if (secret) return DB.markTradeExecuted(t.coinid, secret, function () { next(); });
            if (t.timelock > 0 && tipBlock > t.timelock) return DB.markTradeRefunded(t.coinid, function () { next(); });
            next();                                          // claimed but notify not yet visible — leave OPEN
        });
    }

    AX.market = { poll: poll, price: price, HTLC_DEPTH: HTLC_DEPTH };
})(typeof globalThis !== 'undefined' ? globalThis : this);
