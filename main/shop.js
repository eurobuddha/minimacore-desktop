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
const { rpcCall } = require("./rpc"), { oneCommand } = require("./cmdverb");
const { pinMinimaSend } = require("./sendpin");
const sc = require("./shopcrypto");
const store = require("./shop-store");
const listing = require("./shop-listing");
const SHOP = require("../renderer/apps-act.js").shop;   // the one rule for which token a shop is paid in, and what a plain amount is (shared with the screens)

const MINIMERCH = "0x4D494E494D45524348";   // ASCII "MINIMERCH" — the shared order channel (matches native)
const MSG_AMOUNT = "0.000000001";
const MINIMA_TOKEN = "0x00";
const MXUSD_TOKEN = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
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
let scanTimer = null, lastTip = 0, scanning = false, backfilled = false, lastPassFailed = false, lastStepFailed = false;
// Refs whose payment is at the node in THIS process right now (0.19.265): a send can take up to the RPC's write timeout, and
// while it runs "not sent" and Retry are refused (they cleared the in-flight mark and paid a second time while the first was live).
const sending = new Set();
const SENDING = "This payment is being sent to the node now. Wait for its answer.";
// A buy order the vendor has moved to PAID or on (CONFIRMED, SHIPPED, DELIVERED): the payment arrived (0.19.265). A buy order's
// own `paid` is never set (only the vendor's store counts coins), so its status is what says it.
const ACKED = new Set(["PAID", "CONFIRMED", "SHIPPED", "DELIVERED"]);
const acked = (o) => !!(o && (o.paid || ACKED.has(o.status)));

let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) { return runner(oneCommand(cmd)); }   // ONE command each (main/rpc.js, 0.19.194)

function tokenFor(currency) { return String(currency).toUpperCase() === "USDT" || String(currency).toLowerCase() === "mxusdt" ? MXUSD_TOKEN : MINIMA_TOKEN; }
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
  // The stored vendor address is kept (0.19.232): getaddress only the first time. A shop already handed out names that
  // address, and a later getaddress could return another one, whose payments were then never read.
  vendorAddress = store.getMeta("vendorAddress") || "";
  if (!vendorAddress) { try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; vendorAddress = gr.miniaddress || gr.address || ""; if (vendorAddress) store.setMeta("vendorAddress", vendorAddress); } catch (e) {} }
  if (!store.getMeta("cn:merch")) { try { await nodeCmd("coinnotify action:add address:" + MINIMERCH); store.setMeta("cn:merch", true); } catch (e) {} }
  for (const a of payAddresses()) if (!store.getMeta("cn:pay:" + a)) { try { await nodeCmd("coinnotify action:add address:" + a); store.setMeta("cn:pay:" + a, true); } catch (e) {} }
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
  const r = await nodeCmd(await pinMinimaSend(nodeCmd, cmd, { minCoinage: 3 }));
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
  if (!/^\d+(\.\d+)?$/.test(String(amount)) || !/[1-9]/.test(String(amount))) throw new Error("Invalid amount.");   // a plain decimal above zero: no sign, no exponent
  let chk; try { chk = await nodeCmd(`checkaddress address:${vendorAddr}`); } catch (e) { chk = null; }
  if (!chk || chk.status === false) throw new Error("Couldn't validate the vendor address — not sending.");
  const state = ref ? ` state:${JSON.stringify({ "1": "0x" + Buffer.from(ref, "utf8").toString("hex") })}` : "";
  const cmd = `send amount:${amount} address:${vendorAddr} tokenid:${tokenid}${state}`;
  let r;
  try { r = await nodeCmd(await pinMinimaSend(nodeCmd, cmd, { minCoinage: 3 })); }
  catch (e) { const amb = new Error("Payment may have been submitted — check your balance/history before retrying."); amb.ambiguous = true; throw amb; }
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "payment failed");
  return r;
}

// ---- BUYER: place an order (seal ORDER → MINIMERCH, then the ref-stamped payment) ----
async function placeOrder(shopCfg, items, total, shipping, delivery, note) {
  // The token paid is the one the shop's CURRENCY names, never the file's own tokenid: a .shop that says "Minima" and
  // carries another token's id is refused here, whatever screen (or stored shop) it came from (0.19.118).
  const tok = SHOP.token(shopCfg || {}); if (tok.err) throw new Error(tok.err);
  const tokenid = tok.tokenid;
  if (!/^\d+(\.\d+)?$/.test(String(total)) || !/[1-9]/.test(String(total))) throw new Error("Invalid amount.");   // before the order message is sent
  await init();
  if (!sc.isValidPublicId(shopCfg.vendorPublicId)) throw new Error("This shop's vendor id is invalid.");
  if (!looksLikeMinimaAddress(shopCfg.vendorAddress)) throw new Error("This shop's payout address is invalid.");
  const ref = "ORD-" + randomId().slice(0, 8).toUpperCase();
  const msg = { type: T.ORDER, ref, randomid: randomId(), from: identity.publicId, to: shopCfg.vendorPublicId,
    date: Date.now(), shopId: shopCfg.shopId, shopName: shopCfg.shopName, items, amount: String(total),
    currency: shopCfg.currency, tokenid, shipping: shipping || "", delivery: delivery || "", buyerPayaddr: vendorAddress, message: note || "" };
  // local order first (role=buy) so a failed payment still shows with a retry.
  // The vendor address goes in HERE, in the object upsertOrder persists — stashing it afterwards with
  // `store.order(ref).vendorAddress = …` only mutated the in-memory row and never flushed, so a crash before
  // the next unrelated write lost it and retryPayment fell back to store.shop(), which is exactly the source
  // this stash exists to avoid trusting. The ambiguity flags either side of it already use setMetaSync.
  store.upsertOrder({ ref, role: "buy", counterparty: shopCfg.vendorPublicId, shopId: shopCfg.shopId, shopName: shopCfg.shopName,
    items, amount: String(total), currency: shopCfg.currency, tokenid, shipping: shipping || "", delivery: delivery || "",
    vendorAddress: shopCfg.vendorAddress,
    status: "PENDING", paid: false, date: msg.date, unread: false });
  await sendMerchMessage(shopCfg.vendorPublicId, msg);
  let payTxpow = null, payError = null;
  // In flight, on disk, until the node answers (0.19.241, as released 0.18.208): a quit or crash during the send leaves it set,
  // and a retry is then refused as "may already have been sent" instead of paying a second time.
  store.setMetaSync("inflight:" + ref, true); sending.add(ref);
  try { const pr = await sendPayment(shopCfg.vendorAddress, String(total), tokenid, ref); payTxpow = (pr && pr.response && (pr.response.txpowid || pr.response.txpow)) || null; store.setMetaSync("unpaid:" + ref, false); store.setMetaSync("inflight:" + ref, false); }
  catch (e) {
    if (!e.ambiguous) store.setMetaSync("inflight:" + ref, false);
    payError = e.message || "payment failed";
    // AMBIGUOUS (timed-out but maybe accepted) must NOT get a one-click retry — that double-pays. Flag it apart
    // from a clean failure, which is safe to retry. Both flushed so the state survives a crash.
    if (e.ambiguous) store.setMetaSync("ambiguous:" + ref, true); else store.setMetaSync("unpaid:" + ref, true);
  } finally { sending.delete(ref); }
  emitter.emit("update");
  return { ref, payError, payTxpow };
}
async function retryPayment(ref) {
  await init();
  const o = store.order(ref); if (!o || o.role !== "buy") throw new Error("Order not found.");
  if (sending.has(ref)) throw new Error(SENDING);
  if (acked(o)) throw new Error("This order is already paid.");
  if (store.getMeta("ambiguous:" + ref) || store.getMeta("inflight:" + ref)) throw new Error("That payment may already have been sent — check your Balance/History before retrying, to avoid paying twice.");
  // A retry only after a payment the node refused (0.19.241, as released 0.18.208): no "unpaid" mark, no second payment.
  if (!store.getMeta("unpaid:" + ref)) throw new Error("This order has no refused payment to retry. Check your Balance/History.");
  const tok = SHOP.token(o); if (tok.err) throw new Error(tok.err);   // an order placed before 0.19.118 with a shop whose token did not match its currency
  const vendorAddr = o.vendorAddress || (store.shop(o.shopId) || {}).vendorAddress;
  if (!vendorAddr) throw new Error("Missing vendor address for retry.");
  let r;
  store.setMetaSync("inflight:" + ref, true); sending.add(ref);
  try { r = await sendPayment(vendorAddr, String(o.amount), o.tokenid, ref); }
  catch (e) { if (e.ambiguous) store.setMetaSync("ambiguous:" + ref, true); else store.setMetaSync("inflight:" + ref, false); throw e; }   // a retry that itself times out → now ambiguous, block further retries
  finally { sending.delete(ref); }
  store.setMetaSync("unpaid:" + ref, false); store.setMetaSync("inflight:" + ref, false); emitter.emit("update");
  return r;
}

// ---- VENDOR: advance an order's status (sends a sealed STATUS_UPDATE back to the buyer) ----
async function advanceStatus(ref, status) {
  const o = store.order(ref); if (!o || o.role !== "sell") throw new Error("Order not found.");
  store.ensureChecked(o);
  // Only the order's one legitimate next step, by the rule the screen draws its buttons from (SHOP.nextStatus, 0.19.171):
  // CONFIRMED, then SHIPPED, then DELIVERED, and only for an order paid by what my listing says is due or one I checked
  // by hand (0.19.166). Before, any state was accepted here and sent to the buyer: PAID on an unpaid order, a jump, a word.
  const next = SHOP.nextStatus(o);
  if (!next || status !== next) {
    if (!store.mayAdvance(o) && o.problems.length) throw new Error("This order is not paid by what your shop says is due. Check it by hand first.");
    throw new Error("That is not this order's next step.");
  }
  await init();
  store.setStatus(ref, status);
  const msg = { type: T.STATUS_UPDATE, ref: o.wireRef || ref, randomid: randomId(), from: identity.publicId, to: o.counterparty, date: Date.now(), status };
  await sendMerchMessage(o.counterparty, msg);
  emitter.emit("update");
  return { ok: true };
}
async function reply(ref, text) {
  await init();
  const o = store.order(ref); if (!o) throw new Error("Order not found.");
  const type = o.role === "sell" ? T.REPLY : T.BUYER_REPLY;
  const msg = { type, ref: o.wireRef || ref, randomid: randomId(), from: identity.publicId, to: o.counterparty, date: Date.now(), message: text };
  store.addChat({ ref, randomid: msg.randomid, from: identity.publicId, to: o.counterparty, incoming: false, message: text, date: msg.date });
  await sendMerchMessage(o.counterparty, msg);
  emitter.emit("update");
  return { ok: true };
}

// ---- routing an opened inbound message ----
// What another party sends is kept only as capped primitives (0.19.168): a value that is not a string or a finite number
// becomes "" (or is left out), so no structure of theirs ever reaches the store. Items nested 12,000 arrays deep made
// every save of shop.json throw (and nothing was saved again); String() or Number() of one throws as well.
const txt = (v, n) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "").slice(0, n);
const num = (v, n) => (typeof v === "number" && Number.isFinite(v) ? v : txt(v, n));
const when = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : /^\d{1,15}$/.test(txt(v, 15)) ? Number(v) : Date.now());
/** One order line as stored: the fields a line has, each a capped primitive; anything that is not an object is null. */
function itemLine(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  const line = { product: txt(it.product, 200), quantity: num(it.quantity, 20), unitPrice: txt(it.unitPrice, 64), lineTotal: txt(it.lineTotal, 64) };
  if (it.size != null) line.size = txt(it.size, 60);
  if (it.nftTokenId != null) line.nftTokenId = txt(it.nftTokenId, 80);
  if (it.nftStateIdx != null) line.nftStateIdx = num(it.nftStateIdx, 12);
  if (it.nftBundle != null) line.nftBundle = num(it.nftBundle, 12);
  return line;
}
/** Where a second buyer's order with an already used reference is kept: the reference and that buyer's whole id. */
function dupKey(ref, fromPublicId) { return ref + "~" + fromPublicId; }
function routeIncoming(w, fromPublicId) {
  if (!w || w.from !== fromPublicId || !w.ref) return;   // envelope `from` must match the sealed sender (anti-spoof)
  if (typeof w.ref !== "string" || w.ref.length > 64) return;
  if (w.type === T.ORDER || w.type === T.INQUIRY) {
    if (typeof w.shopId !== "string") return;
    const own = store.shop(w.shopId);
    if (!own) return;   // only accept orders/enquiries for a shop I actually authored — else any coin to my identity could inject bogus orders + flush-amplify
    // The token this order must be paid in is MY shop's, never the currency the buyer wrote (0.19.165, released 0.18.151):
    // a buyer who wrote "Minima" on an order to an MxUSD shop had it marked paid by a payment in Minima.
    const tokenid = tokenFor(own.currency);
    // What it is due is worked out from MY listing, never the buyer's total (0.19.166, released 0.18.159). items: an
    // array (this desktop) or a JSON array string (the phone's wire shape); either is kept as an array.
    const items = (listing.itemsOf(w.items) || []).slice(0, 40).map(itemLine), shipping = txt(w.shipping, 200), buyerCurrency = txt(w.currency, 20);
    const chk = listing.check(own, { items, shipping, currency: buyerCurrency });
    // The same reference from a second buyer (0.19.241, as released 0.18.208): it was dropped, and a payment carrying that
    // reference was counted for whichever order came first. Both are kept, and neither is paid automatically: a payment
    // cannot be told apart. The second is kept under the reference and that buyer's whole id; what it sends back keeps the wire ref.
    const prior = store.order(w.ref), problems = chk.problems.slice(0, 20).map(p => String(p).slice(0, 300));
    let ref = w.ref, wireRef;
    if (prior && prior.counterparty !== fromPublicId) {
      if (store.order(dupKey(w.ref, fromPublicId))) return;   // this buyer's copy is already kept
      const DUP = "another buyer sent an order with the same reference " + w.ref + ": a payment with it cannot be told apart, so check both orders by hand";
      store.flagDuplicate(w.ref, DUP);
      problems.unshift(DUP); wireRef = w.ref; ref = dupKey(w.ref, fromPublicId);
    }
    const isNew = store.upsertOrder({ ref, wireRef, role: "sell", counterparty: fromPublicId, buyerName: txt(w.fromname, 64),
      shopId: w.shopId, shopName: own.shopName || txt(w.shopName, 200), items, amount: txt(w.amount, 64) || "0", buyerCurrency,
      due: problems.length ? "" : chk.due, problems, currency: tokenid === MXUSD_TOKEN ? "USDT" : "Minima",
      tokenid, shipping, delivery: txt(w.delivery, 500), buyerPayaddr: txt(w.buyerPayaddr, 90),
      status: w.type === T.INQUIRY ? "INQUIRY" : problems.length ? "UNCHECKED" : "PENDING", paid: false, date: when(w.date), unread: true, note: txt(w.message, 1000) });
    if (isNew) emitter.emit("incoming", { ref, shopName: own.shopName, amount: problems.length ? "" : chk.due, currency: tokenid === MXUSD_TOKEN ? "MxUSD" : "Minima" });
  } else if (w.type === T.STATUS_UPDATE) {
    const o = store.order(w.ref);
    if (o && o.role === "buy" && o.counterparty === fromPublicId) store.setStatus(w.ref, txt(w.status, 20));   // only the vendor I bought from can advance MY buy order
  } else if (w.type === T.REPLY || w.type === T.BUYER_REPLY) {
    let o = store.order(w.ref); const randomid = txt(w.randomid, 64);
    if (o && o.counterparty !== fromPublicId) o = store.order(dupKey(w.ref, fromPublicId));   // the second buyer's copy
    if (o && randomid && o.counterparty === fromPublicId) store.addChat({ ref: o.ref, randomid, from: fromPublicId, to: identity.publicId, incoming: true, message: txt(w.message, 4000), date: when(w.date) });
  }
}

// ---- scanners (adaptive depth: MINIMERCH is a network-wide shared address, so a deep query can exceed the node's
//      reply cap and return a non-array — shrink 256→…→4 until we get a real list, like mail.js, rather than miss all) ----
let served = 0;   // the smallest depth the node really served in this pass or step (0.19.328, as released 0.18.213's passServed)
async function coinsAt(address, depth, extra) {
  let d = depth;
  while (d >= 4) {
    const r = await nodeCmd(`coins address:${address} simplestate:true${extra || ""} order:desc depth:${d}`);
    if (r && Array.isArray(r.response)) { served = Math.min(served, d); return r.response; }
    d = Math.floor(d / 2);
  }
  return null;   // never got a usable reply → caller keeps its bookmark and retries next tick
}
const above = (c, floor) => floor > 0 && Number(c && c.created) > floor;   // already read by an earlier pass: a backfill step skips it (0.19.328)
function capSeen() { if (seenMsgCoins.size > 40000) seenMsgCoins.clear(); if (seenPayCoins.size > 40000) seenPayCoins.clear(); }
async function scanOrders(depth, floor) {
  const all = await coinsAt(MINIMERCH, depth); if (!all) return null;   // null: not read (the cursor stays)
  const coins = all.filter(c => !above(c, floor));
  capSeen();
  let changed = false;
  for (const c of coins) {
    const id = c.coinid; if (!id || seenMsgCoins.has(id)) continue; seenMsgCoins.add(id);
    try {   // one coin at a time: whatever one message holds, the others in the batch are still read (0.19.168)
      const blobHex = statePort(c, 99); if (!blobHex) continue;
      const opened = await sc.open(identity, blobHex); if (!opened || !opened.valid) continue;   // not for me / bad sig
      routeIncoming(parseWire(opened.plaintext), opened.fromPublicId);
      changed = true;
    } catch (e) { store.log("miniMall: an order channel coin could not be read (" + String(id).slice(0, 80) + "): " + ((e && e.message) || e)); }
  }
  return changed;
}
/** Every address payments to my shops land on (0.19.232): the vendor address and each stored shop's own payout address. */
function payAddresses() {
  const out = new Set(); if (vendorAddress) out.add(vendorAddress);
  for (const s of store.shops()) if (s && looksLikeMinimaAddress(s.vendorAddress)) out.add(String(s.vendorAddress));
  return [...out];
}
/** Can this payout address never be valid (0.19.284)? Decided here, never from a node error: an Mx whose checksum is wrong (the
 *  node's own Address.convertMinimaAddress: SHA3 of the 32-byte address, as main/futurecash.js mxToHex reads it), or an 0x that is
 *  not 64 hexadecimal digits (checkaddress's length rule). 0.19.273 took any status:false of checkaddress for "invalid", and a
 *  wallet error during a resync or a restore then skipped a real payout address for the whole session. */
function badAddress(a) {
  a = String(a == null ? "" : a).trim();
  if (/^0x/i.test(a)) return !/^0x[0-9a-fA-F]{64}$/.test(a);
  return !/^M[xX]/.test(a) || !require("./futurecash").mxToHex(a);
}
// Payout addresses that can never be valid and whose coins the node did not list: skipped for SKIP_MS, logged whole, said on the
// Inbox (scanState). Not read as "not answered", which held the cursor for good and read the widest window on every pass.
const SKIP_MS = 5 * 60000, skippedPay = new Map();   // address -> skipped until
const skipping = (a) => (skippedPay.get(a) || 0) > Date.now();
async function scanPayments(depth, floor) {
  const addrs = payAddresses().filter(a => !skipping(a)); if (!addrs.length) return false;
  let listed = [], any = false;
  let missed = false;   // one payout address the node did not answer for: what was read is judged, but the pass is not covered (0.19.249)
  for (const a of addrs) {
    const got = await coinsAt(a, depth, " relevant:true");
    if (got) { any = true; listed = listed.concat(got.filter(c => !above(c, floor))); continue; }
    if (badAddress(a)) { skippedPay.set(a, Date.now() + SKIP_MS); store.log("miniMall: the payout address " + a + " is not a valid Minima address, so payments to it are not read (looked at again in 5 minutes). Correct it in miniMall Studio (the shop's payout address)."); any = true; continue; }
    missed = true;
  }
  if (!any) return null;
  capSeen();
  // Oldest first (0.19.200, as released 0.18.185; the node lists newest first): a top-up is judged after the payment it
  // completes. Within one block the larger coin first, so the remainder comes last.
  const coins = listed.map((c, i) => ({ c, i })).sort((a, b) => (Number(a.c && a.c.created) || 0) - (Number(b.c && b.c.created) || 0)
    || (b.c && a.c && b.c.amount != null && a.c.amount != null ? (Number(coinAmount(b.c)) - Number(coinAmount(a.c))) : 0) || (b.i - a.i)).map(x => x.c);
  let changed = false;
  const judge = (c) => {
    const id = c && c.coinid; if (!id || seenPayCoins.has(id)) return "";
    try {   // one coin at a time (0.19.168)
      const refHex = statePort(c, 1); if (!refHex) { seenPayCoins.add(id); return ""; }
      const ref = hexToText(refHex); if (!ref) { seenPayCoins.add(id); return ""; }
      // Not marked seen while its order is not here yet (0.19.174, as released 0.18.163): a payment mined before its
      // order message was skipped for the rest of the session. It is read again on the next scan; the store counts it once.
      const o = store.order(ref); if (!o) return "";
      seenPayCoins.add(id);
      if (o.role !== "sell" || o.paid) return "";
      const outcome = store.recordPayment(ref, id, coinAmount(c), c.tokenid || MINIMA_TOKEN);   // the coin id: each coin counted once, also after a restart
      if (outcome === "DUST") seenPayCoins.delete(id);   // judged again later, against what is then still due (0.19.200)
      if (outcome && outcome !== "ALREADY" && outcome !== "DUST") { changed = true; emitter.emit("incoming", { ref, paid: outcome }); }
      return outcome || "";
    } catch (e) { store.log("miniMall: a payment coin could not be read (" + String(id).slice(0, 80) + "): " + ((e && e.message) || e)); return ""; }
  };
  // One pass oldest first, then one more over this scan's dust if anything counted (a top-up older than the payment it completes).
  const dust = coins.filter(c => judge(c) === "DUST");
  if (changed && dust.length) for (const c of dust) judge(c);
  return missed ? null : changed;
}
/** How many blocks a pass asks for (0.19.232, mail.js's depthForGap): the gap since the last scanned tip (saved, so it
 *  survives a quit) plus a margin, never below the steady window, never past one pass's ceiling. What is older is read by the
 *  stepped backfill (0.19.328, as released 0.18.206 / 0.18.213): one step per pass, each reaching BACKFILL_CHUNK blocks deeper than
 *  the last (one pass's ceiling), skipping what an earlier pass read, until the gap is read or the node serves no deeper. */
const WINDOW_DEPTH = 4096, GAP_MARGIN = 16, BACKFILL_CHUNK = WINDOW_DEPTH;
function depthForGap(tip, prevTip) { if (!prevTip) return BACKFILL_MAX_DEPTH; const gap = Math.max(0, tip - prevTip); return Math.min(WINDOW_DEPTH, Math.max(POLL_DEPTH, gap + GAP_MARGIN)); }
// How deep the node can list coins at all (0.19.330). `coins address:` walks the node's in-memory block tree from the tip to its root
// (TxPoWSearcher.searchCoins: tip.getParent() until null, the depth counted in tree blocks; core e64600285be) and answers any deeper
// depth with a LIST of what the tree holds, not a refusal: a deeper read looked complete and the backfill "finished" over blocks it
// never saw. The tree is cut when it reaches 1124 blocks and shrinks back to 1024 (TxPoWProcessor: MINIMA_CASCADE_START_DEPTH 1024 +
// MINIMA_CASCADE_FREQUENCY 100), and at each cut the new root receives every RELEVANT unspent coin of what was cut
// (copyParentRelevantCoins): a read that reaches the root lists this wallet's unspent payments of any age, while ORDERS on the shared
// channel and payments already spent are gone past the tree. status's chain.length is the branch's length (getHeaviestBranchLength):
// every read is capped there, a payments read of that depth reaches the root, and a gap whose floor is at least that far below the tip
// is past the tree. (A node
// started with -megammr adds every unspent coin of its MegaMMR to `coins … megammr:true` once the tree is walked, whatever their age:
// this app does not ask for that, and the node runs -megammr only when the Web Wallet switched it on.) 0 = not read.
async function treeLength() {
  try { const r = await nodeCmd("status"); const l = Number(r && r.response && r.response.chain && r.response.chain.length); return Number.isSafeInteger(l) && l > 0 ? l : 0; } catch (e) { return 0; }
}
async function currentBlock() { try { const b = await nodeCmd("block"); return parseInt((b && b.response && (b.response.block != null ? b.response.block : b.response)), 10) || 0; } catch (e) { return 0; } }
async function scanOnce() {
  if (scanning || !identity) return;
  scanning = true;
  try {
    const tip = await currentBlock(), prev = Number(store.getMeta("scanned_tip_block") || 0);
    const meta = (k) => Number(store.getMeta(k)) || 0;
    let depth = tip ? depthForGap(tip, prev) : (backfilled ? POLL_DEPTH : BACKFILL_MAX_DEPTH);
    // reads deeper than the steady window, and every backfill step, are capped at the node's block tree (0.19.330); unread: nothing moves
    const len = tip && (depth > POLL_DEPTH || meta("backfill_target_block")) ? await treeLength() : -1;
    if (len > 0) depth = Math.min(depth, len);
    served = depth;
    const a = await scanOrders(depth).catch(() => null);
    const b = await scanPayments(depth).catch(() => null);
    backfilled = true;
    // A failed read advances nothing (0.19.249, as released 0.18.213): only a pass that read both, at every payout address,
    // moves the cursor; the same blocks are read on the next pass. What could not be read is said on the Inbox (scanState).
    let failed = !tip || len === 0 || a === null || b === null, stepFailed = false, changed = !!(a || b);   // the tree's length unread: what was read is judged, nothing moves
    const bf0 = meta("backfill_target_block") + "/" + meta("backfill_floor_block") + "/" + meta("unread_below_block");
    if (!failed) {
      const covered = tip - served;   // the oldest block this pass read (less than asked when the node served less)
      // a gap below this pass (the app was away longer than one pass reads, or the node served less): the backfill reaches down to the
      // oldest unread block and starts just under this pass; a gap that opens while an older one is still being read keeps the oldest
      // target (0.19.328, as released 0.18.213)
      if (prev && prev < covered) {
        const t0 = meta("backfill_target_block"); store.setMeta("backfill_target_block", t0 ? Math.min(t0, prev) : prev); store.setMeta("backfill_floor_block", covered);
        store.log("miniMall: the app was away for " + (tip - prev) + " blocks; this pass read back to block " + covered + ", and the older blocks are read in steps, back to block " + (t0 ? Math.min(t0, prev) : prev));
      }
      store.setMeta("scanned_tip_block", Math.max(prev, tip));   // never DOWN (0.19.332): a node resynced to a lower tip does not make the scan read again what it read
      const target = meta("backfill_target_block"), floor = meta("backfill_floor_block");
      // ONE step per pass: a widening query is heavy on the shared MINIMERCH address; a tip not above the floor (a fresh sync or a resync with
      // the store kept) puts the step off, not called a failure (0.19.332)
      if (target && floor && tip > floor) {
        const deep = Math.min(tip - target + GAP_MARGIN, tip - floor + BACKFILL_CHUNK, len > 0 ? len : Infinity);   // never past the tree (0.19.330)
        served = deep;
        const c = await scanOrders(deep, floor).catch(() => null), d = await scanPayments(deep, floor).catch(() => null);
        changed = changed || !!(c || d);
        const reached = tip - served;
        if (c === null || d === null) stepFailed = true;   // nothing moves: the same step is tried on the next pass (0.19.249), said as OLDER orders (0.19.332)
        else if (reached <= target) { store.setMeta("backfill_target_block", 0); store.setMeta("backfill_floor_block", 0); }
        else if (reached < floor) store.setMeta("backfill_floor_block", reached);
        else {   // the node served no deeper than the floor: what is older cannot be read, said and kept (0.19.249)
          // the floor (0.19.330): what is above it was read; the payments read reached the root, so only orders and spent payments are gone
          store.setMeta("backfill_target_block", 0); store.setMeta("backfill_floor_block", 0); store.setMeta("unread_below_block", floor);
          store.log("miniMall: orders sent before block " + floor + ", and payments already spent, could not be read: the node did not list them (its block tree ends there, or its replies were cut short)");
        }
        // "no deeper history" stays said (0.19.331, as the released tree; 0.19.273 cleared it at the next pass) until a step reads below it
        // or the vendor hides it on the Inbox (dismissUnread)
        if (c !== null && d !== null && meta("unread_below_block") && reached < meta("unread_below_block")) store.setMeta("unread_below_block", 0);
      }
    }
    const bf1 = meta("backfill_target_block") + "/" + meta("backfill_floor_block") + "/" + meta("unread_below_block");
    const said = failed !== lastPassFailed || stepFailed !== lastStepFailed || bf0 !== bf1; lastPassFailed = failed; lastStepFailed = stepFailed;
    if (changed || said) emitter.emit("update");
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

/** A .shop file is the vendor's: checked before the screens see it (currency and token, plain prices and fees), and a
 *  product picture is an inline picture or nothing. Throws the plain reason. */
function checkImported(cfg) {
  const why = SHOP.problem(cfg); if (why) throw new Error(why);
  for (const p of cfg.products) if (p && typeof p === "object") p.image = SHOP.image(p.image);
  return cfg;
}

// ---- read-model for the renderer ----
function myShops() { return store.shops(); }
/** A shop's payout address is checked when it is new or changed (0.19.273; 0.19.284: here, by its checksum, not by asking the
 *  node): one with the right shape and a wrong checksum was saved, and its payments could never be read. */
async function saveShop(cfg) {
  const addr = String((cfg && cfg.vendorAddress) || "").trim(), was = cfg && store.shop(cfg.shopId);
  if (addr && !(was && String(was.vendorAddress || "").trim() === addr)) {
    if (!looksLikeMinimaAddress(addr)) throw new Error("This shop's payout address is invalid.");
    if (badAddress(addr)) throw new Error("The payout address " + addr + " is not a valid Minima address. Nothing was saved; check the address and save again.");
    skippedPay.delete(addr);
  }
  store.saveShop(cfg); emitter.emit("update"); return cfg;
}
function deleteShop(shopId) { store.deleteShop(shopId); emitter.emit("update"); }
/** What the screens may offer for a buy order's payment (0.19.265): `sending` while its send is at the node in this process
 *  (no warning, no button), nothing once the vendor acknowledged it; else the unpaid / may-have-gone-through marks. */
function payState(o) {
  const ref = o.ref, s = sending.has(ref), done = o.role === "buy" && acked(o);
  return { sending: s, unpaid: !s && !done && !!store.getMeta("unpaid:" + ref), ambiguous: !s && !done && !!(store.getMeta("ambiguous:" + ref) || store.getMeta("inflight:" + ref)) };
}
function ordersList() {
  return store.orders().map(o => (o.role === "sell" ? store.ensureChecked(o) : o)).map(o => Object.assign({ ref: o.ref, role: o.role, shopId: o.shopId, shopName: o.shopName, status: o.status,
    amount: o.amount, due: o.due || "", unchecked: !!(o.problems && o.problems.length), currency: o.currency, tokenid: o.tokenid, paid: !!o.paid, date: o.date, unread: !!o.unread }, payState(o))).sort((a, b) => (b.date || 0) - (a.date || 0));
}
function orderDetail(ref) {
  const o = store.order(ref); if (!o) return null; store.markOrderRead(ref); if (o.role === "sell") store.ensureChecked(o);
  // a payment still marked in flight (a quit or crash during the send) is "may already have gone through" too (0.19.241, as released 0.18.217);
  // a second buyer's copy of a reference: payments carrying that reference are counted on the first order (as released 0.18.218)
  const first = o.wireRef ? store.order(o.wireRef) : null;
  const sharedRef = first ? { ref: first.ref, received: first.paidAmount || "0" } : null;
  return Object.assign({ order: o, chat: store.chat(ref), sharedRef }, payState(o));
}
/** The buyer checked their History and the uncertain payment was not sent (0.19.241, as released 0.18.217): Retry is offered again. */
function paymentNotSent(ref) {
  const o = store.order(ref); if (!o || o.role !== "buy") throw new Error("Order not found.");
  if (sending.has(ref)) throw new Error(SENDING);
  if (acked(o)) throw new Error("This order is already paid.");
  if (!store.getMeta("ambiguous:" + ref) && !store.getMeta("inflight:" + ref)) throw new Error("This order has no payment that may have gone through.");
  store.setMetaSync("ambiguous:" + ref, false); store.setMetaSync("inflight:" + ref, false); store.setMetaSync("unpaid:" + ref, true);
  emitter.emit("update"); return { ok: true };
}
/** The vendor checked an order that does not match the listing by hand (an explicit question on the screen). */
function vendorCheck(ref) { if (!store.handCheck(ref)) throw new Error("Only an order that does not match your shop is checked by hand."); emitter.emit("update"); return { ok: true }; }
/** What the order scan could not read, for the Inbox's status line (0.19.249): the last pass failed (the node did not answer;
 *  read again on the next block), and the oldest block below which a long absence left orders and payments unread. */
/** The vendor hid the Inbox's "could not be read" notice (0.19.331): the log keeps it. */
function dismissUnread() { store.setMeta("unread_below_block", 0); emitter.emit("update"); return { ok: true }; }
/** What the order scan could not read yet, for the Inbox: a failed pass, the block a backfill still reads back to (catchingUpTo), the oldest
 *  block a node that serves no deeper left unread (unreadBelow), payout addresses skipped as not valid (0.19.249, 0.19.284, 0.19.328). */
function scanState() { return { readFailed: lastPassFailed, stepFailed: lastStepFailed, catchingUpTo: Number(store.getMeta("backfill_target_block")) || 0, unreadBelow: Number(store.getMeta("unread_below_block")) || 0, skipped: [...skippedPay.keys()].filter(skipping) }; }
function newOrderCount() { return store.orders().filter(o => o.role === "sell" && o.unread).length; }

module.exports = {
  emitter, init, invalidateIdentity, myIdentity, vendorCard, startLoop, stopLoop, scanOnce,
  myShops, saveShop, deleteShop, ordersList, orderDetail, newOrderCount, scanState, dismissUnread,
  placeOrder, retryPayment, paymentNotSent, advanceStatus, reply, checkImported, vendorCheck,
  sendingCount: () => sending.size,   // payments at the node in this process: said by the Quit and Shutdown warnings (0.19.288)
  _setRunner, MINIMERCH, MXUSD_TOKEN, tokenFor
};
