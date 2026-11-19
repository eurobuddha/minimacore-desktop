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
  assert.equal(require("../main/restore.js").restoreFileCommand({ host: H, file: "old.bak", password: "pw1" }).cmd, `megammrsync action:resync host:${H} file:old.bak password:pw1`, "a backup file's command is built in the main process (0.18.95)");
  assert.ok(resyncCommand({ host: H, phrase: FAKE, keyuses: "1" }).resetsWallet);
  assert.ok(!/file:/.test(source("resyncCommand")), "and the page cannot build one");
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
  bad({ host: H, needPhrase: true }, "Rebuild without a phrase");
  const badFile = (o, why) => { const r = require("../main/restore.js").restoreFileCommand(o); assert.ok(r.error && !r.cmd, why); };
  badFile({ host: H, file: "my file.bak" }, "a file path with a space");
  badFile({ host: H, file: "a.bak", password: "p w" }, "a password with a space");
  badFile({ host: H, file: "a.bak", password: 'p"w' }, "a password with a quote");
  badFile({ host: "h:9001 phrase:x", file: "a.bak" }, "a host carrying another parameter");
  badFile({ host: H }, "Restore without a file");
  bad({ host: H, phrase: "fake words; status", keyuses: "1" }, "a semicolon in the phrase: the node would run the rest as a second command");
  badFile({ host: H, file: "a;b.bak" }, "a semicolon in the file path"); badFile({ host: H, file: "a.bak", password: "p;w" }, "a semicolon in the password");
  assert.ok(/semicolon/.test(require("../main/restore.js").restoreFileCommand({ host: H, file: "a;b.bak" }).error), "said in plain words");
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
  const order = ["built.error", "showConfirm(", "await cmd(built.cmd)", "saveConfig({ megammrHost", "walletReplaced()"].map(x => run.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "refuse, confirm, run, remember the host, drop identities: in that order");
  assert.equal((body.match(/megammrsync action/g) || []).length, 0, "no screen builds its own megammrsync");
  const w = source("walletReplaced");
  for (const call of ["resetMailState", "resetPpState", "resetAxState", "resetWalletFigures"]) assert.ok(w.includes(call), call);
  // 0.18.106: the stores are reset by the main process inside the resync (node.onWalletReplaced), not by this window
  assert.ok(!/api\.\w*Invalidate\(/.test(w), "the window resets no store");
  const mainJs = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), hook = mainJs.slice(mainJs.indexOf("node.onWalletReplaced = async () => {"), mainJs.indexOf("// Restore from a backup FILE"));
  for (const call of ["mail.invalidateIdentity()", "pandapools.invalidate()", "atomix.invalidate()", "dexicon.invalidate({ hold: true })", "casino.invalidate()"]) assert.ok(hook.includes(call), call);
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

const flowPrelude = "let CFG = cfg0, RESTORE = null, waitingForNode = false, postBootStarted = true, running = false, KEYMODE = km0, FR_CLASSIC = classic0;\n";
function flow(opts) {
  opts = opts || {};
  const log = [], toasts = [], saved = [];
  const env = {
    cfg0: Object.assign({ network: "mainnet", megammrHost: "megammr.example:9001", walletDone: false }, opts.cfg),
    km0: Object.assign({ mode: "", supported: false }, opts.km), classic0: !!opts.classic,
    api: {
      saveConfig: async (p) => { log.push("save:" + Object.keys(p).sort().join(",")); saved.push(p); return Object.assign({}, env.cfg0, ...saved); },
      recordKeyMode: async (m) => { log.push("record:" + m); if (opts.recordRefused) throw new Error("This wallet's key mode is classic and cannot be changed."); return m; },
      nodeStart: async () => { log.push("nodeStart"); }, nodeRestart: async () => { log.push("nodeRestart"); },
      nodeStatus: async () => ({ state: opts.afterState || "starting", lastError: opts.afterError || null }),
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
  const fns = lift(["cmd", "resyncCommand", "seedMismatch", "frStart", "postBootRestore", "confirmNewSeed", "modeQuestionHtml", "restoreMode"], env, flowPrelude,
    ["state: () => ({ RESTORE, waitingForNode, postBootStarted, CFG })", "setRestore: (r) => { RESTORE = r; }"]);
  return { log, toasts, saved, fns, els: () => opts.els };
}

test("New Wallet: the config is saved, then the node starts; the wallet is not marked done and nothing of a seed is saved", async () => {
  const h = flow();
  await h.fns.frStart(null);
  assert.deepEqual(h.log, ["record:classic", "save:megammrHost,setupDone,walletDone,walletMode", "showStarting", "nodeStart"]);
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

// ---- key mode in the screens (0.18.88); main/keymode.js and the config rules are in scripts/keymode-test.cjs ----
test("the key mode is recorded before the config is saved and before the node starts, in both capability states", async () => {
  const first = async (opts, restore) => { const h = flow(opts); await h.fns.frStart(restore || null); return h; };
  assert.equal((await first({ km: { supported: false } })).log[0], "record:classic", "a node without block keys: every new wallet is classic");
  assert.equal((await first({ km: { supported: false }, classic: true })).log[0], "record:classic");
  let h = await first({ km: { supported: true } });
  assert.deepEqual(h.log, ["record:block", "save:megammrHost,setupDone,walletDone,walletMode", "showStarting", "nodeStart"], "a capable node: new wallets are block, recorded first");
  assert.equal(h.fns.state().CFG.keyMode, undefined, "the renderer never puts the mode in a config patch");
  assert.equal((await first({ km: { supported: true }, classic: true })).log[0], "record:classic", "the Classic mode switch");
  const R = (mode) => ({ seed: "NOT A REAL SEED", keyuses: "1", host: "megammr.example:9001", mode });
  assert.equal((await first({ km: { supported: true } }, R("classic"))).log[0], "record:classic", "a restore uses the mode its words were used in");
  assert.equal((await first({ km: { supported: true }, classic: true }, R("block"))).log[0], "record:block");
  assert.equal((await first({ km: { supported: true, mode: "classic" } }, R("block"))).log[0], "record:classic", "a mode already recorded is the one asked for again");
  h = await first({ km: { supported: true }, recordRefused: true }, R("block"));
  assert.deepEqual(h.log, ["record:block"], "a refusal stops everything: no save, no node start");
  assert.equal(h.fns.state().RESTORE, null, "and no seed is held");
  assert.equal(h.toasts.length, 1);
});

test("the mode question and the Classic switch exist only when the node can run block keys", () => {
  const off = flow({ km: { supported: false, mode: "classic" } }), on = flow({ km: { supported: true } });
  assert.equal(off.fns.modeQuestionHtml(), "", "no question, no dead switch");
  assert.deepEqual(off.fns.restoreMode(null), { mode: "classic" });
  assert.ok(/Which kind of wallet were these words used in\?/.test(on.fns.modeQuestionHtml()) && /different addresses in each mode/.test(on.fns.modeQuestionHtml()));
  const host = (picked) => ({ querySelector: () => picked ? { dataset: { mode: picked } } : null });
  assert.ok(on.fns.restoreMode(host(null)).error, "it must be answered");
  assert.deepEqual(on.fns.restoreMode(host("block")), { mode: "block" });
  assert.deepEqual(on.fns.restoreMode(host("classic")), { mode: "classic" });
  const fixed = flow({ km: { supported: true, mode: "classic" } });
  assert.deepEqual(fixed.fns.restoreMode(host("classic")), { mode: "classic" });
  assert.ok(/cannot be changed/.test(fixed.fns.restoreMode(host("block")).error), "an existing install is never switched: the other mode's words are refused");
  const params = source("renderParams");
  assert.ok(params.includes('firstRun && KEYMODE.supported && !KEYMODE.mode ? psSwitch("pClassic", "Classic mode", FR_CLASSIC'), "the switch: first run, capable node, no wallet yet; off by default");
  assert.ok(/let FR_CLASSIC = false;/.test(app));
  for (const fn of ["frRestore", "renderBackup"]) assert.ok(source(fn).includes("modeQuestionHtml()") && source(fn).includes("restoreMode("), fn + " asks");
  assert.ok(source("frRestore").indexOf("restoreMode(") < source("frRestore").indexOf("resolveSeed("), "asked before the words are read");
});

test("Startup Params refuses -blockaskeyuses and -lowram; the tray line shows the true mode", () => {
  const { paramsPatch } = lift(["paramsPatch"]);
  const P = PARAMS.defaultParams();
  for (const x of ["-lowram", "-txpowdbstore 3 -blockaskeyuses"]) assert.ok(/cannot be set here/.test(paramsPatch({ net: "mainnet", extraArgs: x, P }, { basePort: 9001 }).error), x);
  const els = { trayMode: { textContent: "" } };
  const k = lift(["paintKeyMode"], { el: (id) => els[id] }, 'let KEYMODE = { mode: "", supported: false };\n');
  k.paintKeyMode("classic"); assert.equal(els.trayMode.textContent, "Classic mode");
  k.paintKeyMode("block"); assert.equal(els.trayMode.textContent, "Block key uses · low-RAM node");
  k.paintKeyMode(undefined); assert.equal(els.trayMode.textContent, "Block key uses · low-RAM node", "a status without the mode changes nothing");
});

// ---- Settings (0.18.89) ----
test("Settings holds the desktop's own items in the shell's style, and no second command box", () => {
  const body = app.slice(app.indexOf("async function renderSettings()"), app.indexOf("function keysInfo("));
  const titles = [...body.matchAll(/sec\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(titles, ["This computer", "Updates", "Node", "Signing keys", "Address key uses", "Signing keys", "Address labels", "History"]);
  assert.ok(!/diagCmd|diagGo|diagOut|Diagnostics/.test(app), "the Diagnostics command box is gone: the Terminal is the one place to type a node command");
  assert.ok(!/api\.cmd\(/.test(body), "Settings sends no free-text command");
  assert.ok(!/vault|megammrsync|backup password/.test(body), "seed, resync and backup live in Backup & Recovery");
  assert.ok(/class="switch switch--m2" role="switch" id="setAutostart"/.test(body) && body.includes("home-eyebrow") && body.includes("home-card"), "the phone's switch, eyebrow and card");
  assert.ok(!/if \(!running\) \{ host\.innerHTML = waitHtml\(\); return; \}/.test(body), "updates and open at login do not wait for the node");
  for (const id of ["updCard", "updCheck", "updGet", "setKindApply", "setHeap", "kuAudit", "setClearHist", "chanceLeft"]) assert.ok(body.includes(id), id + " kept");
  assert.ok(!/—/.test(body.slice(0, body.indexOf("const drawUpdate"))), "no em dash in the Settings text");
});

// ---- key-mode audit (0.18.94+) ----
test("M5: a node stopped for the wrong key mode puts one message over the whole window, with nothing to dismiss it", () => {
  const added = [], els = { shell: { inert: false } };
  const { showKeyModeBlock } = lift(["showKeyModeBlock"], { esc: (x) => String(x).replace(/</g, "&lt;"), el: (id) => els[id] || null,
    document: { body: { insertAdjacentHTML: (_w, h) => { added.push(h); els.keyModeBlock = {}; } } } });
  showKeyModeBlock("The node is running with block keys <b>"); showKeyModeBlock("again");
  assert.equal(added.length, 1, "once");
  assert.ok(added[0].includes('role="alertdialog"') && added[0].includes("running with block keys &lt;b>") && !/<button/.test(added[0]), "the words, escaped, and no button");
  assert.equal(els.shell.inert, true, "nothing underneath can be used");
  assert.ok(/function onStatus\(s\) \{\n  if \(s\.keyModeAlert\) showKeyModeBlock\(s\.keyModeAlert\);/.test(app), "shown on the first status that carries it");
});

test("H3: Restore from file asks the backup's key mode on every node, and the main process decides", async () => {
  const body = source("renderBackup"), q = source("backupModeQuestionHtml");
  assert.ok(q.includes("Was this backup made by a wallet using block key uses, such as Pandamonium on a phone with default settings, or classic keys?"));
  assert.ok(!/KEYMODE\.supported/.test(q), "asked even when this node runs classic keys only");
  const file = body.slice(body.indexOf('if (BK_PAGE === "restore")'), body.indexOf("// Private keys"));
  assert.ok(file.includes("backupModeQuestionHtml()") && file.includes("wireModeQuestion(host)"));
  const order = ["api.restoreBackup(Object.assign({ check: true }, o))", 'run("bkGo", "Restore"', "exec: () => api.restoreBackup(o)"].map(x => file.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "the main process refuses first; then the question; then the main process runs it");
  assert.ok(!/megammrsync|cmd\(/.test(file), "the page sends no restore command of its own");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/"mcd:restoreBackup", \(_e, o\) => restore\.restoreBackup\(o, \{ keyMode: config\.load\(\)\.keyMode, supported: node\.blockKeysSupported\(\),/.test(main), "with the recorded mode and the jar's capability, read in the main process");
  assert.ok(main.indexOf("restore.loadsBackupFile(command)") > main.indexOf('"mcd:cmd"') && main.indexOf("restore.loadsBackupFile(command)") < main.indexOf("pinMinimaSend(run, command)"), "and the general command channel refuses a backup-file restore before anything runs");
});

test("M4: the note under the mode question says what is true: the choice is kept, and the other mode needs a fresh install", () => {
  const { modeQuestionHtml } = lift(["modeQuestionHtml"], { KEYMODE: { supported: true } });
  const note = modeQuestionHtml();
  assert.ok(!/restore again and choose the other/.test(note), "the app refuses that: the mode is already recorded");
  assert.ok(/recorded for this install and cannot be changed afterwards/.test(note) && /the other mode then needs a fresh install of the app/.test(note) && /Nothing is lost/.test(note));
});

test("M2: after megammrsync the node is restarted by the main process, and every screen says what the node is doing", async () => {
  const body = source("renderBackup"), run = body.slice(body.indexOf("const run = async"), body.indexOf("const hostField"));
  const order = ["await cmd(built.cmd)", "walletReplaced()", "await api.nodeStatus()", 'after.state === "error"', "The node is restarting."].map(x => run.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "the node's state is read before anything is called complete: " + order);
  assert.ok(!/complete ✓", "ok"/.test(run), "no bare 'complete' while the node is down");
  assert.ok(app.includes('el("stopBar").hidden = !(s.state === "stopped" && !s.resyncing &&'), "no 'The node is stopped' bar during the restart");
  assert.ok(app.includes('s.resyncing ? "Restarting after resync…" : s.state === "stopped" ? "Node stopped"'), "the footer says so too");
  const R = { seed: WordEntry.minimaForm(FAKE24), keyuses: "1", host: "megammr.example:9001" };
  let h = flow(); h.fns.setRestore(R); await h.fns.postBootRestore();
  assert.deepEqual(h.toasts, ["ok:Wallet restored ✓ The node is restarting."]);
  h = flow({ afterState: "error", afterError: "The node was not started: its start command holds -blockaskeyuses" }); h.fns.setRestore(R); await h.fns.postBootRestore();
  assert.equal(h.toasts.length, 1); assert.ok(/^err:Wallet restored, but the node was not started again\. The node was not started: its start command holds -blockaskeyuses/.test(h.toasts[0]), h.toasts[0]);
  assert.ok(h.saved.some(p => p.walletDone === true), "the wallet IS restored, so it is marked done either way");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(main.includes("if (restore.isResync(command)) return node.runResync(command);") && main.includes("run: (c) => node.runResync(c)"), "every megammrsync, from any screen or the Terminal, goes through runResync");
});
