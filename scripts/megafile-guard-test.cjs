// Second review of Resync from a MegaMMR file (0.19.391+): while an import, a restore, a MegaMMR switch or a resync runs, nothing else
// stops, restarts or resets the node or changes how it starts; Quit asks first. main.js is read with the TypeScript parser and its own
// functions are run over stand-ins (as scripts/inflight-test.cjs does).
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ts = require("typescript");

/** main.js's ipcMain handlers by name, and its top-level declarations (functions and consts) by name, as source text. */
function mainParts() {
  const src = read("main/main.js"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), calls = {}, decl = {};
  const walk = (n) => { if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0])) calls[n.arguments[0].text] = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) decl[st.name.text] = st.getText(sf);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decl[d.name.text] = st.getText(sf);
  }
  return { src, calls, decl };
}

test("M1: while an import or a resync runs, Stop, Restart, Start, the node kind, Startup Params, the Terminal's stopping commands are refused with the plain reason", async () => {
  const { calls, decl } = mainParts(), MF = require("../main/megammrfile.js");
  for (const n of ["mayStop", "guardStop", "nodeBusy", "notBusy", "NODE_START_KEYS", "saveConfigPatch"]) assert.ok(decl[n], "main.js declares " + n);
  const run = (env) => new Function("env", "with (env) { " + ["mayStop", "guardStop", "nodeBusy", "notBusy", "NODE_START_KEYS", "saveConfigPatch"].map(n => decl[n]).join("\n") +
    "\n return { mayStop, guardStop, saveConfigPatch }; }")(env);
  for (const [busy, resyncing] of [[true, false], [false, true], [false, false]]) {
    const did = [];
    const env = { megafile: { busy: () => busy }, node: { resyncing }, require: (m) => (m === "./megammrfile" ? MF : require(m)), stopGuard: { pass: async () => { did.push("asked"); return true; } },
      config: { save: (p) => { did.push("save " + Object.keys(p).join(",")); return {}; } }, nativeTheme: {}, reserveMode: () => {}, loginitem: {}, app: {}, firstRunOpen: null };
    const f = run(env), refused = busy || resyncing;
    if (refused) {
      await assert.rejects(f.mayStop("ACK", "restart"), { message: MF.BUSY }, "mayStop");
      assert.throws(() => f.saveConfigPatch({ params: { megammr: false } }), { message: MF.BUSY }, "Startup Params");
      assert.throws(() => f.saveConfigPatch({ heapMb: 4096 }), { message: MF.BUSY });
      f.saveConfigPatch({ megammrHost: "h:9001" }); f.saveConfigPatch({ labels: {} });   // nothing about how the node starts: saved
      assert.deepEqual(did, ["save megammrHost", "save labels"], "the guard was never asked, nothing of the node's start saved");
      await f.guardStop(); assert.equal(did.at(-1), "asked", "the flow's own stops (inside its exclusive) ask the stop guard alone");
    } else { await f.mayStop("ACK", "restart"); f.saveConfigPatch({ params: { megammr: true } }); assert.deepEqual(did, ["asked", "save params"]); }
  }
  // every handler that stops, restarts or (re)starts the node goes through mayStop or notBusy; only the flow's own two use guardStop
  for (const n of ["mcd:nodeRestart", "mcd:nodeStop", "mcd:nodeReclaim", "mcd:setNodeKind", "mcd:chatApplyBackup"]) assert.ok(/await mayStop\(/.test(calls[n]) && !/guardStop/.test(calls[n]), n);
  assert.ok(/notBusy\(\); await node\.start\(\)/.test(calls["mcd:nodeStart"]), "Start");
  assert.ok(calls["mcd:cmd"].includes("if (restore.isResync(command)) { await mayStop();") && calls["mcd:cmd"].includes("if (stops) await mayStop();"), "the Terminal's resync, reset, quit and import");
  assert.ok(/run: async \(c\) => \{ await guardStop\(\); return held\(\(\) => runResync\(c\)\); \}/.test(calls["mcd:restoreBackup"]), "the restore inside its own exclusive");
  assert.ok(/mayStop: \(\) => guardStop\(\)/.test(decl.megafile), "the import inside its own exclusive");
  assert.ok(/label: lang\.t\("Restart node"\), click: \(\) => \{ mayStop\(\)/.test(read("main/main.js")), "the tray's Restart node");
});

test("M1: Quit during an import asks first, Stay open the default; a quit the system asked for is not held", () => {
  const { src } = mainParts();
  const q = src.slice(src.indexOf('app.on("before-quit"'));
  const order = ['quitAsking = true;', 'if (megafile.busyWhat() === "import" && !systemQuit.on())', 'buttons: [lang.t("Quit anyway"), lang.t("Stay open")], defaultId: 1, cancelId: 1',
    'message: lang.t("A MegaMMR import is running"), detail: lang.t(IMPORT_QUIT_WARNING)', 'if (r.response !== 0 && !systemQuit.on()) { quitAsking = false; return; }', "inflight.decideQuit(", "await node.stop()"].map(x => q.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "asked before anything is stopped: " + order);
  assert.ok(/IMPORT_QUIT_WARNING = N_\("Quitting now leaves the chain half-replaced\. Your funds are safe, but the balance will be incomplete until Resync node \(Backup & Recovery\) has run\."\)/.test(src));
});

test("M1: the import says it is running in the node's status, and the window disables Stop, Restart, Startup Params and Backup & Recovery's node rows meanwhile", async () => {
  const MF = require("../main/megammrfile.js"), seen = [];
  const node = { resyncing: false, emit: (ev, s) => seen.push(ev + ":" + s.megafileBusy), snapshot() { return { megafileBusy: this.megafileBusy || "" }; } };
  const mf = MF.create({ node });
  let inside; await mf.exclusive("import", async () => { inside = [mf.busyWhat(), node.megafileBusy]; });
  assert.deepEqual(inside, ["import", "import"]); assert.deepEqual(seen, ["status:import", "status:"]); assert.equal(mf.busyWhat(), "");
  const nm = read("main/node-manager.js"); assert.ok(/resyncing: !!this\.resyncing, megafileBusy: this\.megafileBusy \|\| "",/.test(nm), "in the snapshot");
  const app = read("renderer/app.js");
  assert.ok(/const nodeBusyNow = \(\) => !!\(LAST_STATUS && \(LAST_STATUS\.resyncing \|\| LAST_STATUS\.megafileBusy\)\);/.test(app));
  for (const id of ["nRestart", "nReclaim", "nMegaOff", "nContrib", "pSave", "pSaveRestart"]) assert.ok(new RegExp('id="' + id + '"\\$\\{busyAttr\\(\\)\\}').test(app), id + " disabled while busy");
  assert.ok(/data-bk="\$\{r\[0\]\}"\$\{nodeBusyNow\(\) && !\/\^\(chat\|mail\|create\)\$\/\.test\(r\[0\]\) \? busyAttr\(\)/.test(app), "Backup & Recovery: Restore, Resync, the import, Rebuild, Turn MegaMMR off");
  assert.ok(/if \(wasBusy !== nodeBusyNow\(\) && activeView === "backup" && BK_PAGE === ""\) renderBackup\(\);/.test(app), "the rows follow it");
});
