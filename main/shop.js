/*
 * shop.js — miniMall on-chain transport + orchestration (main process). Joins the SAME mainnet network as the
 * native com.eurobuddha miniMall Shop/Inbox apps: sealed order/status/reply messages ride 1-nano coins to the
 * shared MINIMERCH address in state[99] (privacy by encryption); payment is a separate ref-stamped value send to
 * the vendor's own address (state[1] = ref). Identity is the seed-derived "minimerch-*" sealed-box identity
 * (shopcrypto) — the same node also runs minimaMail under a different HKDF domain with no clash.
 *
 * Node = dumb transport; all crypto/keys stay here. The renderer only ever sees publicIds + decrypted order data.
 */
const EventEmitter = require("events");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const sc = require("./shopcrypto");
const store = require("./shop-store");

const MINIMERCH = "0x4D494E494D45524348";   // ASCII "MINIMERCH" — the shared order channel (matches native)
const MSG_AMOUNT = "0.000000001";
const MINIMA_TOKEN = "0x00";
const USDT_TOKEN = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const SHOP_KEY_ACCOUNT = "shop-identity";
const SCAN_EVERY_MS = 10000;
const POLL_DEPTH = 64;      // steady-state window (MINIMERCH is shared/busy — go deeper than mail's private channel)
const BACKFILL_MAX_DEPTH = 256;

const T = { ORDER: "ORDER", INQUIRY: "INQUIRY", REPLY: "REPLY", BUYER_REPLY: "BUYER_REPLY", STATUS_UPDATE: "STATUS_UPDATE" };

const emitter = new EventEmitter();
const seenMsgCoins = new Set();
const seenPayCoins = new Set();
let identity = null;         // {boxPk,boxSk,signPk,signSk,publicId}
let vendorAddress = "";      // my default receiving address (payments land here)
let scanTimer = null, lastTip = 0, scanning = false, backfilled = false;

let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) { return runner(cmd); }

function tokenFor(currency) { return String(currency).toUpperCase() === "USDT" || String(currency).toLowerCase() === "mxusdt" ? USDT_TOKEN : MINIMA_TOKEN; }
function randomId() { return crypto.randomBytes(16).toString("hex"); }
function looksLikeMinimaAddress(a) {
  a = String(a || "").trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}
/** Read a coin's state at `port` as a hex string, tolerating {"99":"0x.."} object and [{port,data}] array shapes. */
function statePort(coin, port) {
  const st = coin && coin.state;
  if (st == null) return null;
  if (Array.isArray(st)) { for (const e of st) if (String(e.port) === String(port)) return String(e.data || ""); return null; }
  if (typeof st === "object") { const v = st[String(port)]; return v == null ? null : String(v); }
  return null;
}
function hexToText(h) { try { return Buffer.from(String(h).replace(/^0x/i, ""), "hex").toString("utf8"); } catch (e) { return ""; } }
function coinAmount(coin) { return coin && (coin.tokenid && coin.tokenid !== "0x00" ? (coin.tokenamount || coin.amount) : coin.amount) || "0"; }

// ---- identity (derive once, cache in Keychain) ----
async function init() {
  if (identity) return identity;
  await sc.ready();
  const cached = config.getSecret(SHOP_KEY_ACCOUNT);
  if (cached) { try { identity = sc.loadIdentity(cached); } catch (e) { identity = null; } }
  if (!identity) {
    const r = await nodeCmd("vault action:seed");
    const resp = (r && r.response) || {};
    const seed = resp.seed || resp.phrase || "";
    if (!seed) throw new Error("Couldn't read the node seed (is the wallet unlocked?).");
    identity = await sc.deriveIdentity(seed);
    config.setSecret(sc.serializeIdentity(identity), SHOP_KEY_ACCOUNT);
  }
  try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; vendorAddress = gr.miniaddress || gr.address || ""; if (vendorAddress) store.setMeta("vendorAddress", vendorAddress); } catch (e) {}
  if (!vendorAddress) vendorAddress = store.getMeta("vendorAddress") || "";
  if (!store.getMeta("cn:merch")) { try { await nodeCmd("coinnotify action:add address:" + MINIMERCH); store.setMeta("cn:merch", true); } catch (e) {} }
  if (vendorAddress && !store.getMeta("cn:pay:" + vendorAddress)) { try { await nodeCmd("coinnotify action:add address:" + vendorAddress); store.setMeta("cn:pay:" + vendorAddress, true); } catch (e) {} }
  return identity;
}
/** On seed change (wallet restore) → drop the cached shop identity + local orders (different identity). */
function invalidateIdentity() {
  config.deleteSecret(SHOP_KEY_ACCOUNT);
  identity = null; vendorAddress = ""; backfilled = false; seenMsgCoins.clear(); seenPayCoins.clear();
  try { store.clear(); } catch (e) {}
}
function myIdentity() { return identity ? { publicId: identity.publicId, vendorAddress } : null; }
/** The Vendor Card the customer pastes into a shop-config: "0x<publicId>|<vendorAddress>" (native format). */
function vendorCard() { return identity ? identity.publicId + "|" + vendorAddress : ""; }

// ---- MerchMessage wire (JSON/UTF-8), matches native comms/MerchMessage ----
function toWire(m) {
  const o = { type: m.type, ref: m.ref, randomid: m.randomid, from: m.from, fromname: m.fromname || "",
    to: m.to, date: m.date, shopId: m.shopId || "", shopName: m.shopName || "" };
  if (m.type === T.ORDER || m.type === T.INQUIRY) {
    o.items = m.items || []; o.amount = m.amount || "0"; o.currency = m.currency || "Minima"; o.tokenid = m.tokenid || MINIMA_TOKEN;
    o.shipping = m.shipping || ""; o.delivery = m.delivery || ""; o.buyerPayaddr = m.buyerPayaddr || ""; o.message = m.message || "";
  } else if (m.type === T.STATUS_UPDATE) { o.status = m.status || "";
  } else { o.message = m.message || ""; }
  return Buffer.from(JSON.stringify(o), "utf8");
}
function parseWire(buf) { try { return JSON.parse(Buffer.from(buf).toString("utf8")); } catch (e) { return null; } }

// ---- send a sealed message to a peer via the MINIMERCH channel ----
async function sendMerchMessage(toPublicId, msg) {
  if (!sc.isValidPublicId(toPublicId)) throw new Error("Invalid recipient shop id.");
  const blob = await sc.seal(identity, toPublicId, toWire(msg));
  if (blob.length > 90000) throw new Error("Message too large for one coin (shrink any image).");
  const cmd = `send amount:${MSG_AMOUNT} address:${MINIMERCH} tokenid:0x00 state:${JSON.stringify({ "99": "0x" + blob })}`;
  const r = await nodeCmd(await pinMinimaSend(nodeCmd, cmd));
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "message send failed");
  return r;
}
/** Ref-stamped value payment to the vendor's own address (NOT the MINIMERCH channel). Mirrors mail.pay() safety:
 *  STRICT-validate amount + tokenid so nothing can be injected into the space-tokenised `send` (last-wins parser
 *  redirect class), node-verify the address before funds move, and flag an ambiguous (timed-out) send so a retry
 *  can't double-pay. */
async function sendPayment(vendorAddr, amount, tokenid, ref) {
  if (!looksLikeMinimaAddress(vendorAddr)) throw new Error("Invalid vendor address.");
  if (!(String(tokenid) === MINIMA_TOKEN || /^0x[0-9A-Fa-f]{64}$/.test(String(tokenid)))) throw new Error("Invalid token.");
  if (!/^[0-9]*\.?[0-9]+$/.test(String(amount)) || !(parseFloat(amount) > 0)) throw new Error("Invalid amount.");
  let chk; try { chk = await nodeCmd(`checkaddress address:${vendorAddr}`); } catch (e) { chk = null; }
  if (!chk || chk.status === false) throw new Error("Couldn't validate the vendor address — not sending.");
  const state = ref ? ` state:${JSON.stringify({ "1": "0x" + Buffer.from(ref, "utf8").toString("hex") })}` : "";
  const cmd = `send amount:${amount} address:${vendorAddr} tokenid:${tokenid}${state}`;
  let r;
  try { r = await nodeCmd(await pinMinimaSend(nodeCmd, cmd)); }
  catch (e) { const amb = new Error("Payment may have been submitted — check your balance/history before retrying."); amb.ambiguous = true; throw amb; }
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "payment failed");
  return r;
}

// ---- BUYER: place an order (seal ORDER → MINIMERCH, then the ref-stamped payment) ----
async function placeOrder(shopCfg, items, total, shipping, delivery, note) {
  await init();
  if (!sc.isValidPublicId(shopCfg.vendorPublicId)) throw new Error("This shop's vendor id is invalid.");
  if (!looksLikeMinimaAddress(shopCfg.vendorAddress)) throw new Error("This shop's payout address is invalid.");
  const ref = "ORD-" + randomId().slice(0, 8).toUpperCase();
  const tokenid = shopCfg.tokenid || tokenFor(shopCfg.currency);
  const msg = { type: T.ORDER, ref, randomid: randomId(), from: identity.publicId, to: shopCfg.vendorPublicId,
    date: Date.now(), shopId: shopCfg.shopId, shopName: shopCfg.shopName, items, amount: String(total),
    currency: shopCfg.currency, tokenid, shipping: shipping || "", delivery: delivery || "", buyerPayaddr: vendorAddress, message: note || "" };
  // local order first (role=buy) so a failed payment still shows with a retry
  store.upsertOrder({ ref, role: "buy", counterparty: shopCfg.vendorPublicId, shopId: shopCfg.shopId, shopName: shopCfg.shopName,
    items, amount: String(total), currency: shopCfg.currency, tokenid, shipping: shipping || "", delivery: delivery || "",
    status: "PENDING", paid: false, date: msg.date, unread: false });
  // stash the vendor address on the order so a retry never has to trust anything else
  const ord = store.order(ref); if (ord) ord.vendorAddress = shopCfg.vendorAddress;
  await sendMerchMessage(shopCfg.vendorPublicId, msg);
  let payTxpow = null, payError = null;
  try { const pr = await sendPayment(shopCfg.vendorAddress, String(total), tokenid, ref); payTxpow = (pr && pr.response && (pr.response.txpowid || pr.response.txpow)) || null; }
  catch (e) {
    payError = e.message || "payment failed";
    // AMBIGUOUS (timed-out but maybe accepted) must NOT get a one-click retry — that double-pays. Flag it apart
    // from a clean failure, which is safe to retry. Both flushed so the state survives a crash.
    if (e.ambiguous) store.setMetaSync("ambiguous:" + ref, true); else store.setMetaSync("unpaid:" + ref, true);
  }
  emitter.emit("update");
  return { ref, payError, payTxpow };
}
async function retryPayment(ref) {
  await init();
  const o = store.order(ref); if (!o || o.role !== "buy") throw new Error("Order not found.");
  if (store.getMeta("ambiguous:" + ref)) throw new Error("That payment may already have been sent — check your Balance/History before retrying, to avoid paying twice.");
  if (o.paid) throw new Error("This order is already paid.");
  const vendorAddr = o.vendorAddress || (store.shop(o.shopId) || {}).vendorAddress;
  if (!vendorAddr) throw new Error("Missing vendor address for retry.");
  let r;
  try { r = await sendPayment(vendorAddr, String(o.amount), o.tokenid, ref); }
  catch (e) { if (e.ambiguous) store.setMetaSync("ambiguous:" + ref, true); throw e; }   // a retry that itself times out → now ambiguous, block further retries
  store.setMetaSync("unpaid:" + ref, false); emitter.emit("update");
  return r;
}

// ---- VENDOR: advance an order's status (sends a sealed STATUS_UPDATE back to the buyer) ----
async function advanceStatus(ref, status) {
  await init();
  const o = store.order(ref); if (!o || o.role !== "sell") throw new Error("Order not found.");
  store.setStatus(ref, status);
  const msg = { type: T.STATUS_UPDATE, ref, randomid: randomId(), from: identity.publicId, to: o.counterparty, date: Date.now(), status };
  await sendMerchMessage(o.counterparty, msg);
  emitter.emit("update");
  return { ok: true };
}
async function reply(ref, text) {
  await init();
  const o = store.order(ref); if (!o) throw new Error("Order not found.");
  const type = o.role === "sell" ? T.REPLY : T.BUYER_REPLY;
  const msg = { type, ref, randomid: randomId(), from: identity.publicId, to: o.counterparty, date: Date.now(), message: text };
  store.addChat({ ref, randomid: msg.randomid, from: identity.publicId, to: o.counterparty, incoming: false, message: text, date: msg.date });
  await sendMerchMessage(o.counterparty, msg);
  emitter.emit("update");
  return { ok: true };
}

// ---- routing an opened inbound message ----
function routeIncoming(w, fromPublicId) {
  if (!w || w.from !== fromPublicId || !w.ref) return;   // envelope `from` must match the sealed sender (anti-spoof)
  if (typeof w.ref !== "string" || w.ref.length > 64) return;
  if (w.type === T.ORDER || w.type === T.INQUIRY) {
    if (!store.shop(w.shopId)) return;   // only accept orders/enquiries for a shop I actually authored — else any coin to my identity could inject bogus orders + flush-amplify
    const isNew = store.upsertOrder({ ref: w.ref, role: "sell", counterparty: fromPublicId, buyerName: String(w.fromname || "").slice(0, 64),
      shopId: w.shopId, shopName: (store.shop(w.shopId) || {}).shopName || String(w.shopName || ""), items: Array.isArray(w.items) ? w.items.slice(0, 40) : [], amount: String(w.amount || "0"), currency: w.currency === "USDT" ? "USDT" : "Minima",
      tokenid: tokenFor(w.currency), shipping: String(w.shipping || "").slice(0, 200), delivery: String(w.delivery || "").slice(0, 500), buyerPayaddr: String(w.buyerPayaddr || "").slice(0, 90),
      status: w.type === T.INQUIRY ? "INQUIRY" : "PENDING", paid: false, date: Number(w.date) || Date.now(), unread: true, note: String(w.message || "").slice(0, 1000) });
    if (isNew) emitter.emit("incoming", { ref: w.ref, shopName: w.shopName, amount: w.amount, currency: w.currency });
  } else if (w.type === T.STATUS_UPDATE) {
    const o = store.order(w.ref);
    if (o && o.role === "buy" && o.counterparty === fromPublicId) store.setStatus(w.ref, w.status);   // only the vendor I bought from can advance MY buy order
  } else if (w.type === T.REPLY || w.type === T.BUYER_REPLY) {
    const o = store.order(w.ref);
    if (o && o.counterparty === fromPublicId) store.addChat({ ref: w.ref, randomid: w.randomid, from: fromPublicId, to: identity.publicId, incoming: true, message: String(w.message || "").slice(0, 4000), date: Number(w.date) || Date.now() });
  }
}

// ---- scanners (adaptive depth: MINIMERCH is a network-wide shared address, so a deep query can exceed the node's
//      reply cap and return a non-array — shrink 256→…→4 until we get a real list, like mail.js, rather than miss all) ----
async function coinsAt(address, depth, extra) {
  let d = depth;
  while (d >= 4) {
    const r = await nodeCmd(`coins address:${address} simplestate:true${extra || ""} order:desc depth:${d}`);
    if (r && Array.isArray(r.response)) return r.response;
    d = Math.floor(d / 2);
  }
  return null;   // never got a usable reply → caller keeps its bookmark and retries next tick
}
function capSeen() { if (seenMsgCoins.size > 40000) seenMsgCoins.clear(); if (seenPayCoins.size > 40000) seenPayCoins.clear(); }
async function scanOrders(depth) {
  const coins = await coinsAt(MINIMERCH, depth); if (!coins) return false;
  capSeen();
  let changed = false;
  for (const c of coins) {
    const id = c.coinid; if (!id || seenMsgCoins.has(id)) continue; seenMsgCoins.add(id);
    const blobHex = statePort(c, 99); if (!blobHex) continue;
    const opened = await sc.open(identity, blobHex); if (!opened || !opened.valid) continue;   // not for me / bad sig
    routeIncoming(parseWire(opened.plaintext), opened.fromPublicId);
    changed = true;
  }
  return changed;
}
async function scanPayments(depth) {
  if (!vendorAddress) return false;
  const coins = await coinsAt(vendorAddress, depth, " relevant:true"); if (!coins) return false;
  capSeen();
  let changed = false;
  for (const c of coins) {
    const id = c.coinid; if (!id || seenPayCoins.has(id)) continue; seenPayCoins.add(id);
    const refHex = statePort(c, 1); if (!refHex) continue;
    const ref = hexToText(refHex); if (!ref) continue;
    const o = store.order(ref); if (!o || o.role !== "sell" || o.paid) continue;
    const outcome = store.recordPayment(ref, coinAmount(c), c.tokenid || MINIMA_TOKEN);
    if (outcome && outcome !== "ALREADY") { changed = true; emitter.emit("incoming", { ref, paid: outcome }); }
  }
  return changed;
}
async function scanOnce() {
  if (scanning || !identity) return;
  scanning = true;
  try {
    const depth = backfilled ? POLL_DEPTH : BACKFILL_MAX_DEPTH;
    const a = await scanOrders(depth).catch(() => false);
    const b = await scanPayments(depth).catch(() => false);
    backfilled = true;
    if (a || b) emitter.emit("update");
  } finally { scanning = false; }
}
async function startLoop() {
  await init();
  if (scanTimer) return;
  await scanOnce();
  scanTimer = setInterval(async () => {
    try { const r = await nodeCmd("block"); const tip = parseInt((r && r.response && (r.response.block != null ? r.response.block : r.response)), 10) || 0;
      if (tip !== lastTip) { lastTip = tip; await scanOnce(); } } catch (e) {}
  }, SCAN_EVERY_MS);
}
function stopLoop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

// ---- read-model for the renderer ----
function myShops() { return store.shops(); }
function saveShop(cfg) { store.saveShop(cfg); emitter.emit("update"); return cfg; }
function deleteShop(shopId) { store.deleteShop(shopId); emitter.emit("update"); }
function ordersList() {
  return store.orders().map(o => ({ ref: o.ref, role: o.role, shopId: o.shopId, shopName: o.shopName, status: o.status,
    amount: o.amount, currency: o.currency, tokenid: o.tokenid, paid: !!o.paid, date: o.date, unread: !!o.unread,
    unpaid: !!store.getMeta("unpaid:" + o.ref), ambiguous: !!store.getMeta("ambiguous:" + o.ref) })).sort((a, b) => (b.date || 0) - (a.date || 0));
}
function orderDetail(ref) {
  const o = store.order(ref); if (!o) return null; store.markOrderRead(ref);
  return { order: o, chat: store.chat(ref), unpaid: !!store.getMeta("unpaid:" + ref), ambiguous: !!store.getMeta("ambiguous:" + ref) };
}
function newOrderCount() { return store.orders().filter(o => o.role === "sell" && o.unread).length; }

module.exports = {
  emitter, init, invalidateIdentity, myIdentity, vendorCard, startLoop, stopLoop, scanOnce,
  myShops, saveShop, deleteShop, ordersList, orderDetail, newOrderCount,
  placeOrder, retryPayment, advanceStatus, reply,
  _setRunner, MINIMERCH, USDT_TOKEN, tokenFor
};
