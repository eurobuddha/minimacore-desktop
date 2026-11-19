/*
 * dexicon-signgate.js — what the hidden Dexicon page may have signed or posted (0.18.120, security review M4).
 *
 * The page (renderer/dexicon/, verbatim) builds and signs its own FAST takes, so `txncreate … txnsign` and `txnpost`
 * reach it through the bridge (main/dexicon.js pageCmd). One unescaped relay string in that page would have been full
 * custody: a script in the frame could build any spend and have it signed. This file is the main process's own check,
 * made on what the NODE says the transaction holds (`txnlist id:`), never on what the page said it built.
 *
 * The page has exactly two transactions (main/dexicon/lib/fill.js buildSigned, lib/maker.js relock):
 *   SELF  every output pays this wallet (a void / relock). Signed and posted when nothing leaves: per token, what
 *         comes back to the wallet equals everything that goes in.
 *   TAKE  some outputs pay a maker. Signed, never posted by the page (the maker posts). Allowed only when ALL hold:
 *         - the user reviewed a FAST trade on the native screen in the last ten minutes (`budget`: side, limit price,
 *           amount; set by the app's own window, which the frame cannot reach);
 *         - every input that is not this wallet's is a coin of ONE live order the engine's own service has read from
 *           the relays (not the page's copy), on the side the user is taking;
 *         - every output that is not this wallet's pays that order's address or the address of one of its coins;
 *         - only MINIMA and MxUSD move; this wallet gives one and receives the other, at that order's price or better
 *           (the engine's own rounding: MxUSD paid is rounded up, MxUSD received rounded down, 8 decimals);
 *         - the order's price is inside the reviewed limit, and the MINIMA of all takes signed since the review is
 *           inside the reviewed amount.
 * Anything else is refused, with the reason.
 *
 * Pure: no node, no store. F = the engine's own AX.fill (d, up8, down8, coinValue, MINIMA, MXUSD), for exact decimals.
 */
"use strict";

const BUDGET_MS = 10 * 60000;
const HEX64 = /^0x[0-9a-f]{64}$/;
const SIMPLE = /^RETURN SIGNEDBY\((0x[0-9A-Fa-f]{64})\)$/;   // main/dexicon/lib/maker.js SIMPLE

/** This wallet's own addresses: a simple script whose key is one of the wallet's keys. (`scripts` alone will not do:
 *  a taker registers each maker's script with newscript, so makers' addresses are in that list too.) */
function ownAddresses(scriptsReply, keysReply) {
  const keys = new Set(), own = new Set();
  const kr = keysReply && keysReply.response, list = Array.isArray(kr) ? kr : (kr && Array.isArray(kr.keys) ? kr.keys : []);
  for (const k of list) if (k && k.publickey) keys.add(String(k.publickey).toLowerCase());
  const rows = scriptsReply && Array.isArray(scriptsReply.response) ? scriptsReply.response : [];
  for (const r of rows) { const m = r && SIMPLE.exec(String(r.script || "")); if (m && r.address && keys.has(m[1].toLowerCase())) own.add(String(r.address).toLowerCase()); }
  return own;
}

/**
 * a = { txn (txnlist's `transaction`), own (Set of lower-case addresses), orders (the service's relay orders),
 *       budget ({ buy, price, left, until } | null), post (true for txnpost), now, F }.
 * Returns { ok: true, kind: "self" } | { ok: true, kind: "take", minima (string), orderId } | { ok: false, why }.
 */
function check(a) {
  const F = a.F, no = (why) => ({ ok: false, why });
  const t = a.txn, ins = t && t.inputs, outs = t && t.outputs;
  if (!Array.isArray(ins) || !Array.isArray(outs) || !ins.length || !outs.length) return no("the transaction has no inputs or no outputs");
  if (Array.isArray(t.state) && t.state.length) return no("the transaction carries state");
  const lc = (v) => String(v == null ? "" : v).toLowerCase(), MIN = lc(F.MINIMA), USD = lc(F.MXUSD);
  const sums = () => ({ [MIN]: F.d(0), [USD]: F.d(0) });
  const myIn = sums(), allIn = sums(), myOut = sums(), foreignIn = [], foreignOut = [];
  for (const c of ins.concat(outs)) {
    if (!c || !HEX64.test(lc(c.address))) return no("a coin without a plain address");
    const tok = lc(c.tokenid);
    if (tok !== MIN && tok !== USD) return no("a token that is neither MINIMA nor MxUSD (" + c.tokenid + ")");
    if (tok !== MIN && c.tokenamount === undefined) return no("an MxUSD amount the node did not state");
    if (c.state && c.state.length) return no("a coin that carries state");
  }
  for (const c of ins) {
    const tok = lc(c.tokenid), v = F.coinValue(c);
    allIn[tok] = allIn[tok].plus(v);
    if (a.own.has(lc(c.address))) myIn[tok] = myIn[tok].plus(v); else foreignIn.push(c);
  }
  for (const c of outs) { const tok = lc(c.tokenid); if (a.own.has(lc(c.address))) myOut[tok] = myOut[tok].plus(F.coinValue(c)); else foreignOut.push(c); }

  if (!foreignOut.length) {   // SELF
    for (const tok of [MIN, USD]) if (!myOut[tok].eq(allIn[tok])) return no("not everything that goes in comes back to this wallet (" + (tok === MIN ? "MINIMA" : "MxUSD") + ": " + allIn[tok].toFixed() + " in, " + myOut[tok].toFixed() + " back)");
    return { ok: true, kind: "self" };
  }
  // TAKE
  if (a.post) return no("the page posts only transactions that pay this wallet; this one pays " + foreignOut[0].address);
  const b = a.budget;
  if (!b || !(a.now < b.until)) return no("no FAST trade was reviewed on the Trade screen in the last ten minutes");
  if (!foreignIn.length) return no("it pays " + foreignOut[0].address + " and spends no coin of any order");
  const side = b.buy ? "sell" : "buy", need = foreignIn.map(c => lc(c.coinid));
  const order = (a.orders || []).find(o => o && o.side === side && Array.isArray(o.coins) && need.every(id => o.coins.some(x => lc(x) === id)));
  if (!order) return no("its foreign inputs are not the coins of one live " + side + " order the engine has read from the relays (" + need.join(", ") + ")");
  const payTo = new Set([lc(order.address)].concat(foreignIn.map(c => lc(c.address))));
  for (const c of foreignOut) if (!payTo.has(lc(c.address))) return no("an output pays " + c.address + ", which is neither this wallet nor order " + order.orderId);
  const give = b.buy ? USD : MIN, recv = b.buy ? MIN : USD;
  for (const c of foreignIn) if (lc(c.tokenid) !== recv) return no("the order's coin " + c.coinid + " is not the token this trade receives");
  if (!myIn[recv].eq(0)) return no("this wallet's coins of the token it is to receive are spent too");
  const gave = myIn[give].minus(myOut[give]), got = myOut[recv], minima = b.buy ? got : gave, usd = b.buy ? gave : got, price = F.d(order.price);
  if (!(minima.gt(0) && usd.gt(0) && price.gt(0))) return no("nothing is received, or nothing is paid");
  if (b.buy ? usd.gt(F.up8(minima.times(price))) : usd.lt(F.down8(minima.times(price)))) return no("not at order " + order.orderId + "'s price " + order.price + ": " + minima.toFixed() + " MINIMA for " + usd.toFixed() + " MxUSD");
  if (b.buy ? price.gt(F.d(b.price)) : price.lt(F.d(b.price))) return no("order " + order.orderId + " at " + order.price + " is outside the reviewed limit " + b.price);
  if (minima.gt(F.d(order.amount))) return no("more than order " + order.orderId + " offers");
  if (minima.gt(F.d(b.left))) return no(minima.toFixed() + " MINIMA is more than is left of the reviewed amount (" + F.d(b.left).toFixed() + ")");
  return { ok: true, kind: "take", minima: minima.toFixed(), orderId: String(order.orderId) };
}

module.exports = { check, ownAddresses, BUDGET_MS };
