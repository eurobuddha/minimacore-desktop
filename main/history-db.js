/*
 * history-db.js — a rich, deep, LOCALLY-OWNED transaction-history store backed by SQLite (sql.js WASM).
 *
 * Supersedes the old JSON blob store (history-store.js). The node retains every wallet-relevant txpow
 * indefinitely (only isrelevant=0 rows age out), so `history relevant:true` gives the complete wallet history
 * forward from first sync — we capture it in FULL FIDELITY here so it is permanent, queryable, and immune to any
 * future node pruning. This DB is the sole source of truth for the History tab; the node is only the feed, and any
 * block-explorer link is a convenience, never a dependency.
 *
 * Reuses the sql.js engine that already backs PandaPools (main/pandapools/sqlshim.js) — a second DB instance at
 * <userData>/history.sqlite; no new dependency. We drive `_db` directly with prepared statements + BOUND params
 * (no string interpolation of user input → no SQL injection) and schedule the shim's debounced whole-image save.
 *
 * On first init an existing history.json is migrated in, then renamed history.json.migrated (never lose data).
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { makeSqlShim } = require("./pandapools/sqlshim");

const MAX_ROWS = 200000;     // soft cap; trims lowest-block rows if exceeded (a busy wallet is still far below this)

let shim = null, db = null, readyP = null;

function dbPath() { return path.join(app.getPath("userData"), "history.sqlite"); }

function ensureReady() { if (!readyP) readyP = init(); return readyP; }

async function init() {
  shim = await makeSqlShim(dbPath());
  db = shim._db;
  db.run(`CREATE TABLE IF NOT EXISTS tx (
    txpowid TEXT PRIMARY KEY,
    block INTEGER, time INTEGER,
    istransaction INTEGER, isblock INTEGER, size INTEGER,
    burn TEXT,
    direction TEXT, kind TEXT,
    primary_tokenid TEXT, primary_tokenname TEXT, primary_amount TEXT,
    counterparty TEXT,
    in_count INTEGER, out_count INTEGER,
    difference_json TEXT, inputs_json TEXT, outputs_json TEXT, state_json TEXT,
    raw_json TEXT,
    captured_at INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_tx_block ON tx(block DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_tx_time  ON tx(time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_tx_token ON tx(primary_tokenid)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_tx_dir   ON tx(direction)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_tx_cp    ON tx(counterparty)`);
  migrateFromJson();
}

// One-time import of the legacy JSON store, then rename it aside so we never re-import or lose it.
function migrateFromJson() {
  const legacy = path.join(app.getPath("userData"), "history.json");
  let rows;
  try { rows = JSON.parse(fs.readFileSync(legacy, "utf8")); }
  catch (e) { return; }   // no legacy file / unreadable
  try {
    const list = rows && rows.rows && typeof rows.rows === "object" ? Object.values(rows.rows) : [];
    if (list.length) { insertBatch(list); shim.persist(); }   // schedule the whole-image save so the migration is durable
    fs.renameSync(legacy, legacy + ".migrated");
  } catch (e) { /* best-effort; leave the JSON in place if the rename fails */ }
}

// ---- helpers: coerce a normalized renderer row → column values ----
function iOr(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function bI(v) { return v ? 1 : 0; }
function sOr(v) { return (v === undefined || v === null) ? null : String(v); }
function jOr(v) { try { return v == null ? null : JSON.stringify(v); } catch (e) { return null; } }
function pJson(s) { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } }

const INSERT_SQL = `INSERT OR REPLACE INTO tx
  (txpowid, block, time, istransaction, isblock, size, burn, direction, kind,
   primary_tokenid, primary_tokenname, primary_amount, counterparty, in_count, out_count,
   difference_json, inputs_json, outputs_json, state_json, raw_json, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function rowParams(r) {
  return [
    String(r.txpowid),
    iOr(r.block), iOr(r.time),
    bI(r.istransaction), bI(r.isblock), iOr(r.size),
    sOr(r.burn),
    sOr(r.direction), sOr(r.kind),
    sOr(r.tokenid), sOr(r.tokenName), sOr(r.amount),
    sOr(r.counterparty),
    iOr(r.inCount), iOr(r.outCount),
    jOr(r.difference), jOr(r.inputs), jOr(r.outputs), jOr(r.state),
    r.raw != null ? jOr(r.raw) : null,
    Date.now()
  ];
}

// Insert many rows in one transaction with a single reused prepared statement (fast); caller persists.
function insertBatch(rows) {
  const valid = rows.filter(r => r && typeof r.txpowid === "string" && r.txpowid);
  if (!valid.length) return 0;
  const stmt = db.prepare(INSERT_SQL);
  db.run("BEGIN");
  try {
    for (const r of valid) { stmt.run(rowParams(r)); }
    db.run("COMMIT");
  } catch (e) { try { db.run("ROLLBACK"); } catch (e2) {} throw e; }
  finally { stmt.free(); }
  return valid.length;
}

function trimIfNeeded() {
  const n = countSync();
  if (n <= MAX_ROWS) return;
  // delete the lowest-block rows beyond the cap
  db.run(`DELETE FROM tx WHERE txpowid IN (
    SELECT txpowid FROM tx ORDER BY block ASC, time ASC LIMIT ?
  )`, [n - MAX_ROWS]);
}

function countSync() {
  const stmt = db.prepare(`SELECT COUNT(*) AS c FROM tx`);
  stmt.step(); const c = stmt.getAsObject().c; stmt.free();
  return c || 0;
}

// Map a DB row back to the shape the renderer already consumes (histGet / renderHistoryList).
function toRow(d) {
  return {
    txpowid: d.txpowid, block: d.block, time: d.time,
    istransaction: !!d.istransaction, isblock: !!d.isblock, size: d.size,
    burn: d.burn,
    direction: d.direction, kind: d.kind,
    tokenid: d.primary_tokenid, tokenName: d.primary_tokenname, amount: d.primary_amount,
    counterparty: d.counterparty,
    inCount: d.in_count, outCount: d.out_count,
    difference: pJson(d.difference_json) || {},
    inputs: pJson(d.inputs_json) || [],
    outputs: pJson(d.outputs_json) || [],
    state: pJson(d.state_json) || []
  };
}

function selectRows(where, params, limit, offset) {
  let sql = `SELECT * FROM tx`;
  if (where) sql += ` WHERE ${where}`;
  sql += ` ORDER BY block DESC, time DESC`;
  if (limit != null) sql += ` LIMIT ${parseInt(limit, 10) || 0}`;
  if (offset) sql += ` OFFSET ${parseInt(offset, 10) || 0}`;
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(toRow(stmt.getAsObject()));
  stmt.free();
  return out;
}

// ---- public API (all async; await ready) ----

/** Upsert normalized rows. Returns the total stored row count. */
async function merge(rows) {
  await ensureReady();
  if (!Array.isArray(rows) || !rows.length) return countSync();
  insertBatch(rows);
  trimIfNeeded();
  shim.persist();
  return countSync();
}

/** All rows, newest chain-height first. Optional limit (default: everything — the History tab renders these). */
async function all(limit) {
  await ensureReady();
  return selectRows(null, null, limit != null ? limit : null, 0);
}

/**
 * Filtered, paged query (Stage 2). filters:
 *   { search, token, direction, from, to, limit, offset }
 * search → LIKE across counterparty / token name / txpowid; token → primary_tokenid equality;
 * direction → one of in|out|self|split|consolidation (matched against direction OR kind);
 * from/to → time range (ms). All values are BOUND, never interpolated.
 */
async function query(filters) {
  await ensureReady();
  filters = filters || {};
  const clauses = [], params = [];
  if (filters.search) {
    const like = "%" + String(filters.search).trim() + "%";
    clauses.push(`(counterparty LIKE ? OR primary_tokenname LIKE ? OR txpowid LIKE ?)`);
    params.push(like, like, like);
  }
  if (filters.token) { clauses.push(`primary_tokenid = ?`); params.push(String(filters.token)); }
  if (filters.direction) { clauses.push(`(direction = ? OR kind = ?)`); params.push(String(filters.direction), String(filters.direction)); }
  if (filters.from != null) { clauses.push(`time >= ?`); params.push(iOr(filters.from)); }
  if (filters.to != null) { clauses.push(`time <= ?`); params.push(iOr(filters.to)); }
  const where = clauses.length ? clauses.join(" AND ") : null;
  const limit = filters.limit != null ? filters.limit : 500;
  return selectRows(where, params, limit, filters.offset || 0);
}

/** Distinct tokens seen in history (for the filter dropdown): [{tokenid, name}]. */
async function tokens() {
  await ensureReady();
  const stmt = db.prepare(`SELECT primary_tokenid AS tokenid, primary_tokenname AS name, COUNT(*) AS c
                           FROM tx GROUP BY primary_tokenid ORDER BY c DESC`);
  const out = [];
  while (stmt.step()) { const o = stmt.getAsObject(); if (o.tokenid) out.push({ tokenid: o.tokenid, name: o.name }); }
  stmt.free();
  return out;
}

async function count() { await ensureReady(); return countSync(); }

async function stats() {
  await ensureReady();
  const stmt = db.prepare(`SELECT COUNT(*) AS c, MIN(block) AS minb, MAX(block) AS maxb,
                                  MIN(time) AS mint, MAX(time) AS maxt FROM tx`);
  stmt.step(); const o = stmt.getAsObject(); stmt.free();
  return { count: o.c || 0, minBlock: o.minb || null, maxBlock: o.maxb || null, minTime: o.mint || null, maxTime: o.maxt || null };
}

async function clear() {
  await ensureReady();
  db.run(`DELETE FROM tx`);
  shim.persist();
}

/** Synchronous whole-image save; called from app before-quit. No-op if never initialised. */
function flush() { if (shim) shim.flush(); }

module.exports = { merge, all, query, tokens, count, stats, clear, flush };
