/*
 * chat.js — KeetChat orchestration (main process). The node's keets sidecar is the
 * transport (pubkey-addressed E2E messages: direct when the peer is online, sealed
 * fleet-mailbox store-and-forward when not — keets/SERVICES.md). This module is the
 * ONE drainer of `keets action:inbox` on this node: it stores to chat-store (acks
 * only after the store write), then emits events for the renderer. Wire payloads
 * are maxima_chat_v1-compatible JSON (chatschema.js) so Parlons-native peers parse
 * them unchanged once parlons-node gains the keets transport.
 *
 * minima kind only: on the parlons kind the jar's own KeetsChatBridge is the
 * drainer (single-drainer rule), so this module stays off there.
 */
const EventEmitter = require("events");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const store = require("./chat-store");
const schema = require("./chatschema");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const POLL_MS = 5000;

/*
 * Companion fan-out — the desktop twin of the Android KEETS NOTIFY broadcast.
 * A companion chat app on this machine (e.g. Parlons Desktop) registers by
 * writing <node data folder>/keets-companions.json:
 *   [{ "url": "http://127.0.0.1:<port>/keets", "token": "<hex>" }]
 * Every drained message (real AND the read/payaddr controls, never payaddr-req)
 * is POSTed there pre-ack with the x-keets-token header. One-shot, best-effort:
 * a companion that is down misses the event; this app's KeetChat keeps the
 * durable copy. The file anchors in the NODE's data dir because both apps can
 * find that without any new configuration.
 */
// strict parse: startsWith("http://127.0.0.1") would admit 127.0.0.1.evil.com
function isLoopbackUrl(u) {
  try { const p = new URL(u); return p.protocol === "http:" && p.hostname === "127.0.0.1"; }
  catch (e) { return false; }
}
let companionsCache = { mtime: 0, list: [] };
let statusDataDir = null;   // the node's VERSIONED data dir from `status` - the
                            // same path a companion discovers via the RPC, so
                            // both sides anchor on one answer
async function refreshCompanionsDir() {
  if (statusDataDir) return;
  try { statusDataDir = (await nodeCmd("status")).data || null; } catch (e) { }
}
function companions() {
  try {
    if (!statusDataDir) return [];
    const f = path.join(statusDataDir, "keets-companions.json");
    const st = fs.statSync(f);
    if (st.mtimeMs !== companionsCache.mtime) {
      const list = JSON.parse(fs.readFileSync(f, "utf8"));
      companionsCache = { mtime: st.mtimeMs, list: Array.isArray(list) ? list.filter((c) => c && typeof c.url === "string" && isLoopbackUrl(c.url)) : [] };
    }
  } catch (e) {
    companionsCache = { mtime: 0, list: [] };
  }
  return companionsCache.list;
}

function fanout(msg, m) {
  const list = companions();
  if (!list.length) return;
  const body = JSON.stringify({ event: "KEETS", data: {
    id: m.id || msg.id, from: msg.from, ts: m.ts || parseInt(msg.ts) || Date.now(),
    payload: msg.payload, message: m.legacy ? msg.message : m.body,
    name: m.name, ref: m.ref, state: m.state || "", via: msg.via
  }});
  for (const c of list) {
    try {
      const u = new URL(c.url);
      const req = require("http").request({ host: u.hostname, port: u.port, path: u.pathname,
        method: "POST", timeout: 3000,
        headers: { "Content-Type": "application/json", "x-keets-token": c.token || "" } });
      req.on("error", () => {});
      req.on("timeout", () => req.destroy());
      req.end(body);
    } catch (e) { /* best-effort */ }
  }
}

const emitter = new EventEmitter();
let pollTimer = null;
const payAddrReplied = new Map();   // peer -> last auto-reply ms (10-min cooldown)
let polling = false;
let myinfo = null;      // { pubkey, drive } from `keets action:info`
let lastErr = "";

// swappable node-command runner (tests use _setRunner, same as mail.js)
let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) {
  const r = await runner(cmd);
  const j = typeof r === "string" ? JSON.parse(r) : r;
  if (!j || j.status !== true) throw new Error((j && j.error) || "keets command failed");
  return j.response;
}

function hexOf(s) { return "0x" + Buffer.from(s, "utf8").toString("hex"); }

// ---- identity -------------------------------------------------------------
async function init() {
  if (myinfo) return myinfo;
  myinfo = await nodeCmd("keets action:info");
  return myinfo;
}
function myIdentity() {
  return { pubkey: myinfo ? myinfo.pubkey : "", name: store.metaGet("myname") || "" };
}
function setName(n) { store.metaSet("myname", ("" + (n || "")).trim()); }

// ---- inbox drain ----------------------------------------------------------
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    if (!myinfo) await init();
    await refreshCompanionsDir();
    const inbox = await nodeCmd("keets action:inbox");
    let fresh = 0, lastName = "", lastPreview = "";
    for (const msg of inbox) {
      const m = schema.chatDecode(msg.message);

      // control messages: consumed, never stored or notified
      if (m.state === "read") {
        // prefer the referenced message's own timestamp (peer clocks drift)
        let upto = m.ts || Date.now();
        if (m.ref) {
          const target = store.thread(msg.from).find(x => x.msgid === m.ref);
          if (target && target.ts) upto = target.ts;
        }
        store.markPeerRead(msg.from, upto);
        fanout(msg, m);
        await nodeCmd("keets action:ack id:" + msg.id);
        emitter.emit("update");
        continue;
      }
      if (m.state === "payaddr") {
        // contacts only: a control message must never create a contact, or any
        // stranger can plant a payee row with their address
        if (store.getContact(msg.from) && /^(0x|Mx)[0-9A-Za-z]+$/.test(m.addr)) {
          store.metaSet("payaddr:" + msg.from, m.addr);
          fanout(msg, m);
        }
        await nodeCmd("keets action:ack id:" + msg.id);
        emitter.emit("update");
        continue;
      }
      if (m.state === "payaddr-req") {
        await nodeCmd("keets action:ack id:" + msg.id);
        // contacts only: answering strangers links the chat identity to the wallet
        const last = payAddrReplied.get(msg.from) || 0;
        if (store.getContact(msg.from) && Date.now() - last > 10 * 60 * 1000) {
          payAddrReplied.set(msg.from, Date.now());
          try {
            const ga = await nodeCmd("getaddress");
            const payload = schema.chatEncodeTyped("", "", { state: "payaddr", addr: ga.miniaddress });
            await nodeCmd("keets action:send to:" + msg.from + " datahex:" + hexOf(payload));
          } catch (e) { /* node busy — they can re-request */ }
        }
        continue;
      }

      const msgid = m.id || msg.id;
      const isNew = store.addMessage({
        msgid, pubkey: msg.from, incoming: true,
        body: m.body, name: m.name, ref: m.ref,
        state: m.state, amt: m.amt, tokname: m.tokname, txid: m.txid,
        ts: m.ts || parseInt(msg.ts) || Date.now(),
        via: msg.via, read: false
      });
      if (isNew) {
        // contact auto-created, named by the sender's self-declared name (else full pubkey)
        if (!store.getContact(msg.from)) store.addContact(msg.from, m.name || msg.from);
        fresh++;
        lastName = m.name || (store.getContact(msg.from) || {}).name || msg.from;
        lastPreview = m.state === "image" ? "📷 Photo"
                    : m.state === "audio" ? "🎤 Voice note"
                    : m.state === "payment" ? "💸 " + m.amt + " " + (m.tokname || "Minima")
                    : m.body;
      }
      if (isNew) fanout(msg, m);
      // ack ONLY after the durable store write — this module owns the inbox
      await nodeCmd("keets action:ack id:" + msg.id);
    }
    lastErr = "";
    if (fresh > 0) {
      emitter.emit("update");
      emitter.emit("incoming", { count: fresh, name: lastName, preview: lastPreview });
    }
  } catch (e) {
    lastErr = e.message || "" + e;   // sidecar starting / node restarting — retry next tick
  } finally {
    polling = false;
  }
}

function startLoop() {
  if (pollTimer) return;
  if (node.kind && node.kind() === "parlons") return;   // no keets on the parlons kind
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_MS);
  pollOnce().catch(() => {});
}
function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  myinfo = null;
  // a restarted node may run a different version = different data dir
  statusDataDir = null;
  companionsCache = { mtime: 0, list: [] };
}

// ---- sending --------------------------------------------------------------
async function send(toPubkey, text) {
  const to = ("" + toPubkey).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a keets pubkey: 0x + 64 hex");
  const payload = schema.chatEncode(store.metaGet("myname") || "", text);
  const msgid = JSON.parse(payload).id;
  // write-before-send so a crash can't lose the message (mail.js lifecycle rule)
  store.addMessage({ msgid, pubkey: to, incoming: false, body: "" + text, name: "", ref: "",
    ts: Date.now(), via: "", read: true, status: "sending" });
  emitter.emit("update");
  try {
    const r = await nodeCmd("keets action:send to:" + to + " datahex:" + hexOf(payload));
    store.setStatus(msgid, { via: r.delivered, status: r.delivered === "direct" ? "delivered" : "mailboxed" });
  } catch (e) {
    store.setStatus(msgid, { status: "failed", error: e.message });
    emitter.emit("update");
    throw e;
  }
  emitter.emit("update");
  return store.thread(to).find(m => m.msgid === msgid);
}

// ---- media ------------------------------------------------------------------
function mediaDir() {
  const d = path.join(app.getPath("userData"), "chatimg");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Fetch a keets:// photo (disk-cached) and return it as a data url for the renderer. */
async function fetchMedia(ref) {
  // An inbound ref is attacker-adjacent data: no whitespace (would inject
  // command params) and the extension comes from an ALLOWLIST match, never a
  // raw slice (a crafted "extension" with ../ walked out of mediaDir).
  if (!/^keets:\/\/\S+$/.test(ref)) throw new Error("bad media ref");
  const key = crypto.createHash("sha256").update(ref).digest("hex").slice(0, 40);
  const clean = ref.split("?")[0].toLowerCase();
  const m2 = clean.match(/\.(ogg|m4a|wav|png|jpe?g)$/);
  const ext = m2 ? m2[0] : ".jpg";
  const mime = ext === ".png" ? "image/png"
             : ext === ".ogg" ? "audio/ogg"
             : ext === ".m4a" ? "audio/mp4"
             : ext === ".wav" ? "audio/wav"
             : "image/jpeg";
  const f = path.join(mediaDir(), key + ext);
  if (!fs.existsSync(f)) {
    await nodeCmd("keets action:fetch url:" + ref + " file:" + f);
  }
  // 16MB mesh files exist; a >8MB base64 data: URL stalls main + the DOM.
  if (!fs.existsSync(f)) throw new Error("fetch failed");
  if (fs.statSync(f).size > 8 * 1024 * 1024) throw new Error("media too large to inline");
  if (fs.statSync(f).size === 0) { fs.unlinkSync(f); throw new Error("fetch failed"); }
  return "data:" + mime + ";base64," + fs.readFileSync(f).toString("base64");
}
/** Publish a local image file to our media drive and send it as a photo message. */
async function sendImageFile(to, filePath) {
  const name = "/chat/img-" + Date.now() + path.extname(filePath).toLowerCase();
  const pub = await nodeCmd("keets action:publish path:" + name + " file:" + filePath);
  const payload = schema.chatEncodeTyped(store.metaGet("myname") || "", "", { state: "image", ref: pub.url });
  return sendTyped(to, payload, { state: "image", ref: pub.url, body: "" });
}

// ---- payments ---------------------------------------------------------------
function payAddrOf(pubkey) { return store.metaGet("payaddr:" + pubkey) || ""; }
async function requestPayAddr(to) {
  const payload = schema.chatEncodeTyped("", "", { state: "payaddr-req" });
  await nodeCmd("keets action:send to:" + to + " datahex:" + hexOf(payload));
}
async function sendPayment(to, amount) {
  const addr = payAddrOf(to);
  if (!addr) { await requestPayAddr(to); throw new Error("No pay address yet — requested it over chat, try again shortly"); }
  if (!/^[0-9]+(\.[0-9]+)?$/.test("" + amount)) throw new Error("Invalid amount");
  const txp = await nodeCmd("send address:" + addr + " amount:" + amount);
  const txid = (txp && txp.txpowid) ? "" + txp.txpowid : "";
  const payload = schema.chatEncodeTyped(store.metaGet("myname") || "", "",
      { state: "payment", amt: "" + amount, tokname: "Minima", txid, addr });
  return sendTyped(to, payload, { state: "payment", amt: "" + amount, tokname: "Minima", txid, body: "" });
}

/** Shared write-before-send for typed messages. */
async function sendTyped(to, payload, fields) {
  const msgid = JSON.parse(payload).id;
  store.addMessage(Object.assign({ msgid, pubkey: to, incoming: false, name: "", ref: "",
    ts: Date.now(), via: "", read: true, status: "sending" }, fields));
  emitter.emit("update");
  try {
    const r = await nodeCmd("keets action:send to:" + to + " datahex:" + hexOf(payload));
    store.setStatus(msgid, { via: r.delivered, status: r.delivered === "direct" ? "delivered" : "mailboxed" });
  } catch (e) {
    store.setStatus(msgid, { status: "failed", error: e.message });
    emitter.emit("update");
    throw e;
  }
  emitter.emit("update");
  return store.thread(to).find(m => m.msgid === msgid);
}

// ---- renderer API ---------------------------------------------------------
function threads() {
  // one row per contact, merged with contact names; contacts with no messages still show
  const rows = store.threadRows();
  const byPk = {};
  for (const r of rows) byPk[r.pubkey] = r;
  const out = [];
  for (const c of store.contacts()) {
    const r = byPk[c.pubkey] || { pubkey: c.pubkey, last: null, unread: 0, count: 0 };
    r.name = c.name || c.pubkey;
    delete byPk[c.pubkey];
    out.push(r);
  }
  for (const r of Object.values(byPk)) { r.name = r.pubkey; out.push(r); }   // messages from non-contacts
  return out.sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
}
function thread(pubkey) {
  store.markThreadRead(pubkey);
  const msgs = store.thread(pubkey);
  // read receipt to the peer (blue ticks their side), deduped on the newest incoming id
  const latestIn = [...msgs].reverse().find(m => m.incoming);
  if (latestIn && store.metaGet("receipt:" + pubkey) !== latestIn.msgid) {
    store.metaSet("receipt:" + pubkey, latestIn.msgid);
    const payload = JSON.stringify(Object.assign(JSON.parse(schema.chatEncodeTyped("", "", { state: "read" })), { ref: latestIn.msgid }));
    nodeCmd("keets action:send to:" + pubkey + " datahex:" + hexOf(payload)).catch(() => {});
  }
  return msgs;
}
function addContact(pubkey, name) {
  const pk = ("" + pubkey).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(pk)) throw new Error("pubkey must be 0x + 64 hex");
  return store.addContact(pk, name);
}
function renameContact(pubkey, name) { return store.addContact(pubkey, name); }
function removeContact(pubkey) { store.removeContact(pubkey); store.deleteThread(pubkey); }
function unreadCount() { return store.unreadCount(); }
function status() { return { running: !!pollTimer, pubkey: myinfo ? myinfo.pubkey : "", lastError: lastErr, unread: store.unreadCount() }; }

module.exports = { emitter, init, myIdentity, setName, startLoop, stopLoop, pollOnce, send,
  threads, thread, addContact, renameContact, removeContact, unreadCount, status, _setRunner,
  fetchMedia, sendImageFile, sendPayment, requestPayAddr, payAddrOf };
