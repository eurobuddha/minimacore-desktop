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
function lift(names, env, prelude, extra) {
  env = Object.assign({ MINIMA_PARAMS: PARAMS }, env || {});
  return new Function(...Object.keys(env), (prelude || "") + names.map(source).join("\n") + "; return { " + names.concat(extra || []).join(", ") + " };")(...Object.values(env));
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
  assert.ok(/\$\("bkShow"\)\.onclick = async[\s\S]*?seedFrom\(await tryCmd\("vault"\)\)/.test(body), "vault runs when Show seed phrase is pressed");
  assert.ok(app.includes('if (activeView === "backup" && view !== "backup") el("backupBody").innerHTML = "";'), "leaving the screen removes the words from the page");
  assert.ok(!/console\.\w+\([^)]*(phrase|seed|pw\b|password)/i.test(app), "nothing logs a phrase or a password");
  assert.ok(!/saveConfig\(\{[^}]*(phrase|seed|password)/i.test(app), "nothing saves one");
  assert.ok(!/localStorage|\bstore\(/.test(body), "and the hub keeps nothing in browser storage");
});

// ---- first run (0.18.87) ----
const WordEntry = require("../renderer/wordentry.js");
const FAKE24 = "test only void abandon ".repeat(6).trim();   // NOT a seed: four list words, repeated

test("word boxes: Minima's own 2048 words, each word checked, pasted text split as the phone splits it", () => {
  assert.equal(WordEntry.WORDS.length, 2048);
  assert.equal(new Set(WordEntry.WORDS).size, 2048);
  assert.deepEqual([WordEntry.WORDS[0], WordEntry.WORDS[2047]], ["abandon", "zoo"]);
  assert.deepEqual(WordEntry.splitPasted("1. Test\n2) ONLY, void.abandon"), ["test", "only", "void", "abandon"]);
  assert.equal(WordEntry.letters("Te5t!"), "tet");
  assert.deepEqual(WordEntry.matches("", 8), []);
  assert.deepEqual(WordEntry.matches("acco", 2), ["account"], "one match: the box completes it");
  assert.equal(WordEntry.matches("ab", 8).length, 8);
  assert.equal(WordEntry.join(FAKE24.split(" ")), FAKE24);
  assert.equal(WordEntry.join(FAKE24.split(" ").slice(1)), null, "23 words are not a phrase");
  assert.equal(WordEntry.join(FAKE24.split(" ").slice(1).concat("zzq")), null, "nor are 24 with one that is not a word");
  assert.equal(WordEntry.minimaForm(" Test  only\nVOID abandon "), "TEST ONLY VOID ABANDON", "capitals, single spaces: what BIP39.cleanSeedPhrase returns");
});

test("a free-form phrase is refused when the node cannot carry it or it is list words with a mistake", () => {
  const why = WordEntry.anyPhraseProblem;
  assert.equal(why("not a real phrase, just a test!"), null);
  assert.ok(why("too short"));
  assert.ok(why("-starts with a dash and is long"));
  for (const ch of ['"', ";", ":", "[", "]", "{", "}", "\\", "\n", "\t"]) assert.ok(why("a fake phrase " + ch + " for the test"), JSON.stringify(ch) + " is refused");
  assert.ok(why(FAKE24.replace("void", "voidd")), "list words with one mistake belong in the boxes");
  assert.equal(why(FAKE24), null, "list words only: allowed, and the app then asks which form");
  assert.ok(WordEntry.allListWords(FAKE24) && !WordEntry.allListWords("test only void") && !WordEntry.allListWords(FAKE24 + " zzq"));
});

const flowPrelude = "let CFG = cfg0, RESTORE = null, waitingForNode = false, postBootStarted = true, running = false;\n";
function flow(opts) {
  opts = opts || {};
  const log = [], toasts = [], saved = [];
  const env = {
    cfg0: Object.assign({ network: "mainnet", megammrHost: "megammr.example:9001", walletDone: false }, opts.cfg),
    api: {
      saveConfig: async (p) => { log.push("save:" + Object.keys(p).sort().join(",")); saved.push(p); return Object.assign({}, env.cfg0, ...saved); },
      nodeStart: async () => { log.push("nodeStart"); }, nodeRestart: async () => { log.push("nodeRestart"); },
      cmd: async (c) => { log.push("cmd:" + c); return opts.cmdFails ? { status: false, error: "node says no" } : { status: true, response: {} }; },
      clip: async () => true
    },
    toast: (m, k) => toasts.push((k || "") + ":" + m), ipcError: (e) => String(e && e.message || e), esc: (x) => String(x),
    showStarting: () => log.push("showStarting"), showSetup: () => log.push("launcher"), hideSetup: () => log.push("hideSetup"), renderActive: () => log.push("renderActive"),
    walletReplaced: async () => log.push("walletReplaced"), postBootNewSeed: () => {},
    frScreen: () => ({ set innerHTML(v) {}, className: "" }),
    el: (id) => opts.els && opts.els[id] || (opts.els = opts.els || {}, opts.els[id] = { onclick: null, style: {}, textContent: "", insertAdjacentHTML() {} }),
    WordEntry: Object.assign({}, WordEntry, { create: () => ({ phrase: () => opts.typed, problem: () => "Word 3 is empty or not one of the 2048 words.", isAnyPhrase: () => false, clear() {} }) })
  };
  const fns = lift(["cmd", "resyncCommand", "seedMismatch", "frStart", "postBootRestore", "confirmNewSeed"], env, flowPrelude,
    ["state: () => ({ RESTORE, waitingForNode, postBootStarted, CFG })", "setRestore: (r) => { RESTORE = r; }"]);
  return { log, toasts, saved, fns, els: () => opts.els };
}

test("New Wallet: the config is saved, then the node starts; the wallet is not marked done and nothing of a seed is saved", async () => {
  const h = flow();
  await h.fns.frStart(null);
  assert.deepEqual(h.log, ["save:megammrHost,setupDone,walletDone,walletMode", "showStarting", "nodeStart"]);
  assert.deepEqual(h.saved[0], { setupDone: true, walletMode: "new", walletDone: false, megammrHost: "megammr.example:9001" });
  assert.equal(h.fns.state().postBootStarted, false, "the post-boot wallet step is armed for this start");
  const solo = flow({ cfg: { network: "solo" } });
  await solo.fns.frStart(null);
  assert.equal(solo.saved[0].walletDone, true, "a solo network has no seed step, as before");
});

test("Restore Wallet: the seed is held in memory only, applied after the node is up, then cleared", async () => {
  const h = flow();
  const R = { seed: WordEntry.minimaForm(FAKE24), keyuses: "2000", host: "other.example:9001" };
  await h.fns.frStart(R);
  assert.equal(h.saved[0].walletMode, "restore");
  assert.equal(h.saved[0].megammrHost, "other.example:9001");
  assert.ok(!JSON.stringify(h.saved).toUpperCase().includes("VOID"), "the config save carries no word of the seed");
  assert.equal(h.fns.state().RESTORE, R);
  h.log.length = 0;
  await h.fns.postBootRestore();
  assert.deepEqual(h.log, [`cmd:megammrsync action:resync host:other.example:9001 phrase:"${R.seed}" anyphrase:true keyuses:2000`,
    "walletReplaced", "save:megammrHost,walletDone", "hideSetup", "renderActive"], "the 0.18.84 command, then the old identities dropped, then walletDone");
  assert.equal(h.fns.state().RESTORE, null, "the seed is cleared from memory");
  assert.ok(!JSON.stringify(h.saved).toUpperCase().includes("VOID"));
});

test("Restore Wallet: a failed megammrsync never marks the wallet done", async () => {
  const h = flow({ cmdFails: true });
  h.fns.setRestore({ seed: WordEntry.minimaForm(FAKE24), keyuses: "1", host: "megammr.example:9001" });
  await h.fns.postBootRestore();
  assert.ok(!h.log.some(l => l.startsWith("save:")) && !h.log.includes("walletReplaced") && !h.log.includes("hideSetup"));
  assert.ok(h.fns.state().RESTORE, "kept for Retry");
  h.els().rBack.onclick();
  assert.equal(h.fns.state().RESTORE, null, "Back drops it");
});

test("New Wallet: the wallet opens only after the node's words are typed back", async () => {
  const seed = WordEntry.minimaForm(FAKE24);
  let h = flow({ typed: null });
  h.fns.confirmNewSeed(seed); await h.els().frGo.onclick();
  assert.deepEqual(h.saved, [], "boxes not filled: nothing saved"); assert.equal(h.toasts.length, 1);
  h = flow({ typed: FAKE24.replace("void", "zoo") });
  h.fns.confirmNewSeed(seed); await h.els().frGo.onclick();
  assert.deepEqual(h.saved, [], "a wrong word: nothing saved"); assert.ok(/Word 3 /.test(h.toasts[0]));
  h = flow({ typed: FAKE24 });
  h.fns.confirmNewSeed(seed); await h.els().frGo.onclick();
  assert.deepEqual(h.saved, [{ walletDone: true }]);
  assert.deepEqual(h.log.slice(-2), ["hideSetup", "renderActive"]);
  assert.equal(h.fns.seedMismatch(seed, FAKE24 + " zoo"), "Word 25 is not the word of this wallet. Check what you wrote down.");
});

test("first run is the phone's launcher; the seed screens keep the words out of storage, logs and config", () => {
  const launcher = source("showSetup");
  for (const w of ["MINIMA CORE", ">New Wallet<", ">Restore Wallet<", ">Startup Params<"]) assert.ok(launcher.includes(w), w);
  for (const fn of ["showSetup", "frRestore", "resolveSeed", "frStart", "postBootNewSeed", "confirmNewSeed", "postBootRestore"]) {
    const src = source(fn);
    assert.ok(!/console\.|localStorage|\bstore\(/.test(src), fn + " logs nothing and stores nothing in the browser");
    assert.ok(!/saveConfig\(\{[^}]*(seed|phrase|keyuses)/i.test(src), fn + " saves no seed");
  }
  assert.ok(source("hideSetup").includes('el("setupBody").innerHTML = ""'), "closing the layer removes the words from the page");
  assert.ok(/postBootNewSeed[\s\S]*?tryCmd\("vault"\)/.test(app) && source("confirmNewSeed").includes("seedMismatch(phrase, typed)"));
  assert.ok(html.includes('<script src="wordentry.js"></script>') && !html.includes("Set up your node"));
  const stub = fs.readFileSync(path.join(ROOT, "scripts", "dev-preview", "stub.js"), "utf8");
  assert.ok(stub.includes('const FAKE_SEED = "TEST ONLY VOID ABANDON ".repeat(6).trim();'), "the preview's seed is four words repeated: plainly not a wallet");
});
