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

// ---- 0.19.121: what no line may carry ----
const { scrub, forFile } = require("../main/nodelog");
const SECRET = "Zk3_rpc-secret-0123456789abcdefXY";
ok("the RPC secret is taken out wherever it stands: line start, middle, end, twice", () => {
  assert.equal(scrub(SECRET + " is the password", SECRET), "••• is the password");
  assert.equal(scrub("Minima @ 1 : args -rpcpassword " + SECRET + " -daemon true", SECRET), "Minima @ 1 : args -rpcpassword ••• -daemon true");
  assert.equal(scrub("rpcpassword:" + SECRET, SECRET), "rpcpassword:•••");
  assert.equal(scrub(SECRET + SECRET + " x " + SECRET, SECRET), "•••••• x •••");
  assert.equal(scrub("https://user:" + SECRET + "@127.0.0.1:12005/status", SECRET), "https://user:•••@127.0.0.1:12005/status");
});
ok("a short or empty secret blanks nothing", () => {
  const line = "Minima @ 1 : Block 10 received, 7 coins";
  for (const s of ["", "1", "7 coins".slice(0, 7), null, undefined, 12345678]) assert.equal(scrub(line, s), line, String(s));
  assert.equal(scrub("abcdefgh", "abcdefgh"), "•••", "8 characters is the least that is looked for");
});
ok("a seed phrase is redacted quoted, as JSON, and as bare words, without eating the rest of the line", () => {
  assert.equal(scrub('megammrsync action:resync phrase:"ONE TWO THREE" host:x:9001'), 'megammrsync action:resync phrase:"•••" host:x:9001');
  assert.equal(scrub('{"command":"vault","response":{"phrase":"ONE TWO THREE","seed":"0x01"}}'), '{"command":"vault","response":{"phrase":"•••","seed":"•••"}}', "0.19.172: the vault's seed too");
  assert.equal(scrub('{"seed" : "0xABCDEF", "privatekey":"0x0123", "Seed":"x", "seeds":"kept", "block":"1"}'), '{"seed":"•••", "privatekey":"•••", "Seed":"•••", "seeds":"kept", "block":"1"}', "a JSON seed or private key, in any case and spacing");
  assert.equal(scrub('{"seedphrase":"ONE TWO","mnemonic" :"THREE FOUR","seedphrases":"kept"}'), '{"seedphrase":"•••","mnemonic":"•••","seedphrases":"kept"}', "0.19.175: the names the released desktop also redacts");
  assert.equal(scrub('{"phrase" : "ONE TWO"}'), '{"phrase":"•••"}');
  assert.equal(scrub('{"Phrase":"ONE TWO","PRIVATEKEY" : "0x01","PrivateKey":"0x02"}'), '{"Phrase":"•••","PRIVATEKEY":"•••","PrivateKey":"•••"}', "any letter case (0.19.197, as released 0.18.179)");
  assert.equal(scrub("megammrsync action:resync phrase:ONE TWO THREE host:megammr.example:9001 keyuses:1000"), "megammrsync action:resync phrase:••• host:megammr.example:9001 keyuses:1000");
  assert.equal(scrub("keys genkey phrase:alpha"), "keys genkey phrase:•••");
  const words = Array.from({ length: 30 }, (_, i) => "W" + "abcdefghijklmnopqrstuvwxyzABCD"[i]);
  assert.equal(scrub("phrase:" + words.join(" ")), "phrase:••• " + words.slice(24).join(" "), "24 words at most: what follows is not eaten");
  assert.equal(scrub("an unrelated line: phrase: none given, 12 blocks"), "an unrelated line: phrase: none given, 12 blocks");
  assert.equal(scrub("sendfrom privatekey:0xABCDEF0123 amount:1"), "sendfrom privatekey:••• amount:1");
  // 0.19.226: ":" spaced as the node reads it, and a reply's "seedrandom" field
  assert.equal(scrub('megammrsync phrase : "ONE TWO" host:x:9001'), 'megammrsync phrase:"•••" host:x:9001');
  assert.equal(scrub("keys action:genkey phrase : ONE TWO host:a.b:1"), "keys action:genkey phrase:••• host:a.b:1");
  assert.equal(scrub("sendfrom privatekey : 0xABCDEF amount:1"), "sendfrom privatekey:••• amount:1");
  assert.equal(scrub('sendfrom PrivateKey:"0xABCDEF" amount:1'), "sendfrom privatekey:••• amount:1");
  assert.equal(scrub('{"command":"seedrandom","response":{"seedrandom":"0x1234","modifier":"x"}}'), '{"command":"seedrandom","response":{"seedrandom":"•••","modifier":"x"}}');
});
ok("bidirectional controls are stripped", () => {
  const raw = "[parlons-node] message from 0xAB\u202E: \u2066gnp.exe\u2069\u200E\u200F\u202A\u202B\u202C\u202D\u2067\u2068 end";
  assert.equal(scrub(raw), "[parlons-node] message from 0xAB: gnp.exe end");
  assert.ok(!/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(scrub(raw)));
});
ok("a saved log passes the same scrub on every line", () => {
  const out = forFile(["a " + SECRET, 'x phrase:"ONE TWO"', "y phrase:ONE TWO", "z\u202Ez"].join("\n"), SECRET).split("\n");
  assert.deepEqual(out.slice(0, 4), ["a •••", 'x phrase:"•••"', "y phrase:•••", "zz"]);
  assert.ok(forFile("b " + SECRET).includes(SECRET), "no secret given: nothing to look for (main.js always gives it)");
});

console.log(fail === 0 ? "\n✅ NODE LOG PASS — " + pass + " checks" : "\n❌ NODE LOG FAIL — " + fail + " failed");
process.exit(fail ? 1 : 0);
