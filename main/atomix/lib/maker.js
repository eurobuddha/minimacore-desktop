/**
 * maker — the maker controller: build the published order from the saved config (a pegged auto-MM ladder or a
 * manual ladder), publish it (sign + post via the order book), keep it alive (republish on reprice / the keep-alive
 * interval), and tombstone it (an all-disabled no-liquidity order) on a currency switch or a dead feed. It is the
 * single source of the LIVE order the responder answers takes against (currentOrder(), armSafe'd while withdrawn).
 *
 * Config lives in kv (async), loaded into plain objects — keys are PER-CURRENCY (suffix `_<currency.key>`), the
 * native 0.1.5 market-memory: switching currency parks one market's config and restores the other's, no bleed:
 *   maker_cfg_<ccy>   = { pegEnable, step, size, bias, reprice, levels, min, manualEnable, spread, rand, randSeed }
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
    // A balance the host could not read: since when (0 = the last read was good), and whether the user was told.
    var balBadSince = 0, balBadNotified = false;
    var _now = function () { return Date.now(); };

    function configure(ctx) { C = ctx; if (!cfgCache) cfgCache = {}; if (!manualCache) manualCache = { bids: [], asks: [] }; if (!stateCache) stateCache = {}; }
    function num(v, d) { var n = (v == null || v === '') ? d : Number(v); return isFinite(n) ? n : d; }
    function onOrder(o) { ORDER = o; if (C && C.onOrder) C.onOrder(o); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    /** The live order the responder answers takes against, armSafe'd (withdrawn → empty, declines all). Uses the
     *  merged pegCfg so armSafe sees BOTH enable (user config) and withdrawn (runtime state). */
    function currentOrder() { return balanceBlind() ? O.make() : PEG.armSafe(ORDER, pegCfg()); }
    /** The keep-alive has not read a balance for longer than KEEPALIVE_MS: the live ladder was published against
     *  figures nobody can confirm any more, so the responder stops answering takes from it (empty order = decline
     *  all) until a read succeeds. */
    function balanceBlind() { return balBadSince > 0 && _now() - balBadSince > KEEPALIVE_MS; }
    /** A usable balance pair: both legs real numbers (a failed read is null / NaN / a string, never a 0). */
    function validAvail(a) { return !!a && typeof a.minima === 'number' && typeof a.usdt === 'number' && isFinite(a.minima) && isFinite(a.usdt); }

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
            bias: num(c.bias, 0), reprice: num(c.reprice, 1), levels: num(c.levels, 1), min: num(c.min, 0), spread: num(c.spread, 0), rand: num(c.rand, 0), randSeed: num(c.randSeed, 1),
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
        // every publish path routes here: a live order is never stamped with a balance that was not read
        if (!validAvail(avail)) return cb(new Error('your balances could not be read, so nothing was published — try again in a moment'));
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
        // manual: publish as-is (or tombstone if empty). A confirmed manual publish is LIVE again: clear the withdrawn
        // flag a tombstone set (15 Nov: only the pegged path cleared it, so a live manual market stayed "Offline ·
        // market withdrawn" on screen while takers could trade it)
        if (!o.pairs[SYM].bids.length && !o.pairs[SYM].asks.length) return tombstone(avail, cb);
        doPublish(o, function (err) {
            if (err) return cb(err);
            if (!stateCache.withdrawn) return cb(null);
            stateCache.withdrawn = false;
            saveState(function () { cb(null); });
        });
    }
    /** BACKING CLAMP (native SwapEngine.checkLadderCoins): before publishing a MULTI-tranche ask ladder,
     *  advertise only the largest PREFIX of ask tranches whose CUMULATIVE size the total free balance covers —
     *  the responder locks by COMBINING coins, so backing is the sum, not per-coin. Coin-read failure fails
     *  SAFE (trim to the best tranche only), never open. Single/no ladder → publish as-is. cb(order). */
    function clampAsks(o, cb) {
        var p = o.pairs[SYM];
        if (!p || !p.en || p.asks.length < 2) return cb(o);
        AX.htlc.tokenBalance(TR.active().tokenId, function (err, balance) {
            if (err) { O.trimAsks(p, 1); return cb(o); }               // fail SAFE, not open
            var total = Number(balance.sendable);
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
        // A balance the host could not read (null, or a leg that is not a number) is never published as 0: that drops
        // the market from every taker's book and spends a key use. The live order keeps its last good figures.
        if (!validAvail(avail)) return unreadBalance(cb);
        balBadSince = 0; balBadNotified = false;
        var c = cfgCache || {};
        if (!c.pegEnable && !(manualCache && ((manualCache.bids || []).length || (manualCache.asks || []).length))) return cb(null);  // nothing configured
        var due = (Date.now() - lastPublishMs) >= KEEPALIVE_MS;
        if (!(c.pegEnable && PEG.shouldReprice(pegCfg(), lastPublishMs)) && !due) return cb(null);
        // The currency can be switched by the OTHER context (the page) while this pass is already past
        // reloadShared: the UI tombstones the old ladder, and a keep-alive still running as the OLD currency
        // would republish it for one interval. Re-read the shared kv right before publishing; if it moved,
        // skip — the next pass reconfigures every engine and publishes under the new currency.
        M.kvGet('trading_currency', TR.active().key, function (k) {
            if (k !== TR.active().key) return cb(null);
            publish(avail, cb);
        });
    }

    /** keepAlive with no readable balance. The published market stands — EXCEPT that the dead-feed safety still runs:
     *  a pegged market whose price is gone (never fetched, or older than the hard ceiling: applyPeg's PEG_STALE) is
     *  tombstoned and marked withdrawn exactly as the normal path would, so an unreadable balance can never keep a
     *  ladder live on a price nobody has. Reads failing longer than KEEPALIVE_MS are told once (and currentOrder()
     *  stops answering takes until a read succeeds). cb(err). */
    function unreadBalance(cb) {
        if (!balBadSince) balBadSince = _now();
        if (balanceBlind() && !balBadNotified) {
            balBadNotified = true;
            notify('Balance unreadable', 'Your ' + TR.active().coinLabel + ' / USDT balance has not been readable for over '
                + Math.round(KEEPALIVE_MS / 60000) + ' min — new takes are declined until it reads again');
        }
        var c = cfgCache || {};
        if (!c.pegEnable || (stateCache && stateCache.withdrawn) || !PEG.noUsablePrice()) return cb(null);
        M.kvGet('trading_currency', TR.active().key, function (k) {
            if (k !== TR.active().key) return cb(null);
            tombstone(null, cb);   // a tombstone carries no liquidity: no balance needed
        });
    }

    /** The sellable amount in a `balance tokenid:` reply, or null when the node did not answer it (status not true,
     *  pending, no array, a sendable that is not a number). An empty array is a real zero: no coins of that token. */
    function sellableFrom(r) {
        if (!r || r.status !== true || r.pending === true || !Array.isArray(r.response)) return null;
        if (!r.response.length) return 0;
        var s = r.response[0] && r.response[0].sendable;
        if (typeof s !== 'string' && typeof s !== 'number') return null;
        var v = Number(s);
        return String(s).trim() !== '' && isFinite(v) && v >= 0 ? v : null;
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
        cb = cb || function () {};
        // A tombstone that FAILED must stop the switch: proceeding flips the currency while the old ladder is
        // still live and, from the next poll, mispriced — the exact hazard the tombstone exists to prevent.
        tombstone(avail, function (err) {
            if (err) return cb(err);
            PEG.resetForSwitch(); ORDER = null; stateCache = {}; saveState(cb);
        });
    }

    /** Currency reload (service, AFTER the flip was detected in kv): drop the old in-memory order/peg WITHOUT
     *  tombstoning (the UI that switched already did) — then loadConfig picks up the new currency's market. */
    function resetForReload() { PEG.resetForSwitch(); ORDER = null; lastPublishMs = 0; cfgCache = {}; manualCache = { bids: [], asks: [] }; stateCache = {}; }

    AX.maker = {
        configure: configure, loadConfig: loadConfig, saveConfig: saveConfig, pegCfg: pegCfg,
        buildOrder: buildOrder, publish: publish, tombstone: tombstone, keepAlive: keepAlive,
        refreshPeg: refreshPeg, onCurrencySwitch: onCurrencySwitch, resetForReload: resetForReload, currentOrder: currentOrder,
        clampAsks: clampAsks, sellableFrom: sellableFrom, validAvail: validAvail, balanceBlind: balanceBlind,
        _setNow: function (fn) { _now = fn; }, _resetBalanceWatch: function () { balBadSince = 0; balBadNotified = false; },
        _state: function () { return { cfg: cfgCache, manual: manualCache, state: stateCache, lastPublishMs: lastPublishMs }; },
        _setLastPublish: function (t) { lastPublishMs = t; }, KEEPALIVE_MS: KEEPALIVE_MS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
