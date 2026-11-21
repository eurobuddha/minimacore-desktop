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

let mem = null;   // { shops:{shopId:cfg}, orders:{ref:order}, chat:{randomid:msg}, meta:{} }
let writeTimer = null;
// Where a failure to save is said (0.19.168: it was swallowed, so a store that could no longer be written said nothing).
// main.js points it at the Logs view; the same reason is said once until it changes.
let logTo = (m) => { try { console.error(m); } catch (e) {} }, lastSaveError = "";
function setLog(fn) { if (typeof fn === "function") logTo = fn; }
function log(m) { try { logTo(String(m)); } catch (e) {} }
function saveFailed(e) { const m = "miniMall: shop.json could not be saved: " + ((e && e.message) || e); if (m !== lastSaveError) { lastSaveError = m; log(m); } }
function saved() { lastSaveError = ""; }

function filePath() { return path.join(app.getPath("userData"), "shop.json"); }
function ensureLoaded() {
  if (mem) return;
  mem = { shops: {}, orders: {}, chat: {}, meta: {} };
  let raw = null;
  try { raw = fs.readFileSync(filePath(), "utf8"); } catch (e) { return; }   // first run
  try {
    const j = JSON.parse(raw);
    if (j) { mem.shops = j.shops || {}; mem.orders = j.orders || {}; mem.chat = j.chat || {}; mem.meta = j.meta || {}; }
  } catch (e) {
    // Source of truth — never silently clobber a corrupt file; preserve it and start fresh.
    try { fs.renameSync(filePath(), filePath() + ".corrupt-" + Date.now()); } catch (e2) {}
  }
}
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "shop.json.tmp");
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }));
      fs.renameSync(tmp, filePath()); saved();
    } catch (e) { saveFailed(e); }
  }, WRITE_DEBOUNCE_MS);
}
function flush() {   // synchronous — for fund-relevant writes (a recorded order/payment must survive a crash)
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "shop.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }));
    fs.renameSync(tmp, filePath()); saved();
  } catch (e) { saveFailed(e); }
}

// ---- shops (my authored catalogs) ----
// Every lookup by an id a peer can write (shopId, ref, randomid) reads OWN entries only (0.19.199, as released 0.18.183):
// "__proto__" found Object.prototype, so an order "for a shop I made" passed, and an order ref of "__proto__" wrote into it.
const has = (m, k) => typeof k === "string" && Object.hasOwn(m, k);
function saveShop(cfg) { ensureLoaded(); if (typeof cfg.shopId !== "string" || cfg.shopId === "__proto__") throw new Error("Invalid shop id."); mem.shops[cfg.shopId] = cfg; persistSoon(); }
function shops() { ensureLoaded(); return Object.values(mem.shops); }
function shop(shopId) { ensureLoaded(); return has(mem.shops, shopId) ? mem.shops[shopId] : null; }
function deleteShop(shopId) { ensureLoaded(); if (has(mem.shops, shopId)) { delete mem.shops[shopId]; persistSoon(); } }

// ---- decimal-safe money (BigInt; NEVER float — amounts are decimal strings up to 44dp) ----
// A money figure is a plain decimal: digits, at most one point with digits after it. No sign, no exponent, no hex, no
// spaces. → [units BigInt, decimals] or null. decCmp → -1 / 0 / 1, or NULL when either side is not such a figure: an
// unreadable figure is never "equal" (0.19.164, released 0.18.149: it was, so a malformed buyer total counted as paid
// by any amount).
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
 * Is a coin dust for this order (0.19.200, the released rule of 0.18.181 and 0.18.185)? Below the larger of 1% of what is
 * due and 0.000001 of the token (no real price is smaller: miniMall prices are written to six decimals), unless it is at
 * least what is still due: a top-up of the remainder is never dust, however small. A real payment is one coin, or a few;
 * 100 coins of 1% still pay an order. With nothing due by the listing (an unchecked order), only the 0.000001 floor.
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
 *  An order stored before 0.19.166 is checked here the first time it is needed, against the shop as it is now. */
function ensureChecked(o) {
  if (Array.isArray(o.problems)) return o;
  const c = listing.check(shop(o.shopId), { items: o.items, shipping: o.shipping, currency: o.buyerCurrency || o.currency });
  o.due = c.problems.length ? "" : c.due; o.problems = c.problems;
  return o;
}
/** Record ONE payment coin against an order. Coins of the order's token add up (decimal-safe), each coin id counted once
 *  for good: the ids of counted coins (the right token only, at most MAX_PAY_COINS) are kept on the order, so a coin seen again after a restart, or once the in-memory "seen" set is
 *  cleared, never counts twice (0.19.167, as the phone Inbox 0.5.15, e2900eb9b3f8f74763c180fe602d41dd97c516c7). The
 *  buyer's own total is never what is compared (0.19.166, released 0.18.159): PAID iff the order matches the vendor's
 *  listing AND the CUMULATIVE paid amount >= what the listing says is due > 0. An order that does not match is UNCHECKED
 *  and is never paid (the vendor checks it by hand: handCheck); one due 0 or less, or not a readable figure, is BAD_TOTAL.
 *  A coin of another token never pays and never blocks a later honest payment (anyone can stamp a ref on a tiny coin): it
 *  does not undo a partial payment, and a right-token coin moves WRONG_TOKEN on. Only PAID locks the order. Never
 *  clobbers a vendor-progressed status (CONFIRMED+). → the outcome, "ALREADY" when paid, or null (no such order, no coin
 *  id, or this coin counted before). */
// ponytail: at most MAX_PAY_COINS counted coins per order (0.19.170). A coin carries one ref, so the order's own list is the
// whole record of what was counted; past the cap nothing more is counted and the order waits for a check by hand.
const MAX_PAY_COINS = 500;
const TOO_MANY_COINS = "more than " + MAX_PAY_COINS + " payment coins came for this order; check the payment by hand";
function recordPayment(ref, coinid, paidAmount, paidTokenid) {
  ensureLoaded(); const o = order(ref); if (!o) return null;
  if (o.paid) return "ALREADY";
  const id = String(coinid == null ? "" : coinid).toLowerCase();
  if (!id || id.length > 80) return null;
  o.coins = Array.isArray(o.coins) ? o.coins : [];
  if (o.coins.includes(id)) return null;
  ensureChecked(o);
  if (String(paidTokenid).toLowerCase() !== String(o.tokenid).toLowerCase()) {   // never counted, so never kept: a wrong coin seen again changes nothing
    if (!o.paidAmount) o.paidTokenid = paidTokenid;   // shown only while no coin of the right token has come
    if (STATUS_RANK.WRONG_TOKEN > (STATUS_RANK[o.status] || 0)) o.status = "WRONG_TOKEN";
    flush(); return "WRONG_TOKEN";
  }
  // Dust (0.19.200, as released 0.18.181 / 0.18.185) is not counted, not kept and not saved: it never fills the order's
  // MAX_PAY_COINS list, so a flood of tiny coins cannot push a later real payment past the cap, and it costs no disk write.
  // It is NOT remembered either: what is dust depends on what is still due, so the same coin is judged again later.
  if (isDust(o, paidAmount)) return "DUST";
  if (o.coins.length >= MAX_PAY_COINS) {
    if (!o.problems.includes(TOO_MANY_COINS)) { o.problems.push(TOO_MANY_COINS); o.due = ""; }
    if ((STATUS_RANK[o.status] || 0) <= STATUS_RANK.UNCHECKED) o.status = "UNCHECKED";   // from any state before PAID; never back from a vendor's
    flush(); return "UNCHECKED";
  }
  o.coins.push(id);
  o.paidAmount = decAdd(o.paidAmount || "0", paidAmount); o.paidTokenid = paidTokenid; o.paidAt = Date.now();
  const outcome = o.problems.length ? "UNCHECKED" : !payableTotal(o.due) ? "BAD_TOTAL" : decGte(o.paidAmount, o.due) ? "PAID" : "UNDERPAID";
  if (outcome === "PAID") o.paid = true;
  if ((STATUS_RANK[outcome] || 0) > (STATUS_RANK[o.status] || 0) || o.status === "WRONG_TOKEN") o.status = outcome;   // advance, never downgrade CONFIRMED+
  flush(); return outcome;
}
/** The vendor's explicit "I checked this order by hand" for an order that does not match the listing: only then can it
 *  be confirmed, shipped or delivered without being PAID. Nothing else changes (it is still not paid). */
function handCheck(ref) {
  ensureLoaded(); const o = order(ref);
  if (!o || o.role !== "sell") return false;
  ensureChecked(o); if (!o.problems.length) return false;
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

function clear() { mem = { shops: {}, orders: {}, chat: {}, meta: {} }; flush(); }
function exportAll() { ensureLoaded(); return { shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }; }

module.exports = {
  saveShop, shops, shop, deleteShop,
  upsertOrder, order, orders, setStatus, recordPayment, markOrderRead, handCheck, mayAdvance, ensureChecked,
  addChat, chat, setMeta, setMetaSync, getMeta, clear, exportAll, flush, setLog, log,
  _money: { decCmp, decGte, decAdd, payableTotal, isDust }, MAX_PAY_COINS
};
