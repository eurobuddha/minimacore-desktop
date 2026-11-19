/* ES5 service: the sole chain/transaction owner. Never touches the DOM. */
/* module loads live in Dexicon service.js (resting/*.js) */
var PDService = { book:[], block:0, identity:null, keyset:{}, addrset:{}, keysReady:false, keysRetryBlock:0, ready:false, scanning:false, rescan:false, busy:false,
  activityLog:[], logSequence:0, logSession:String(Date.now()), lastLogMessage:"", pendingRows:[], pendingRefs:{}, filling:{}, stage:"", stageAtMs:0, busyBlock:0, fillCoins:null, fillBlock:0, fillMeta:null, tape:[], myTrades:[],
  stats:{last:null, changePct:null, high:null, low:null, volume:"0", lastFill:null},
  cancelled:{}, vanished:[], verifyingFill:false, lastFillLine:"", diff:null, restQueue:null, restQueueCoins:null, restQueueBlock:0,
  pools:[], poolScanning:false, poolHaveLive:false, poolEmptyScans:0,
  maker:{cfg:null, working:false, lastCycleMs:0, pendingIdle:null}, processor:{working:false, startedBlock:0} };
PDService.SWEEP_DEADLINE_BLOCKS = 6;
/* A processor run that loses its callback would otherwise hold `working` for the whole session and
   silently stop renewing GTC orders. Force-clear it after this many blocks. */
PDService.PROCESSOR_STUCK_BLOCKS = 4;
/* `busy` had no escape at all: one lost callback anywhere in the transaction chain left it true
   for the rest of the session, refusing every later action with "a transaction is already in
   flight" and silently disabling the maker and the processor. The block clock is the only clock
   this service has. */
PDService.BUSY_STUCK_BLOCKS = 8;
/* A stage line older than this renders as nothing, so the banner can never sit there lying about
   what the app is doing. Native holds a stage for the same 45 seconds. */
PDService.STAGE_HOLD_MS = 45000;
PDService.MAKER_MIN_CYCLE_MS = 60000;
PDService.MAKER_MAX_ACTIONS = 4;
PDService.MAKER_MAX_CREATES_SIDE = 1;
PDService.MAKER_PATIENCE_BLOCKS = 4;
PDService.MAKER_TOMBSTONE_BLOCKS = 10;
PDService.tell = function(type, data) {
  /* solo messages are echoed to every MiniDapp component, including this service.
     The origin field prevents an echoed STATE/POSTED update becoming a command. */
  MDS.comms.solo(JSON.stringify({origin:"service", type:type, data:data || {}}), function(){});
};
PDService.notify = function(message) {
  try { if (MDS.notify) MDS.notify(String(message || "")); } catch (ignore) {}
};
PDService.notifyPending = function(event) {
  var row, side, line;
  if (!event || !event.row) return;
  row = event.row;
  side = row.buy ? "Buy " : "Sell ";
  line = side + PandaDEX.plain(row.minima) + " MINIMA @ " + PandaDEX.plain(row.price);
  if (event.type === "live") PDService.notify("Order live: " + line + " is on the order book");
  else if (event.type === "settled" && row.kind === PandaPending.CANCEL) PDService.notify("Order cancelled: funds are back in your wallet");
  else if (event.type === "settled" && row.kind === PandaPending.EDIT) PDService.notify("New price live: " + line);
};
PDService.cmd = function(command, callback) {
  var failure=PandaSafety.commandFailure(command), called=false;
  if (failure) return callback({status:false,error:failure});
  MDS.cmd(command, function(result) {
    if (called) return; called=true;
    callback(result || {status:false,error:"No node response",transporterror:true});
  });
};
PDService.escSql = function(value) { return String(value).replace(/'/g, "''"); };
PDService.maybeDec = function(value) {
  try {
    if (value === undefined || value === null || value === "" || value === "—") return null;
    return PandaDEX.d(value);
  } catch (ignore) {
    return null;
  }
};
PDService.dec = function(value, fallback) {
  var d = PDService.maybeDec(value);
  if (d) return d;
  d = PDService.maybeDec(fallback === undefined ? 0 : fallback);
  return d || PandaDEX.d(0);
};
PDService.rebuildPendingRefs = function() { PDService.pendingRefs = PandaPending.refs(PDService.pendingRows); };
PDService.pendingInit = function(done) {
  MDS.sql("CREATE TABLE IF NOT EXISTS `pending_state` (`id` int primary key, `json` clob)", function() {
    MDS.sql("SELECT `json` FROM `pending_state` WHERE `id`=1", function(result) {
      var rows = result && result.rows, raw = [], i;
      try { if (rows && rows.length) raw = JSON.parse(rows[0].json || rows[0].JSON || "[]"); } catch (ignore) { raw = []; }
      PDService.pendingRows = [];
      for (i = 0; i < raw.length; i++) PDService.pendingRows.push(PandaPending.clean(raw[i]));
      PDService.rebuildPendingRefs();
      if (done) done();
    });
  });
};
PDService.savePending = function(done) {
  var json = PDService.escSql(JSON.stringify(PDService.pendingRows || []));
  MDS.sql("DELETE FROM `pending_state` WHERE `id`=1", function() {
    MDS.sql("INSERT INTO `pending_state` (`id`,`json`) VALUES (1,'" + json + "')", function() { if (done) done(); });
  });
};
PDService.pendingMessage = function(type, row) {
  if (!row) return "";
  if (type === "live") return "Order is live on the book";
  if (type === "settled" && row.kind === PandaPending.CANCEL) return "Order cancelled — funds are returning to your wallet";
  if (type === "settled" && row.kind === PandaPending.EDIT) return "New price is live on the book";
  if (type === "gaveup" && row.kind === PandaPending.PLACE) return "Never saw that order rest on the book — it may have been taken immediately. Check Orders and your balance.";
  if (type === "gaveup") return "Still no confirmation for that request — check Orders and your balance.";
  return "";
};
PDService.addPending = function(kind, row, done) {
  if (kind === PandaPending.PLACE && row && row.orderId) PDService.rememberOrder(row.orderId);
  var next = PandaPending.clean({
    kind:kind, orderId:row && row.orderId, coinid:row && row.coinid, buy:row && row.buy,
    minima:row && row.minima, price:row && row.price, submitMs:Date.now(), submitBlock:PDService.block
  });
  PDService.pendingRows.push(next);
  PDService.rebuildPendingRefs();
  PDService.savePending(function() { PDService.snapshot(); if (done) done(); });
};
PDService.addPendingRows = function(rows, done) {
  var i;
  rows = rows || [];
  for (i = 0; i < rows.length; i++) PDService.pendingRows.push(PandaPending.clean(rows[i]));
  PDService.rebuildPendingRefs();
  PDService.savePending(function() { PDService.snapshot(); if (done) done(); });
};
PDService.isMine = function(order) { return !!(order && PDService.keyset[order.ownerPk]); };
PDService.owns = function(order) { return !!(order && PDService.keyset[order.ownerPk] && PDService.addrset[order.wantAddr]); };
PDService.emptyMap = function(map) { var k; for (k in map) if (map.hasOwnProperty(k)) return false; return true; };
PDService.snapshot = function() {
  var mine = [], book = [], i, order;
  for (i = 0; i < PDService.book.length; i++) {
    order = PDService.book[i];
    if (PDService.owns(order)) mine.push(order);
    if (order && order.fillable !== false) book.push(order);   /* the public book shows only what a taker can fill */
  }
  PDService.tell("STATE", {ready:PDService.ready, block:PDService.block, identity:PDService.identity,
    book:book, pools:PDService.pools, poolsSyncing:!PDService.poolHaveLive, mine:mine, pending:PDService.pendingRefs, pendingRows:PDService.pendingRows,
    filling:PDService.filling, stats:PDService.stats,
    activityLog:PDService.activityLog, logSession:PDService.logSession, awaitingFill:!!PDService.fillMeta, stage:PDService.stageNow(), busy:PDService.busy, tape:PDService.tape, myTrades:PDService.myTrades,
    maker:PDService.makerPublic()});
};
PDService.setStage = function(message) {
  var text = String(message || "");
  PDService.stage = text; PDService.stageAtMs = Date.now();
  if (text && text !== PDService.lastLogMessage) {
    PDService.activityLog.unshift({id:++PDService.logSequence, at:PDService.stageAtMs, text:text.slice(0,512)});
    if (PDService.activityLog.length > 60) PDService.activityLog.length = 60;
    PDService.lastLogMessage = text;
  }
  PDService.snapshot();
};
PDService.stageNow = function() {
  if (!PDService.stage) return "";
  return !PDService.busy && !PDService.fillMeta && Date.now() - Number(PDService.stageAtMs || 0) > PDService.STAGE_HOLD_MS ? "" : PDService.stage;
};
/* Mark the start of a fund-moving action so the block clock can free it if its callback is lost. */
PDService.setBusy = function(on) { PDService.busy = !!on; PDService.busyBlock = on ? PDService.block : 0; };
PDService.releaseStuckBusy = function() {
  if (!PDService.busy || PDService.block <= 0 || Number(PDService.busyBlock || 0) <= 0) return;
  if (PDService.block - Number(PDService.busyBlock) <= PDService.BUSY_STUCK_BLOCKS) return;
  PDService.setBusy(false); PDService.busyBlock = 0;
  PDService.setStage("That transaction never came back from the node. Nothing further was sent — check ORDERS and your balance before retrying.");
};
PDService.loadTape = function(done) {
  PandaTape.tapeRows(120, function(tape) {
    PDService.tape = tape;
    PandaTape.myTrades(200, function(trades) {
      PDService.myTrades = trades;
      PandaTape.fillsSince(Date.now() - PandaStats.D1, 8000, function(fills) {
        PDService.stats = PandaStats.stats24h(fills, Date.now());
        PandaTape.lastFill(function(last) {
          PDService.stats.lastFill = last ? PandaStats.lastFill([last], Date.now()) : null;
          if (done) done();
        });
      });
    });
  });
};
/* PandaPools discovery. Single-flight, and it does NOT believe a lone empty scan: a resyncing
   node answers status:true with an empty list, and dropping every pool on that would make the
   router silently fall back to book-only. Two consecutive empties against a non-empty cache are
   required before the pools go away. Same shape as the book's own belief rule. */
PDService.POOL_EMPTY_CONFIRM = 2;
PDService.poolWaiters = [];
PDService.refreshPools = function(done) {
  var emptyAgainstCache;
  /* If a scan is already running, WAIT for it rather than returning the stale snapshot — a trade
     about to be planned must not be handed pool reserves that are already a block old. */
  if (PDService.poolScanning) { if (done) PDService.poolWaiters.push(done); return; }
  PDService.poolScanning = true;
  if (done) PDService.poolWaiters.push(done);
  function finishPools() {
    var waiters = PDService.poolWaiters, i;
    PDService.poolWaiters = [];
    /* Report, never swallow. A silently-eaten exception here left the UI on "Checking pool
       liquidity" forever with no transaction and no error — the failure mode this whole release
       exists to eliminate. */
    for (i = 0; i < waiters.length; i++) {
      try { waiters[i](); }
      catch (error) {
        PDService.notifyLog("pool-wait callback failed: " + error);
        PDService.setBusy(false);
        PDService.setStage("Could not plan the trade — " + (error && error.message ? error.message : error));
        PDService.tell("ERROR", {message:"Could not plan the trade — " + (error && error.message ? error.message : error)});
      }
    }
  }
  PandaPool.scan(PDService.cmd, function(error, pools) {
    PDService.poolScanning = false;
    /* A failed scan keeps the previous snapshot, which is the right call for rendering but means
       a trade could be planned against reserves that have since moved. Say so rather than hide it. */
    if (error) { PDService.notifyLog("pool scan failed: " + error); finishPools(); return; }
    pools = pools || [];
    emptyAgainstCache = pools.length === 0 && PDService.pools.length > 0;
    if (emptyAgainstCache) PDService.poolEmptyScans++; else PDService.poolEmptyScans = 0;
    if (!emptyAgainstCache || !PDService.poolHaveLive || PDService.poolEmptyScans >= PDService.POOL_EMPTY_CONFIRM) {
      PDService.pools = pools;
      PDService.poolHaveLive = true;
    }
    finishPools();
  });
};
/* The tape suppresses a vanish it knows we cancelled. That map was written in exactly one place —
   inside recordObservedFill, AFTER adjudication had already run — so no cancel we submitted was
   ever pre-registered, and the tape fell back to guessing from address-and-amount evidence. That
   guess is what turned a cancelled ask rung's refund into a "fill" for every bid rung of the same
   size. Register at submit time, and persist it so a restart does not forget. */
PDService.CANCEL_KEEP_MS = 24 * 60 * 60 * 1000;
PDService.cancelInit = function(done) {
  MDS.sql("CREATE TABLE IF NOT EXISTS `cancelled_coins` (`coinid` varchar(160) primary key, `ts` bigint)", function() {
    MDS.sql("DELETE FROM `cancelled_coins` WHERE `ts`<" + (Date.now() - PDService.CANCEL_KEEP_MS), function() {
      MDS.sql("SELECT `coinid` FROM `cancelled_coins`", function(res) {
        var rows = (res && res.rows) || [], i, id;
        for (i = 0; i < rows.length; i++) { id = rows[i].COINID || rows[i].coinid; if (id) PDService.cancelled[id] = true; }
        if (done) done();
      });
    });
  });
};
PDService.noteCancelled = function(coinid) {
  if (!coinid) return;
  /* The in-memory map is authoritative for this session, so a lost write cannot resurrect a
     phantom before the next restart. */
  PDService.cancelled[coinid] = true;
  MDS.sql("INSERT INTO `cancelled_coins` (`coinid`,`ts`) VALUES ('" + PDService.escSql(coinid) + "'," + Date.now() + ")", function() {
    /* An MDS write can fail while its callback still reports success, so confirm by reading it
       back. Losing this row means a cancel is re-adjudicated later as a possible fill. */
    MDS.sql("SELECT `coinid` FROM `cancelled_coins` WHERE `coinid`='" + PDService.escSql(coinid) + "'", function(res) {
      var rows = (res && res.rows) || [];
      if (!rows.length) PDService.notifyLog("cancel log write was lost for " + coinid + " — it will not survive a restart");
    });
  });
};
PDService.notifyLog = function(message) { try { if (MDS.log) MDS.log("[PandaDEX] " + message); } catch (ignore) {} };
/* fillMeta lived only in memory: a service restart between posting and confirmation lost the
   trade permanently, even though pending_state already showed the pattern. */
PDService.saveFill = function() {
  var payload = PDService.escSql(JSON.stringify({meta:PDService.fillMeta, coins:PDService.fillCoins, block:PDService.fillBlock}));
  MDS.sql("CREATE TABLE IF NOT EXISTS `fill_state` (`id` int primary key, `json` clob)", function() {
    MDS.sql("MERGE INTO `fill_state` (`id`,`json`) KEY(`id`) VALUES (1,'" + payload + "')", function(r) {
      if(!r||r.status!==true)PDService.setStage("Trade record could not be saved. Keep this app open and check the node before any retry.");
    });
  });
};
PDService.loadFill = function(done) {
  MDS.sql("CREATE TABLE IF NOT EXISTS `fill_state` (`id` int primary key, `json` clob)", function() {
    MDS.sql("SELECT `json` FROM `fill_state` WHERE `id`=1", function(res) {
      var rows = (res && res.rows) || [], raw = null;
      try { if (rows.length) raw = JSON.parse(rows[0].json || rows[0].JSON || "null"); } catch (ignore) { raw = null; }
      if (raw && raw.meta) { PDService.fillMeta = raw.meta; PDService.fillCoins = raw.coins || null; PDService.fillBlock = Number(raw.block || 0); }
      if (done) done();
    });
  });
};
PDService.recordFill = function(status, note) {
  var m = PDService.fillMeta;
  if (!m) return;
  PDService.fillMeta = null; PDService.saveFill();
  PDService.lastFillLine = (m.buy ? "Bought " : "Sold ") + PandaDEX.plain(m.size) + " MINIMA @ " + PandaDEX.plain(m.price);
  PandaTape.addMyTrade({spentcoin:m.spentcoin, timems:Date.now(), block:PDService.block, price:m.price,
    size:m.size, buy:m.buy, maker:false, orderid:"", txpowid:m.txpowid || "", sourceKind:m.sourceKind || "BOOK",
    sourceCoinids:(m.sourceCoinids || []).join(" "), verificationStatus:status || "LOCAL_VERIFIED",
    verificationNote:note || "Source coins spent and expected proceeds observed", verifiedBlock:PDService.block}, function(added) {
      if (added) PDService.notify(status
        ? "Trade recorded UNVERIFIED: " + (m.buy ? "Bought " : "Sold ") + PandaDEX.plain(m.size) + " MINIMA @ " + PandaDEX.plain(m.price) + " MxUSD. " + note + "."
        : "Trade complete: " + (m.buy ? "Bought " : "Sold ") + PandaDEX.plain(m.size) + " MINIMA @ " + PandaDEX.plain(m.price) + " MxUSD. Funds are confirming.");
      PDService.loadTape(function() { PDService.snapshot(); });
    });
};
/* A PARTIAL fill proves itself: the successor coin carrying the remainder is on-chain evidence
   that a fill happened and for exactly how much. A FULL disappearance proves nothing on its own —
   it is equally consistent with a fill, someone else's cancel, or a coin we simply failed to read.
   So only positive payout evidence may be recorded, and UNKNOWN is DROPPED.

   This previously recorded UNKNOWN as a fill, which is the phantom-trade bug native lists as a
   fixed critical issue. PandaVerify returns UNKNOWN for any unreadable reply, so a single node
   hiccup was enough to write a trade that never happened into the tape, the candles, the 24h
   stats, my_trades, the P&L and the accounting export. A lost trade is invisible to the user; a
   phantom one is not. */
PDService.recordObservedFill = function(spentCoin, order, size, price, takerBuy, partial) {
  if (partial) return PDService.storeObservedFill(spentCoin, order, size, price, takerBuy, true);
  PDService.queueVanish(spentCoin, order, size, price, takerBuy, 0);
};
/* Full disappearances are collected across the whole scan and adjudicated together, because the
   evidence rule is EXCLUSIVE — one coin can prove at most one order — and that can only be decided
   once every vanish in the scan is known. Adjudicating them one at a time is what let a single
   cancelled rung's refund "prove" a fill for every other rung of the same size. */
PDService.vanished = [];
PDService.queueVanish = function(spentCoin, order, size, price, takerBuy, since) {
  PDService.vanished.push({coinid:spentCoin, order:order, size:size, price:price, buy:takerBuy, since:since});
};
PDService.settleVanished = function() {
  var batch = PDService.vanished, ids = [], i;
  PDService.vanished = [];
  if (!batch.length) return;
  for (i = 0; i < batch.length; i++) ids.push(batch[i].coinid);
  /* TRUE HISTORY FIRST. Ask the chain what actually spent each coin and read that transaction's
     outputs — definitive, order-linked, and still available long after the proceeds were spent
     onward, which is the case payout evidence can never recover. Only what history cannot answer
     falls through to the exclusive payout rule below. */
  PandaHistory.findSpends(PDService.cmd, ids, function(spends) {
    var settled = {}, rest = [], j, it, spend, verdict;
    for (j = 0; j < batch.length; j++) {
      it = batch[j];
      spend = spends[it.coinid];
      verdict = spend ? PandaHistory.verdictForSpend(spend, it.order, PDService.sameAmount) : null;
      if (!verdict) { rest.push(it); continue; }
      settled[it.coinid] = true;
      if (verdict === "CANCELLED") { PDService.noteCancelled(it.coinid); continue; }
      PDService.storeObservedFill(it.coinid, it.order, it.size, it.price, it.buy, false, spend.txpowid, "CHAIN_VERIFIED", spend);
    }
    if (!rest.length) return;
    PandaVerify.verifyBatch(PDService.cmd, rest, PDService.block, function(verdicts) {
      var k, r, v;
      for (k = 0; k < rest.length; k++) {
        r = rest[k];
        v = verdicts[r.coinid] || PandaVerify.UNKNOWN;
        if (v === PandaVerify.CANCELLED) { PDService.noteCancelled(r.coinid); continue; }
        if (v !== PandaVerify.FILLED) continue;   /* unprovable — never recorded */
        PDService.storeObservedFill(r.coinid, r.order, r.size, r.price, r.buy, false, "", "LOCAL_VERIFIED");
      }
    });
  });
};
PDService.sameAmount = function(a, b) { try { return PandaDEX.d(a).eq(PandaDEX.d(b)); } catch (ignore) { return false; } };
PDService.storeObservedFill = function(spentCoin, order, size, price, takerBuy, partial, txpowid, how, proof) {
  var mine = PDService.owns(order), time=proof&&proof.inclusionTimeMs>0?proof.inclusionTimeMs:Date.now(), block=proof&&proof.inclusionBlock>0?proof.inclusionBlock:PDService.block;
  PandaTape.addFill({spentcoin:spentCoin, timems:time, block:block, price:price,
    size:size, buy:takerBuy, partial:partial === true && size.lt(order.minima), mine:mine}, function() {
    if (mine) {
      PandaTape.addMyTrade({spentcoin:spentCoin, timems:time, block:block, price:price,
        size:size, buy:takerBuy, maker:true, orderid:order.orderId, txpowid:txpowid || "", sourceKind:"BOOK",
        verificationStatus:how || "LOCAL_VERIFIED",
        verificationNote:(how === "CHAIN_VERIFIED" ? "Read from the included transaction at this order input index" + (proof&&proof.inclusionTimeMs>0?". Time basis: verified inclusion block.":". Time basis: observation on this device.")
          : (partial ? "Partial fill proven by successor order" : "Full fill proven by payout evidence")),
        verifiedBlock:block}, function(added) {
          if (added) PDService.notify((partial === true && size.lt(order.minima) ? "Order partially filled: " : "Order filled: ") + (order.sell ? "Sold " : "Bought ") + PandaDEX.plain(size) + " MINIMA @ " + PandaDEX.plain(price) + " MxUSD");
          PDService.loadTape(function() { PDService.snapshot(); });
        });
    } else {
      PDService.loadTape(function() { PDService.snapshot(); });
    }
  });
};
PDService.makerDefault = function() {
  return {pegged:true, stepPct:"0.20", levelCount:3, askSize:"0", bidSize:"0", manualMid:"0",
    skewPct:"0", repricePct:"0.25", armed:false, asks:[], bids:[], slots:{}, tombstones:{}, lastActedMid:null,
    /* Bumped on every accepted settings write. A callback queued before the change must not be
       reauthorised by the settings that replaced it. */
    quoteRevision:"0"};
};
PDService.levelIn = function(level) { return {price:PandaDEX.plain(PDService.dec(level && level.price)), sizeMinima:PandaDEX.plain(PDService.dec(level && (level.sizeMinima || level.size)))}; };
PDService.levelOut = function(level) { return {price:PDService.dec(level && level.price), sizeMinima:PDService.dec(level && level.sizeMinima)}; };
PDService.normalizeMaker = function(raw) {
  var d = PDService.makerDefault(), c = raw || {}, i;
  for (i in d) if (d.hasOwnProperty(i) && c[i] !== undefined) d[i] = c[i];
  d.pegged = d.pegged !== false; d.armed = d.armed === true;
  d.stepPct = PandaDEX.plain(PDService.dec(d.stepPct, "0.20")); d.askSize = PandaDEX.plain(PDService.dec(d.askSize)); d.bidSize = PandaDEX.plain(PDService.dec(d.bidSize));
  d.manualMid = PandaDEX.plain(PDService.dec(d.manualMid)); d.skewPct = PandaDEX.plain(PDService.dec(d.skewPct)); d.repricePct = PandaDEX.plain(PDService.dec(d.repricePct, "0.25"));
  if (PDService.dec(d.skewPct).gt(20)) d.skewPct = "20";
  if (PDService.dec(d.skewPct).lt(-20)) d.skewPct = "-20";
  if (!PDService.dec(d.repricePct).gt(0)) d.repricePct = "0.25";
  d.levelCount = Math.max(1, Math.min(PandaMaker.MAX_LEVELS, Number(d.levelCount || 3)));
  d.asks = Array.isArray(d.asks) ? d.asks : []; d.bids = Array.isArray(d.bids) ? d.bids : [];
  for (i = 0; i < d.asks.length; i++) d.asks[i] = PDService.levelIn(d.asks[i]);
  for (i = 0; i < d.bids.length; i++) d.bids[i] = PDService.levelIn(d.bids[i]);
  d.slots = d.slots && typeof d.slots === "object" ? d.slots : {}; d.tombstones = d.tombstones && typeof d.tombstones === "object" ? d.tombstones : {};
  d.quoteRevision = String(d.quoteRevision === undefined || d.quoteRevision === null ? "0" : d.quoteRevision);
  return d;
};
PDService.makerLadderConfig = function() {
  var c = PDService.maker.cfg || PDService.makerDefault(), asks = [], bids = [], i;
  for (i = 0; i < c.asks.length && i < PandaMaker.MAX_LEVELS; i++) asks.push(PDService.levelOut(c.asks[i]));
  for (i = 0; i < c.bids.length && i < PandaMaker.MAX_LEVELS; i++) bids.push(PDService.levelOut(c.bids[i]));
  return {pegged:c.pegged, stepPct:c.stepPct, asks:asks, bids:bids, skewPct:c.skewPct, repricePct:c.repricePct};
};
PDService.makerPublic = function() {
  var c = PDService.maker.cfg || PDService.makerDefault(), desired = PDService.makerDesired(), cleanDesired = [], commitments = PandaMaker.commitments(desired), slots = 0, tombs = 0, k, i, s;
  for (i = 0; i < desired.length; i++) { s = desired[i]; cleanDesired.push({id:s.id, sell:s.sell, price:PandaDEX.plain(s.price), sizeMinima:PandaDEX.plain(s.sizeMinima)}); }
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) slots++;
  for (k in c.tombstones) if (c.tombstones.hasOwnProperty(k)) tombs++;
  return {cfg:c, working:PDService.maker.working, desired:cleanDesired, commitments:{askMinima:PandaDEX.plain(commitments.askMinima), bidUsdt:PandaDEX.plain(commitments.bidUsdt)}, slots:slots, tombstones:tombs, mid:PandaDEX.plain(PDService.makerMid() || 0), feed:{mid:PandaDEX.plain(PandaPrice.mid()), label:PandaPrice.stateLabel(), fresh:PandaPrice.fresh(), mustWithdraw:PandaPrice.mustWithdraw(), widen:PandaPrice.widenFactor(), error:PandaPrice.lastError || ""}};
};
PDService.loadMaker = function(done) {
  MDS.sql("CREATE TABLE IF NOT EXISTS `maker_state` (`id` int primary key, `json` clob)", function() {
    MDS.sql("SELECT `json` FROM `maker_state` WHERE `id`=1", function(result) {
      var rows = result && result.rows, raw = null;
      try { if (rows && rows.length) raw = JSON.parse(rows[0].json || rows[0].JSON || "{}"); } catch (ignore) {}
      PDService.maker.cfg = PDService.normalizeMaker(raw);
      if (done) done();
    });
  });
};
/* Native MakerConfig.storageHealthy / saveUserAction. The slot records ARE the maker's memory of
   which on-chain order is which; if they cannot be written, the next cycle plans against a ladder
   it can no longer recognise and posts a second one on top of real funds. A failed write therefore
   latches quoting off, and only an explicit user save clears it — never a retry of our own. */
PDService.saveMaker = function(done, userAction) {
  var json = PDService.escSql(JSON.stringify(PDService.maker.cfg || PDService.makerDefault()));
  MDS.sql("DELETE FROM `maker_state` WHERE `id`=1", function() {
    MDS.sql("INSERT INTO `maker_state` (`id`,`json`) VALUES (1,'" + json + "')", function(result) {
      var ok = !(result && result.status === false);
      if (!ok) { PDService.maker.storageFailed = true; PDService.setStage("Maker settings could not be saved — quoting is paused. Check storage and save again."); }
      else if (userAction) PDService.maker.storageFailed = false;
      if (done) done(ok);
    });
  });
};
/* Everything the guard revalidates against, read at the moment of use. */
PDService.makerGuardState = function() {
  var c = PDService.maker.cfg || PDService.makerDefault(), pegged = !!c.pegged, feedMid = pegged ? PandaPrice.mid() : null;
  return {storageHealthy:!PDService.maker.storageFailed, armed:c.armed === true,
    revision:c.quoteRevision || "0", ladder:PDService.makerLadderConfig(),
    quoteOk:!pegged || (!PandaPrice.mustWithdraw() && PDService.dec(feedMid).gt(0)),
    mid:feedMid, widen:pegged ? String(PandaPrice.widenFactor()) : "1"};
};
PDService.makerMid = function() {
  var mid = PandaPrice && PandaPrice.mid ? PDService.maybeDec(PandaPrice.mid()) : null;
  return mid && mid.gt(0) ? mid.toDecimalPlaces(PandaDEX.PRICE_DP, Decimal.ROUND_HALF_UP) : null;
};
PDService.bookMid = function() {
  var bid = null, ask = null, i, o, price;
  for (i = 0; i < PDService.book.length; i++) {
    o = PDService.book[i];
    if (o && o.fillable === false) continue;
    price = PDService.maybeDec(o && o.price);
    if (!price || !price.gt(0)) continue;
    if (o.sell) { if (!ask || price.lt(ask)) ask = price; }
    else { if (!bid || price.gt(bid)) bid = price; }
  }
  return bid && ask ? bid.add(ask).div(2).toDecimalPlaces(PandaDEX.PRICE_DP, Decimal.ROUND_HALF_UP) : null;
};
PDService.makerDesired = function() {
  var c = PDService.maker.cfg || PDService.makerDefault(), mid = c.pegged ? PDService.makerMid() : PDService.dec(c.manualMid);
  return PandaMaker.desired(mid, PDService.makerLadderConfig(), c.pegged ? String(PandaPrice.widenFactor()) : "1");
};
PDService.makerOwnedIds = function() {
  var c = PDService.maker.cfg || PDService.makerDefault(), ids = {}, k;
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) ids[c.slots[k].orderId] = true;
  for (k in c.tombstones) if (c.tombstones.hasOwnProperty(k)) ids[k] = true;
  return ids;
};
PDService.makerLiveById = function(includeTombs) {
  var out = {}, c = PDService.maker.cfg || PDService.makerDefault(), i, o;
  for (i = 0; i < PDService.book.length; i++) {
    o = PDService.book[i];
    if (PDService.owns(o) && (includeTombs || !c.tombstones[o.orderId])) out[o.orderId] = o;
  }
  return out;
};
PDService.makerRemember = function(slot, orderId, block) {
  var c = PDService.maker.cfg;
  /* Record what the order LOCKS, not just what we asked for. Repricing changes the want side and
     leaves this alone, so it is the only baseline a partial fill can be measured against. */
  c.slots[slot.id] = {orderId:orderId, size:PandaDEX.plain(slot.sizeMinima),
    locked:PandaDEX.plain(PandaTxn.lockedAmount(!slot.sell, slot.sizeMinima, slot.price)),
    lockedToken:slot.sell ? "0x00" : PandaDEX.USDT,
    sentBlock:block || 0, lastActionBlock:0}; PDService.saveMaker();
};
PDService.makerForgetByOrderId = function(orderId) {
  var c = PDService.maker.cfg, k;
  for (k in c.slots) if (c.slots.hasOwnProperty(k) && c.slots[k].orderId === orderId) { delete c.slots[k]; PDService.saveMaker(); return; }
};
PDService.makerTombstone = function(orderId, createdBlock, lastAttemptBlock) {
  var c = PDService.maker.cfg, t;
  if (!orderId) return;
  t = c.tombstones[orderId];
  if (!t) c.tombstones[orderId] = {createdBlock:createdBlock || PDService.block, lastAttemptBlock:lastAttemptBlock || 0};
  else if ((lastAttemptBlock || 0) > Number(t.lastAttemptBlock || 0)) t.lastAttemptBlock = lastAttemptBlock;
  PDService.saveMaker();
};
PDService.makerSetStage = function(message) { if (message) PDService.setStage(message); };
PDService.makerRun = function(actions, idx, mid, posted, chainBlock, guard) {
  var a, createOid, input, o, newWant, stopped;
  if (idx >= actions.length) {
    stopped = PDService.maker.guardStopped;
    PDService.maker.working = false;
    PDService.maker.guardStopped = false;
    if (posted > 0 && PDService.dec(mid).gt(0)) PDService.maker.cfg.lastActedMid = PandaDEX.plain(mid);
    PDService.saveMaker(function() { PDService.makerSetStage(stopped ? "Maker: prices or settings changed; remaining adjustments were not submitted" : posted > 0 ? "Maker: " + posted + " action" + (posted === 1 ? "" : "s") + " accepted — mining now" : "Maker: no adjustment could be posted — will retry"); PDService.snapshot(); });
    return;
  }
  PDService.maker.working = true;
  a = actions[idx];
  /* Native MakerEngine: revalidate before EVERY action, and on refusal abandon the REST of the
     cycle rather than skipping one action. lastCycleMs=0 lets the next book update replan at once
     — or withdraw the ladder, if what changed was the price feed going stale. */
  if (guard && !guard.allows(PDService.makerGuardState(), a)) {
    PDService.maker.guardStopped = true;
    PDService.maker.lastCycleMs = 0;
    return PDService.makerRun(actions, actions.length, mid, posted, chainBlock, guard);
  }
  if (a.kind === PandaMaker.K_CREATE) {
    return PDService.cmd("random", function(rand) {
      createOid = rand && rand.status && rand.response && rand.response.random;
      if (!createOid) { PDService.makerSetStage("Maker: CREATE failed — could not create order id"); return PDService.makerRun(actions, idx + 1, mid, posted, chainBlock, guard); }
      input = {buy:!a.slot.sell, minima:PandaDEX.plain(a.slot.sizeMinima), price:PandaDEX.plain(a.slot.price), gtc:true, minRem:PandaDEX.plain(PandaMaker.minRemainderFor(a.slot)), orderId:createOid};
      PandaTxn.create(PDService.cmd, PDService.identity, input, function(error, tx, orderId) {
        if (error) { PDService.makerSetStage("Maker: CREATE failed — " + error); return PDService.makerRun(actions, idx + 1, mid, posted, chainBlock, guard); }
        PDService.makerRemember(a.slot, orderId, chainBlock);
        PDService.addPending(PandaPending.PLACE, {orderId:orderId, buy:!a.slot.sell, minima:input.minima, price:input.price});
        PDService.tell("POSTED", {message:"Maker rung submitted — it appears after confirmation", tx:tx});
        PDService.makerRun(actions, idx + 1, mid, posted + 1, chainBlock, guard);
      });
    });
  }
  if (a.kind === PandaMaker.K_RELOCK) {
    o = a.order;
    /* 0.4.26: a V5 coin can only be relocked AT V5 (the owner branch keeps @ADDRESS), where a partial filler can still
       freeze its remainder. Cancel it instead; the ladder re-places the rung next pass, at V6. */
    if (!PDService.onV6(o)) { actions[idx] = {kind:PandaMaker.K_CANCEL, order:o, slot:a.slot}; return PDService.makerRun(actions, idx, mid, posted, chainBlock, guard); }
    newWant = o.sell ? PandaDEX.up(PDService.dec(o.locked).mul(a.slot.price), PandaDEX.DP) : PandaDEX.down(PDService.dec(o.locked).div(a.slot.price), PandaDEX.DP);
    return PandaTxn.relock(PDService.cmd, o, newWant, function(error, tx) {
      if (error) { PDService.makerSetStage("Maker: RELOCK failed — " + error); return PDService.makerRun(actions, idx + 1, mid, posted, chainBlock, guard); }
      if (PDService.maker.cfg.slots[a.slot.id]) PDService.maker.cfg.slots[a.slot.id].lastActionBlock = chainBlock;
      PDService.saveMaker(); PDService.addPending(PandaPending.EDIT, {orderId:o.orderId, coinid:o.coinid, buy:!o.sell, minima:PandaDEX.plain(o.minima), price:PandaDEX.plain(a.slot.price)});
      PDService.tell("POSTED", {message:"Maker rung reprice submitted — mining now", tx:tx});
      PDService.makerRun(actions, idx + 1, mid, posted + 1, chainBlock, guard);
    });
  }
  if (a.kind === PandaMaker.K_CANCEL) {
    PDService.noteCancelled(a.order.coinid);
    PDService.noteCancelled(a.order.coinid);
    return PandaTxn.cancel(PDService.cmd, a.order, function(error, tx) {
      if (error) { PDService.makerSetStage("Maker: CANCEL failed — " + error); return PDService.makerRun(actions, idx + 1, mid, posted, chainBlock, guard); }
      PDService.makerForgetByOrderId(a.order.orderId); PDService.makerTombstone(a.order.orderId, chainBlock, chainBlock);
      PDService.addPending(PandaPending.CANCEL, {orderId:a.order.orderId, coinid:a.order.coinid, buy:!a.order.sell, minima:PandaDEX.plain(a.order.minima), price:PandaDEX.plain(a.order.price)});
      PDService.tell("POSTED", {message:"Maker rung cancellation submitted — mining now", tx:tx});
      PDService.makerRun(actions, idx + 1, mid, posted + 1, chainBlock, guard);
    });
  }
  PDService.makerRun(actions, idx + 1, mid, posted, chainBlock, guard);
};
PDService.makerOnBook = function() {
  var c = PDService.maker.cfg, now = Date.now(), mid, desired, byOrderId, liveBySlot = {}, settling = {}, partial = {}, renew = {}, postedSizes = {}, dirty = false, k, r, o, complete, actions, ids;
  /* Must also stand down for the order processor: it renews GTC orders on these same blocks, and
     two engines building transactions at once is the concurrent-signing hazard signlock.js exists
     for. The gate would serialise them anyway; skipping here avoids the redundant work entirely. */
  if (!c || PDService.busy || PDService.maker.working || PDService.processor.working) return;
  if (!PDService.keysUsable()) return;   /* a blind key set cannot tell its own rungs from a stranger's */
  PDService.makerSweepTombstones();
  if (PDService.maker.working) return;
  if (!c.armed) return;
  /* C-3: while orders of another key mode are live, place nothing new - and do not leave the ladder frozen at a stale
     mid (no reprice, no stale-feed withdraw): stand it down. It is re-placed once the pause clears. */
  if (PDService.orphans.length) { if (PDService.maker.cfg && !PDService.emptyMap(PDService.maker.cfg.slots || {})) { PDService.setStage("Paused (orders of another key mode are live) — withdrawing the ladder"); PDService.makerWithdrawAll(false); } return; }
  if (now - PDService.maker.lastCycleMs < PDService.MAKER_MIN_CYCLE_MS) return;
  if (c.pegged && (!PDService.dec(c.stepPct).gt(0) || (!PandaMaker.hasSizedRung(PDService.makerLadderConfig().asks) && !PandaMaker.hasSizedRung(PDService.makerLadderConfig().bids)))) return;
  if (c.pegged) {
    PandaPrice.refreshAsync();
    if (PandaPrice.mustWithdraw()) {
      if (PDService.hasMakerSlots()) { PDService.setStage("Price feed stale — withdrawing the ladder"); PDService.makerWithdrawAll(false); }
      return;
    }
  }
  mid = c.pegged ? PDService.makerMid() : PDService.dec(c.manualMid);
  desired = PDService.makerDesired();
  byOrderId = PDService.makerLiveById(false);
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) {
    r = c.slots[k];
    if (!r.sentBlock || r.sentBlock <= 0) { r.sentBlock = PDService.block; dirty = true; continue; }
    if (!byOrderId[r.orderId] && PDService.block - Number(r.sentBlock || 0) >= PDService.MAKER_PATIENCE_BLOCKS) { delete c.slots[k]; dirty = true; }
  }
  if (dirty) PDService.saveMaker();
  if (!desired.length) return;
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) {
    r = c.slots[k]; o = byOrderId[r.orderId];
    if (!o) settling[k] = true;
    else {
      liveBySlot[k] = o;
      if (r.lastActionBlock && PDService.block - Number(r.lastActionBlock) < PDService.MAKER_PATIENCE_BLOCKS) settling[k] = true;
      postedSizes[k] = PDService.dec(r.size);
      if (PandaMaker.preserve(r, o)) partial[o.coinid] = true;
      if (o.gtc && PDService.block - Number(o.created || 0) >= PandaDEX.RENEW_AT) renew[k] = true;
    }
  }
  complete = true;
  for (k in settling) if (settling.hasOwnProperty(k)) complete = false;
  ids = c.tombstones; for (k in ids) if (ids.hasOwnProperty(k)) complete = false;
  for (k = 0; k < desired.length; k++) if (!liveBySlot[desired[k].id]) complete = false;
  if (c.pegged && complete && !PandaMaker.worthRepricing(c.lastActedMid, mid, c.repricePct)) return;
  actions = PandaMaker.reconcile(desired, liveBySlot, settling, renew, c.pegged ? PDService.dec(c.repricePct) : PandaDEX.d(0), partial, postedSizes, PandaMaker.budget(PDService.MAKER_MAX_ACTIONS, PDService.MAKER_MAX_CREATES_SIDE));
  if (!actions.length) return;
  PDService.maker.lastCycleMs = now;
  PDService.makerSetStage("Maker: " + actions.length + " adjustment" + (actions.length === 1 ? "" : "s") + (PDService.dec(mid).gt(0) ? " at mid " + PDService.dec(mid).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6) : ""));
  PDService.maker.guardStopped = false;
  PDService.makerRun(actions, 0, mid, 0, PDService.block, PandaMaker.guard(PDService.makerLadderConfig(), c.quoteRevision || "0", mid, c.pegged ? String(PandaPrice.widenFactor()) : "1"));
};
PDService.makerSweepTombstones = function() {
  var c = PDService.maker.cfg, mineById, done = [], target = null, k, t, o;
  if (!c || PDService.busy || PDService.maker.working || PDService.processor.working) return;
  mineById = PDService.makerLiveById(true);
  for (k in c.tombstones) if (c.tombstones.hasOwnProperty(k)) {
    t = c.tombstones[k]; o = mineById[k];
    if (!o) { if (PDService.block - Number(t.createdBlock || 0) >= PDService.MAKER_TOMBSTONE_BLOCKS) done.push(k); }
    else if (!target && (!t.lastAttemptBlock || PDService.block - Number(t.lastAttemptBlock || 0) >= PDService.MAKER_PATIENCE_BLOCKS)) target = o;
  }
  for (k = 0; k < done.length; k++) delete c.tombstones[done[k]];
  if (done.length) PDService.saveMaker();
  if (!target) return;
  PDService.makerTombstone(target.orderId, PDService.block, PDService.block);
  PDService.maker.working = true; PDService.makerSetStage("Maker: cancelling a late order");
  PDService.noteCancelled(target.coinid);
  PandaTxn.cancel(PDService.cmd, target, function(error, tx) {
    PDService.maker.working = false;
    if (!error) {
      PDService.addPending(PandaPending.CANCEL, {orderId:target.orderId, coinid:target.coinid, buy:!target.sell, minima:PandaDEX.plain(target.minima), price:PandaDEX.plain(target.price)});
      PDService.tell("POSTED", {message:"Late maker order cancellation submitted", tx:tx});
    }
    PDService.snapshot();
  });
};
PDService.hasMakerSlots = function() {
  var c = PDService.maker.cfg, k;
  if (!c) return false;
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) return true;
  for (k in c.tombstones) if (c.tombstones.hasOwnProperty(k)) return true;
  return false;
};
PDService.makerCancelChunks = function(live, idx) {
  var chunk = live.slice(idx, idx + PandaDEX.MAX_ORDERS);
  if (!chunk.length) { PDService.maker.working = false; PDService.setStage("Maker withdraw submitted — orders leave as blocks confirm"); return PDService.refresh(); }
  for (var ci = 0; ci < chunk.length; ci++) PDService.noteCancelled(chunk[ci].coinid);
  PandaTxn.cancelBatch(PDService.cmd, chunk, function(error, tx) {
    var i;
    if (error) { for (i = 0; i < chunk.length; i++) PDService.makerTombstone(chunk[i].orderId, PDService.block, 0); PDService.tell("ERROR", {message:error}); }
    else {
      for (i = 0; i < chunk.length; i++) {
        PDService.makerTombstone(chunk[i].orderId, PDService.block, PDService.block);
        PDService.addPending(PandaPending.CANCEL, {orderId:chunk[i].orderId, coinid:chunk[i].coinid, buy:!chunk[i].sell, minima:PandaDEX.plain(chunk[i].minima), price:PandaDEX.plain(chunk[i].price)});
      }
      PDService.tell("POSTED", {message:"Maker withdraw batch submitted", tx:tx});
    }
    PDService.makerCancelChunks(live, idx + chunk.length);
  });
};
PDService.makerWithdrawAll = function(disarm) {
  var c = PDService.maker.cfg, byId = PDService.makerLiveById(true), live = [], k, r;
  if (!c) return;
  if (disarm) c.armed = false;
  for (k in c.slots) if (c.slots.hasOwnProperty(k)) {
    r = c.slots[k];
    if (byId[r.orderId]) live.push(byId[r.orderId]);
    else PDService.makerTombstone(r.orderId, PDService.block, 0);
  }
  c.slots = {}; PDService.saveMaker();
  if (!live.length) { PDService.setStage("Maker: no visible ladder orders to cancel"); return PDService.snapshot(); }
  PDService.maker.working = true; PDService.setStage("Maker: withdrawing " + live.length + " visible order" + (live.length === 1 ? "" : "s"));
  PDService.makerCancelChunks(live, 0);
};
PDService.makerWithdraw = function() { PDService.makerWithdrawAll(true); };
PDService.cancelAllRun = function(list, idx, ok, failed) {
  var chunk, i, rows = [];
  if (idx >= list.length) {
    PDService.setBusy(false);
    PDService.setStage(failed === 0 ? "Cancel sent for " + ok + " order" + (ok === 1 ? "" : "s") + " — each leaves the book when a block confirms it" : "Cancel sent for " + ok + "; " + failed + " could not be cancelled — check your open orders");
    return PDService.refresh();
  }
  chunk = list.slice(idx, idx + PandaDEX.MAX_ORDERS);
  PDService.setBusy(true);
  PDService.setStage("Cancelling " + Math.min(idx + chunk.length, list.length) + " of " + list.length + "…");
  for (var ci = 0; ci < chunk.length; ci++) PDService.noteCancelled(chunk[ci].coinid);
  PandaTxn.cancelBatch(PDService.cmd, chunk, function(error, tx) {
    if (error) {
      PDService.tell("ERROR", {message:"Cancel batch failed — " + error});
      return PDService.cancelAllRun(list, idx + chunk.length, ok, failed + chunk.length);
    }
    for (i = 0; i < chunk.length; i++) {
      rows.push({kind:PandaPending.CANCEL, orderId:chunk[i].orderId, coinid:chunk[i].coinid, buy:!chunk[i].sell, minima:PandaDEX.plain(chunk[i].minima), price:PandaDEX.plain(chunk[i].price), submitMs:Date.now(), submitBlock:PDService.block});
    }
    PDService.addPendingRows(rows, function() {
      PDService.tell("POSTED", {message:"Cancel batch submitted", tx:tx});
      PDService.cancelAllRun(list, idx + chunk.length, ok + chunk.length, failed);
    });
  });
};
PDService.processorInit = function(done) {
  MDS.sql("CREATE TABLE IF NOT EXISTS `processor_inflight` (`coinid` varchar(160) PRIMARY KEY, `block` bigint)", function() { if (done) done(); });
};
PDService.processorMark = function(coinid) {
  MDS.sql("DELETE FROM `processor_inflight` WHERE `coinid`='" + PDService.escSql(coinid) + "'", function() {
    MDS.sql("INSERT INTO `processor_inflight` (`coinid`,`block`) VALUES ('" + PDService.escSql(coinid) + "'," + Number(PDService.block || 0) + ")", function(){});
  });
};
PDService.processorClear = function(coinid) { MDS.sql("DELETE FROM `processor_inflight` WHERE `coinid`='" + PDService.escSql(coinid) + "'", function(){}); };
PDService.processorProcess = function() {
  /* `working` is cleared only when a run completes normally, so a callback the node never delivers
     would wedge GTC renewal for the rest of the session — silently, which is the worst kind. Blocks
     are the only clock the service can trust here. */
  if (PDService.processor.working && PDService.block - PDService.processor.startedBlock > PDService.PROCESSOR_STUCK_BLOCKS) PDService.processor.working = false;
  if (PDService.processor.working || PDService.busy || PDService.maker.working || PDService.block <= 0) return;
  if (!PDService.keysUsable()) return;   /* never renew or collect against a key set we could not read */
  MDS.sql("SELECT `coinid`,`block` FROM `processor_inflight`", function(res) {
    var rows = res && res.rows || [], inflight = {}, present = {}, i, r, o, actions = [], mine, skip = PDService.makerOwnedIds();
    for (i = 0; i < rows.length; i++) {
      r = rows[i]; inflight[r.COINID || r.coinid] = Number(r.BLOCK || r.block || 0);
    }
    for (i = 0; i < PDService.book.length; i++) present[PDService.book[i].coinid] = true;
    for (r in inflight) if (inflight.hasOwnProperty(r)) {
      if (!present[r] || PDService.block - inflight[r] > 6) PDService.processorClear(r);
    }
    for (i = 0; i < PDService.book.length && actions.length < 2; i++) {
      o = PDService.book[i];
      if (!PDService.owns(o) || skip[o.orderId] || inflight[o.coinid] || PDService.pendingRefs[o.coinid]) continue;   /* a user request already in flight wins */
      if (o.gtc && PDService.block - Number(o.created || 0) >= PandaDEX.RENEW_AT && PDService.block - Number(o.created || 0) <= PandaDEX.EXPIRY) actions.push({kind:"renew", order:o});
      else if (PDService.block - Number(o.created || 0) > PandaDEX.EXPIRY) actions.push({kind:"collect", order:o});
    }
    if (!actions.length) return;
    PDService.processor.startedBlock = PDService.block;
    PDService.processorRun(actions, 0);
  });
};
PDService.processorRun = function(actions, idx) {
  var a;
  if (idx >= actions.length) { PDService.processor.working = false; return PDService.refresh(); }
  PDService.processor.working = true;
  a = actions[idx];
  PDService.processorMark(a.order.coinid);
  if (a.kind === "renew" && (!PDService.onV6(a.order) || a.order.fillable === false)) {
    /* 0.4.26: renewing a V5 order would keep it at V5 for good, freezable by any partial filler; an unfillable one would
       stay dead liquidity. Send it home instead (marked cancelled only once the cancel posted). */
    return PandaTxn.cancel(PDService.cmd, a.order, function(error, tx) {
      if (error) { PDService.processorClear(a.order.coinid); PDService.notify("Couldn't return an order to your wallet — will retry: " + error); }
      else {
        PDService.noteCancelled(a.order.coinid);
        PDService.addPending(PandaPending.CANCEL, {orderId:a.order.orderId, coinid:a.order.coinid, buy:!a.order.sell, minima:PandaDEX.plain(a.order.minima), price:PandaDEX.plain(a.order.price)});
        PDService.notify(a.order.fillable === false
          ? "An order that can no longer be filled was returned to your wallet instead of renewed. Place it again if you still want it."
          : "An order on the old order contract was returned to your wallet instead of renewed. Place it again: new orders use the protected contract.");
      }
      PDService.processorRun(actions, idx + 1);
    });
  }
  if (a.kind === "renew") {
    return PandaTxn.relock(PDService.cmd, a.order, null, function(error) {
      if (error) { PDService.processorClear(a.order.coinid); PDService.notify("Couldn't renew an order: order @ " + PandaDEX.plain(a.order.price) + " — will retry"); PDService.tell("ERROR", {message:"Renewal failed for order @ " + PandaDEX.plain(a.order.price) + " — will retry"}); }
      else PDService.addPending(PandaPending.EDIT, {orderId:a.order.orderId, coinid:a.order.coinid, buy:!a.order.sell, minima:PandaDEX.plain(a.order.minima), price:PandaDEX.plain(a.order.price)});
      PDService.processorRun(actions, idx + 1);
    });
  }
  PDService.noteCancelled(a.order.coinid);
  return PandaTxn.collectExpired(PDService.cmd, a.order, function(error) {
    if (error) PDService.processorClear(a.order.coinid);
    else {
      PDService.addPending(PandaPending.CANCEL, {orderId:a.order.orderId, coinid:a.order.coinid, buy:!a.order.sell, minima:PandaDEX.plain(a.order.minima), price:PandaDEX.plain(a.order.price)});
    }
    PDService.processorRun(actions, idx + 1);
  });
};
/* Ask the node whether every source coin is really gone. Unknown is NOT spent. */
PDService.allSourcesSpent = function(ids, idx, done) {
  var id;
  if (idx >= ids.length) return done(true);
  id = ids[idx];
  PDService.cmd("coins simplestate:true coinid:" + id, function(reply) {
    var present = PandaVerify.coinPresent(reply);
    if (present === null || present === true) return done(false);   /* unreadable or still there */
    PDService.allSourcesSpent(ids, idx + 1, done);
  });
};
PDService.proceedsArrived = function(done) {
  var m = PDService.fillMeta, tok, amount;
  if (!m || !PDService.identity) return done(false);
  tok = m.buy ? "0x00" : PandaDEX.USDT;                 /* a buy receives MINIMA, a sell MxUSD */
  /* m.proceeds is the exact output amount the transaction was built with. The fallback is only
     for a fill saved by a version before 0.4.19 and is the old, rounded guess. */
  amount = m.proceeds !== undefined && m.proceeds !== null && m.proceeds !== ""
    ? m.proceeds : m.buy ? m.size : PandaDEX.plain(PandaDEX.d(m.size).mul(m.price));
  PDService.cmd("coins simplestate:true address:" + PDService.identity.address + " tokenid:" + tok +
    " coinage:0 depth:" + Math.max(12, PDService.SWEEP_DEADLINE_BLOCKS + 6), function(reply) {
      done(PandaVerify.proceedsPresent(reply, tok, amount, Number(m.postBlock || 0)));
    });
};
/* The deadline above only fires while one of OUR coins is still visible. Once they are all gone
   but the proceeds do not verify, there was nothing left to time out — the trade sat "waiting for
   confirmation" forever and the user found out it had worked by looking at ASSETS. Our coins being
   spent means something happened; not matching the proceeds means we cannot prove what. So record
   it rather than erase it, but never claim a verification we do not have. */
PDService.giveUpOnFill = function() {
  if(!PDService.fillMeta)return;
  PDService.setStage("Submission is still unverified. Inputs remain reserved; check node history and proceeds before retrying.");
};
PDService.reconcileFill = function(book) {
  var i, j, coinid;
  if (!PDService.fillCoins || PDService.verifyingFill) return;
  for (i = 0; i < PDService.fillCoins.length; i++) {
    coinid = PDService.fillCoins[i];
    if (PDService.sourceStillLive(book, coinid)) {
      if (PDService.fillBlock > 0 && PDService.block - PDService.fillBlock > PDService.SWEEP_DEADLINE_BLOCKS && !PDService.restQueueCoins) {
        PDService.stage = "Confirmation is still unknown. Inputs remain reserved; check Activity before retrying.";
      }
      return;
    }
  }
  /* Gate 1 (nothing of ours is still visible) only says the local snapshot agrees. Prove it against
     the node before claiming LOCAL_VERIFIED: every source coin actually spent, and the proceeds we
     expected actually present at our address at or after the block we posted in. Until both hold we
     simply wait — the deadline above is what eventually gives up. */
  PDService.verifyingFill = true;
  PDService.allSourcesSpent(PDService.fillCoins.slice(), 0, function(spent) {
    /* NOT calling giveUpOnFill here: it says "your coins were spent", and in this branch the node
       says they were not. A local snapshot that has run ahead of the node resolves itself; if it
       does not, the sourceStillLive deadline above is what catches it. */
    if (!spent) { PDService.verifyingFill = false; return; }
    PDService.proceedsArrived(function(arrived) {
      PDService.verifyingFill = false;
      if (!arrived) return PDService.giveUpOnFill();
      PDService.fillCoins = null; PDService.fillBlock = 0; PDService.filling = {};
      PDService.recordFill();
      if (!PDService.restQueueCoins) PDService.setStage("\u2713 " + (PDService.lastFillLine || "Trade confirmed") + " \u2014 proceeds are confirming, see ASSETS");
    });
  });
};
PDService.restReady = function(book) {
  var i, coinid;
  if (!PDService.restQueueCoins) return false;
  for (i = 0; i < PDService.restQueueCoins.length; i++) {
    coinid = PDService.restQueueCoins[i];
    if (PDService.sourceStillLive(book, coinid)) {
      if (PDService.restQueueBlock > 0 && PDService.block - PDService.restQueueBlock > PDService.SWEEP_DEADLINE_BLOCKS) {
        /* The trade itself may well have landed — it is the REMAINDER that timed out. Record it
           before clearing, otherwise a posted, confirmed trade is erased and the user is told it
           never happened. */
        PDService.recordFill();
        PDService.restQueue = null; PDService.restQueueCoins = null; PDService.restQueueBlock = 0;
        PDService.fillCoins = null; PDService.fillBlock = 0; PDService.filling = {}; PDService.fillMeta = null;
        PDService.setStage("Your resting limit order was NOT placed — the trade did not confirm in time. Check ORDERS and your balance.");
      }
      return false;
    }
  }
  return true;
};
PDService.sourceStillLive = function(book, coinid) {
  var i, p;
  for (i = 0; i < (book || []).length; i++) if (book[i].coinid === coinid) return true;
  /* A composite fill also consumes pool reserve coins. Until those are gone too, the trade has
     not landed — resting the unfilled remainder early would double-spend the funding. */
  for (i = 0; i < (PDService.pools || []).length; i++) {
    p = PDService.pools[i];
    if (p.coinidM === coinid || p.coinidT === coinid) return true;
  }
  return false;
};
PDService.placeRest = function() {
  if (PDService.orphans.length) { PDService.restQueue = null; PDService.restQueueCoins = null; PDService.restQueueBlock = 0; return PDService.tell("ERROR", {message:PDService.orphanMessage()}); }
  var q = PDService.restQueue;
  PDService.restQueue = null; PDService.restQueueCoins = null; PDService.restQueueBlock = 0;
  if (!q) return;
  PDService.setStage("Placing the unfilled balance as a resting limit order");
  PDService.setBusy(true);
  PandaTxn.create(PDService.cmd, PDService.identity, q, function(error, tx, orderId) {
    PDService.setBusy(false);
    if (error) { PDService.setStage("Resting order failed — " + error); return PDService.tell("ERROR", {message:error}); }
    PDService.addPending(PandaPending.PLACE, {orderId:orderId, buy:!!q.buy, minima:q.minima, price:q.price});
    PDService.setStage("Resting limit order submitted — waiting for confirmation");
    PDService.tell("POSTED", {message:"Resting limit order submitted — it appears after confirmation (~50 seconds)", tx:tx});
    PDService.refresh();
  });
};
PDService.refresh = function() {
  /* A NEWBLOCK arriving mid-scan used to be dropped outright. That matters more now that the
     signing gate can defer a maker or processor action to "next refresh" — a dropped block could
     mean the deferred work waits for a block that already came. Remember it and re-enter instead.
     The scan itself stays single-flight; only the request is coalesced. */
  if (PDService.scanning) { PDService.rescan = true; return; }
  PDService.scanning = true;
  PDService.rescan = false;
  PandaPrice.refreshAsync();
  PandaBook.scan(PDService.cmd, function(book, incomplete) {
    var resolved, i, msg, changed, visibleBook;
    PDService.scanning = false;
    if (incomplete) PDService.tell("ERROR", {message:"Part of the order book could not be read" + (PDService.book.length ? " — keeping the last good book" : "")});
    visibleBook = incomplete && PDService.book.length ? PDService.book : book;
    if (PDService.diff) PandaTape.ingest(PDService.diff, visibleBook, incomplete, PDService.block,
      {onFill:PDService.recordObservedFill, onVanish:PDService.queueVanish});
    PDService.settleVanished();
    PDService.book = visibleBook;
    PDService.checkOrphans();
    if (!incomplete) {
      resolved = PandaPending.resolve(PDService.pendingRows, visibleBook, Date.now());
      changed = resolved.events.length || resolved.rows.length !== PDService.pendingRows.length;
      PDService.pendingRows = resolved.rows; PDService.pendingRefs = resolved.refs;
      for (i = 0; i < resolved.events.length; i++) {
        msg = PDService.pendingMessage(resolved.events[i].type, resolved.events[i].row);
        if (msg) PDService.stage = msg;
        PDService.notifyPending(resolved.events[i]);
      }
      if (changed) PDService.savePending();
    }
    /* The signing gate has no timers — the service scope has none. This is what keeps its
       heartbeat alive, retries a contended claim, and force-releases a lost callback. */
    PandaSignLock.tick();
    PDService.releaseStuckBusy();
    PDService.retryKeysIfStale();
    PDService.refreshPools();
    PDService.reconcileFill(visibleBook);
    PDService.makerOnBook();
    PDService.processorProcess();
    PDService.snapshot();
    if (PDService.restReady(visibleBook)) PDService.placeRest();
    if (PDService.rescan) PDService.refresh();
  });
};
/* Review 7 Nov (C-3, owner decision: block). PandaBear (legacy keys) and BlackBear (block-as-key-uses) derive DIFFERENT
   keys from one seed. Orders placed under one mode stay live after a switch: this wallet can no longer cancel, relock or
   renew them, and every fill (and the expiry sweep) pays the OLD mode's address. The service remembers every identity it
   has run under; while any of their orders is live but its key is not in this wallet, new trading is refused and the user
   is told to switch back and cancel them. */
PDService.orphans = [];
PDService.knownIdentities = {};
PDService.rememberIdentity = function(pk) {
  if (!PandaSafety.hex(pk)) return;
  PDService.knownIdentities[String(pk).toUpperCase()] = true;
  MDS.sql("CREATE TABLE IF NOT EXISTS `my_identities` (`publickey` varchar(160) primary key)", function() {
    MDS.sql("MERGE INTO `my_identities` (`publickey`) KEY (`publickey`) VALUES ('" + String(pk).toUpperCase() + "')", function() {
      MDS.sql("SELECT `publickey` FROM `my_identities`", function(r) {
        var rows = (r && r.rows) || [], i;
        for (i = 0; i < rows.length; i++) if (rows[i] && PandaSafety.hex(rows[i].PUBLICKEY)) PDService.knownIdentities[String(rows[i].PUBLICKEY).toUpperCase()] = true;
        PDService.checkOrphans();
      });
    });
  });
};
/* Only orders THIS service placed count (their orderId, port 4, is recorded at placement and survives relocks): an
   order planted by anyone else with an old public key of mine (public on chain) must not be able to freeze my trading. */
PDService.myOrderIds = {};
PDService.rememberOrder = function(orderId) {
  if (!PandaSafety.hex(orderId)) return;
  var id = String(orderId).toUpperCase();
  PDService.myOrderIds[id] = true;
  MDS.sql("CREATE TABLE IF NOT EXISTS `my_orders` (`orderid` varchar(160) primary key)", function() {
    MDS.sql("MERGE INTO `my_orders` (`orderid`) KEY (`orderid`) VALUES ('" + id + "')", function() {});
  });
};
PDService.loadMyOrders = function() {
  MDS.sql("CREATE TABLE IF NOT EXISTS `my_orders` (`orderid` varchar(160) primary key)", function() {
    MDS.sql("SELECT `orderid` FROM `my_orders`", function(r) {
      var rows = (r && r.rows) || [], i;
      for (i = 0; i < rows.length; i++) if (rows[i] && PandaSafety.hex(rows[i].ORDERID)) PDService.myOrderIds[String(rows[i].ORDERID).toUpperCase()] = true;
      PDService.checkOrphans();
    });
  });
};
/* Coins this service has itself SEEN as its own (key and payout address in the wallet) - recorded while that key was
   still here. Only those can be orphans: an orderId and an old public key are both public on chain, so a planted coin
   copying them is never in this set. (A remainder created by a partial fill AFTER the switch is not recorded either -
   that fails open.) */
PDService.myCoins = {};
PDService.rememberCoin = function(coinid) {
  if (!PandaSafety.hex(coinid)) return;
  var id = String(coinid).toUpperCase();
  if (PDService.myCoins[id]) return;
  PDService.myCoins[id] = true;
  MDS.sql("CREATE TABLE IF NOT EXISTS `my_coins` (`coinid` varchar(160) primary key)", function() {
    MDS.sql("MERGE INTO `my_coins` (`coinid`) KEY (`coinid`) VALUES ('" + id + "')", function() {});
  });
};
PDService.loadMyCoins = function() {
  MDS.sql("CREATE TABLE IF NOT EXISTS `my_coins` (`coinid` varchar(160) primary key)", function() {
    MDS.sql("SELECT `coinid` FROM `my_coins`", function(r) {
      var rows = (r && r.rows) || [], i;
      for (i = 0; i < rows.length; i++) if (rows[i] && PandaSafety.hex(rows[i].COINID)) PDService.myCoins[String(rows[i].COINID).toUpperCase()] = true;
      PDService.checkOrphans();
    });
  });
};
PDService.checkOrphans = function() {
  var out = [], i, o, pk;
  if (!PDService.keysUsable()) return;   /* a blind key set would flag our own orders */
  for (i = 0; i < PDService.book.length; i++) {
    o = PDService.book[i];
    if (PDService.owns(o)) PDService.rememberCoin(o.coinid);
    pk = String((o && o.ownerPk) || "").toUpperCase();
    if (pk && PDService.knownIdentities[pk] && PDService.myOrderIds[String((o && o.orderId) || "").toUpperCase()]
        && PDService.myCoins[String((o && o.coinid) || "").toUpperCase()]
        && !PDService.keyset[o.ownerPk] && !PDService.keyset[pk]) out.push(o);
  }
  if (out.length && !PDService.orphans.length) PDService.notify(PDService.orphanMessage(out.length));
  PDService.orphans = out;
};
PDService.orphanMessage = function(n) {
  n = n || PDService.orphans.length;
  return n + " of your resting order" + (n === 1 ? " was" : "s were") + " placed under another key mode (PandaBear vs BlackBear) and " + (n === 1 ? "is" : "are")
    + " still live. This wallet cannot cancel " + (n === 1 ? "it" : "them") + ", and any fill pays the old mode's address. Switch your node back to that mode, cancel "
    + (n === 1 ? "it" : "them") + ", then switch again. New orders are paused until then.";
};
PDService.onV6 = function(o) { return !!o && String(o.addr || '').toUpperCase() === PandaDEX.ADDR.toUpperCase(); };
PDService.scriptArg = function(script) { return '"' + (script || PandaDEX.script).replace(/"/g, '\\"') + '"'; };
/* NEVER SHRINK ON FAILURE. The old version emptied both sets before querying, so a node that
   failed to answer `keys action:list` left the service owning nothing — and owns() returning false
   for the user's own orders is not a display bug: the maker cannot see its own rungs, decides they
   are missing, and posts the whole ladder a second time. Build into local maps and full-replace
   each half only when the node actually answered. Only a complete key and derived-address load becomes fresh. A failed load
   retains the last complete ownership snapshot for display. Retries ride the block clock; this service runs no timers. */
PDService.KEY_RETRY_BLOCKS = 4;
PDService.loadKeys = function(done) {
  var load={}, keys={}, addrs={}, list=[];
  PDService.keyLoad=load; PDService.keysReady=false;
  function current(){return PDService.keyLoad===load;}
  function finish(ok){if(!current())return;PDService.keyLoad=null;PDService.keysRetryBlock=PDService.block;
    if(ok){PDService.keyset=keys;PDService.addrset=addrs;PDService.keysReady=true;}if(done)done();}
  PDService.cmd("keys action:list", function(result) {
    if(!current())return;
    var rows=result&&result.response,i,key;
    if(rows&&!Array.isArray(rows))rows=rows.keys;
    if(!PandaSafety.truthy(result&&result.status)||!Array.isArray(rows)||!rows.length)return finish(false);
    for(i=0;i<rows.length;i++){
      key=typeof rows[i]==="string"?rows[i]:rows[i]&&rows[i].publickey;
      if(!PandaSafety.hex(key))return finish(false);
      if(!keys[key]){keys[key]=true;list.push(key);}
    }
    function derive(index){
      if(!current())return;
      if(index===list.length){
        if(PDService.identity&&keys[PDService.identity.publickey]&&PandaSafety.hex(PDService.identity.address))addrs[PDService.identity.address]=true;
        return finish(true);
      }
      PDService.cmd("runscript script:"+JSON.stringify("RETURN SIGNEDBY("+list[index]+")"),function(reply){
        if(!current())return;
        var response=reply&&reply.response,address=response&&response.script&&response.script.address;
        if(!PandaSafety.truthy(reply&&reply.status)||!PandaSafety.truthy(response&&response.parseok)||!PandaSafety.hex(address))return finish(false);
        addrs[address]=true;derive(index+1);
      });
    }
    derive(0);
  });
};
/* True once the node has actually listed the wallet's keys. Until then every ownership answer is
   a guess, and acting on a guess means duplicate ladders and renewals of orders we do not own. */
PDService.keysUsable = function() { return PDService.keysReady === true; };
PDService.retryKeysIfStale = function() {
  if (PDService.keysUsable() || PDService.block <= 0) return;
  if (PDService.block - Number(PDService.keysRetryBlock || 0) < PDService.KEY_RETRY_BLOCKS) return;
  PDService.keysRetryBlock = PDService.block;
  PDService.loadKeys(function() {});
};
PDService.boot = function() {
  /* Give the signing gate its durable layer. Without this it still serialises correctly inside
     this context; with it, a lock survives a service restart mid-chain and frees itself by TTL. */
  /* The signing gate is a plain in-process queue now — nothing to inject, and deliberately so:
     holding MDS.sql by reference detached a Java method and broke every signing path. */
  /* Let the transaction layer narrate. Without this the UI shows one line for the whole chain. */
  PandaTxn.stage = function(message) { PDService.setStage(message); };
  /* And let it refuse an owner key this wallet does not hold, rather than sending it to the node
     and surfacing "Public Key not found". Only meaningful once the key set is actually readable. */
  PandaTxn.holdsKey = function(publickey) { return PDService.keysUsable() && !!PDService.keyset[publickey]; };
  PDService.cmd("runscript script:" + PDService.scriptArg(), function(scriptResult) {
    var script = scriptResult && scriptResult.response && scriptResult.response.script;
    if (!scriptResult.status || !scriptResult.response.parseok || !script || String(script.address).toUpperCase() !== PandaDEX.ADDR.toUpperCase())
      return PDService.tell("ERROR", {message:"PandaDEX order covenant mismatch; trading disabled"});
    PDService.cmd("newscript trackall:false script:" + PDService.scriptArg(), function(registerResult) {
      if (!registerResult.status) return PDService.tell("ERROR", {message:registerResult.error || "Could not register covenant"});
      /* V5 too: its coins (old orders) are still filled, cancelled, relocked and collected at their own address. */
      PDService.cmd("newscript trackall:false script:" + PDService.scriptArg(PandaDEX.SCRIPT_V5), function(v5Result) {
      if (!v5Result.status) return PDService.tell("ERROR", {message:v5Result.error || "Could not register the V5 covenant"});
      PDService.cmd("getaddress", function(addressResult) {
        if (!addressResult.status) return PDService.tell("ERROR", {message:addressResult.error || "Could not read wallet identity"});
        PDService.identity = {address:addressResult.response.address, publickey:addressResult.response.publickey, miniaddress:addressResult.response.miniaddress};
        PDService.rememberIdentity(PDService.identity.publickey);
        PDService.loadMyOrders();
        PDService.loadMyCoins();
        PDService.loadKeys(function() {
        PandaTape.init(function(ok) {
    if(ok===false){PDService.tell("ERROR",{message:"Trade history storage could not be opened. Existing data is retained; retry when storage is available."});return;}
          /* Load the persisted cancel log alongside boot — it only has to be present before the
             first fill adjudication, which is a refresh away. No extra nesting. */
          PDService.cancelInit(function() {});
          PDService.loadFill(function() {});
          PDService.diff = PandaTape.newDiff({consume:function(coinid){ return !!PDService.cancelled[coinid]; }});
          PDService.processorInit(function() {
            PDService.pendingInit(function() {
              PDService.loadMaker(function() {
                PDService.loadTape(function() {
                  PDService.ready = true;
                  PDService.cmd("block", function(blockResult) { var tip=PandaSafety.tipBlock(blockResult); if(tip>0) { PDService.block=tip; PDService.refresh(); } });
                });
              });
            });
          });
        });
        });
      });
    });
        });
    });
};
/* Any throw inside a node callback propagates into Java and disappears — the chain stops, `busy`
   stays set and the banner freezes with no error. That is precisely how a trade "stalls". Every
   user action is wrapped so a defect reports itself instead of hanging the app. */
PDService.action = function(message) {
  try { PDService.actionInner(message); }
  catch (error) {
    PDService.notifyLog("action failed: " + error);
    PDService.setBusy(false);
    PDService.setStage("That action could not be completed — " + (error && error.message ? error.message : error));
    PDService.tell("ERROR", {message:"That action could not be completed — " + (error && error.message ? error.message : error) + " (nothing was sent)"});
  }
};
PDService.actionInner = function(message) {
  var i, order = null, plan, comp, rest, data, amountD, priceD, limitD, minRemD;
  if (message.type === "REFRESH") { if (!PDService.ready) { PDService.snapshot(); return; } return PDService.refresh(); }
  if (!PDService.ready) { PDService.setStage("PandaDEX is still starting…"); return; }
  /* Deliberately does NOT refuse while the maker or processor is working. Those are background
     engines that run every block; rejecting a user's cancel because the ladder happened to be
     mid-cycle would be a worse app. signlock.js serialises the actual signing, so a user action
     that lands mid-cycle now queues behind it instead of signing alongside it. `busy` still gates,
     because that one means THIS user already has a transaction in flight. */
  if (PDService.busy) return PDService.tell("ERROR", {message:"A transaction is already in flight"});
  /* C-3: orders created under another key mode are live - placing more would only widen the exposure. Cancels,
     edits of this mode's orders and refresh stay allowed. */
  if (PDService.orphans.length && (message.type === "LIMIT" || message.type === "SPLIT" || message.type === "MAKER_PUBLISH" || message.type === "MAKER_APPLY"))
    return PDService.tell("ERROR", {message:PDService.orphanMessage()});
  if (message.type === "SPLIT") {
    data = message.data || {};
    if (!PDService.identity || !PDService.identity.address) return PDService.tell("ERROR", {message:"Still reading your wallet identity — try again in a moment"});
    amountD = PDService.maybeDec(data.amount);
    if (!amountD || !amountD.gt(0)) return PDService.tell("ERROR", {message:"Enter an amount to split"});
    PDService.setBusy(true); PDService.setStage("Splitting funding coins…");
    return PandaSplit.run(PDService.cmd, PDService.identity.address, data.tokenid || "0x00", amountD, function(error, tx) {
      PDService.setBusy(false);
      if (error) { PDService.setStage("Split failed — " + error); return PDService.tell("ERROR", {message:error}); }
      PDService.setStage("Split posted — wait for the next block, then publish the ladder");
      PDService.tell("POSTED", {message:PandaSplit.COUNT + " funding coins requested — wait for a block, then publish", tx:tx});
      PDService.refresh();
    });
  }
  if (message.type === "LIMIT") {
    data = message.data || {};
    amountD = PDService.maybeDec(data.minima); priceD = PDService.maybeDec(data.price); minRemD = PDService.dec(data.minRem);
    if (!amountD || !amountD.gt(0)) return PDService.tell("ERROR", {message:"Enter a valid MINIMA amount"});
    if (!priceD || !priceD.gt(0)) return PDService.tell("ERROR", {message:"Enter a valid price"});
    amountD = PandaDEX.down(amountD, PandaDEX.DP); minRemD = Decimal.max(PandaDEX.d(0), PandaDEX.down(minRemD, PandaDEX.DP));
    data.minima = PandaDEX.plain(amountD); data.price = PandaDEX.plain(priceD); data.minRem = PandaDEX.plain(minRemD);
    /* Re-read the pools before planning. PDService.pools is up to a block old and refreshPools
       keeps the previous snapshot when a scan fails, so a reserve coin somebody else already spent
       stays in our plan — the transaction then names a spent input and is rejected with
       mmrproofs:false, which is exactly the kind of failure that reported nothing useful. Costs a
       few node calls on a user action only. */
    PDService.setStage("Checking pool liquidity\u2026");
    return PDService.refreshPools(function() { PDService.limitWithPools(data); });
  }
  return PDService.actionRest(message);
};
PDService.limitWithPools = function(data) {
  try { PDService.limitWithPoolsInner(data); }
  catch (error) {
    PDService.notifyLog("limit planning failed: " + error);
    PDService.setBusy(false);
    PDService.setStage("Could not plan the trade — " + (error && error.message ? error.message : error));
    PDService.tell("ERROR", {message:"Could not plan the trade — " + (error && error.message ? error.message : error) + " (nothing was sent)"});
  }
};
PDService.limitWithPoolsInner = function(data) {
  /* data.minima was already validated and normalised by the LIMIT handler before the pool refresh;
     re-derive it here because this no longer shares a scope with it. */
  var i, plan, comp, rest, amountD = PandaDEX.d(data.minima);
  {
    comp = PandaComposite.plan(PDService.book, PDService.pools, !!data.buy, data.minima, data.price || null, PDService.block);
    if (!PandaComposite.isEmpty(comp) && PandaComposite.poolCount(comp) > 0) {
      PDService.filling = {};
      for (i = 0; i < comp.sourceCoinIds.length; i++) PDService.filling[comp.sourceCoinIds[i]] = true;
      rest = amountD.sub(comp.totalMinima);
      PDService.setBusy(true); PDService.setStage("Building blended transaction… selecting coins and signing");
      return PandaTxn.fillComposite(PDService.cmd, PDService.identity, comp, !!data.buy, function(error, tx) {
        PDService.setBusy(false);
        if (error) { PDService.filling = {}; PDService.setStage("Trade failed — " + error); return PDService.tell("ERROR", {message:error}); }
        PDService.setStage("Posted — waiting for a block to confirm your " + (data.buy ? "buy" : "sell") + " of " + PandaDEX.plain(comp.totalMinima) + " MINIMA");
        PDService.tell("POSTED", {message:"Blended trade submitted — waiting for confirmation", tx:tx});
        /* The remainder only rests once every source coin has actually left the chain. Posting it
           earlier would spend funding the blended transaction is still relying on. */
        if (rest.gt(0)) {
          PDService.restQueue = {buy:!!data.buy, minima:PandaDEX.plain(rest), price:data.price, gtc:data.gtc, minRem:data.minRem};
          PDService.restQueueCoins = comp.sourceCoinIds.slice();
          PDService.restQueueBlock = PDService.block;
        }
        PDService.fillCoins = comp.sourceCoinIds.slice();
        PDService.fillBlock = PDService.block;
        PDService.fillMeta = {spentcoin:comp.sourceCoinIds[0], price:PandaDEX.plain(comp.effectivePrice),
          size:PandaDEX.plain(comp.totalMinima), buy:!!data.buy, txpowid:tx || "",
          /* The ONE proceeds output this transaction pays us (buildCompositeSteps). Not
             size x effectivePrice: that price is totalUsdt/totalMinima ROUNDED, so multiplying
             it back does not return totalUsdt and the coin never matched. */
          proceeds:PandaDEX.plain(data.buy ? comp.totalMinima : comp.totalUsdt),
          postBlock:PDService.block,
          sourceKind:(PandaComposite.poolCount(comp) > 0 && comp.orderTakes.length) ? "BOOK+POOL" : (PandaComposite.poolCount(comp) > 0 ? "POOL" : "BOOK"),
          sourceCoinids:comp.sourceCoinIds.slice()}; PDService.saveFill();
        PDService.refresh();
      });
    }
    plan = PandaBook.plan(PDService.book, !!data.buy, data.minima, data.price || null, PDService.block);
    if (!plan || !plan.takes || !plan.takes.length) {
      PDService.setBusy(true); PDService.setStage("Building transaction… selecting coins and signing");
      return PandaTxn.create(PDService.cmd, PDService.identity, data, function(error, tx, orderId) {
        PDService.setBusy(false);
        if (error) { PDService.setStage("Order failed — " + error); return PDService.tell("ERROR", {message:error}); }
        PDService.addPending(PandaPending.PLACE, {orderId:orderId, buy:!!data.buy, minima:data.minima, price:data.price});
        PDService.setStage("Order submitted — waiting for confirmation");
        PDService.tell("POSTED", {message:"Order submitted — it appears after confirmation (~50 seconds)", tx:tx}); PDService.refresh();
      });
    }
    PDService.filling = {};
    for (i = 0; i < plan.takes.length; i++) PDService.filling[plan.takes[i].order.coinid] = true;
    rest = PDService.dec(data.minima).sub(plan.totalMinima);
    PDService.setBusy(true); PDService.setStage("Building transaction… selecting coins and signing");
    return PandaTxn.fill(PDService.cmd, PDService.identity, plan, function(error, tx) {
      PDService.setBusy(false);
      if (error) { PDService.filling = {}; PDService.setStage("Trade failed — " + error); return PDService.tell("ERROR", {message:error}); }
      PDService.setStage("Posted — waiting for a block to confirm your " + (data.buy ? "buy" : "sell") + " of " + PandaDEX.plain(plan.totalMinima) + " MINIMA");
      PDService.tell("POSTED", {message:"Trade submitted — waiting for confirmation", tx:tx});
      if (rest.gt(0)) {
        PDService.restQueue = {buy:!!data.buy, minima:PandaDEX.plain(rest), price:data.price, gtc:data.gtc, minRem:data.minRem};
        PDService.restQueueCoins = [];
        for (i = 0; i < plan.takes.length; i++) PDService.restQueueCoins.push(plan.takes[i].order.coinid);
        PDService.restQueueBlock = PDService.block;
      }
      PDService.fillCoins = [];
      for (i = 0; i < plan.takes.length; i++) PDService.fillCoins.push(plan.takes[i].order.coinid);
      PDService.fillBlock = PDService.block;
      PDService.fillMeta = {spentcoin:plan.takes[0].order.coinid, price:PandaDEX.plain(plan.average),
        size:PandaDEX.plain(plan.totalMinima), buy:!!data.buy, txpowid:tx || "", postBlock:PDService.block, sourceKind:"BOOK",
        proceeds:PandaDEX.plain(data.buy ? plan.totalMinima : plan.totalUsdt),
        sourceCoinids:PDService.fillCoins.slice()}; PDService.saveFill();
      PDService.refresh();
    });
  }
};
PDService.actionRest = function(message) {
  var i, order = null, data, amountD, previousMaker;
  if (message.type === "CANCEL") {
    data = message.data || {};
    for (i = 0; i < PDService.book.length; i++) if (PDService.book[i].coinid === data.coinid) order = PDService.book[i];
    if (!PDService.owns(order)) return PDService.tell("ERROR", {message:"That is not one of your active orders"});
    if (PDService.pendingRefs[order.coinid] === "cancel") return PDService.tell("ERROR", {message:"That cancellation is already waiting for confirmation"});
    PDService.setBusy(true); PDService.setStage("Submitting cancellation…");
    PDService.noteCancelled(order.coinid);
    return PandaTxn.cancel(PDService.cmd, order, function(error, tx) {
      var wasMaker = PDService.makerOwnedIds()[order.orderId];
      PDService.setBusy(false);
      if (error) { PDService.setStage("Cancellation failed — " + error); return PDService.tell("ERROR", {message:error}); }
      if (wasMaker) { PDService.makerForgetByOrderId(order.orderId); PDService.makerTombstone(order.orderId, PDService.block, PDService.block); }
      PDService.addPending(PandaPending.CANCEL, {orderId:order.orderId, coinid:order.coinid, buy:!order.sell, minima:PandaDEX.plain(order.minima), price:PandaDEX.plain(order.price)});
      PDService.setStage("Cancellation submitted — waiting for confirmation");
      PDService.tell("POSTED", {message:"Cancellation submitted — funds return when it confirms (~50 seconds)", tx:tx}); PDService.refresh();
    });
  }
  if (message.type === "CANCEL_ALL") {
    var mine = [], c = PDService.maker.cfg;
    for (i = 0; i < PDService.book.length; i++) {
      order = PDService.book[i];
      if (PDService.owns(order) && PDService.pendingRefs[order.coinid] !== "cancel" && String(PDService.pendingRefs[order.coinid] || "").indexOf("edit:") !== 0) mine.push(order);
    }
    if (!mine.length) return PDService.tell("ERROR", {message:"No cancellable open orders"});
    if (c && c.armed) {
      c.armed = false; c.slots = {}; c.tombstones = {};
      PDService.saveMaker();
      PDService.setStage("Market maker stopped — cancelling every order");
    }
    return PDService.cancelAllRun(mine, 0, 0, 0);
  }
  if (message.type === "EDIT") {
    data = message.data || {};
    for (i = 0; i < PDService.book.length; i++) if (PDService.book[i].coinid === data.coinid) order = PDService.book[i];
    if (!PDService.owns(order)) return PDService.tell("ERROR", {message:"That is not one of your active orders"});
    if (!PDService.onV6(order)) return PDService.tell("ERROR", {message:"This order is on the old order contract, which a partial fill can freeze. Cancel it and place it again: new orders use the protected contract."});
    if (PDService.pendingRefs[order.coinid] === "cancel") return PDService.tell("ERROR", {message:"That order is already being cancelled"});
    if (String(PDService.pendingRefs[order.coinid] || "").indexOf("edit:") === 0) return PDService.tell("ERROR", {message:"That reprice is already waiting for confirmation"});
    priceD = PDService.maybeDec(data.price);
    if (!priceD || !priceD.gt(0)) return PDService.tell("ERROR", {message:"Enter a valid new price"});
    data.price = PandaDEX.plain(priceD);
    PDService.setBusy(true); PDService.setStage("Submitting reprice…");
    return PandaTxn.relock(PDService.cmd, order, PandaTxn.newWantForPrice(order, data.price), function(error, tx) {
      PDService.setBusy(false);
      if (error) { PDService.setStage("Reprice failed — " + error); return PDService.tell("ERROR", {message:error}); }
      PDService.addPending(PandaPending.EDIT, {orderId:order.orderId, coinid:order.coinid, buy:!order.sell, minima:PandaDEX.plain(order.minima), price:data.price});
      PDService.setStage("Reprice submitted — waiting for confirmation");
      PDService.tell("POSTED", {message:"Reprice submitted — the order updates after confirmation", tx:tx});
      PDService.refresh();
    });
  }
  if (message.type === "MAKER_SAVE" || message.type === "MAKER_PUBLISH" || message.type === "MAKER_APPLY") {
    data = message.data || {};
    previousMaker = PDService.maker.cfg || PDService.makerDefault();
    PDService.maker.cfg = PDService.normalizeMaker(data.cfg || data);
    /* Slot records and tombstones are what is ON CHAIN. They round-tripped through the page, so a
       stale snapshot could hand back a ladder memory older than the truth — and a maker that
       forgets a rung posts a second one on top of real funds. Keep the service's own. */
    PDService.maker.cfg.slots = previousMaker.slots || {};
    PDService.maker.cfg.tombstones = previousMaker.tombstones || {};
    /* A settings write invalidates any action still queued under the settings it replaced. */
    PDService.maker.cfg.quoteRevision = String(Number(previousMaker.quoteRevision || 0) + 1);
    if (message.type === "MAKER_PUBLISH") { PDService.maker.cfg.armed = true; PDService.maker.cfg.lastActedMid = null; PDService.maker.lastCycleMs = 0; }
    if (message.type === "MAKER_APPLY") PDService.maker.lastCycleMs = 0;
    return PDService.saveMaker(function(ok) { if (ok) PDService.setStage(message.type === "MAKER_PUBLISH" ? "Maker published — first cycle starting" : "Maker settings saved"); PDService.refresh(); }, true);
  }
  if (message.type === "MAKER_WITHDRAW") return PDService.makerWithdraw();
  if (!message.type) return;
  PDService.tell("ERROR", {message:"Unsupported request: " + String(message.type)});
};
