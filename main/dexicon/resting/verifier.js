/* verifier.js — did a vanished order get FILLED, or CANCELLED, or can we not tell?
 *
 * Native's FillVerifier asks that question one order at a time: fetch the coins at the order's
 * payout address and look for one whose token and amount match. That is too weak, and it is the
 * bug behind a tape full of trades that never happened.
 *
 * Every order a wallet creates carries the SAME payout address — port 1 is the wallet's receive
 * address — so one address holds every rung's refund, every proceeds output and all change. A
 * cancelled ASK rung refunds exactly its size in MINIMA. A BID rung of the same size wants exactly
 * that much MINIMA. Adjudicated independently, that single refund coin "proves payment" for every
 * bid rung that disappears in the same window: one cancellation becomes six phantom trades.
 *
 * The fix is not a better predicate, it is EXCLUSIVITY. A coin is evidence for at most ONE order:
 *
 *   pass 1  refunds  — a coin equal to an order's `locked` in its `lockedTok` proves THAT order was
 *                      cancelled. Claimed first because it is the most specific signal available,
 *                      which also stops a refund being mistaken for somebody else's payment.
 *   pass 2  payments — of what is left, a coin equal to an order's `wantAmt` in its `wantTok`
 *                      proves that order was filled.
 *   pass 3  the rest — UNKNOWN, and an UNKNOWN is never recorded. A lost trade is invisible; a
 *                      phantom one is not.
 *
 * Evidence must also be NEWER than the last block we actually saw the order alive, not merely
 * within a fixed lookback, so a coin that existed before the order vanished cannot explain it.
 *
 * This is stronger than native and is the intended direction of travel for the APK.
 */
var PandaVerify = PandaVerify || {};
(function (V, P) {
  V.EVIDENCE_BLOCKS = 12;
  V.CANCELLED = "CANCELLED";
  V.FILLED = "FILLED";
  V.UNKNOWN = "UNKNOWN";

  V.sameToken = function (a, b) { return String(a || "0x00").toUpperCase() === String(b || "0x00").toUpperCase(); };
  V.coinValue = function (coin) { var tok = (coin && coin.tokenid) || "0x00"; return P.d(!V.sameToken(tok, "0x00") ? (coin.tokenamount || coin.amount || 0) : (coin.amount || 0)); };
  V.rows = function (reply) {
    var r = reply && reply.response;
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.coins)) return r.coins;
    return null;
  };

  /* The earliest block a coin could have been created and still explain this order's disappearance.
     `since` is the last block we saw the order alive; without it we fall back to native's window. */
  V.earliest = function (order, seenBlock, since) {
    var a = Number((order && order.created) || 0),
        b = Number(seenBlock || 0) - V.EVIDENCE_BLOCKS,
        c = Number(since || 0);
    return Math.max(a, Math.max(b, c));
  };

  V.matches = function (coin, tok, amount, floor) {
    if (!coin) return false;
    if (Number(coin.created || 0) < floor) return false;
    if (!V.sameToken(coin.tokenid || "0x00", tok)) return false;
    return V.coinValue(coin).eq(P.d(amount));
  };

  V.findUnclaimed = function (rows, claimed, tok, amount, floor) {
    var j, coin, key;
    for (j = 0; j < (rows || []).length; j++) {
      coin = rows[j]; key = String(coin && coin.coinid);
      if (claimed[key]) continue;
      if (V.matches(coin, tok, amount, floor)) return key;
    }
    return null;
  };
  /* items: [{coinid, order, since}] — every full disappearance seen in one scan, adjudicated
     together so the exclusivity rule can apply. Returns {coinid: verdict}. */
  V.adjudicateBatch = function (rowsByAddr, items, seenBlock) {
    var out = {}, claimed = {}, i, j, it, rows, floor, coin, key, found;
    items = items || [];
    for (i = 0; i < items.length; i++) out[items[i].coinid] = V.UNKNOWN;

    /* pass 1 — a clean refund proves a cancellation and CLAIMS the coin, so no other order can
       later read it as its own payment. That claim is the whole fix.
       An order that has BOTH a refund-shaped and a payment-shaped coin available is genuinely
       ambiguous; it is skipped here and settled in pass 2, where a payment wins — native's
       precedence, preserved deliberately so this ports back without changing behaviour. */
    for (i = 0; i < items.length; i++) {
      it = items[i]; rows = rowsByAddr[it.order.wantAddr] || null;
      if (!rows) continue;
      floor = V.earliest(it.order, seenBlock, it.since); found = null;
      if (V.findUnclaimed(rows, claimed, it.order.wantTok, it.order.wantAmt, floor)) continue;
      found = V.findUnclaimed(rows, claimed, it.order.lockedTok, it.order.locked, floor);
      if (found) { claimed[found] = true; out[it.coinid] = V.CANCELLED; }
    }

    /* pass 2 — of what remains, a payment proves a fill */
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (out[it.coinid] !== V.UNKNOWN) continue;
      rows = rowsByAddr[it.order.wantAddr] || null;
      if (!rows) continue;
      floor = V.earliest(it.order, seenBlock, it.since);
      found = V.findUnclaimed(rows, claimed, it.order.wantTok, it.order.wantAmt, floor);
      if (found) { claimed[found] = true; out[it.coinid] = V.FILLED; continue; }
      /* nothing left that could be a payment — fall back to a refund it could not claim earlier */
      found = V.findUnclaimed(rows, claimed, it.order.lockedTok, it.order.locked, floor);
      if (found) { claimed[found] = true; out[it.coinid] = V.CANCELLED; }
    }
    return out;
  };

  /* Fetch evidence once per distinct payout address, then adjudicate the whole batch. */
  V.verifyBatch = function (cmd, items, seenBlock, done) {
    var addrs = [], seen = {}, rowsByAddr = {}, i, a;
    items = items || [];
    if (!items.length) return done({});
    for (i = 0; i < items.length; i++) {
      a = items[i].order && items[i].order.wantAddr;
      if (a && !seen[a]) { seen[a] = true; addrs.push(a); }
    }
    (function next(idx) {
      if (idx >= addrs.length) return done(V.adjudicateBatch(rowsByAddr, items, seenBlock));
      a = addrs[idx];
      cmd("coins simplestate:true address:" + a + " coinage:0 depth:" + V.EVIDENCE_BLOCKS, function (reply) {
        rowsByAddr[a] = (reply && reply.status) ? (V.rows(reply) || []) : null;   /* null = unreadable, never "no evidence" */
        next(idx + 1);
      });
    })(0);
  };

  /* ---- evidence for OUR OWN taker trade (native reconcileTakerFill/completeTakerFill) ----
     Deliberately not optimistic: a consensus-rejected sweep posts without error and simply never
     mines, so recording on "posted" writes a permanent phantom keyed by coinid that then blocks
     the real record if that coin later fills for real. */

  /* TRI-STATE and that is the whole point: true present, false gone, null WE DO NOT KNOW.
     A failed or unparseable reply must never be read as "the coin is spent". */
  V.coinPresent = function (reply) {
    var r;
    if (!reply || reply.status !== true) return null;
    r = reply.response;
    if (Array.isArray(r)) return r.length > 0;
    if (r && typeof r === "object") return String(r.coinid || "").length > 0;
    return null;
  };
  /* The proceeds we expected must actually exist at our address, in the right token, for the exact
     amount, created no earlier than the block we posted in. */
  V.proceedsPresent = function (reply, tok, amount, minBlock) {
    var rows = V.rows(reply), i, c;
    if (!rows) return false;
    for (i = 0; i < rows.length; i++) {
      c = rows[i];
      if (!c || Number(c.created || 0) < Number(minBlock || 0)) continue;
      if (!V.sameToken(c.tokenid || "0x00", tok)) continue;
      if (V.coinValue(c).eq(P.d(amount))) return true;
    }
    return false;
  };

  /* Single-order form, kept for callers and tests. Exclusivity is trivial with one item. */
  V.adjudicate = function (reply, order, seenBlock, since) {
    var rows = V.rows(reply), byAddr = {};
    if (!rows || !order) return V.UNKNOWN;
    byAddr[order.wantAddr] = rows;
    return V.adjudicateBatch(byAddr, [{coinid:order.coinid, order:order, since:since}], seenBlock)[order.coinid];
  };
  V.verify = function (cmd, order, seenBlock, done) {
    if (!order || !order.wantAddr) return done(V.UNKNOWN);
    V.verifyBatch(cmd, [{coinid:order.coinid, order:order, since:0}], seenBlock, function (verdicts) {
      done(verdicts[order.coinid] || V.UNKNOWN);
    });
  };
})(PandaVerify, PandaDEX);
