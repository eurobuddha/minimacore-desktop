// A file the node is told to read (0.19.386): a backup for Restore from file, a MegaMMR file for Resync from a MegaMMR file.
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

test("Resync from a MegaMMR file: refused unless the node keeps the MegaMMR; asks the stop guard; the node gets one import of exactly the chosen file", async () => {
  const ts = require("typescript"), src = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), calls = {};
  let keeps = "";
  const walk = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0])) calls[n.arguments[0].text] = n.getText(sf);
    if (ts.isVariableStatement(n) && /^const nodeKeepsMegammr = /.test(n.getText(sf))) keeps = n.getText(sf);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(keeps && calls["mcd:pickImport"] && calls["mcd:importMegammr"]);
  const mega = file("downloads/mega 19 Nov.mmr", 8192);
  for (const [megammr, allow] of [[false, true], [true, false], [true, true]]) {
    const did = [], h = {}, imports = picker([mega]), env = { ipcMain: { handle: (n, f) => { h[n] = f; } }, requireRunning: () => {}, importfile: F, imports, process: { platform: "darwin" },
      rpc: { rpcCall: async (port, secret, c) => { did.push("ask " + c); return { status: true, response: { megammr } }; } }, node: { rpcPort: () => 1 }, config: { rpcSecret: () => "s" },
      mayStop: async () => { did.push("guard"); if (!allow) throw new Error("The node keeps running: nothing was stopped."); }, held: (op) => op(),
      runResync: async (c) => { did.push(c); return { status: true, command: "megammr", params: { action: "import", file: mega } }; } };
    new Function("env", "with (env) { " + keeps + "; " + calls["mcd:pickImport"] + "; " + calls["mcd:importMegammr"] + "; }")(env);
    if (!megammr) {
      picker.last = null; await assert.rejects(h["mcd:pickImport"](null, "megammr"), { message: F.NEEDS_MEGAMMR }); assert.equal(picker.last, null, "no dialog opened");
      await assert.rejects(h["mcd:importMegammr"](null, mega), { message: F.NEEDS_MEGAMMR });
      assert.deepEqual(did, ["ask status", "ask status"], "no dialog, no guard, no import"); continue;
    }
    await assert.rejects(h["mcd:importMegammr"](null, mega), { message: F.CHOOSE_FIRST }, "nothing chosen yet");
    assert.deepEqual(await h["mcd:pickImport"](null, "megammr"), { path: mega, size: 8192 });
    const r = await h["mcd:importMegammr"](null, mega).catch(e => e.message);
    const cmd = `megammr action:import file:"${mega}"`;
    assert.deepEqual(did, allow ? ["ask status", "ask status", "ask status", "guard", cmd] : ["ask status", "ask status", "ask status", "guard"]);
    assert.deepEqual(r, allow ? { status: true } : "The node keeps running: nothing was stopped.");
    assert.deepEqual(nodeRead(cmd), [{ verb: "megammr", params: { action: "import", file: mega } }]);
    assert.ok(restore.stopsNode(cmd) && !restore.loadsBackupFile(cmd) && !restore.replacesKeysElsewhere(cmd), "a stop, and not a wallet replacement");
    assert.equal(rpc._timeoutFor(cmd), 60 * 60 * 1000, "a long import is not cut at 3 minutes");
  }
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
  assert.ok(/run\("bkGo", t\("Import"\), \{ host: CFG\.megammrHost, exec: \(\) => api\.importMegammr\(f\) \}, t\("Import this MegaMMR file\?"\)/.test(megaPage), "through the shared question");
  assert.ok(megaPage.includes("Your wallet and seed phrase are not touched.") && megaPage.includes("Any transaction still waiting to be mined is dropped."));
  assert.ok(/\["megafile", t\("Resync from a MegaMMR file"\)/.test(body), "listed in Backup & Recovery");
  const pre = fs.readFileSync(path.join(ROOT, "main", "preload.js"), "utf8");
  assert.ok(/pickImport: \(kind\) => ipcRenderer\.invoke\("mcd:pickImport", kind\)/.test(pre) && /importMegammr: \(file\) => ipcRenderer\.invoke\("mcd:importMegammr", file\)/.test(pre));
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/picked: \(shown\) => imports\.confirm\("backup", shown\)/.test(main), "Restore from file runs on main's chosen path only");
});
