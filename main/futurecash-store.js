/*
 * futurecash-store.js — Future Cash Next's own store, one SQLite file per wallet (main/futurecash.js names it).
 *
 * The native app (apks/base integrated/futurecash-next) keeps two work tables in SQLite (Store.java: fc_collect,
 * fc_sweep, same columns, same status words) and its settings, verdict and activity log in SharedPreferences (Cfg.java,
 * the MiniDapp's keypair keys). Here both live in one file: the tables as they are, the settings as rows of fc_kv (the
 * same key names, every value a string, as Cfg keeps them), and fc_retired, the addresses this app took out of the
 * node's change rotation (the desktop records what it retired; the phone does not).
 *
 * sql.js (SQLite in WASM, already used by the PandaPools and AtomiX stores). Values are always BOUND, never put into the
 * statement text. EVERY WRITE IS ON DISK BEFORE IT RETURNS (whole image, tmp file, fsync, rename): Cfg.set uses commit()
 * for the same reason, "an unflushed 'we already posted this collect' is how a coin gets collected twice". A file that
 * fails SQLite's own check is never opened (the caller says so and leaves it where it is).
 */
"use strict";
const fs = require("fs");
const path = require("path");

let sqlReady = null;
function sqlJs() {
  if (!sqlReady) {
    const initSqlJs = require("sql.js");
    const wasm = fs.readFileSync(path.join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"));
    sqlReady = initSqlJs({ wasmBinary: wasm });
  }
  return sqlReady;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS fc_collect (fc_coinid TEXT PRIMARY KEY, payout_address TEXT, tokenid TEXT, out_amount TEXT, mature_block INTEGER DEFAULT 0, at_risk INTEGER DEFAULT 0, status TEXT, collect_block INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, updated INTEGER, note TEXT)",
  "CREATE TABLE IF NOT EXISTS fc_sweep (coinid TEXT PRIMARY KEY, address TEXT, tokenid TEXT, amount TEXT, status TEXT, sweep_block INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, updated INTEGER, note TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_collect_status ON fc_collect(status)",
  "CREATE INDEX IF NOT EXISTS idx_sweep_status ON fc_sweep(status)",
  "CREATE TABLE IF NOT EXISTS fc_kv (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS fc_retired (address TEXT PRIMARY KEY, mx TEXT, script TEXT, at INTEGER, block INTEGER)"
];

/** Open (or make) the store at `file`. Throws when the file is there and is not a sound SQLite database. */
async function open(file, o = {}) {
  const SQL = await sqlJs();
  let db;
  if (fs.existsSync(file)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
    const check = db.exec("PRAGMA quick_check");
    if (!check.length || check[0].values.some(r => r[0] !== "ok")) { db.close(); throw new Error("the Future Cash store failed its integrity check"); }
  } else db = new SQL.Database();
  for (const s of SCHEMA) db.run(s);
  const now = o.now || Date.now;

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp", fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, Buffer.from(db.export())); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  if (!fs.existsSync(file)) save();
  const all = (q, p) => { const st = db.prepare(q); try { st.bind(p || []); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } };
  const one = (q, p) => all(q, p)[0] || null;
  /** A write: run, then on disk. → how many rows it changed (the atomic claims read this). */
  const run = (q, p) => { db.run(q, p || []); const n = db.getRowsModified(); save(); return n; };

  const kv = {
    get: (k, dflt) => { const r = one("SELECT v FROM fc_kv WHERE k=?", [k]); return r && r.v !== "" && r.v != null ? String(r.v) : (dflt === undefined ? null : dflt); },
    set: (k, v) => { run("INSERT OR REPLACE INTO fc_kv (k, v) VALUES (?, ?)", [k, v == null ? "" : String(v)]); },
    is: (k, dflt) => { const v = kv.get(k, null); return v == null ? !!dflt : v === "1"; },
    setBool: (k, on) => kv.set(k, on ? "1" : "0"),
    getLong: (k) => { const n = Number(kv.get(k, "0")); return Number.isSafeInteger(n) ? n : 0; },
    remove: (k) => { run("DELETE FROM fc_kv WHERE k=?", [k]); }
  };
  const rowC = (r) => ({ coinid: r.fc_coinid, payout: r.payout_address, tokenid: r.tokenid, amount: r.out_amount, status: r.status, matureBlock: Number(r.mature_block) || 0,
    collectBlock: Number(r.collect_block) || 0, attempts: Number(r.attempts) || 0, atRisk: Number(r.at_risk) === 1 });
  const rowS = (r) => ({ coinid: r.coinid, address: r.address, tokenid: r.tokenid, amount: r.amount, status: r.status, note: r.note == null ? null : String(r.note),
    sweepBlock: Number(r.sweep_block) || 0, attempts: Number(r.attempts) || 0 });
  const marks = (n) => new Array(n).fill("?").join(",");

  return {
    file, kv,
    // ---- fc_collect (Store.java) ----
    collectExists: (id) => !!one("SELECT 1 AS x FROM fc_collect WHERE fc_coinid=?", [id]),
    insertCollect: (id, payout, tokenid, amount, mature, risk) => run("INSERT OR REPLACE INTO fc_collect (fc_coinid, payout_address, tokenid, out_amount, mature_block, at_risk, status, collect_block, attempts, updated) VALUES (?,?,?,?,?,?,?,0,0,?)",
      [id, payout, tokenid, amount, mature, risk ? 1 : 0, "DETECTED", now()]),
    refreshCollect: (id, mature, risk) => run("UPDATE fc_collect SET mature_block=?, at_risk=?, updated=? WHERE fc_coinid=?", [mature, risk ? 1 : 0, now(), id]),
    reArmAfterReorg: (id) => run("UPDATE fc_collect SET status=?, updated=? WHERE fc_coinid=? AND status IN (?,?,?)", ["DETECTED", now(), id, "COLLECTED", "COLLECTED_SAFE", "SWEEP_QUEUED"]),
    collects: (...st) => all("SELECT * FROM fc_collect WHERE status IN (" + marks(st.length) + ")", st).map(rowC),
    collect: (id) => { const r = one("SELECT * FROM fc_collect WHERE fc_coinid=?", [id]); return r ? rowC(r) : null; },
    claimForPost: (id, posted, tip) => run("UPDATE fc_collect SET status=?, collect_block=?, attempts=attempts+1, updated=? WHERE fc_coinid=? AND status=?", [posted, tip, now(), id, "DETECTED"]) > 0,
    setCollectStatus: (id, st) => run("UPDATE fc_collect SET status=?, updated=? WHERE fc_coinid=?", [st, now(), id]),
    deleteCollect: (id) => run("DELETE FROM fc_collect WHERE fc_coinid=?", [id]),
    // ---- fc_sweep ----
    insertSweep: (id, address, tokenid, amount) => run("INSERT OR IGNORE INTO fc_sweep (coinid, address, tokenid, amount, status, sweep_block, attempts, updated) VALUES (?,?,?,?,?,0,0,?)", [id, address, tokenid, amount, "PENDING", now()]),
    sweeps: (...st) => all("SELECT * FROM fc_sweep WHERE status IN (" + marks(st.length) + ")", st).map(rowS),
    claimSweepForPost: (id, tip) => run("UPDATE fc_sweep SET status=?, sweep_block=?, attempts=attempts+1, updated=? WHERE coinid=? AND status=?", ["SWEEP_POSTED", tip, now(), id, "PENDING"]) > 0,
    setSweepStatus: (id, st, note) => note == null ? run("UPDATE fc_sweep SET status=?, updated=? WHERE coinid=?", [st, now(), id]) : run("UPDATE fc_sweep SET status=?, note=?, updated=? WHERE coinid=?", [st, note, now(), id]),
    deleteSweep: (id) => run("DELETE FROM fc_sweep WHERE coinid=?", [id]),
    sweepNotes: () => all("SELECT note FROM fc_sweep WHERE note IS NOT NULL AND note<>''").map(r => String(r.note)),
    sweepIds: () => all("SELECT coinid FROM fc_sweep").map(r => String(r.coinid)),
    // ---- counts and totals for the dashboard (Store.readyTotals / pendingAtRisk: MINIMA only, as text sums are not made here) ----
    count: (table, st) => Number(one("SELECT COUNT(*) AS n FROM " + (table === "sweep" ? "fc_sweep" : "fc_collect") + " WHERE status=?", [st]).n) || 0,
    ready: (tip, risk) => all("SELECT out_amount FROM fc_collect WHERE status=? AND mature_block>0 AND mature_block<=? AND tokenid='0x00' AND at_risk=?", ["DETECTED", tip, risk ? 1 : 0]).map(r => String(r.out_amount)),
    pendingRisk: (tip) => all("SELECT out_amount, mature_block FROM fc_collect WHERE status=? AND at_risk=1 AND mature_block>? AND tokenid='0x00'", ["DETECTED", tip]).map(r => ({ amount: String(r.out_amount), mature: Number(r.mature_block) || 0 })),
    /** Store.resetHistory: completed records go, anything still in flight stays. */
    resetHistory: () => { run("DELETE FROM fc_sweep WHERE status IN (?,?)", ["SWEPT", "TAKEN"]); run("DELETE FROM fc_collect WHERE status IN (?,?,?)", ["DETECTED", "SWEEP_QUEUED", "COLLECTED_SAFE"]); },
    // ---- fc_retired ----
    addRetired: (address, mx, script, block) => run("INSERT OR REPLACE INTO fc_retired (address, mx, script, at, block) VALUES (?,?,?,?,?)", [address, mx || "", script || "", now(), block || 0]),
    retired: () => all("SELECT * FROM fc_retired ORDER BY at").map(r => ({ address: String(r.address), mx: String(r.mx || ""), script: String(r.script || ""), at: Number(r.at) || 0, block: Number(r.block) || 0 })),
    close: () => { try { db.close(); } catch (e) {} }
  };
}

module.exports = { open, SCHEMA };
