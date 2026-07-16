/*
 * router.js — PoolRouter: the JS port of PoolRouter.java. Splits one trade across every pool for a pair by
 * constant-product WATER-FILLING — each incremental slice goes to whichever pool currently offers the best
 * marginal price. For equally-priced pools this is a split proportional to reserves, so N equal pools
 * behave EXACTLY like one pool of the summed reserves (zero fragmentation cost). Each slice is quoted
 * through Curve so every leg is grain-correct and pool-favourable; the tx builder just sums them.
 *
 * ONE transaction spends + recreates every used pool at once (proven in phase-B 3-pool routing), capped at
 * MAX_POOLS legs for the TxPoW ceiling; deeper-liquidity pools are preferred when more exist.
 */
var Router = (function () {
    var D = Decimal;
    var MAX_POOLS = 6;       // max pools in one routed tx (each = 2 covenant inputs + 2 outputs)
    var STEPS = 128;         // water-filling granularity

    function quote(p, minimaToToken, amount) {
        return minimaToToken ? Curve.quoteMtoT(p, amount) : Curve.quoteTtoM(p, amount);
    }

    /**
     * Route `totalIn` across `pairPools` (all must share the same token). `minimaToToken` = pay MINIMA get
     * token, else pay token get MINIMA. Returns
     *   { ok, allocs:[{pool,quote}], totalIn, totalOut, effPrice, spotBefore,
     *     poolsUsed, poolsAvailable, capped, pairAddresses:[...] }
     */
    function route(pairPools, minimaToToken, totalInRaw) {
        var r = {
            allocs: [], pairAddresses: [],
            totalIn: new D(0), totalOut: new D(0), spotBefore: new D(0), effPrice: new D(0),
            poolsAvailable: 0, poolsUsed: 0, capped: false, ok: false
        };
        if (!pairPools || !totalInRaw) return r;
        var totalIn = PP.dec(totalInRaw);
        if (totalIn.lte(0)) return r;

        var pools = [];
        for (var i = 0; i < pairPools.length; i++) {
            var p = pairPools[i];
            if (Curve.funded(p)) {
                pools.push(p);
                if (p.address) r.pairAddresses.push(p.address);   // every pair pool, even if capped/not routed
            }
        }
        r.poolsAvailable = pools.length;
        if (pools.length === 0) return r;

        // prefer the deepest pools when more than MAX_POOLS exist
        if (pools.length > MAX_POOLS) {
            pools = pools.slice().sort(function (a, b) { return PP.dec(b.reserveM).cmp(PP.dec(a.reserveM)); });
            pools = pools.slice(0, MAX_POOLS);
            r.capped = true;
        }
        r.spotBefore = Curve.aggregatePrice(pools);

        var n = pools.length;
        var alloc = [], curOut = [];
        for (var a = 0; a < n; a++) { alloc[a] = new D(0); curOut[a] = new D(0); }

        var chunk = totalIn.div(STEPS);
        if (chunk.lte(0)) return r;

        var placed = new D(0);
        for (var s = 0; s < STEPS; s++) {
            var best = -1, bestGain = new D(0);
            for (var j = 0; j < n; j++) {
                var trial = alloc[j].plus(chunk);
                var qt = quote(pools[j], minimaToToken, trial);
                if (!qt.ok) continue;
                var gain = qt.outAmount.minus(curOut[j]);         // marginal proceeds from this slice
                if (gain.cmp(bestGain) > 0) { best = j; bestGain = gain; }
            }
            if (best < 0) break;                                  // no pool can absorb another slice
            alloc[best] = alloc[best].plus(chunk);
            placed = placed.plus(chunk);
            var qb = quote(pools[best], minimaToToken, alloc[best]);
            curOut[best] = qb.ok ? qb.outAmount : curOut[best];
        }
        // assign the rounding residual to the deepest-allocated pool so sum(alloc) == totalIn
        var residual = totalIn.minus(placed);
        if (residual.gt(0)) {
            var deepest = -1, max = new D(-1);
            for (var d = 0; d < n; d++) if (alloc[d].cmp(max) > 0) { max = alloc[d]; deepest = d; }
            if (deepest >= 0) alloc[deepest] = alloc[deepest].plus(residual);
        }

        // final per-pool quotes → the allocations the transaction will use
        for (var f = 0; f < n; f++) {
            if (alloc[f].lte(0)) continue;
            var qf = quote(pools[f], minimaToToken, alloc[f]);
            if (!qf.ok) continue;
            r.allocs.push({ pool: pools[f], quote: qf });
            r.totalIn = r.totalIn.plus(qf.inAmount);
            r.totalOut = r.totalOut.plus(qf.outAmount);
        }
        r.poolsUsed = r.allocs.length;
        if (r.poolsUsed === 0 || r.totalOut.lte(0)) return r;
        r.effPrice = minimaToToken ? r.totalOut.div(r.totalIn) : r.totalIn.div(r.totalOut);
        r.ok = true;
        return r;
    }

    /** Total MINIMA-side depth of the pools that would be routed (for the aggregate-depth display). */
    function aggregateDepth(pairPools) {
        var pools = [];
        for (var i = 0; i < pairPools.length; i++) if (Curve.funded(pairPools[i])) pools.push(pairPools[i]);
        if (pools.length > MAX_POOLS) {
            pools = pools.slice().sort(function (a, b) { return PP.dec(b.reserveM).cmp(PP.dec(a.reserveM)); });
            pools = pools.slice(0, MAX_POOLS);
        }
        return Curve.totalMinima(pools);
    }

    /** Group funded pools by token id (each group is one routable pair), deepest pair first. */
    function byToken(pools) {
        var order = [], groups = [];
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            if (!Curve.funded(p)) continue;
            var idx = order.indexOf(p.tok);
            if (idx < 0) { order.push(p.tok); groups.push([p]); }
            else groups[idx].push(p);
        }
        groups.sort(function (a, b) { return Curve.totalMinima(b).cmp(Curve.totalMinima(a)); });
        return groups;
    }

    return { MAX_POOLS: MAX_POOLS, STEPS: STEPS, route: route, aggregateDepth: aggregateDepth, byToken: byToken };
})();
