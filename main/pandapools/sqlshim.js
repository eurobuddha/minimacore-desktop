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

/** An empty database file found on disk is kept aside under <file>-empty-YYYYMMDD (-2, -3 …) → the new path, or "" when it could not be. */
function keepEmpty(filePath, now) {
  const d = now || new Date(), ymd = "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  let to = filePath + "-empty-" + ymd;
  for (let n = 2; fs.existsSync(to); n++) to = filePath + "-empty-" + ymd + "-" + n;
  try { fs.renameSync(filePath, to); return to; } catch (e) { return ""; }
}

/** log(line): where an empty file found on disk is said (0.18.233); console when the caller passes none. */
async function makeSqlShim(filePath, log) {
  if (!sqlReady) {
    const wasmPath = path.join(__dirname, "..", "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);          // load the wasm ourselves → no locateFile path games inside the asar
    sqlReady = initSqlJs({ wasmBinary });
  }
  const SQL = await sqlReady;
  let db;
  try { const bytes = fs.readFileSync(filePath);
    // A file of 0 bytes is a database with no tables (0.18.212: SQLite itself treats it so, and sql.js exports a
    // table-less database as 0 bytes, which older versions wrote when the engine stopped before creating any table), so it
    // opens fresh. A file with content that is not SQLite (no 16-byte header) or fails the check is refused and kept
    // (0.18.210): opening it fresh would read the swap and pool records as none and the next save would overwrite them.
    if (bytes.length && bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") throw Object.assign(new Error("The database " + filePath + " is damaged (not an SQLite file). Nothing was changed; keep that file and ask for help rather than deleting it."), { code: "EBADDB" });
    // A 0-byte file on disk (0.18.233, as Pandamonium Desktop 0.19.274): this version never writes one (flushChecked writes nothing
    // for a database with no tables; versions before 0.18.212 did), so it may be a store something else emptied: it is said, with
    // the file whole, and kept under a dated name before a new database starts in its place. It is still never refused.
    if (!bytes.length) {
      const kept = keepEmpty(filePath), say = typeof log === "function" ? log : (l) => console.warn("[store] " + l);
      try { say("the database " + filePath + " was an empty file (0 bytes): " + (kept ? "it is kept as " + kept + " and " : "it could not be moved aside, and ") + "a new database is started in its place"); } catch (e) {}
    }
    db = new SQL.Database(bytes.length ? new Uint8Array(bytes) : undefined);
    const check=db.exec("PRAGMA quick_check");
    if(!check.length||check[0].values.some(row=>row[0]!=="ok"))throw new Error("Pool database integrity check failed.");
  }
  catch (e) { if(e.code!=="ENOENT")throw e; db = new SQL.Database(); }                    // ENOENT → fresh DB

  let writeTimer = null;
  function persistSoon() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushChecked();   // written, synced to disk, then renamed (0.18.210: no sync, so a power cut could leave an empty file); retried on the next write
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

  // Checked counterpart of the existing atomic whole-image save, used for recovery guards.
  let disposed = false;   // set when the owner has let this database go (a wallet replacement): it never writes again
  function flushChecked() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (disposed) return false;
    let fd;
    try {
      const image = db.export();
      if (!image.length) return true;   // no tables yet: nothing to keep, and a 0-byte file is never written (0.18.212)
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + ".tmp";
      fd = fs.openSync(tmp, "w", 0o600);
      fs.writeFileSync(fd, Buffer.from(image)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, filePath);
      try { const dfd = fs.openSync(path.dirname(filePath), "r"); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch (e) { /* the rename is still atomic */ }
      return true;
    } catch (e) { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} return false; }
  }
  /** Let this database go without writing: a pending save is cancelled and later saves do nothing (0.18.212). */
  function dispose() { disposed = true; if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } }
  return { sql: sqlCmd, persist: persistSoon, _db: db, flush: flushChecked, flushChecked, dispose };
}

module.exports = { makeSqlShim, keepEmpty };
