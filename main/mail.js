/*
 * mail.js — minimaMail on-chain transport + orchestration (main process). Node = dumb transport; all crypto/keys
 * stay here. Every message is a 0.000000001 MINIMA coin to the shared CHAINMAIL address with the sealed blob in
 * coin state port 99; the inbox is the set of coins at that address we can crypto_box_seal_open.
 *
 * Identity is derived from the seed EXACTLY ONCE (first run), cached in the macOS Keychain, and thereafter loaded
 * from the Keychain — the raw seed is never fetched again and never reaches the renderer.
 */
const EventEmitter = require("events");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const mc = require("./mailcrypto");
const store = require("./mail-store");

const CHAINMAIL = "0x434841494E4D41494C";
const MSG_AMOUNT = "0.000000001";
const MAIL_KEY_ACCOUNT = "mail-identity";
const SCAN_EVERY_MS = 10000;
const POLL_DEPTH = 32;      // steady-state recent window
const BACKFILL_MAX_DEPTH = 256;

const emitter = new EventEmitter();
let identity = null;        // {boxPk,boxSk,signPk,signSk,publicId}
let mypayaddr = "";
let scanTimer = null;
let lastTip = 0;
let scanning = false;
let backfilled = false;

// swappable node-command runner (overridable in tests via _setRunner)
let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) { return runner(cmd); }

// ---- identity (derive once, cache in Keychain) ----
async function init() {
  if (identity) return identity;
  await mc.ready();
  const cached = config.getSecret(MAIL_KEY_ACCOUNT);
  if (cached) { try { identity = mc.loadIdentity(cached); } catch (e) { identity = null; } }
  if (!identity) {
    const r = await nodeCmd("vault action:seed");
    const resp = (r && r.response) || {};
    const seed = resp.seed || resp.phrase || "";
    if (!seed) throw new Error("Couldn't read the node seed (is the wallet unlocked?).");
    identity = await mc.deriveIdentity(seed);
    config.setSecret(mc.serializeIdentity(identity), MAIL_KEY_ACCOUNT);
  }
  try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; mypayaddr = gr.miniaddress || gr.address || ""; if (mypayaddr) store.metaSet("mypayaddr", mypayaddr); } catch (e) {}
  if (!store.metaGet("coinnotify")) { try { await nodeCmd("coinnotify action:add address:" + CHAINMAIL); store.metaSet("coinnotify", true); } catch (e) {} }
  return identity;
}
/** On wallet restore the seed changed → drop the cached identity so it re-derives. */
function invalidateIdentity() { config.deleteSecret(MAIL_KEY_ACCOUNT); identity = null; backfilled = false; }

function threadKey(a, b, subject) { return crypto.createHash("sha256").update([a, b].sort().join("") + (subject || ""), "utf8").digest("hex"); }
function randomId() { return crypto.randomBytes(32).toString("hex"); }
function toWire(m) {
  const o = { from: m.from, fromname: m.fromname || "", to: m.to, subject: m.subject || "", message: m.message || "",
    randomid: m.randomid, date: m.date, type: m.type || "text", payaddr: m.payaddr || "" };
  if (m.type === "payment") { o.amount = m.amount; o.tokenid = m.tokenid; o.tokenname = m.tokenname; o.txpowid = m.txpowid; }
  if (m.type === "image") o.image = m.image || "";
  return JSON.stringify(o);
}
async function currentBlock() { try { const b = await nodeCmd("block"); return parseInt((b && b.response && (b.response.block != null ? b.response.block : b.response)), 10) || 0; } catch (e) { return 0; } }

// ---- send ----
async function sendBlob(blobHex) {
  const cmd = `send amount:${MSG_AMOUNT} address:${CHAINMAIL} tokenid:0x00 state:${JSON.stringify({ "99": "0x" + blobHex })}`;
  const r = await nodeCmd(cmd);
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "message send failed");
  return r;
}
/** Send a message. base = { message, type, image?, amount?, tokenid?, tokenname?, txpowid? }. */
async function sendMessage(toPublicId, base) {
  await init();
  if (!mc.isValidPublicId(toPublicId)) throw new Error("Invalid recipient mail id.");
  const rid = randomId(), date = Date.now();
  const wire = { from: identity.publicId, fromname: store.metaGet("myname") || "", to: toPublicId, subject: "",
    message: base.message || "", randomid: rid, date, type: base.type || "text", payaddr: mypayaddr,
    amount: base.amount, tokenid: base.tokenid, tokenname: base.tokenname, txpowid: base.txpowid, image: base.image };
  const blob = await mc.seal(identity, toPublicId, Buffer.from(toWire(wire), "utf8"));
  if (blob.length > 49000) throw new Error("Message too large for one on-chain coin — shrink the image.");
  const block = await currentBlock();
  await sendBlob(blob);
  const local = { hashref: threadKey(identity.publicId, toPublicId, ""), fromname: wire.fromname, frompublickey: identity.publicId,
    topublickey: toPublicId, subject: "", message: wire.message, randomid: rid, incoming: false, read: true, date,
    status: "sent", sentblock: block, type: wire.type, amount: base.amount, tokenid: base.tokenid, tokenname: base.tokenname,
    txpowid: base.txpowid, image: base.image, payaddr: mypayaddr };
  store.addMessage(local);
  emitter.emit("update");
  return local;
}
async function pay(toPublicId, payaddr, amount, tokenid, tokenname) {
  await init();
  if (!/^(0x|Mx)[0-9A-Za-z]+$/.test(payaddr)) throw new Error("Invalid pay address.");
  if (!/^[0-9]*\.?[0-9]+$/.test(String(amount)) || parseFloat(amount) <= 0) throw new Error("Invalid amount.");
  if (!/^0x[0-9A-Fa-f]+$/.test(tokenid) && tokenid !== "0x00") throw new Error("Invalid token.");
  const r = await nodeCmd(`send amount:${amount} address:${payaddr} tokenid:${tokenid}`);
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "payment failed");
  const txpowid = (r.response && r.response.txpowid) || "";
  return sendMessage(toPublicId, { type: "payment", message: "", amount: String(amount), tokenid, tokenname: tokenname || "", txpowid });
}

// ---- scan ----
function statePort99(coin) {
  const st = coin && coin.state;
  if (!st) return "";
  if (Array.isArray(st)) { for (const p of st) if (parseInt(p.port, 10) === 99) return String(p.data || p.value || ""); return ""; }
  if (typeof st === "object") return String(st["99"] || "");
  return "";
}
async function queryCoins(depth) {
  try {
    const r = await nodeCmd(`coins address:${CHAINMAIL} order:desc depth:${depth}`);
    if (r && r.status === true && Array.isArray(r.response)) return r.response;
    return null;   // over-limit / bad reply
  } catch (e) { return null; }
}
async function scanOnce(deep) {
  await init();
  const block = await currentBlock();
  let depth = deep ? BACKFILL_MAX_DEPTH : POLL_DEPTH, coins = null;
  while (depth >= 4) { coins = await queryCoins(depth); if (coins) break; depth = Math.floor(depth / 2); }
  if (!coins) return 0;
  let fresh = 0;
  for (const coin of coins) {
    const blob = statePort99(coin);
    if (!blob) continue;
    let o; try { o = await mc.open(identity, blob); } catch (e) { o = null; }
    if (!o || !o.valid) continue;
    let m; try { m = JSON.parse(Buffer.from(o.plaintext).toString("utf8")); } catch (e) { continue; }
    if (o.fromPublicId !== m.from) continue;             // signed-from must equal claimed sender
    if (m.to !== identity.publicId) continue;            // addressed to me
    if (m.type === "payaddr-req" || m.type === "payaddr-reply") { if (m.payaddr) store.metaSet("pa:" + m.from, m.payaddr); continue; }
    const local = { hashref: threadKey(m.from, m.to, m.subject || ""), fromname: m.fromname || "", frompublickey: m.from,
      topublickey: m.to, subject: m.subject || "", message: m.message || "", randomid: m.randomid, incoming: true, read: false,
      date: parseInt(m.date, 10) || Date.now(), status: "received", sentblock: 0, type: m.type || "text",
      amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image, payaddr: m.payaddr || "" };
    if (store.addMessage(local)) { fresh++; if (m.payaddr) store.metaSet("pa:" + m.from, m.payaddr); }
  }
  store.markConfirmed(block);
  store.metaSet("scanned_tip_block", block);
  if (deep) backfilled = true;
  if (fresh) emitter.emit("update");
  return fresh;
}
async function scan() { if (scanning) return 0; scanning = true; try { return await scanOnce(!backfilled); } finally { scanning = false; } }

function startLoop() {
  if (scanTimer) return;
  const tick = async () => { try { const tip = await currentBlock(); if (tip !== lastTip) { lastTip = tip; await scan(); } } catch (e) {} };
  tick();
  scanTimer = setInterval(tick, SCAN_EVERY_MS);
}
function stopLoop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

// ---- read model for the renderer ----
function myIdentity() { return { publicId: identity && identity.publicId, name: store.metaGet("myname") || "", payaddr: store.metaGet("mypayaddr") || mypayaddr || "" }; }
function shareString() { const id = identity && identity.publicId; const pa = store.metaGet("mypayaddr") || mypayaddr; return pa ? id + "|" + pa : id; }
function setName(name) { store.metaSet("myname", String(name || "")); emitter.emit("update"); }
function threads() { return store.threads().map(t => ({ hashref: t.hashref, unread: t.unread, count: t.count, last: t.last, other: otherOf(t.last) })); }
function otherOf(m) { if (!m || !identity) return ""; return m.incoming ? m.frompublickey : m.topublickey; }
function thread(hashref) { store.markThreadRead(hashref); emitter.emit("update"); return store.thread(hashref); }
function threadWith(peer) { if (!identity) return []; const h = threadKey(identity.publicId, peer, ""); store.markThreadRead(h); emitter.emit("update"); return store.thread(h); }
function contacts() { return store.contacts(); }
function addContact(share, name) {
  const parts = String(share || "").split("|");
  const id = parts[0].trim();
  if (!mc.isValidPublicId(id)) throw new Error("That doesn't look like a valid mail id.");
  if (parts[1]) store.metaSet("pa:" + id, parts[1].trim());
  store.addContact(id, name || "");
  return { publicId: id };
}

module.exports = { emitter, init, invalidateIdentity, startLoop, stopLoop, scan,
  sendMessage, pay, myIdentity, shareString, setName, threads, thread, threadWith, contacts, addContact,
  _setRunner, CHAINMAIL, threadKey };
