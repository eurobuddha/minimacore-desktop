/* Android Pending.java lifecycle port, kept pure for tests and service reuse. */
var PandaPending = {};
PandaPending.PLACE = "PLACE";
PandaPending.CANCEL = "CANCEL";
PandaPending.EDIT = "EDIT";
PandaPending.SLOW_MS = 3 * 60 * 1000;
PandaPending.GIVEUP_MS = 20 * 60 * 1000;
PandaPending.clean = function(row) {
  row = row || {};
  return {
    kind:String(row.kind || row.KIND || ""),
    orderId:String(row.orderId || row.orderid || row.ORDERID || ""),
    coinid:String(row.coinid || row.COINID || ""),
    buy:row.buy === true || row.buy === "true" || row.BUY === true || row.BUY === "true" || row.buy === 1 || row.BUY === 1,
    minima:String(row.minima || row.MINIMA || "0"),
    price:String(row.price || row.PRICE || "0"),
    /* A legitimate 0 is not "unknown" — || would silently restamp it as now and reset the
       give-up clock every time the row was re-cleaned. */
    submitMs:Number(row.submitMs !== undefined ? row.submitMs : (row.submitms !== undefined ? row.submitms : (row.SUBMITMS !== undefined ? row.SUBMITMS : Date.now()))),
    submitBlock:Number(row.submitBlock || row.submitblock || row.SUBMITBLOCK || 0)
  };
};
PandaPending.status = function(row, nowMs) {
  var age, seconds, minutes, verb;
  row = PandaPending.clean(row);
  age = Math.max(0, Number(nowMs || Date.now()) - Number(row.submitMs || 0));
  if (row.kind === PandaPending.CANCEL) verb = "Cancelling";
  else if (row.kind === PandaPending.EDIT) verb = "Updating price";
  else verb = "Sending";
  seconds = Math.max(1, Math.round(age / 1000));
  minutes = Math.floor(seconds / 60);
  if (age >= PandaPending.SLOW_MS) return verb + "… taking longer than usual (" + (minutes || 1) + "m). Funds are safe; waiting for the next block.";
  return verb + "… waiting for the next block (~50s) · " + (minutes > 0 ? minutes + "m " + (seconds % 60) + "s" : seconds + "s");
};
PandaPending.refs = function(rows) {
  var refs = {}, i, row;
  rows = rows || [];
  for (i = 0; i < rows.length; i++) {
    row = PandaPending.clean(rows[i]);
    if (row.kind === PandaPending.CANCEL && row.coinid) refs[row.coinid] = "cancel";
    else if (row.kind === PandaPending.EDIT && row.coinid) refs[row.coinid] = "edit:" + row.orderId;
    else if (row.kind === PandaPending.PLACE && row.orderId) refs[row.orderId] = "create";
  }
  return refs;
};
PandaPending.resolve = function(rows, book, nowMs) {
  var liveIds = {}, liveCoins = {}, kept = [], events = [], i, row, done, gaveUp, order;
  rows = rows || []; book = book || []; nowMs = Number(nowMs || Date.now());
  for (i = 0; i < book.length; i++) {
    order = book[i] || {};
    if (order.orderId) liveIds[order.orderId] = true;
    if (order.coinid) liveCoins[order.coinid] = true;
  }
  for (i = 0; i < rows.length; i++) {
    row = PandaPending.clean(rows[i]);
    done = false;
    if (row.kind === PandaPending.PLACE) done = !!(row.orderId && liveIds[row.orderId]);
    else if (row.kind === PandaPending.CANCEL) done = !!(row.coinid && !liveCoins[row.coinid]);
    else if (row.kind === PandaPending.EDIT) done = !!(row.coinid && !liveCoins[row.coinid] && row.orderId && liveIds[row.orderId]);
    gaveUp = !done && (nowMs - Number(row.submitMs || 0) >= PandaPending.GIVEUP_MS);
    if (done) events.push({type:row.kind === PandaPending.PLACE ? "live" : "settled", row:row});
    else if (gaveUp) events.push({type:"gaveup", row:row});
    else kept.push(row);
  }
  return {rows:kept, events:events, refs:PandaPending.refs(kept)};
};
