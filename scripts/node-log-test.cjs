/*
 * node-log-test.cjs — main/nodelog.js writes every line to disk and rotates at the byte cap.
 * Run: node scripts/node-log-test.cjs
 */
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createNodeLog } = require("../main/nodelog");

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.error("  ✗", name, "—", e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodelog-"));

ok("creates the directory and appends timestamped lines", () => {
  const log = createNodeLog(path.join(dir, "a"), { maxBytes: 100000 });
  log.append("Minima @ 12:00 : Script NOT found for address : 0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A\n");
  log.append("second");
  const text = fs.readFileSync(log.file, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z Minima @ 12:00 : Script NOT found for address : 0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A$/.test(lines[0]), "full line, full address, one timestamp: " + lines[0]);
  assert.ok(/ second$/.test(lines[1]));
});

ok("rotates to node.log.1 at the cap and keeps writing", () => {
  const log = createNodeLog(path.join(dir, "b"), { maxBytes: 300 });
  for (let i = 0; i < 20; i++) log.append("line " + i + " " + "x".repeat(40));   // ~70 bytes each → several rotations
  assert.ok(fs.existsSync(log.file) && fs.existsSync(log.older), "both files exist after rotation");
  assert.ok(fs.statSync(log.file).size <= 300 && fs.statSync(log.older).size <= 300, "neither file exceeds the cap");
  const last = fs.readFileSync(log.file, "utf8").trim().split("\n").pop();
  assert.ok(/ line 19 /.test(last), "the newest line is in the live file: " + last);
});

ok("a second instance on the same directory continues the existing file", () => {
  const d = path.join(dir, "c");
  createNodeLog(d, { maxBytes: 100000 }).append("one");
  createNodeLog(d, { maxBytes: 100000 }).append("two");
  assert.equal(fs.readFileSync(path.join(d, "node.log"), "utf8").trim().split("\n").length, 2);
});

ok("an unwritable directory never throws", () => {
  const log = createNodeLog(path.join(dir, "a", "node.log", "not-a-dir"), { maxBytes: 100 });   // parent is a FILE
  log.append("dropped");   // must not throw
});

console.log(fail === 0 ? "\n✅ NODE LOG PASS — " + pass + " checks" : "\n❌ NODE LOG FAIL — " + fail + " failed");
process.exit(fail ? 1 : 0);
