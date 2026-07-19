/**
 * swapplan — the taker's amount math + market-sweep planner, a faithful port of native MainActivity's
 * computeUsdt/computeMinima/ceilUsdt/legMinima + buildSweepPlan. Pure (no MDS/RPC) so it is unit-testable in
 * isolation — the exact grain rounding here is fund-relevant (a sub-grain or over-budget leg is rejected on-chain
 * or over-pays). Requires AX.dec (exact decimal), AX.order (levels/MAX_LEVELS), AX.orderbook (aggSide/levelCap).
 * Attaches to AX.swapplan.
 *
 * Rounding contract (matches native + the maker's own guard):
 *   SELL: lock `minima` (grain6) mxUSDT, request floor6(minima × bid) USDT   (I receive → round DOWN).
 *   BUY:  lock  ceil6(minima × ask) USDT, request exactly `minima` mxUSDT     (I pay → round UP).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var D = AX.dec, O = AX.order, B = AX.book;   // the order-book module attaches to AX.book
    var SYM = 'USDT', EPS = 1e-9;

    function pstr(price) { return String(price); }   // double→string; BigDecimal 6dp floor/ceil absorbs float tails
    function num(s) { var n = Number(s); return isFinite(n) ? n : 0; }

    /** USDT I receive selling `minima` mxUSDT at `price` = floor6(minima × price); null on bad input. */
    function computeUsdt(minima, price) {
        if (minima == null || !(price > 0)) return null;
        if (!(num(minima) > 0)) return null;
        try { var v = D.mulFloor(minima, pstr(price), 6); return num(v) > 0 ? v : null; } catch (e) { return null; }
    }
    /** mxUSDT I receive spending `usdt` USDT at `price` = floor6(usdt ÷ price); null on bad input. */
    function computeMinima(usdt, price) {
        if (usdt == null || !(price > 0)) return null;
        if (!(num(usdt) > 0)) return null;
        try { var v = D.divFloor(usdt, pstr(price), 6); return num(v) > 0 ? v : null; } catch (e) { return null; }
    }
    /** USDT I must lock to BUY `minima` mxUSDT at `price` = ceil6(minima × price) — round UP so lockedUsdt ≥
     *  minima×price holds to the last tick against the maker's BigDecimal guard. null if it collapses to zero. */
    function ceilUsdt(minima, price) {
        if (minima == null || !(price > 0)) return null;
        try { var v = D.mulCeil(minima, pstr(price), 6); return num(v) > 0 ? v : null; } catch (e) { return null; }
    }
    /** Quantize a mxUSDT quantity (double) DOWN to the 6dp trade grain — never over a level's cap. */
    function legMinima(v) { try { return D.floorDp(String(v), 6); } catch (e) { return '0'; } }

    /**
     * Walk the book best-price-first, splitting into ≤ MAX_LEVELS per-level legs. BOTH sides are mxUSDT-TARGET
     * driven (targetStr = mxUSDT to sell / to buy). BUY additionally caps at bestAsk × (1+slippage) (legs above
     * are partial). Each leg is clamped to the maker's display cap AND a per-maker running balance so two tranches
     * of one maker can't over-allocate; a sub-min leg is never emitted; my own orders are excluded.
     * Returns { sell, legs:[{maker,price,minima,usdt,minimaD,usdtD}], target, filledMinima, totalUsdt, avgPrice,
     *           worstPrice, slippagePct, partial, stopReason }.
     */
    function buildSweepPlan(book, sell, targetStr, slippage, myPublicId) {
        slippage = slippage || 0;
        var plan = { sell: sell, legs: [], target: 0, filledMinima: 0, totalUsdt: 0, avgPrice: 0,
                     worstPrice: 0, slippagePct: slippage * 100, partial: false, stopReason: 'filled' };
        var target = num(targetStr);
        plan.target = target;
        if (target <= 0) { plan.stopReason = 'book-exhausted'; return plan; }
        var dust = Math.max(EPS, target * 1e-4);

        var remUsdt = {}, remMinima = {};                 // per-maker remaining balances, keyed by signerPk
        var remaining = target, bestPrice = 0;

        var rows = B.aggSide(book, sell, myPublicId);
        for (var r = 0; r < rows.length; r++) {
            if (plan.legs.length >= O.MAX_LEVELS) { plan.stopReason = 'leg-cap'; plan.partial = true; break; }
            if (remaining <= dust) break;
            var maker = rows[r].maker, lvl = rows[r].level, price = lvl.p, key = maker.signerPk;
            if (!(price > 0)) continue;

            if (!sell && bestPrice > 0 && slippage > 0 && price > bestPrice * (1 + slippage) + EPS) {
                plan.stopReason = 'slippage'; plan.partial = true; break;   // BUY slippage cap
            }

            var pr = maker.pairs[SYM], mn = pr ? (pr.min || 0) : 0;
            var capMinima;
            if (sell) {   // maker BUYS my mxUSDT with USDT → cap by their remaining USDT / price
                var ru = (key in remUsdt) ? remUsdt[key] : maker.usdtAvail;
                capMinima = Math.min(lvl.a, price > 0 ? ru / price : 0);
            } else {      // maker SELLS mxUSDT → cap by their remaining mxUSDT
                var rm = (key in remMinima) ? remMinima[key] : maker.minimaAvail;
                capMinima = Math.min(lvl.a, rm);
            }
            if (capMinima <= EPS) continue;

            var takeMinima = Math.min(capMinima, remaining);
            if (takeMinima <= EPS) continue;
            if (mn > 0 && takeMinima < mn - EPS) {                 // never emit a sub-min leg (maker auto-declines)
                if (remaining < mn - EPS) { plan.stopReason = 'below-min'; plan.partial = true; break; }
                continue;                                          // this level can't honor its own min → try deeper
            }

            var minimaStr = legMinima(takeMinima), m = num(minimaStr);
            if (m <= EPS) continue;
            var usdtStr = sell ? computeUsdt(minimaStr, price) : ceilUsdt(minimaStr, price);
            if (usdtStr == null) continue;
            var minimaD = num(minimaStr), usdtD = num(usdtStr);
            if (minimaD <= EPS || usdtD <= EPS) continue;
            if (mn > 0 && minimaD < mn - EPS) continue;            // rounding slipped it below min — skip

            if (bestPrice <= 0) bestPrice = price;                 // anchor slippage on the FIRST leg taken
            plan.legs.push({ maker: maker, price: price, minima: minimaStr, usdt: usdtStr, minimaD: minimaD, usdtD: usdtD });
            plan.filledMinima += minimaD;
            plan.totalUsdt += usdtD;
            plan.worstPrice = price;                               // best-first → last added is the worst price
            if (sell) remUsdt[key] = ((key in remUsdt) ? remUsdt[key] : maker.usdtAvail) - usdtD;
            else remMinima[key] = ((key in remMinima) ? remMinima[key] : maker.minimaAvail) - minimaD;
            remaining -= minimaD;
        }

        if (remaining > dust) plan.partial = true;
        if (plan.partial && plan.stopReason === 'filled') plan.stopReason = 'book-exhausted';
        plan.avgPrice = plan.filledMinima > 0 ? plan.totalUsdt / plan.filledMinima : 0;
        return plan;
    }

    /** Total mxUSDT takeable across the book (≤6 legs) on the given side — the "up to ~X" depth hint. */
    function sweepDepthMinima(book, sell, myPublicId, slippage) {
        return buildSweepPlan(book, sell, '1000000000', sell ? 0 : (slippage || 0), myPublicId).filledMinima;
    }

    AX.swapplan = {
        computeUsdt: computeUsdt, computeMinima: computeMinima, ceilUsdt: ceilUsdt, legMinima: legMinima,
        buildSweepPlan: buildSweepPlan, sweepDepthMinima: sweepDepthMinima
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
