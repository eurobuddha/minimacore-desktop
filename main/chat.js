/*
 * chat.js — KeetChat orchestration (main process). The node's keets sidecar is the
 * transport (pubkey-addressed E2E messages: direct when the peer is online, sealed
 * fleet-mailbox store-and-forward when not — keets/SERVICES.md). This module is the
 * ONE drainer of `keets action:inbox` on this node: it stores to chat-store (acks
 * only after the store write), then emits events for the renderer. Wire payloads
 * are maxima_chat_v1-compatible JSON (chatschema.js) so Parlons-native peers parse
 * them unchanged once parlons-node gains the keets transport.
 *
 * minima kind only — the Parlons kind has no keets (node-manager PARLONS_REFUSED).
 */
const EventEmitter = require("events");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const store = require("./chat-store");
const schema = require("./chatschema");

const POLL_MS = 5000;

const emitter = new EventEmitter();
let pollTimer = null;
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
    const inbox = await nodeCmd("keets action:inbox");
    let fresh = 0, lastName = "", lastPreview = "";
    for (const msg of inbox) {
      const m = schema.chatDecode(msg.message);
      const msgid = m.id || msg.id;
      const isNew = store.addMessage({
        msgid, pubkey: msg.from, incoming: true,
        body: m.body, name: m.name, ref: m.ref,
        ts: m.ts || parseInt(msg.ts) || Date.now(),
        via: msg.via, read: false
      });
      if (isNew) {
        // contact auto-created, named by the sender's self-declared name (else full pubkey)
        if (!store.getContact(msg.from)) store.addContact(msg.from, m.name || msg.from);
        fresh++;
        lastName = m.name || (store.getContact(msg.from) || {}).name || msg.from;
        lastPreview = m.body;
      }
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
function thread(pubkey) { store.markThreadRead(pubkey); return store.thread(pubkey); }
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
  threads, thread, addContact, renameContact, removeContact, unreadCount, status, _setRunner };
