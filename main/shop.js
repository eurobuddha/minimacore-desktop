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
const { rpcCall, oneCommand } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const sc = require("./shopcrypto");
const store = require("./shop-store");
const listing = require("./shop-listing");
const SHOP = require("../renderer/shop-rules.js");   // which token a shop is paid in, what a price is (shared with the screen)

const MINIMERCH = "0x4D494E494D45524348";   // ASCII "MINIMERCH" — the shared order channel (matches native)
const MSG_AMOUNT = "0.000000001";
const MINIMA_TOKEN = "0x00";
const USDT_TOKEN = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const SHOP_KEY_ACCOUNT = "shop-identity";
const SCAN_EVERY_MS = 10000;
const POLL_DEPTH = 64;      // steady-state window (MINIMERCH is shared/busy — go deeper than mail's private channel)
const BACKFILL_MAX_DEPTH = 256;   // the very first pass on a new store
// What was read is remembered across restarts (0.18.206, after mail.js): the tip the last pass covered ("scanTip"); the next
// pass reaches back to it (up to WINDOW_DEPTH), and an older gap is walked down by a paced backfill, BACKFILL_CHUNK more
// blocks per pass, until it is covered or the node will not serve deeper. The first pass read 256 and then 64 for ever,
// with the "done" mark in memory only: orders and payments made while the app was closed longer were never read.
const WINDOW_DEPTH = 1024, GAP_MARGIN = 8, BACKFILL_CHUNK = 512;
// How deep `coins address:` can read (0.18.276, corrected 0.18.277, read from core/minima-core e64600285be): without megammr:true
// (never passed here) the node walks only its in-memory TxPoW tree (TxPoWSearcher.searchCoins: the walk ends where the tree ends and
// returns what it found, never a refusal). The tree is cut when it reaches MINIMA_CASCADE_START_DEPTH + MINIMA_CASCADE_FREQUENCY = 1124
// blocks and shrinks back to 1024 (TxPoWProcessor.java:555-568), so it holds 1024 to 1123 blocks; on every cut its new root receives
// every RELEVANT UNSPENT coin of the pruned history (newroot.copyParentRelevantCoins()). So a payments read (relevant:true) deep enough
// to reach the root returns this wallet's unspent payment coins of ANY age; orders on the shared channel (not relevant) and payments
// already spent are lost past the tree. NODE_TREE_DEPTH: what the tree surely holds; NODE_TREE_MOST: what it may hold; ROOT_DEPTH:
// a walk that reaches the root whatever the tree's length.
const NODE_TREE_DEPTH = 1024, NODE_TREE_MOST = 1123, ROOT_DEPTH = 1124;

const T = { ORDER: "ORDER", INQUIRY: "INQUIRY", REPLY: "REPLY", BUYER_REPLY: "BUYER_REPLY", STATUS_UPDATE: "STATUS_UPDATE" };

const emitter = new EventEmitter();
const seenMsgCoins = new Set();
const seenPayCoins = new Set();
let identity = null;         // {boxPk,boxSk,signPk,signSk,publicId}
let vendorAddress = "";      // my default receiving address (payments land here)
let scanTimer = null, lastTip = 0, scanning = false, passServed = 0;
// Refs whose payment is at the node in THIS process right now (0.18.224, as Pandamonium Desktop 0.19.265): a send can take up to
// the RPC's write timeout, and while it runs "not sent" and Retry are refused (they cleared the in-flight mark and paid a second
// time while the first was live).
const sending = new Set();
const SENDING = "This payment is being sent to the node now. Wait for its answer.";
// A buy order the vendor has moved to PAID or on (CONFIRMED, SHIPPED, DELIVERED): the payment arrived. A buy order's own `paid`
// is never set (only the vendor's store counts coins), so its status is what says it.
const ACKED = new Set(["PAID", "CONFIRMED", "SHIPPED", "DELIVERED"]);
const acked = (o) => !!(o && (o.paid || ACKED.has(o.status)));
// A read the node did not answer (refused at every depth, timed out, threw) in this pass (0.18.213): it was taken as covered,
// so the newest part of a gap was never read. Any failure now advances nothing; the same blocks are read on the next pass.
let readFailed = false, lastPassFailed = false, lastStepFailed = false;   // the recent window failed / only a backfill step failed (0.18.277)

let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) { return runner(oneCommand(cmd)); }   // ONE command each (main/rpc.js, 0.18.177)

function tokenFor(currency) { return SHOP.tokenOfCurrency(currency) === USDT_TOKEN ? USDT_TOKEN : MINIMA_TOKEN; }   // the one mapping (renderer/shop-rules.js); an unknown currency is Minima here, as before
function randomId() { return crypto.randomBytes(16).toString("hex"); }
function looksLikeMinimaAddress(a) {
  a = String(a || "").trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}
/**
 * Can this payout address never be valid (0.18.227, as Pandamonium Desktop 0.19.273 / 0.19.284)? Decided here, never from a node
 * error: an Mx whose checksum is wrong (the node's own Address.convertMinimaAddress: the first 4 bytes of the SHA3 of the 32-byte
 * address, as Pandamonium Desktop's main/futurecash.js mxToHex reads it), or an 0x that is not 64 hexadecimal digits
 * (checkaddress's length rule). looksLikeMinimaAddress checks the shape only, so an Mx with a wrong checksum was saved and its
 * payments could never be read. SHA-3 comes from main/sha3.js (0.18.247): Electron's crypto has none.
 */
const B32 = "0123456789abcdefghijklmnopqrstuv";
function mxToHex(mx) {
  if (typeof mx !== "string" || !/^M[xX][0-9A-Za-z]{30,100}$/.test(mx)) return null;
  let n = 0n;
  for (const ch of mx.slice(2).toLowerCase().replace(/w/g, "i").replace(/y/g, "l").replace(/z/g, "o")) { const d = B32.indexOf(ch); if (d < 0) return null; n = n * 32n + BigInt(d); }
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const b = Buffer.from(h, "hex");
  if (b.length !== 39 || b[0] !== 1 || ((b[1] << 8) | b[2]) !== 32) return null;
  const addr = b.subarray(3, 35);
  // main/sha3.js, never crypto's sha3-256 (0.18.247: Electron's BoringSSL has none, so this threw and every address read as valid)
  return require("./sha3").sha3_256(addr).subarray(0, 4).equals(b.subarray(35)) ? "0x" + addr.toString("hex").toUpperCase() : null;
}
function badAddress(a) {
  a = String(a == null ? "" : a).trim();
  if (/^0x/i.test(a)) return !/^0x[0-9a-fA-F]{64}$/.test(a);
  if (!/^M[xX]/.test(a)) return true;
  return !mxToHex(a);
}
// Payout addresses that can never be valid and whose coins the node did not list: skipped for SKIP_MS, logged whole, said on the
// miniMall status line (scanState). They were read as "not answered", which held the scan for good: the tip never advanced and
// every pass read the widest window again. A node error about a valid address still holds the scan (read again next pass).
const SKIP_MS = 5 * 60000, skippedPay = new Map();   // address -> skipped until
const skipping = (a) => (skippedPay.get(a) || 0) > Date.now();
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
  // The address buyers pay is the one in the published .shop (0.18.205): it is kept once chosen. `getaddress` gives one of
  // the wallet's default addresses at random, and asking it on every start moved the address the scan read, so payments
  // to the published one went unseen after a restart.
  vendorAddress = store.getMeta("vendorAddress") || "";
  if (!vendorAddress) { try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; vendorAddress = gr.miniaddress || gr.address || ""; if (vendorAddress) store.setMeta("vendorAddress", vendorAddress); } catch (e) {} }
  if (!store.getMeta("cn:merch")) { try { await nodeCmd("coinnotify action:add address:" + MINIMERCH); store.setMeta("cn:merch", true); } catch (e) {} }
  for (const a of payAddresses()) if (!store.getMeta("cn:pay:" + a)) { try { await nodeCmd("coinnotify action:add address:" + a); store.setMeta("cn:pay:" + a, true); } catch (e) {} }
  return identity;
}
/** On seed change (wallet restore) → drop the cached shop identity + local orders (different identity). */
function invalidateIdentity() {
  config.deleteSecret(SHOP_KEY_ACCOUNT);
  identity = null; vendorAddress = ""; seenMsgCoins.clear(); seenPayCoins.clear();
  try { store.clear(); } catch (e) {}
}
/** Every address a buyer may pay: this app's vendor address and the payout address of each shop I made. */
function payAddresses() {
  const all = [vendorAddress].concat(store.shops().map(x => x && x.vendorAddress));
  return [...new Set(all.filter(a => typeof a === "string" && looksLikeMinimaAddress(a)))];
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
  if (!SHOP.payable(amount)) throw new Error("Invalid amount.");   // a plain decimal above zero: no sign, no exponent
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
  // The token paid is the one the shop's CURRENCY names, never the file's own tokenid: a .shop that says "Minima" and
  // carries another token's id is refused here, whatever screen (or stored shop) it came from (0.18.150).
  const tok = SHOP.token(shopCfg || {}); if (tok.err) throw new Error(tok.err);
  const tokenid = tok.tokenid;
  if (!SHOP.payable(total)) throw new Error("Invalid amount.");   // before the order message is sent
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
  // In flight, on disk, until the node answers (0.18.208): a quit or crash during the send leaves it set, and a retry is then
  // refused as "may already have been sent" instead of paying a second time.
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
  // A retry only after a payment the node refused (0.18.208): no "unpaid" mark, no second payment.
  if (!store.getMeta("unpaid:" + ref)) throw new Error("This order has no refused payment to retry. Check your Balance/History.");
  const tok = SHOP.token(o); if (tok.err) throw new Error(tok.err);   // an order placed before 0.18.150 with a shop whose token did not match its currency
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
  // The vendor's screen offers exactly these three (shopAdvanceRow); nothing else is a status a vendor sets (0.18.166).
  if (typeof status !== "string" || !/^(CONFIRMED|SHIPPED|DELIVERED)$/.test(status)) throw new Error("Unknown order status.");
  // Confirm, ship, deliver: only an order paid by what my listing says is due, or one I checked by hand (0.18.159).
  if (!store.mayAdvance(o)) throw new Error("This order is not paid by what your shop says is due. Check it by hand first.");
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

// ---- what a peer sent, as it may be stored (0.18.163) ----
// A message is a peer's JSON and can hold anything: an object 12,000 arrays deep made every later JSON.stringify of the
// store throw (nothing was saved for the session), and String() of one throws as well. Nothing a peer sent is stored,
// converted or used as a key as it came: a field is a primitive cut to its length, or it is dropped.
function str(v, n) { return typeof v === "string" ? v.slice(0, n) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, n) : ""; }
const LINE_FIELDS = { product: 200, quantity: 12, unitPrice: 80, lineTotal: 80, size: 60, nftTokenId: 66, nftStateIdx: 12, nftBundle: 12 };
const ORDER_MAX_BYTES = 48 * 1024;   // one stored order, whole; lines past it are not kept
/** One order line rebuilt from capped primitives only (a number stays a number); anything else is dropped. */
function cleanLine(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  const out = {};
  for (const [k, n] of Object.entries(LINE_FIELDS)) {
    const v = it[k];
    if (typeof v === "number" && Number.isFinite(v) && String(v).length <= n) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, n);
  }
  return out;
}
function cleanItems(raw) {
  let a = null;
  if (Array.isArray(raw)) a = raw;
  else if (typeof raw === "string" && raw.length <= 200000) a = listing.itemsOf(raw);   // the phone sends a JSON string
  return (a || []).slice(0, 40).map(cleanLine).filter(Boolean);
}

// ---- routing an opened inbound message ----
/** Where a second buyer's order with an already used reference is kept: the reference and that buyer's whole id. */
function dupKey(ref, fromPublicId) { return ref + "~" + fromPublicId; }
function routeIncoming(w, fromPublicId) {
  if (!w || typeof w !== "object" || w.from !== fromPublicId || !w.ref) return;   // envelope `from` must match the sealed sender (anti-spoof)
  if (typeof w.ref !== "string" || w.ref.length > 64) return;
  const date = typeof w.date === "number" && Number.isFinite(w.date) ? w.date : Date.now();
  if (w.type === T.ORDER || w.type === T.INQUIRY) {
    if (typeof w.shopId !== "string" || w.shopId.length > 200) return;
    const own = store.shop(w.shopId);
    if (!own) return;   // only accept orders/enquiries for a shop I actually authored — else any coin to my identity could inject bogus orders + flush-amplify
    // The token this order must be paid in is MY shop's, never the currency the buyer wrote (0.18.151): a buyer who
    // wrote "Minima" on an order to an MxUSD shop had it marked paid by a payment in Minima.
    const tokenid = tokenFor(own.currency);
    // What it is due is worked out from MY listing, never the buyer's total (0.18.159). items: an array (this desktop)
    // or a JSON array string (the phone's wire shape); either is kept as an array.
    const items = cleanItems(w.items), shipping = str(w.shipping, 200), buyerCurrency = str(w.currency, 20);
    const order = { ref: w.ref, role: "sell", counterparty: fromPublicId, buyerName: str(w.fromname, 64),
      shopId: w.shopId, shopName: own.shopName || str(w.shopName, 200), items, amount: str(w.amount, 80) || "0", buyerCurrency,
      currency: tokenid === USDT_TOKEN ? "USDT" : "Minima",
      tokenid, shipping, delivery: str(w.delivery, 500), buyerPayaddr: str(w.buyerPayaddr, 90),
      paid: false, date, unread: true, note: str(w.message, 1000) };
    while (order.items.length && Buffer.byteLength(JSON.stringify(order)) > ORDER_MAX_BYTES) order.items.pop();   // the whole order stays bounded
    const chk = listing.check(own, { items: order.items, shipping, currency: buyerCurrency });
    // The same reference from a second buyer (0.18.208): it was dropped, and a payment carrying that reference was counted
    // for whichever order came first. Both are kept, and neither can be paid automatically: a payment cannot be told apart.
    const prior = store.order(w.ref), problems = chk.problems.slice(0, 20).map(p => String(p).slice(0, 300));
    if (prior && prior.counterparty !== fromPublicId) {
      if (store.order(dupKey(w.ref, fromPublicId))) return;   // this buyer's copy is already kept
      const DUP = "another buyer sent an order with the same reference " + w.ref + ": a payment with it cannot be told apart, so check both orders by hand";
      store.flagDuplicate(w.ref, DUP);
      problems.unshift(DUP); order.wireRef = w.ref; order.ref = dupKey(w.ref, fromPublicId);
    }
    Object.assign(order, { due: problems.length ? "" : chk.due, problems,
      status: w.type === T.INQUIRY ? "INQUIRY" : problems.length ? "UNCHECKED" : "PENDING" });
    const isNew = store.upsertOrder(order);
    if (isNew) emitter.emit("incoming", { ref: order.ref, shopName: own.shopName, amount: problems.length ? "" : chk.due, currency: tokenid === USDT_TOKEN ? "MxUSD" : "Minima" });
  } else if (w.type === T.STATUS_UPDATE) {
    const o = store.order(w.ref);
    if (o && o.role === "buy" && o.counterparty === fromPublicId && typeof w.status === "string") store.setStatus(w.ref, w.status.slice(0, 20));   // only the vendor I bought from can advance MY buy order
  } else if (w.type === T.REPLY || w.type === T.BUYER_REPLY) {
    let o = store.order(w.ref); if (o && o.counterparty !== fromPublicId) o = store.order(dupKey(w.ref, fromPublicId));   // the second buyer's copy
    if (o && o.counterparty === fromPublicId && str(w.randomid, 64)) store.addChat({ ref: o.ref, randomid: str(w.randomid, 64), from: fromPublicId, to: identity.publicId, incoming: true, message: str(w.message, 4000), date });
  }
}

// ---- scanners (adaptive depth: MINIMERCH is a network-wide shared address, so a deep query can exceed the node's
//      reply cap and return a non-array — shrink 256→…→4 until we get a real list, like mail.js, rather than miss all) ----
async function coinsAt(address, depth, extra) {
  let d = depth;
  while (d >= 4) {
    let r; try { r = await nodeCmd(`coins address:${address} simplestate:true${extra || ""} order:desc depth:${d}`); } catch (e) { readFailed = true; return null; }
    if (r && Array.isArray(r.response)) { passServed = Math.min(passServed, d); return r.response; }   // the depth the node really served
    d = Math.floor(d / 2);
  }
  readFailed = true;
  return null;   // never got a usable reply → caller keeps its bookmark and retries next tick
}
function capSeen() { if (seenMsgCoins.size > 40000) seenMsgCoins.clear(); if (seenPayCoins.size > 40000) seenPayCoins.clear(); }
const above = (c, floor) => floor > 0 && Number(c && c.created) > floor;   // already read by an earlier pass: a backfill step skips it
async function scanOrders(depth, floor) {
  const coins = (await coinsAt(MINIMERCH, depth) || []).filter(c => !above(c, floor)); if (!coins.length) return false;
  capSeen();
  let changed = false;
  for (const c of coins) {
    const id = c.coinid; if (!id || seenMsgCoins.has(id)) continue; seenMsgCoins.add(id);
    const blobHex = statePort(c, 99); if (!blobHex) continue;
    // One coin's message never stops the batch (0.18.163): a message that cannot be routed is logged and passed over.
    try {
      const opened = await sc.open(identity, blobHex); if (!opened || !opened.valid) continue;   // not for me / bad sig
      routeIncoming(parseWire(opened.plaintext), opened.fromPublicId);
      changed = true;
    } catch (e) { console.error("[miniMall] a message in coin " + id + " could not be read: " + String((e && e.message) || e).slice(0, 200)); }
  }
  return changed;
}
async function scanPayments(depth, floor) {
  const addrs = payAddresses().filter(a => !skipping(a)); if (!addrs.length) return false;
  const listed = [], have = new Set();
  for (const a of addrs) {   // every published payout address (0.18.205), one coin once
    const before = readFailed, got = await coinsAt(a, depth, " relevant:true");
    if (!got && badAddress(a)) {   // not a node error: this address can never be read (0.18.227)
      readFailed = before; skippedPay.set(a, Date.now() + SKIP_MS);
      console.error("[miniMall] the payout address " + a + " is not a valid Minima address, so payments to it are not read (looked at again in 5 minutes). Correct it in miniMall Studio (the shop's payout address).");
      continue;
    }
    if (!got) continue;
    for (const c of got) if (c && c.coinid && !have.has(c.coinid) && !above(c, floor)) { have.add(c.coinid); listed.push(c); }
  }
  capSeen();
  // Oldest first (0.18.185; the node lists newest first): a top-up is judged after the payment it completes. Within one
  // block the larger coin first, so the remainder comes last.
  const coins = listed.map((c, i) => ({ c, i })).sort((a, b) => (Number(a.c.created) || 0) - (Number(b.c.created) || 0)
    || (b.c.amount != null && a.c.amount != null ? (Number(coinAmount(b.c)) - Number(coinAmount(a.c))) : 0) || (b.i - a.i)).map(x => x.c);
  let changed = false;
  const judge = (c) => {
    const id = c.coinid; if (!id || seenPayCoins.has(id)) return "";
    const refHex = statePort(c, 1); if (!refHex) { seenPayCoins.add(id); return ""; }
    const ref = hexToText(refHex); if (!ref) { seenPayCoins.add(id); return ""; }
    const o = store.order(ref); if (!o || o.role !== "sell" || o.paid) return "";   // not marked seen: a payment that arrives before its order is matched once the order is in
    seenPayCoins.add(id);
    const outcome = store.recordPayment(ref, coinAmount(c), c.tokenid || MINIMA_TOKEN, String(id));   // the store counts each coin once, across restarts
    if (outcome === "DUST") seenPayCoins.delete(id);   // judged again later, against what is then still due (0.18.185)
    if (outcome && outcome !== "ALREADY" && outcome !== "DUST") { changed = true; emitter.emit("incoming", { ref, paid: outcome }); }
    return outcome || "";
  };
  // One pass oldest first, then one more over this scan's dust if anything counted (a top-up older than the payment it completes).
  const dust = coins.filter(c => judge(c) === "DUST");
  if (changed && dust.length) for (const c of dust) judge(c);
  return changed;
}
async function scanOnce() {
  if (scanning || !identity) return;
  scanning = true;
  try {
    let tip = 0;
    try { const r = await nodeCmd("block"); tip = parseInt((r && r.response && (r.response.block != null ? r.response.block : r.response)), 10) || 0; } catch (e) { tip = 0; }
    const prev = Number(store.getMeta("scanTip")) || 0;
    const want = prev && tip > prev ? tip - prev + GAP_MARGIN : prev && tip ? POLL_DEPTH : BACKFILL_MAX_DEPTH;
    const depth = Math.max(POLL_DEPTH, Math.min(WINDOW_DEPTH, want));
    const failed = () => { readFailed = true; return false; };
    passServed = depth; readFailed = false;
    const a = await scanOrders(depth).catch(failed);
    const b = await scanPayments(depth).catch(failed);
    let changed = a || b;
    const recentFailed = readFailed;   // a backfill step's failure below is said as such, not as the recent window's (0.18.277)
    if (tip && !readFailed && prev && tip < prev) {
      // the chain is BELOW what was read before (a fresh sync or a resync while the store persists, 0.18.276): the cursor is not moved
      // down and the backfill waits; neither is a failure
    } else if (tip && !readFailed) {
      const covered = tip - passServed;   // the oldest block this pass read
      // A new gap below this pass: the backfill reaches down to the oldest unread block and starts again just under this
      // pass (0.18.213: a gap that opened while an older backfill was pending was never registered).
      if (prev && prev < covered) { const t0 = Number(store.getMeta("bfTarget")) || 0; store.setMeta("bfTarget", t0 ? Math.min(t0, prev) : prev); store.setMeta("bfFloor", covered); }
      store.setMeta("scanTip", tip);
      const target = Number(store.getMeta("bfTarget")) || 0, floor = Number(store.getMeta("bfFloor")) || 0;
      if (target && floor && tip <= target) { /* the chain has not reached the gap yet: the backfill waits, not a failure (0.18.276) */ }
      else if (target && floor && tip - floor >= NODE_TREE_DEPTH) {
        // the rest of the gap is past what the tree surely holds (0.18.277): orders are read as deep as the tree may still hold, and ONE
        // payments read reaches the root, where this wallet's unspent payment coins of any age are; both skip what was read before (floor)
        passServed = NODE_TREE_MOST; const c = await scanOrders(NODE_TREE_MOST, floor).catch(failed);
        passServed = ROOT_DEPTH; const d = await scanPayments(ROOT_DEPTH, floor).catch(failed);
        changed = changed || c || d;
        if (!readFailed) {   // a failed read moves nothing: the same reads are tried on the next pass
          const root = passServed >= ROOT_DEPTH;   // the reply cap may have cut the payments read short of the root
          store.setMeta("bfTarget", 0); store.setMeta("bfFloor", 0); store.setMeta("unreadBelow", floor); store.setMeta("unreadWhy", root ? "tree" : "treeAll");
          console.error("[miniMall] " + (root ? "orders older than block " + floor + ", and payments already spent," : "orders and payments older than block " + floor) + " could not be read: the node keeps only its recent blocks.");
          changed = true;
        }
      } else if (target && floor) {   // ONE backfill step per pass, paced: a widening query is heavy on the shared MINIMERCH address
        const deep = Math.min(tip - target + GAP_MARGIN, tip - floor + BACKFILL_CHUNK, NODE_TREE_DEPTH);   // never past what the tree surely holds (0.18.277)
        passServed = deep;
        const c = await scanOrders(deep, floor).catch(failed), d = await scanPayments(deep, floor).catch(failed);
        changed = changed || c || d;
        const reached = tip - passServed;
        if (readFailed) { /* nothing moves: the same step is tried on the next pass */ }
        else if (reached <= target) { store.setMeta("bfTarget", 0); store.setMeta("bfFloor", 0); store.setMeta("bfStall", 0); }
        else if (reached < floor) { store.setMeta("bfFloor", reached); store.setMeta("bfStall", 0); }
        else {
          // the node served no deeper than what was read: its reply was cut (the reply cap depends on what the blocks hold, so it is tried on
          // two more passes, 0.18.277) and then the backfill ends with the cause said
          const stall = (Number(store.getMeta("bfStall")) || 0) + 1;
          if (stall < 3) store.setMeta("bfStall", stall);
          else { store.setMeta("bfTarget", 0); store.setMeta("bfFloor", 0); store.setMeta("bfStall", 0); store.setMeta("unreadBelow", reached); store.setMeta("unreadWhy", "cap"); console.error("[miniMall] orders and payments older than block " + reached + " could not be read: the node's answer for older blocks was too large."); }
        }
      }
    }
    if (!tip) readFailed = true;
    const nowRecent = recentFailed || !tip, nowStep = readFailed && !nowRecent;
    if (lastPassFailed !== nowRecent || lastStepFailed !== nowStep) changed = true;   // the status line changes
    lastPassFailed = nowRecent; lastStepFailed = nowStep;
    if (changed) emitter.emit("update");
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

/** A .shop file is the vendor's: checked before the screen sees it (currency and token, plain prices and fees), and a
 *  product picture is an inline picture or nothing. Throws the plain reason. */
function checkImported(cfg) {
  const why = SHOP.problem(cfg); if (why) throw new Error(why);
  for (const p of cfg.products) if (p && typeof p === "object") p.image = SHOP.image(p.image);
  return cfg;
}

// ---- read-model for the renderer ----
function myShops() { return store.shops(); }
/** A shop's payout address is checked when it is new or changed (0.18.227): by its checksum here, not by asking the node. */
function saveShop(cfg) {
  const addr = String((cfg && cfg.vendorAddress) || "").trim(), was = cfg && store.shop(cfg.shopId);
  if (addr && !(was && String(was.vendorAddress || "").trim() === addr)) {
    if (!looksLikeMinimaAddress(addr)) throw new Error("This shop's payout address is invalid.");
    if (badAddress(addr)) throw new Error("The payout address " + addr + " is not a valid Minima address. Nothing was saved; check the address and save again.");
    skippedPay.delete(addr);
  }
  store.saveShop(cfg); emitter.emit("update"); return cfg;
}
function deleteShop(shopId) { store.deleteShop(shopId); emitter.emit("update"); }
/** What the screens may offer for a buy order's payment (0.18.224): `sending` while its send is at the node in this process (no
 *  warning, no button), nothing once the vendor acknowledged it; else the unpaid / may-have-gone-through marks. */
function payState(o) {
  const ref = o.ref, s = sending.has(ref), done = o.role === "buy" && acked(o);
  return { sending: s, unpaid: !s && !done && !!store.getMeta("unpaid:" + ref), ambiguous: !s && !done && !!(store.getMeta("ambiguous:" + ref) || store.getMeta("inflight:" + ref)) };
}
function ordersList() {
  return store.orders().map(o => Object.assign({ ref: o.ref, role: o.role, shopId: o.shopId, shopName: o.shopName, status: o.status,
    amount: o.amount, due: o.due || "", unchecked: !!(o.problems && o.problems.length), currency: o.currency, tokenid: o.tokenid, paid: !!o.paid, date: o.date, unread: !!o.unread }, payState(o))).sort((a, b) => (b.date || 0) - (a.date || 0));
}
function orderDetail(ref) {
  const o = store.order(ref); if (!o) return null; store.markOrderRead(ref); if (o.role === "sell") store.ensureChecked(o);
  // a payment still marked in flight (a quit or crash during the send) is shown as "may already have gone through" too (0.18.217)
  // a second buyer's copy of a reference (0.18.218): payments carrying that reference are counted on the first order
  const first = o.wireRef ? store.order(o.wireRef) : null;
  const sharedRef = first ? { ref: first.ref, received: first.paidAmount || "0" } : null;
  return Object.assign({ order: o, chat: store.chat(ref), sharedRef }, payState(o));
}
/** The buyer checked their History and the uncertain payment was not sent (0.18.217): Retry is offered again. */
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
/** What the order scan could not read yet, for the miniMall status line (0.18.213). */
function scanState() {
  const target = Number(store.getMeta("bfTarget")) || 0, below = Number(store.getMeta("unreadBelow")) || 0, skipped = [...skippedPay.keys()].filter(skipping);
  const skippedText = skipped.map(a => "Payments to " + a + " are not read: it is not a valid Minima address. Correct the shop's payout address in miniMall Studio.").join(" ");
  // the unread notice is shown only to someone with a shop, and until it is dismissed (0.18.277: it stayed for everyone, for good);
  // what it says is what is true: past the node's recent blocks orders, and payments already spent, could not be read
  const why = store.getMeta("unreadWhy"), shown = below && store.shops().length > 0 && below > (Number(store.getMeta("unreadDismissed")) || 0);
  const belowText = !shown ? "" : why === "cap" ? "Orders and payments older than block " + below + " could not be read: the node's answer for older blocks was too large."
    : why === "treeAll" ? "Orders and payments older than block " + below + " could not be read: the node keeps only its recent blocks."
    : "Orders older than block " + below + ", and payments to your shops that were already spent, could not be read: the node keeps only its recent blocks. Payments not yet spent were read.";
  return { readFailed: lastPassFailed || lastStepFailed, catchingUpTo: target, unreadBelow: below, unreadShown: !!shown, skipped,
    // the recent window is what fails when a pass fails (a backfill step reads only inside the node's tree), so it is said as recent
    text: [lastPassFailed ? "Recent orders could not be read: the node did not answer. They are read again on the next block."
      : lastStepFailed ? "Older orders could not be read yet: the node did not answer. They are read again on the next block."
      : target ? "Reading orders and payments from while the app was closed (back to block " + target + ")." : belowText, skippedText].filter(Boolean).join(" ") };   // a payout address skipped as not valid, whole (0.18.227)
}
/** The unread notice was seen (0.18.277): hidden until a new one; the fact stays in the log. */
function dismissUnread() { store.setMeta("unreadDismissed", Number(store.getMeta("unreadBelow")) || 0); emitter.emit("update"); return { ok: true }; }
function newOrderCount() { return store.orders().filter(o => o.role === "sell" && o.unread).length; }

module.exports = {
  emitter, init, invalidateIdentity, myIdentity, vendorCard, startLoop, stopLoop, scanOnce,
  myShops, saveShop, deleteShop, ordersList, orderDetail, newOrderCount, scanState, dismissUnread,
  placeOrder, retryPayment, paymentNotSent, advanceStatus, reply, checkImported, vendorCheck,
  sendingCount: () => sending.size,   // payments at the node in this process: said by the node-stop guard (0.18.225)
  _mxToHex: mxToHex,   // test-only
  _setRunner, MINIMERCH, USDT_TOKEN, tokenFor
};
