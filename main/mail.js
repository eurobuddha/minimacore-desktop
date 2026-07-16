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
const backup = require("./mailbackup");

const CHAINMAIL = "0x434841494E4D41494C";
const MSG_AMOUNT = "0.000000001";
const MAIL_KEY_ACCOUNT = "mail-identity";
const SCAN_EVERY_MS = 10000;
const POLL_DEPTH = 32;      // steady-state recent window
const BACKFILL_MAX_DEPTH = 256;

const emitter = new EventEmitter();
const seenCoins = new Set();   // coinids already trial-decrypted this session (skip re-opening on every poll)
const repliedReq = new Set();  // payaddr-req randomids we've already auto-answered this session (avoid reply storms)
// Hard bounds on the payaddr-reply auto-responder — an attacker can post unlimited payaddr-reqs (fresh randomid +
// fresh publicId each), and every reply is a real coin + one WOTS key-use. Cap replies globally per hour AND per peer.
let autoReplyTimes = [];       // timestamps (ms) of recent auto-replies, pruned to a rolling hour
const paReplyCooldown = new Map();  // peer publicId → last auto-reply ms
const AUTO_REPLY_MAX_PER_HOUR = 24;
const AUTO_REPLY_PEER_COOLDOWN_MS = 10 * 60 * 1000;
let identityGen = 0;           // bumped on any identity swap so a stale in-flight scan can't set `backfilled`
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
/** On wallet restore the seed changed → drop the cached identity AND the old seed's local inbox/contacts/payaddr,
 *  so the restored (different) identity doesn't show the previous wallet's conversations. Called only on seed change. */
function invalidateIdentity() {
  config.deleteSecret(MAIL_KEY_ACCOUNT);
  identity = null; backfilled = false; seenCoins.clear(); mypayaddr = "";
  identityGen++; repliedReq.clear(); paReplyCooldown.clear(); autoReplyTimes = [];
  try { store.clear(); } catch (e) { /* best effort */ }
}

function threadKey(a, b, subject) { return crypto.createHash("sha256").update([a, b].sort().join("") + (subject || ""), "utf8").digest("hex"); }
function randomId() { return crypto.randomBytes(32).toString("hex"); }
/** A real Minima receiving address: Mx… (base58 alphanumeric, len 40–80) or 0x + exactly 64 hex.
 *  CRUCIALLY rejects a Mail key (0x + 130 hex) so an identity key can never be a pay address, AND enforces the
 *  Mx charset — a whitespace-tolerant length-only check let a crafted "Mx… address:0x<attacker>" pass and, once
 *  interpolated into `send … address:<x> …`, the node's space-tokenised last-wins parser redirected the funds. */
function looksLikeMinimaAddress(a) {
  a = String(a || "").trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}
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
async function pay(toPublicId, payaddr, amount, tokenid, tokenname, memo) {
  await init();
  if (!looksLikeMinimaAddress(payaddr)) throw new Error("Invalid pay address.");   // rejects a Mail key too
  if (!/^[0-9]*\.?[0-9]+$/.test(String(amount)) || parseFloat(amount) <= 0) throw new Error("Invalid amount.");
  if (!/^0x[0-9A-Fa-f]+$/.test(tokenid) && tokenid !== "0x00") throw new Error("Invalid token.");
  // Defense-in-depth beyond the charset validator: have the node parse/verify the address before any funds move
  // (same gate as the wallet's Send tab). Blocks a charset-valid-but-not-real address, and a belt-and-braces stop
  // for the injection class. Only aborts on a definitive falsy/failed reply, never on node-busy ambiguity.
  let chk; try { chk = await nodeCmd(`checkaddress address:${payaddr}`); } catch (e) { chk = null; }
  if (!chk || chk.status === false) throw new Error("Couldn't validate the recipient address — not sending.");
  const memoStr = String(memo || "");
  let r;
  try { r = await nodeCmd(`send amount:${amount} address:${payaddr} tokenid:${tokenid}`); }
  catch (e) {
    // The send may have been ACCEPTED and posted even though the RPC call timed out / the socket reset. Do NOT
    // report a clean failure — that invites a re-pay (double spend). Tell the caller the status is uncertain.
    const amb = new Error("Payment may have been submitted — check your Balance/History before retrying.");
    amb.ambiguous = true; throw amb;
  }
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "payment failed");
  if (!store.metaGet("pa:" + toPublicId)) store.metaSet("pa:" + toPublicId, payaddr);   // remember only if we have no signed-learned address
  // The payment is committed here. A receipt-message failure MUST NOT surface as a payment failure —
  // otherwise the user re-pays (double spend). Post the on-chain receipt best-effort.
  const txpowid = (r.response && r.response.txpowid) || "";
  try { return await sendMessage(toPublicId, { type: "payment", message: memoStr, amount: String(amount), tokenid, tokenname: tokenname || "", txpowid }); }
  catch (e) {
    // Receipt-to-peer failed, but the PAYMENT already went through above. Persist a local ledger entry regardless,
    // so the spend is visible in the thread/history after a restart — otherwise a receipt failure hides real funds leaving.
    try {
      const block = await currentBlock();   // the payment IS on-chain — record the block so it can confirm normally
      store.addMessage({ hashref: threadKey(identity.publicId, toPublicId, ""), fromname: store.metaGet("myname") || "",
        frompublickey: identity.publicId, topublickey: toPublicId, subject: "", message: memoStr, randomid: randomId(),
        incoming: false, read: true, date: Date.now(), status: "sent", sentblock: block, type: "payment",
        amount: String(amount), tokenid, tokenname: tokenname || "", txpowid, image: "", payaddr: mypayaddr });
    } catch (e2) { /* best effort */ }
    emitter.emit("update");
    return { status: "sent", type: "payment", amount: String(amount), tokenid, tokenname: tokenname || "", txpowid, receiptFailed: true };
  }
}

/** Post a control coin (payaddr-req / payaddr-reply) — a sealed wire with NO local message record (it's not chat).
 *  Carries my pay address so the peer can also learn it just from the request. Mirrors native sendPayaddrReq. */
async function sendControl(toPublicId, type) {
  await init();
  if (!mc.isValidPublicId(toPublicId)) return false;
  const wire = { from: identity.publicId, fromname: store.metaGet("myname") || "", to: toPublicId, subject: "",
    message: "", randomid: randomId(), date: Date.now(), type, payaddr: mypayaddr };
  const blob = await mc.seal(identity, toPublicId, Buffer.from(toWire(wire), "utf8"));
  if (blob.length > 49000) return false;
  await sendBlob(blob);
  return true;
}
/** Actively ask a peer for their receiving address (the handshake the old port never initiated). */
async function requestPayaddr(toPublicId) { try { return await sendControl(toPublicId, "payaddr-req"); } catch (e) { return false; } }

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
  const gen = identityGen;              // if the identity is swapped mid-scan, don't let this stale pass set backfilled
  const block = await currentBlock();
  let depth = deep ? BACKFILL_MAX_DEPTH : POLL_DEPTH, coins = null;
  while (depth >= 4) { coins = await queryCoins(depth); if (coins) break; depth = Math.floor(depth / 2); }
  if (!coins) return 0;
  let fresh = 0, paLearned = false, lastFresh = null;
  const paSeen = new Set();             // learn each peer's payaddr once per scan; coins are order:desc so newest wins
  for (const coin of coins) {
    const blob = statePort99(coin);
    if (!blob) continue;
    const seenKey = coin.coinid || ("b:" + blob);                  // fall back to the blob when a coin lacks a coinid
    if (seenCoins.has(seenKey)) continue;                          // already trial-decrypted this session
    if (seenCoins.size > 40000) seenCoins.clear();
    seenCoins.add(seenKey);
    let o; try { o = await mc.open(identity, blob); } catch (e) { o = null; }
    if (!o || !o.valid) continue;
    let m; try { m = JSON.parse(Buffer.from(o.plaintext).toString("utf8")); } catch (e) { continue; }
    if (o.fromPublicId !== m.from) continue;             // signed-from must equal claimed sender
    if (m.to !== identity.publicId) continue;            // addressed to me
    // Learn the peer's pay address (piggybacked on EVERY message/control coin) — once per scan, newest coin first.
    if (m.payaddr && !paSeen.has(m.from)) {
      paSeen.add(m.from);
      if (store.metaGet("pa:" + m.from) !== m.payaddr) { store.metaSet("pa:" + m.from, m.payaddr); paLearned = true; }
    }
    if (m.type === "payaddr-req" || m.type === "payaddr-reply") {
      // For a REQUEST on a LIVE scan, auto-answer with our own address — the handshake. Suppressed during a deep
      // backfill (no reply coin per historical request) AND hard rate-limited (per-peer cooldown + global hourly
      // cap) so a flood of forged requests can't drain coins / WOTS key-uses.
      if (m.type === "payaddr-req" && !deep && !repliedReq.has(m.randomid)) {
        if (repliedReq.size > 2000) repliedReq.clear();
        repliedReq.add(m.randomid);
        const now = Date.now();
        autoReplyTimes = autoReplyTimes.filter(t => now - t < 3600000);
        const last = paReplyCooldown.get(m.from) || 0;
        if (autoReplyTimes.length < AUTO_REPLY_MAX_PER_HOUR && (now - last) > AUTO_REPLY_PEER_COOLDOWN_MS) {
          autoReplyTimes.push(now); paReplyCooldown.set(m.from, now);
          try { await sendControl(m.from, "payaddr-reply"); } catch (e) { /* best effort */ }
        }
      }
      continue;
    }
    const local = { hashref: threadKey(m.from, m.to, m.subject || ""), fromname: m.fromname || "", frompublickey: m.from,
      topublickey: m.to, subject: m.subject || "", message: m.message || "", randomid: m.randomid, incoming: true, read: false,
      date: parseInt(m.date, 10) || Date.now(), status: "received", sentblock: 0, type: m.type || "text",
      amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image, payaddr: m.payaddr || "" };
    if (store.addMessage(local)) { fresh++; lastFresh = local; }
  }
  store.markConfirmed(block);
  store.metaSet("scanned_tip_block", block);
  if (deep && gen === identityGen) backfilled = true;
  if (fresh || paLearned) emitter.emit("update");   // paLearned → an open send-funds sheet can live-fill the address
  if (fresh && !deep && lastFresh) {                 // live (not backfill) → surface an OS notification
    const nm = (store.getContact(lastFresh.frompublickey) || {}).username || lastFresh.fromname || "";
    const preview = lastFresh.type === "image" ? "📷 Photo" : lastFresh.type === "payment" ? "💰 Payment" : (lastFresh.message || "");
    emitter.emit("incoming", { count: fresh, from: lastFresh.frompublickey, name: nm, preview });
  }
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
function resolvePayaddr(peer) { return store.metaGet("pa:" + peer) || ""; }         // a peer's known receiving address (or "")
function myReceivingAddress() { return store.metaGet("mypayaddr") || mypayaddr || ""; }
function shareString() { const id = identity && identity.publicId; const pa = store.metaGet("mypayaddr") || mypayaddr; return pa ? id + "|" + pa : id; }
function setName(name) { store.metaSet("myname", String(name || "")); emitter.emit("update"); }
function threads() { return store.threads().map(t => ({ hashref: t.hashref, unread: t.unread, count: t.count, last: t.last, other: otherOf(t.last) })); }
function otherOf(m) { if (!m || !identity) return ""; return m.incoming ? m.frompublickey : m.topublickey; }
// NOTE: emit ONLY when marking-read actually changed something. The renderer's live-update handler calls these
// to refresh an open thread; emitting unconditionally would re-trigger that handler forever (a self-feeding loop).
function thread(hashref) { if (store.markThreadRead(hashref)) emitter.emit("update"); return store.thread(hashref); }
function threadWith(peer) { if (!identity) return []; const h = threadKey(identity.publicId, peer, ""); if (store.markThreadRead(h)) emitter.emit("update"); return store.thread(h); }
function contacts() { return store.contacts(); }
function addContact(share, name) {
  const parts = String(share || "").split("|");
  const id = parts[0].trim();
  if (!mc.isValidPublicId(id)) throw new Error("That doesn't look like a valid mail id.");
  if (parts[1]) store.metaSet("pa:" + id, parts[1].trim());
  store.addContact(id, name || "");
  return { publicId: id };
}
/** Rename a chat/contact — sets the display name for this peer, creating a contact row if none exists.
 *  The thread title reads the contact name, so a rename reflects everywhere immediately. */
function renameContact(peer, name) {
  if (!mc.isValidPublicId(peer)) throw new Error("Invalid mail id.");
  store.renameContact(peer, String(name || "").trim());
  emitter.emit("update");
  return { publicId: peer };
}
function removeContact(peer) { store.removeContact(peer); emitter.emit("update"); return true; }
function deleteThread(hashref) { store.deleteThread(hashref); emitter.emit("update"); return true; }
function archivedThreads() { return store.archivedThreads().map(t => ({ hashref: t.hashref, unread: t.unread, count: t.count, last: t.last, other: otherOf(t.last) })); }
function setArchived(hashref, on) { store.setArchived(hashref, !!on); emitter.emit("update"); return true; }

// ---- passphrase-encrypted backup (identity + name + contacts + messages), byte-compatible with the native app ----
async function exportBackup(passphrase) {
  // ASCII-only: Android's PBKDF2 (PBEKeySpec) uses low-byte-per-char, not UTF-8, so a non-ASCII passphrase would
  // derive a different key there and the backup wouldn't restore on the phone. Enforce parity by refusing them.
  if (/[^\x20-\x7E]/.test(String(passphrase))) throw new Error("Use an ASCII passphrase (letters, digits, punctuation) so it restores on every device.");
  await init();
  const sk = JSON.parse(mc.serializeIdentity(identity));   // { publicId, boxPk, boxSk, signPk, signSk } (all hex)
  const root = {
    identity: { boxPk: sk.boxPk, boxSk: sk.boxSk, signPk: sk.signPk, signSk: sk.signSk },
    name: store.metaGet("myname") || "",
    // payaddr is an extra field (native ignores it) so a peer can be paid immediately after a desktop→desktop restore.
    contacts: store.contacts().map(c => ({ name: c.username || "", key: c.publicId, payaddr: store.metaGet("pa:" + c.publicId) || "" })),
    // native reads only the base fields; the extra fields keep desktop's payment/image detail on a desktop restore.
    messages: store.all().map(m => ({ hashref: m.hashref, fromname: m.fromname || "", from: m.frompublickey, to: m.topublickey,
      message: m.message || "", randomid: m.randomid, incoming: !!m.incoming, read: !!m.read, date: m.date, status: m.status || "",
      type: m.type || "text", amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image,
      payaddr: m.payaddr || "", sentblock: m.sentblock || 0 })),
  };
  return backup.encrypt(passphrase, Buffer.from(JSON.stringify(root), "utf8"));   // → container JSON string
}
async function importBackup(passphrase, json) {
  if (/[^\x20-\x7E]/.test(String(passphrase))) throw new Error("Use an ASCII passphrase — a non-ASCII one won't match a backup made on another device.");
  await mc.ready();
  const plain = backup.decrypt(passphrase, json);          // throws on a wrong passphrase / tampered file
  const root = JSON.parse(plain.toString("utf8"));
  const kd = root.identity || {};
  if (!kd.boxPk || !kd.boxSk || !kd.signPk || !kd.signSk) throw new Error("Backup is missing the identity keys.");
  const publicId = "0x" + kd.boxPk + kd.signPk;
  if (!mc.isValidPublicId(publicId)) throw new Error("Backup identity is invalid.");
  const restored = mc.loadIdentity(JSON.stringify({ publicId, boxPk: kd.boxPk, boxSk: kd.boxSk, signPk: kd.signPk, signSk: kd.signSk }));
  if (!mc.keypairConsistent(restored)) throw new Error("Backup identity keys are inconsistent (corrupt file).");
  // Everything above validates BEFORE any mutation — a wrong-passphrase / corrupt file can't leave a half-swapped state.
  identityGen++;
  identity = restored;
  config.setSecret(mc.serializeIdentity(identity), MAIL_KEY_ACCOUNT);
  seenCoins.clear(); repliedReq.clear(); paReplyCooldown.clear(); autoReplyTimes = []; backfilled = false; lastTip = 0;
  store.clear();   // drop the PREVIOUS identity's decrypted mail/contacts (confidentiality on a shared/repurposed node)
  if (root.name != null) store.metaSet("myname", String(root.name));
  for (const c of (root.contacts || [])) {
    if (!c || !c.key || !mc.isValidPublicId(String(c.key))) continue;   // don't import garbage contact keys
    store.addContact(String(c.key), String(c.name || ""));
    if (c.payaddr && looksLikeMinimaAddress(String(c.payaddr))) store.metaSet("pa:" + String(c.key), String(c.payaddr));
  }
  for (const m of (root.messages || [])) {
    if (!m || !m.hashref || !m.randomid) continue;
    store.addMessage({ hashref: m.hashref, fromname: m.fromname || "", frompublickey: m.from || "", topublickey: m.to || "",
      subject: "", message: m.message || "", randomid: m.randomid, incoming: !!m.incoming, read: !!m.read,
      date: parseInt(m.date, 10) || Date.now(), status: m.status || "", sentblock: m.sentblock || 0,
      type: m.type || "text", amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid,
      image: m.image, payaddr: m.payaddr || "" });
  }
  try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; mypayaddr = gr.miniaddress || gr.address || ""; if (mypayaddr) store.metaSet("mypayaddr", mypayaddr); } catch (e) {}
  emitter.emit("update");
  scan().catch(() => {});
  return myIdentity();
}

module.exports = { emitter, init, invalidateIdentity, startLoop, stopLoop, scan,
  sendMessage, pay, requestPayaddr, resolvePayaddr, myReceivingAddress, looksLikeMinimaAddress,
  myIdentity, shareString, setName, threads, thread, threadWith, contacts, addContact,
  renameContact, removeContact, deleteThread, archivedThreads, setArchived, exportBackup, importBackup,
  _setRunner, CHAINMAIL, threadKey };
