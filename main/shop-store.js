/*
 * shop-store.js — persistent local store for miniMall (my shops / orders / order-chat / meta), mirroring the
 * native com.eurobuddha.comms MerchDb. The node prunes coins, so this local store is the source of truth.
 * Orders dedup on `ref`; chat dedups on `randomid`. Atomic tmp+rename writes, debounced. JSON (modest volume).
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const WRITE_DEBOUNCE_MS = 300;

let mem = null;   // { shops:{shopId:cfg}, orders:{ref:order}, chat:{randomid:msg}, meta:{} }
let writeTimer = null;

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
      fs.renameSync(tmp, filePath());
    } catch (e) {}
  }, WRITE_DEBOUNCE_MS);
}
function flush() {   // synchronous — for fund-relevant writes (a recorded order/payment must survive a crash)
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "shop.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }));
    fs.renameSync(tmp, filePath());
  } catch (e) {}
}

// ---- shops (my authored catalogs) ----
function saveShop(cfg) { ensureLoaded(); mem.shops[cfg.shopId] = cfg; persistSoon(); }
function shops() { ensureLoaded(); return Object.values(mem.shops); }
function shop(shopId) { ensureLoaded(); return mem.shops[shopId] || null; }
function deleteShop(shopId) { ensureLoaded(); if (mem.shops[shopId]) { delete mem.shops[shopId]; persistSoon(); } }

// ---- decimal-safe money (BigInt; NEVER float — amounts are decimal strings up to 44dp) ----
function decCmp(a, b) {
  const [ai = "0", af = ""] = String(a == null ? "0" : a).split(".");
  const [bi = "0", bf = ""] = String(b == null ? "0" : b).split(".");
  const dp = Math.max(af.length, bf.length);
  let A, B; try { A = BigInt((ai || "0") + af.padEnd(dp, "0")); B = BigInt((bi || "0") + bf.padEnd(dp, "0")); } catch (e) { return 0; }
  return A < B ? -1 : A > B ? 1 : 0;
}
function decGte(a, b) { return decCmp(a, b) >= 0; }
function decAdd(a, b) {
  const [ai = "0", af = ""] = String(a == null ? "0" : a).split(".");
  const [bi = "0", bf = ""] = String(b == null ? "0" : b).split(".");
  const dp = Math.max(af.length, bf.length);
  let sum; try { sum = BigInt((ai || "0") + af.padEnd(dp, "0")) + BigInt((bi || "0") + bf.padEnd(dp, "0")); } catch (e) { return String(a || "0"); }
  const str = sum.toString().padStart(dp + 1, "0");
  return dp ? str.slice(0, -dp) + "." + str.slice(-dp) : str;
}

// ---- orders (dedup on ref; never regress a progressed status) ----
const STATUS_RANK = { PENDING: 0, INQUIRY: 0, UNDERPAID: 1, WRONG_TOKEN: 1, PAID: 2, CONFIRMED: 3, SHIPPED: 4, DELIVERED: 5 };
/** Insert an order if new (dedup on ref). Returns true if newly inserted. Never overwrites an existing order. */
function upsertOrder(o) {
  ensureLoaded();
  if (mem.orders[o.ref]) return false;
  mem.orders[o.ref] = o;
  flush();   // fund-relevant: an incoming order must survive a crash
  return true;
}
function order(ref) { ensureLoaded(); return mem.orders[ref] || null; }
function orders() { ensureLoaded(); return Object.values(mem.orders); }
/** Set status only if it STRICTLY advances (higher rank) — an out-of-order/malicious STATUS_UPDATE can't roll back. */
function setStatus(ref, status) {
  ensureLoaded(); const o = mem.orders[ref]; if (!o) return false;
  const cur = STATUS_RANK[o.status] != null ? STATUS_RANK[o.status] : 0;
  const nxt = STATUS_RANK[status] != null ? STATUS_RANK[status] : 0;
  if (nxt <= cur) return false;
  o.status = status; flush(); return true;
}
/** Record a matched payment against an order. Accumulates across coins (decimal-safe); PAID iff token matches AND
 *  the CUMULATIVE paid amount >= the order amount. Never clobbers a vendor-progressed status (CONFIRMED+). */
function recordPayment(ref, paidAmount, paidTokenid) {
  ensureLoaded(); const o = mem.orders[ref]; if (!o) return null;
  if (o.paid) return "ALREADY";
  if (String(paidTokenid).toLowerCase() !== String(o.tokenid).toLowerCase()) {
    o.paidTokenid = paidTokenid;
    if (STATUS_RANK.WRONG_TOKEN > (STATUS_RANK[o.status] || 0)) o.status = "WRONG_TOKEN";
    flush(); return "WRONG_TOKEN";
  }
  o.paidAmount = decAdd(o.paidAmount || "0", paidAmount); o.paidTokenid = paidTokenid; o.paidAt = Date.now();
  const outcome = decGte(o.paidAmount, o.amount) ? "PAID" : "UNDERPAID";
  if (outcome === "PAID") o.paid = true;
  if ((STATUS_RANK[outcome] || 0) > (STATUS_RANK[o.status] || 0)) o.status = outcome;   // advance, never downgrade CONFIRMED+
  flush(); return outcome;
}
function markOrderRead(ref) { ensureLoaded(); const o = mem.orders[ref]; if (o && o.unread) { o.unread = false; persistSoon(); return true; } return false; }
function setMeta(k, v) { ensureLoaded(); mem.meta[k] = v; persistSoon(); }
function setMetaSync(k, v) { ensureLoaded(); mem.meta[k] = v; flush(); }   // fund-relevant flags (unpaid/ambiguous) must survive a crash
function getMeta(k) { ensureLoaded(); return mem.meta[k]; }

// ---- order chat (dedup on randomid) ----
function addChat(m) { ensureLoaded(); if (mem.chat[m.randomid]) return false; mem.chat[m.randomid] = m; persistSoon(); return true; }
function chat(ref) { ensureLoaded(); return Object.values(mem.chat).filter(m => m.ref === ref).sort((a, b) => (a.date || 0) - (b.date || 0)); }

function clear() { mem = { shops: {}, orders: {}, chat: {}, meta: {} }; flush(); }
function exportAll() { ensureLoaded(); return { shops: mem.shops, orders: mem.orders, chat: mem.chat, meta: mem.meta }; }

module.exports = {
  saveShop, shops, shop, deleteShop,
  upsertOrder, order, orders, setStatus, recordPayment, markOrderRead,
  addChat, chat, setMeta, setMetaSync, getMeta, clear, exportAll, flush
};
