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
    if (c === "balance") return { status: true, response: (imported && o.walletAfter) || o.wallet || [{ tokenid: "0x00", confirmed: "1234", coins: "2" }] };
    if (!m) return { status: true, response: { block: String(now.tip), hash: ids(now.tip, now.tag), timemilli: String(now.at || Date.now()) } };
    return Number(m[1]) <= now.tip ? { status: true, response: { txpowid: ids(Number(m[1]), now.tag) } } : { status: false, error: "TxPoW not found @ height " + m[1] }; };
  const node = { state: o.state || "running", proc: {}, resyncing: !!o.resyncing, megammrBroken: false, heapMbNow: o.heapMbNow == null ? 7168 : o.heapMbNow, kind: () => o.kind || "parlons", dataDir: () => DIR,
    restart: async () => { did.push("restart with megammr:" + params.megammr); node.proc = {}; say(o.restartLines); node.state = o.downAfter && did.filter(x => x.startsWith("restart")).length === o.downAfter ? "error" : "running"; }, snapshot: () => ({ state: node.state }),
    start: async () => { did.push("start"); node.proc = {}; node.state = "running"; },
    on: (ev, f) => { if (ev === "line") listeners.push(f); }, removeListener: (ev, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); } };
  // the node's log: what each command prints, with MinimaLogger's prefix (main/megammrfile.js reads only those lines)
  const say = (lines) => { for (const l of lines || []) for (const f of listeners.slice()) f(/^\[raw\]/.test(l) ? l.slice(5) : "Minima @ 23/11/2026 00:04:04 [30.9 MB] : " + l); };
  const imports = picker([mega]);
  const d = { node, imports, fs: Object.assign({}, fs, { statfsSync: () => ({ bavail: 100 * G, bsize: 1 }) }), totalmem: () => o.ram || 16 * G, platform: "darwin", log: () => {}, sleep: async () => {}, upMs: 5,
    config: { load: () => ({ heapMb: o.heapMb || 0, params: Object.assign({}, params), megammrImport: cfg.megammrImport ? JSON.parse(JSON.stringify(cfg.megammrImport)) : undefined }), save: (p) => { did.push("save " + JSON.stringify(p.params)); Object.assign(params, p.params); },
      setMegammrImport: (v) => { if (o.badMarker) throw new Error("EACCES"); did.push("marker " + (v ? v.stage : "cleared")); cfg.megammrImport = v || null; } },
    status: async () => { const m = answers.length > 1 ? answers.shift() : answers[0]; did.push("status " + m); if (m === null) throw new Error("ECONNREFUSED"); return { status: true, response: { megammr: m } }; },
    call: async (c) => { if (/^(block|balance|txpow block:\d+)$/.test(c)) return chain(c); did.push(c.replace(mega, "F")); say(o.checkLines); return o.check ? o.check(c, { node, say }) : { status: true, response: {} }; },
    mayStop: async () => { did.push("guard"); if (o.refuse) throw new Error("The node keeps running: nothing was stopped."); }, held: (op) => op(),
    runResync: async (c) => { did.push(c.replace(mega, "F")); imported = true; if (o.swap) o.swap(mega); say(o.importLines); return o.import ? o.import(c, { node, say, cfg }) : { status: true }; },
    work: async () => (typeof o.work === "function" ? o.work(mf) : o.work || []), holdEngines: async () => { did.push("hold"); if (o.onHold) await o.onHold(mf); }, releaseEngines: async () => { did.push("release"); if (o.onRelease) o.onRelease(mf); } };
  if (o.mayStop) d.mayStop = () => o.mayStop(did, mf);
  if (o.emit) { node.emit = () => o.emit(node); d.showMs = 0; }
  if (o.offerMs) d.offerMs = o.offerMs;
  if (o.sleep) d.sleep = (ms) => o.sleep(ms, { node, say, did }); if (o.stallMs) d.stallMs = o.stallMs; if (o.stuckMs) d.stuckMs = o.stuckMs;
  const mf = MF.create(d);
  await imports.pick("megammr");
  let r; try { r = await (o.off ? mf.megammrOff() : mf.importMegammr(mega)); } catch (e) { r = e.message; }
  for (let i = 0; i < 30; i++) await new Promise(res => setImmediate(res));   // the check after the import (verify) runs by itself
  return { did, r, params, mf, MF, cfg, node, file: mega };
}

test("Resync from a MegaMMR file: engines held for the whole import; only {megammr:true} saved, always, before any restart; the node's own reader checks the whole file before anything is reset", async () => {
  let w = await flowWorld({});
  assert.deepEqual(w.did, ["status false", "guard", "hold", 'save {"megammr":true}', "marker switching", "restart with megammr:true", "status true", "guard",
    'megammr action:integrity file:"F"', "marker importing", 'megammr action:import file:"F"', "marker catchup", "marker cleared", "release"]);   // the marker, right before the import (0.19.392)
  assert.deepEqual(w.r, { status: true, broken: false, on: true }); assert.equal(w.params.megammr, true);
  // already a MegaMMR node: no switch, but the setting is still saved before the import (its restart must keep the MegaMMR)
  w = await flowWorld({ megammr: [true], was: false });
  assert.deepEqual(w.did, ["status true", "guard", "hold", 'save {"megammr":true}', 'megammr action:integrity file:"F"', "marker importing", 'megammr action:import file:"F"', "marker catchup", "marker cleared", "release"]);
  // ...whose memory setting was changed since it started: restarted first, so the room counted is the room it has
  w = await flowWorld({ megammr: [true, true], heapMb: 8192, heapMbNow: 3072 });
  assert.deepEqual(w.did.slice(0, 6), ["status true", "guard", "hold", 'save {"megammr":true}', "restart with megammr:true", "status true"]);
});

test("Resync from a MegaMMR file: every failure ends with the node restarted and the setting as it was; an unknown status is never read as off", async () => {
  // the node refuses the file (truncated, or its blocks do not follow its MegaMMR): nothing reset; a node this flow turned on goes back
  let w = await flowWorld({ check: () => ({ status: false, error: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }) });
  assert.deepEqual(w.did.slice(-5), ['megammr action:integrity file:"F"', 'save {"megammr":false}', "restart with megammr:false", "marker cleared", "release"], "the switching marker goes once MegaMMR is back off");
  assert.equal(w.r, F.say(w.MF.CHECK_FAILED_BACK, { why: "Invalid block number.. not incremental.. last_in_mega:78 new_block:73" }));
  assert.ok(!w.did.some(x => /action:import/.test(x)), "never imported");
  w = await flowWorld({ megammr: [true], check: () => ({ status: false, error: "java.lang.NullPointerException" }) });
  assert.deepEqual(w.did.slice(-2), ['megammr action:integrity file:"F"', "release"], "a MegaMMR node that refused a file is left as it was");
  // the import fails part-way (after the node reset its chain: it printed "Streaming IBD.."): restarted at once, light again when this flow
  // turned MegaMMR on; the marker stays and the engines stay held (0.19.392)
  const RESET = ["MegaMMR import pre-flight.. file:22.4 KB heapfree:6.0 GB heapmax:6.0 GB", "Loading MegaMMR portion.. (file 22.4 KB)", "MegaMMR loaded.. coins:4", "Streaming IBD.. blocks:34 (with cascade)"];
  w = await flowWorld({ importLines: RESET, import: () => ({ status: false, error: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }) });
  assert.deepEqual(w.did.slice(-6), ['megammr action:import file:"F"', "marker importing", 'save {"megammr":false}', "restart with megammr:false", "marker cleared", "release"], "verify first: the same balance after the restart owes nothing (0.19.397)");
  assert.equal(w.r, F.say(w.MF.FAILED_BACK, { why: "MegaMMR import failed : java.io.EOFException .. RESTART Minima before retrying" }));
  w = await flowWorld({ megammr: [true], importLines: RESET, import: (c, n) => { n.node.proc = null; throw new Error("socket hang up"); } });
  assert.deepEqual(w.did.slice(-5), ['megammr action:import file:"F"', "marker importing", "restart with megammr:true", "marker cleared", "release"], "no answer, the node gone: restarted too");
  assert.equal(w.r, F.say(w.MF.FAILED, { why: "socket hang up" }));
  // the status cannot be read: nothing at all is done; after the switch, the setting goes back to what it WAS (here: never set), not to false
  w = await flowWorld({ megammr: [null] }); assert.equal(w.r, w.MF.STATUS_UNKNOWN); assert.deepEqual(w.did, ["status null"]);
  w = await flowWorld({ megammr: [false, null] });
  assert.deepEqual(w.did.slice(3), ['save {"megammr":true}', "marker switching", "restart with megammr:true", "status null", 'save {"megammr":false}', "restart with megammr:false", "marker cleared", "release"]);
  w = await flowWorld({ megammr: [false, null], was: undefined }); assert.ok(w.did.includes("save {}"), "the previous value (none) put back: " + w.did); assert.equal(w.r, F.ON_FAILED);
  w = await flowWorld({ megammr: [false, false] }); assert.deepEqual(w.did.slice(-4), ["status false", 'save {"megammr":false}', "marker cleared", "release"], "came back light: put back, no second restart");
});

test("Resync from a MegaMMR file: refused, before anything changes, while work is open, while another resync or import runs, or without room; the file is checked again right before the import", async () => {
  let w = await flowWorld({ work: ["1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0xabc"] });
  assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: "1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0xabc" })); assert.deepEqual(w.did, ["status false"], "read while the engines run, and refused before anything is held or asked (0.19.417)");
  w = await flowWorld({ resyncing: true }); assert.equal(w.r, w.MF.BUSY); assert.deepEqual(w.did, []);
  w = await flowWorld({ refuse: true }); assert.equal(w.r, "The node keeps running: nothing was stopped."); assert.deepEqual(w.did, ["status false", "guard"], "the guard is asked before the hold: a no holds nothing (0.19.417)");
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
  assert.equal(F.megammrHeapMb(0), 7168); assert.equal(F.megammrHeapMb("6144"), 6144);
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
  assert.ok(/if \(BK_PAGE && !running && BK_PAGE !== "megaoff" && !\(BK_PAGE === "megafile" && importing\)\)/.test(app) && /running \|\| r\[0\] === "megaoff" \|\| \(r\[0\] === "megafile" && importing\) \? "" : " disabled"/.test(app), "Backup & Recovery's Turn MegaMMR off works with the node stopped");
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
  // after it ("MegaMMR loaded..", 0.19.397): VERIFY FIRST. The balance differs after the restart: the marker stays, nothing released, the banner
  // says so with both exits; the same balance: cleared silently (above)
  w = await flowWorld({ importLines: RESET_LINES, walletAfter: [{ tokenid: "0x00", confirmed: "34", coins: "1" }], import: () => ({ status: false, error: "MegaMMR IBD batch was not fully accepted" }) });
  assert.equal(w.cfg.megammrImport.stage, "importing"); assert.deepEqual(w.cfg.megammrImport.before, [["0x00", "1234", "2"]], "the wallet as it was, recorded before the import");
  assert.ok(!w.did.includes("release"), w.did.join(" | ")); assert.match(w.r, /use Resync node/);
  assert.deepEqual(w.node.megafileBanner, { kind: "incomplete", less: true, before: [["0x00", "1234", "2"]], now: [["0x00", "34", "1"]] });
  await w.mf.keep(); assert.equal(w.cfg.megammrImport, null); assert.equal(w.did.at(-1), "release", "My balance is correct: cleared, released");
  // a quit or a crash in the middle: the marker written before the import is all that is left
  let seen; w = await flowWorld({ importLines: RESET_LINES, import: (c, x) => { seen = JSON.parse(JSON.stringify(x.cfg.megammrImport)); return { status: true }; } });
  assert.equal(seen && seen.stage, "importing", "already written while the node imports");
  // a success the node itself calls broken (its boot said "Your MEGAMMR is BROKEN") goes back to verify first: released only on the same balance
  w = await flowWorld({ walletAfter: [{ tokenid: "0x00", confirmed: "0", coins: "0" }], import: (c, n) => { n.node.megammrBroken = true; return { status: true }; } });
  assert.deepEqual(w.r, { status: true, broken: true, on: true }); assert.equal(w.cfg.megammrImport.stage, "importing"); assert.ok(!w.did.includes("release"));
  // only the logger's own lines count: a line that merely contains the words does not make a failure "after the reset"
  w = await flowWorld({ importLines: ["[raw]peer says Streaming IBD.. blocks:1", "[raw]Minima @ x : Streaming IBD.. blocks:1"], import: () => ({ status: false, error: "x" }) });
  assert.equal(w.cfg.megammrImport, null, "not anchored to the logger's prefix: not believed");
});

test("M2: a Resync node that ended well clears the marker and releases the engines; without one it does nothing", async () => {
  const MF = require("../main/megammrfile.js"), did = [], cfg = { megammrImport: { stage: "failed" } }, nd = {};
  const mf = MF.create({ node: nd, log: () => {}, releaseEngines: async () => did.push("release"), config: { load: () => ({ megammrImport: cfg.megammrImport }), setMegammrImport: (v) => { did.push("marker " + v); cfg.megammrImport = v; } } });
  await mf.resynced(); assert.deepEqual(did, ["marker null", "release"]); await mf.resynced(); assert.deepEqual(did, ["marker null", "release"], "once");
  // M3 (third review): a seed or backup restore that still holds the engines releases them itself, once it has settled
  cfg.megammrImport = { stage: "importing" }; nd.walletCheck = { held: true }; await mf.resynced(); assert.deepEqual(did.slice(-1), ["marker null"], "cleared, not released under a restore");
  cfg.megammrImport = { stage: "catchup" }; nd.walletCheck = null; nd.replacingWallet = true; await mf.keep(); assert.deepEqual(did.slice(-1), ["marker null"]);
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(main.includes("const r = await node.runResync(c); if (r && r.status === true && restore.isResync(c)) await megafile.resynced(); return r; };"), "every Resync node, from any screen or the Terminal");
  assert.ok(/node\.onEnginesRelease = \(\) => \{ if \(freeze\.isFrozen\("dexicon"\) \|\| megafile\.holdsEngines\(\) \|\| \(node\.walletCheck && node\.walletCheck\.held\)\) return;/.test(main), "no release of the engines while the marker is set, whoever asks");
  const boot = main.slice(main.indexOf("app.whenReady().then(() => {"));
  const at = boot.indexOf('if (require("./megammrfile").holds(c.megammrImport)) {');
  assert.ok(at > 0 && boot.indexOf("node.onEnginesHold()") > at && boot.indexOf("node.onEnginesHold()") < boot.indexOf("if (c.setupDone && c.walletDone) node.start();"), "held at launch, before the node starts");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "main", "config.js"), "utf8");
  assert.ok(!/^\s*megammrImport:/m.test(cfgSrc.slice(cfgSrc.indexOf("const DEFAULTS"), cfgSrc.indexOf("function load()"))) && /function setMegammrImport\(v\)/.test(cfgSrc), "never from the window's patch (save() drops a key DEFAULTS does not name)");
  const nm = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/this\.emit\("line", scrub\(l, this\.secret\)\);[^\n]*\n\s*this\.log\(l\);\n\s*\}/.test(nm) && /megammrImport: \(\(m\) => \(m && typeof m === "object" && String\(m\.stage \|\| ""\)\) \|\| \(m \? "importing" : ""\)\)\(config\.load\(\)\.megammrImport\), megafileBanner: this\.megafileBanner \|\| null,/.test(nm), "the node's fresh lines and the marker's stage in its status");
  // the window: the banner on every screen, its one press, never by itself
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8"), html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  assert.ok(/id="megaBar" role="alert" hidden><span id="megaBarText"><\/span><span class="megabar__btns" id="megaBarBtns"><\/span><\/div>/.test(html));
  assert.ok(/show = !!b && !s\.megafileBusy && !s\.resyncing && !!CFG\.walletDone;/.test(app), "the banner comes from main's verify (the node's status), never while the import or a resync runs");
  assert.ok(/x\.onclick = async \(\) => \{ x\.disabled = true; try \{ await fn\(\); \}/.test(app) && (app.match(/megaResyncNow\(\)/g) || []).length <= 3, "pressed, never run by itself");
  assert.ok(/const built = resyncCommand\(\{ host: CFG\.megammrHost \}\);[\s\S]{0,400}await cmd\(built\.cmd\)/.test(app), "Resync node, built where every resync is built, through mcd:cmd");
});

test("M3: no answer from a node that is still importing is not an end: it is followed from its log, never restarted, and finishes", async () => {
  // the RPC's bound ends; the node goes on, prints its steps, saves and exits by itself; the flow then starts it again
  const steps = ["IBD blocks processed.. 2560/5120", "IBD blocks processed.. 5120/5120", "System memory clean..", "Transfer your CoinProofs.. 2", "All saved..", "Main Instance Cleared.."];
  let w = await flowWorld({ importLines: RESET_LINES, import: () => { throw new Error("RPC timeout. The node did not answer, and it may still be resyncing"); },
    sleep: async (ms, x) => { if (steps.length) x.say([steps.shift()]); else if (x.node.proc) { x.did.push("node exits by itself"); x.node.proc = null; x.node.state = "error"; } } });
  assert.deepEqual(w.r, { status: true, broken: false, on: true }, String(w.r));
  assert.deepEqual(w.did.slice(-6), ['megammr action:import file:"F"', "marker catchup", "node exits by itself", "start", "marker cleared", "release"], "no restart while it worked; catchup as soon as the node printed All saved..");
  // no new step for longer than the stall bound: given up (after the reset: the marker stays, the node is restarted)
  w = await flowWorld({ importLines: RESET_LINES, stallMs: 30, import: () => { throw new Error("RPC timeout"); }, sleep: () => new Promise(r => setTimeout(r, 5)) });
  assert.match(w.r, /the node showed no progress for 0 minutes/); assert.ok(w.did.includes("marker importing")); assert.ok(w.did.includes("restart with megammr:false"));
  // the node exits without finishing: not an answer either way, but the end
  w = await flowWorld({ importLines: RESET_LINES, import: () => { throw new Error("RPC timeout"); }, sleep: async (ms, x) => { x.node.proc = null; } });
  assert.match(w.r, /the node stopped before it finished/); assert.ok(w.did.includes("marker importing")); assert.equal(w.cfg.megammrImport, null, "the same balance afterwards: nothing owed");
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

// ---- third review (0.19.397): no refusal by the file's tip, no permanent verdict; only a different block id at a recorded height stops ----
test("an old file is warned of, never refused; a node that is behind or stuck may import a newer file", async () => {
  const MF = require("../main/megammrfile.js"), at = (chaintip, cascadetip) => () => ({ status: true, response: { cascadetip: String(cascadetip), chaintip: String(chaintip), weight: "1" } });
  for (const [top, casc, tip] of [[1500, 1400, 1000], [1050, 1000, 1000], [100, 50, 60000]]) {
    const w = await flowWorld({ before: { tip }, check: at(top, casc) }); assert.deepEqual(w.r, { status: true, broken: false, on: true }, top + " vs " + tip + ": " + w.r);
  }
  assert.equal(MF.BEHIND, 51840); assert.ok(!("AHEAD" in MF) && !("AHEAD_WHY" in MF) && !("STUCK_MS" in MF), "the refusals and the stuck rule are gone");
  // the warning: the file's MegaMMR (its header) ends more than 30 days of blocks behind this node's tip
  const w = await flowWorld({ megammr: [true], before: { tip: 60000 }, off: true });   // the file stays chosen; the header of megaFile() ends at block 78
  const age = await w.mf.fileAge(w.file).catch(e => e.message);
  assert.deepEqual(age, { fileTip: "78", nodeTip: "60000", old: true });
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/let age = null; try \{ age = await api\.megammrFileAge\(f\); \}/.test(app) && /\{ f: f \}\) \+ old, t\("Import"\)\); \};/.test(app), "said in the import's question");
  // this node's tip cannot be read: nothing decided on an unknown
  const u = await flowWorld({ chain: (c) => (c === "block" ? { status: false, error: "x" } : null) });
  assert.equal(u.r, MF.STATUS_UNKNOWN); assert.ok(!u.did.some(x => /action:(integrity|import)/.test(x)));
});

test("after the import: released only when a recorded block matches AND the tip is fresh (0.19.400); never a verdict by time; a different id at a recorded height is said as a fork, with Keep", async () => {
  const MF = require("../main/megammrfile.js");
  // an older file (the normal case): the node catches up; while its tip is old the banner says "catching up: block X", no verdict, no release
  const after = { tip: 950, tag: "AA", at: Date.now() - 3 * 3600 * 1000 };
  let w = await flowWorld({ after });
  assert.equal(w.cfg.megammrImport.stage, "catchup"); assert.deepEqual(w.cfg.megammrImport.anchors.map(a => a.block), [700, 997, 1000]);
  assert.deepEqual(w.node.megafileBanner, { kind: "catchup", block: 950, target: 700, offer: false, stalled: false }); assert.ok(!w.did.includes("release"));
  w.cfg.megammrImport.since = Date.now() - MF.OFFER_MS - 1; await w.mf.verify(); assert.equal(w.node.megafileBanner.offer, true, "Keep is offered after 10 minutes");
  Object.assign(after, { tip: 1012, at: Date.now() }); await w.mf.verify();
  assert.equal(w.cfg.megammrImport, null); assert.equal(w.did.at(-1), "release");
  // fresh, but none of the recorded blocks compared (0.19.400: freshness alone never releases): held, catching up, no verdict
  w = await flowWorld({ before: { tip: 1000 }, chain: (c, imported) => (imported && /^txpow block:/.test(c) ? { status: false, error: "TxPoW not found" } : null) });
  assert.equal(w.cfg.megammrImport.stage, "catchup"); assert.ok(!w.did.includes("release"));
  // a file from another chain ending at a FRESH block below the recorded heights (what the real node showed with G2's file): held
  w = await flowWorld({ after: { tip: 650, tag: "BB", at: Date.now() } });
  assert.equal(w.cfg.megammrImport.stage, "catchup"); assert.ok(!w.did.includes("release"), "never released on freshness alone");
  // stuck (the orphaned-last-block case): no growth for OFFER_MS: the plain line and Resync node, Keep; still no verdict, still held
  const stuck = { tip: 960, tag: "AA", at: Date.now() - 3600 * 1000 };
  w = await flowWorld({ after: stuck, offerMs: 20 });
  assert.equal(w.node.megafileBanner.stalled, false); await new Promise(r => setTimeout(r, 30)); await w.mf.verify();
  assert.deepEqual(w.node.megafileBanner, { kind: "catchup", block: 960, target: 700, offer: true, stalled: true }); assert.equal(w.cfg.megammrImport.stage, "catchup");
  stuck.tip = 961; await w.mf.verify(); assert.equal(w.node.megafileBanner.stalled, false, "the block number grew: the line goes");
  // a recorded height holds ANOTHER block: "mismatch", said as exactly that, nothing released; Keep releases
  w = await flowWorld({ after: { tip: 1040, tag: "BB", at: Date.now() } });
  const m = w.cfg.megammrImport; assert.equal(m.stage, "mismatch"); assert.equal(m.block, 700); assert.ok(!w.did.includes("release"));
  assert.deepEqual(w.node.megafileBanner, { kind: "mismatch", block: 700, before: m.was, after: m.now }); assert.notEqual(m.was, m.now);
  await w.mf.verify(); assert.equal(w.cfg.megammrImport.stage, "mismatch", "asked again: no change, no new verdict");
  await w.mf.keep(); assert.equal(w.cfg.megammrImport, null); assert.equal(w.did.at(-1), "release");
  // a shorter chain that does not grow: no verdict at all, ever (the stuck rule is gone): it stays "catching up" with Keep offered
  w = await flowWorld({ after: { tip: 650, tag: "BB", at: Date.now() - 3600 * 1000 } });
  assert.equal(w.cfg.megammrImport.stage, "catchup"); assert.equal(w.node.megafileBanner.kind, "catchup");
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(app.includes('MEGA_MISMATCH = N_("Block {block} on this node before the import was {before}; after the import it is {after}. One of the two is a fork.")') && !/MEGA_FOREIGN|from a different chain:/.test(app), "never names the file as the wrong one");
  assert.ok(/k === "mismatch" \? \[\[t\("Keep the imported chain"\), megaKeepAsk\], \[t\("Turn MegaMMR off and resync"\), megaOffResync\]\]/.test(app), "two choices: no network call to the host (megammrsync speaks the P2P protocol; the app has no read path to it)");
  assert.ok(/k === "incomplete" \? \[\[t\("Resync node now"\), megaResyncAsk\], \[t\("My balance is correct: dismiss"\), megaDismiss\]\]/.test(app) && /k === "catchup" \? \[\.\.\.\(b\.offer \? \[\[t\("Keep the imported chain"\), megaKeepAsk\]\] : \[\]\), \.\.\.\(b\.stalled \? \[\[t\("Resync node now"\), megaResyncAsk\]\] : \[\]\)\]/.test(app));
  assert.ok(app.includes('MEGA_STALLED = N_("The node is not receiving new blocks. Resync node gets it moving again.")') && /\(b\.stalled \? " " \+ t\(MEGA_STALLED\) \+ " " \+ t\(MEGA_RESYNC_EMPTIES/.test(app), "said, with what Resync does to the MegaMMR");
  const ask = app.slice(app.indexOf("async function megaResyncAsk()"), app.indexOf("async function megaResyncNow()"));
  assert.ok(/if \(\(CFG\.params \|\| \{\}\)\.megammr\) \{ showActionSheet\(t\("Resync node"\), \[\{ label: t\("Turn MegaMMR off and resync"\), onclick: megaOffResync \}, \{ label: t\("Resync and keep MegaMMR mode \(empty until re-imported\)"\), onclick: megaResyncNow \}\], t\(MEGA_RESYNC_EMPTIES/.test(ask), "Resync says it empties the MegaMMR");
  const dis = app.slice(app.indexOf("async function megaDismiss()"), app.indexOf("async function megaKeepAsk()"));
  assert.ok(dis.indexOf('cmd("balance")') < dis.indexOf("showConfirm(") && dis.indexOf("showConfirm(") < dis.indexOf("await megaKeepNow()"), "the balance read again and shown before anything is cleared");
});

test("the marker: switching holds nothing and is offered Finish or Turn off; an odd marker is verify-first and clearable; writing it never fails an import", async () => {
  const MF = require("../main/megammrfile.js");
  assert.equal(MF.holds(null), false); assert.equal(MF.holds({ stage: "switching" }), false);
  for (const m of [{ stage: "importing" }, { stage: "failed" }, { stage: "" }, "yes", 1, { stage: "foreign" }]) assert.equal(MF.holds(m), true, JSON.stringify(m));
  // a crash after the switch to MegaMMR mode, before the import: the next launch offers Finish or Turn off
  let w = await flowWorld({ marker: { stage: "switching" }, megammr: [true], was: true, off: true });   // a stand-in world: verify on it directly
  const nd = { state: "running" }, cfg = { megammrImport: { stage: "switching" }, params: { megammr: true } }, did = [];
  const mf = MF.create({ node: nd, log: () => {}, releaseEngines: async () => did.push("release"), call: async () => ({ status: true, response: [] }),
    config: { load: () => ({ megammrImport: cfg.megammrImport, params: cfg.params }), setMegammrImport: (v) => { did.push("marker " + (v ? v.stage : "cleared")); cfg.megammrImport = v; } } });
  await mf.verify(); assert.deepEqual(nd.megafileBanner, { kind: "switching" }); assert.deepEqual(did, []);
  cfg.params.megammr = false; await mf.verify(); assert.deepEqual(did, ["marker cleared"], "MegaMMR is off again: nothing owed");
  // odd markers: verify first (no balance recorded: the banner, with its dismiss)
  for (const odd of ["x", { stage: "" }, { stage: "foreign" }, { at: 1 }]) { cfg.megammrImport = odd; nd.megafileBanner = null; await mf.verify(); assert.equal(nd.megafileBanner && nd.megafileBanner.kind, "incomplete", JSON.stringify(odd)); }
  await mf.keep(); assert.equal(cfg.megammrImport, null);
  // a marker that cannot be written is said, and the import still reports what it did
  w = await flowWorld({ megammr: [true], badMarker: true }); assert.deepEqual(w.r, { status: true, broken: false, on: true });
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/: \[\[t\("Finish the import"\), \(\) => \{ BK_PAGE = "megafile"; selectTab\("backup"\); \}\], \[t\("Turn MegaMMR off"\), megammrOffNow\], \[t\("Keep MegaMMR on, empty"\), megaKeepEmptyAsk\]\];/.test(app));
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
  assert.equal(w.r, F.say(MF.OOM_SAID, { why: "socket hang up", heap: "7168" }), "the node's own line says it: the exit is said as memory");
  w = await flowWorld({ megammr: [true], import: () => ({ status: false, error: "MegaMMR import failed : java.lang.OutOfMemoryError: Java heap space .. RESTART Minima before retrying" }) });
  assert.match(w.r, /^The node ran out of memory reading this MegaMMR file .*Nothing was imported or reset\./); assert.equal(w.cfg.megammrImport, null);
  w = await flowWorld({ check: () => ({ status: false, error: "INVALID Coin proof! @ {\"coinid\":\"0x00\",\"amount\":\"1\"}" }) });
  assert.equal(w.r, F.say(MF.CHECK_FAILED_BACK, { why: "INVALID Coin proof!" }), "the reason, not the coin's JSON");
  assert.match(MF.FAILED, /Resync node also empties this node's MegaMMR \(megammrsync clears it\): import a MegaMMR file again afterwards to have it whole\.$/);
  assert.ok(!/empties/.test(MF.FAILED_BACK), "a node turned back light has no MegaMMR to empty");
});

test("MINOR: during the import and while it is unfinished, Mail, miniMall, Vestr, and Future Cash Next do not run; Freeze says it is the import", async () => {
  const freeze = require("../main/freeze.js"); let paused = true; const started = [];
  const f = freeze.create({ load: () => [], save() {}, paused: () => paused, engines: { mail: { start: () => started.push("mail") }, minimall: { start: () => started.push("minimall") }, vestr: { start: () => started.push("vestr") }, chat: { start: () => started.push("chat") } } });
  for (const id of ["mail", "minimall", "vestr", "chat"]) f.start(id);
  assert.deepEqual(started, ["chat"], "chat is not money; the others wait"); paused = false; for (const id of ["mail", "minimall", "vestr"]) f.start(id); assert.deepEqual(started, ["chat", "mail", "minimall", "vestr"]);
  const g = freeze.create({ load: () => [], save() {}, replacing: () => "import", engines: { dexicon: { gate() {}, stop() {}, start() {} } } });
  await assert.rejects(g.set("dexicon", true), { message: "A MegaMMR file import is running, and Dexicon's engines are stopped for it. Dexicon can be frozen once that has finished." });
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/const loopsPaused = \(\) => megafile\.busy\(\);/.test(main) && /function pauseLoops\(\) \{ mail\.stopLoop\(\); shop\.stopLoop\(\); vestr\.stopLoop\(\); futurecash\.stop\(\)\.catch\(\(\) => \{\}\); \}/.test(main));
  assert.ok(/holdEngines: \(\) => \{ pauseLoops\(\); return node\.onEnginesHold\(\); \}/.test(main) && /paused: \(\) => loopsPaused\(\),/.test(main));
  assert.ok(/if \(s\.state !== "running" \|\| loopsPaused\(\)\) \{ fcBlock = 0; fcStarter\.reset\(\); futurecash\.stop\(\)/.test(main), "Future Cash Next");
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

// ---- gate review of 0.19.401: MINORs and NITs (0.19.402) ----
test("0.19.402 M1: a verify (or keep) that awaited across a newly started import releases nothing; onEnginesRelease refuses while the import runs", async () => {
  const MF = require("../main/megammrfile.js"), did = [], cfg = { megammrImport: { stage: "importing", before: [["0x00", "5", "1"]] }, params: {} };
  let answer; const nd = { state: "running" };
  const mf = MF.create({ node: nd, log: () => {}, releaseEngines: async () => did.push("release"), call: () => new Promise(r => { answer = r; }),
    config: { load: () => ({ megammrImport: cfg.megammrImport, params: cfg.params }), setMegammrImport: (v) => { did.push("marker " + (v ? v.stage : "cleared")); cfg.megammrImport = v; } } });
  const v = mf.verify(); await new Promise(r => setImmediate(r));
  let release; const imp = mf.exclusive("import", () => new Promise(r => { release = r; }));   // a new import holds the engines meanwhile
  assert.equal(mf.holdsEngines(), true, "the running import holds them");
  answer({ status: true, response: [{ tokenid: "0x00", confirmed: "5", coins: "1" }] }); await v;   // the SAME balance: before, this released
  assert.deepEqual(did, [], "nothing cleared, nothing released under the running import");
  await assert.rejects(mf.keep(), { message: MF.BUSY }, "keep refused while it runs");
  release(); await imp;
  // the import's own release (refused for open work, inside its exclusive) passes its own guard
  const seen = []; let reads = 0; const w = await flowWorld({ work: () => (reads++ ? ["1 AtomiX swap still in flight"] : []), onRelease: (m) => seen.push(m.busyWhat() + ":" + m.holdsEngines()) });   // open work found after the hold (0.19.417)
  assert.deepEqual(seen, ["import:false"], w.r);
  cfg.megammrImport = null; await mf.exclusive("restore", async () => assert.equal(mf.holdsEngines(), false, "a restore's own settle releases them (node-manager walletSettle)"));
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/node\.onEnginesRelease = \(\) => \{ if \(freeze\.isFrozen\("dexicon"\) \|\| megafile\.holdsEngines\(\) \|\|/.test(main));
});

test("0.19.402 M2/M7: past every recorded height with none of them in the node's tree: said plainly, Keep at once; no answer is said as waiting", async () => {
  // the node was far behind the file: txpow block:N finds none of its old blocks (not in the tree or the archive)
  let w = await flowWorld({ after: { tip: 5000, tag: "BB", at: Date.now() - 3600 * 1000 }, chain: (c, imported) => (imported && /^txpow block:/.test(c) ? { status: false, error: "TxPoW not found" } : null) });
  assert.equal(w.cfg.megammrImport.stage, "catchup");
  assert.deepEqual(w.node.megafileBanner, { kind: "catchup", block: 5000, target: 700, offer: true, stalled: false, unseen: true });
  assert.ok(!w.did.includes("release")); await w.mf.keep(); assert.equal(w.did.at(-1), "release");
  // below the recorded heights: still "block X of at least Y", no claim
  w = await flowWorld({ after: { tip: 650, tag: "AA", at: Date.now() - 3600 * 1000 } }); assert.equal(w.node.megafileBanner.unseen, undefined);
  // the node does not answer the block read, or a recorded block's read: "waiting", never silent, nothing concluded
  let mute = false;
  w = await flowWorld({ after: { tip: 1012, tag: "AA", at: Date.now() - 3600 * 1000 }, chain: (c, imported) => { if (imported && mute && c === "block") throw new Error("ECONNREFUSED"); return null; } });
  mute = true; await w.mf.verify(); assert.deepEqual(w.node.megafileBanner, { kind: "waiting" }); assert.equal(w.cfg.megammrImport.stage, "catchup");
  mute = false;
  w = await flowWorld({ after: { tip: 1012, tag: "AA", at: Date.now() - 3600 * 1000 }, chain: (c, imported) => { if (imported && /^txpow block:/.test(c)) throw new Error("timeout"); return null; } });
  assert.deepEqual(w.node.megafileBanner, { kind: "waiting" });
  // an importing marker whose balance cannot be read
  const MF = require("../main/megammrfile.js"), nd = { state: "running" }, cfg = { megammrImport: { stage: "importing", before: [] } };
  const mf = MF.create({ node: nd, log: () => {}, releaseEngines: async () => {}, call: async () => { throw new Error("no answer"); }, config: { load: () => cfg, setMegammrImport: (v) => { cfg.megammrImport = v; } } });
  await mf.verify(); assert.deepEqual(nd.megafileBanner, { kind: "waiting" });
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(app.includes(`MEGA_UNSEEN = N_("None of this node's earlier blocks can be compared with the imported chain`) && /k === "catchup" && b\.unseen \? t\(MEGA_UNSEEN\)/.test(app));
  assert.ok(/k === "waiting" \? t\(MEGA_WAITING\) \+ " " \+ t\(MEGA_HELD\)/.test(app));
});

test("0.19.402 NITs: an old marker claims no 'less'; a refused check keeps an earlier switching marker; an unwritable clear still releases, with a warning", async () => {
  const MF = require("../main/megammrfile.js");
  for (const stage of ["failed", "foreign"]) {
    const nd = { state: "running" }, cfg = { megammrImport: { stage } };
    const mf = MF.create({ node: nd, log: () => {}, call: async () => ({ status: true, response: [{ tokenid: "0x00", confirmed: "1", coins: "1" }] }), config: { load: () => cfg, setMegammrImport() {} } });
    await mf.verify(); assert.equal(nd.megafileBanner.less, undefined, stage); assert.equal(nd.megafileBanner.unknown, true, stage);
  }
  // an earlier import left "switching" (MegaMMR on, empty); Finish the import, and the node refuses the file: the marker stays
  const w = await flowWorld({ marker: { stage: "switching", at: "x" }, megammr: [true], check: (c) => (/integrity/.test(c) ? { status: false, error: "INVALID" } : { status: true, response: {} }) });
  assert.ok(/refused it: INVALID/.test(w.r), w.r); assert.equal(w.cfg.megammrImport && w.cfg.megammrImport.stage, "switching", "MegaMMR is still on and empty");
  // a clear that cannot be written: released all the same, the marker reads as cleared for this run, and said
  const did = [], cfg = { megammrImport: { stage: "catchup", anchors: [] } }, nd = { state: "running" };
  const mf = MF.create({ node: nd, log: () => {}, releaseEngines: async () => did.push("release:" + mf.holdsEngines()), config: { load: () => cfg, setMegammrImport: () => { throw new Error("EACCES: permission denied"); } } });
  const r = await mf.keep();
  assert.deepEqual(did, ["release:false"], "main's onEnginesRelease finds nothing holding them"); assert.equal(mf.marker(), null);
  assert.equal(r.kept, true); assert.ok(r.warning.startsWith("Cleared for now, but the app's settings could not be saved (EACCES: permission denied)"), r.warning);
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/if \(r && r\.warning\) toast\(MainSaid\.say\(r\.warning\), "warn"\)/.test(app), "said in the window");
});

test("0.19.402 M3-M6: Quit's words at the final restart; the import's row stays open while it runs; the banner's node-free exits work stopped; switching gets a non-destructive dismiss; names beside full ids", () => {
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/IMPORT_QUIT_RESTART = N_\("The import has finished and the node is restarting\./.test(main) && /done = busyNow === "import" && m && m\.stage === "catchup"/.test(main));
  assert.ok(/const MEGA_NODELESS = \[megammrOffNow, megaKeepAsk, megaOffResync, megaDismiss, megaKeepEmptyAsk\];/.test(app) && /x\.disabled = s\.state !== "running" && !MEGA_NODELESS\.includes\(fn\);/.test(app));
  assert.ok(!/MEGA_NODELESS = [^\n]*megaResyncAsk/.test(app), "Resync node needs the node");
  const dis = app.slice(app.indexOf("async function megaDismiss()"), app.indexOf("async function megaKeepAsk()"));
  assert.ok(dis.indexOf('toast(t("Start the node to check the balance."), "err"); return;') > 0 && dis.indexOf("Start the node") < dis.indexOf('cmd("balance")'));
  assert.ok(/"\(" \+ String\(r\.tokenid\) \+ "\): "/.test(dis) && !/slice\(|shortId|substring\(/.test(dis), "the whole id, beside the name");
  assert.ok(/id="bkGo" data-label="\$\{th\("Import"\)\}"\$\{busyAttr\(\)\}/.test(app), "the import's own button waits while it runs");
  const nm = fs.readFileSync(path.join(ROOT, "main", "node-manager.js"), "utf8");
  assert.ok(/if \(this\.listenerCount\("line"\)\) this\.emit\("line", scrub\(l, this\.secret\)\);/.test(nm));
});

// ---- 0.19.417: the owner's import on 0.19.416 ALWAYS refused: "Dexicon has not finished starting, so its orders could not be checked" and
// "Future Cash Next has not started (or is frozen)", with both fully started. The flow held the engines, THEN asked them what was open, and a
// held engine does not answer: the stand-ins of 0.19.395-0.19.416 answered all the same. These answer as the real modules do. ----
/** The engines as main/dexicon.js, main/futurecash.js and main/atomix.js answer: running, whole. Dexicon held (and dropped): { ready:false,
 *  hasStore:true, waitedMs:0 } and what it had open when it stopped (last); Future Cash Next is stopped by the app as soon as an import runs
 *  (main.js loopsPaused, at the exclusive's first status), keeping what its store held; AtomiX held keeps its read models (main/atomix.js hold).
 *  work() and the stop guard read them the way main.js does (walletWork, inFlightWork: main/restore.js heldRead, main/inflight.js stopGuard). */
function engines(o = {}) {
  const inflight = require("../main/inflight.js"), heldRead = restore.heldRead || ((w) => w);   // 0.19.416 has none: an engine is read as it answers
  const e = { held: false, dx: { orders: [], pending: 0, takes: 0, unknown: 0 }, fc: { collects: [], queued: [], sweeps: [], posted: 0 }, ax: [], starting: !!o.starting, waitedMs: o.waitedMs || 0, skip: false, said: [] };
  const dexicon = async () => (e.starting ? { ready: false, hasStore: true, waitedMs: e.held ? 0 : e.waitedMs }
    : e.held ? Object.assign({ ready: false, hasStore: true, waitedMs: 0 }, e.dxLast ? { last: e.dxLast } : {}) : Object.assign({ ready: true }, e.dx));
  const futurecash = (mf) => { if (!mf.busy()) return Object.assign({ ready: true, hasStore: true }, e.fc); if (!e.fcLast) e.fcLast = Object.assign({}, e.fc); return { ready: false, hasStore: true, error: "", last: e.fcLast }; };
  e.read = async (mf) => ({ atomix: { ready: true, swaps: e.ax.slice(), maker: false, otcOffer: false, otcDeals: 0 }, pools: [], ownPools: [],
    dexicon: heldRead(await dexicon(), mf.holdsEngines()), futurecash: heldRead(futurecash(mf), mf.busy()) });
  e.work = async (mf) => restore.activeWorkList(Object.assign(await e.read(mf), { skipDexicon: e.skip })).filter(i => !String(i).endsWith(restore.CONFIRM_HINT));
  // main.js holdEngines: Dexicon drained, then dropped with what it had open; o.during: work that starts while the engines are being stopped
  e.hold = async () => { if (o.during) o.during(e); e.held = true; e.dxLast = e.starting ? null : Object.assign({}, e.dx); };
  // main.js mayStop (main/inflight.js stopGuard): anything in flight or not checkable is asked; o.yes: the user's answer
  e.guard = async (did, mf) => { const w = inflight.inFlight(await e.read(mf), "shutdown", Date.now()); if (!w.any) return did.push("guard");
    did.push("question"); e.said.push(w.busy.concat(w.unread).join(" | ")); if (!o.yes) throw new Error("The node keeps running: nothing was stopped."); };
  return e;
}
const engineWorld = (e, o = {}) => flowWorld(Object.assign({ work: (mf) => e.work(mf), onHold: () => e.hold(), mayStop: (did, mf) => e.guard(did, mf) }, o));
const OWNER_SAW = F.say(require("../main/megammrfile.js").IMPORT_OPEN, { items: ["Dexicon has not finished starting, so its orders could not be checked. Wait a moment and try again.",
  "Future Cash Next has not started (or is frozen), so its collects and sweeps could not be checked. Start the node, unfreeze it on the Apps tab, and try again."].join("\n• ") });

test("0.19.417 the owner's import: what is open is read while the engines run, the guard is asked, then they are held; nothing open imports, with no question", async () => {
  const e = engines(), w = await engineWorld(e);
  assert.notEqual(w.r, OWNER_SAW, "0.19.416 refused exactly so");
  assert.deepEqual(w.r, { status: true, broken: false, on: true }, String(w.r));
  // the guard after the flow's own restart into MegaMMR mode reads the engines as held: what they had open, never "has not started"
  assert.deepEqual(w.did.slice(0, 8), ["status false", "guard", "hold", 'save {"megammr":true}', "marker switching", "restart with megammr:true", "status true", "guard"], e.said.join(" || "));
  assert.ok(!w.did.includes("question"), e.said.join(" || "));
});

test("0.19.417 open work present: refused with the engines never held and the guard never asked", async () => {
  const e = engines(); e.ax.push("0x" + "AB".repeat(32)); e.dx.takes = 1;
  const w = await engineWorld(e);
  assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: ["1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0x" + "AB".repeat(32), "1 Dexicon trade sent and not yet answered. Wait for it to settle (a few minutes)."].join("\n• ") }));
  assert.deepEqual(w.did, ["status false"]); assert.equal(e.held, false);
  // a Future Cash Next collect posted before the import began: read from what its store held when the import stopped it
  const f = engines(); f.fc = { collects: ["0x" + "CC".repeat(32)], queued: [], sweeps: [], posted: 1 };
  const v = await engineWorld(f);
  assert.equal(v.r, F.say(v.MF.IMPORT_OPEN, { items: "1 Future Cash Next collect or sweep is still under way, which only this wallet's keys can finish: 0x" + "CC".repeat(32) }));
  assert.deepEqual(v.did, ["status false"]);
});

test("0.19.417 work that starts between the read and the hold: read again as held, refused, and the engines let go", async () => {
  for (const during of [(e) => { e.dx.takes = 1; }, (e) => { e.ax.push("0x" + "EF".repeat(32)); }]) {
    const e = engines({ during }), w = await engineWorld(e);
    const item = e.ax.length ? "1 AtomiX swap still in flight (the app holds what is needed to claim or refund it): 0x" + "EF".repeat(32) : "1 Dexicon trade sent and not yet answered. Wait for it to settle (a few minutes).";
    assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: item }), "only what is new, never \"has not started\" for what the flow itself stopped");
    assert.deepEqual(w.did, ["status false", "guard", "hold", "release"]); assert.ok(!w.did.some(x => /megammr action|save|restart/.test(x)));
  }
});

test("0.19.417 an engine that really has not started: wait at first, the skip after two minutes (Import without these checks?), then the import goes on", async () => {
  const MS = require("../renderer/mainsaid.js"), app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  let e = engines({ starting: true, waitedMs: 30000 }), w = await engineWorld(e);
  assert.equal(w.r, F.say(w.MF.IMPORT_OPEN, { items: "Dexicon has not finished starting, so its orders could not be checked. Wait a moment and try again." }));
  assert.deepEqual(w.did, ["status false"], "refused before anything is held"); assert.equal(MS.has(w.r, "REPLACE_SKIP_HINT"), false, "no way past it yet");
  e = engines({ starting: true, waitedMs: restore.DEX_STUCK_MS + 1000, yes: true }); w = await engineWorld(e);
  assert.ok(String(w.r).includes("Dexicon has not finished starting after 2 minutes, so its on-chain orders and its trades waiting for an answer cannot be checked. " + restore.DEX_SKIP_HINT), w.r);
  assert.equal(MS.has(w.r, "REPLACE_SKIP_HINT"), true, "the window offers the skip (renderer/app.js offerWithoutDexicon)");
  assert.ok(/if \(importing\) \{ if \(!await showConfirm\(t\("Import without these checks\?"\)/.test(app) && /try \{ await attempt\(\); \} catch \(e\) \{ if \(!await offerWithoutDexicon\(e, !!built\.importing\)\) throw e; await attempt\(\); \}/.test(app));
  // the user goes on (main.js mcd:dxSkipCheck: only checks that cannot be made are in the way): the same import again, the check left out
  assert.equal(restore.onlyDexiconUnchecked(await e.work({ busy: () => false, holdsEngines: () => false })), true);
  e.skip = true; w = await engineWorld(e);
  assert.deepEqual(w.r, { status: true, broken: false, on: true }, String(w.r));
  assert.ok(w.did.includes("hold") && w.did.includes('megammr action:import file:"F"'));
  assert.ok(e.said.every(s => /Exchange trades waiting for an answer \(Dexicon has not started\)/.test(s)), "the guard says only the engine that really has not started: " + e.said.join(" || "));
});

test("0.19.417 main reads an engine that its own flow stopped from what it had open (walletWork, the stop guard, Freeze)", () => {
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(main.includes("const dexWork = async () => restore.heldRead(await dexicon.activeWork(), megafile.holdsEngines());") && main.includes("const fcWork = () => restore.heldRead(futurecash.activeWork(), loopsPaused());"));
  assert.ok(main.includes("dexicon: await dexWork().catch(() => null), skipDexicon });") && main.includes("one(() => dexWork()), one(() => fcWork())]);") && main.includes("futurecashBlockers(await Promise.resolve().then(fcWork).catch(() => null))"));
  assert.equal(restore.heldRead({ ready: false, hasStore: true, waitedMs: 0 }, true).ready, false, "never ran (or not read whole): as before");
});
