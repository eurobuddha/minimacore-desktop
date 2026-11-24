"use strict";
/**
 * writermark.js — which version of this app last started a node on a data folder (<data>/minimacore-writer.txt), so an OLDER
 * copy refuses to run on what a newer one wrote (0.19.423). Every build since 0.19.105 uses the same data folder; on
 * 23 Nov 2026 a stray 0.19.105 was opened on the folder 0.19.416 had written: it knows nothing of the import marker, the
 * frozen apps or the stop guard. The mark is only ever raised. A folder with no mark (written before 0.19.423) is accepted.
 * ponytail: builds older than 0.19.423 do not read the mark, so this protects only from 0.19.423 on.
 *
 * The file (0.19.438). One line an app:
 *   app <version> <app id>     the newest version of THAT app (its bundle id, main/flavor.js appId) that started a node here
 *   app <version>              the line builds 0.19.423 to 0.19.437 wrote and read (no app id): still written, raised only, so
 *                              those older copies go on refusing; read here only when the file names no app at all (an old mark)
 * Versions are compared only within one app: two apps of this family pointed at one custom data folder have unrelated version
 * numbers (0.18.x and 0.19.x), and the one with the lower number was refused for good. A mark an old build left names no app, so it
 * is still compared with everyone: the way back below is for that, and for a deliberate return to an older version.
 *
 * THE WAY BACK: quit the app and delete <data folder>/minimacore-writer.txt. Nothing else reads it, and the next start writes it again.
 */
const fs = require("fs");
const path = require("path");
const FILE = "minimacore-writer.txt";
const VER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const ID = /^[A-Za-z0-9._-]{1,120}$/;

/** -1, 0, 1 for two dotted versions */
function cmp(a, b) { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; } return 0; }
/** what the file holds: { legacy: the line with no app id ("" when none), byId: { <app id>: version } }. Lines not readable as a mark are skipped. */
function marks(dir) {
  const out = { legacy: "", byId: {} };
  let text = ""; try { text = fs.readFileSync(path.join(dir, FILE), "utf8"); } catch (e) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^app (\S+)(?: (\S+))?$/.exec(line);
    if (!m || !VER.test(m[1])) continue;
    if (m[2] === undefined) { if (!out.legacy || cmp(out.legacy, m[1]) < 0) out.legacy = m[1]; }
    else if (ID.test(m[2]) && (!out.byId[m[2]] || cmp(out.byId[m[2]], m[1]) < 0)) out.byId[m[2]] = m[1];
  }
  return out;
}
/** the version this app (id) is compared with: its own line; or, in a file that names no app at all, the old line. "" = no mark for it.
 *  Without an id (as before 0.19.438): the old line. */
function read(dir, id) {
  const m = marks(dir);
  if (!id) return m.legacy;
  return m.byId[id] || (Object.keys(m.byId).length ? "" : m.legacy);
}
/** why this copy must not start a node on the folder ("" = it may). name: the app's name; exe: this running copy's own path; id: the app's id. */
function problem(dir, mine, name, exe, id) {
  const was = read(dir, id);
  if (!was || !VER.test(String(mine)) || cmp(was, mine) <= 0) return "";
  return "This data folder was last used by " + name + " " + was + ". This copy is " + mine + ", which is older and can damage what the newer one wrote. "
    + "The node was not started and nothing was changed. Open " + name + " " + was + " or newer. To go back to this older version on purpose, quit the app, delete the file "
    + path.join(dir, FILE) + " and open this copy again." + (exe ? " This copy is at " + exe : "");
}
/** record this version for this app (id), and on the old line, unless each already carries this one or a newer one. Throws when it cannot be written. */
function mark(dir, mine, id) {
  if (!VER.test(String(mine))) return;
  const m = marks(dir); let changed = false;
  if (id && ID.test(id) && (!m.byId[id] || cmp(m.byId[id], mine) < 0)) { m.byId[id] = mine; changed = true; }
  if (!m.legacy || cmp(m.legacy, mine) < 0) { m.legacy = mine; changed = true; }
  if (!changed) return;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, FILE);
  fs.writeFileSync(f + ".tmp", "app " + m.legacy + "\n" + Object.keys(m.byId).sort().map((k) => "app " + m.byId[k] + " " + k + "\n").join("")); fs.renameSync(f + ".tmp", f);
}
module.exports = { FILE, cmp, read, marks, problem, mark };
