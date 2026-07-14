/*
 * mail-store.js — persistent local store for minimaMail (messages / contacts / meta), mirroring the native
 * CommsDb. Messages are keyed by `hashref|randomid` (the native UNIQUE dedup). The node prunes coins, so this
 * local store is the source of truth for the inbox. Atomic tmp+rename writes, debounced.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const WRITE_DEBOUNCE_MS = 300;
const MAX_MESSAGES = 50000;

let mem = null;   // { messages:{ "hashref|randomid":msg }, contacts:{ publicId:{publicId,username} }, meta:{} }
let writeTimer = null;

function filePath() { return path.join(app.getPath("userData"), "mail.json"); }
function ensureLoaded() {
  if (mem) return;
  mem = { messages: {}, contacts: {}, meta: {} };
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (j) { mem.messages = j.messages || {}; mem.contacts = j.contacts || {}; mem.meta = j.meta || {}; }
  } catch (e) { /* first run */ }
}
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = app.getPath("userData"); fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "mail.json.tmp");
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: mem.messages, contacts: mem.contacts, meta: mem.meta }));
      fs.renameSync(tmp, filePath());
    } catch (e) { /* retried next write */ }
  }, WRITE_DEBOUNCE_MS);
}
const keyOf = (m) => m.hashref + "|" + m.randomid;

/** Upsert-if-new by (hashref,randomid). Returns true if it was a new message. */
function addMessage(m) {
  ensureLoaded();
  const k = keyOf(m);
  if (mem.messages[k]) return false;
  mem.messages[k] = m;
  const keys = Object.keys(mem.messages);
  if (keys.length > MAX_MESSAGES) {
    const arr = keys.map(x => mem.messages[x]).sort((a, b) => (a.date || 0) - (b.date || 0));
    for (let i = 0; i < arr.length - MAX_MESSAGES; i++) delete mem.messages[keyOf(arr[i])];
  }
  persistSoon();
  return true;
}
function all() { ensureLoaded(); return Object.values(mem.messages); }

/** One row per thread (latest message + unread count), newest first. */
function threads() {
  ensureLoaded();
  const byRef = {};
  for (const m of Object.values(mem.messages)) {
    const t = byRef[m.hashref] || (byRef[m.hashref] = { hashref: m.hashref, last: null, unread: 0, count: 0 });
    t.count++;
    if (m.incoming && !m.read) t.unread++;
    if (!t.last || (m.date || 0) >= (t.last.date || 0)) t.last = m;
  }
  return Object.values(byRef).sort((a, b) => ((b.last && b.last.date) || 0) - ((a.last && a.last.date) || 0));
}
function thread(hashref) { ensureLoaded(); return Object.values(mem.messages).filter(m => m.hashref === hashref).sort((a, b) => (a.date || 0) - (b.date || 0)); }
function markThreadRead(hashref) { ensureLoaded(); let ch = false; for (const m of Object.values(mem.messages)) if (m.hashref === hashref && m.incoming && !m.read) { m.read = true; ch = true; } if (ch) persistSoon(); }
function unreadCount() { ensureLoaded(); return Object.values(mem.messages).filter(m => m.incoming && !m.read).length; }
function markConfirmed(block) { ensureLoaded(); let ch = false; for (const m of Object.values(mem.messages)) if (!m.incoming && m.status === "sent" && m.sentblock && block >= m.sentblock) { m.status = "confirmed"; ch = true; } if (ch) persistSoon(); }

// contacts
function contacts() { ensureLoaded(); return Object.values(mem.contacts); }
function addContact(publicId, username) { ensureLoaded(); mem.contacts[publicId] = { publicId, username: username || "" }; persistSoon(); }
function getContact(publicId) { ensureLoaded(); return mem.contacts[publicId] || null; }
function removeContact(publicId) { ensureLoaded(); delete mem.contacts[publicId]; persistSoon(); }

// meta k/v
function metaGet(k) { ensureLoaded(); return mem.meta[k]; }
function metaSet(k, v) { ensureLoaded(); mem.meta[k] = v; persistSoon(); }

function clear() { mem = { messages: {}, contacts: {}, meta: {} }; persistSoon(); }
function exportAll() { ensureLoaded(); return { messages: mem.messages, contacts: mem.contacts, meta: mem.meta }; }

module.exports = { addMessage, all, threads, thread, markThreadRead, unreadCount, markConfirmed,
  contacts, addContact, getContact, removeContact, metaGet, metaSet, clear, exportAll };
