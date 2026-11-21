// The commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026): `vault` and `seedrandom` reach the
// node from a window only after the phrase typed for that exact command and the system's prompt (main/seedgate.js), once,
// within a minute. Nothing here reaches a node: `run` is a recording stand-in.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const G = require("../main/seedgate.js");
const SRC = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// CHANGED on purpose (0.19.187): read as the node reads a command (main/cmdverb.js), over-blocking: "vaults", "seedrandomx",
// "keys action:genkeys" and "keys publickey:genkey" now count as gated (the node answers the first two as missingcmd anyway).
const VECTORS = [["vault", "seed"], ["VAULT action:seed", "seed"], ["  Vault  action:wipekeys", "seed"], ["vault action:passwordlock password:x", "seed"], ["balance;vault", "seed"], ["balance ; VaUlT", "seed"],
  ["seedrandom modifier:ethbridge", "key"], ["SEEDRANDOM", "key"], ["status;seedrandom modifier:x", "key"], ["seedrandom;vault", "seed"],
  ["keys action:genkey", "key"], ["KEYS Action:GenKey", "key"], ["status; keys action:\"genkey\"", "key"], ["keys action:list", null], ["keys", null], ["keys action:genkeys", "key"], ["keys publickey:genkey", "key"],
  ["vaults", "seed"], ["balance vault", null], ["send amount:1 address:vault", null], ["", null], ["status", null], ["seedrandomx", "key"], [";;", null],
  ["\"vault\"", "seed"], ["\u0001vault", "seed"], ["va\"ul\"t", "seed"], ["\"seedrandom\" modifier:x", "key"], ["keys \"action\":genkey", "key"], ["keys action :genkey", "key"], ["keys action : genkey", "key"]];
// the system check (main/syscheck.js, 0.19.188) over stand-ins: Touch ID asked or a message box confirmed, nothing of Electron's
const SC = require("../main/syscheck.js"), EN = (k, p) => String(k).replace(/\{(\w+)\}/g, (m, n) => (p || {})[n]);
const os = (o) => { const asked = [], boxes = []; const sys = SC.create({ can: () => !!o.can, prompt: async (why) => { asked.push(why); if (o.refuse) throw new Error("no"); },
  confirm: async (d) => { boxes.push(d); return o.confirm !== false; }, seen: () => !!o.seen, markSeen() {}, where: () => "/x/touchid-seen" }, EN); return Object.assign(sys, { asked, boxes }); };

test("which commands are gated: vault (any action), seedrandom (any modifier) and keys with genkey, however quoted, spaced or chained; nothing else", () => {
  for (const [c, k] of VECTORS) assert.equal(G.secretKind(c), k, JSON.stringify(c));
  // 0.19.187: the window no longer decides; it has no reader of its own (renderer/app.js termRun asks main first)
  assert.ok(!/function termSecretKind/.test(SRC("renderer/app.js")), "no second reader in the window");
});

// ---- 0.19.187: the node's own reading of 68 command texts (the released review ran them through minima-core's
// CommandRunner.getCommand: [class:name params] per ";" piece; copied from the released scripts/cmdgate-test.cjs). Every
// text the node runs as vault, seedrandom or keys with a genkey action must be gated; the plain commands must not be. ----
const NODE_READS = [
  ["vault", "[vault:vault {}]"],
  [" vault ", "[vault:vault {}]"],
  ["\tvault\n", "[vault:vault {}]"],
  ["VAULT", "[vault:vault {}]"],
  ["Vault action:seed", "[vault:vault {\"action\":\"seed\"}]"],
  ["\"vault\"", "[vault:vault {}]"],
  ["\"vault\" action:seed", "[vault:vault {\"action\":\"seed\"}]"],
  ["'vault'", "[missingcmd:missingcmd {}]"],
  ["\u0001vault", "[vault:vault {}]"],
  ["\u001fvault action:seed", "[vault:vault {\"action\":\"seed\"}]"],
  ["\u0000vault", "[vault:vault {}]"],
  ["\u007fvault", "[missingcmd:missingcmd {}]"],
  ["\u200bvault", "[missingcmd:missingcmd {}]"],
  ["\ufeffvault", "[missingcmd:missingcmd {}]"],
  ["\u00a0vault", "[missingcmd:missingcmd {}]"],
  ["vault\u00a0action:seed", "[missingcmd:missingcmd {}]"],
  ["%76ault", "[missingcmd:missingcmd {}]"],
  ["vault;", "[vault:vault {}]"],
  [";;vault", "[vault:vault {}]"],
  ["status;vault", "[status:status {}] [vault:vault {}]"],
  ["status;\u0001vault", "[status:status {}] [vault:vault {}]"],
  ["action:seed vault", "[missingcmd:missingcmd {}]"],
  ["vault:seed", "[missingcmd:missingcmd {}]"],
  ["vault action:seed\u0000", "[vault:vault {\"action\":\"seed\"}]"],
  ["seedrandom modifier:ethbridge", "[seedrandom:seedrandom {\"modifier\":\"ethbridge\"}]"],
  ["\"seedrandom\" modifier:ethbridge", "[seedrandom:seedrandom {\"modifier\":\"ethbridge\"}]"],
  ["\u0002seedrandom modifier:x", "[seedrandom:seedrandom {\"modifier\":\"x\"}]"],
  ["SEEDRANDOM modifier:x", "[seedrandom:seedrandom {\"modifier\":\"x\"}]"],
  ["keys action:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:GENKEY", "[keys:keys {\"action\":\"GENKEY\"}]"],
  ["keys action :genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action : genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys \"action\":genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys \"action\" : \"genkey\"", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys \"action:genkey\"", "[keys:keys {}]"],
  ["keys action:\"genkey\"", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys\taction:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:genkey phrase:x", "[keys:keys {\"action\":\"genkey\",\"phrase\":\"x\"}]"],
  ["keys phrase:x action:genkey", "[keys:keys {\"phrase\":\"x\",\"action\":\"genkey\"}]"],
  ["\"keys\" action:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:list action:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:genkey{", "[keys:keys {\"action\":\"genkey{\"}]"],
  ["keys  action:{genkey}", "[missingcmd:missingcmd {}]"],
  ["keys action:[genkey]", "[missingcmd:missingcmd {}]"],
  ["keys action:gen\u200bkey", "[keys:keys {\"action\":\"gen\\u200Bkey\"}]"],
  ["k\u0435ys action:genkey", "[missingcmd:missingcmd {}]"],
  ["keys action\t:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:\tgenkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:\u0001genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["\u212aeys action:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["va\"ul\"t phrase:{}", "[vault:vault {\"phrase\":{}}]"],
  ["va\"ul\"t action:seed x:[1]", "[vault:vault {\"action\":\"seed\",\"x\":[1]}]"],
  ["seed\"random\" modifier:a{", "[seedrandom:seedrandom {\"modifier\":\"a{\"}]"],
  ["ke\"ys\" action:gen\"key\" x:{}", "[keys:keys {\"action\":\"genkey\",\"x\":{}}]"],
  ["\"vault\"action:seed", "[vault:vault {\"action\":\"seed\"}]"],
  ["\"vault\"\u0001", "[vault:vault {}]"],
  ["vault", "[vault:vault {}]"],
  ["balance", "[balance:balance {}]"],
  ["keys action:list", "[keys:keys {\"action\":\"list\"}]"],
  ["send amount:1 address:0xAA", "[send:send {\"amount\":\"1\",\"address\":\"0xAA\"}]"],
  ["backup password:\"x\"", "[backup:backup {\"password\":\"x\"}]"],
  ["megammrsync action:resync phrase:\"x\" host:h:9001", "[megammrsync:megammrsync {\"action\":\"resync\",\"phrase\":\"x\",\"host\":\"h:9001\"}]"],
  ["\"keys\"action:genkey", "[keys:keys {\"action\":\"genkey\"}]"],
  ["keys action:\"gen\"key", "[keys:keys {\"action\":\"gen\"}]"],
  ["v\"\"ault", "[missingcmd:missingcmd {}]"],
  ["\u0001\"vault\"", "[vault:vault {}]"],
  ["\"\"vault", "[missingcmd:missingcmd {}]"],
  ["keys action:{\"a\":1} action:genkey", "[keys:keys {\"action\":\"genkey\"}]"]
];

test("every text the node runs as a gated command is gated (68 variants: quotes, control characters, ':' spacing, case, chains)", () => {
  let gatedByNode = 0;
  for (const [text, node] of NODE_READS) {
    const runs = [...node.matchAll(/\[(\w+):(\w+) (\{.*?\})\]/g)].map(m => ({ name: m[2], params: m[3] }));
    const mustGate = runs.some(r => r.name === "vault" || r.name === "seedrandom" || (r.name === "keys" && /genkey/i.test(r.params)));
    const k = G.classify(text).kind;
    if (mustGate) { gatedByNode++; assert.notEqual(k, "", JSON.stringify(text) + " is run by the node as " + node + " and must be gated"); assert.notEqual(G.refusal(text, () => false), "", JSON.stringify(text) + " is refused without a pass"); }
    if (["balance", "keys action:list", "send amount:1 address:0xAA", 'backup password:"x"', 'megammrsync action:resync phrase:"x" host:h:9001'].includes(text)) assert.equal(k, "", text + " is not gated");
  }
  assert.equal(gatedByNode, 46, "46 of the 68 texts are run by the node as a gated command");
});

test("a chain that holds a gated command is refused, never gated whole (as released 0.18.174); the refusal names all three commands", async () => {
  const g = G.create(os({ can: false }));
  for (const c of ["status;vault", "balance;seedrandom modifier:x", "keys action:list;keys action:genkey", "vault;", ";;vault"]) {
    const chain = G.classify(c).chain;
    const why = G.refusal(c, () => true);   // even with a pass at hand
    if (chain) { assert.match(why, /^vault, seedrandom and keys action:genkey show a seed or a private key, and this chain of commands holds one\. Run that command on its own/, c); await assert.rejects(g.open(c, G.classify(c).kind === "seed" ? "SHOW SEED" : "SHOW KEY"), /this chain of commands holds one/, c); }
    else assert.equal(why, "", c + " is one command (empty pieces are dropped)");
  }
  assert.equal(G.refusal("vault", () => false), "vault, seedrandom and keys action:genkey show a seed or a private key; this one shows the seed phrase. Type SHOW SEED in the Terminal to run it.");
  assert.equal(G.refusal("keys action:genkey", () => false), "vault, seedrandom and keys action:genkey show a seed or a private key; this one shows a private key. Type SHOW KEY in the Terminal to run it.");
  assert.equal(G.refusal("balance", () => false), "");
});

test("the gate: the phrase for the kind, then the system's prompt, then that exact command once within a minute", async () => {
  let now = 1000; const sys = os({ can: true }), g = G.create(sys, () => now);
  assert.equal(g.take("vault"), false, "nothing passes before the gate was opened");
  await assert.rejects(g.open("vault", "show seed"), /Type SHOW SEED exactly to continue\./); assert.deepEqual(sys.asked, [], "a wrong phrase: no system prompt");
  await assert.rejects(g.open("vault", "SHOW KEY"), /SHOW SEED/); await assert.rejects(g.open("seedrandom modifier:x", "SHOW SEED"), /Type SHOW KEY exactly/);
  await assert.rejects(g.open("balance", "SHOW SEED"), /This command needs no check\./);
  assert.equal(g.take("vault"), false, "a refused open leaves no pass");
  assert.deepEqual(await g.open("vault", " SHOW SEED "), { system: true }); assert.deepEqual(sys.asked, ["show a seed phrase by running: vault"], "CHANGED on purpose (0.19.188): the reason names what is shown and the whole command");
  assert.equal(g.take("vault action:seed"), false, "another command: refused, and the pass is spent");
  assert.equal(g.take("vault"), false);
  await g.open("vault", "SHOW SEED"); assert.equal(g.take("vault"), true, "the exact command, once"); assert.equal(g.take("vault"), false, "single use");
  await g.open("seedrandom modifier:a", "SHOW KEY"); now += G.PASS_MS + 1; assert.equal(g.take("seedrandom modifier:a"), false, "not after a minute");
  await g.open("seedrandom modifier:a", "SHOW KEY"); now += G.PASS_MS; assert.equal(g.take("seedrandom modifier:a"), true, "within it");
  const refusing = G.create(os({ can: true, refuse: true }));
  await assert.rejects(refusing.open("vault", "SHOW SEED"), /^Error: Cancelled$/); assert.equal(refusing.take("vault"), false, "a refused system prompt leaves no pass");
  const noneSys = os({ can: false }), none = G.create(noneSys); assert.deepEqual(await none.open("vault", "SHOW SEED"), { system: false }, "no Touch ID here: a message box was confirmed, and the answer says so");
  assert.deepEqual(noneSys.boxes, ["This shows a seed phrase. This Terminal command will run once:\n\nvault"], "the box names the exact command (0.19.188)");
  assert.equal(none.take("vault"), true);
});

test("Show seed phrase (Backup & Recovery): the same checks before the node is asked", async () => {
  const sent = [], run = async (c) => { sent.push(c); return { status: true, response: { phrase: "ONE TWO THREE" } }; };
  await assert.rejects(G.revealSeed("", os({}), run), /Type SHOW SEED/); await assert.rejects(G.revealSeed("SHOW SEED", os({ can: true, refuse: true }), run), /Cancelled/);
  assert.deepEqual(sent, [], "the node is not asked before both checks");
  assert.deepEqual(await G.revealSeed("SHOW SEED", os({ can: true }), run), { phrase: "ONE TWO THREE", system: true }); assert.deepEqual(sent, ["vault"]);
  await assert.rejects(G.revealSeed("SHOW SEED", os({}), async () => ({ status: true, response: {} })), /Couldn't read the seed\./);
});

test("main: the general command channel refuses vault and seedrandom without a pass; the window reaches the seed only through the gates", () => {
  const main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd"'));
  assert.ok(/^ipcMain\.handle\("mcd:cmd", async \(_e, command\) => \{\n  if \(typeof command !== "string" \|\| !command\.trim\(\)\) throw new Error\("empty command"\);\n[^\n]*\n  if \(\/\[\\x00-\\x08\\x0b-\\x1f\\x7f\]\/\.test\(command\)\) throw new Error\("This command holds a control character\. Type it again without one\."\);\n(?:[^\n]*\n){0,6}?  requireRunning\(\);\n[^\n]*\n  const gated = seedgate\.refusal\(command, secretGate\.take\); if \(gated\) throw new Error\(gated\);/.test(h), "control characters first, then the node, then the gate: the first things the handler checks");
  assert.ok(/ipcMain\.handle\("mcd:secretGate", \(_e, command, typed\) => \{ requireRunning\(\); return secretGate\.open\(command, typed\); \}\);/.test(main));
  assert.ok(/if \(!firstRunOpen \|\| c\.walletDone \|\| c\.walletMode !== "new"\) throw new Error\("The seed is shown here only while a new wallet is being made\."\);/.test(main) && /if \(c\.walletDone\) firstRunOpen = false;/.test(main), "the first-run seed: only in that step");
  assert.equal((main.match(/"vault"/g) || []).length, 1, "main asks for the vault in one place of its own (the first-run step); the reveal is in seedgate.js");
  // the window: no command of its own asks for the vault; the Terminal keeps no secret command and no secret reply
  for (const f of fs.readdirSync(path.join(__dirname, "..", "renderer")).filter(x => x.endsWith(".js"))) {
    const s = SRC("renderer/" + f); assert.ok(!/(cmd|tryCmd)\(\s*["'`](vault|seedrandom)/i.test(s), f + " asks the node for a secret directly");
  }
  const app = SRC("renderer/app.js"), run = app.slice(app.indexOf("async function termRun()"), app.indexOf("function renderTerminal()"));
  assert.ok(run.indexOf("try { r = await api.cmd(c); } catch (x) { err = x; }") < run.indexOf("if (secret) {"), "main is asked first: its refusal decides");
  assert.ok(/secret = MainSaid\.has\(raw, "SG_GATED_SEED"\) \? "seed" : MainSaid\.has\(raw, "SG_GATED_KEY"\) \? "key" : null;/.test(run), "decided by main's code, never by words on screen or a reader of its own");
  assert.ok(run.indexOf("if (secret) {") < run.indexOf("TERM_HIST.push(c)") && /secretReveal\(c, JSON\.stringify\(r, null, 2\), !!\(g && g\.system\)\);[^\n]*\n\s*\}\);\n\s*return;\n\s*\}/.test(run), "a secret command returns before the history and the output");
  assert.ok(/appendTerm\(c\.split\(\/\\s\+\/\)\[0\], "cmd"\)/.test(run), "only its verb is shown in the output");
  const reveal = app.slice(app.indexOf("function secretReveal("), app.indexOf("// Export: the phone asks"));
  assert.ok(!/appendTerm|TERM_ITEMS|clip|copy\(/.test(reveal) && /setTimeout\(end, 60000\)/.test(reveal) && /window\.addEventListener\("blur", end\)/.test(reveal), "the reply: never in the output or a copy, gone after a minute and on blur");
  assert.ok(/\$\("bkShow"\)\.onclick = \(\) => secretAsk\("seed", t\("Show seed phrase"\), async \(typed\) => \{\s*const r = await api\.revealSeed\(typed\);\s*secretReveal\(t\("Seed phrase"\), r\.phrase, r\.system\);/.test(app), "Show seed phrase goes through the same gate");
});

// ---- 0.19.188: the system check names the exact, whole command (released 0.18.176, 0.18.184, 0.18.186) ----
test("a gated command is shown whole: over 80 characters or a repeated parameter is refused (the node keeps the last); a box where there is no Touch ID", async () => {
  for (const mac of [true, false]) {
    const sys = os({ can: mac }), g = G.create(sys);
    const hidden = "keys action:list" + " ".repeat(mac ? 70 : 600) + "action:genkey";
    await assert.rejects(g.open(hidden, "SHOW KEY"), /names action more than once \(the node would keep only the last\)/, "shown as keys action:list, run as genkey");
    assert.deepEqual([sys.asked, sys.boxes], [[], []], "nothing was asked"); assert.notEqual(G.refusal(hidden, g.take), "", "and it does not run");
    await assert.rejects(g.open("keys action:genkey phrase:" + "x".repeat(80), "SHOW KEY"), /longer than the check can show in full \(80 characters\)/);
    for (const dup of ["vault action:seed action:wipekeys", 'keys action:genkey "action":list', "seedrandom modifier:a modifier : b"]) await assert.rejects(g.open(dup, dup.startsWith("vault") ? "SHOW SEED" : "SHOW KEY"), /more than once/, dup);
    const c = "keys   action:genkey\u202e  phrase:x";
    await g.open(c, "SHOW KEY");
    const text = mac ? sys.asked[0] : sys.boxes[0];
    assert.equal(text, mac ? "show a private key by running: keys action:genkey phrase:x" : "This shows a private key. This Terminal command will run once:\n\nkeys action:genkey phrase:x", "the whole command, white space collapsed, the bidi control a space");
    assert.notEqual(G.refusal("keys action:genkey phrase:x", g.take), "", "the pass is for the exact original text only");
    await g.open(c, "SHOW KEY"); assert.equal(G.refusal(c, g.take), "");
  }
  // a translated reason never cuts the command: past 120 characters the English is said
  const asked = [], long = SC.create({ can: () => true, prompt: async (w) => { asked.push(w); }, markSeen() {} }, () => "x".repeat(130));
  await long.check(["show a private key by running: {command}", { command: "k".repeat(80) }], "d");
  assert.equal(asked[0], "show a private key by running: " + "k".repeat(80));
});

test("syscheck: refused (not phrase only) once Touch ID worked here and cannot be asked; the marker is written only after a prompt succeeded and names this Mac", async () => {
  await assert.rejects(os({ can: false, seen: true }).check("r", "d"), /Touch ID has worked in this app on this Mac before but cannot be asked now[\s\S]*lock the screen and log in again[\s\S]*delete this file: \/x\/touchid-seen/);
  const bx = os({ can: false, seen: true }); await assert.rejects(bx.check("r", "d")); assert.deepEqual(bx.boxes, [], "no fall-back to a box while it is remembered");
  let marked = 0;
  await assert.rejects(SC.create({ can: () => true, prompt: async () => { throw new Error("no"); }, confirm: async () => true, seen: () => false, markSeen: () => { marked++; }, where: () => "" }).check("r", "d"), /Cancelled/);
  assert.equal(marked, 0, "a refused prompt leaves no marker");
  const osm = require("os"), dir = fs.mkdtempSync(path.join(osm.tmpdir(), "tid-")), file = path.join(dir, "touchid-seen");
  let can = true, boxes = 0;
  const electron = { app: { getPath: () => dir }, systemPreferences: { canPromptTouchID: () => can, promptTouchID: async () => {} }, dialog: { showMessageBox: async (w, o) => { boxes++; assert.ok(o.detail.includes("No Touch ID check is available on this computer")); return { response: 1 }; } } };
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform"); Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const sys = SC.forElectron(electron, () => null);
    assert.deepEqual(await sys.check("r", "d"), { biometric: true });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).machine, SC.machineId(), "the marker names this Mac");
    can = false;
    await assert.rejects(sys.check("r", "d"), (e) => e.message.includes("delete this file: " + file + " ."), "refused, naming the file's whole path");
    fs.writeFileSync(file, JSON.stringify({ machine: "another mac" }));
    assert.deepEqual(await sys.check("r", "d"), { biometric: false }, "a marker from another Mac is ignored: the box is used"); assert.equal(boxes, 1);
  } finally { Object.defineProperty(process, "platform", realPlatform); fs.rmSync(dir, { recursive: true, force: true }); }
  const main = SRC("main/main.js");
  assert.ok(/const systemCheck = require\("\.\/syscheck"\)\.forElectron\(require\("electron"\), \(\) => win\);/.test(main) && !/canPromptTouchID/.test(main), "one system check for every gate");
  for (const re of [/seedgate\.revealSeed\(typed, systemCheck,/, /secretGate = seedgate\.create\(systemCheck\)/, /exportKeyGated\(typed, systemCheck\)/]) assert.ok(re.test(main), String(re));
});
