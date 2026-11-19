// The core screens rebuilt to Pandamonium's in Phase 2c (0.18.85+): Startup Params, Backup & Recovery, first run,
// Settings. Functions are lifted out of renderer/app.js and RUN; nothing here talks to a node, and every word
// used as a seed below is an obvious fake.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const PARAMS = require("../renderer/params.js");

// a one-line definition, or a block that ends at the first "}" in column 0 (as scripts/wallet-money-test.cjs)
function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  const code = m[1].replace(/\s+\/\/.*$/, "");
  return /\{$/.test(code) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
function lift(names, env) {
  env = Object.assign({ MINIMA_PARAMS: PARAMS }, env || {});
  return new Function(...Object.keys(env), names.map(source).join("\n") + "; return { " + names.join(", ") + " };")(...Object.values(env));
}

test("Startup Params: a titled sub screen, opened from the menu and from the Node tab; the old wizard is not", () => {
  assert.ok(html.includes('id="view-params"'));
  assert.ok(/SUB_TITLE = \{[^}]*params: "Startup Params"/.test(app));
  assert.ok(app.includes('act === "params") selectTab("params")'));
  assert.ok(app.includes('el("nReconfig").onclick = () => selectTab("params")'));
  const body = source("renderParams");
  for (const words of ["Startup parameters", "Configure how the node starts. Changes take effect when the node restarts.", "Server mode (-server)",
    "MegaMMR (-megammr)", "Keets transport (-keets)", "Extra arguments (advanced)", ">Save<", "Save &amp; Restart Node", "Copy RPC password"])
    assert.ok(body.includes(words), "the phone's wording: " + words);
  assert.ok(!/Resync automatically/.test(body), "no auto-resync switch: the desktop has nothing behind it");
});

test("Startup Params saves node settings only: never a wallet field", () => {
  const { paramsPatch } = lift(["paramsPatch"]);
  const P = PARAMS.defaultParams();
  const r = paramsPatch({ net: "mainnet", server: true, basePort: "12001", rpcPort: "", dataFolder: "", customPeer: "", extraArgs: "-txpowdbstore 3", P }, { basePort: 9001 });
  assert.deepEqual(Object.keys(r.patch).sort(), ["basePort", "contribute", "customConnect", "dataFolder", "extraArgs", "network", "params", "rpcPortManual"]);
  assert.equal(r.patch.contribute, true);
  assert.equal(paramsPatch({ net: "solo", server: true, basePort: "x", rpcPort: "", P }, { basePort: 9001 }).patch.contribute, false, "a solo network never contributes");
  assert.equal(paramsPatch({ net: "solo", server: true, basePort: "x", rpcPort: "", P }, { basePort: 9001 }).patch.basePort, 9001);
  assert.ok(paramsPatch({ net: "custom", customPeer: "", P }, {}).error, "a custom network needs its peer");
});

test("Startup Params: the Server switch and the network preset fill the flags the wizard's did", () => {
  const { applyNetPreset } = lift(["applyNetPreset"]);
  const d = PARAMS.defaultParams();
  assert.deepEqual(applyNetPreset(Object.assign({}, d), "mainnet", false, "", ""), d, "mainnet and light wallet are the defaults");
  const c = applyNetPreset(Object.assign({}, d), "mainnet", true, "", "");
  assert.ok(c.server === true && c.isclient === false && c.mobile === false && c.nosyncibd === false, "contribute emits -server alone");
  const s = applyNetPreset(Object.assign({}, d), "solo", true, "", "");
  assert.ok(s.solo === true && s.isclient === false && s.server === false && s.p2pnodes === "");
  const x = applyNetPreset(Object.assign({}, d), "custom", false, "192.0.2.7:9001", "");
  assert.ok(x.connect === "192.0.2.7:9001" && x.p2pnodes === "");
});

test("the RPC password goes from the main process to the clipboard and is never handed to the page", () => {
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/"mcd:copyRpcPassword", \(\) => \{ clipboard\.writeText\(config\.rpcSecret\(\)\); return true; \}/.test(main));
  assert.ok(!/(return|=>)\s*config\.rpcSecret\(\)/.test(main), "no handler returns the secret");
});

// ---- Backup & Recovery (0.18.86) ----
test("Backup & Recovery: the phone's hub rows, in its order, with Mail backup after Chat backup", () => {
  assert.ok(html.includes('id="view-backup"') && /SUB_TITLE = \{[^}]*backup: "Backup & Recovery"/.test(app));
  const rows = [...source("renderBackup").matchAll(/\["([a-z]+)", "([^"]+)", "/g)].map(m => m[1] + "=" + m[2]);
  assert.deepEqual(rows, ["create=Create backup", "restore=Restore from file", "chat=Chat backup", "mail=Mail backup", "resync=Resync node", "keys=Private keys"]);
  assert.ok(!/setBackup|setResync|setReveal|setRestore|showRestoreOverlay/.test(app), "the Settings cards and the restore dialog are gone: one home for each operation");
});

test("megammrsync is built in one place and puts the bytes on the wire that 0.18.84 did", () => {
  const { resyncCommand } = lift(["resyncCommand"]);
  const H = "megammr.example:9001", FAKE = "not a real seed just test words";
  assert.equal(resyncCommand({ host: H }).cmd, "megammrsync action:resync host:" + H);
  assert.equal(resyncCommand({ host: H }).resetsWallet, false, "a plain resync does not touch the wallet");
  assert.equal(resyncCommand({ host: H, phrase: " " + FAKE + "\n", anyphrase: true, keyuses: "2000" }).cmd,
    `megammrsync action:resync host:${H} phrase:"${FAKE}" anyphrase:true keyuses:2000`, "the restore dialog's command; only the ends of the phrase are trimmed");
  assert.equal(resyncCommand({ host: H, phrase: FAKE, keyuses: 0 }).cmd, `megammrsync action:resync host:${H} phrase:"${FAKE}" keyuses:0`);
  assert.equal(resyncCommand({ host: H, phrase: "Not  A  Real   Seed", anyphrase: true, keyuses: "1" }).cmd.includes('"Not  A  Real   Seed"'), true, "spacing and case inside a phrase are never changed");
  assert.equal(resyncCommand({ host: H, file: "old.bak", password: "pw1" }).cmd, `megammrsync action:resync host:${H} file:old.bak password:pw1`);
  assert.ok(resyncCommand({ host: H, phrase: FAKE, keyuses: "1" }).resetsWallet && resyncCommand({ host: H, file: "a.bak" }).resetsWallet);
});

test("megammrsync refuses everything the old screens refused, before any command exists", () => {
  const { resyncCommand } = lift(["resyncCommand"]);
  const H = "megammr.example:9001", bad = (o, why) => { const r = resyncCommand(o); assert.ok(r.error && !r.cmd, why); };
  bad({ host: "megammr.example" }, "a host without a port");
  bad({ host: "h:9001 phrase:x" }, "a host carrying another parameter");
  bad({ host: H, phrase: 'fake "words"', keyuses: "1" }, "a quote in the phrase");
  bad({ host: H, phrase: "fake\\words", keyuses: "1" }, "a backslash in the phrase");
  bad({ host: H, phrase: "fake\nwords", keyuses: "1" }, "a line break inside the phrase");
  bad({ host: H, phrase: "fake words" }, "a phrase without key uses");
  bad({ host: H, phrase: "fake words", keyuses: "-1" }, "negative key uses");
  bad({ host: H, phrase: "fake words", keyuses: "12abc" }, "key uses that are not a number");
  bad({ host: H, keyuses: "x" }, "key uses that are not a number, without a phrase");
  bad({ host: H, file: "my file.bak" }, "a file path with a space");
  bad({ host: H, file: "a.bak", password: "p w" }, "a password with a space");
  bad({ host: H, file: "a.bak", password: 'p"w' }, "a password with a quote");
  bad({ host: H, needPhrase: true }, "Rebuild without a phrase");
  bad({ host: H, needFile: true }, "Restore without a file");
});

test("a backup password is letters and numbers, typed twice, before the backup command is built", () => {
  const { backupPasswordProblem } = lift(["backupPasswordProblem"]);
  assert.equal(backupPasswordProblem("abc123", "abc123"), "");
  for (const pw of ["", 'a"b', "a\\b", "a b", "a\nb", "pä55"]) assert.ok(backupPasswordProblem(pw, pw), JSON.stringify(pw) + " is refused");
  assert.ok(backupPasswordProblem("abc123", "abc124"), "the two entries must match");
  const body = source("renderBackup");
  assert.ok(body.indexOf("backupPasswordProblem(") < body.indexOf('cmd(`backup password:"${pw}"`)'), "checked first; the command string is the 0.18.84 one");
});

test("every megammrsync screen confirms first, and a replaced wallet drops the old identities", () => {
  const body = source("renderBackup");
  const run = body.slice(body.indexOf("const run = async"), body.indexOf("const hostField"));
  const order = ["built.error", "showConfirm(", "cmd(built.cmd)", "saveConfig({ megammrHost", "walletReplaced()"].map(x => run.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "refuse, confirm, run, remember the host, drop identities: in that order");
  assert.equal((body.match(/megammrsync action/g) || []).length, 0, "no screen builds its own megammrsync");
  const w = source("walletReplaced");
  for (const call of ["mailInvalidate", "resetMailState", "ppInvalidate", "resetPpState", "axInvalidate", "resetAxState", "casinoInvalidate", "resetWalletFigures"]) assert.ok(w.includes(call), call);
});

test("the seed phrase is read only on request, shown only on its screen, and never stored or logged", () => {
  const body = source("renderBackup");
  assert.equal((app.match(/tryCmd\("vault"\)/g) || []).length <= 2, true);
  assert.ok(/\$\("bkShow"\)\.onclick = async[\s\S]*?seedFrom\(await tryCmd\("vault"\)\)/.test(body), "vault runs when Show seed phrase is pressed");
  assert.ok(app.includes('if (activeView === "backup" && view !== "backup") el("backupBody").innerHTML = "";'), "leaving the screen removes the words from the page");
  assert.ok(!/console\.\w+\([^)]*(phrase|seed|pw\b|password)/i.test(app), "nothing logs a phrase or a password");
  assert.ok(!/saveConfig\(\{[^}]*(phrase|seed|password)/i.test(app), "nothing saves one");
  assert.ok(!/localStorage|\bstore\(/.test(body), "and the hub keeps nothing in browser storage");
});
