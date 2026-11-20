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

// ---- 0.18.153: what no line may carry ----
const { scrub } = require("../main/nodelog");
const SECRET = "Zk3_rpc-secret-0123456789abcdefXY";
ok("the RPC secret is taken out wherever it stands: line start, middle, end, twice", () => {
  assert.equal(scrub(SECRET + " is the password", SECRET), "••• is the password");
  assert.equal(scrub("Minima @ 1 : args -rpcpassword " + SECRET + " -daemon true", SECRET), "Minima @ 1 : args -rpcpassword ••• -daemon true");
  assert.equal(scrub(SECRET + SECRET + " x " + SECRET, SECRET), "•••••• x •••");
  assert.equal(scrub("https://user:" + SECRET + "@127.0.0.1:9005/status", SECRET), "https://user:•••@127.0.0.1:9005/status");
});
ok("a short or empty secret blanks nothing", () => {
  const line = "Minima @ 1 : Block 10 received, 7 coins";
  for (const s of ["", "1", "7 coins", null, undefined, 12345678]) assert.equal(scrub(line, s), line, String(s));
  assert.equal(scrub("abcdefgh", "abcdefgh"), "•••", "8 characters is the least that is looked for");
});
ok("a seed phrase is redacted quoted, as JSON, and as bare words, without eating the rest of the line", () => {
  assert.equal(scrub('megammrsync action:resync phrase:"ONE TWO THREE" host:x:9001'), 'megammrsync action:resync phrase:"•••" host:x:9001');
  assert.equal(scrub('{"command":"vault","response":{"phrase":"ONE TWO THREE","seed":"0x01"}}'), '{"command":"vault","response":{"phrase":"•••","seed":"0x01"}}');
  assert.equal(scrub("megammrsync action:resync phrase:ONE TWO THREE host:megammr.example:9001 keyuses:1000"), "megammrsync action:resync phrase:••• host:megammr.example:9001 keyuses:1000");
  const words = Array.from({ length: 30 }, (_, i) => "W" + "abcdefghijklmnopqrstuvwxyzABCD"[i]);
  assert.equal(scrub("phrase:" + words.join(" ")), "phrase:••• " + words.slice(24).join(" "), "24 words at most");
  assert.equal(scrub("an unrelated line: phrase: none given, 12 blocks"), "an unrelated line: phrase: none given, 12 blocks");
  assert.equal(scrub("sendfrom privatekey:0xABCDEF0123 amount:1"), "sendfrom privatekey:••• amount:1");
});
ok("bidirectional controls are stripped", () => {
  assert.equal(scrub("[parlons-node] message from 0xAB\u202E: \u2066gnp.exe\u2069\u200E\u200F\u202A\u202B\u202C\u202D\u2067\u2068 end"), "[parlons-node] message from 0xAB: gnp.exe end");
});
ok("node-manager log(): the Logs view and node.log never carry the secret, a bare seed or a bidi control, also across the 400-character cut", () => {
  const Module = require("module"), realLoad = Module._load, udir = path.join(dir, "nm");
  Module._load = function (r) { if (r === "electron") return { app: { getPath: () => udir, getVersion: () => "t", isPackaged: false, getAppPath: () => "." } }; return realLoad.apply(this, arguments); };
  let m; try { m = require("../main/node-manager"); } finally { Module._load = realLoad; }
  m.secret = SECRET;
  const last = (line) => { m.log(line); return m.logs[m.logs.length - 1]; };
  assert.equal(last("Minima @ 1 : -rpcpassword " + SECRET + " -daemon"), "Minima @ 1 : -rpcpassword ••• -daemon");
  for (const at of [380, 395, 399, 400]) { const shown = last("x".repeat(at) + SECRET + " tail"); assert.ok(!shown.includes(SECRET.slice(0, 4)) && !shown.includes(SECRET.slice(-4)), at + ": " + shown.slice(370)); }
  assert.equal(last("megammrsync phrase:ONE TWO THREE host:a.example:9001"), "megammrsync phrase:••• host:a.example:9001");
  assert.equal(last("a\u202Eb\u2066c\u200F"), "abc");
  const disk = fs.readFileSync(path.join(udir, "node.log"), "utf8");
  assert.ok(!disk.includes(SECRET) && !disk.includes("ONE TWO THREE") && !/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(disk), "the file on disk has the same lines");
  assert.ok(/this\.secret = config\.rpcSecret\(\);[^\n]*\n\s*this\.log\("\[app\] starting node: java "/.test(fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8")), "held from the moment the node is given it");
});

// ---- 0.18.160: whole lines only, so a secret split across two stdout chunks is still scrubbed ----
ok("node-manager nodeSaid(): a line split across chunks is logged once, whole and scrubbed; a last unended line is kept for the next chunk", () => {
  const m = require("../main/node-manager"); m.secret = SECRET; m.carry = { out: "", err: "" };
  const before = m.logs.length;
  m.nodeSaid("out", "Minima @ 2 : params -rpcpassword " + SECRET.slice(0, 10));
  assert.equal(m.logs.length, before, "nothing logged until the line ends");
  m.nodeSaid("out", SECRET.slice(10) + " -daemon\nnext li");
  assert.deepEqual(m.logs.slice(before), ["Minima @ 2 : params -rpcpassword ••• -daemon"]);
  m.nodeSaid("err", "stderr has its own " + SECRET.slice(0, 5)); m.nodeSaid("out", "ne\n"); m.nodeSaid("err", SECRET.slice(5) + "\n");
  assert.deepEqual(m.logs.slice(before + 1), ["next line", "stderr has its own •••"]);
  const disk = fs.readFileSync(path.join(dir, "nm", "node.log"), "utf8"); assert.ok(!disk.includes(SECRET.slice(0, 10)) && !disk.includes(SECRET.slice(10)), "no half on disk either");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8");
  assert.ok(/p\.stdout\.on\("data", d => this\.nodeSaid\("out", d\)\);/.test(src) && /p\.stderr\.on\("data", d => this\.nodeSaid\("err", d\)\);/.test(src), "both streams of the node go through it");
});

// ---- 0.18.167: the last unended line is logged when the streams close, not on exit ----
ok("node-manager: a last line with no line end is logged on the process's close event, scrubbed", () => {
  const m = require("../main/node-manager"); m.secret = SECRET; m.carry = { out: "", err: "" };
  const before = m.logs.length;
  m.nodeSaid("out", "last words -rpcpassword " + SECRET);
  assert.equal(m.logs.length, before);
  m.flushCarry(); assert.deepEqual(m.logs.slice(before), ["last words -rpcpassword •••"]); assert.deepEqual(m.carry, { out: "", err: "" });
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8");
  assert.ok(/p\.on\("close", \(\) => this\.flushCarry\(\)\);/.test(src), "flushed on close");
  const exitHandler = src.slice(src.indexOf('p.on("exit"'), src.indexOf("});", src.indexOf('p.on("exit"')));
  assert.ok(!/carry|flushCarry/.test(exitHandler), "not on exit");
});

console.log(fail === 0 ? "\n✅ NODE LOG PASS — " + pass + " checks" : "\n❌ NODE LOG FAIL — " + fail + " failed");
process.exit(fail ? 1 : 0);
