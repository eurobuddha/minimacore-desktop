/* Android DexStats/Candles.stats24h port for the MDS ticker header. */
var PandaStats = {};
PandaStats.D1 = 24 * 60 * 60 * 1000;
PandaStats.cleanFill = function(row) {
  row = row || {};
  return {
    timems:Number(row.timems || row.TIMEMS || 0),
    price:PandaDEX.d(row.price || row.PRICE || 0),
    size:PandaDEX.d(row.size || row.SIZE || 0),
    buy:row.buy === true || row.buy === "true" || row.BUY === true || row.BUY === "true" || row.buy === 1 || row.BUY === 1
  };
};
PandaStats.stats24h = function(rows, nowMs) {
  var sorted = [], cutoff, last = null, first = null, high = null, low = null, vol = PandaDEX.d(0), i, f, change;
  rows = rows || []; nowMs = Number(nowMs || Date.now()); cutoff = nowMs - PandaStats.D1;
  for (i = 0; i < rows.length; i++) sorted.push(PandaStats.cleanFill(rows[i]));
  sorted.sort(function(a, b) { return Number(a.timems) - Number(b.timems); });
  for (i = 0; i < sorted.length; i++) {
    f = sorted[i];
    if (f.timems < cutoff) continue;
    if (first === null) first = f.price;
    last = f.price;
    high = high === null || f.price.gt(high) ? f.price : high;
    low = low === null || f.price.lt(low) ? f.price : low;
    vol = vol.add(f.size);
  }
  if (last === null) return {last:null, changePct:null, high:null, low:null, volume:PandaDEX.plain(vol)};
  change = first.eq(0) ? PandaDEX.d(0) : last.sub(first).mul(100).div(first).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {last:PandaDEX.plain(last), changePct:PandaDEX.plain(change), high:PandaDEX.plain(high), low:PandaDEX.plain(low), volume:PandaDEX.plain(vol)};
};
PandaStats.lastFill = function(rows, nowMs) {
  var best = null, i, f, age;
  rows = rows || []; nowMs = Number(nowMs || Date.now());
  for (i = 0; i < rows.length; i++) {
    f = PandaStats.cleanFill(rows[i]);
    if (!best || f.timems > best.timems) best = f;
  }
  if (!best) return null;
  age = Math.max(0, nowMs - best.timems);
  return {price:PandaDEX.plain(best.price), ageMs:age};
};

/* PriceMath.weightedBookPrice: best displayed levels, same-side MINIMA sizes. */
PandaStats.weightedBookPrice = function(bid, bidSize, ask, askSize) {
  var value = PandaDEX.d(0), size = PandaDEX.d(0);
  function add(p, n) {
    if (p === null || p === undefined || n === null || n === undefined) return;
    p = PandaDEX.d(p); n = PandaDEX.d(n);
    if (p.gt(0) && n.gt(0)) { value = value.add(p.mul(n)); size = size.add(n); }
  }
  add(bid, bidSize); add(ask, askSize);
  return size.gt(0) ? value.div(size).toDecimalPlaces(12, Decimal.ROUND_HALF_UP) : null;
};
