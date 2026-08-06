/**
 * maker — the maker controller: build the published order from the saved config (a pegged auto-MM ladder or a
 * manual ladder), publish it (sign + post via the order book), keep it alive (republish on reprice / the keep-alive
 * interval), and tombstone it (an all-disabled no-liquidity order) on a currency switch or a dead feed. It is the
 * single source of the LIVE order the responder answers takes against (currentOrder(), armSafe'd while withdrawn).
 *
 * Config lives in kv (async), loaded into plain objects — keys are PER-CURRENCY (suffix `_<currency.key>`), the
 * native 0.1.5 market-memory: switching currency parks one market's config and restores the other's, no bleed:
 *   maker_cfg_<ccy>   = { pegEnable, step, size, bias, reprice, levels, min, manualEnable }
 *   maker_manual_<ccy>= { bids:[{p,a}], asks:[{p,a}] }   (used when pegEnable=false)
 *   peg_state_<ccy>   = { lastMid, withdrawn, wide, lastOk, lastPrice }   (runtime; commitPeg advances it)
 * The service RE-LOADS these + the active currency every poll (loadConfig is cheap) so a UI edit / withdraw /
 * currency switch is honored within one poll — without this the service's stale in-memory copy silently
 * republishes a withdrawn or outdated market on the next keep-alive.
 *
 * configure({ mds, identity, myMinimaPk, ethAddr, onOrder?(order), notify? }). Requires AX.order, AX.orderbook,
 * AX.peg, AX.trading, AX.mds, AX.flow. Attaches to AX.maker.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var O = AX.order, B = AX.book, PEG = AX.peg, TR = AX.trading, M = AX.mds, F = AX.flow;
    var SYM = O.SYM;
    var KEEPALIVE_MS = 30 * 60 * 1000;   // republish at least this often (coin age-out safety)

    var C = null, ORDER = null, lastPublishMs = 0;

    function configure(ctx) { C = ctx; if (!cfgCache) cfgCache = {}; if (!manualCache) manualCache = { bids: [], asks: [] }; if (!stateCache) stateCache = {}; }
    function num(v, d) { var n = (v == null || v === '') ? d : Number(v); return isFinite(n) ? n : d; }
    function onOrder(o) { ORDER = o; if (C && C.onOrder) C.onOrder(o); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    /** The live order the responder answers takes against, armSafe'd (withdrawn → empty, declines all). Uses the
     *  merged pegCfg so armSafe sees BOTH enable (user config) and withdrawn (runtime state). */
    function currentOrder() { return PEG.armSafe(ORDER, pegCfg()); }

    var cfgCache = null, manualCache = null, stateCache = null;

    // ---- config load/save (kv, PER-CURRENCY keys — market memory, no cross-currency bleed) ----
    function kvKey(base) { return base + '_' + TR.active().key; }
    /** One-time adopt of a pre-0.1.3 install's UN-suffixed keys into the ACTIVE currency's keys (the legacy config
     *  belonged to whatever currency was persisted active) — else an upgrade silently loses the maker's ladder. */
    function migrateLegacy(cb) {
        M.kvGet(kvKey('maker_cfg'), '', function (cur) {
            if (cur) return cb();                                   // already per-currency
            M.kvGet('maker_cfg', '', function (legacy) {
                if (!legacy) return cb();                           // fresh install — nothing to adopt
                F.waterfall([
                    function (n) { M.kvSet(kvKey('maker_cfg'), legacy, function () { n(); }); },
                    function (n) { M.kvGet('maker_manual', '', function (v) { if (!v) return n(); M.kvSet(kvKey('maker_manual'), v, function () { n(); }); }); },
                    function (n) { M.kvGet('peg_state', '', function (v) { if (!v) return n(); M.kvSet(kvKey('peg_state'), v, function () { n(); }); }); },
                    function (n) { M.kvDel('maker_cfg', function () { M.kvDel('maker_manual', function () { M.kvDel('peg_state', function () { n(); }); }); }); }
                ], function () { cb(); });
            });
        });
    }
    function loadConfig(cb) {
        migrateLegacy(function () { doLoadConfig(cb); });
    }
    function doLoadConfig(cb) {
        F.waterfall([
            function (n) { M.kvGet(kvKey('maker_cfg'), '', function (v) { try { cfgCache = v ? JSON.parse(v) : {}; } catch (e) { cfgCache = {}; } n(); }); },
            function (n) { M.kvGet(kvKey('maker_manual'), '', function (v) { try { manualCache = v ? JSON.parse(v) : { bids: [], asks: [] }; } catch (e) { manualCache = { bids: [], asks: [] }; } n(); }); },
            function (n) { M.kvGet(kvKey('peg_state'), '', function (v) { try { stateCache = v ? JSON.parse(v) : {}; } catch (e) { stateCache = {}; } n(); }); }
        ], function () { PEG.init({ lastOk: stateCache.lastOk, lastPrice: stateCache.lastPrice }); cb && cb(); });
    }
    function saveConfig(cfg, manual, cb) {
        cfgCache = cfg || cfgCache || {}; if (manual) manualCache = manual;
        F.waterfall([
            function (n) { M.kvSet(kvKey('maker_cfg'), JSON.stringify(cfgCache), function () { n(); }); },
            function (n) { M.kvSet(kvKey('maker_manual'), JSON.stringify(manualCache), function () { n(); }); }
        ], function () { cb && cb(); });
    }
    /** peg runtime state = the commitPeg fields; persisted so a restart keeps the reprice baseline + withdrawn flag. */
    function saveState(cb) { M.kvSet(kvKey('peg_state'), JSON.stringify(stateCache || {}), function () { cb && cb(); }); }
    function pegCfg() {   // the object peg.applyPeg/shouldReprice read (config + runtime state merged)
        var c = cfgCache || {}, s = stateCache || {};
        return { enable: !!c.pegEnable, step: num(c.step, 0), size: num(c.size, 0),
            askSize: num(c.askSize, num(c.size, 0)), bidSize: num(c.bidSize, num(c.size, 0)),   // independent per-side sizes (0 = don't publish that side)
            bias: num(c.bias, 0), reprice: num(c.reprice, 1), levels: num(c.levels, 1), min: num(c.min, 0),
            lastMid: s.lastMid, withdrawn: !!s.withdrawn, wide: !!s.wide };
    }

    // ---- build the order (identity + balances + ladder) ----
    function buildOrder(avail) {
        var o = O.make();
        o.mpk = C.myMinimaPk; o.eth = C.ethAddr; o.cid = C.identity.publicId();
        o.minimaAvail = num(avail && avail.minima, 0); o.usdtAvail = num(avail && avail.usdt, 0);
        var c = cfgCache || {};
        var p = O.pair(true, 0, 0, num(c.min, 0));
        o.pairs[SYM] = p;
        if (!c.pegEnable) {   // manual ladder
            var man = manualCache || { bids: [], asks: [] };
            p.bids = (man.bids || []).map(function (l) { return O.level(l.p, l.a); });
            p.asks = (man.asks || []).map(function (l) { return O.level(l.p, l.a); });
            O.sanitizePair(p);
        }
        return o;
    }

    // ---- publish / tombstone / keep-alive ----
    /** Publish the live order. avail = { minima, usdt }. cb(err). Pegged + no usable price → auto-tombstone. */
    function publish(avail, cb) {
        cb = cb || function () {};
        var o = buildOrder(avail);
        var c = cfgCache || {};
        if (c.pegEnable) {
            var r = PEG.applyPeg(o, pegCfg());
            if (r.result === PEG.PEG_STALE) return tombstone(avail, cb);   // no usable price → withdraw, don't publish stale
            if (r.result === PEG.PEG_OFF) { /* unconfigured peg → manual ladder already on o (empty) */ }
            var mid = r.mid, wide = !!r.wide;
            return doPublish(o, function (err) {
                if (err) return cb(err);
                // commitPeg: advance the reprice baseline + clear withdrawn/wide ONLY after the publish confirmed.
                stateCache.lastMid = mid; stateCache.withdrawn = false; stateCache.wide = wide;
                stateCache.lastOk = Date.now(); stateCache.lastPrice = mid;
                saveState(function () { cb(null); });
            });
        }
        // manual: publish as-is (or tombstone if empty)
        if (!o.pairs[SYM].bids.length && !o.pairs[SYM].asks.length) return tombstone(avail, cb);
        doPublish(o, cb);
    }
    /** BACKING CLAMP (native SwapEngine.checkLadderCoins): before publishing a MULTI-tranche ask ladder,
     *  advertise only the largest PREFIX of ask tranches whose CUMULATIVE size the total free balance covers —
     *  the responder locks by COMBINING coins, so backing is the sum, not per-coin. Coin-read failure fails
     *  SAFE (trim to the best tranche only), never open. Single/no ladder → publish as-is. cb(order). */
    function clampAsks(o, cb) {
        var p = o.pairs[SYM];
        if (!p || !p.en || p.asks.length < 2) return cb(o);
        AX.htlc.myFreeCoins(TR.active().tokenId, function (err, coins) {
            if (err) { O.trimAsks(p, 1); return cb(o); }               // fail SAFE, not open
            var total = 0;
            for (var i = 0; i < (coins || []).length; i++) total += Number(AX.htlc.coinAmount(coins[i])) || 0;
            var cum = 0, backable = 0;
            for (var j = 0; j < p.asks.length; j++) { cum += p.asks[j].a; if (cum <= total + 1e-9) backable++; else break; }
            O.trimAsks(p, backable);
            cb(o);
        });
    }
    function doPublish(o, cb) {
        clampAsks(o, function (clamped) {
            B.publishFresh(C.identity, clamped, function (err) {
                if (err) return cb(err);
                lastPublishMs = Date.now(); onOrder(clamped); cb(null);
            });
        });
    }

    /** Withdraw: publish an all-disabled no-liquidity order (all effective levels empty → makerLive false). cb(err). */
    function tombstone(avail, cb) {
        cb = cb || function () {};
        var o = buildOrder(avail);
        var p = o.pairs[SYM]; p.en = false; p.bids = []; p.asks = []; p.buy = 0; p.sell = 0;
        B.publishFresh(C.identity, o, function (err) {
            if (err) return cb(err);
            lastPublishMs = Date.now(); onOrder(null);   // no live order → responder declines all
            stateCache.withdrawn = true;
            saveState(function () { notify('Market withdrawn', 'Your ' + TR.active().coinLabel + ' order is no longer live'); cb(null); });
        });
    }

    /** Background keep-alive: republish when the peg says reprice, or once the keep-alive interval elapses. cb(err). */
    function keepAlive(avail, cb) {
        // HALTED (identitywatch): never publish an order under a key the node does not own.
        if (AX.identitywatch && AX.identitywatch.halted()) return cb && cb();
        cb = cb || function () {};
        var c = cfgCache || {};
        if (!c.pegEnable && !(manualCache && ((manualCache.bids || []).length || (manualCache.asks || []).length))) return cb(null);  // nothing configured
        var due = (Date.now() - lastPublishMs) >= KEEPALIVE_MS;
        if (c.pegEnable && PEG.shouldReprice(pegCfg(), lastPublishMs)) return publish(avail, cb);
        if (due) return publish(avail, cb);
        cb(null);
    }

    /** Refresh the oracle price (drives shouldReprice), persisting the last-good stamp. cb(). */
    function refreshPeg(cb) {
        PEG.fetch(function (e, saved) {
            if (!e && saved) { stateCache.lastOk = saved.lastOk; stateCache.lastPrice = saved.lastPrice; saveState(function () { cb && cb(); }); }
            else cb && cb();
        });
    }

    /** Currency switch (UI, BEFORE the flip): tombstone the OLD market + wipe the OLD currency's peg state so the
     *  new currency can't price off the old. Call while TR is still the OLD currency (saveState keys off it). */
    function onCurrencySwitch(avail, cb) {
        tombstone(avail, function () { PEG.resetForSwitch(); ORDER = null; stateCache = {}; saveState(cb || function () {}); });
    }

    /** Currency reload (service, AFTER the flip was detected in kv): drop the old in-memory order/peg WITHOUT
     *  tombstoning (the UI that switched already did) — then loadConfig picks up the new currency's market. */
    function resetForReload() { PEG.resetForSwitch(); ORDER = null; lastPublishMs = 0; cfgCache = {}; manualCache = { bids: [], asks: [] }; stateCache = {}; }

    AX.maker = {
        configure: configure, loadConfig: loadConfig, saveConfig: saveConfig, pegCfg: pegCfg,
        buildOrder: buildOrder, publish: publish, tombstone: tombstone, keepAlive: keepAlive,
        refreshPeg: refreshPeg, onCurrencySwitch: onCurrencySwitch, resetForReload: resetForReload, currentOrder: currentOrder,
        clampAsks: clampAsks,
        _state: function () { return { cfg: cfgCache, manual: manualCache, state: stateCache, lastPublishMs: lastPublishMs }; },
        _setLastPublish: function (t) { lastPublishMs = t; }, KEEPALIVE_MS: KEEPALIVE_MS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
