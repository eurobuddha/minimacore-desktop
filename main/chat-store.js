/*
 * chat-store.js — persistent local store for KeetChat (messages / contacts / meta).
 * Messages are keyed by their wire `msgid` (the cross-transport dedup id from
 * chatschema, falling back to the keets inbox id). The node's sidecar inbox is
 * drained-and-acked by main/chat.js, so this store is the source of truth for
 * history. Same atomic tmp+rename, debounced-write shape as mail-store.js.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const WRITE_DEBOUNCE_MS = 300;
const MAX_MESSAGES = 50000;

let mem = null;   // { messages:{ msgid:msg }, contacts:{ pubkey:{pubkey,name,maximapk} }, meta:{} }
let writeTimer = null;

function filePath() { return path.join(app.getPath("userData"), "chat.json"); }
function ensureLoaded() {
  if (mem) return;
  mem = { messages: {}, contacts: {}, meta: {} };
  let raw = null;
  try { raw = fs.readFileSync(filePath(), "utf8"); }
  catch (e) { return; }   // ENOENT → first run
  try {
    const j = JSON.parse(raw);
    if (j) { mem.messages = j.messages || {}; mem.contacts = j.contacts || {}; mem.meta = j.meta || {}; }
  } catch (e) {
    // existing-but-unparseable: preserve aside, never clobber (mail-store rule)
    try { fs.renameSync(filePath(), filePath() + ".corrupt-" + Date.now()); } catch (e2) { /* best effort */ }
  }
}
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "chat.json.tmp");
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: mem.messages, contacts: mem.contacts, meta: mem.meta }));
      fs.renameSync(tmp, filePath());
    } catch (e) { /* retried next write */ }
  }, WRITE_DEBOUNCE_MS);
}

/** Upsert-if-new by msgid. msg = {msgid, pubkey, incoming, body, name, ref, ts, via, read, status}. Returns true if new. */
function addMessage(m) {
  ensureLoaded();
  if (mem.messages[m.msgid]) return false;
  mem.messages[m.msgid] = m;
  const keys = Object.keys(mem.messages);
  if (keys.length > MAX_MESSAGES) {
    const arr = keys.map(k => mem.messages[k]).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (let i = 0; i < arr.length - MAX_MESSAGES; i++) delete mem.messages[arr[i].msgid];
  }
  persistSoon();
  return true;
}

/** One row per contact pubkey that has messages: {pubkey, last, unread, count}, newest first. */
function threadRows() {
  ensureLoaded();
  const byPk = {};
  for (const m of Object.values(mem.messages)) {
    const t = byPk[m.pubkey] || (byPk[m.pubkey] = { pubkey: m.pubkey, last: null, unread: 0, count: 0 });
    t.count++;
    if (m.incoming && !m.read) t.unread++;
    if (!t.last || (m.ts || 0) >= (t.last.ts || 0)) t.last = m;
  }
  return Object.values(byPk).sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
}
function thread(pubkey) {
  ensureLoaded();
  return Object.values(mem.messages).filter(m => m.pubkey === pubkey).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
function deleteThread(pubkey) {
  ensureLoaded(); let ch = false;
  for (const k of Object.keys(mem.messages)) if (mem.messages[k].pubkey === pubkey) { delete mem.messages[k]; ch = true; }
  if (ch) persistSoon();
}
function markThreadRead(pubkey) {
  ensureLoaded(); let ch = false;
  for (const m of Object.values(mem.messages)) if (m.pubkey === pubkey && m.incoming && !m.read) { m.read = true; ch = true; }
  if (ch) persistSoon();
  return ch;
}
function unreadCount() { ensureLoaded(); return Object.values(mem.messages).filter(m => m.incoming && !m.read).length; }
function setStatus(msgid, patch) {
  ensureLoaded();
  const m = mem.messages[msgid];
  if (!m) return false;
  Object.assign(m, patch);
  persistSoon();
  return true;
}

// contacts — pubkey is the keets pubkey (0x + 64 hex, stored and shown IN FULL);
// maximapk reserved for the Parlons interop era
function contacts() { ensureLoaded(); return Object.values(mem.contacts); }
function addContact(pubkey, name, maximapk) {
  ensureLoaded();
  const c = mem.contacts[pubkey] || { pubkey };
  if (name !== undefined && name !== null && name !== "") c.name = name;
  if (!c.name) c.name = pubkey;
  if (maximapk) c.maximapk = maximapk;
  mem.contacts[pubkey] = c;
  persistSoon();
  return c;
}
function getContact(pubkey) { ensureLoaded(); return mem.contacts[pubkey] || null; }
function removeContact(pubkey) { ensureLoaded(); delete mem.contacts[pubkey]; persistSoon(); }

// meta k/v
function metaGet(k) { ensureLoaded(); return mem.meta[k]; }
function metaSet(k, v) { ensureLoaded(); mem.meta[k] = v; persistSoon(); }

function clear() { mem = { messages: {}, contacts: {}, meta: {} }; persistSoon(); }

module.exports = { addMessage, threadRows, thread, deleteThread, markThreadRead, unreadCount, setStatus,
  contacts, addContact, getContact, removeContact, metaGet, metaSet, clear };
