/*
 * chat.js — KeetChat orchestration (main process). The node's keets sidecar is the
 * transport (pubkey-addressed E2E messages: direct when the peer is online, sealed
 * fleet-mailbox store-and-forward when not — keets/SERVICES.md). This module is the
 * ONE drainer of `keets action:inbox` on this node: it stores to chat-store (acks
 * only after the store write), then emits events for the renderer. Wire payloads
 * are maxima_chat_v1-compatible JSON (chatschema.js) so Parlons-native peers parse
 * them unchanged once parlons-node gains the keets transport.
 *
 * Both node kinds (0.18.17+): the Parlons kind launches the jar with
 * -Dparlons.node.keetschat=off (node-manager), so its KeetsChatBridge stands down
 * and this module is the one drainer there too. Keets chats come into KeetChat,
 * Parlons chats stay in Parlons.
 * Single-drainer exclusion: the embedded node NEVER runs with -mdsenable -
 * the fork's MDS keets poller would be a second acker. If MDS is ever added
 * to the desktop node params, this module must stand down first.
 */
const EventEmitter = require("events");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall, oneCommand } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const store = require("./chat-store");
const schema = require("./chatschema");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const POLL_MS = 1500;   // loopback node command; the sidecar pushes, we must not lag it

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
  const generation = chatGeneration;
  try {
    const status = await nodeCmd("status");
    if (generation === chatGeneration) statusDataDir = status.data || null;
  } catch (e) { }
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
let polling = null;
let myinfo = null;      // { pubkey, drive } from `keets action:info`
let lastErr = "";

// swappable node-command runner (tests use _setRunner, same as mail.js)
let runner = (cmd, timeoutMs) => {
  if (!node.keetsEnabled()) throw new Error("Keets is off.");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd, timeoutMs);
};

// The bundled Parlons node has two RPC workers. All slow background chat work shares one slot.
// KeetsAPI allows 5 s to connect plus 120 s for a sidecar reply. Keep the slot until the node
// answers, including when an offline peer takes the full 30 s media deadline.
const BACKGROUND_TIMEOUT_MS = 135000;
const backgroundJobs = [];
const pendingRead = new Map();
const MAX_PENDING_RECEIPTS = 128;
let backgroundBusy = false, chatGeneration = 0;
let pendingDeliveries = 0, pendingAddressReplies = 0;

async function drainBackground() {
  if (backgroundBusy) return;
  backgroundBusy = true;
  try {
    while (backgroundJobs.length) {
      // A click also promotes an automatic download that is already waiting for its turn.
      const priority = backgroundJobs.findIndex(job => job.entry && job.entry.force);
      const [job] = backgroundJobs.splice(Math.max(priority, 0), 1);
      try { job.resolve(await job.work()); } catch (e) { job.reject(e); }
    }
  } finally {
    backgroundBusy = false;
  }
}

function enqueueBackground(work, entry) {
  return new Promise((resolve, reject) => {
    backgroundJobs.push({ work, entry, resolve, reject });
    drainBackground();
  });
}

function deliveredReceipt(cmd) {
  // Delivery ticks are best effort. A full queue must not delay storing, acknowledging or showing new messages.
  if (pendingDeliveries >= MAX_PENDING_RECEIPTS) return;
  pendingDeliveries++;
  enqueueBackground(() => nodeCmd(cmd, BACKGROUND_TIMEOUT_MS))
    .catch(() => {}).finally(() => { pendingDeliveries--; });
}

function readReceipt(peer, ref) {
  const existing = pendingRead.get(peer);
  if (existing) { existing.ref = ref; return; }
  if (pendingRead.size >= MAX_PENDING_RECEIPTS) return;
  const latest = { ref };
  pendingRead.set(peer, latest);
  enqueueBackground(async () => {
    pendingRead.delete(peer);
    store.metaSet("receipt:" + peer, latest.ref);
    const payload = JSON.stringify(Object.assign(JSON.parse(schema.chatEncodeTyped("", "", { state: "read" })), { ref: latest.ref }));
    await nodeCmd("keets action:send to:" + peer + " datahex:" + hexOf(payload), BACKGROUND_TIMEOUT_MS);
  }).catch(() => {});
}
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd, timeoutMs) {
  const r = await runner(oneCommand(cmd), timeoutMs);   // ONE command each (main/rpc.js, 0.18.177)
  const j = typeof r === "string" ? JSON.parse(r) : r;
  if (!j || j.status !== true) throw new Error((j && j.error) || "keets command failed");
  return j.response;
}

function hexOf(s) { return "0x" + Buffer.from(s, "utf8").toString("hex"); }
// Every value from a peer or the window that is pasted into a keets command (0.18.327): a key is 0x + 64 hex, an inbox id plain
// characters; anything else (a space would add a parameter, a ";" a command) is never put in a command. The inbox names a sender
// with or without the 0x.
const PEER_KEY = /^(0x)?[0-9a-fA-F]{64}$/, INBOX_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const isPeer = (k) => typeof k === "string" && PEER_KEY.test(k);

// ---- identity -------------------------------------------------------------
async function init() {
  if (myinfo) return myinfo;
  const generation = chatGeneration;
  const info = await nodeCmd("keets action:info");
  if (generation !== chatGeneration) throw new Error("Chat node changed");
  myinfo = info;
  return myinfo;
}
function myIdentity() {
  return { pubkey: myinfo ? myinfo.pubkey : "", name: store.metaGet("myname") || "" };
}
function setName(n) { store.metaSet("myname", ("" + (n || "")).trim()); }
/** A restored chat backup replaced the keets keypair: ask the sidecar again on the next init(). */
function forgetIdentity() { myinfo = null; }

// ---- inbox drain ----------------------------------------------------------
async function pollOnce() {
  const generation = chatGeneration;
  if (polling === generation) return;
  polling = generation;
  try {
    if (!myinfo) await init();
    if (generation !== chatGeneration) return;
    await refreshCompanionsDir();
    if (generation !== chatGeneration) return;
    const inbox = await nodeCmd("keets action:inbox");
    let fresh = 0, lastName = "", lastPreview = "";
    for (const msg of inbox) {
      if (generation !== chatGeneration) return;
      if (!msg || !isPeer(msg.from) || typeof msg.id !== "string" || !INBOX_ID.test(msg.id)) {   // 0.18.327: never pasted into a command
        console.error("[chat] an inbox entry whose sender or id is not plain was skipped: " + JSON.stringify(msg && { from: String(msg.from).slice(0, 200), id: String(msg.id).slice(0, 200) }));
        continue;
      }
      const m = capDecoded(schema.chatDecode(msg.message));   // every peer string cut to its length before anything uses or stores it (0.18.172)

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
      if (m.state === "delivered") {
        // the peer stored our message (0.18.18+): single tick -> double tick
        store.markDelivered(m.ref, msg.from);   // only my outgoing message to that sender (0.18.207)
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
        if (generation !== chatGeneration) return;
        // contacts only: answering strangers links the chat identity to the wallet
        const last = payAddrReplied.get(msg.from) || 0;
        if (store.getContact(msg.from) && Date.now() - last > 10 * 60 * 1000 && pendingAddressReplies < MAX_PENDING_RECEIPTS) {
          payAddrReplied.set(msg.from, Date.now());
          pendingAddressReplies++;
          enqueueBackground(async () => {
            const ga = await nodeCmd("getaddress");
            if (generation !== chatGeneration || !store.getContact(msg.from)) return;
            const payload = schema.chatEncodeTyped("", "", { state: "payaddr", addr: ga.miniaddress });
            await nodeCmd("keets action:send to:" + msg.from + " datahex:" + hexOf(payload), BACKGROUND_TIMEOUT_MS);
          }).catch(() => {}).finally(() => { pendingAddressReplies--; });
        }
        continue;
      }

      // unknown states: a future control type must never become a garbage
      // chat row (the keetchat 0.2.1 lesson) - ack + consume
      if (!m.legacy && !["", "image", "audio", "payment"].includes(m.state)) {
        await nodeCmd("keets action:ack id:" + msg.id);
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
        // contact auto-created, named by the sender's self-declared name (else full pubkey);
        // an auto-learned name FOLLOWS the sender until the user renames it by hand (0.18.18+)
        const c = store.getContact(msg.from);
        if (!c) store.addContact(msg.from, m.name || msg.from, undefined, true);
        else if (c.auto && m.name && c.name !== m.name) store.addContact(msg.from, m.name, undefined, true);
        // tell the sender we stored it: their single tick becomes a double tick
        const rcpt = JSON.stringify(Object.assign(JSON.parse(schema.chatEncodeTyped("", "", { state: "delivered" })), { ref: msgid }));
        deliveredReceipt("keets action:send to:" + msg.from + " datahex:" + hexOf(rcpt));
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
    if (generation !== chatGeneration) return;
    lastErr = "";
    if (fresh > 0) {
      emitter.emit("update");
      emitter.emit("incoming", { count: fresh, name: lastName, preview: lastPreview });
    }
  } catch (e) {
    if (generation === chatGeneration) lastErr = e.message || "" + e;   // sidecar starting / node restarting — retry next tick
  } finally {
    if (polling === generation) polling = null;
  }
}

function onNodeStatus(snapshot) {
  if (snapshot.state === "running" && snapshot.keetsEnabled) startLoop();
  else if (pollTimer) stopLoop();
}

function startLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_MS);
  pollOnce().catch(() => {});
}
function stopLoop() {
  chatGeneration++;
  for (const job of backgroundJobs.splice(0)) job.reject(new Error("Chat node changed"));
  pendingRead.clear();
  payAddrReplied.clear();
  mediaInFlight.clear();
  mediaFailed.clear();
  senderDown.clear();
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
const MEDIA_RETRY_MS = 2 * 60 * 1000, MEDIA_RETRY_MAX_MS = 30 * 60 * 1000;
const MAX_PENDING_MEDIA = 256;
const MEDIA_LATER = "This photo could not be fetched just now (its sender may be offline). It is tried again later.";
const mediaInFlight = new Map(), mediaFailed = new Map(), senderDown = new Map();

function mediaPlace(ref) {
  // An inbound ref is attacker-adjacent data: no whitespace (would inject
  // command params) and the extension comes from an ALLOWLIST match, never a
  // raw slice (a crafted "extension" with ../ walked out of mediaDir).
  // 0.18.177: \S allowed ";", ":" and quotes, so a peer's ref could carry a second command into keets action:fetch.
  if (typeof ref !== "string" || !/^keets:\/\/[A-Za-z0-9._~\/-]{1,400}(\?[A-Za-z0-9._~=&%-]{0,200})?$/.test(ref)) throw new Error("bad media ref");
  const key = crypto.createHash("sha256").update(ref).digest("hex").slice(0, 40);
  const clean = ref.split("?")[0].toLowerCase();
  const m2 = clean.match(/\.(ogg|m4a|wav|png|jpe?g)$/);
  const ext = m2 ? m2[0] : ".jpg";
  const mime = ext === ".png" ? "image/png"
             : ext === ".ogg" ? "audio/ogg"
             : ext === ".m4a" ? "audio/mp4"
             : ext === ".wav" ? "audio/wav"
             : "image/jpeg";
  return { file: path.join(mediaDir(), key + ext), mime };
}

function mediaData(file, mime) {
  const size = fs.statSync(file).size;
  if (size === 0) throw new Error("fetch failed");
  if (size > 8 * 1024 * 1024) throw new Error("media too large to inline");
  return "data:" + mime + ";base64," + fs.readFileSync(file).toString("base64");
}

function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}

async function fetchMedia(ref, force = false, sender) {
  const { file, mime } = mediaPlace(ref);
  const pending = mediaInFlight.get(ref);
  if (pending) {
    if (force === true) pending.force = true;
    return pending.result;
  }
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return mediaData(file, mime);

  // The row identifies the sender. A drive named in a message can belong to anyone.
  const peer = isPeer(sender) ? sender.toLowerCase().replace(/^0x/, "") : "";
  const blocked = () => {
    const now = Date.now(), failure = mediaFailed.get(ref);
    return (failure && now < failure.until) || now < (senderDown.get(peer) || 0);
  };
  if (force !== true && blocked()) throw new Error(MEDIA_LATER);
  // A long thread can request every photo in one redraw. Leave one place for a user's click.
  const limit = force === true ? MAX_PENDING_MEDIA : MAX_PENDING_MEDIA - 1;
  if (mediaInFlight.size >= limit) throw new Error("Chat media queue is full. Try again shortly.");
  const generation = chatGeneration;
  const entry = { force: force === true };
  entry.result = enqueueBackground(async () => {
    if (!entry.force && blocked()) throw new Error(MEDIA_LATER);
    const part = file + "." + crypto.randomUUID() + ".part";
    if (/["\u0000-\u001f\u007f;]/.test(part)) throw new Error("The app's data folder name holds a character a node command cannot carry.");
    try {
      await nodeCmd("keets action:fetch url:" + ref + ' file:"' + part + '"', BACKGROUND_TIMEOUT_MS);
      if (generation !== chatGeneration) throw new Error("Chat node changed");
      if (!fs.statSync(part).size) throw new Error("fetch failed");
      fs.renameSync(part, file);
      mediaFailed.delete(ref);
      senderDown.delete(peer);
      return mediaData(file, mime);
    } catch (e) {
      if (generation === chatGeneration && /media unavailable/.test(e.message)) {
        const was = mediaFailed.get(ref), now = Date.now();
        const wait = Math.min(MEDIA_RETRY_MAX_MS, was ? was.wait * 2 : MEDIA_RETRY_MS);
        remember(mediaFailed, ref, { until: now + wait, wait }, 2000);
        if (peer) remember(senderDown, peer, now + MEDIA_RETRY_MS, 500);
      }
      throw e;
    } finally {
      fs.rmSync(part, { force: true });
    }
  }, entry).finally(() => {
    if (mediaInFlight.get(ref) === entry) mediaInFlight.delete(ref);
  });
  mediaInFlight.set(ref, entry);
  return entry.result;
}
/** Publish a local image file to our media drive and send it as a photo message. */
async function sendImageFile(to, filePath) {
  // 0.18.188: said plainly, before anything is sent: a node command cannot carry ; or " (or a control character) in a path
  if (typeof filePath !== "string" || !filePath || /["\u0000-\u001f\u007f;]/.test(filePath)) throw new Error("This file's name or folder holds a ; , a \" or a control character, which a node command cannot carry. Rename the file or move it to another folder, then try again.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(to))) throw new Error("recipient must be a keets pubkey: 0x + 64 hex");
  const ext = path.extname(filePath).toLowerCase(), name = "/chat/img-" + Date.now() + (/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".jpg");
  const pub = await nodeCmd("keets action:publish path:" + name + ' file:"' + filePath + '"');   // quoted: a path may hold spaces
  const payload = schema.chatEncodeTyped(store.metaGet("myname") || "", "", { state: "image", ref: pub.url });
  return sendTyped(to, payload, { state: "image", ref: pub.url, body: "" });
}

// ---- payments ---------------------------------------------------------------
function payAddrOf(pubkey) { return store.metaGet("payaddr:" + pubkey) || ""; }
async function requestPayAddr(to) {
  const payload = schema.chatEncodeTyped("", "", { state: "payaddr-req" });
  await nodeCmd("keets action:send to:" + to + " datahex:" + hexOf(payload));
}
// The currencies a chat payment can carry. MxUSD is the Minima dollar-pegged token; the wire
// (tok/tokname) and every renderer already carried it, only the send path hard-coded Minima.
const PAY_TOKENS = {
  minima: { id: "0x00", name: "Minima" },
  mxusd: { id: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", name: "MxUSD" }
};
async function sendPayment(to, amount, token) {
  const tk = PAY_TOKENS[(token || "minima").toLowerCase()];
  if (!tk) throw new Error("Unknown currency");
  const addr = payAddrOf(to);
  if (!addr) { await requestPayAddr(to); throw new Error("No pay address yet — requested it over chat, try again shortly"); }
  // The same care as Mail and miniMall payments (0.18.207): a plain amount above zero, an address the node accepts, a
  // Minima send pinned clear of unsignable dust, a send that did not answer is "may have been sent" (a retry could pay
  // twice), and a receipt that fails after the payment went is not a failed payment.
  amount = String(amount == null ? "" : amount).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(amount) || !/[1-9]/.test(amount)) throw new Error("Invalid amount: a plain number above zero.");
  if (!/^(0x[0-9A-Fa-f]{2,128}|Mx[0-9A-Za-z]{20,128})$/.test(addr)) throw new Error("This contact's pay address is not a valid address. Nothing was sent.");
  try { await nodeCmd("checkaddress address:" + addr); } catch (e) { throw new Error("Couldn't validate this contact's pay address. Nothing was sent."); }
  let cmd = "send address:" + addr + " amount:" + amount + (tk.id === "0x00" ? "" : " tokenid:" + tk.id);
  if (tk.id === "0x00") { try { cmd = await pinMinimaSend((c) => runner(oneCommand(c)), cmd); } catch (e) { /* unpinned, as written */ } }
  let j;
  try { const r = await runner(oneCommand(cmd)); j = typeof r === "string" ? JSON.parse(r) : r; }
  catch (e) { j = undefined; }
  if (!j || typeof j !== "object") throw new Error("The payment may have been sent (the node did not answer). Check your Balance and History before you try again, so you do not pay twice.");
  if (j.status !== true && j.pending !== true) throw new Error((j.error || "the node refused the payment") + ". Nothing was sent.");
  const txp = j.response;
  const txid = (txp && txp.txpowid) ? "" + txp.txpowid : "";
  const fields = { state: "payment", amt: amount, tok: tk.id, tokname: tk.name, txid, addr };
  const payload = schema.chatEncodeTyped(store.metaGet("myname") || "", "", fields);
  try { return await sendTyped(to, payload, { state: "payment", amt: amount, tok: tk.id, tokname: tk.name, txid, body: "" }); }
  catch (e) { return { receiptFailed: true, txid, error: String((e && e.message) || e) }; }   // the payment went; only the note to the contact did not
}

/** Shared write-before-send for typed messages. */
async function sendTyped(to, payload, fields) {
  if (!isPeer(to)) throw new Error("recipient must be a keets pubkey: 64 hex");   // 0.18.327: payments and photos reach here too
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
  if (latestIn && isPeer(pubkey) && store.metaGet("receipt:" + pubkey) !== latestIn.msgid) {
    readReceipt(pubkey, latestIn.msgid);
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

/* A peer's decoded message, every string cut to a length that keeps any real message whole (0.18.172): the body to
 * 256 KB (one keets message carries at most that), a name 200, a media ref 2048, an address 90, an amount 80, a token id
 * 66, a token name 200, a transaction id 130, a state 20. Done here, not in chatschema.js, which must stay identical to
 * the canonical mds/keetchat copy (scripts/chat-test.cjs). */
const CHAT_CAP = { body: 262144, name: 200, ref: 2048, addr: 90, amt: 80, tok: 66, tokname: 200, txid: 130, state: 20 };
function capDecoded(m) {
  const out = Object.assign({}, m);
  for (const [k, n] of Object.entries(CHAT_CAP)) out[k] = typeof m[k] === "string" ? m[k].slice(0, n) : "";
  return out;
}

module.exports = { emitter, init, myIdentity, setName, startLoop, stopLoop, onNodeStatus, pollOnce, send,
  threads, thread, addContact, renameContact, removeContact, unreadCount, status, _setRunner,
  fetchMedia, sendImageFile, sendPayment, requestPayAddr, payAddrOf, forgetIdentity, _capDecoded: capDecoded, CHAT_CAP };
