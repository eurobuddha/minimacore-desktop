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
    for (const o of Object.values(mem.orders)) migrate(o);
  } catch (e) {
    // Source of truth — never silently clobber a corrupt file; preserve it and start fresh.
    try { fs.renameSync(filePath(), filePath() + ".corrupt-" + Date.now()); } catch (e2) {}
  }
}
/**
 * An order stored before the listing check (0.19.166) or the coin lists (0.19.167), here or by the released 0.18.69, read
 * once at load (0.19.247, as released 0.18.195 / 0.18.218; this store's own layout):
 *  - already paid, or confirmed / shipped / delivered, before the listing check: its verdict is kept (no check against the
 *    shop as it is now, no Unchecked banner); one moved on without a payment this version can see is checked by hand;
 *  - money counted but no coin list: the coins are counted again from what the node still shows (legacyPaid keeps the old
 *    figure for the screen). It errs towards underpaid and a check by hand, never towards paid: the old figure plus a coin
 *    seen again would count that coin twice.
 * An order whose items were not kept is Unchecked by the listing check itself ("the order has no items that can be read").
 */
function migrate(o) {
  if (!o || typeof o !== "object" || o.role !== "sell") return;
  if (!Array.isArray(o.problems) && (o.paid || (STATUS_RANK[o.status] || 0) >= STATUS_RANK.CONFIRMED)) { o.legacyVerdict = true; o.problems = []; o.due = ""; return; }
  if (!o.paid && !Array.isArray(o.coins) && decCmp(o.paidAmount || "0", "0") === 1) {
    o.legacyPaid = String(o.paidAmount); o.paidAmount = "0"; o.coins = [];
    if ((STATUS_RANK[o.status] || 0) < STATUS_RANK.PAID) o.status = "PENDING";
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
/** The incoming orders sent with this reference (0.19.352, as released 0.18.297): the one kept under it first, then other buyers' copies (ref~buyer). */
function refOrders(ref) {
  ensureLoaded(); if (typeof ref !== "string") return [];
  const first = order(ref), head = first && first.role === "sell" && !first.wireRef ? [first] : [];
  return head.concat(Object.values(mem.orders).filter(o => o && o.role === "sell" && o.wireRef === ref && o !== first));
}
/** The order a payment coin with this reference pays (0.19.352, as released 0.18.297; the phone Inbox's MerchDb.recordPayment rule): `proof` is
 *  the coin's state port 2. A coin with a proof pays only the order whose secret it proves (o.commit), the first one or another buyer's copy; a
 *  coin without one pays the first order that has no secret, as before; neither pays an order with a secret it does not prove (`unproven`).
 *  An order stored before 0.19.352 (neither commit nor noSecret: its secret, if it came with one, was not read) is paid as before by any coin
 *  with its reference. A port 2 that is not 0x and 64 hexadecimal digits proves nothing. */
function payee(ref, proof) {
  const all = refOrders(ref), p = typeof proof === "string" && proof ? (proof.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(proof) ? proof.toLowerCase() : "bad") : "";
  const before = (x) => !x.commit && !x.noSecret;
  const o = (p && p !== "bad" ? all.find(x => x.commit && x.commit.toLowerCase() === p) : null) || all.find(x => p ? before(x) : !x.commit) || null;
  return { order: o, unproven: o && o.commit ? [] : all.filter(x => x.commit) };
}
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
// Dust coins of an order not counted yet (0.19.248, as released 0.18.190), in memory only: { ref → { coins: Map(coin id → amount),
// sum (exact, kept as each coin comes and goes), min: [id, amount] of the smallest kept } }. Together they count once their sum
// covers what is still due (9.9 + 0.05 + 0.05 pays 10). A flood that never sums to it writes nothing. Full (PENDING_MAX), a coin
// not larger than the smallest kept is not kept, one look (0.19.272: every new coin past 1000 sorted the whole map and every
// look re-summed it, about a second of main thread per block for 3000 coins); a larger one takes the smallest one's place.
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
/** What is still due by the listing, as [units, decimals], or null when nothing can be paid by it. */
function remainingOf(o) {
  const d = decParse(o.due), p = decParse(o.paidAmount || "0") || [0n, 0];
  if (!d || d[0] <= 0n || o.problems.length) return null;
  const dp = Math.max(d[1], p[1]); return [d[0] * 10n ** BigInt(dp - d[1]) - p[0] * 10n ** BigInt(dp - p[1]), dp];
}
/** The order's verdict after a count: PAID locks it; the status only advances (never back from a vendor's). */
function judge(o) {
  const outcome = o.problems.length ? "UNCHECKED" : !payableTotal(o.due) ? "BAD_TOTAL" : decGte(o.paidAmount, o.due) ? "PAID" : "UNDERPAID";
  if (outcome === "PAID") o.paid = true;
  if ((STATUS_RANK[outcome] || 0) > (STATUS_RANK[o.status] || 0) || o.status === "WRONG_TOKEN") o.status = outcome;   // advance, never downgrade CONFIRMED+
  return outcome;
}
/** The order's gathered dust, counted together when it covers what is still due → the outcome, or "". */
function settleDust(o, ref) {
  const pend = PENDING_DUST.get(ref), rem = remainingOf(o);
  if (!pend || !pend.coins.size || !rem || rem[0] <= 0n) return "";
  const S = decParse(pend.sum), dp = Math.max(S[1], rem[1]);
  if (S[0] * 10n ** BigInt(dp - S[1]) < rem[0] * 10n ** BigInt(dp - rem[1]) || o.coins.length + pend.coins.size > MAX_PAY_COINS) return "";
  PENDING_DUST.delete(ref);
  for (const cid of pend.coins.keys()) o.coins.push(cid);
  o.paidAmount = decAdd(o.paidAmount || "0", pend.sum);
  o.paidTokenid = o.tokenid; o.paidAt = Date.now();
  return judge(o);
}
function recordPayment(ref, coinid, paidAmount, paidTokenid) {
  ensureLoaded(); const o = order(ref); if (!o) return null;
  if (o.paid) return "ALREADY";
  const id = String(coinid == null ? "" : coinid).toLowerCase();
  if (!id || id.length > 80) return null;
  o.coins = Array.isArray(o.coins) ? o.coins : [];
  if (o.coins.includes(id)) return null;
  ensureChecked(o);
  if (String(paidTokenid).toLowerCase() !== String(o.tokenid).toLowerCase()) {   // never counted, so never kept: a wrong coin seen again changes nothing
    const was = o.paidTokenid + "/" + o.status;   // no write for a coin that changes nothing (0.19.345)
    if (!o.paidAmount) o.paidTokenid = paidTokenid;   // shown only while no coin of the right token has come
    if (STATUS_RANK.WRONG_TOKEN > (STATUS_RANK[o.status] || 0)) o.status = "WRONG_TOKEN";
    if (o.paidTokenid + "/" + o.status !== was) flush();
    return "WRONG_TOKEN";
  }
  // Dust (0.19.200, as released 0.18.181 / 0.18.185) is not counted, not kept and not saved: it never fills the order's
  // MAX_PAY_COINS list, so a flood of tiny coins cannot push a later real payment past the cap, and it costs no disk write.
  // It is NOT remembered either: what is dust depends on what is still due, so the same coin is judged again later.
  // Gathered in memory (0.19.248): counted with the order's other dust once together they cover what is still due.
  if (isDust(o, paidAmount)) {
    if (!decParse(paidAmount)) return "DUST";
    pendAdd(ref, id, String(paidAmount));
    const out = settleDust(o, ref); if (out) { flush(); return out; }
    return "DUST";
  }
  if (o.coins.length >= MAX_PAY_COINS) {
    const was = o.status + "/" + o.problems.length;   // no write for a coin past the cap that changes nothing (0.19.345: 2000 old coins rewrote shop.json 1500 more times)
    if (!o.problems.includes(TOO_MANY_COINS)) { o.problems.push(TOO_MANY_COINS); o.due = ""; }
    if ((STATUS_RANK[o.status] || 0) <= STATUS_RANK.UNCHECKED) o.status = "UNCHECKED";   // from any state before PAID; never back from a vendor's
    if (o.status + "/" + o.problems.length !== was) flush();
    return "UNCHECKED";
  }
  pendDelete(ref, id); o.coins.push(id);
  o.paidAmount = decAdd(o.paidAmount || "0", paidAmount); o.paidTokenid = paidTokenid; o.paidAt = Date.now();
  let outcome = judge(o);
  if (outcome === "UNDERPAID") outcome = settleDust(o, ref) || outcome;   // the gathered dust may now cover what is left
  if (o.paid) PENDING_DUST.delete(ref);
  flush(); return outcome;
}
/** A second buyer sent an order with this order's reference (0.19.241, as released 0.18.208): it can no longer be paid
 *  automatically. An order the vendor confirmed or moved on (CONFIRMED, SHIPPED, DELIVERED), or checked by hand, is left as it is.
 *  One marked PAID and not moved on (0.19.344, as released 0.18.289) is held again: the payment that paid it may be the other buyer's
 *  (the reference is plain text on chain, so a copier's order can be the one held first), so it is unpaid, UNCHECKED, and moves on
 *  only once checked by hand. What was received stays counted on it. Nothing was sent for PAID: the buyer hears from CONFIRMED on. */
function flagDuplicate(ref, problem) {
  ensureLoaded(); const o = order(ref); if (!o || o.role !== "sell") return false;
  const unpay = o.status === "PAID" && !o.handChecked;
  if (!unpay && (o.paid || (STATUS_RANK[o.status] || 0) >= STATUS_RANK.PAID)) return false;
  ensureChecked(o); if (o.problems.includes(problem)) return false;
  o.problems = [problem].concat(o.problems); o.due = "";
  if (unpay) { o.paid = false; o.status = "UNCHECKED"; }
  else if (o.status !== "INQUIRY" && o.status !== "WRONG_TOKEN" && (STATUS_RANK[o.status] || 0) <= STATUS_RANK.UNCHECKED) o.status = "UNCHECKED";
  flush(); return true;
}
/** The vendor's explicit "I checked this order by hand" for an order that does not match the listing: only then can it
 *  be confirmed, shipped or delivered without being PAID. Nothing else changes (it is still not paid). */
function handCheck(ref) {
  ensureLoaded(); const o = order(ref);
  if (!o || o.role !== "sell") return false;
  // also an order an older version counted money for, and one whose older verdict was kept but that is not paid (0.19.247)
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

function clear() { mem = { shops: {}, orders: {}, chat: {}, meta: {} }; flush(); }
function exportAll() { ensureLoaded(); return { shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }; }

module.exports = {
  saveShop, shops, shop, deleteShop,
  upsertOrder, order, orders, refOrders, payee, setStatus, recordPayment, markOrderRead, handCheck, flagDuplicate, mayAdvance, ensureChecked,
  addChat, chat, setMeta, setMetaSync, getMeta, clear, exportAll, flush, setLog, log,
  _money: { decCmp, decGte, decAdd, decSub, payableTotal, isDust }, MAX_PAY_COINS, PENDING_MAX,
  _pendingDust: (ref) => { const p = PENDING_DUST.get(ref); return p ? { size: p.coins.size, sum: p.sum, min: p.min && p.min[1] } : null; }
};
