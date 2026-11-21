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
const REV = 2;   // 1 (no field) = the store up to 0.19.1; 2 = the same shape, file rows allowed

let mem = null;   // { messages:{ msgid:msg }, contacts:{ pubkey:{pubkey,name,maximapk} }, meta:{} }
let writeTimer = null;

function filePath() { return path.join(app.getPath("userData"), "chat.json"); }
function ensureLoaded() {
  if (mem) return;
  // Maps with no prototype (0.19.233): ids a peer writes (a message id, a ref) find only what is stored under them;
  // "__proto__", "constructor" and the like are plain keys, never Object.prototype.
  const bare = (o) => Object.assign(Object.create(null), o && typeof o === "object" && !Array.isArray(o) ? o : {});
  mem = { messages: bare(), contacts: bare(), meta: bare() };
  let raw = null;
  try { raw = fs.readFileSync(filePath(), "utf8"); }
  catch (e) { return; }   // ENOENT → first run
  try {
    const j = JSON.parse(raw);
    if (j) { mem.messages = bare(j.messages); mem.contacts = bare(j.contacts); mem.meta = bare(j.meta); }
    // 0.19.2 adds message rows of a new kind (state "file") and nothing else. The file as the older version left it is
    // copied aside once, before this version writes anything: the node deletes inbox messages once they are stored here.
    if (j && j.rev !== REV) { try { fs.copyFileSync(filePath(), filePath() + ".before-0.19.2", fs.constants.COPYFILE_EXCL); } catch (e2) { /* already kept, or unreadable */ } }
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
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, rev: REV, messages: mem.messages, contacts: mem.contacts, meta: mem.meta }));
      fs.renameSync(tmp, filePath());
    } catch (e) { /* retried next write */ }
  }, WRITE_DEBOUNCE_MS);
}

/** One stored message by id, or null (own entries only). */
function message(msgid) { ensureLoaded(); return typeof msgid === "string" && Object.hasOwn(mem.messages, msgid) ? mem.messages[msgid] : null; }
/** Upsert-if-new by msgid. msg = {msgid, pubkey, incoming, body, name, ref, ts, via, read, status}. Returns true if new. */
function addMessage(m) {
  ensureLoaded();
  if (typeof m.msgid !== "string" || Object.hasOwn(mem.messages, m.msgid)) return false;
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
function deleteMessage(msgid) { ensureLoaded(); if (!mem.messages[msgid]) return false; delete mem.messages[msgid]; persistSoon(); return true; }
function markThreadRead(pubkey) {
  ensureLoaded(); let ch = false;
  for (const m of Object.values(mem.messages)) if (m.pubkey === pubkey && m.incoming && !m.read) { m.read = true; ch = true; }
  if (ch) persistSoon();
  return ch;
}
function unreadCount() { ensureLoaded(); return Object.values(mem.messages).filter(m => m.incoming && !m.read).length; }
/** Read receipt from the peer: our outgoing messages up to uptoTs are peer-read. */
function markPeerRead(pubkey, uptoTs) {
  ensureLoaded(); let ch = false;
  for (const m of Object.values(mem.messages)) {
    if (m.pubkey === pubkey && !m.incoming && !m.peerread && (m.ts || 0) <= uptoTs) { m.peerread = true; ch = true; }
  }
  if (ch) persistSoon();
  return ch;
}
function setStatus(msgid, patch) {
  ensureLoaded();
  const m = message(msgid);
  if (!m) return false;
  Object.assign(m, patch);
  persistSoon();
  return true;
}

// contacts — pubkey is the keets pubkey (0x + 64 hex, stored and shown IN FULL);
// maximapk reserved for the Parlons interop era
function contacts() { ensureLoaded(); return Object.values(mem.contacts); }
function addContact(pubkey, name, maximapk, auto) {
  ensureLoaded();
  const c = mem.contacts[pubkey] || { pubkey };
  if (name !== undefined && name !== null && name !== "") c.name = name;
  // auto=true: the name came from the sender, not the user - it may follow later names.
  // A user-given name (auto omitted/false) clears the flag and sticks.
  c.auto = auto === true;
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

/** Everything, for a chat backup: { messages:[...], contacts:[...], meta:{...} }. */
function all() { ensureLoaded(); return { messages: Object.values(mem.messages), contacts: Object.values(mem.contacts), meta: Object.assign({}, mem.meta) }; }
/** Restore merge: rows already here win; flushed to disk before returning. */
function mergeBackup(contacts, messages, payaddr, myname) {
  ensureLoaded();
  for (const c of contacts) if (c && c.pubkey && !mem.contacts[c.pubkey]) mem.contacts[c.pubkey] = { pubkey: c.pubkey, name: c.name || c.pubkey, auto: false, ...(c.maximapk ? { maximapk: c.maximapk } : {}) };
  for (const m of messages) if (m && m.msgid && !mem.messages[m.msgid]) mem.messages[m.msgid] = m;
  for (const [pk, a] of Object.entries(payaddr || {})) if (a && !mem.meta["payaddr:" + pk]) mem.meta["payaddr:" + pk] = a;
  if (myname && !mem.meta.myname) mem.meta.myname = myname;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "chat.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, rev: REV, messages: mem.messages, contacts: mem.contacts, meta: mem.meta }));
  fs.renameSync(tmp, filePath());
}
function clear() { mem = { messages: {}, contacts: {}, meta: {} }; persistSoon(); }

module.exports = { message, addMessage, threadRows, thread, deleteThread, deleteMessage, markThreadRead, unreadCount, setStatus, markPeerRead,
  contacts, addContact, getContact, removeContact, metaGet, metaSet, clear, all, mergeBackup };
