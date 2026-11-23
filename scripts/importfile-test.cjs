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
  const listeners = [], cfg = { megammrImport: o.marker || null };
  // this node's chain (M4): its tip and its blocks' ids, before the import (o.before) and after it (o.after, else the same chain)
  const ids = (n, tag) => "0x" + (tag + String(n)).padStart(64, "0").slice(-64).replace(/[^0-9A-F]/gi, "0");
  const before = Object.assign({ tip: 1000, tag: "AA" }, o.before), t0 = Date.now();
  let imported = false;
  const chain = (c) => { const now = imported ? Object.assign({}, before, { at: t0 }, o.after) : before, m = /^txpow block:(\d+)$/.exec(c);
    if (o.chain) { const r = o.chain(c, imported); if (r) return r; }
    if (!m) return { status: true, response: { block: String(now.tip), hash: ids(now.tip, now.tag), timemilli: String(now.at || Date.now()) } };
    return Number(m[1]) <= now.tip ? { status: true, response: { txpowid: ids(Number(m[1]), now.tag) } } : { status: false, error: "TxPoW not found @ height " + m[1] }; };
  const node = { state: o.state || "running", proc: {}, resyncing: !!o.resyncing, megammrBroken: false, heapMbNow: o.heapMbNow == null ? 3072 : o.heapMbNow, kind: () => o.kind || "parlons", dataDir: () => DIR,
    restart: async () => { did.push("restart with megammr:" + params.megammr); node.proc = {}; say(o.restartLines); node.state = o.downAfter && did.filter(x => x.startsWith("restart")).length === o.downAfter ? "error" : "running"; }, snapshot: () => ({ state: node.state }),
    start: async () => { did.push("start"); node.proc = {}; node.state = "running"; },
    on: (ev, f) => { if (ev === "line") listeners.push(f); }, removeListener: (ev, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); } };
  // the node's log: what each command prints, with MinimaLogger's prefix (main/megammrfile.js reads only those lines)
  const say = (lines) => { for (const l of lines || []) for (const f of listeners.slice()) f(/^\[raw\]/.test(l) ? l.slice(5) : "Minima @ 23/11/2026 00:04:04 [30.9 MB] : " + l); };
  const imports = picker([mega]);
  const d = { node, imports, fs: Object.assign({}, fs, { statfsSync: () => ({ bavail: 100 * G, bsize: 1 }) }), totalmem: () => o.ram || 16 * G, platform: "darwin", log: () => {}, sleep: async () => {}, upMs: 5,
    config: { load: () => ({ heapMb: o.heapMb || 0, params: Object.assign({}, params), megammrImport: cfg.megammrImport ? JSON.parse(JSON.stringify(cfg.megammrImport)) : undefined }), save: (p) => { did.push("save " + JSON.stringify(p.params)); Object.assign(params, p.params); },
      setMegammrImport: (v) => { did.push("marker " + (v ? v.stage : "cleared")); cfg.megammrImport = v || null; } },
    status: async () => { const m = answers.length > 1 ? answers.shift() : answers[0]; did.push("status " + m); if (m === null) throw new Error("ECONNREFUSED"); return { status: true, response: { megammr: m } }; },
    call: async (c) => { if (/^(block|txpow block:\d+)$/.test(c)) return chain(c); did.push(c.replace(mega, "F")); say(o.checkLines); return o.check ? o.check(c, { node, say }) : { status: true, response: {} }; },
    mayStop: async () => { did.push("guard"); if (o.refuse) throw new Error("The node keeps running: nothing was stopped."); }, held: (op) => op(),
    runResync: async (c) => { did.push(c.replace(mega, "F")); imported = true; if (o.swap) o.swap(mega); say(o.importLines); return o.import ? o.import(c, { node, say, cfg }) : { status: true }; },
    work: async () => o.work || [], holdEngines: async () => { did.push("hold"); }, releaseEngines: async () => { did.push("release"); } };
  if (o.emit) { node.emit = () => o.emit(node); d.showMs = 0; }
  if (o.sleep) d.sleep = (ms) => o.sleep(ms, { node, say, did }); if (o.stallMs) d.stallMs = o.stallMs; if (o.stuckMs) d.stuckMs = o.stuckMs;
  const mf = MF.create(d);
  await imports.pick("megammr");
  let r; try { r = await (o.off ? mf.megammrOff() : mf.importMegammr(mega)); } catch (e) { r = e.message; }
  for (let i = 0; i < 30; i++) await new Promise(res => setImmediate(res));   // the check after the import (verify) runs by itself
  return { did, r, params, mf, MF, cfg, node };
}

test("Resync from a MegaMMR file: engines held for the whole import; only {megammr:true} saved, always, before any restart; the node's own reader checks the whole file before anything is reset", async () => {
  let w = await flowWorld({});
  assert.deepEqual(w.did, ["status false", "hold", "guard", 'save {"megammr":true}', "restart with megammr:true", "status true", "guard",
    'megammr action:integrity file:"F"', "marker importing", 'megammr action:import file:"F"', "marker catchup", "marker cleared", "release"]);   // the marker, right before the import (0.19.392)
  assert.deepEqual(w.r, { status: true, broken: false, on: true }); assert.equal(w.params.megammr, true);
  // already a MegaMMR node: no switch, but the setting is still saved before the import (its restart must keep the MegaMMR)
  w = await flowWorld({ megammr: [true], was: false });
  assert.deepEqual(w.did, ["status true", "hold", "guard", 'save {"megammr":true}', 'megammr action:integrity file:"F"', "marker importing", 'megammr action:import file:"F"', "marker catchup", "marker cleared", "release"]);
  // ...whose memory setting was changed since it started: restarted first, so the room counted is the room it has
  w = await flowWorld({ megammr: [true, true], heapMb: 8192, heapMbNow: 3072 });
  assert.deepEqual(w.did.slice(0, 6), ["status true", "hold", "guard", 'save {"megammr":true}', "restart with megammr:true", "status true"]);
});

test("Resync from a MegaMMR file: every failure ends with the node restarted and the setting as it was; an unknown status is never read as off", async () => {
  // the node refuses the file (truncated, or its blocks do not follow its MegaMMR): nothing reset; a node this flow turned on goes back
  let w = await flowWorld({ check: () => ({ status: false, error: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }) });
  assert.deepEqual(w.did.slice(-4), ['megammr action:integrity file:"F"', 'save {"megammr":false}', "restart with megammr:false", "release"]);
  assert.equal(w.r, F.say(w.MF.CHECK_FAILED_BACK, { why: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }));
  assert.ok(!w.did.some(x => /action:import/.test(x)), "never imported");
  w = await flowWorld({ megammr: [true], check: () => ({ status: false, error: "java.lang.NullPointerException" }) });
  assert.deepEqual(w.did.slice(-2), ['megammr action:integrity file:"F"', "release"], "a MegaMMR node that refused a file is left as it was");
  // the import fails part-way (after the node reset its chain: it printed "Streaming IBD.."): restarted at once, light again when this flow
  // turned MegaMMR on; the marker stays and the engines stay held (0.19.392)
  const RESET = ["MegaMMR import pre-flight.. file:22.4 KB heapfree:6.0 GB heapmax:6.0 GB", "Loading MegaMMR portion.. (file 22.4 KB)", "MegaMMR loaded.. coins:4", "Streaming IBD.. blocks:34 (with cascade)"];
  w = await flowWorld({ importLines: RESET, import: () => ({ status: false, error: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }) });
  assert.deepEqual(w.did.slice(-4), ['megammr action:import file:"F"', "marker failed", 'save {"megammr":false}', "restart with megammr:false"]);
  assert.equal(w.r, F.say(w.MF.FAILED_BACK, { why: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }));
  w = await flowWorld({ megammr: [true], importLines: RESET, import: (c, n) => { n.node.proc = null; throw new Error("socket hang up"); } });
  assert.deepEqual(w.did.slice(-3), ['megammr action:import file:"F"', "marker failed", "restart with megammr:true"], "no answer, the node gone: restarted too");
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
  assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: "1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0xabc" })); assert.deepEqual(w.did, ["status false", "hold", "release"], "held first, then read, then let go (0.19.395)");
  w = await flowWorld({ resyncing: true }); assert.equal(w.r, w.MF.BUSY); assert.deepEqual(w.did, []);
  w = await flowWorld({ refuse: true }); assert.equal(w.r, "The node keeps running: nothing was stopped."); assert.deepEqual(w.did, ["status false", "hold", "guard", "release"]);
  // the plain Minima node gets Java's default memory, a quarter of the computer's, whatever the Parlons Node setting says
  const G = 1024 * 1024 * 1024, big = megaFile("flow/big.mmr", 64); fs.truncateSync(big, Math.floor(1.6 * G));
  w = await flowWorld({ kind: "minima", ram: 16 * G, file: big }); assert.match(w.r, /four times that in memory while it checks and imports it: 6556 MB, and the plain Minima node gets 4096 MB here \(a quarter of this computer's memory\)\. In Settings, choose the Parlons Node, set Parlons Node memory to 6556 or more/);
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
  assert.ok(/holdEngines: \(\) => \{ pauseLoops\(\); return node\.onEnginesHold\(\); \}, releaseEngines: \(\) => node\.releaseEngines\(\)/.test(main) && /replacing: \(\) => \(megafile\.busy\(\) \? "import"/.test(main), "the engines are held, and Freeze does not let them go meanwhile");
  assert.ok(/dataDir: \(\) => node\.dataDir\(\)/.test(main), "the picker knows the node's data folder");
  assert.equal(rpc._timeoutFor('megammr action:integrity file:"/a.mmr"'), 60 * 60 * 1000, "the whole-file check is not cut at 3 minutes");
});

test("room for a MegaMMR import: four times the file (the owner's 1.5 GB mainnet file peaked at 5.5 GB of a 6144 MB heap)", () => {
  const M = 1024 * 1024, G = 1024 * M, roomy = { ramBytes: 16 * G, freeDiskBytes: 100 * G };
  assert.equal(F.megammrHeapMb(0), 3072); assert.equal(F.megammrHeapMb("6144"), 6144);
  assert.equal(F.roomProblem(Object.assign({ size: 460 * M, heapMb: 3072 }, roomy)), "");
  assert.match(F.roomProblem(Object.assign({ size: 1605266343, heapMb: 3072 }, roomy)), /This MegaMMR file is 1531 MB\. The node needs about four times that in memory while it checks and imports it: 6124 MB, and it is set to 3072 MB\. In Settings, set Parlons Node memory to 6124 or more and press Apply and restart the node/);
  assert.equal(F.roomProblem(Object.assign({ size: 1605266343, heapMb: 6144 }, roomy)), "");
  assert.equal(F.roomProblem(Object.assign({ size: 1536 * M, heapMb: 6144 }, roomy)), "", "the owner's import: 1.5 GB in 6144 MB");
  assert.match(F.roomProblem(Object.assign({ size: 1536 * M, heapMb: 5120 }, roomy)), /: 6144 MB, and it is set to 5120 MB/, "below its measured peak: refused");
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
  assert.ok(/\$\{s\.megammrBroken \? `<button class="btn btn--danger" id="nMegaOff"\$\{busyAttr\(\)\}>/.test(app) && /if \(el\("nMegaOff"\)\) el\("nMegaOff"\)\.onclick = megammrOffNow;/.test(app));
  assert.ok(/\$\{s\.cascadeBroken \? `<button class="btn btn--outline" id="nRescue">\$\{th\("Startup Params"\)\}/.test(app));
  const off = app.slice(app.indexOf("async function megammrOffNow()"), app.indexOf("async function megammrOffNow()") + 400);
  assert.ok(off.indexOf("await showConfirm(") < off.indexOf("api.megammrOff()"), "asks first");
  assert.ok(/if \(s\.megammrBroken && s\.bootTs && megaBrokenSaid !== s\.bootTs && megaBrokenSeen\(\) !== String\(s\.bootTs\)\) \{ megaBrokenSaid = s\.bootTs; megaBrokenSeen\(String\(s\.bootTs\)\); megammrBrokenNotice\(\); \}/.test(app), "said from the status, once per node start (0.19.395: not once per window)");
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
  assert.ok(/const exec = async \(\) => \{ let j; try \{ j = await api\.importMegammr\(f\); \} finally \{ CFG = await api\.getConfig\(\)\.catch\(\(\) => CFG\); \} return j; \};[^\n]*\n\s*run\("bkGo", t\("Import"\), \{ host: CFG\.megammrHost, exec, importing: true \}, t\("Import this MegaMMR file\?"\)/.test(megaPage), "through the shared question; the window's config read again after any import, failed or not");
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

// ---- second review, M2 + M3 (0.19.392): the marker that survives a quit, pre-reset and post-reset failures told apart, no answer is not an end ----
const RESET_LINES = ["MegaMMR import pre-flight.. file:22.4 KB heapfree:6.0 GB heapmax:6.0 GB", "Loading MegaMMR portion.. (file 22.4 KB)", "MegaMMR loaded.. coins:4", "Streaming IBD.. blocks:34 (with cascade)"];
test("M2: the marker is written right before the import and cleared only on success or a failure before the node reset its chain; with it set nothing is released", async () => {
  let w = await flowWorld({});
  assert.ok(w.did.indexOf("marker importing") === w.did.indexOf('megammr action:import file:"F"') - 1, "right before the import: " + w.did.join(" | "));
  assert.equal(w.cfg.megammrImport, null); assert.equal(w.did.at(-1), "release");
  // stopped before "Streaming IBD..": nothing reset, so nothing owed: marker cleared, engines released, the message never says Resync
  w = await flowWorld({ importLines: RESET_LINES.slice(0, 2), import: () => ({ status: false, error: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }) });
  assert.deepEqual(w.did.slice(-5), ['megammr action:import file:"F"', "marker cleared", 'save {"megammr":false}', "restart with megammr:false", "release"]);
  assert.equal(w.r, F.say(w.MF.NOT_STARTED_BACK, { why: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" })); assert.ok(!/Resync/.test(w.r));
  w = await flowWorld({ megammr: [true], import: () => ({ status: false, error: "Unsupported MegaMMR backup version: 2" }) });
  assert.equal(w.r, F.say(w.MF.NOT_STARTED, { why: "Unsupported MegaMMR backup version: 2" })); assert.equal(w.cfg.megammrImport, null);
  // after it: the marker stays (failed), nothing released, the message says Resync node
  w = await flowWorld({ importLines: RESET_LINES, import: () => ({ status: false, error: "MegaMMR IBD batch was not fully accepted" }) });
  assert.equal(w.cfg.megammrImport.stage, "failed"); assert.equal(w.cfg.megammrImport.turnedOn, true); assert.ok(!w.did.includes("release"), w.did.join(" | ")); assert.match(w.r, /use Resync node/);
  // a quit or a crash in the middle: the marker written before the import is all that is left
  let seen; w = await flowWorld({ importLines: RESET_LINES, import: (c, x) => { seen = JSON.parse(JSON.stringify(x.cfg.megammrImport)); return { status: true }; } });
  assert.equal(seen && seen.stage, "importing", "already written while the node imports");
  // a success the node itself calls broken (its boot said "Your MEGAMMR is BROKEN") releases nothing
  w = await flowWorld({ import: (c, n) => { n.node.megammrBroken = true; return { status: true }; } });
  assert.deepEqual(w.r, { status: true, broken: true, on: true }); assert.equal(w.cfg.megammrImport.stage, "failed"); assert.ok(!w.did.includes("release"));
  // only the logger's own lines count: a line that merely contains the words does not make a failure "after the reset"
  w = await flowWorld({ importLines: ["[raw]peer says Streaming IBD.. blocks:1", "[raw]Minima @ x : Streaming IBD.. blocks:1"], import: () => ({ status: false, error: "x" }) });
  assert.equal(w.cfg.megammrImport, null, "not anchored to the logger's prefix: not believed");
});

test("M2: a Resync node that ended well clears the marker and releases the engines; without one it does nothing", async () => {
  const MF = require("../main/megammrfile.js"), did = [], cfg = { megammrImport: { stage: "failed" } };
  const mf = MF.create({ node: {}, log: () => {}, releaseEngines: async () => did.push("release"), config: { load: () => ({ megammrImport: cfg.megammrImport }), setMegammrImport: (v) => { did.push("marker " + v); cfg.megammrImport = v; } } });
  await mf.resynced(); assert.deepEqual(did, ["marker null", "release"]); await mf.resynced(); assert.deepEqual(did, ["marker null", "release"], "once");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(main.includes("const r = await node.runResync(c); if (r && r.status === true && restore.isResync(c)) await megafile.resynced(); return r; };"), "every Resync node, from any screen or the Terminal");
  assert.ok(/node\.onEnginesRelease = \(\) => \{ if \(freeze\.isFrozen\("dexicon"\) \|\| config\.load\(\)\.megammrImport\) return;/.test(main), "no release of the engines while the marker is set, whoever asks");
  const boot = main.slice(main.indexOf("app.whenReady().then(() => {"));
  assert.ok(boot.indexOf("if (c.megammrImport) {") > 0 && boot.indexOf("node.onEnginesHold()") > boot.indexOf("if (c.megammrImport) {") && boot.indexOf("node.onEnginesHold()") < boot.indexOf("if (c.setupDone && c.walletDone) node.start();"), "held at launch, before the node starts");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "main", "config.js"), "utf8");
  assert.ok(!/^\s*megammrImport:/m.test(cfgSrc.slice(cfgSrc.indexOf("const DEFAULTS"), cfgSrc.indexOf("function load()"))) && /function setMegammrImport\(v\)/.test(cfgSrc), "never from the window's patch (save() drops a key DEFAULTS does not name)");
  const nm = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/this\.emit\("line", scrub\(l, this\.secret\)\);[^\n]*\n\s*this\.log\(l\);\n\s*\}/.test(nm) && /megammrImport: \(\(m\) => \(m && typeof m === "object" && String\(m\.stage \|\| ""\)\) \|\| ""\)\(config\.load\(\)\.megammrImport\)/.test(nm), "the node's fresh lines and the marker's stage in its status");
  // the window: the banner on every screen, its one press, never by itself
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8"), html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  assert.ok(/id="megaBar" role="alert" hidden><span id="megaBarText"><\/span><button class="btn btn--outline btn--sm" id="megaBarOff" hidden><\/button><button class="btn btn--primary btn--sm" id="megaBarResync"><\/button>/.test(html));
  assert.ok(/MEGA_UNFINISHED = N_\("Balance incomplete after an unfinished MegaMMR import\. Your funds are safe\. Resync node rebuilds the chain from \{host\}\."\)/.test(app));
  assert.ok(/show = !!stage && !s\.megafileBusy && !s\.resyncing && !!CFG\.walletDone;/.test(app) && /t\(MEGA_UNFINISHED, \{ host: CFG\.megammrHost \|\| "" \}\)/.test(app), "with the host from config");
  assert.equal((app.match(/megaResyncNow\b/g) || []).length, 2, "defined once, called only from its button"); assert.ok(/el\("megaBarResync"\)\.onclick = megaResyncNow;/.test(app));
  assert.ok(/const built = resyncCommand\(\{ host: CFG\.megammrHost \}\);[\s\S]{0,400}await cmd\(built\.cmd\)/.test(app), "Resync node, built where every resync is built, through mcd:cmd");
});

test("M3: no answer from a node that is still importing is not an end: it is followed from its log, never restarted, and finishes", async () => {
  // the RPC's bound ends; the node goes on, prints its steps, saves and exits by itself; the flow then starts it again
  const steps = ["IBD blocks processed.. 2560/5120", "IBD blocks processed.. 5120/5120", "System memory clean..", "Transfer your CoinProofs.. 2", "All saved..", "Main Instance Cleared.."];
  let w = await flowWorld({ importLines: RESET_LINES, import: () => { throw new Error("RPC timeout. The node did not answer, and it may still be resyncing"); },
    sleep: async (ms, x) => { if (steps.length) x.say([steps.shift()]); else if (x.node.proc) { x.did.push("node exits by itself"); x.node.proc = null; x.node.state = "error"; } } });
  assert.deepEqual(w.r, { status: true, broken: false, on: true }, String(w.r));
  assert.deepEqual(w.did.slice(-6), ['megammr action:import file:"F"', "node exits by itself", "start", "marker catchup", "marker cleared", "release"], "no restart while it worked");
  // no new step for longer than the stall bound: given up (after the reset: the marker stays, the node is restarted)
  w = await flowWorld({ importLines: RESET_LINES, stallMs: 30, import: () => { throw new Error("RPC timeout"); }, sleep: () => new Promise(r => setTimeout(r, 5)) });
  assert.match(w.r, /the node showed no progress for 0 minutes/); assert.equal(w.cfg.megammrImport.stage, "failed"); assert.ok(w.did.includes("restart with megammr:false"));
  // the node exits without finishing: not an answer either way, but the end
  w = await flowWorld({ importLines: RESET_LINES, import: () => { throw new Error("RPC timeout"); }, sleep: async (ms, x) => { x.node.proc = null; } });
  assert.match(w.r, /the node stopped before it finished/); assert.equal(w.cfg.megammrImport.stage, "failed");
  // the integrity check too: followed to "All coins checked", then the import goes on
  w = await flowWorld({ check: () => { throw new Error("RPC timeout"); }, sleep: async (ms, x) => x.say(["Checking coins @ 5000 / 9000", "All coins checked 9000 / 9000"]) });
  assert.deepEqual(w.r, { status: true, broken: false, on: true }); assert.ok(w.did.includes('megammr action:import file:"F"'));
  // a node that is not there any more is not followed
  w = await flowWorld({ megammr: [true], check: (c, x) => { x.node.proc = null; throw new Error("ECONNRESET"); } });
  assert.ok(!w.did.includes('megammr action:import file:"F"') && w.did.includes("restart with megammr:true"), w.did.join(" | "));
  const MF = require("../main/megammrfile.js");
  assert.equal(MF.STALL_MS, 30 * 60 * 1000);
  for (const l of ["Load MegaMMR.. 1.6 GB", "Checking coins @ 5000 / 9000", "IBD blocks processed.. 2560/34000", "MegaMMR loading coins.. 250000/9000000 kept:12", "Streaming IBD.. blocks:34 (with cascade)", "All saved.."]) assert.ok(MF.STEP.test(l), l);
});

test("the owner's complaint (2026-11-23): the import's screen shows every step live, from the node's own log, with its last lines, not only after a timeout", async () => {
  const shots = [];
  const restartLines = ["Loading MegaMMR size : 1.5 GB", "MegaMMR loading coins.. 250000/663414 kept:250000", "MegaMMR loading coins.. 500000/663414 kept:500000"];
  const w = await flowWorld({ checkLines: ["Load MegaMMR.. 1.5 GB", "Check IBD..", "Now check all coin proofs..", "Checking coins @ 5000 / 663588", "All coins checked 663588 / 663588"],
    importLines: RESET_LINES.concat(["IBD blocks processed.. 1102/1102", "Transfer your CoinProofs.. 2", "All saved.."]),
    restartLines, emit: (node) => shots.push({ step: node.megafileStep, log: (node.megafileLog || []).slice(), busy: node.megafileBusy }) });
  assert.deepEqual(w.r, { status: true, broken: false, on: true });
  const steps = shots.filter(x => x.busy).map(x => x.step);
  for (const k of ["app:restart-on", "app:check", "app:import", "app:restart-end"]) assert.ok(steps.includes(k), k + " in " + steps.join(" | "));
  assert.ok(steps.indexOf("app:restart-on") < steps.indexOf("app:check") && steps.indexOf("app:check") < steps.indexOf("app:import"), "in order");
  assert.ok(steps.some(x => /^MegaMMR loading coins/.test(x)) && steps.some(x => /^Load MegaMMR\.\. 1\.5 GB|^Check IBD|^Checking coins @/.test(x)), "the node's own steps, before any timeout: " + steps.join(" | "));
  assert.ok(shots.some(x => x.log.some(l => /^Minima @ .* : (Streaming IBD|IBD blocks processed)/.test(l))), "the node's last lines, whole");
  assert.equal(shots.at(-1).busy, ""); assert.deepEqual(shots.at(-1).log, [], "gone with the import");
  // the window says each step in its language (renderer/app.js importStage), numbers as the node wrote them
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  const I18N = require("../renderer/i18n.js"); for (const c of ["en", "zh"]) require("../renderer/i18n/" + c + ".js");
  const src = app.slice(app.indexOf("function importStage(step)"), app.indexOf("/** The import's screen while it runs"));
  const importStage = new Function("t", src + "; return importStage;")((k, v) => I18N.t(k, v));
  I18N.set("en");
  const said = (l) => importStage(l);
  assert.equal(said("MegaMMR loading coins.. 250000/663414 kept:250000"), "Loading the node's MegaMMR: 250000 of 663414 coins");
  assert.equal(said("Checking coins @ 5000 / 663588"), "Checking coins: 5000 of 663588");
  assert.equal(said("IBD blocks processed.. 1102/1102"), "Importing blocks: 1102 of 1102");
  assert.equal(said("Load MegaMMR.. 1.5 GB"), "Reading the MegaMMR file…"); assert.equal(said("Streaming IBD.. blocks:1102 (with cascade)"), "Replacing the chain…");
  assert.equal(said("app:restart-on"), "Restarting the node in MegaMMR mode…"); assert.equal(said("All saved.."), "Saved. Restarting the node…");
  I18N.set("zh"); assert.ok(/663414/.test(said("MegaMMR loading coins.. 250000/663414 kept:250000")) && !/Loading/.test(said("MegaMMR loading coins.. 1/2"))); I18N.set("en");
  assert.ok(/<div id="bkProg" hidden><div class="bk-stage" id="bkStage" role="status" aria-live="polite"><\/div><div class="eyebrow ps-label">\$\{th\("Node log"\)\}<\/div><div class="bk-mono bk-log" id="bkLog"><\/div><\/div>/.test(app));
  assert.ok(/if \(activeView === "backup" && BK_PAGE === "megafile"\) paintImportProgress\(s\);/.test(app) && /wirePick\("megammr"\); paintImportProgress\(LAST_STATUS\);/.test(app), "from every status, and when the screen is opened again");
  const nm = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/megafileLog: this\.megafileBusy && Array\.isArray\(this\.megafileLog\) \? this\.megafileLog\.slice\(\) : \[\]/.test(nm) && /this\.emit\("line", scrub\(l, this\.secret\)\)/.test(nm), "redacted as the Logs are");
});

// ---- second review, M4 (0.19.394): a file from another chain is refused by its tip, or found out after the import; the engines wait for the network's tip ----
test("M4: the file's chain tip against this node's: far above, starting above it, or more than 30 days below is refused before anything is reset", async () => {
  const MF = require("../main/megammrfile.js"), at = (chaintip, cascadetip) => () => ({ status: true, response: { cascadetip: String(cascadetip), chaintip: String(chaintip), weight: "1" } });
  let w = await flowWorld({ check: at(1101, 1000) });   // 101 above a node at 1000
  assert.equal(w.r, F.say(MF.TIP_REFUSED_BACK, { why: F.say(MF.AHEAD_WHY, { chaintip: "1101", tip: "1000" }) })); assert.ok(!w.did.some(x => /action:import/.test(x)) && w.did.includes("restart with megammr:false"));
  w = await flowWorld({ megammr: [true], check: at(1050, 1000) });   // its block list starts at this node's tip: none of its blocks could be found in it
  assert.equal(w.r, F.say(MF.TIP_REFUSED, { why: F.say(MF.AHEAD_WHY, { chaintip: "1050", tip: "1000" }) }));
  w = await flowWorld({ before: { tip: 60000 }, check: at(8159, 7000) });   // 51841 blocks behind
  assert.equal(w.r, F.say(MF.TIP_REFUSED_BACK, { why: F.say(MF.BEHIND_WHY, { chaintip: "8159", tip: "60000" }) }));
  for (const [top, casc] of [[1100, 999], [990, 900], [8160, 7000 + 52000 - 52000]]) { w = await flowWorld({ before: { tip: top === 8160 ? 60000 : 1000 }, check: at(top, casc) }); assert.deepEqual(w.r, { status: true, broken: false, on: true }, top + ": " + w.r); }
  assert.equal(MF.AHEAD, 100); assert.equal(MF.BEHIND, 51840); assert.equal(MF.DEEP, 300);
  // this node's tip cannot be read: nothing decided on an unknown
  w = await flowWorld({ chain: (c) => (c === "block" ? { status: false, error: "x" } : null) });
  assert.equal(w.r, MF.STATUS_UNKNOWN); assert.ok(!w.did.some(x => /action:(integrity|import)/.test(x)));
});

test("M4: after the import the engines wait until this node's own earlier blocks are on the new chain and it is at the network's tip; another chain is said, and nothing is released", async () => {
  // the anchors are recorded before anything is touched: DEEP back, NEAR back and the tip, with their ids, whole
  let w = await flowWorld({ after: { tip: 1000, tag: "AA", at: Date.now() - 2 * 3600 * 1000 } });   // same chain, tip 2 hours old: not caught up
  assert.deepEqual(w.cfg.megammrImport.anchors.map(a => a.block), [700, 997, 1000]); assert.ok(w.cfg.megammrImport.anchors.every(a => /^0x[0-9A-F]{64}$/i.test(a.txpowid)));
  assert.equal(w.cfg.megammrImport.stage, "catchup"); assert.ok(!w.did.includes("release"), "held while it catches up");
  // ...then it reaches the tip: confirmed, released
  const after = { tip: 950, tag: "AA", at: Date.now() - 3 * 3600 * 1000 };
  w = await flowWorld({ after });   // an older file: below the old tip
  assert.equal(w.cfg.megammrImport.stage, "catchup");
  Object.assign(after, { tip: 1012, at: Date.now() }); await w.mf.verify();
  assert.equal(w.cfg.megammrImport, null); assert.equal(w.did.at(-1), "release");
  // another chain at the anchors' heights: "foreign" at once, nothing released, the banner says so with Turn MegaMMR off and Resync node
  w = await flowWorld({ after: { tip: 1040, tag: "BB", at: Date.now() } });
  assert.equal(w.cfg.megammrImport.stage, "foreign"); assert.ok(!w.did.includes("release"));
  // a shorter chain that never grows towards the old tip (its peers are on another chain): foreign after STUCK_MS
  w = await flowWorld({ after: { tip: 650, tag: "BB", at: Date.now() - 3600 * 1000 } });
  assert.equal(w.cfg.megammrImport.stage, "catchup");
  const MF = require("../main/megammrfile.js"); assert.equal(MF.STUCK_MS, 30 * 60 * 1000); assert.equal(MF.FRESH_MS, 30 * 60 * 1000);
  w = await flowWorld({ after: { tip: 650, tag: "BB", at: Date.now() - 3600 * 1000 }, stuckMs: 1 });
  await new Promise(r => setTimeout(r, 5)); await w.mf.verify(); assert.equal(w.cfg.megammrImport.stage, "foreign");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/node\.on\("status", \(s\) => \{ if \(s && s\.state === "running"\) megafile\.verify\(\)\.catch\(\(\) => \{\}\); \}\);/.test(main), "asked at every status, at launch too");
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/stage === "catchup" \? t\(MEGA_CATCHUP\) : stage === "foreign" \? t\(MEGA_FOREIGN\)/.test(app) && /off\.hidden = !\(stage === "foreign" && \(CFG\.params \|\| \{\}\)\.megammr\)/.test(app) && /el\("megaBarOff"\)\.onclick = megammrOffNow;/.test(app));
  assert.ok(/b\.hidden = stage === "catchup";/.test(app), "no Resync offered while it only catches up");
});

// ---- second review, MINORs and NITs (0.19.395) ----
test("MINOR: the file is fingerprinted before the check and compared before the import; truthful messages for no answer, out of memory, a coin's JSON cut, FAILED on a MegaMMR node", async () => {
  const MF = require("../main/megammrfile.js");
  let w = await flowWorld({ check: (c) => { fs.appendFileSync(/file:"([^"]+)"/.exec(c)[1], Buffer.alloc(16, 1)); return { status: true, response: {} }; } });
  assert.equal(w.r, F.say(MF.TIP_REFUSED_BACK, { why: MF.CHANGED_WHY })); assert.ok(!w.did.some(x => /action:import/.test(x)));
  w = await flowWorld({ check: (c, x) => { x.node.proc = null; throw new Error("socket hang up"); } });
  assert.equal(w.r, F.say(MF.CHECK_UNANSWERED_BACK, { why: "socket hang up" }), "not 'the node read the whole file and refused it'");
  w = await flowWorld({ megammr: [true], check: (c, x) => { x.node.proc = null; throw new Error("socket hang up"); } });
  assert.equal(w.r, F.say(MF.CHECK_UNANSWERED, { why: "socket hang up" }));
  w = await flowWorld({ heapMb: 6144, check: () => ({ status: false, error: "java.lang.OutOfMemoryError: Java heap space" }) });
  assert.equal(w.r, F.say(MF.OOM_BACK, { why: "java.lang.OutOfMemoryError: Java heap space", heap: "6144" }));
  w = await flowWorld({ megammr: [true], checkLines: ["[raw]Exception in thread \"RPC\" java.lang.OutOfMemoryError: Java heap space"], check: (c, x) => { x.node.proc = null; throw new Error("socket hang up"); } });
  assert.equal(w.r, F.say(MF.OOM_SAID, { why: "socket hang up", heap: "3072" }), "the node's own line says it: the exit is said as memory");
  w = await flowWorld({ megammr: [true], import: () => ({ status: false, error: "MegaMMR import failed : java.lang.OutOfMemoryError: Java heap space .. RESTART Minima before retrying" }) });
  assert.match(w.r, /^The node ran out of memory reading this MegaMMR file .*Nothing was imported or reset\./); assert.equal(w.cfg.megammrImport, null);
  w = await flowWorld({ check: () => ({ status: false, error: "INVALID Coin proof! @ {\"coinid\":\"0x00\",\"amount\":\"1\"}" }) });
  assert.equal(w.r, F.say(MF.CHECK_FAILED_BACK, { why: "INVALID Coin proof!" }), "the reason, not the coin's JSON");
  assert.match(MF.FAILED, /Resync node also empties this node's MegaMMR \(megammrsync clears it\): import a MegaMMR file again afterwards to have it whole\.$/);
  assert.ok(!/empties/.test(MF.FAILED_BACK), "a node turned back light has no MegaMMR to empty");
});

test("MINOR: during the import and while it is unfinished, Mail, miniMall, Vestr, Future Cash Next and P2P Chance do not run; Freeze says it is the import", async () => {
  const freeze = require("../main/freeze.js"); let paused = true; const started = [];
  const f = freeze.create({ load: () => [], save() {}, paused: () => paused, engines: { mail: { start: () => started.push("mail") }, minimall: { start: () => started.push("minimall") }, vestr: { start: () => started.push("vestr") }, chat: { start: () => started.push("chat") } } });
  for (const id of ["mail", "minimall", "vestr", "chat"]) f.start(id);
  assert.deepEqual(started, ["chat"], "chat is not money; the others wait"); paused = false; for (const id of ["mail", "minimall", "vestr"]) f.start(id); assert.deepEqual(started, ["chat", "mail", "minimall", "vestr"]);
  const g = freeze.create({ load: () => [], save() {}, replacing: () => "import", engines: { dexicon: { gate() {}, stop() {}, start() {} } } });
  await assert.rejects(g.set("dexicon", true), { message: "A MegaMMR file import is running, and Dexicon's engines are stopped for it. Dexicon can be frozen once that has finished." });
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/const loopsPaused = \(\) => megafile\.busy\(\) \|\| !!config\.load\(\)\.megammrImport;/.test(main) && /function pauseLoops\(\) \{ mail\.stopLoop\(\); shop\.stopLoop\(\); vestr\.stopLoop\(\); futurecash\.stop\(\)\.catch\(\(\) => \{\}\); casino\.stopLoop\(\); casinoStarted = false; \}/.test(main));
  assert.ok(/holdEngines: \(\) => \{ pauseLoops\(\); return node\.onEnginesHold\(\); \}/.test(main) && /paused: \(\) => loopsPaused\(\),/.test(main));
  assert.ok(/if \(s\.state !== "running" \|\| loopsPaused\(\)\) \{ fcBlock = 0; fcStarter\.reset\(\); futurecash\.stop\(\)/.test(main) && /if \(casinoStarted \|\| loopsPaused\(\)\) return;/.test(main), "Future Cash Next and P2P Chance");
});

test("MINOR/NIT: the Web Wallet points to the import; the import's skip question is its own; a broken MegaMMR is said once per node start, from the logger's own line", () => {
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8"), main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), pre = fs.readFileSync(path.join(ROOT, "main", "preload.js"), "utf8");
  assert.ok(!/wwEnableMegammr/.test(main + pre + app), "no MegaMMR switch-on that leaves it empty");
  assert.ok(/el\("wwEnableBtn"\)\.addEventListener\("click", \(\) => \{ BK_PAGE = "megafile"; selectTab\("backup"\); \}\);/.test(app) && app.includes('th("Import a MegaMMR file")'));
  const off = app.slice(app.indexOf("async function offerWithoutDexicon(e, importing)"), app.indexOf("const IMPORT_SKIP_NOTE"));
  assert.ok(/if \(importing\) \{ if \(!await showConfirm\(t\("Import without these checks\?"\), ipcError\(e\) \+ "\\n\\n" \+ t\(IMPORT_SKIP_NOTE\)/.test(off) && /if \(!importing\) try \{ warning = MainSaid\.say\(await api\.dxSkipWarning\(\)\)/.test(off) && /if \(!importing && !await showConfirm\(dexOnly/.test(off), "never the wallet-replacement wording for an import");
  const NM = require("../main/node-manager.js"), C = Object.getPrototypeOf(NM);
  const fresh = () => Object.assign(Object.create(C), { logs: [], cont: { out: null, err: null }, parlons: { ready: true }, emit() {}, snapshot: () => ({}), log() {}, proc: {}, polled: false, megammrBroken: false, cascadeBroken: false, fatalHint: "" });
  let nm = fresh(); nm.nodeLine("[peer] Your MEGAMMR is BROKEN"); nm.nodeLine("Your Cascade is BROKEN"); assert.equal(nm.megammrBroken || nm.cascadeBroken, false, "not the logger's own line: not believed");
  nm = fresh(); nm.nodeLine("Minima @ 23/11/2026 00:07:02 [22.6 MB] : java.lang.Exception: Your MEGAMMR is BROKEN (does not start 21 where tree ends 19).. please 'reset' your node."); assert.equal(nm.megammrBroken, true);
  assert.ok(/bootTs: this\.startedTs \|\| 0,/.test(fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8")), "the start it was said for, kept after the node halts");
});
