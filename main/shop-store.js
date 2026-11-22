/*
 * shop-store.js — persistent local store for miniMall (my shops / orders / order-chat / meta), mirroring the
 * native com.eurobuddha.comms MerchDb. The node prunes coins, so this local store is the source of truth.
 * Orders dedup on `ref`; chat dedups on `randomid`. Atomic tmp+rename writes, debounced. JSON (modest volume).
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const listing = require("./shop-listing");

const WRITE_DEBOUNCE_MS = 300;

let mem = null;   // { shops:{shopId:cfg}, orders:{ref:order}, chat:{randomid:msg}, meta:{}, counted:{coinid:ref} }
// counted (0.18.163): every payment coin already added to an order, kept ON DISK. The scanner's own "seen" set is in
// memory only, so after a restart its backfill counted the same coin again and a half-paid order became PAID.
// The order's own coin list is the authority (a coin carries one order's ref in its state, so it is only ever offered to
// that order); the global list is a short guard of the most recent ids (0.18.202: 100000 → 5000).
const COUNTED_MAX = 5000, ORDER_COINS_MAX = 1000;
let writeTimer = null;

function filePath() { return path.join(app.getPath("userData"), "shop.json"); }
function ensureLoaded() {
  if (mem) return;
  mem = { shops: {}, orders: {}, chat: {}, meta: {}, counted: {} };
  let raw = null;
  try { raw = fs.readFileSync(filePath(), "utf8"); } catch (e) { return; }   // first run
  try {
    const j = JSON.parse(raw);
    if (j) { mem.shops = j.shops || {}; mem.orders = j.orders || {}; mem.chat = j.chat || {}; mem.meta = j.meta || {}; mem.counted = j.counted || {}; }
    for (const o of Object.values(mem.orders)) migrate(o);
  } catch (e) {
    // Source of truth — never silently clobber a corrupt file; preserve it and start fresh.
    try { fs.renameSync(filePath(), filePath() + ".corrupt-" + Date.now()); } catch (e2) {}
  }
}
/**
 * An order stored by a version before the listing check (0.18.195; 0.18.69 is the released one) carries none of its
 * fields. Read once at load:
 *  - already paid, or confirmed / shipped / delivered: its verdict is kept (no re-check, no banner);
 *  - money already counted but no coin list: the coins are counted again from what the node still shows (legacyPaid keeps
 *    the old figure for the screen). It errs towards underpaid and a check by hand, never towards paid: the old figure
 *    without its coins would let the same coin count twice;
 *  - no items (a phone order an older version stored without them): says so, and can be checked by hand.
 */
function migrate(o) {
  if (!o || o.role !== "sell" || Array.isArray(o.problems)) return;
  if (o.paid || (STATUS_RANK[o.status] || 0) >= STATUS_RANK.CONFIRMED) { o.legacyVerdict = true; o.problems = []; o.due = ""; return; }
  if (!Array.isArray(o.coins) && decCmp(o.paidAmount || "0", "0") === 1) {
    o.legacyPaid = String(o.paidAmount); o.paidAmount = "0"; o.coins = [];
    if ((STATUS_RANK[o.status] || 0) < STATUS_RANK.PAID) o.status = "PENDING";
  }
  if (!Array.isArray(o.items) || !o.items.length) { o.legacyNoItems = true; o.problems = ["the items were not kept by an older version of this app"]; o.due = ""; }
}
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "shop.json.tmp");
      fs.writeFileSync(tmp, snapshot());
      fs.renameSync(tmp, filePath());
    } catch (e) { saveFailed(e); }
  }, WRITE_DEBOUNCE_MS);
}
function snapshot() { return JSON.stringify({ version: 1, shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta, counted: mem.counted }); }
// A failed save is said, not swallowed (0.18.163): it left every order of the session unsaved without a word.
function saveFailed(e) { console.error("[miniMall] shop.json could not be saved: " + String((e && e.message) || e).slice(0, 300)); }
function flush() {   // synchronous — for fund-relevant writes (a recorded order/payment must survive a crash)
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "shop.json.tmp");
    fs.writeFileSync(tmp, snapshot());
    fs.renameSync(tmp, filePath());
  } catch (e) { saveFailed(e); }
}

// ---- shops (my authored catalogs) ----
// Every lookup by an id a peer can write (shopId, ref, randomid) reads OWN entries only (0.18.183): "__proto__" found
// Object.prototype, so an order "for a shop I made" passed, and an order ref of "__proto__" wrote into the prototype.
const has = (m, k) => typeof k === "string" && Object.hasOwn(m, k);
function saveShop(cfg) { ensureLoaded(); if (typeof cfg.shopId !== "string" || cfg.shopId === "__proto__") throw new Error("Invalid shop id."); mem.shops[cfg.shopId] = cfg; persistSoon(); }
function shops() { ensureLoaded(); return Object.values(mem.shops); }
function shop(shopId) { ensureLoaded(); return has(mem.shops, shopId) ? mem.shops[shopId] : null; }
function deleteShop(shopId) { ensureLoaded(); if (has(mem.shops, shopId)) { delete mem.shops[shopId]; persistSoon(); } }

// ---- decimal-safe money (BigInt; NEVER float — amounts are decimal strings up to 44dp) ----
// A money figure is a plain decimal: digits, at most one point with digits after it. No sign, no exponent, no hex, no
// spaces. → [units BigInt, decimals] or null. decCmp → -1 / 0 / 1, or NULL when either side is not such a figure: an
// unreadable figure is never "equal" (0.18.149: it was, so a malformed buyer total counted as paid by any amount).
function decParse(v) {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d{1,60}(\.\d{1,60})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return [BigInt(i + f), f.length];
}
function decCmp(a, b) {
  const A = decParse(a), B = decParse(b); if (!A || !B) return null;
  const dp = Math.max(A[1], B[1]), x = A[0] * 10n ** BigInt(dp - A[1]), y = B[0] * 10n ** BigInt(dp - B[1]);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** a >= b, both readable figures. */
function decGte(a, b) { const c = decCmp(a, b); return c === 0 || c === 1; }
/**
 * Is a coin dust for this order (0.18.181)? Below the larger of 1% of what is due and 0.000001 of the token (no real
 * price is smaller: miniMall prices are written to six decimals), unless it is at least what is still due: a top-up of
 * the remainder is never dust, however small. A real payment is one coin, or a few; 100 coins of 1% still pay an order.
 * With nothing due by the listing (an unchecked order), only the 0.000001 floor.
 */
const MIN_COIN = "0.000001";
function isDust(o, amount) {
  const a = decParse(amount); if (!a) return true;
  const d = decParse(o.due);
  if (!d || d[0] <= 0n) return decCmp(amount, MIN_COIN) === -1;   // nothing due by the listing: only the absolute floor
  const p = decParse(o.paidAmount || "0") || [0n, 0], m = decParse(MIN_COIN);
  const dp = Math.max(a[1], d[1] + 2, p[1], m[1]), at = (x) => x[0] * 10n ** BigInt(dp - x[1]);
  let floor = d[0] * 10n ** BigInt(dp - d[1] - 2);                  // 1% of what is due
  if (floor < at(m)) floor = at(m);                                 // never below 0.000001
  const remaining = at(d) - at(p); if (remaining < floor) floor = remaining;   // what is still due is never dust
  return floor > 0n && at(a) < floor;
}
/** An order total that can ever be paid: a readable figure above zero. */
function payableTotal(v) { return decCmp(v, "0") === 1; }
function decAdd(a, b) {
  const [ai = "0", af = ""] = String(a == null ? "0" : a).split(".");
  const [bi = "0", bf = ""] = String(b == null ? "0" : b).split(".");
  const dp = Math.max(af.length, bf.length);
  let sum; try { sum = BigInt((ai || "0") + af.padEnd(dp, "0")) + BigInt((bi || "0") + bf.padEnd(dp, "0")); } catch (e) { return String(a || "0"); }
  const str = sum.toString().padStart(dp + 1, "0");
  return dp ? str.slice(0, -dp) + "." + str.slice(-dp) : str;
}

// ---- orders (dedup on ref; never regress a progressed status) ----
const STATUS_RANK = { PENDING: 0, INQUIRY: 0, UNDERPAID: 1, WRONG_TOKEN: 1, BAD_TOTAL: 1, UNCHECKED: 1, PAID: 2, CONFIRMED: 3, SHIPPED: 4, DELIVERED: 5 };
/** Insert an order if new (dedup on ref). Returns true if newly inserted. Never overwrites an existing order. */
function upsertOrder(o) {
  ensureLoaded();
  if (typeof o.ref !== "string" || o.ref === "__proto__" || has(mem.orders, o.ref)) return false;
  mem.orders[o.ref] = o;
  flush();   // fund-relevant: an incoming order must survive a crash
  return true;
}
function order(ref) { ensureLoaded(); return has(mem.orders, ref) ? mem.orders[ref] : null; }
function orders() { ensureLoaded(); return Object.values(mem.orders); }
/** Set status only if it STRICTLY advances (higher rank) — an out-of-order/malicious STATUS_UPDATE can't roll back. */
function setStatus(ref, status) {
  ensureLoaded(); const o = order(ref); if (!o) return false;
  const cur = STATUS_RANK[o.status] != null ? STATUS_RANK[o.status] : 0;
  const nxt = STATUS_RANK[status] != null ? STATUS_RANK[status] : 0;
  if (nxt <= cur) return false;
  o.status = status; flush(); return true;
}
/** What an order is due by the vendor's own listing (main/shop-listing.js), worked out once and kept on the order:
 *  o.due (the recomputed total, "" when it could not be) and o.problems (every way the order departs from the listing).
 *  An order stored before 0.18.159 is checked here the first time it is needed, against the shop as it is now. */
function ensureChecked(o) {
  if (Array.isArray(o.problems)) return o;
  const c = listing.check(shop(o.shopId), { items: o.items, shipping: o.shipping, currency: o.buyerCurrency || o.currency });
  o.due = c.problems.length ? "" : c.due; o.problems = c.problems;
  return o;
}
/** Record a matched payment against an order. Accumulates across coins (decimal-safe). The buyer's own total is never
 *  what is compared (0.18.159): PAID iff the token matches AND the order matches the vendor's listing AND the CUMULATIVE
 *  paid amount >= what the listing says is due > 0. An order that does not match is UNCHECKED and is never paid (the
 *  vendor checks it by hand: handCheck); one due 0 or less is BAD_TOTAL. Never clobbers a vendor-progressed status (CONFIRMED+). */
// Dust coins of an order not counted yet (0.18.190), in memory only: { ref → { coins: Map(coinid → amount), sum (exact, kept as
// each coin comes and goes), min: [id, amount] of the smallest kept } }. Together they count once their sum covers what is still
// due (9.9 + 0.05 + 0.05 pays 10). A flood that never sums to it writes nothing. Full (PENDING_MAX), a coin not larger than the
// smallest kept is not kept, one look (0.18.226, as Pandamonium Desktop 0.19.272: every new coin past 1000 sorted the whole map
// and every look re-summed it, about a second of main thread per block for 3000 coins, and 1000 gathered coins never fit the
// order's 1000-coin list beside the coins it had, so a flood never counted); a larger one takes the smallest one's place.
// After a restart the scanner sees them again and they gather again.
const PENDING_DUST = new Map(), PENDING_MAX = 256;
function decSub(a, b) {   // a - b, both readable figures, a >= b
  const A = decParse(a), B = decParse(b), dp = Math.max(A[1], B[1]), d = A[0] * 10n ** BigInt(dp - A[1]) - B[0] * 10n ** BigInt(dp - B[1]);
  const str = d.toString().padStart(dp + 1, "0");
  return dp ? str.slice(0, -dp) + "." + str.slice(-dp) : str;
}
function smallest(coins) { let m = null; for (const [id, a] of coins) if (!m || decCmp(a, m[1]) === -1) m = [id, a]; return m; }
function pendAdd(ref, id, amount) {
  let p = PENDING_DUST.get(ref); if (!p) { p = { coins: new Map(), sum: "0", min: null }; PENDING_DUST.set(ref, p); }
  if (p.coins.has(id)) return;
  if (p.coins.size >= PENDING_MAX) {
    if (decCmp(amount, p.min[1]) !== 1) return;
    p.coins.delete(p.min[0]); p.sum = decSub(p.sum, p.min[1]); p.min = null;
  }
  p.coins.set(id, amount); p.sum = decAdd(p.sum, amount);
  p.min = !p.min ? smallest(p.coins) : decCmp(amount, p.min[1]) === -1 ? [id, amount] : p.min;
}
function pendDelete(ref, id) {   // a gathered coin counted on its own after all (what is due moved): never counted twice
  const p = PENDING_DUST.get(ref); if (!p || !p.coins.has(id)) return;
  p.sum = decSub(p.sum, p.coins.get(id)); p.coins.delete(id);
  if (p.min && p.min[0] === id) p.min = smallest(p.coins);
}
function remainingOf(o) {
  const d = decParse(o.due), p = decParse(o.paidAmount || "0") || [0n, 0];
  if (!d || d[0] <= 0n || o.problems.length) return null;
  const dp = Math.max(d[1], p[1]); return [d[0] * 10n ** BigInt(dp - d[1]) - p[0] * 10n ** BigInt(dp - p[1]), dp];
}
/** Count coins on an order: in its list and the global list, their amounts added; the outcome. */
function countCoins(o, ref, coins, paidTokenid) {
  for (const [cid, amount] of coins) {
    o.coins = (o.coins || []).concat(cid); mem.counted[cid] = ref;
    o.paidAmount = decAdd(o.paidAmount || "0", amount);
  }
  const ids = Object.keys(mem.counted); if (ids.length > COUNTED_MAX) for (const k of ids.slice(0, ids.length - COUNTED_MAX)) delete mem.counted[k];   // the oldest go first; the order's own list still holds them
  o.paidTokenid = paidTokenid; o.paidAt = Date.now();
  const outcome = o.problems.length ? "UNCHECKED" : !payableTotal(o.due) ? "BAD_TOTAL" : decGte(o.paidAmount, o.due) ? "PAID" : "UNDERPAID";
  if (outcome === "PAID") { o.paid = true; PENDING_DUST.delete(ref); }
  if ((STATUS_RANK[outcome] || 0) > (STATUS_RANK[o.status] || 0)) o.status = outcome;   // advance, never downgrade CONFIRMED+
  return outcome;
}
/** The order's gathered dust, counted together when it covers what is still due → the outcome, or "". */
function settleDust(o, ref) {
  const pend = PENDING_DUST.get(ref), rem = remainingOf(o);
  if (!pend || !pend.coins.size || !rem || rem[0] <= 0n) return "";
  // the running sum (0.18.226); a gathered coin is never counted elsewhere: recordPayment returns ALREADY for a counted one before
  // it is gathered, and one counted on its own after all is taken out (pendDelete)
  const S = decParse(pend.sum), dp = Math.max(S[1], rem[1]);
  if (S[0] * 10n ** BigInt(dp - S[1]) < rem[0] * 10n ** BigInt(dp - rem[1]) || (o.coins || []).length + pend.coins.size > ORDER_COINS_MAX) return "";
  PENDING_DUST.delete(ref);
  return countCoins(o, ref, [...pend.coins.entries()], o.tokenid);
}
function recordPayment(ref, paidAmount, paidTokenid, coinid) {
  ensureLoaded(); const o = order(ref); if (!o) return null;
  if (o.paid) return "ALREADY";
  // A coin is counted once, for one order, across restarts (0.18.163). No coin id: nothing can be told apart, so nothing is counted.
  const cid = typeof coinid === "string" ? coinid.toLowerCase() : "";
  if (!/^0x[0-9a-f]{1,128}$/.test(cid)) return null;
  if (has(mem.counted, cid) || (o.coins || []).includes(cid)) return "ALREADY";
  ensureChecked(o);
  const rightToken = String(paidTokenid).toLowerCase() === String(o.tokenid).toLowerCase();
  // Dust (0.18.181) never fills the order's 1000-coin list, so a flood of tiny coins cannot block a later real payment.
  // It is NOT remembered on disk (0.18.185): what is dust depends on what is still due, so the same coin is judged again
  // later; it is gathered in memory and counted with the order's other dust once together they cover what is still due
  // (0.18.190). Nothing is saved for it until then.
  if (isDust(o, paidAmount)) {
    if (!rightToken || !decParse(paidAmount)) return "DUST";
    pendAdd(ref, cid, String(paidAmount));
    const out = settleDust(o, ref); if (out) { flush(); return out; }
    return "DUST";
  }
  if ((o.coins || []).length >= ORDER_COINS_MAX) return null;
  if (!rightToken) {
    o.coins = (o.coins || []).concat(cid); mem.counted[cid] = ref;
    o.paidTokenid = paidTokenid;
    if (STATUS_RANK.WRONG_TOKEN > (STATUS_RANK[o.status] || 0)) o.status = "WRONG_TOKEN";
    flush(); return "WRONG_TOKEN";
  }
  pendDelete(ref, cid);
  let outcome = countCoins(o, ref, [[cid, String(paidAmount)]], paidTokenid);
  if (outcome === "UNDERPAID") outcome = settleDust(o, ref) || outcome;   // the gathered dust may now cover what is left
  flush(); return outcome;
}
/** A second buyer sent an order with this order's reference (0.18.208): it can no longer be paid automatically. An order
 *  the vendor confirmed or moved on (CONFIRMED, SHIPPED, DELIVERED), or checked by hand, is left as it is. One marked PAID and
 *  not moved on (0.18.289) is held again: the payment that paid it may be the other buyer's (the reference is plain text on
 *  chain, so a copier's order can be the one held first), so it is unpaid, UNCHECKED, and moves on only once checked by hand.
 *  What was received stays counted on it. Nothing was sent for PAID: the buyer hears of an order only from CONFIRMED on. */
function flagDuplicate(ref, problem) {
  ensureLoaded(); const o = order(ref); if (!o || o.role !== "sell") return false;
  const unpay = o.status === "PAID" && !o.handChecked;
  if (!unpay && (o.paid || (STATUS_RANK[o.status] || 0) >= STATUS_RANK.PAID)) return false;
  ensureChecked(o); if (o.problems.includes(problem)) return false;
  o.problems = [problem].concat(o.problems); o.due = "";
  if (unpay) { o.paid = false; o.status = "UNCHECKED"; }
  else if (o.status !== "INQUIRY" && (STATUS_RANK[o.status] || 0) <= STATUS_RANK.UNCHECKED && o.status !== "WRONG_TOKEN") o.status = "UNCHECKED";
  flush(); return true;
}
/** The vendor's explicit "I checked this order by hand" for an order that does not match the listing: only then can it
 *  be confirmed, shipped or delivered without being PAID. Nothing else changes (it is still not paid). */
function handCheck(ref) {
  ensureLoaded(); const o = order(ref);
  if (!o || o.role !== "sell") return false;
  // an order an older version counted money for can be checked by hand too, and one whose older verdict was kept but that is
  // not paid (0.18.218: confirmed by an older version without a payment, it could never move on)
  ensureChecked(o); if (!o.problems.length && !o.legacyPaid && !(o.legacyVerdict && !o.paid)) return false;
  o.handChecked = true; flush(); return true;
}
/** May the vendor confirm / ship / deliver this order? Paid by the listing's figure, or checked by hand. */
function mayAdvance(o) { return !!(o && (o.paid || o.handChecked)); }
function markOrderRead(ref) { ensureLoaded(); const o = order(ref); if (o && o.unread) { o.unread = false; persistSoon(); return true; } return false; }
function setMeta(k, v) { ensureLoaded(); mem.meta[k] = v; persistSoon(); }
function setMetaSync(k, v) { ensureLoaded(); mem.meta[k] = v; flush(); }   // fund-relevant flags (unpaid/ambiguous) must survive a crash
function getMeta(k) { ensureLoaded(); return mem.meta[k]; }

// ---- order chat (dedup on randomid) ----
function addChat(m) { ensureLoaded(); if (typeof m.randomid !== "string" || m.randomid === "__proto__" || has(mem.chat, m.randomid)) return false; mem.chat[m.randomid] = m; persistSoon(); return true; }
function chat(ref) { ensureLoaded(); return Object.values(mem.chat).filter(m => m.ref === ref).sort((a, b) => (a.date || 0) - (b.date || 0)); }

function clear() { mem = { shops: {}, orders: {}, chat: {}, meta: {}, counted: {} }; PENDING_DUST.clear(); flush(); }
function exportAll() { ensureLoaded(); return { shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }; }

module.exports = {
  saveShop, shops, shop, deleteShop,
  upsertOrder, order, orders, setStatus, recordPayment, markOrderRead, handCheck, flagDuplicate, mayAdvance, ensureChecked,
  addChat, chat, setMeta, setMetaSync, getMeta, clear, exportAll, flush,
  _money: { decCmp, decGte, decAdd, decSub, payableTotal }, PENDING_MAX,
  _pendingDust: (ref) => { const p = PENDING_DUST.get(ref); return p ? { size: p.coins.size, sum: p.sum, min: p.min && p.min[1] } : null; }
};
