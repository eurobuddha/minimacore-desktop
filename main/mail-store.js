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
  let raw = null;
  try { raw = fs.readFileSync(filePath(), "utf8"); }
  catch (e) { return; }   // ENOENT → genuine first run; leave the empty store
  try {
    const j = JSON.parse(raw);
    if (j) { mem.messages = j.messages || {}; mem.contacts = j.contacts || {}; mem.meta = j.meta || {}; }
  } catch (e) {
    // The file EXISTS but is unparseable. This store is the source of truth (the node prunes coins), so we must NOT
    // silently reset and let the next write clobber it. Preserve the bad file aside for recovery, then start fresh.
    try { fs.renameSync(filePath(), filePath() + ".corrupt-" + Date.now()); } catch (e2) { /* best effort */ }
  }
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

/** All threads, one row each (latest message + unread count), newest first — archived and not. */
function allThreadRows() {
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
/** Inbox = non-archived threads. */
function threads() { const arch = archivedSet(); return allThreadRows().filter(t => !arch.has(t.hashref)); }
/** The Archived view = archived threads only. */
function archivedThreads() { const arch = archivedSet(); return allThreadRows().filter(t => arch.has(t.hashref)); }
function thread(hashref) { ensureLoaded(); return Object.values(mem.messages).filter(m => m.hashref === hashref).sort((a, b) => (a.date || 0) - (b.date || 0)); }
/** Delete every message in a thread (and drop its archived flag). */
function deleteThread(hashref) {
  ensureLoaded(); let ch = false;
  for (const k of Object.keys(mem.messages)) if (mem.messages[k].hashref === hashref) { delete mem.messages[k]; ch = true; }
  if (mem.meta["arch:" + hashref]) { delete mem.meta["arch:" + hashref]; ch = true; }
  if (ch) persistSoon();
}
// archive state lives in meta under `arch:<hashref>`
function archivedSet() { ensureLoaded(); const s = new Set(); for (const k in mem.meta) if (k.indexOf("arch:") === 0 && mem.meta[k]) s.add(k.slice(5)); return s; }
function setArchived(hashref, on) { ensureLoaded(); if (on) mem.meta["arch:" + hashref] = true; else delete mem.meta["arch:" + hashref]; persistSoon(); }
function markThreadRead(hashref) { ensureLoaded(); let ch = false; for (const m of Object.values(mem.messages)) if (m.hashref === hashref && m.incoming && !m.read) { m.read = true; ch = true; } if (ch) persistSoon(); return ch; }
function unreadCount() { ensureLoaded(); return Object.values(mem.messages).filter(m => m.incoming && !m.read).length; }
function markConfirmed(block) { ensureLoaded(); let ch = false; for (const m of Object.values(mem.messages)) if (!m.incoming && m.status === "sent" && m.sentblock && block >= m.sentblock) { m.status = "confirmed"; ch = true; } if (ch) persistSoon(); }

// contacts
function contacts() { ensureLoaded(); return Object.values(mem.contacts); }
function addContact(publicId, username) { ensureLoaded(); mem.contacts[publicId] = { publicId, username: username || "" }; persistSoon(); }
/** Rename (or name) a contact, creating the row if this peer wasn't a saved contact yet. */
function renameContact(publicId, username) { ensureLoaded(); const c = mem.contacts[publicId] || { publicId }; c.username = username || ""; mem.contacts[publicId] = c; persistSoon(); }
function getContact(publicId) { ensureLoaded(); return mem.contacts[publicId] || null; }
function removeContact(publicId) { ensureLoaded(); delete mem.contacts[publicId]; persistSoon(); }

// meta k/v
function metaGet(k) { ensureLoaded(); return mem.meta[k]; }
function metaSet(k, v) { ensureLoaded(); mem.meta[k] = v; persistSoon(); }

function clear() { mem = { messages: {}, contacts: {}, meta: {} }; persistSoon(); }
function exportAll() { ensureLoaded(); return { messages: mem.messages, contacts: mem.contacts, meta: mem.meta }; }

module.exports = { addMessage, all, threads, archivedThreads, thread, deleteThread, setArchived, archivedSet,
  markThreadRead, unreadCount, markConfirmed,
  contacts, addContact, renameContact, getContact, removeContact, metaGet, metaSet, clear, exportAll };
