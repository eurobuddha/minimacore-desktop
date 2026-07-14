/*
 * history-store.js — a persistent, txpowid-keyed transaction-history store.
 *
 * Light nodes PRUNE old txpows, so the node's `history` command only ever returns a recent window. To give a
 * useful, complete wallet history we persist every normalized row the renderer has ever seen into a JSON file
 * under userData, keyed by txpowid (idempotent upsert), and render the list FROM this store — mirroring the
 * native history/utxo apps which keep their own SQLite copy for exactly this reason.
 *
 * Storage: userData/history.json = { version, rows: { <txpowid>: <NormalizedRow> }, updatedAt }.
 * Writes are atomic (tmp + rename) and debounced. A soft cap evicts the lowest-block rows first.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_ROWS = 20000;
const WRITE_DEBOUNCE_MS = 250;

let mem = null;              // in-memory { txpowid: row } (lazy-loaded)
let writeTimer = null;

function filePath() { return path.join(app.getPath("userData"), "history.json"); }

function ensureLoaded() {
  if (mem) return;
  mem = {};
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (j && j.rows && typeof j.rows === "object") mem = j.rows;
  } catch (e) { /* first run / unreadable → empty */ }
}

function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = app.getPath("userData");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "history.json.tmp");
      const payload = JSON.stringify({ version: 1, rows: mem, updatedAt: 0 });
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, filePath());   // atomic swap
    } catch (e) { /* best-effort; retried on the next merge */ }
  }, WRITE_DEBOUNCE_MS);
}

/** All rows, newest chain-height first. */
function all() {
  ensureLoaded();
  return Object.values(mem).sort((a, b) => (b.block || 0) - (a.block || 0) || (b.time || 0) - (a.time || 0));
}

/** Upsert rows by txpowid; a later copy wins. Returns the total stored row count. */
function merge(rows) {
  ensureLoaded();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r.txpowid === "string" && r.txpowid) mem[r.txpowid] = r;
    }
  }
  // soft cap: drop the lowest-block rows
  const keys = Object.keys(mem);
  if (keys.length > MAX_ROWS) {
    const sorted = keys.map(k => mem[k]).sort((a, b) => (a.block || 0) - (b.block || 0));
    for (let i = 0; i < sorted.length - MAX_ROWS; i++) delete mem[sorted[i].txpowid];
  }
  persistSoon();
  return Object.keys(mem).length;
}

/** Wipe the store (used by "clear history" and on wallet restore). */
function clear() {
  mem = {};
  persistSoon();
}

module.exports = { all, merge, clear };
