/* PandaPools-compatible pool discovery, quote math, routing, and synthetic depth. */
var PandaPool = {};
var PandaCurve = {};
var PandaPoolRouter = {};
var PandaSynthetic = {};
(function(Pool, Curve, Router, Synthetic, P) {
  Pool.SENTINEL = "0x50414E4441504F4F4C53";
  Pool.SENTINEL_SCAN_DEPTH = 1500;
  Pool.FEE_KEEP = P.d("0.995");
  Pool.script = function(opk, oadr, tok, kmin) {
    return "IF SIGNEDBY(" + opk + ") THEN "
      + "IF VERIFYOUT(@INPUT " + oadr + " @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF "
      + "RETURN GETOUTADDR(@INPUT) EQ @ADDRESS AND GETOUTTOK(@INPUT) EQ @TOKENID AND GETOUTAMT(@INPUT) GTE @AMOUNT "
      + "ENDIF "
      + "IF @TOKENID EQ 0x00 THEN "
      + "ASSERT @INPUT % 2 EQ 0 LET s=@INPUT+1 "
      + "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ " + tok + " "
      + "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ " + tok + " "
      + "LET x=@AMOUNT LET y=GETINAMT(s) LET nx=GETOUTAMT(@INPUT) LET ny=GETOUTAMT(s) "
      + "ASSERT VERIFYOUT(@INPUT @ADDRESS nx 0x00 FALSE) "
      + "ELSE "
      + "ASSERT @TOKENID EQ " + tok + " AND @INPUT % 2 EQ 1 LET s=@INPUT-1 "
      + "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ 0x00 "
      + "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ 0x00 "
      + "LET y=@AMOUNT LET x=GETINAMT(s) LET ny=GETOUTAMT(@INPUT) LET nx=GETOUTAMT(s) "
      + "ASSERT VERIFYOUT(@INPUT @ADDRESS ny " + tok + " FALSE) "
      + "ENDIF "
      + "LET dx=nx-x LET dy=ny-y LET fx=MAX(dx 0)*5/1000 LET fy=MAX(dy 0)*5/1000 "
      + "RETURN (nx-fx)*(ny-fy) GTE MAX(x*y " + kmin + ")";
  };
  Pool.funded = function(pool) { return !!(pool && P.d(pool.reserveM).gt(0) && P.d(pool.reserveT).gt(0)); };
  Pool.spotPrice = function(pool) { return Pool.funded(pool) ? P.d(pool.reserveT).div(pool.reserveM) : P.d(0); };
  Pool.state = function(coin, port) { return P.state(coin, port); };
  /* Quote for a command parameter escaping ONLY `"` and `\` — and CRUCIALLY leaving `/` alone.
     A JSON-style quoter turns the pool covenant's `*5/1000` into `*5\/1000`, which makes the
     script unparseable (parseok=false) and any coin sent to that malformed address UNSPENDABLE
     FOREVER. Adopted verbatim from pandapools-mds/covenant.js, whose script text hashes to live
     pool addresses. */
  Pool.scriptArg = function(script) {
    var s = String(script || ""), out = '"', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); if (c === '"' || c === '\\') out += '\\'; out += c; }
    return out + '"';
  };
  Pool.clean = function(raw) {
    raw = raw || {};
    return {
      address:raw.address || raw.ADDRESS || "", mxaddress:raw.mxaddress || raw.MXADDRESS || "",
      opk:raw.opk || raw.OPK || "", oadr:raw.oadr || raw.OADR || "", tok:raw.tok || raw.TOK || P.USDT,
      kmin:String(raw.kmin || raw.KMIN || "0"), covenantScript:raw.covenantScript || raw.COVENANTSCRIPT || "",
      tokName:raw.tokName || raw.TOKNAME || "", tokDecimals:Number(raw.tokDecimals || raw.TOKDECIMALS || 8),
      reserveM:P.plain(raw.reserveM || raw.RESERVEM || 0), coinidM:raw.coinidM || raw.COINIDM || "",
      reserveT:P.plain(raw.reserveT || raw.RESERVET || 0), coinidT:raw.coinidT || raw.COINIDT || "",
      reserveBlock:Number(raw.reserveBlock || raw.RESERVEBLOCK || 0)
    };
  };
  Pool.tokenDecimals = function(token) {
    if (token && typeof token === "object" && token.decimals !== undefined) return Number(token.decimals || 8);
    return 8;
  };
  Pool.scan = function(cmd, done) {
    cmd("coins simplestate:true order:desc depth:" + Pool.SENTINEL_SCAN_DEPTH + " address:" + Pool.SENTINEL, function(result) {
      var coins = result && result.response, params = {}, list = [], i, c, tok, oadr, opk, kmin, key;
      if (!result || !result.status || !Array.isArray(coins)) return done((result && result.error) || "pool scan returned no coin list", []);
      for (i = 0; i < coins.length; i++) {
        c = coins[i]; tok = Pool.state(c, 2); oadr = Pool.state(c, 3); opk = Pool.state(c, 4); kmin = Pool.state(c, 5);
        if (!tok || !oadr || !opk || !kmin || !P.eqTok(tok, P.USDT)) continue;
        key = String(opk + "|" + tok + "|" + kmin).toLowerCase();
        if (!params[key]) params[key] = [opk, oadr, tok, kmin];
      }
      for (key in params) if (params.hasOwnProperty(key)) list.push(params[key]);
      if (!list.length) return done(null, []);
      Pool.derive(cmd, list, [], done, 0);
    });
  };
  Pool.derive = function(cmd, params, pools, done, idx) {
    var p, opk, oadr, tok, kmin, script;
    if (idx >= params.length) return Pool.fund(cmd, pools, done, 0);
    p = params[idx]; opk = p[0]; oadr = p[1]; tok = p[2]; kmin = p[3]; script = Pool.script(opk, oadr, tok, kmin);
    cmd("runscript script:" + Pool.scriptArg(script), function(result) {
      var resp = result && result.response, sc = resp && resp.script, pool;
      if (result && result.status && resp && (resp.parseok === true || resp.parseok === "true" || resp.parseok === 1) && sc && sc.address) {
        pool = Pool.clean({opk:opk, oadr:oadr, tok:tok, kmin:kmin, address:sc.address, mxaddress:sc.mxaddress || "", covenantScript:script});
        pools.push(pool);
      }
      Pool.derive(cmd, params, pools, done, idx + 1);
    });
  };
  Pool.fund = function(cmd, pools, done, idx) {
    var pool;
    if (idx >= pools.length) return Pool.done(pools, done);
    pool = pools[idx];
    cmd("coins depth:" + Pool.SENTINEL_SCAN_DEPTH + " address:" + pool.address, function(result) {
      var cs = result && result.response || [], i, c, tid, amt, mb = 0, tb = 0;
      if (Array.isArray(cs)) for (i = 0; i < cs.length; i++) {
        c = cs[i]; if (!c || c.spent) continue; tid = c.tokenid || "0x00";
        if (P.eqTok(tid, "0x00")) {
          amt = P.d(c.amount || 0);
          if (!P.d(pool.reserveM).gt(amt)) { pool.reserveM = P.plain(amt); pool.coinidM = c.coinid || ""; mb = Number(c.created || 0); }
        } else if (P.eqTok(tid, pool.tok)) {
          amt = P.d(c.tokenamount || c.amount || 0);
          if (!P.d(pool.reserveT).gt(amt)) { pool.reserveT = P.plain(amt); pool.coinidT = c.coinid || ""; tb = Number(c.created || 0); pool.tokDecimals = Pool.tokenDecimals(c.token); }
        }
      }
      pool.reserveBlock = Math.max(mb, tb);
      Pool.fund(cmd, pools, done, idx + 1);
    });
  };
  Pool.done = function(pools, done) {
    var out = [], seen = {}, i, p, key;
    for (i = 0; i < pools.length; i++) {
      p = Pool.clean(pools[i]);
      if (!Pool.funded(p)) continue;
      key = String(p.address || "").toLowerCase();
      if (key && seen[key]) continue;
      if (key) seen[key] = true;
      out.push(p);
    }
    done(null, out);
  };
  Curve.quoteMtoT = function(pool, dx) {
    var q = {ok:false}, dp, x, y, rhs, nx, fx, ny, dy;
    pool = Pool.clean(pool); dx = P.d(dx);
    if (!Pool.funded(pool) || !dx.gt(0)) return q;
    dp = Number(pool.tokDecimals || 8); x = P.d(pool.reserveM); y = P.d(pool.reserveT); rhs = x.mul(y); if (P.d(pool.kmin).gt(rhs)) rhs = P.d(pool.kmin);
    nx = x.add(dx); fx = dx.mul(5).div(1000); ny = rhs.div(nx.sub(fx)).toDecimalPlaces(dp, Decimal.ROUND_CEIL); dy = y.sub(ny);
    if (!dy.gt(0)) return q;
    q.inAmount = dx; q.outAmount = dy; q.newX = nx; q.newY = ny; q.spotBefore = Pool.spotPrice(pool); q.spotAfter = ny.div(nx); q.effPrice = dy.div(dx); q.ok = true; return q;
  };
  Curve.quoteTtoM = function(pool, dyinRaw) {
    var q = {ok:false}, dp, dyin, x, y, rhs, ny, fy, nx, dm;
    pool = Pool.clean(pool); dyinRaw = P.d(dyinRaw);
    if (!Pool.funded(pool) || !dyinRaw.gt(0)) return q;
    dp = Number(pool.tokDecimals || 8); dyin = P.down(dyinRaw, dp); if (!dyin.gt(0)) return q;
    x = P.d(pool.reserveM); y = P.d(pool.reserveT); rhs = x.mul(y); if (P.d(pool.kmin).gt(rhs)) rhs = P.d(pool.kmin);
    ny = y.add(dyin); fy = dyin.mul(5).div(1000); nx = rhs.div(ny.sub(fy)).toDecimalPlaces(11, Decimal.ROUND_CEIL); dm = x.sub(nx);
    if (!dm.gt(0)) return q;
    q.inAmount = dyin; q.outAmount = dm; q.newX = nx; q.newY = ny; q.spotBefore = Pool.spotPrice(pool); q.spotAfter = ny.div(nx); q.effPrice = dyin.div(dm); q.ok = true; return q;
  };
  Curve.quoteTForMOut = function(pool, minimaOut) {
    var q = {ok:false}, x, y, rhs, nxTarget, needAfterFee, dyin, forward;
    pool = Pool.clean(pool); minimaOut = P.d(minimaOut);
    if (!Pool.funded(pool) || !minimaOut.gt(0) || minimaOut.gte(pool.reserveM)) return q;
    x = P.d(pool.reserveM); y = P.d(pool.reserveT); rhs = x.mul(y); if (P.d(pool.kmin).gt(rhs)) rhs = P.d(pool.kmin);
    nxTarget = x.sub(minimaOut); needAfterFee = rhs.div(nxTarget).sub(y);
    if (!needAfterFee.gt(0)) return q;
    dyin = needAfterFee.div(Pool.FEE_KEEP).toDecimalPlaces(Number(pool.tokDecimals || 8), Decimal.ROUND_CEIL);
    forward = Curve.quoteTtoM(pool, dyin);
    if (!forward.ok || forward.outAmount.lt(minimaOut)) return q;
    return forward;
  };
  Curve.aggregatePrice = function(pools) {
    var x = P.d(0), y = P.d(0), i, pool;
    pools = pools || [];
    for (i = 0; i < pools.length; i++) { pool = Pool.clean(pools[i]); if (Pool.funded(pool)) { x = x.add(pool.reserveM); y = y.add(pool.reserveT); } }
    return x.gt(0) ? y.div(x) : P.d(0);
  };
  Curve.totalMinima = function(pools) {
    var s = P.d(0), i, pool; pools = pools || [];
    for (i = 0; i < pools.length; i++) { pool = Pool.clean(pools[i]); if (Pool.funded(pool)) s = s.add(pool.reserveM); }
    return s;
  };
  Router.MAX_POOLS = 6; Router.STEPS = 128;
  Router.funded = function(pairPools, route) {
    var pools = [], i, p; pairPools = pairPools || [];
    for (i = 0; i < pairPools.length; i++) { p = Pool.clean(pairPools[i]); if (Pool.funded(p)) { pools.push(p); if (p.address) route.pairAddresses.push(p.address); } }
    return pools;
  };
  Router.route = function(pairPools, minimaToToken, totalIn) { return Router.routeInternal(pairPools, minimaToToken, false, totalIn); };
  Router.routeExactMinimaOut = function(pairPools, minimaOut) { return Router.routeInternal(pairPools, false, true, minimaOut); };
  Router.routeInternal = function(pairPools, minimaToToken, exactMinimaOut, total) {
    var r = {allocs:[], pairAddresses:[], totalIn:P.d(0), totalOut:P.d(0), spotBefore:P.d(0), effPrice:P.d(0), poolsAvailable:0, poolsUsed:0, capped:false, ok:false},
      pools, n, alloc = [], curIn = [], curOut = [], chunk, placed = P.d(0), s, i, best, bestScore, trial, q, cost, gain, residual, deepest, max;
    total = P.d(total);
    if (!total.gt(0)) return r;
    pools = Router.funded(pairPools, r); r.poolsAvailable = pools.length;
    if (!pools.length) return r;
    if (pools.length > Router.MAX_POOLS) { pools.sort(function(a,b){ return P.d(b.reserveM).cmp(a.reserveM); }); pools = pools.slice(0, Router.MAX_POOLS); r.capped = true; }
    r.spotBefore = Curve.aggregatePrice(pools); n = pools.length;
    for (i = 0; i < n; i++) { alloc[i] = P.d(0); curIn[i] = P.d(0); curOut[i] = P.d(0); }
    chunk = total.div(Router.STEPS);
    if (!chunk.gt(0)) return r;
    for (s = 0; s < Router.STEPS; s++) {
      best = -1; bestScore = exactMinimaOut ? null : P.d(0);
      for (i = 0; i < n; i++) {
        trial = alloc[i].add(chunk);
        q = exactMinimaOut ? Curve.quoteTForMOut(pools[i], trial) : (minimaToToken ? Curve.quoteMtoT(pools[i], trial) : Curve.quoteTtoM(pools[i], trial));
        if (!q.ok) continue;
        if (exactMinimaOut) {
          cost = q.inAmount.sub(curIn[i]);
          if (!cost.gt(0)) continue;
          if (bestScore === null || cost.lt(bestScore)) { best = i; bestScore = cost; }
        } else {
          gain = q.outAmount.sub(curOut[i]);
          if (gain.gt(bestScore)) { best = i; bestScore = gain; }
        }
      }
      if (best < 0) break;
      alloc[best] = alloc[best].add(chunk); placed = placed.add(chunk);
      q = exactMinimaOut ? Curve.quoteTForMOut(pools[best], alloc[best]) : (minimaToToken ? Curve.quoteMtoT(pools[best], alloc[best]) : Curve.quoteTtoM(pools[best], alloc[best]));
      if (q.ok) { curIn[best] = q.inAmount; curOut[best] = q.outAmount; }
    }
    residual = total.sub(placed);
    if (residual.gt(0)) {
      deepest = -1; max = P.d(-1);
      for (i = 0; i < n; i++) if (alloc[i].gt(max)) { max = alloc[i]; deepest = i; }
      if (deepest >= 0) alloc[deepest] = alloc[deepest].add(residual);
    }
    for (i = 0; i < n; i++) {
      if (!alloc[i].gt(0)) continue;
      q = exactMinimaOut ? Curve.quoteTForMOut(pools[i], alloc[i]) : (minimaToToken ? Curve.quoteMtoT(pools[i], alloc[i]) : Curve.quoteTtoM(pools[i], alloc[i]));
      if (!q.ok) continue;
      r.allocs.push({pool:pools[i], quote:q}); r.totalIn = r.totalIn.add(q.inAmount); r.totalOut = r.totalOut.add(q.outAmount);
    }
    r.poolsUsed = r.allocs.length;
    if (!r.poolsUsed || !r.totalOut.gt(0)) return r;
    r.effPrice = minimaToToken ? r.totalOut.div(r.totalIn) : r.totalIn.div(r.totalOut);
    if (exactMinimaOut) r.effPrice = r.totalIn.div(r.totalOut);
    r.ok = true; return r;
  };
  Router.aggregateDepth = function(pairPools) {
    var pools = Router.funded(pairPools || [], {pairAddresses:[]});
    if (pools.length > Router.MAX_POOLS) { pools.sort(function(a,b){ return P.d(b.reserveM).cmp(a.reserveM); }); pools = pools.slice(0, Router.MAX_POOLS); }
    return Curve.totalMinima(pools);
  };
  /* ---- synthetic depth: pool liquidity rendered as order-book bands ----
     Port of native SyntheticDepth.java. Two rules here are easy to get wrong and both were:

     1. A band boundary is a MARGINAL price, not an average one. The question a depth row answers
        is "how much can I take before the NEXT slice costs more than this price?" — not "how much
        can I take before my AVERAGE cost exceeds it?". On a constant-product curve those differ by
        a factor of two: taking Q out of reserves (x,y) moves the marginal price by ~2Q/x but the
        average price by only ~Q/x, so solving on the average admits twice the quantity for the
        same displayed price. That is not a rounding difference, it is a doubled depth ladder.
     2. A displayed row must be executable AT the price displayed beside it. Solving the curve says
        what the maths allows; it does not account for the router's own slicing and rounding. Every
        band is therefore re-planned through the real router at its own limit price and shaved back
        until the plan actually fills it. */
  Synthetic.DEFAULT_TICK = "0.00001";
  Synthetic.DISPLAY_DEPTH_CUT = "0.00001";
  Synthetic.SOLVE_ITERATIONS = 8;
  Synthetic.CAP_ITERATIONS = 8;
  Synthetic.ROUTER_SLICES = 128;

  /* The binary search revisits amounts, and enforceExecutable re-walks totals capToExecutable
     already priced. Memoise routes for the duration of one sample() pass — same pools, same side,
     same amount is the same answer. Cleared on exit so a later pass never sees stale reserves. */
  Synthetic._routes = null;
  Synthetic.routeFor = function(pools, askSide, amount) {
    var key, r;
    if (!Synthetic._routes) return askSide ? Router.routeExactMinimaOut(pools, amount) : Router.route(pools, true, amount);
    key = (askSide ? "a" : "b") + P.plain(amount);
    if (Object.prototype.hasOwnProperty.call(Synthetic._routes, key)) return Synthetic._routes[key];
    r = askSide ? Router.routeExactMinimaOut(pools, amount) : Router.route(pools, true, amount);
    Synthetic._routes[key] = r;
    return r;
  };
  Synthetic.sample = function(pools, askSide, tick, rows) {
    var out = [], pair = [], i, p, px, quantum, cap, prev = P.d(0), boundary, bucket, cum, band;
    pools = pools || [];
    for (i = 0; i < pools.length; i++) { p = Pool.clean(pools[i]); if (Pool.funded(p) && P.eqTok(p.tok, P.USDT)) pair.push(p); }
    if (!pair.length || rows <= 0) return out;
    px = Curve.aggregatePrice(pair); if (!px.gt(0)) return out;
    cap = Curve.totalMinima(pair).mul("0.5"); if (!cap.gt(0)) return out;
    quantum = tick ? P.d(tick) : P.d(Synthetic.DEFAULT_TICK);
    if (!quantum.gt(0)) return out;
    Synthetic._routes = {};
    try {
    for (i = 1; i <= rows; i++) {
      boundary = askSide ? px.add(quantum.mul(i)) : px.sub(quantum.mul(i));
      bucket = Synthetic.bucketPrice(boundary, askSide, quantum);
      if (!bucket.gt(0)) break;
      cum = Synthetic.solveToBoundary(pair, askSide, boundary, cap);
      cum = Synthetic.capToExecutable(pair, askSide, cum, bucket);
      band = cum.sub(prev);
      if (!band.gt(0)) continue;
      out.push({price:bucket, poolMinima:band});
      prev = cum;
      if (prev.gte(cap)) break;
    }
    return Synthetic.enforceExecutable(pair, askSide, out);
    } finally { Synthetic._routes = null; }
  };

  /* Snap a band's displayed price onto the tick grid the book itself groups by — asks up, bids
     down, so a level never flatters its own side. Without this the pool rows key on raw curve
     prices and never merge with the book's levels. */
  Synthetic.bucketPrice = function(price, askSide, tick) {
    var p = P.d(price === undefined || price === null ? 0 : price), t = P.d(tick), q;
    if (!p.gt(0) || !t.gt(0)) return P.d(0);
    q = askSide ? p.div(t).ceil() : p.div(t).floor();
    return q.mul(t);
  };

  /* The price of the NEXT slice at this cumulative size, obtained by differencing a route at
     `amount` against one an epsilon smaller — exactly how the composite router picks between a
     pool and an order. */
  Synthetic.marginalPrice = function(pools, askSide, amount) {
    var amt = P.d(amount), epsilon, beforeAmt, before, after, prevM, prevT, curM, curT, dm, dt;
    if (!amt.gt(0)) return null;
    epsilon = amt.div(Synthetic.ROUTER_SLICES).toDecimalPlaces(P.DP, Decimal.ROUND_CEIL);
    if (!epsilon.gt(0)) return null;
    beforeAmt = amt.sub(epsilon); if (beforeAmt.lt(0)) beforeAmt = P.d(0);
    before = beforeAmt.gt(0) ? Synthetic.routeFor(pools, askSide, beforeAmt) : null;
    after = Synthetic.routeFor(pools, askSide, amt);
    if (!after || !after.ok) return null;
    prevM = before && before.ok ? (askSide ? before.totalOut : before.totalIn) : P.d(0);
    prevT = before && before.ok ? (askSide ? before.totalIn : before.totalOut) : P.d(0);
    curM = askSide ? after.totalOut : after.totalIn;
    curT = askSide ? after.totalIn : after.totalOut;
    dm = P.d(curM).sub(prevM); dt = P.d(curT).sub(prevT);
    if (!dm.gt(0) || !dt.gt(0)) return null;
    return dt.div(dm).toDecimalPlaces(P.PRICE_DP, Decimal.ROUND_HALF_UP);
  };

  Synthetic.solveToBoundary = function(pools, askSide, boundary, cap) {
    var lo = P.d(0), hi = P.d(cap), i, mid, marginal, cmp;
    for (i = 0; i < Synthetic.SOLVE_ITERATIONS; i++) {
      mid = lo.add(hi).div(2).toDecimalPlaces(P.DP, Decimal.ROUND_HALF_UP);
      marginal = Synthetic.marginalPrice(pools, askSide, mid);
      if (!marginal) { hi = mid; continue; }
      cmp = marginal.cmp(boundary);
      if (askSide ? cmp <= 0 : cmp >= 0) lo = mid; else hi = mid;
    }
    return lo;
  };

  Synthetic.capToExecutable = function(pools, askSide, amount, limitPrice) {
    var amt = P.d(amount);
    if (!amt.gt(0)) return amt;
    return Synthetic.conservativeExecutable(pools, askSide, amt, limitPrice);
  };

  /* Shave until the real router can actually fill it at this limit. PandaComposite is resolved at
     call time on purpose: composite.js loads after this file. */
  /* How much the router would actually move at this limit price.
     This used to ask PandaComposite.plan with an empty book — but with no orders that router
     degenerates to exactly this single pool route, after grinding through its 128-slice loop with
     two full multi-pool routes per slice. 32,768 curve quotes for an answer one route gives in
     128. Measured, it made the depth ladder take 26 SECONDS for one pool and 53 for three, on
     every block, on the page's own thread. Native survives the same shape only because Java
     BigDecimal is far quicker and it runs on a dedicated background thread; here it froze the app. */
  Synthetic.executableAt = function(pools, askSide, amount, limitPrice) {
    var r = Synthetic.routeFor(pools, askSide, amount), got, paid, eff;
    if (!r || !r.ok) return P.d(0);
    got = P.d(askSide ? r.totalOut : r.totalIn);     /* the MINIMA leg */
    paid = P.d(askSide ? r.totalIn : r.totalOut);    /* the MxUSD leg */
    if (!got.gt(0) || !paid.gt(0)) return P.d(0);
    if (limitPrice) {
      eff = paid.div(got);
      if (askSide ? eff.gt(limitPrice) : eff.lt(limitPrice)) return P.d(0);
    }
    return got;
  };
  /* Shave until the router can actually fill it at this limit. */
  Synthetic.conservativeExecutable = function(pools, askSide, amount, limitPrice) {
    var cut = P.d(Synthetic.DISPLAY_DEPTH_CUT), candidate = P.d(amount).sub(cut), i, filled;
    if (candidate.lt(0)) candidate = P.d(0);
    for (i = 0; i < Synthetic.CAP_ITERATIONS && candidate.gt(0); i++) {
      filled = Synthetic.executableAt(pools, askSide, candidate, limitPrice);
      if (filled.gte(candidate)) return candidate;
      candidate = (filled.lt(candidate) ? filled : candidate).sub(cut);
      if (candidate.lt(0)) candidate = P.d(0);
    }
    return P.d(0);
  };

  /* A row is only honest if the CUMULATIVE depth above it is fillable at its price, so the check
     runs on the running total and re-derives each band from what survived. */
  Synthetic.enforceExecutable = function(pools, askSide, rows) {
    var safe = [], displayed = P.d(0), safeDisplayed = P.d(0), i, row, capped, band;
    for (i = 0; i < (rows || []).length; i++) {
      row = rows[i];
      displayed = displayed.add(row.poolMinima);
      capped = Synthetic.conservativeExecutable(pools, askSide, displayed, row.price);
      band = capped.sub(safeDisplayed);
      if (!band.gt(0)) continue;
      safe.push({price:row.price, poolMinima:band});
      safeDisplayed = capped;
    }
    return safe;
  };
})(PandaPool, PandaCurve, PandaPoolRouter, PandaSynthetic, PandaDEX);
