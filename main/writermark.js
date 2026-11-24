"use strict";
/**
 * writermark.js — which version of this app last started a node on a data folder (<data>/minimacore-writer.txt), so an OLDER
 * copy refuses to run on what a newer one wrote (0.19.423). Every build since 0.19.105 uses the same data folder; on
 * 23 Nov 2026 a stray 0.19.105 was opened on the folder 0.19.416 had written: it knows nothing of the import marker, the
 * frozen apps or the stop guard. The mark is only ever raised. A folder with no mark (written before 0.19.423) is accepted.
 * ponytail: builds older than 0.19.423 do not read the mark, so this protects only from 0.19.423 on.
 */
const fs = require("fs");
const path = require("path");
const FILE = "minimacore-writer.txt";
const VER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** -1, 0, 1 for two dotted versions */
function cmp(a, b) { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; } return 0; }
/** the version recorded in the folder, or "" (no mark, or not readable as one) */
function read(dir) { try { const m = /^app (\S+)$/m.exec(fs.readFileSync(path.join(dir, FILE), "utf8")); return m && VER.test(m[1]) ? m[1] : ""; } catch (e) { return ""; } }
/** why this copy must not start a node on the folder ("" = it may). name: the app's name; exe: this running copy's own path. */
function problem(dir, mine, name, exe) {
  const was = read(dir);
  if (!was || !VER.test(String(mine)) || cmp(was, mine) <= 0) return "";
  return "This data folder was last used by " + name + " " + was + ". This copy is " + mine + ", which is older and can damage what the newer one wrote. "
    + "The node was not started and nothing was changed. Open " + name + " " + was + " or newer." + (exe ? " This copy is at " + exe : "");
}
/** record this version, unless the folder already carries this one or a newer one. Throws when it cannot be written. */
function mark(dir, mine) {
  if (!VER.test(String(mine))) return;
  const was = read(dir);
  if (was && cmp(was, mine) >= 0) return;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, FILE);
  fs.writeFileSync(f + ".tmp", "app " + mine + "\n"); fs.renameSync(f + ".tmp", f);
}
module.exports = { FILE, cmp, read, problem, mark };
