/**
 * peg — the price oracle + auto-MM ladder generator, a faithful port of native PriceOracle.java. mxUSDT trades at
 * PARITY to ERC20 USDT (mid always 1.0, no external feed); MINIMA pegs to the live MEXC MINIMA/USDT order book
 * (effective bid/ask at DEPTH_MIN_USDT notional, spread-checked, two-read jump confirmation). applyPeg regenerates
 * the order's ladder around the mid per the saved config; the stay-live-with-widening machinery keeps a market up
 * (defensively wider) while the feed is stale rather than pulling it, and withdraws only when there is NO usable
 * price or the feed is down past a hard ceiling.
 *
 * Platform port note: native reads SharedPreferences synchronously inside applyPeg; MDS kv is async, so the maker
 * controller loads the peg CONFIG once into a plain object and passes it here — applyPeg/shouldReprice/armSafe are
 * pure functions of (order, cfg, module price-state). The price-state (last-good mid + clock) lives in memory and
 * is restored across restarts via init(saved)/{lastOk,lastPrice} the controller persists to kv. fetch() is the only
 * async part (MDS.net.GET). Requires AX.order, AX.trading, AX.mds. Attaches to AX.peg.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var O = AX.order, TR = AX.trading, M = AX.mds;
    var SYM = O.SYM;

    var PARITY_MID = 1.0;
    var DEPTH_URL = 'https://api.mexc.com/api/v3/depth?symbol=MINIMAUSDT&limit=20';
    var BOOK_URL = 'https://api.mexc.com/api/v3/ticker/bookTicker?symbol=MINIMAUSDT';
    var FRESH_MS = 5 * 60000, FETCH_GAP_MS = 30000, MIN_REPRICE_GAP_MS = 3 * 60000;
    var JUMP_FRACTION = 0.5, DEPTH_MIN_USDT = 25;
    var STALE_WIDEN_FULL_MS = 90 * 60000, MAX_WIDEN = 10.0, HARD_STALE_MS = 12 * 60 * 60000;

    var PEG_OFF = 0, PEG_APPLIED = 1, PEG_STALE = 2, PEG_WIDE = 3;

    // ---- runtime price state (in memory; survives restart via init(saved)) ----
    var price = 0, bid = 0, ask = 0, goodAtMs = 0, lastTryMs = 0, firstTryMs = 0, suspect = 0, appliedMid = 0, lastError = null;
    var _now = function () { return Date.now(); };
    function ageMs() { return goodAtMs > 0 ? (_now() - goodAtMs) : (365 * 24 * 60 * 60000); }
    function num(v, def) { var d = (v == null || v === '') ? def : Number(v); return (isFinite(d)) ? d : def; }

    /** Restore the last-good clock+price so a restart keeps the market live around the last mid. saved={lastOk,lastPrice}. */
    function init(saved) {
        if (!saved) return;
        var t = Number(saved.lastOk) || 0, now = _now();
        if (goodAtMs === 0 && t > 0 && t <= now) goodAtMs = t;
        if (price <= 0) { var lp = Number(saved.lastPrice) || 0; if (lp > 0 && isFinite(lp)) price = lp; }
    }
    /** Currency switch: wipe the cached price + freshness so a MINIMA peg can't price off mxUSDT's parity 1.0. */
    function resetForSwitch() { price = 0; bid = 0; ask = 0; goodAtMs = 0; suspect = 0; firstTryMs = 0; lastTryMs = 0; appliedMid = 0; lastError = null; }

    function fresh() { return price > 0 && ageMs() <= FRESH_MS; }
    function source() { return TR.active().pricingParity ? 'Parity' : 'MEXC'; }
    function state() { return { price: price, bid: bid, ask: ask, ageMs: ageMs(), fresh: fresh(), error: lastError }; }

    /** Spread multiplier by feed staleness: 1× fresh → MAX_WIDEN once down ≥ STALE_WIDEN_FULL_MS. */
    function wideningFactor(age) {
        if (age <= FRESH_MS) return 1.0;
        var t = (age - FRESH_MS) / (STALE_WIDEN_FULL_MS - FRESH_MS);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        return 1.0 + (MAX_WIDEN - 1.0) * t;
    }

    /**
     * Regenerate the order's ladder around the current oracle mid per cfg. Returns { result, mid, wide }:
     * PEG_OFF (untouched), PEG_APPLIED (fresh/tight), PEG_WIDE (stale but priced with a widened defensive spread),
     * PEG_STALE (NO usable price / feed past the hard ceiling → caller MUST NOT publish). cfg = {enable, step, size,
     * bias, levels}. Mutates order.pairs[SYM] (bids/asks, buy=sell=0).
     */
    function applyPeg(order, cfg) {
        if (!cfg || !cfg.enable) return { result: PEG_OFF };
        var p = order.pairs[SYM];
        if (!p || !p.en) return { result: PEG_OFF };
        var step = num(cfg.step, 0), size = num(cfg.size, 0);
        var askSize = num(cfg.askSize, size), bidSize = num(cfg.bidSize, size);   // independent per-side sizes (fallback to legacy `size`); a side with size 0 is not published → single-sided market
        var bias = Math.max(-20, Math.min(20, num(cfg.bias, 0)));
        if (!(step > 0) || !(askSize > 0 || bidSize > 0)) return { result: PEG_OFF };   // need a step + at least ONE side sized
        var m = price, age = ageMs();
        if (!(m > 0)) return { result: PEG_STALE };                   // never fetched / none persisted → don't publish
        if (age > HARD_STALE_MS) return { result: PEG_STALE };        // down past the hard ceiling → let withdraw stand
        var stale = age > FRESH_MS;
        var effStep = step * wideningFactor(age);
        var quoted = m * (1 + bias / 100.0);
        var levels = Math.floor(num(cfg.levels, 1));
        if (levels < 1) levels = 1; else if (levels > O.MAX_LEVELS) levels = O.MAX_LEVELS;
        p.bids = []; p.asks = [];
        for (var i = 1; i <= levels; i++) {
            if (askSize > 0) p.asks.push(O.level(quoted * (1 + i * effStep / 100.0), askSize));
            if (bidSize > 0) p.bids.push(O.level(quoted * (1 - i * effStep / 100.0), bidSize));
        }
        p.buy = 0; p.sell = 0;                                        // re-derived from the fresh levels
        O.sanitizePair(p);                                           // drops any bid a huge step pushed ≤ 0
        if (!p.asks.length && !p.bids.length) return { result: PEG_STALE };
        appliedMid = m;
        return { result: stale ? PEG_WIDE : PEG_APPLIED, mid: m, wide: stale };
    }

    /**
     * Should the maker republish NOW (vs waiting the keep-alive interval)? cfg adds {reprice, lastMid, withdrawn,
     * wide}. True when the fresh mid moved ≥ reprice% from the last pegged publish (with a spam floor), a withdrawn
     * order can be restored (feed recovered), or a WIDE order can now tighten.
     */
    function shouldReprice(cfg, lastPublishMs) {
        if (!cfg || !cfg.enable) return false;
        var m = price, age = ageMs();
        if (!(m > 0)) return false;
        var isFresh = age <= FRESH_MS;
        if (cfg.withdrawn) return isFresh;                            // no-price withdrawal restores once fresh
        if (isFresh && cfg.wide) return true;                        // was WIDE, now fresh → tighten NOW
        if (!isFresh) return false;                                  // stale: keep-alive handles it, no urgent reprice
        if (_now() - lastPublishMs < MIN_REPRICE_GAP_MS) return false;
        var last = num(cfg.lastMid, 0);
        if (!(last > 0)) return true;
        var thresh = Math.max(0.1, num(cfg.reprice, 1.0));
        return Math.abs(m - last) / last * 100.0 >= thresh;
    }

    /** While a pegged order is withdrawn (stale feed), arm the responder guard with an EMPTY order (decline all)
     *  rather than a saved ladder whose prices the market may have left behind. */
    function armSafe(order, cfg) { return (cfg && cfg.enable && cfg.withdrawn) ? O.make() : order; }

    // ---- fetch (async, MDS.net.GET) ----
    /** Refresh the oracle price for the ACTIVE currency. cb(err, saved{lastOk,lastPrice}|null). Paced by FETCH_GAP_MS. */
    function fetch(cb) {
        cb = cb || function () {};
        var now = _now();
        if (now - lastTryMs < FETCH_GAP_MS) return cb(null, null);
        lastTryMs = now; if (firstTryMs === 0) firstTryMs = now;
        if (TR.active().pricingParity) return fetchParity(cb);
        fetchMexc(cb);
    }
    function fetchParity(cb) {
        if (!TR.active().pricingParity) return cb(null, null);   // switched away mid-fetch → drop
        suspect = 0; price = PARITY_MID; bid = PARITY_MID; ask = PARITY_MID; goodAtMs = _now(); lastError = null;
        cb(null, { lastOk: goodAtMs, lastPrice: PARITY_MID });
    }
    function parseJson(res) { try { return JSON.parse(M.netText(res)); } catch (e) { return null; } }
    function effectiveLevel(side) {
        if (!side || !side.length) return 0;
        var cum = 0;
        for (var i = 0; i < side.length; i++) {
            var px = Number(side[i][0]), qty = Number(side[i][1]);
            if (!(px > 0) || !(qty > 0)) return 0;
            cum += px * qty;
            if (cum >= DEPTH_MIN_USDT) return px;
        }
        return 0;
    }
    function fetchMexc(cb) {
        M.netGet(DEPTH_URL, function (res) {
            var depth = parseJson(res), b = 0, a = 0;
            if (depth && depth.bids && depth.asks) { b = effectiveLevel(depth.bids); a = effectiveLevel(depth.asks); }
            if (b > 0 && a > 0) return commitMexc(b, a, cb);
            // FALLBACK: top-of-book only.
            M.netGet(BOOK_URL, function (res2) {
                var book = parseJson(res2);
                var bb = book ? Number(book.bidPrice) : 0, aa = book ? Number(book.askPrice) : 0;
                commitMexc(bb, aa, cb);
            });
        });
    }
    function commitMexc(b, a, cb) {
        if (!(b > 0) || !(a > 0) || b > a) { lastError = 'thin/empty book'; return cb(new Error(lastError), null); }
        if ((a - b) / a >= 0.2) { lastError = 'spread too wide'; return cb(new Error(lastError), null); }
        var m = (a + b) / 2;
        if (!(m > 0) || !isFinite(m)) { lastError = 'bad price'; return cb(new Error('bad price'), null); }
        if (TR.active().pricingParity) return cb(null, null);   // switched to a parity currency mid-fetch → drop
        if (price > 0 && Math.abs(m - price) / price > JUMP_FRACTION) {   // suspect glitch → need a 2nd agreeing read
            if (!(suspect > 0 && Math.abs(m - suspect) / suspect < 0.10)) { suspect = m; lastError = 'suspect jump'; return cb(null, null); }
        }
        suspect = 0; price = m; bid = b; ask = a; goodAtMs = _now(); lastError = null;
        cb(null, { lastOk: goodAtMs, lastPrice: m });
    }

    AX.peg = {
        PEG_OFF: PEG_OFF, PEG_APPLIED: PEG_APPLIED, PEG_STALE: PEG_STALE, PEG_WIDE: PEG_WIDE,
        FRESH_MS: FRESH_MS, HARD_STALE_MS: HARD_STALE_MS, MAX_WIDEN: MAX_WIDEN,
        init: init, resetForSwitch: resetForSwitch, source: source, state: state, fresh: fresh, appliedMid: function () { return appliedMid; },
        applyPeg: applyPeg, shouldReprice: shouldReprice, armSafe: armSafe, wideningFactor: wideningFactor, fetch: fetch,
        _setNow: function (fn) { _now = fn; }, _setPrice: function (p, age) { price = p; goodAtMs = p > 0 ? (_now() - (age || 0)) : 0; },
        _reset: function () { resetForSwitch(); lastTryMs = 0; }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
