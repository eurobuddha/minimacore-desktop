/* Android MakerLadder port: pure ladder math and reconcile decisions. ES5 only. */
var PandaMaker = PandaMaker || {};
(function (M, P) {
  M.MAX_LEVELS = 6;
  M.K_CREATE = "CREATE";
  M.K_RELOCK = "RELOCK";
  M.K_CANCEL = "CANCEL";

  M.level = function (price, size) { return {price:P.d(price), sizeMinima:P.d(size)}; };
  M.sizeAt = function (rungs, i) {
    var level;
    if (!rungs || i >= rungs.length) return P.d(0);
    level = rungs[i];
    if (!level || level.sizeMinima === undefined || level.sizeMinima === null) return P.d(0);
    level = P.d(level.sizeMinima);
    return level.gt(0) ? level : P.d(0);
  };
  M.hasSizedRung = function (rungs) {
    var i;
    for (i = 0; i < M.MAX_LEVELS; i++) if (M.sizeAt(rungs, i).gt(0)) return true;
    return false;
  };
  M.applyCount = function (side, n, seedSize) {
    var want = Math.max(0, Math.min(Number(n || 0), M.MAX_LEVELS)), inherit = P.d(0), seed = P.d(seedSize || 0), out = [], i, existing;
    for (i = 0; i < M.MAX_LEVELS; i++) if (M.sizeAt(side, i).gt(0)) inherit = M.sizeAt(side, i);
    if (!inherit.gt(0) && seed.gt(0)) inherit = seed;
    for (i = 0; i < M.MAX_LEVELS; i++) {
      if (i >= want) { out.push(P.d(0)); continue; }
      existing = M.sizeAt(side, i);
      out.push(existing.gt(0) ? existing : inherit);
    }
    return out;
  };
  M.sanitize = function (levels, asks) {
    var out = [], i, l, p, s;
    levels = levels || [];
    for (i = 0; i < levels.length; i++) {
      l = levels[i];
      if (!l) continue;
      p = P.d(l.price || 0); s = P.d(l.sizeMinima || 0);
      if (p.gt(0) && s.gt(0)) out.push({price:p, sizeMinima:s});
    }
    out.sort(function (a, b) { return asks ? a.price.cmp(b.price) : b.price.cmp(a.price); });
    return out.slice(0, M.MAX_LEVELS);
  };
  M.crossed = function (asks, bids) {
    var a = M.sanitize(asks, true), b = M.sanitize(bids, false);
    return !!(a.length && b.length && b[0].price.gte(a[0].price));
  };
  M.desired = function (mid, cfg, widenFactor) {
    var out = [], hundred = P.d(100), asks, bids, i, widen, skewed, off, bidSz, askSz, price;
    if (!cfg) return out;
    if (!cfg.pegged) {
      asks = M.sanitize(cfg.asks, true); bids = M.sanitize(cfg.bids, false);
      for (i = 0; i < asks.length; i++) out.push({id:"A" + (i + 1), sell:true, price:asks[i].price, sizeMinima:asks[i].sizeMinima});
      for (i = 0; i < bids.length; i++) out.push({id:"B" + (i + 1), sell:false, price:bids[i].price, sizeMinima:bids[i].sizeMinima});
      return out;
    }
    mid = P.d(mid || 0);
    if (!mid.gt(0) || !P.d(cfg.stepPct || 0).gt(0)) return out;
    if (!M.hasSizedRung(cfg.asks) && !M.hasSizedRung(cfg.bids)) return out;
    widen = P.d(widenFactor || 1); if (!widen.gt(0)) widen = P.d(1);
    skewed = mid.mul(P.d(1).add(P.d(cfg.skewPct || 0).div(hundred)));
    for (i = 0; i < M.MAX_LEVELS; i++) {
      off = P.d(cfg.stepPct).mul(i + 1).mul(widen).div(hundred);
      bidSz = M.sizeAt(cfg.bids, i); askSz = M.sizeAt(cfg.asks, i);
      if (bidSz.gt(0)) {
        price = skewed.mul(P.d(1).sub(off)).toDecimalPlaces(6, Decimal.ROUND_DOWN);
        if (price.gt(0)) out.push({id:"B" + (i + 1), sell:false, price:price, sizeMinima:bidSz});
      }
      if (askSz.gt(0)) {
        price = skewed.mul(P.d(1).add(off)).toDecimalPlaces(6, Decimal.ROUND_CEIL);
        out.push({id:"A" + (i + 1), sell:true, price:price, sizeMinima:askSz});
      }
    }
    return out;
  };
  M.commitments = function (desired) {
    var ask = P.d(0), bid = P.d(0), i, s;
    desired = desired || [];
    for (i = 0; i < desired.length; i++) {
      s = desired[i]; if (!s) continue;
      if (s.sell) ask = ask.add(s.sizeMinima);
      else bid = bid.add(P.up(P.d(s.sizeMinima).mul(s.price), P.DP));
    }
    return {askMinima:ask, bidUsdt:bid};
  };
  M.action = function (kind, slot, order, reason) { return {kind:kind, slot:slot || null, order:order || null, reason:reason || ""}; };
  M.budget = function (maxActions, maxCreatesPerSide) { return {maxActions:Number(maxActions || 0), maxCreatesPerSide:maxCreatesPerSide === undefined ? 2147483647 : Number(maxCreatesPerSide)}; };
  M.livePrice = function (order) { return P.d(order.price); };
  M.worthRepricing = function (lastMid, newMid, pct) {
    lastMid = P.d(lastMid || 0); newMid = P.d(newMid || 0); pct = P.d(pct || 0);
    if (!lastMid.gt(0)) return true;
    if (!newMid.gt(0)) return false;
    return newMid.sub(lastMid).abs().div(lastMid).mul(100).gte(pct);
  };
  M.reconcile = function (desired, liveBySlot, settlingSlots, renewSlots, repricePct, partiallyFilled, postedSizes, budget) {
    var relocks = [], creates = [], cancels = [], resizes = [], want = {}, actions = [], k, i, s, live, posted, used, movePct, move, reason, bidCreates = 0, askCreates = 0, max, exact, b;
    desired = desired || []; liveBySlot = liveBySlot || {}; settlingSlots = settlingSlots || {}; renewSlots = renewSlots || {}; partiallyFilled = partiallyFilled || {}; postedSizes = postedSizes || {};
    b = budget || M.budget(0, 2147483647);
    for (i = 0; i < desired.length; i++) want[desired[i].id] = desired[i];
    for (k in liveBySlot) if (liveBySlot.hasOwnProperty(k)) {
      if (settlingSlots[k]) continue;
      if (!want[k] && liveBySlot[k]) cancels.push(M.action(M.K_CANCEL, null, liveBySlot[k], "level removed"));
    }
    for (i = 0; i < desired.length; i++) {
      s = desired[i];
      if (settlingSlots[s.id]) continue;
      live = liveBySlot[s.id];
      if (!live) {
        used = s.sell ? askCreates : bidCreates;
        if (used < b.maxCreatesPerSide) {
          creates.push(M.action(M.K_CREATE, s, null, "level missing"));
          if (s.sell) askCreates++; else bidCreates++;
        }
        continue;
      }
      if (partiallyFilled[live.coinid]) continue;
      posted = postedSizes[s.id];
      if (posted !== undefined && posted !== null && P.d(posted).cmp(s.sizeMinima) !== 0) {
        used = s.sell ? askCreates : bidCreates;
        if (used < b.maxCreatesPerSide) {
          resizes.push(M.action(M.K_CANCEL, null, live, "size changed"));
          resizes.push(M.action(M.K_CREATE, s, null, "size changed"));
          if (s.sell) askCreates++; else bidCreates++;
        }
        continue;
      }
      if (!M.livePrice(live).gt(0)) continue;
      if (repricePct === null || repricePct === undefined || !P.d(repricePct).gt(0)) {
        exact = s.price.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).cmp(M.livePrice(live).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)) !== 0;
        move = exact; reason = "price edited";
      } else {
        movePct = s.price.sub(M.livePrice(live)).abs().div(M.livePrice(live)).mul(100);
        move = movePct.gte(repricePct); reason = "moved " + movePct.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed() + "%";
      }
      if (!move && renewSlots[s.id]) { move = true; reason = "renewing"; }
      if (move) relocks.push(M.action(M.K_RELOCK, s, live, reason));
    }
    actions = relocks.concat(creates).concat(cancels).concat(resizes);
    max = Number(b.maxActions || 0);
    return max > 0 && actions.length > max ? actions.slice(0, max) : actions;
  };
  /* ---- MakerPosition (native MakerPosition) ----------------------------------------------
     "Has this rung been partly eaten?" compared the order's MINIMA against the size we asked for.
     That holds for a SELL, where the MINIMA is what the order locks. For a BUY the MINIMA is the
     WANT side, and repricing changes it with no fill at all — so every repriced bid read as
     part-filled and the engine then refused to touch it again, forever.

     The funded LOCKED amount is the honest baseline: it is fixed at creation and the covenant only
     ever reduces it, and only by a fill. This is a balance comparison, not proof of a particular
     fill transaction — which is why an unknown baseline preserves rather than adjusts. */
  M.baseline = function (record, order) {
    var locked;
    if (!record || !order) return null;
    if (record.locked !== null && record.locked !== undefined && record.locked !== "") {
      locked = P.d(record.locked);
      return locked.gt(0) && P.eqTok(order.lockedTok, record.lockedToken) ? locked : null;
    }
    /* A legacy record kept only the requested MINIMA size. For a sell that IS the funded amount;
       a legacy buy cannot recover its original funding once the price has moved. */
    return order.sell && record.size !== undefined && record.size !== null && P.d(record.size).gt(0)
      ? P.down(P.d(record.size), P.DP) : null;
  };
  M.preserve = function (record, order) {
    var initial = M.baseline(record, order);
    return initial === null || P.d(order.locked).cmp(initial) !== 0;
  };

  /* ---- MakerQuoteGuard (native MakerQuoteGuard) -------------------------------------------
     A cycle decides its whole ladder up front and then posts each action through several async
     node round-trips — a random id, a funding scan, txncheck, txnpost. By the time the fourth
     action is signed the user may have disarmed, edited a rung, or the peg may have moved past
     the reprice threshold. Checking `armed` once at the top of the cycle authorises every later
     action with a fact that was only true at the start.

     The guard captures the intent the cycle was authorised on, and revalidates it before each
     action. It makes NO node call and fetches NO replacement quote — the caller passes in what
     it already knows. A CANCEL is always allowed: withdrawing funds does not depend on the price
     feed or on the ladder settings still being the ones that put them there. */
  function num(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    return b !== null && b !== undefined && P.d(a).cmp(P.d(b)) === 0;
  }
  function levelsSame(a, b) {
    var i, x, y;
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    for (i = 0; i < a.length; i++) {
      x = a[i]; y = b[i];
      if (!x || !y) { if (x !== y) return false; }
      else if (!num(x.price, y.price) || !num(x.sizeMinima, y.sizeMinima)) return false;
    }
    return true;
  }
  M.same = function (a, b) {
    return !!a && !!b && !a.pegged === !b.pegged && num(a.stepPct, b.stepPct) && num(a.skewPct, b.skewPct)
      && num(a.repricePct, b.repricePct) && levelsSame(a.asks, b.asks) && levelsSame(a.bids, b.bids);
  };
  /* A missing or negative threshold means "cannot tell" — treat it as moved and refuse. */
  function moved(before, after, threshold) {
    if (threshold === null || threshold === undefined || P.d(threshold).lt(0)) return true;
    return P.d(before).cmp(P.d(after)) !== 0 && M.worthRepricing(before, after, threshold);
  }
  M.guard = function (ladder, revision, mid, widen) {
    var planned = M.desired(mid, ladder, widen);
    return { allows: function (state, action) {
      var current, now, i, a, b;
      if (!action) return false;                      /* an action we cannot classify is not authorised */
      if (action.kind === M.K_CANCEL) return true;
      if (!state || !state.storageHealthy || !state.armed) return false;
      if (String(revision) !== String(state.revision)) return false;
      if (!M.same(ladder, state.ladder)) return false;
      if (!ladder.pegged) return true;
      if (!state.quoteOk) return false;
      current = P.d(state.mid || 0);
      if (!current.gt(0) || !P.d(mid || 0).gt(0)) return false;
      if (moved(mid, current, ladder.repricePct)) return false;
      /* An ageing reference can require a wider spread even when its midpoint has not moved,
         so recheck the widening with the same ladder math and the same threshold. */
      now = M.desired(current, ladder, state.widen);
      if (planned.length !== now.length) return false;
      for (i = 0; i < planned.length; i++) {
        a = planned[i]; b = now[i];
        if (a.id !== b.id || moved(a.price, b.price, ladder.repricePct)) return false;
      }
      return true;
    } };
  };
  M.minRemainderFor = function (slot) {
    var fivePct = P.d(slot.sizeMinima).mul("0.05"), floor = Decimal.max(fivePct, P.d(P.MIN_ORDER)), half = P.d(slot.sizeMinima).div(2).toDecimalPlaces(P.DP, Decimal.ROUND_DOWN);
    return P.down(Decimal.min(floor, half), P.DP);
  };
})(PandaMaker, PandaDEX);
