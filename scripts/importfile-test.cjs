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

test("Resync from a MegaMMR file turns MegaMMR on: room checked first; the setting saved BEFORE the restart; then one import of exactly the chosen file; a failed switch is put back", async () => {
  const ts = require("typescript"), src = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), calls = {}, decl = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0])) calls[n.arguments[0].text] = n.getText(sf);
    if ((ts.isVariableStatement(n) && /^const (nodeKeepsMegammr|sleepMs|freeDisk) = /.test(n.getText(sf))) || (ts.isFunctionDeclaration(n) && n.name && n.name.text === "nodeUp")) decl.push(n.getText(sf));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.equal(decl.length, 4); assert.ok(calls["mcd:pickImport"] && calls["mcd:importMegammr"] && calls["mcd:megammrOff"]);
  const mega = file("downloads/mega 19 Nov.mmr", 8192), G = 1024 * 1024 * 1024, cmd = `megammr action:import file:"${mega}"`;
  /** one world: the node's megammr answers in turn, the guard's answer, the heap setting, broken after the import */
  const world = async (o) => {
    const did = [], h = {}, answers = o.megammr.slice(), params = { megammr: o.megammr[0], isclient: true };
    const node = { state: "running", megammrBroken: false, rpcPort: () => 1, dataDir: () => DIR, log: () => {}, snapshot: () => ({}), restart: async () => { did.push("restart with megammr:" + params.megammr); } };
    const env = { ipcMain: { handle: (n, f) => { h[n] = f; } }, requireRunning: () => {}, importfile: F, imports: picker([mega]), process: { platform: "darwin" }, node,
      fs: Object.assign({}, fs, { statfsSync: () => ({ bavail: o.disk == null ? 100 * G : o.disk, bsize: 1 }) }), require: (m) => (m === "os" ? { totalmem: () => o.ram || 16 * G } : require(m)),
      rpc: { rpcCall: async (port, secret, c) => { const m = answers.length > 1 ? answers.shift() : answers[0]; did.push("status megammr:" + m); return { status: true, response: { megammr: m } }; } },
      config: { rpcSecret: () => "s", load: () => ({ heapMb: o.heapMb || 0, params: Object.assign({}, params) }), save: (p) => { Object.assign(params, p.params); did.push("save megammr:" + p.params.megammr); } },
      mayStop: async () => { did.push("guard"); if (o.refuse) throw new Error("The node keeps running: nothing was stopped."); }, held: (op) => op(),
      runResync: async (c) => { did.push(c); node.megammrBroken = !!o.broken; return { status: true, command: "megammr", params: { action: "import", file: mega } }; } };
    new Function("env", "with (env) { " + decl.join("\n") + "\n" + calls["mcd:pickImport"] + "; " + calls["mcd:importMegammr"] + "; " + calls["mcd:megammrOff"] + "; }")(env);
    await assert.rejects(h["mcd:importMegammr"](null, mega), { message: F.CHOOSE_FIRST }, "nothing chosen yet");
    assert.deepEqual(await h["mcd:pickImport"](null, "megammr"), { path: mega, size: 8192 }, "a light node may choose a file too");
    did.length = 0;
    const r = await h["mcd:importMegammr"](null, mega).catch(e => e.message);
    return { did, r, params, h };
  };
  // a light node: switched on (saved, then restarted), asked again, guarded again, imported
  let w = await world({ megammr: [false, true] });
  assert.deepEqual(w.did, ["status megammr:false", "guard", "save megammr:true", "restart with megammr:true", "status megammr:true", "guard", cmd]);
  assert.deepEqual(w.r, { status: true, broken: false, on: true }); assert.equal(w.params.megammr, true, "kept on: the restart after the import must not delete the MegaMMR");
  // the switch did not take: nothing imported, the setting put back (a light node has no MegaMMR to lose)
  w = await world({ megammr: [false, false] });
  assert.deepEqual(w.did, ["status megammr:false", "guard", "save megammr:true", "restart with megammr:true", "status megammr:false", "save megammr:false"]);
  assert.equal(w.r, F.ON_FAILED); assert.equal(w.params.megammr, false);
  // already a MegaMMR node: no switch; the guard says no: nothing sent
  w = await world({ megammr: [true], refuse: true }); assert.deepEqual(w.did, ["status megammr:true", "guard"]); assert.equal(w.r, "The node keeps running: nothing was stopped.");
  w = await world({ megammr: [true] }); assert.deepEqual(w.did, ["status megammr:true", "guard", cmd]);
  // the restarted node said its MegaMMR does not fit its chain
  w = await world({ megammr: [true], broken: true }); assert.deepEqual(w.r, { status: true, broken: true, on: true });
  // no room: refused before the guard, before any setting changes
  for (const [o, re] of [[{ heapMb: 1024 }, /needs about 1027 MB of node memory, and the node is set to 1024 MB/], [{ ram: 2 * G }, /This computer has 2048 MB of memory/], [{ disk: 100 * 1024 * 1024 }, /has 100 MB free, and this import needs about 514 MB/]]) {
    w = await world(Object.assign({ megammr: [false] }, o));
    assert.match(w.r, re); assert.deepEqual(w.did, ["status megammr:false"], "nothing changed"); assert.equal(w.params.megammr, false);
  }
  // Turn MegaMMR off: the guard, then the setting saved, then the restart (at which the node deletes megammr.mmr)
  w = await world({ megammr: [true] }); w.did.length = 0; await w.h["mcd:megammrOff"](); assert.deepEqual(w.did, ["guard", "save megammr:false", "restart with megammr:false"]);
  assert.deepEqual(nodeRead(cmd), [{ verb: "megammr", params: { action: "import", file: mega } }]);
  assert.ok(restore.stopsNode(cmd) && !restore.loadsBackupFile(cmd) && !restore.replacesKeysElsewhere(cmd), "a stop, and not a wallet replacement");
  assert.equal(rpc._timeoutFor(cmd), 60 * 60 * 1000, "a long import is not cut at 3 minutes");
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

test("the node's boot line \"Your MEGAMMR is BROKEN\" is noticed during the boot only, and starts clear at every start", () => {
  const NM = require("../main/node-manager.js"), C = { prototype: Object.getPrototypeOf(NM) };
  const nm = Object.create(C.prototype); nm.logs = []; nm.cont = { out: null, err: null }; nm.parlons = { ready: true }; nm.emit = () => {}; nm.snapshot = () => ({}); nm.log = () => {}; nm.proc = {}; nm.polled = false;
  nm.nodeLine("Minima @ 22/11/2026 10:00:00 [ 120.5 MB ] : java.lang.Exception: Your MEGAMMR is BROKEN (does not start 2426000 where tree ends 2426100).. please 'reset' your node.");
  assert.equal(nm.megammrBroken, true);
  const later = Object.create(C.prototype); Object.assign(later, { logs: [], cont: { out: null, err: null }, parlons: { ready: true }, emit() {}, snapshot: () => ({}), log() {}, proc: {}, polled: true, megammrBroken: false });
  later.nodeLine("Your MEGAMMR is BROKEN"); assert.equal(later.megammrBroken, false, "not believed after the boot");
  const src = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/this\.megammrBroken = false;[^\n]*\n\s*this\.keyModeChecked = false; this\.keyModeTries = 0; this\.polled = false;/.test(src), "reset at every start");
  assert.ok(/megammrBroken: !!this\.megammrBroken/.test(src), "in the node's snapshot");
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
  assert.ok(/const exec = async \(\) => \{ const j = await api\.importMegammr\(f\); if \(j && j\.status === true && j\.broken\) setTimeout\(megammrBrokenNotice, 0\); return j; \};\s*run\("bkGo", t\("Import"\), \{ host: CFG\.megammrHost, exec \}, t\("Import this MegaMMR file\?"\)/.test(megaPage), "through the shared question");
  assert.ok(megaPage.includes("A light node is switched to MegaMMR mode first and restarted.") && megaPage.includes("Turn MegaMMR off goes back, and deletes the MegaMMR file."));
  const offPage = body.slice(body.indexOf('if (BK_PAGE === "megaoff")'), body.indexOf("// Private keys"));
  assert.ok(offPage.indexOf('await showConfirm(t("Turn MegaMMR off?"), t(MEGAMMR_OFF_WARNING), t("Turn MegaMMR off"), true)') < offPage.indexOf("api.megammrOff()"), "Turn MegaMMR off asks first");
  assert.ok(/MEGAMMR_OFF_WARNING = N_\("The node restarts as a light node\.\\n\\n• Its MegaMMR file \(megammr\.mmr, in the node's data folder\) is DELETED at that restart\./.test(app), "and says the file is deleted");
  assert.ok(/if \(\(CFG\.params \|\| \{\}\)\.megammr\) rows\.splice/.test(body), "offered on a MegaMMR node only");
  assert.ok(megaPage.includes("Your wallet and seed phrase are not touched.") && megaPage.includes("Any transaction still waiting to be mined is dropped."));
  assert.ok(/\["megafile", t\("Resync from a MegaMMR file"\)/.test(body), "listed in Backup & Recovery");
  const pre = fs.readFileSync(path.join(ROOT, "main", "preload.js"), "utf8");
  assert.ok(/pickImport: \(kind\) => ipcRenderer\.invoke\("mcd:pickImport", kind\)/.test(pre) && /importMegammr: \(file\) => ipcRenderer\.invoke\("mcd:importMegammr", file\)/.test(pre));
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/picked: \(shown\) => imports\.confirm\("backup", shown\)/.test(main), "Restore from file runs on main's chosen path only");
});
