/* Android CompositeRouter port: blends V5 order coins and PandaPools reserves. */
var PandaComposite = {};
(function(C, P, B, PoolRouter) {
  C.SLICES = 128;
  C.MAX_CAPACITY_UNITS = 12;
  C.emptyPlan = function() {
    return {orderTakes:[], poolRoute:null, totalMinima:P.d(0), totalUsdt:P.d(0), effectivePrice:P.d(0),
      orderMinima:P.d(0), orderUsdt:P.d(0), poolMinima:P.d(0), poolUsdt:P.d(0), unfilledMinima:P.d(0),
      worstMarginalPrice:P.d(0), sourceCoinIds:[]};
  };
  C.isEmpty = function(plan) { return !plan || (!plan.orderTakes.length && (!plan.poolRoute || !plan.poolRoute.ok)); };
  C.poolCount = function(plan) { return plan && plan.poolRoute ? plan.poolRoute.poolsUsed : 0; };
  C.capacityUnits = function(plan) { return 2 * C.poolCount(plan) + ((plan && plan.orderTakes && plan.orderTakes.length) || 0); };
  C.plan = function(book, pools, takerBuys, wantMinima, limitPrice, chainBlock) {
    return C.planInternal(book || [], C.filterPair(pools), !!takerBuys, P.d(wantMinima), limitPrice ? P.d(limitPrice) : null, Number(chainBlock || 0));
  };
  C.planInternal = function(book, pools, takerBuys, wantMinima, limitPrice, chainBlock) {
    var plan = C.routeOnce(book, pools, takerBuys, wantMinima, limitPrice, chainBlock), drop, reduced, i;
    while (C.capacityUnits(plan) > C.MAX_CAPACITY_UNITS && plan.poolRoute && plan.poolRoute.poolsUsed > 0) {
      drop = C.smallestPool(plan.poolRoute, takerBuys); if (!drop) break;
      reduced = [];
      for (i = 0; i < pools.length; i++) if (pools[i] !== drop && pools[i].address !== drop.address) reduced.push(pools[i]);
      if (reduced.length === pools.length) break;
      pools = reduced; plan = C.routeOnce(book, pools, takerBuys, wantMinima, limitPrice, chainBlock);
    }
    return plan;
  };
  C.routeOnce = function(book, pools, takerBuys, wantMinima, limitPrice, chainBlock) {
    var plan = C.emptyPlan(), orders, chunk, remaining, poolTarget = P.d(0), currentRoute = null, oi = 0,
      takenFromOrder = P.d(0), step, oc, orderPrice, pc, poolPrice, cmp, usePool, cur;
    if (!wantMinima.gt(0)) return plan;
    orders = C.orders(book, takerBuys, limitPrice, chainBlock);
    chunk = wantMinima.div(C.SLICES).toDecimalPlaces(P.DP, Decimal.ROUND_CEIL);
    remaining = wantMinima;
    while (remaining.gt(0)) {
      step = Decimal.min(remaining, chunk);
      oc = C.orderChoice(orders, oi, takenFromOrder, step, remaining);
      orderPrice = oc ? oc.usdt.div(oc.minima) : null;
      pc = C.poolChoice(pools, takerBuys, poolTarget, step);
      poolPrice = pc ? pc.marginalUsdt.div(pc.marginalMinima) : null;
      if (poolPrice && limitPrice) {
        cmp = poolPrice.cmp(limitPrice);
        if (takerBuys ? cmp > 0 : cmp < 0) pc = null;
      }
      usePool = C.better(takerBuys, orderPrice, poolPrice);
      if (usePool && pc) {
        poolTarget = poolTarget.add(pc.marginalMinima); currentRoute = pc.route;
        plan.worstMarginalPrice = C.worst(plan.worstMarginalPrice, poolPrice, takerBuys);
        remaining = remaining.sub(pc.marginalMinima);
        continue;
      }
      if (!oc) break;
      takenFromOrder = takenFromOrder.add(oc.minima); cur = orders[oi];
      if (takenFromOrder.gte(cur.minima)) { C.addOrder(plan, cur, cur.minima, false); oi++; takenFromOrder = P.d(0); }
      plan.worstMarginalPrice = C.worst(plan.worstMarginalPrice, orderPrice, takerBuys);
      remaining = remaining.sub(oc.minima);
    }
    if (takenFromOrder.gt(0) && oi < orders.length) C.addOrder(plan, orders[oi], takenFromOrder, true);
    if (currentRoute && currentRoute.ok) {
      plan.poolRoute = currentRoute;
      plan.poolMinima = takerBuys ? currentRoute.totalOut : currentRoute.totalIn;
      plan.poolUsdt = takerBuys ? currentRoute.totalIn : currentRoute.totalOut;
      for (var i = 0; i < currentRoute.allocs.length; i++) {
        C.addSource(plan, currentRoute.allocs[i].pool.coinidM);
        C.addSource(plan, currentRoute.allocs[i].pool.coinidT);
      }
    }
    plan.totalMinima = plan.orderMinima.add(plan.poolMinima);
    plan.totalUsdt = plan.orderUsdt.add(plan.poolUsdt);
    plan.unfilledMinima = wantMinima.sub(plan.totalMinima); if (plan.unfilledMinima.lt(0)) plan.unfilledMinima = P.d(0);
    if (plan.totalMinima.gt(0)) plan.effectivePrice = plan.totalUsdt.div(plan.totalMinima).toDecimalPlaces(P.PRICE_DP, Decimal.ROUND_HALF_UP);
    return plan;
  };
  C.better = function(takerBuys, orderPrice, poolPrice) { if (!poolPrice) return false; if (!orderPrice) return true; return takerBuys ? poolPrice.lt(orderPrice) : poolPrice.gt(orderPrice); };
  C.worst = function(cur, px, takerBuys) { if (!px) return cur; if (!cur || P.d(cur).eq(0)) return px; return takerBuys ? Decimal.max(cur, px) : Decimal.min(cur, px); };
  C.orderChoice = function(orders, idx, already, step, requestRemaining) {
    var o, avail, remAvail, take, left, lockedLeft, maxPartialLocked, maxPartialMinima, c;
    if (idx >= orders.length) return null;
    o = orders[idx]; avail = P.d(o.minima); remAvail = avail.sub(already);
    if (!remAvail.gt(0)) return null;
    take = requestRemaining && requestRemaining.gte(remAvail) ? remAvail : Decimal.min(remAvail, step); left = remAvail.sub(take);
    if (left.gt(0)) {
      lockedLeft = o.sell ? left : P.up(left.mul(o.price), P.DP);
      if (lockedLeft.lt(o.minRem)) {
        maxPartialLocked = P.d(o.locked).sub(o.minRem);
        maxPartialMinima = o.sell ? maxPartialLocked : P.down(maxPartialLocked.div(o.price), P.DP);
        take = maxPartialMinima.sub(already);
        if (!take.gt(0)) return null;
      }
    }
    c = {}; c.minima = take; c.usdt = P.up(take.mul(o.price), P.DP); return c;
  };
  C.addOrder = function(plan, o, take, partial) {
    var lockedTake = !partial ? P.d(o.locked) : (o.sell ? P.d(take) : P.up(P.d(take).mul(o.price), P.DP)),
      pay = partial ? P.up(P.d(o.wantAmt).mul(lockedTake).div(o.locked), P.DP) : P.d(o.wantAmt),
      t = {order:o, minima:P.d(take), partial:!!partial, lockedTake:lockedTake, pay:pay, remainder:P.d(o.locked).sub(lockedTake)};
    plan.orderTakes.push(t); plan.orderMinima = plan.orderMinima.add(take); plan.orderUsdt = plan.orderUsdt.add(o.sell ? pay : lockedTake); C.addSource(plan, o.coinid);
  };
  C.poolChoice = function(pools, takerBuys, currentMinima, step) {
    var before = currentMinima.gt(0) ? (takerBuys ? PoolRouter.routeExactMinimaOut(pools, currentMinima) : PoolRouter.route(pools, true, currentMinima)) : null,
      after = takerBuys ? PoolRouter.routeExactMinimaOut(pools, currentMinima.add(step)) : PoolRouter.route(pools, true, currentMinima.add(step)),
      c = {};
    if (!after || !after.ok) return null;
    c.route = after;
    if (takerBuys) {
      c.marginalMinima = after.totalOut.sub(before && before.ok ? before.totalOut : 0);
      c.marginalUsdt = after.totalIn.sub(before && before.ok ? before.totalIn : 0);
    } else {
      c.marginalMinima = after.totalIn.sub(before && before.ok ? before.totalIn : 0);
      c.marginalUsdt = after.totalOut.sub(before && before.ok ? before.totalOut : 0);
    }
    if (!c.marginalMinima.gt(0) || !c.marginalUsdt.gt(0)) return null;
    return c;
  };
  C.orders = function(book, takerBuys, limitPrice, chainBlock) {
    var side = [], i, o, cmp;
    for (i = 0; i < (book || []).length; i++) {
      o = book[i]; if (o.fillable === false || o.sell !== takerBuys) continue;
      if (chainBlock - Number(o.created || 0) > P.EXPIRY - 30) continue;
      if (limitPrice) { cmp = P.d(o.price).cmp(limitPrice); if (takerBuys ? cmp > 0 : cmp < 0) continue; }
      side.push(o);
    }
    side.sort(function(a,b){ return takerBuys ? P.d(a.price).cmp(b.price) : P.d(b.price).cmp(a.price); });
    if (side.length > P.MAX_ORDERS) return side.slice(0, P.MAX_ORDERS);
    return side;
  };
  C.filterPair = function(pools) {
    var out = [], i, p; pools = pools || [];
    for (i = 0; i < pools.length; i++) { p = PandaPool.clean(pools[i]); if (PandaPool.funded(p) && P.eqTok(p.tok, P.USDT)) out.push(p); }
    return out;
  };
  /* Which pool contributes the least MINIMA — and that is a different leg depending on the side:
     buying MINIMA it is the route OUT, selling it is the route IN. Measuring outAmount either way
     ranked pools by their MxUSD leg on the sell side and dropped the wrong one, giving a worse
     fill than necessary whenever a plan had to be shrunk to fit the capacity budget. */
  C.poolMinimaOf = function(alloc, takerBuys) { return P.d(takerBuys ? alloc.quote.outAmount : alloc.quote.inAmount); };
  C.smallestPool = function(route, takerBuys) {
    var best = null, i, a;
    for (i = 0; i < (route.allocs || []).length; i++) {
      a = route.allocs[i];
      if (!best || C.poolMinimaOf(a, takerBuys).lt(C.poolMinimaOf(best, takerBuys))) best = a;
    }
    return best ? best.pool : null;
  };
  C.addSource = function(plan, coinid) { if (coinid && plan.sourceCoinIds.indexOf(coinid) < 0) plan.sourceCoinIds.push(coinid); };
  C.out = function(plan) {
    var out = C.emptyPlan(), i, t, a, allocs = [];
    if (!plan) return out;
    for (i = 0; i < plan.orderTakes.length; i++) { t = plan.orderTakes[i]; out.orderTakes.push({order:t.order, minima:P.plain(t.minima), partial:t.partial, lockedTake:P.plain(t.lockedTake), pay:P.plain(t.pay), remainder:P.plain(t.remainder)}); }
    if (plan.poolRoute) {
      for (i = 0; i < plan.poolRoute.allocs.length; i++) { a = plan.poolRoute.allocs[i]; allocs.push({pool:a.pool, quote:{inAmount:P.plain(a.quote.inAmount), outAmount:P.plain(a.quote.outAmount), newX:P.plain(a.quote.newX), newY:P.plain(a.quote.newY), ok:!!a.quote.ok}}); }
      out.poolRoute = {allocs:allocs, pairAddresses:plan.poolRoute.pairAddresses || [], totalIn:P.plain(plan.poolRoute.totalIn), totalOut:P.plain(plan.poolRoute.totalOut), poolsUsed:plan.poolRoute.poolsUsed, ok:!!plan.poolRoute.ok};
    }
    out.totalMinima=P.plain(plan.totalMinima); out.totalUsdt=P.plain(plan.totalUsdt); out.effectivePrice=P.plain(plan.effectivePrice);
    out.orderMinima=P.plain(plan.orderMinima); out.orderUsdt=P.plain(plan.orderUsdt); out.poolMinima=P.plain(plan.poolMinima); out.poolUsdt=P.plain(plan.poolUsdt);
    out.unfilledMinima=P.plain(plan.unfilledMinima); out.worstMarginalPrice=P.plain(plan.worstMarginalPrice); out.sourceCoinIds=plan.sourceCoinIds.slice();
    return out;
  };
})(PandaComposite, PandaDEX, PandaBook, PandaPoolRouter);
