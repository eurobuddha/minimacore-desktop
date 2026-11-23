// A file the node is told to read (0.19.386; MegaMMR turned on by the import, and off again, 0.19.387): a backup for Restore from file, a MegaMMR file for Resync from a MegaMMR file.
// The path comes only from the system's open dialog (main/importfile.js), is checked, kept in main and given to the node in quotes.
// What reaches the node is read here the way the bundled node reads it (core/minima-core, block line 1.1.2.31-euro14,
// CommandRunner.java runMultiCommand / getCommand / splitStringJSON / splitterQuotedPattern / getParamValue): a stand-in node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const ROOT = path.join(__dirname, "..");
const F = require("../main/importfile.js"), restore = require("../main/restore.js"), rpc = require("../main/rpc.js"), nodelog = require("../main/nodelog.js");

// ---- the node's own reading of a command text, ported line for line (CommandRunner.java :314, :496-560, :581-735) ----
function splitFast(input) {   // splitterQuotedPattern
  const ss = input.trim().replace(/:/g, " : "), tok = [];
  for (const m of ss.matchAll(/"([^"]*)"|(\S+)/g)) tok.push(m[1] != null ? m[1] : m[2]);
  const out = []; let first = true, named = false, nv = "";
  for (const t of tok) {
    if (first) { first = false; out.push(t); continue; }
    if (!named) { if (t.trim() === ":") return null; named = true; nv = t; }
    else if (t.trim() === ":") nv += ":"; else { named = false; nv += t; out.push(nv); }
  }
  return out;
}
function splitSlow(input) {   // the character loop
  const out = []; let cur = "", json = 0, quoted = false;
  for (const c of input.trim()) {
    if (c === " ") { if (!quoted && json === 0) { if (cur !== "") out.push(cur.trim()); cur = ""; } else cur += c; }
    else if (c === "{" || c === "[") { json++; cur += c; } else if (c === "}" || c === "]") { json--; cur += c; }
    else if (c === '"') { if (json > 0) cur += c; else quoted = !quoted; }
    else cur += c;
  }
  if (cur !== "") out.push(cur.trim());
  return out;
}
/** [{ verb, params }] the node would run for this text, in order (a ";" ends a command wherever it stands). */
function nodeRead(text) {
  return text.split(";").map(s => s.trim()).filter(Boolean).map(cmd => {
    const fast = cmd.indexOf(":\\") === -1 && !/[{[]/.test(cmd) ? splitFast(cmd) : null, split = fast || splitSlow(cmd), params = {};
    for (const t of split.slice(1)) {
      const i = t.indexOf(":"); if (i === -1) return { verb: split[0].toLowerCase(), invalid: t };
      let v = t.slice(i + 1).trim(); if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1);
      params[t.slice(0, i).trim()] = v;
    }
    return { verb: split[0].toLowerCase(), params };
  });
}
/** A stand-in node on loopback that reads a request as the Parlons admin RPC does (URLDecoder: "+" is a space) and answers as the
 *  node does: every parameter echoed (Command.getJSONReply); a refused megammrsync file: carries the inner restore's whole reply. */
function standIn(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const text = decodeURIComponent(req.url.slice(1).replace(/\+/g, " ")).trim(); seen.push(text);
    const read = nodeRead(text)[0], body = Object.assign({ command: read.verb, params: read.params, pending: false }, answer(read));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, seen, close: () => new Promise(c => server.close(c)) })));
}

let DIR;
test.before(() => { DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-import-"))); });
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const file = (name, size = 4096) => { const p = path.join(DIR, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size, 7)); return p; };
const refusal = (fn) => { try { fn(); } catch (e) { return e.message; } assert.fail("expected a refusal"); };
const picker = (filePaths) => F.create({ fs, platform: "darwin", showOpen: async (o) => { picker.last = o; return filePaths ? { canceled: false, filePaths } : { canceled: true, filePaths: [] }; } });

test("hostile file names: a ; \" : { } [ ] backslash or control character is refused before anything is sent; spaces are fine", () => {
  for (const name of ["x;quit;y.bak", "x; vault action:wipekeys.bak", 'x" password:abc.bak', "x:y.bak", "{x}.bak", "[x].bak", "a\\b.bak", "line\nbreak.bak", "tab\there.bak", "bidi\u202e.bak"]) {
    const p = file("hostile/" + name);
    assert.equal(refusal(() => F.check("backup", p, fs, "darwin")), F.BAD_PATH, JSON.stringify(name));
    assert.equal(F.pathProblem(p, "darwin"), F.BAD_PATH);
    assert.throws(() => F.megammrImportCommand(p.replace(/\.bak$/, ".mmr"), "darwin"), { message: F.BAD_PATH });
    assert.equal(restore.restoreFileCommand({ host: "h.example:9001", file: p, password: "pw1", picked: true }).error, F.BAD_PATH, "no command is built for " + JSON.stringify(name));
  }
  // why: had it been sent, the node would run a second command it was never asked for (and the admin RPC returns the first reply only)
  assert.deepEqual(nodeRead('megammrsync action:resync host:h.example:9001 file:"/t/x;quit;y.bak"').map(c => c.verb), ["megammrsync", "quit", 'y.bak"']);
  assert.deepEqual(nodeRead('megammr action:import file:"/t/x" password:abc.mmr"').length, 1, "a quote ends the quoted path early");
  assert.equal(nodeRead('megammr action:import file:"/t/x" password:abc.mmr"')[0].params.file, "/t/x", "and the rest becomes another parameter");
  // a Windows path keeps its drive's ":" and its backslashes (the node's slower splitter), and nothing else
  assert.equal(F.pathProblem("C:\\Users\\Ann Lee\\Backups\\b.bak", "win32"), "");
  assert.deepEqual(nodeRead('megammrsync action:resync host:h.example:9001 file:"C:\\Users\\Ann Lee\\Backups\\b.bak" password:pw1')[0].params,
    { action: "resync", host: "h.example:9001", file: "C:\\Users\\Ann Lee\\Backups\\b.bak", password: "pw1" });
  for (const p of ["C:\\a:b.bak", "relative\\b.bak", "\\\\server\\share\\b.bak"]) assert.equal(F.pathProblem(p, "win32"), F.BAD_PATH, p);
  assert.equal(F.pathProblem("relative/b.bak", "darwin"), F.BAD_PATH, "only an absolute path");
});

test("the picker: cancelled keeps nothing; a folder, a link, a device, a wrong extension or an implausible size is refused in plain words", async () => {
  const p = picker(null);
  assert.equal(await p.pick("backup"), null, "cancelled");
  assert.equal(refusal(() => p.confirm("backup", "")), F.CHOOSE_FIRST);
  assert.deepEqual(picker.last.properties, ["openFile"]); assert.deepEqual(picker.last.filters[0].extensions, ["bak"]);
  const good = file("good.bak");
  fs.symlinkSync(good, path.join(DIR, "link.bak")); fs.mkdirSync(path.join(DIR, "folder.bak"));
  for (const [kind, f, why] of [
    ["backup", path.join(DIR, "link.bak"), F.NOT_PLAIN], ["backup", path.join(DIR, "folder.bak"), F.NOT_PLAIN], ["backup", "/dev/null", F.NOT_PLAIN],
    ["backup", file("notes.txt"), F.KINDS.backup.ext], ["backup", file("tiny.bak", 10), "This file is too small to be a node backup (10 bytes). Nothing was sent."],
    ["megammr", good, F.KINDS.megammr.ext], ["megammr", file("tiny.mmr", 100), "This file is too small to be a MegaMMR file (100 bytes). Nothing was sent."],
    ["backup", path.join(DIR, "gone.bak"), "The file could not be read (ENOENT). Nothing was sent."]]) {
    const q = picker([f]);
    await assert.rejects(q.pick(kind), { message: why }, f);
    assert.equal(refusal(() => q.confirm(kind, f)), F.CHOOSE_FIRST, "a refused file is not kept");
  }
  const big = path.join(DIR, "huge.bak"); fs.closeSync(fs.openSync(big, "w")); fs.truncateSync(big, 1024 * 1024 * 1024 + 1);   // sparse
  await assert.rejects(picker([big]).pick("backup"), { message: F.KINDS.backup.large });
  // a link in a FOLDER on the way is resolved: the node is given the real path, and that is what is shown and kept
  fs.symlinkSync(DIR, path.join(DIR, "via"));
  const r = picker([path.join(DIR, "via", "good.bak")]); assert.deepEqual(await r.pick("backup"), { path: good, size: 4096 });
  assert.equal(r.confirm("backup", good), good);
  const m = file("Mega Files/mega.mmr", 5000), q = picker([m]);
  assert.deepEqual(await q.pick("megammr"), { path: m, size: 5000 }); assert.deepEqual(picker.last.filters[0].extensions, ["mmr", "megammr"]);
});

test("confirm: only the path main chose, shown back unchanged, and still a plain file", async () => {
  const a = file("a.bak"), b = file("b.bak"), p = picker([a]);
  await p.pick("backup");
  assert.equal(refusal(() => p.confirm("backup", b)), F.CHOOSE_FIRST, "a path the window invented is not taken");
  assert.equal(refusal(() => p.confirm("megammr", a)), F.CHOOSE_FIRST, "nor one chosen for the other kind");
  assert.equal(p.confirm("backup", a), a);
  fs.rmSync(a); fs.symlinkSync(b, a);
  assert.equal(refusal(() => p.confirm("backup", a)), F.NOT_PLAIN, "swapped for a link after it was chosen");
});

test("Restore from file: the command the node gets, read as the node reads it, runs one restore of exactly the chosen file; the password never comes back", async () => {
  const pw = "Secret9pw", chosen = file("My Backups/minima backup 2026.bak"), p = picker([chosen]);
  await p.pick("backup");
  const node = await standIn((r) => r.params.password === pw ? { status: true, response: { message: "MegaMMR sync fininshed.. please restart" } }
    : { status: false, error: "Error restoring.. " + JSON.stringify({ command: "restore", params: { shutdown: "false", file: r.params.file, password: r.params.password }, status: false, error: "Incorrect Password!" }) });
  const ran = [];
  const d = (o) => Object.assign({ keyMode: "block", supported: true, running: true, work: async () => [], picked: (s) => p.confirm("backup", s),
    run: async (c) => { ran.push(c); return rpc.rpcCall(node.port, "rpc-secret-for-the-stand-in", c); } }, o);
  try {
    await assert.rejects(restore.restoreBackup({ host: "h.example:9001", file: path.join(DIR, "other.bak"), password: pw, mode: "block" }, d()), { message: F.CHOOSE_FIRST });
    assert.deepEqual(ran, [], "nothing sent for a path main did not choose");
    assert.deepEqual(await restore.restoreBackup({ host: "h.example:9001", file: chosen, password: pw, mode: "block", check: true }, d()), { ok: true });
    assert.deepEqual(ran, [], "the check sends nothing");
    const ok = await restore.restoreBackup({ host: "h.example:9001", file: chosen, password: pw, mode: "block" }, d());
    assert.deepEqual(ok, { status: true });
    assert.equal(node.seen[0], `megammrsync action:resync host:h.example:9001 file:"${chosen}" password:${pw}`, "the text the node received");
    assert.deepEqual(nodeRead(node.seen[0]), [{ verb: "megammrsync", params: { action: "resync", host: "h.example:9001", file: chosen, password: pw } }]);
    assert.ok(restore.loadsBackupFile(ran[0]) && restore.isResync(ran[0]) && restore.stopsNode(ran[0]), "read by main as a wallet-replacing resync: the engines are held for it");
    const bad = await restore.restoreBackup({ host: "h.example:9001", file: chosen, password: "Wrong1", mode: "block" }, d());
    assert.deepEqual(bad, { status: false, error: "Error restoring.. Incorrect Password!" }, "the node's own reason, without its echo of the password");
    for (const reply of [ok, bad]) assert.ok(!JSON.stringify(reply).includes(pw) && !JSON.stringify(reply).includes("Wrong1"));
    // a refusal whose words name the password anyway is said without them
    assert.deepEqual(restore.withoutPassword({ status: false, error: "password " + pw + " refused" }, pw), { status: false, error: "The node refused the restore." });
    assert.equal(rpc._timeoutFor(ran[0]), 60 * 60 * 1000);
  } finally { await node.close(); }
});

test("the password never reaches a log line: the node log redacts it as typed and as a reply's JSON echoes it", () => {
  const pw = "Secret9pw";
  for (const line of [`megammrsync action:resync host:h:1 file:"/a b/c.bak" password:${pw}`, `{"command":"restore","params":{"file":"/a.bak","password":"${pw}"},"status":false}`,
    `Error restoring.. {"command":"restore","params":{"shutdown":"false","password" : "${pw}"}}`]) assert.ok(!nodelog.scrub(line, "x").includes(pw), line);
  const src = fs.readFileSync(path.join(ROOT, "main", "importfile.js"), "utf8") + fs.readFileSync(path.join(ROOT, "main", "restore.js"), "utf8");
  assert.ok(!/\blog\(|console\./.test(src), "neither module logs");
});

/** A file whose start is a MegaMMR export's (the bytes of a real one from a private chain: versions 1 and 1, block time 78, entry 36, 60 entries). */
const MEGA_HEAD = Buffer.from("0001010001010001 4e0001000000000124 00013c".replace(/\s/g, ""), "hex");
const megaFile = (name, size = 8192) => { const p = file(name, size); const b = Buffer.alloc(size, 7); MEGA_HEAD.copy(b); fs.writeFileSync(p, b); return p; };

test("a MegaMMR file is read by its first bytes before the node is touched; invisible characters and the node's own databases folder are refused", async () => {
  assert.deepEqual(F.megammrHeader(megaFile("head/ok.mmr"), fs), { tip: "78" });
  const html = file("head/page.mmr"); fs.writeFileSync(html, Buffer.concat([Buffer.from("<html><body>404</body></html>"), Buffer.alloc(4000, 32)]));
  for (const p of [html, file("head/zeros.mmr"), (() => { const q = file("head/v2.mmr"); const b = Buffer.alloc(4096, 7); Buffer.from("000102000101", "hex").copy(b); fs.writeFileSync(q, b); return q; })()])
    assert.equal(refusal(() => F.megammrHeader(p, fs)), F.NOT_MEGAMMR, p);
  for (const ch of ["​", "‍", "‎", "؜", "⁠", "﻿"]) assert.equal(F.pathProblem("/Users/a/Down" + ch + "loads/m.mmr", "darwin"), F.BAD_PATH, JSON.stringify(ch));
  const data = path.join(DIR, "nodedata"), own = megaFile("nodedata/1.1/databases/megammr.mmr"), beside = megaFile("nodedata/exports/m.mmr");
  const q = F.create({ fs, platform: "darwin", dataDir: () => data, showOpen: async () => ({ canceled: false, filePaths: [own] }) });
  await assert.rejects(q.pick("megammr"), { message: F.IN_DATABASES });
  const r = F.create({ fs, platform: "darwin", dataDir: () => data, showOpen: async () => ({ canceled: false, filePaths: [beside] }) });
  assert.equal((await r.pick("megammr")).path, beside, "elsewhere in the data folder is fine");
  r.forget("megammr"); assert.equal(refusal(() => r.confirm("megammr", beside)), F.CHOOSE_FIRST, "forget: chosen again next time");
});

/** One world for main/megammrfile.js: a stand-in node whose answers are given in turn. */
flowWorld.n = 0;
async function flowWorld(o) {
  const MF = require("../main/megammrfile.js"), did = [], answers = (o.megammr || [false, true]).slice(), G = 1024 * 1024 * 1024;
  const mega = o.file || megaFile("flow/" + (++flowWorld.n) + "/mega 19 Nov.mmr");
  const params = Object.assign({ isclient: true }, "was" in o ? { megammr: o.was } : { megammr: answers[0] });
  const node = { state: o.state || "running", resyncing: !!o.resyncing, megammrBroken: false, heapMbNow: o.heapMbNow == null ? 3072 : o.heapMbNow, kind: () => o.kind || "parlons", dataDir: () => DIR,
    restart: async () => { did.push("restart with megammr:" + params.megammr); node.state = o.downAfter && did.filter(x => x.startsWith("restart")).length === o.downAfter ? "error" : "running"; }, snapshot: () => ({ state: node.state }) };
  const imports = picker([mega]);
  const d = { node, imports, fs: Object.assign({}, fs, { statfsSync: () => ({ bavail: 100 * G, bsize: 1 }) }), totalmem: () => o.ram || 16 * G, platform: "darwin", log: () => {}, sleep: async () => {}, upMs: 5,
    config: { load: () => ({ heapMb: o.heapMb || 0, params: Object.assign({}, params) }), save: (p) => { did.push("save " + JSON.stringify(p.params)); Object.assign(params, p.params); } },
    status: async () => { const m = answers.length > 1 ? answers.shift() : answers[0]; did.push("status " + m); if (m === null) throw new Error("ECONNREFUSED"); return { status: true, response: { megammr: m } }; },
    call: async (c) => { did.push(c.replace(mega, "F")); return o.check ? o.check(c) : { status: true, response: {} }; },
    mayStop: async () => { did.push("guard"); if (o.refuse) throw new Error("The node keeps running: nothing was stopped."); }, held: (op) => op(),
    runResync: async (c) => { did.push(c.replace(mega, "F")); if (o.swap) o.swap(mega); return o.import ? o.import(c) : { status: true }; },
    work: async () => o.work || [], holdEngines: async () => { did.push("hold"); }, releaseEngines: async () => { did.push("release"); } };
  const mf = MF.create(d);
  await imports.pick("megammr");
  let r; try { r = await (o.off ? mf.megammrOff() : mf.importMegammr(mega)); } catch (e) { r = e.message; }
  return { did, r, params, mf, MF };
}

test("Resync from a MegaMMR file: engines held for the whole import; only {megammr:true} saved, always, before any restart; the node's own reader checks the whole file before anything is reset", async () => {
  let w = await flowWorld({});
  assert.deepEqual(w.did, ["status false", "guard", "hold", 'save {"megammr":true}', "restart with megammr:true", "status true", "guard",
    'megammr action:integrity file:"F"', 'megammr action:import file:"F"', "release"]);
  assert.deepEqual(w.r, { status: true, broken: false, on: true }); assert.equal(w.params.megammr, true);
  // already a MegaMMR node: no switch, but the setting is still saved before the import (its restart must keep the MegaMMR)
  w = await flowWorld({ megammr: [true], was: false });
  assert.deepEqual(w.did, ["status true", "guard", "hold", 'save {"megammr":true}', 'megammr action:integrity file:"F"', 'megammr action:import file:"F"', "release"]);
  // ...whose memory setting was changed since it started: restarted first, so the room counted is the room it has
  w = await flowWorld({ megammr: [true, true], heapMb: 8192, heapMbNow: 3072 });
  assert.deepEqual(w.did.slice(0, 6), ["status true", "guard", "hold", 'save {"megammr":true}', "restart with megammr:true", "status true"]);
});

test("Resync from a MegaMMR file: every failure ends with the node restarted and the setting as it was; an unknown status is never read as off", async () => {
  // the node refuses the file (truncated, or its blocks do not follow its MegaMMR): nothing reset; a node this flow turned on goes back
  let w = await flowWorld({ check: () => ({ status: false, error: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }) });
  assert.deepEqual(w.did.slice(-4), ['megammr action:integrity file:"F"', 'save {"megammr":false}', "restart with megammr:false", "release"]);
  assert.equal(w.r, F.say(w.MF.CHECK_FAILED_BACK, { why: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }));
  assert.ok(!w.did.some(x => /action:import/.test(x)), "never imported");
  w = await flowWorld({ megammr: [true], check: () => ({ status: false, error: "java.lang.NullPointerException" }) });
  assert.deepEqual(w.did.slice(-2), ['megammr action:integrity file:"F"', "release"], "a MegaMMR node that refused a file is left as it was");
  // the import fails part-way (after the node reset its chain): restarted at once, light again when this flow turned MegaMMR on
  w = await flowWorld({ import: () => ({ status: false, error: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }) });
  assert.deepEqual(w.did.slice(-4), ['megammr action:import file:"F"', 'save {"megammr":false}', "restart with megammr:false", "release"]);
  assert.equal(w.r, F.say(w.MF.FAILED_BACK, { why: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }));
  w = await flowWorld({ megammr: [true], import: () => { throw new Error("socket hang up"); } });
  assert.deepEqual(w.did.slice(-3), ['megammr action:import file:"F"', "restart with megammr:true", "release"], "no answer: restarted too");
  assert.equal(w.r, F.say(w.MF.FAILED, { why: "socket hang up" }));
  // the status cannot be read: nothing at all is done; after the switch, the setting goes back to what it WAS (here: never set), not to false
  w = await flowWorld({ megammr: [null] }); assert.equal(w.r, w.MF.STATUS_UNKNOWN); assert.deepEqual(w.did, ["status null"]);
  w = await flowWorld({ megammr: [false, null] });
  assert.deepEqual(w.did.slice(3), ['save {"megammr":true}', "restart with megammr:true", "status null", 'save {"megammr":false}', "restart with megammr:false", "release"]);
  w = await flowWorld({ megammr: [false, null], was: undefined }); assert.ok(w.did.includes("save {}"), "the previous value (none) put back: " + w.did); assert.equal(w.r, F.ON_FAILED);
  w = await flowWorld({ megammr: [false, false] }); assert.deepEqual(w.did.slice(-3), ["status false", 'save {"megammr":false}', "release"], "came back light: put back, no second restart");
});

test("Resync from a MegaMMR file: refused, before anything changes, while work is open, while another resync or import runs, or without room; the file is checked again right before the import", async () => {
  let w = await flowWorld({ work: ["1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0xabc"] });
  assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: "1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0xabc" })); assert.deepEqual(w.did, ["status false"]);
  w = await flowWorld({ resyncing: true }); assert.equal(w.r, w.MF.BUSY); assert.deepEqual(w.did, []);
  w = await flowWorld({ refuse: true }); assert.equal(w.r, "The node keeps running: nothing was stopped."); assert.deepEqual(w.did, ["status false", "guard"]);
  // the plain Minima node gets Java's default memory, a quarter of the computer's, whatever the Parlons Node setting says
  const G = 1024 * 1024 * 1024, big = megaFile("flow/big.mmr", 64); fs.truncateSync(big, Math.floor(1.6 * G));
  w = await flowWorld({ kind: "minima", ram: 16 * G, file: big }); assert.match(w.r, /needs about 5941 MB of node memory, and the plain Minima node gets 4096 MB here/);
  w = await flowWorld({ kind: "minima", ram: 32 * G, file: big }); assert.deepEqual(w.r, { status: true, broken: false, on: true });
  // swapped for a link after the node checked it: the import is not sent
  const MF = require("../main/megammrfile.js");
  w = await flowWorld({ check: (c) => { const m = /file:"([^"]+)"/.exec(c)[1]; const real = m + ".real"; fs.renameSync(m, real); fs.symlinkSync(real, m); return { status: true }; } });
  assert.ok(!w.did.some(x => /action:import/.test(x)), w.did.join(" | ")); assert.match(w.r, /^The node read the whole file and refused it: Not a plain file/);
  assert.ok(w.did.includes("restart with megammr:false"));
  // one at a time: an import while Turn MegaMMR off (or a restore) runs is refused
  const gate = []; const mf = MF.create({ node: { resyncing: false }, mayStop: () => new Promise(r => gate.push(r)) });
  const first = mf.exclusive("restore", () => new Promise(r => gate.push(r)));
  await assert.rejects(mf.importMegammr("/x.mmr"), { message: MF.BUSY }); await assert.rejects(mf.megammrOff(), { message: MF.BUSY });
  gate.forEach(r => r()); await first; assert.equal(mf.busy(), false);
});

test("Turn MegaMMR off: the guard, only {megammr:false} saved, then the restart; it works with the node stopped (a broken MegaMMR can stop it at every start)", async () => {
  let w = await flowWorld({ off: true, megammr: [true] }); assert.deepEqual(w.did, ["guard", 'save {"megammr":false}', "restart with megammr:false"]);
  w = await flowWorld({ off: true, megammr: [true], state: "error" }); assert.deepEqual(w.did, ["guard", 'save {"megammr":false}', "restart with megammr:false"]); assert.deepEqual(w.r, { state: "running" });
  w = await flowWorld({ off: true, resyncing: true }); assert.equal(w.r, w.MF.BUSY);
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/ipcMain\.handle\("mcd:importMegammr", \(_e, shown\) => megafile\.importMegammr\(shown\)\)/.test(main) && /ipcMain\.handle\("mcd:megammrOff", \(\) => megafile\.megammrOff\(\)\)/.test(main));
  assert.ok(/ipcMain\.handle\("mcd:restoreBackup", \(_e, o\) => megafile\.exclusive\("restore"/.test(main), "a restore is one of them");
  assert.ok(/holdEngines: \(\) => node\.onEnginesHold\(\), releaseEngines: \(\) => node\.releaseEngines\(\)/.test(main) && /\|\| megafile\.busy\(\)/.test(main), "the engines are held, and Freeze does not let them go meanwhile");
  assert.ok(/dataDir: \(\) => node\.dataDir\(\)/.test(main), "the picker knows the node's data folder");
  assert.equal(rpc._timeoutFor('megammr action:integrity file:"/a.mmr"'), 60 * 60 * 1000, "the whole-file check is not cut at 3 minutes");
});

test("room for a MegaMMR import: the 460 MB snapshot fits the default 3072 MB; the 1.6 GB file needs about 6 GB", () => {
  const M = 1024 * 1024, G = 1024 * M, roomy = { ramBytes: 16 * G, freeDiskBytes: 100 * G };
  assert.equal(F.megammrHeapMb(0), 3072); assert.equal(F.megammrHeapMb("6144"), 6144);
  assert.equal(F.roomProblem(Object.assign({ size: 460 * M, heapMb: 3072 }, roomy)), "");
  assert.match(F.roomProblem(Object.assign({ size: 1605266343, heapMb: 3072 }, roomy)), /needs about 5617 MB of node memory, and the node is set to 3072 MB/);
  assert.equal(F.roomProblem(Object.assign({ size: 1605266343, heapMb: 6144 }, roomy)), "");
  assert.match(F.roomProblem({ size: 460 * M, heapMb: 3072, ramBytes: 4 * G - 1, freeDiskBytes: 100 * G }), /This computer has 4095 MB/);
  assert.equal(F.roomProblem({ size: 460 * M, heapMb: 3072, ramBytes: 16 * G, freeDiskBytes: null }), "", "free disk not known: not refused on it");
});

test("a broken MegaMMR or Cascade at boot: noticed during the boot only, its way out is the exit's words (the node halts at every start without -mobile), and it is reset at every start", () => {
  const NM = require("../main/node-manager.js"), C = { prototype: Object.getPrototypeOf(NM) };
  const fresh = (o) => Object.assign(Object.create(C.prototype), { logs: [], cont: { out: null, err: null }, parlons: { ready: true }, emit() {}, snapshot: () => ({}), log() {}, proc: {}, polled: false, megammrBroken: false, cascadeBroken: false, fatalHint: "" }, o);
  // the line as the private chain's node printed it before halting (exit code 0)
  let nm = fresh(); nm.nodeLine("Minima @ 23/11/2026 00:21:41 [16.0 MB] : java.lang.Exception: Your MEGAMMR is BROKEN (does not start 21 where tree ends 19).. please 'reset' your node.");
  assert.equal(nm.megammrBroken, true); assert.equal(nm.fatalHint, NM.MEGAMMR_BROKEN_HINT);
  assert.match(NM.MEGAMMR_BROKEN_HINT, /Press Turn MegaMMR off on this Node tab/); assert.ok(!/the node started|older than/i.test(NM.MEGAMMR_BROKEN_HINT), "no 'started', no guessed cause");
  nm = fresh(); nm.nodeLine("Minima @ 23/11/2026 00:21:41 [16.0 MB] : java.lang.Exception: Your Cascade is BROKEN.. please 'reset' your node.");
  assert.equal(nm.cascadeBroken, true); assert.equal(nm.megammrBroken, false); assert.equal(nm.fatalHint, NM.CASCADE_BROKEN_HINT); assert.match(NM.CASCADE_BROKEN_HINT, /set Rescue node/);
  nm = fresh({ polled: true }); nm.nodeLine("Your MEGAMMR is BROKEN"); nm.nodeLine("Your Cascade is BROKEN"); assert.equal(nm.megammrBroken || nm.cascadeBroken, false, "not believed after the boot"); assert.equal(nm.fatalHint, "");
  const src = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/this\.fatalHint = "";[\s\S]{0,200}this\.megammrBroken = false;[^\n]*\n\s*this\.cascadeBroken = false;/.test(src), "reset at every start");
  assert.ok(/megammrBroken: !!this\.megammrBroken, cascadeBroken: !!this\.cascadeBroken/.test(src), "in the node's snapshot");
  assert.ok(/this\.lastError = this\.fatalHint \|\| \("node exited unexpectedly \(" \+ \(code \?\? sig\) \+ "\)"\);/.test(src), "an exit says the hint, not 'node exited unexpectedly (0)'");
  // the window: the Node tab offers Turn MegaMMR off whenever the boot said so, stopped or not; the notice once per launch from the status
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/\$\{s\.megammrBroken \? `<button class="btn btn--danger" id="nMegaOff">/.test(app) && /if \(el\("nMegaOff"\)\) el\("nMegaOff"\)\.onclick = megammrOffNow;/.test(app));
  assert.ok(/\$\{s\.cascadeBroken \? `<button class="btn btn--outline" id="nRescue">\$\{th\("Startup Params"\)\}/.test(app));
  const off = app.slice(app.indexOf("async function megammrOffNow()"), app.indexOf("async function megammrOffNow()") + 400);
  assert.ok(off.indexOf("await showConfirm(") < off.indexOf("api.megammrOff()"), "asks first");
  assert.ok(/if \(s\.megammrBroken && !megaBrokenSaid\) \{ megaBrokenSaid = true; megammrBrokenNotice\(\); \}/.test(app), "said from the status, on any launch");
  assert.ok(/if \(BK_PAGE && !running && BK_PAGE !== "megaoff"\)/.test(app) && /running \|\| r\[0\] === "megaoff" \? "" : " disabled"/.test(app), "Backup & Recovery's Turn MegaMMR off works with the node stopped");
  assert.ok(!app.includes("The node started, but says its MegaMMR"), "the old wording is gone");
});

test("the screens: a file is chosen, never typed; each import asks first, saying what is replaced, and only then runs", () => {
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8"), body = app.slice(app.indexOf("function renderBackup()"), app.indexOf("// ---- starting / progress screen"));
  const runHelper = body.slice(body.indexOf("const run = async (btnId"), body.indexOf("const hostField"));
  assert.ok(runHelper.indexOf("await showConfirm(title, warning, okLabel") < runHelper.indexOf("built.exec()"), "the question comes before the run");
  const restorePage = body.slice(body.indexOf('if (BK_PAGE === "restore")'), body.indexOf('if (BK_PAGE === "megafile")'));
  assert.ok(restorePage.includes('filePick(t("Backup file"))') && restorePage.includes('wirePick("backup")') && restorePage.includes("const f = chosen,"));
  assert.ok(!/id="bkFile"[^>]*>|field\("bkFile"/.test(restorePage) && !/<input[^>]*bkFile/.test(body), "no text field for a path");
  assert.ok(restorePage.includes("The keys and coins this node holds now are GONE unless they are also in that backup."));
  const megaPage = body.slice(body.indexOf('if (BK_PAGE === "megafile")'), body.indexOf("// Private keys"));
  assert.ok(/const exec = async \(\) => \{ let j; try \{ j = await api\.importMegammr\(f\); \} finally \{ CFG = await api\.getConfig\(\)\.catch\(\(\) => CFG\); \} return j; \};[^\n]*\n\s*run\("bkGo", t\("Import"\), \{ host: CFG\.megammrHost, exec \}, t\("Import this MegaMMR file\?"\)/.test(megaPage), "through the shared question; the window's config read again after any import, failed or not");
  assert.ok(megaPage.includes("A light node is switched to MegaMMR mode first and restarted, and stays in MegaMMR mode.") && megaPage.includes("Turn MegaMMR off goes back, and deletes the MegaMMR file."));
  const offPage = body.slice(body.indexOf('if (BK_PAGE === "megaoff")'), body.indexOf("// Private keys"));
  assert.ok(offPage.indexOf('await showConfirm(t("Turn MegaMMR off?"), t(MEGAMMR_OFF_WARNING), t("Turn MegaMMR off"), true)') < offPage.indexOf("api.megammrOff()"), "Turn MegaMMR off asks first");
  assert.ok(/MEGAMMR_OFF_WARNING = N_\("The node restarts as a light node\.\\n\\n• Its MegaMMR file \(megammr\.mmr, in the node's data folder\) is DELETED at that restart\./.test(app), "and says the file is deleted");
  assert.ok(/if \(\(CFG\.params \|\| \{\}\)\.megammr\) rows\.splice/.test(body), "offered on a MegaMMR node only");
  assert.ok(megaPage.includes("Your wallet and seed phrase are not touched.") && megaPage.includes("Any transaction still waiting to be mined is dropped."));
  assert.ok(/\["megafile", t\("Resync from a MegaMMR file"\)/.test(body), "listed in Backup & Recovery");
  // the import's question: the trust warning; no memory figure; nothing about Resync node (it clears the MegaMMR: megammrsync.java)
  const ask = megaPage.slice(megaPage.indexOf('t("Minima will replace this node\'s chain'), megaPage.indexOf('t("Import")); };'));
  assert.ok(ask.includes("Import only a file from a source you trust. The node checks that the file is whole and holds together, not that it is the real Minima chain: a wrong or crafted file shows a different chain and different balances."));
  assert.ok(ask.includes("catches up from its peers by itself") && !/GB|memory|Resync node/.test(ask), "what catches the node up; no heap claim; no Resync node");
  assert.ok(restorePage.includes("Every key's use count is raised by 256"), "the restore says the +256 key uses (restore.java updateIncrementAllKeyUses(256))");
  // Startup Params: the MegaMMR switch and its checkbox ask when they move away from what is saved
  const ps = app.slice(app.indexOf("function renderParams("), app.indexOf("function ipcRaw("));
  assert.ok(/if \(sw\.id === "pMega"\) \{ const on = sw\.getAttribute\("aria-checked"\) !== "true"; if \(await megaAsk\(on\)\) P\.megammr = on;/.test(ps), "the switch");
  assert.ok(/if \(f === "megammr" && !await megaAsk\(inp\.checked\)\) \{ inp\.checked = !inp\.checked; return; \}/.test(ps), "the checkbox in All parameters");
  assert.ok(/showConfirm\(t\("Turn MegaMMR on\?"\), t\(MEGAMMR_ON_NOTE\)/.test(ps) && /showConfirm\(t\("Turn MegaMMR off\?"\), t\(MEGAMMR_OFF_WARNING\), t\("Turn MegaMMR off"\), true\)/.test(ps), "on: the empty MegaMMR note; off: the same deletion warning");
  assert.ok(/MEGAMMR_ON_NOTE = N_\("The node keeps a MegaMMR from its next restart, but it starts empty: until a MegaMMR file is imported it is incomplete and does not know older coins\.\\n\\nTo fill it, import a MegaMMR file instead: Backup & Recovery, Resync from a MegaMMR file/.test(app));
  const pre = fs.readFileSync(path.join(ROOT, "main", "preload.js"), "utf8");
  assert.ok(/pickImport: \(kind\) => ipcRenderer\.invoke\("mcd:pickImport", kind\)/.test(pre) && /importMegammr: \(file\) => ipcRenderer\.invoke\("mcd:importMegammr", file\)/.test(pre));
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/picked: \(shown\) => imports\.confirm\("backup", shown\)/.test(main), "Restore from file runs on main's chosen path only");
});
