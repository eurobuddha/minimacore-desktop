/*
 * sqlshim.js — an `MDS.sql(query, cb)` backend over sql.js (SQLite compiled to WASM, pure JS — no native rebuild),
 * so the reused store.js + service.js SQL run VERBATIM. The ONLY runtime differences from the node's H2 engine live
 * here (not in the reused files):
 *   • H2 `id bigint auto_increment` → SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`.
 *   • H2 returns UPPERCASE column names; we uppercase the row keys so store.js's `row.INITM` etc. keep working.
 * Persistence: the whole DB is exported to a file on change (debounced atomic tmp+rename, mirroring mail-store.js).
 * Pool bookkeeping is tiny, so export-on-write is cheap.
 */
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

let sqlReady = null;

async function makeSqlShim(filePath) {
  if (!sqlReady) {
    const wasmPath = path.join(__dirname, "..", "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);          // load the wasm ourselves → no locateFile path games inside the asar
    sqlReady = initSqlJs({ wasmBinary });
  }
  const SQL = await sqlReady;
  let db;
  try { db = new SQL.Database(new Uint8Array(fs.readFileSync(filePath))); }
  catch (e) { db = new SQL.Database(); }                    // ENOENT → fresh DB

  let writeTimer = null;
  function persistSoon() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        const dir = path.dirname(filePath); fs.mkdirSync(dir, { recursive: true });
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, Buffer.from(db.export()));
        fs.renameSync(tmp, filePath);
      } catch (e) { /* retried on the next write */ }
    }, 400);
  }

  // Minimal H2→SQLite dialect fixes. varchar/text/int/bigint/double all have valid SQLite type affinity,
  // backticks are accepted, IF NOT EXISTS / ALTER / LIMIT / OFFSET are identical. Beyond the original
  // auto-increment rewrite, the AtomiX engine (main/atomix — same donor-reuse pattern) needs two more,
  // both additive and inert for SQL that doesn't use the construct:
  //   • H2 `MERGE INTO t (cols) KEY(`k`) VALUES (…)` upsert → SQLite `INSERT OR REPLACE INTO t (cols) VALUES (…)`
  //     (every donor MERGE keys on the table's PRIMARY KEY, so REPLACE-on-PK is semantically identical).
  //   • the donor writes `id bigint auto_increment PRIMARY KEY` — after the auto-increment rewrite that would
  //     leave a duplicate "PRIMARY KEY"; collapse it.
  function translate(q) {
    q = q.replace(/`?\bid`?\s+bigint\s+auto_increment/gi, "`id` INTEGER PRIMARY KEY AUTOINCREMENT")
         .replace(/INTEGER PRIMARY KEY AUTOINCREMENT\s+PRIMARY KEY/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
    if (/^\s*MERGE\s+INTO/i.test(q)) {
      q = q.replace(/^\s*MERGE\s+INTO/i, "INSERT OR REPLACE INTO").replace(/\s+KEY\s*\([^)]*\)\s*/i, " ");
    }
    return q;
  }

  function sqlCmd(query, cb) {
    let res;
    try {
      const q = translate(String(query));
      if (/^\s*select/i.test(q)) {
        const stmt = db.prepare(q);
        const rows = [];
        while (stmt.step()) {
          const o = stmt.getAsObject(), up = {};
          for (const k in o) up[k.toUpperCase()] = o[k];    // emulate H2's uppercase column names
          rows.push(up);
        }
        stmt.free();
        res = { status: true, rows: rows };
      } else {
        db.run(q);
        res = { status: true };
        persistSoon();
      }
    } catch (e) {
      // A probe like `SELECT 1 FROM pp_activity` on a missing table SHOULD come back !status (store.js then CREATEs).
      res = { status: false, error: String((e && e.message) || e) };
    }
    if (cb) cb(res);
    return res;
  }

  // `persist` exposes the debounced whole-image save for callers that write via `_db` directly (e.g. history-db.js
  // uses prepared statements + bound params on `_db` for speed/safety, then schedules a save with this). Additive —
  // the reused pandapools code keeps using `sql`/`flush` exactly as before.
  return { sql: sqlCmd, persist: persistSoon, flush: () => { if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } try { fs.writeFileSync(filePath, Buffer.from(db.export())); } catch (e) {} }, _db: db };
}

module.exports = { makeSqlShim };
