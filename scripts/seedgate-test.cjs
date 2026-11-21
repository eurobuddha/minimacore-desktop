// The commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026): `vault` and `seedrandom` reach the
// node from a window only after the phrase typed for that exact command and the system's prompt (main/seedgate.js), once,
// within a minute. Nothing here reaches a node: `run` is a recording stand-in.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const G = require("../main/seedgate.js");
const SRC = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// CHANGED on purpose (0.19.187): read as the node reads a command (main/cmdverb.js), over-blocking: "vaults", "seedrandomx",
// "keys action:genkeys" and "keys publickey:genkey" now count as gated (the node answers the first two as missingcmd anyway).
const VECTORS = [["vault", "seed"], ["VAULT action:seed", "seed"], ["  Vault  action:wipekeys", "change"], ["vault action:passwordlock password:x", "change"], ["balance;vault", "seed"], ["balance ; VaUlT", "seed"],
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
  assert.ok(/^ipcMain\.handle\("mcd:cmd", async \(_e, command\) => \{\n  if \(typeof command !== "string" \|\| !command\.trim\(\)\) throw new Error\("empty command"\);\n[^\n]*\n  if \(\/\[\\x00-\\x08\\x0b-\\x1f\\x7f\]\/\.test\(command\)\) throw new Error\("This command holds a control character\. Type it again without one\."\);\n(?:[^\n]*\n){0,10}?  requireRunning\(\);\n[^\n]*\n  const gated = seedgate\.refusal\(command, secretGate\.take\); if \(gated\) throw new Error\(gated\);/.test(h), "control characters first, then the node, then the gate: the first things the handler checks");
  assert.ok(/ipcMain\.handle\("mcd:secretGate", \(_e, command, typed\) => \{ requireRunning\(\); return secretGate\.open\(command, typed\); \}\);/.test(main));
  assert.ok(/if \(!firstRunOpen \|\| node\.freshAtFirstStart !== true\) throw new Error\("The seed is shown here only while a new wallet is being made\."\);/.test(main) && /if \(c\.walletDone\) firstRunOpen = false;/.test(main), "the first-run seed: only in that step (CHANGED on purpose, 0.19.220: decided from the launch's own facts)");
  assert.equal((main.match(/"vault"/g) || []).length, 1, "main asks for the vault in one place of its own (the first-run step); the reveal is in seedgate.js");
  // the window: no command of its own asks for the vault; the Terminal keeps no secret command and no secret reply
  for (const f of fs.readdirSync(path.join(__dirname, "..", "renderer")).filter(x => x.endsWith(".js"))) {
    const s = SRC("renderer/" + f); assert.ok(!/(cmd|tryCmd)\(\s*["'`](vault|seedrandom)/i.test(s), f + " asks the node for a secret directly");
  }
  // CHANGED on purpose (0.19.237, as released 0.18.194): main is asked what the text is FIRST (mcd:cmdKind), then mcd:cmd decides
  const app = SRC("renderer/app.js"), run = app.slice(app.indexOf("const TERM_BUSY"), app.indexOf("function renderTerminal()"));
  assert.ok(run.indexOf("k = await api.cmdKind(c)") < run.indexOf("if (k.kind && !k.chain) { ask(k.kind); return; }") && run.indexOf("if (k.kind && !k.chain) { ask(k.kind); return; }") < run.indexOf("TERM_HIST.push(c)"), "a secret command goes to its gate before the history and the output");
  assert.ok(/secret = MainSaid\.has\(raw, "SG_GATED_SEED"\) \? "seed" : MainSaid\.has\(raw, "SG_GATED_KEY"\) \? "key" : MainSaid\.has\(raw, "SG_GATED_CHANGE"\) \? "change" : null;\s*\n\s*if \(secret\) \{ ask\(secret\); return; \}/.test(run), "main's refusal still decides, by code");
  assert.ok(/if \(!k\.secretValues\) \{ TERM_HIST\.push\(c\);/.test(run) && /appendTerm\(k\.shown, "cmd"\)/.test(run) && /secretReveal\(k\.shown,/.test(run), "the echo, the title and the history never carry a secret value");
  assert.ok(/appendTerm\(c\.split\(\/\\s\+\/\)\[0\], "cmd"\)/.test(run), "only its verb is shown in the output");
  const reveal = app.slice(app.indexOf("function secretReveal("), app.indexOf("// Export: the phone asks"));
  assert.ok(!/appendTerm|TERM_ITEMS|clip|copy\(/.test(reveal) && /setTimeout\(end, 60000\)/.test(reveal) && /window\.addEventListener\("blur", end\)/.test(reveal), "the reply: never in the output or a copy, gone after a minute and on blur");
  assert.ok(/\$\("bkShow"\)\.onclick = \(\) => secretAsk\("seed", t\("Show seed phrase"\), async \(typed\) => \{\s*const r = await api\.revealSeed\(typed\);\s*secretReveal\(t\("Seed phrase"\), r\.phrase, r\.system\);/.test(app), "Show seed phrase goes through the same gate");
});

// ---- 0.19.188: the system check names the exact, whole command (released 0.18.176, 0.18.184, 0.18.186) ----
// CHANGED on purpose (0.19.227, released 0.18.196): no 80-character cap; secret values hidden; only Touch ID refuses what it cannot show
test("a gated command is shown whole with its secret values hidden: a repeated parameter is refused; Touch ID refuses what it cannot show; a box shows any length", async () => {
  for (const mac of [true, false]) {
    const sys = os({ can: mac }), g = G.create(sys);
    const hidden = "keys action:list" + " ".repeat(mac ? 70 : 600) + "action:genkey";
    await assert.rejects(g.open(hidden, "SHOW KEY"), /names action more than once \(the node would keep only the last\)/, "shown as keys action:list, run as genkey");
    assert.deepEqual([sys.asked, sys.boxes], [[], []], "nothing was asked"); assert.notEqual(G.refusal(hidden, g.take), "", "and it does not run");
    const longOne = "keys action:genkey keyuses:" + "1".repeat(120) + ' phrase:"a b c d e f g h i j k l"';
    if (mac) await assert.rejects(g.open(longOne, "SHOW KEY"), /longer than the Touch ID prompt can show in full \(120 characters, with the secret values hidden\)/);
    else { await g.open(longOne, "SHOW KEY"); assert.ok(sys.boxes[0].includes("1".repeat(120)) && sys.boxes[0].includes("phrase:•••") && !sys.boxes[0].includes("a b c"), "a box shows it whole, the phrase hidden"); sys.boxes.length = 0; g.take(""); }
    for (const dup of ["vault action:seed action:wipekeys", 'keys action:genkey "action":list', "seedrandom modifier:a modifier : b"]) await assert.rejects(g.open(dup, dup.startsWith("vault") ? "SHOW SEED" : "SHOW KEY"), /more than once/, dup);
    const c = "keys   action:genkey\u202e  phrase:x";
    await g.open(c, "SHOW KEY");
    const text = mac ? sys.asked[0] : sys.boxes[0];
    assert.equal(text, mac ? "show a private key by running: keys action:genkey phrase:•••" : "This shows a private key. This Terminal command will run once:\n\nkeys action:genkey phrase:•••", "the whole command, white space collapsed, the bidi control a space, the phrase's value hidden");
    assert.notEqual(G.refusal("keys action:genkey phrase:x", g.take), "", "the pass is for the exact original text only");
    await g.open(c, "SHOW KEY"); assert.equal(G.refusal(c, g.take), "");
  }
  // a translated reason never cuts the command: past 120 characters the English is said; past 120 in English, refused
  const asked = [], long = SC.create({ can: () => true, prompt: async (w) => { asked.push(w); }, markSeen() {} }, () => "x".repeat(130));
  await long.check(["show a private key by running: {command}", { command: "k".repeat(80) }], "d");
  assert.equal(asked[0], "show a private key by running: " + "k".repeat(80));
  await assert.rejects(long.check(["show a private key by running: {command}", { command: "k".repeat(100) }], "d"), /longer than the Touch ID prompt can show in full/);
  assert.equal(asked.length, 1, "never a cut prompt");
  // the third kind: vault actions that change the keys, behind CHANGE KEYS
  for (const c of ["vault action:wipekeys", "vault action:restorekeys phrase:\"a b\"", "vault action:passwordlock password:x", '"vault" action : passwordunlock password:x', "vault action:testphrase phrase:a"]) assert.equal(G.classify(c).kind, "change", c);
  assert.equal(G.classify("vault").kind, "seed"); assert.equal(G.classify("vault action:seed").kind, "seed"); assert.equal(G.classify("vault action:wipekeys;vault").kind, "seed", "the strongest kind");
  assert.equal(G.refusal("vault action:wipekeys", () => false), "This vault command changes this wallet's keys or their lock. Type CHANGE KEYS in the Terminal to run it.");
  const cs = os({ can: false }), cg = G.create(cs);
  await assert.rejects(cg.open("vault action:restorekeys phrase:\"a b\"", "SHOW SEED"), /Type CHANGE KEYS exactly/);
  await cg.open("vault action:restorekeys phrase:\"a b\"", "CHANGE KEYS");
  assert.equal(cs.boxes[0], "This changes this wallet's keys or their lock. This Terminal command will run once:\n\nvault action:restorekeys phrase:•••");
  // 0.19.266: the node reads this as ONE seed value (0xABaction:wipekeys) and no action (0.19.252 showed an action the node never reads): hidden whole
  assert.equal(G.masked('vault seed:0xAB"action":"wipekeys"'), "vault seed:•••");
  assert.equal(G.masked('vault action:passwordunlock password:my"secret'), "vault action:passwordunlock password:•••", "no part of a secret holding a quote is shown");
  assert.equal(G.masked('vault action:passwordunlock password:"my secret" seed : 0xAB confirm:x'), "vault action:passwordunlock password:••• seed:••• confirm:•••".replace("seed:", "seed : "));
});

test("syscheck: refused (not phrase only) once Touch ID worked here and cannot be asked; the marker is written only after a prompt succeeded and names this Mac", async () => {
  await assert.rejects(os({ can: false, seen: true }).check("r", "d"), /Touch ID has worked in this app on this Mac before but cannot be asked now[\s\S]*lock the screen and log in again[\s\S]*delete this file: \/x\/touchid-seen/);
  await assert.rejects(os({ can: false, seen: true }).check("r", "d"), /so nothing was shown\. If the lid is closed or your Touch ID keyboard is unplugged, open the lid or connect it and try again\. If Touch ID is locked/, "the commonest reason first (0.19.251)");
  const bx = os({ can: false, seen: true }); await assert.rejects(bx.check("r", "d")); assert.deepEqual(bx.boxes, [], "no fall-back to a box while it is remembered");
  let marked = 0;
  await assert.rejects(SC.create({ can: () => true, prompt: async () => { throw new Error("no"); }, confirm: async () => true, seen: () => false, markSeen: () => { marked++; }, where: () => "" }).check("r", "d"), /Cancelled/);
  assert.equal(marked, 0, "a refused prompt leaves no marker");
  const osm = require("os"), dir = fs.mkdtempSync(path.join(osm.tmpdir(), "tid-")), file = path.join(dir, "touchid-seen");
  let can = true, boxes = 0;
  const electron = { app: { getPath: () => dir }, systemPreferences: { canPromptTouchID: () => can, promptTouchID: async () => {} }, dialog: { showMessageBox: async (w, o) => { boxes++; assert.ok(o.detail.includes("No Touch ID check is available on this computer")); return { response: 1 }; } } };
  // CHANGED on purpose (0.19.222, released 0.18.191 / 0.18.192): the platform and the Mac's id are injected; the id is the IOPlatformUUID
  try {
    const sys = SC.forElectron(electron, () => null, { platform: "darwin", machineId: () => "MAC-A" });
    assert.deepEqual(await sys.check("r", "d"), { biometric: true });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).machine, "MAC-A", "the marker names this Mac");
    can = false;
    await assert.rejects(sys.check("r", "d"), (e) => e.message.includes("delete this file: " + file + " ."), "refused, naming the file's whole path");
    fs.writeFileSync(file, JSON.stringify({ machine: "another mac" }));
    assert.deepEqual(await sys.check("r", "d"), { biometric: false }, "a marker from another Mac is ignored: the box is used"); assert.equal(boxes, 1);
    // an id that cannot be read counts as the same Mac (refused, never phrase-only)
    fs.writeFileSync(file, JSON.stringify({ machine: "MAC-A" }));
    await assert.rejects(SC.forElectron(electron, () => null, { platform: "darwin", machineId: () => "" }).check("r", "d"), /cannot be asked now/);
    // off macOS the marker is ignored and never written: the box, never a refusal
    can = true; const win = SC.forElectron(electron, () => null, { platform: "win32", machineId: () => "MAC-A" });
    assert.deepEqual(await win.check("r", "d"), { biometric: false }, "no Touch ID off macOS, and a copied marker refuses nothing"); assert.equal(boxes, 2);
    fs.rmSync(file); await win.check("r", "d"); assert.ok(!fs.existsSync(file), "never written off macOS");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ioreg = '+-o Root  <class IORegistryEntry>\n    "IOPlatformSerialNumber" = "X"\n    "IOPlatformUUID" = "564d4c3a-1111-2222-3333-444455556666"\n';
  let called = null; assert.equal(SC.machineId((f, a) => { called = [f, a]; return ioreg; }), "564D4C3A-1111-2222-3333-444455556666");
  assert.deepEqual(called, ["/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]], "absolute path, no shell");
  assert.equal(SC.machineId(() => { throw new Error("no ioreg"); }), "", "unreadable: empty, the same Mac");
  assert.ok(SC.sameMac("", "X") && SC.sameMac("X", "") && SC.sameMac("X", "X") && !SC.sameMac("X", "Y"));
  assert.ok(!/networkInterfaces/.test(SRC("main/syscheck.js")), "never the network cards");
  const main = SRC("main/main.js");
  assert.ok(/const systemCheck = require\("\.\/syscheck"\)\.forElectron\(require\("electron"\), \(\) => win\);/.test(main) && !/canPromptTouchID/.test(main), "one system check for every gate");
  for (const re of [/seedgate\.revealSeed\(typed, systemCheck,/, /secretGate = seedgate\.create\(systemCheck\)/, /exportKeyGated\(typed, systemCheck\)/]) assert.ok(re.test(main), String(re));
});

// ---- 0.19.201: the first-run seed step cannot be reopened by flipping restore back to new after a restore was sent ----
test("first run: decided from this launch's facts: a node first started on an empty data folder, no wallet-replacing command since; config cannot reopen it", async () => {
  const main = SRC("main/main.js");
  const snippet = main.slice(main.indexOf("let firstRunOpen = null;"), main.indexOf('ipcMain.handle("mcd:cmd"'));
  const make = (fresh, cfg) => { const h = {}, sent = [];
    const env = { ipcMain: { handle: (n, f) => { h[n] = f; } }, requireRunning() {}, restore: require("../main/restore.js"), config: { load: () => Object.assign({}, cfg), rpcSecret: () => "" },
      node: { freshAtFirstStart: fresh, rpcPort: () => 0, runResync: async (c) => { sent.push(c); return { status: true }; } }, rpc: { rpcCall: async () => ({ status: true, response: { phrase: "THE NODE'S WORDS" } }) } };
    const api = new Function(...Object.keys(env), snippet + "; return { runResync };")(...Object.values(env)); return { h, api, sent }; };
  // 0.19.201: a wallet-replacing megammrsync closes it, whatever the config then says
  let x = make(true, { walletDone: false, walletMode: "restore" });
  await x.api.runResync('megammrsync action:resync host:h:9001 phrase:"x y" keyuses:0');
  await assert.rejects(x.h["mcd:firstRunSeed"](), /The seed is shown here only while a new wallet is being made/, "the restored wallet's seed is not shown");
  // 0.19.220: an existing wallet's launch (the folder held node data) never shows it, even with walletDone false / walletMode new written by the window
  x = make(false, { walletDone: false, walletMode: "new" });
  await assert.rejects(x.h["mcd:firstRunSeed"](), /only while a new wallet is being made/);
  // a new wallet's own first run (a chain resync only) still shows its seed, whatever walletMode says
  x = make(true, { walletDone: false, walletMode: "restore" });
  await x.api.runResync("megammrsync action:resync host:h:9001");
  assert.equal(await x.h["mcd:firstRunSeed"](), "THE NODE'S WORDS");
  const rest = main.slice(main.indexOf("const runResync =")); assert.ok(!/node\.runResync\(/.test(rest.slice(rest.indexOf("\n"))), "every resync of the window goes through runResync");
  const nm = SRC("main/node-manager.js");
  assert.ok(nm.indexOf("this.freshAtFirstStart = !names.some(") > 0 && nm.indexOf("this.freshAtFirstStart = !names.some(") < nm.indexOf("keymode.markBlockFolder(this.dataDir())"), "read before the folder is marked or the node touches it");
});


test("0.19.237: mcd:cmdKind says what a text is with its secret values hidden; the Terminal keeps such a command out of history", () => {
  const main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmdKind"'), main.indexOf('ipcMain.handle("mcd:cmd", async'));
  const handlers = {}; new Function("ipcMain", "seedgate", "rpc", h)({ handle: (n, f) => { handlers[n] = f; } }, G, require("../main/rpc.js"));
  const k = (c) => handlers["mcd:cmdKind"](null, c);
  assert.deepEqual(k("balance"), { kind: "", chain: false, write: false, shown: "balance", secretValues: false });
  assert.equal(k("send amount:1 address:0xAA").write, true);
  const r = k('megammrsync action:resync host:h:9001 phrase:"ONE TWO THREE" keyuses:9');
  assert.equal(r.shown, "megammrsync action:resync host:h:9001 phrase:••• keyuses:9"); assert.equal(r.secretValues, true);
  assert.equal(k("vault action:passwordunlock password:hunter2").shown, "vault action:passwordunlock password:•••");
  assert.deepEqual([k("vault").kind, k("status;vault").chain], ["seed", true]);
});

// ---- 0.19.250: an empty quoted value does not hide the next parameter name from the reader ----
test("an empty quoted value (password:\"\") does not hide the parameter after it: the kind, a repeated name and the value are read", () => {
  const V = require("../main/cmdverb.js");
  for (const c of ['vault password:"" action:wipekeys', 'vault password : "" action:wipekeys', 'vault password:""action:wipekeys', 'vault phrase:"" action:restorekeys'])
    assert.equal(G.classify(c).kind, "change", c);
  assert.deepEqual(V.paramNames('vault action:seed password:"" action:wipekeys'), ["action", "password", "action"]);
  assert.deepEqual(V.repeated('vault action:seed password:"" action:wipekeys'), ["action"], "the repeat is seen, so the command is refused");
  assert.equal(V.paramValue('vault password:"" action:wipekeys', "action"), "wipekeys");
  assert.equal(V.paramValue('vault password:"x y" action:wipekeys', "action"), "wipekeys", "a value with content as before");
  assert.equal(V.paramValue('keys action:"list"action:genkey', "action"), "genkey", "a name glued after a closing quote as before");
  assert.equal(V.paramValue('send amount:1 address:"" tokenid:0xAB', "tokenid"), "0xAB");
});

// ---- 0.19.266: one reader, the node's own (main/cmdverb.js read: CommandRunner.getCommand and its fast and slow splitters) ----
test("cmdverb.read gives the node's reading of 400 deterministic texts (a table made by an independent port of CommandRunner)", () => {
  const V = require("../main/cmdverb.js"), { rows } = require("./fixtures/node-command-reading.json");
  assert.equal(rows.length, 400);
  for (const r of rows) {
    const got = V.read(r.c);
    assert.equal(got.verb, r.verb, JSON.stringify(r.c)); assert.equal(!!got.error, r.error, JSON.stringify(r.c));
    if (!r.error) assert.deepEqual(got.params, r.params, JSON.stringify(r.c));
  }
});
test("the texts the review ran through the node: every check reads what the node reads, and a text read otherwise than it looks is refused", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), { pinMinimaSend } = require("../main/sendpin");
  const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  // a quoted value of only white space hides nothing: the node keeps the last action, and the checks see it
  assert.equal(V.paramValue('vault action:wipekeys password:" " action:seed', "action"), "seed");
  assert.deepEqual(V.repeated('vault action:wipekeys password:" " action:seed'), ["action"]);
  assert.deepEqual(V.repeated('vault action:wipekeys password:"\t" action:seed'), ["action"]);
  assert.equal(R.replacesKeysElsewhere('vault password:" " action:resetkeys phrase:"a b c"'), true);
  assert.equal(R.replacesWalletFromPhrase('megammrsync action:resync password:" " phrase:"a b c"'), true);
  assert.equal(R.isResync('megammrsync action:resync password:" " phrase:"a b c"'), true);
  assert.equal(R.replacesKeysElsewhere('archive action:resync host:x.y:9001 keys:" " phrase:"a b c"'), true);
  const mx = 'send amount:1 address:0xCD tokenid:0x00 debug:" " tokenid:' + MX;
  assert.equal(V.paramValue(mx, "tokenid"), MX); assert.deepEqual(V.repeated(mx, ["amount", "tokenid", "address", "fromaddress"]), ["tokenid"]);
  const asked = []; assert.equal(await pinMinimaSend(async (c) => { asked.push(c); return { status: true, response: [] }; }, mx), mx, "an MxUSD send is not pinned"); assert.deepEqual(asked, []);
  // the slow path: a { opens JSON even inside quotes, and a name:"…" inside a quoted token is no parameter: the node runs the DEFAULT action (the seed)
  for (const c of ['vault password:"{" action:wipekeys', 'vault confirm:x"phrase: "x"action:wipekeys', 'vault seed:0xAB"action":"wipekeys"']) {
    assert.equal(V.paramValue(c, "action"), null, c); assert.equal(G.classify(c).kind, "seed", c);
    assert.match(V.unclear(c), /differently from how it is written/, c);
    await assert.rejects(G.create({ check: async () => { throw new Error("no question"); } }).open(c, "SHOW SEED"), /differently from how it is written/, c);
  }
  // plain texts, quoted values and a state's JSON are not refused
  for (const c of ['vault action:passwordunlock password:"my secret"', 'send amount:1 address:0xCD state:{"0":"a b","1":"[x]"}', '"vault" action:seed', "keys action:list", 'backup password:"abc1"', "status"]) assert.equal(V.unclear(c), "", c);
  // the mcd:cmd handler itself: the unclear text is refused before anything reaches the node
  const main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes"));
  const handlers = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", h)(
    { handle: (n, f) => { handlers[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => ({}), async (c) => { sent.push(c); return {}; },
    { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } }, { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c);
  for (const c of ['vault seed:0xAB"action":"wipekeys"', 'send amount:1 address:0xCD tokenid:"0x00"tokenid:' + MX, 'txnpost id:a"b'])
    await assert.rejects(handlers["mcd:cmd"](null, c), /differently from how it is written/, c);
  assert.deepEqual(sent, []);
  await handlers["mcd:cmd"](null, "balance"); assert.deepEqual(sent, ["balance"], "a plain command still runs");
});

// ---- 0.19.282: no secret is shown: privatekey: too, every word of an unquoted phrase, and the node's own echo of the parameters ----
test("secrets stay hidden: privatekey: is masked, so are the words after a hidden value, and the node's reply params are scrubbed before the window gets them", async () => {
  assert.equal(G.masked("sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD keyuses:5"), "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:••• keyuses:5");
  assert.equal(G.masked("vault action:restorekeys phrase:spray lamp"), "vault action:restorekeys phrase:••• •••", "the node drops 'lamp', and it is a word of the phrase");
  assert.equal(G.masked("megammrsync action:resync host:h:9001 phrase:w1 w2 w3 w4 keyuses:5"), "megammrsync action:resync host:h:9001 phrase:••• ••• ••• ••• keyuses:5");
  assert.equal(G.masked('vault action:passwordunlock password:"my secret" seed : 0xAB confirm:x'), "vault action:passwordunlock password:••• seed : ••• confirm:•••", "a spaced name still ends it");
  const main = SRC("main/main.js"), kh = main.slice(main.indexOf('ipcMain.handle("mcd:cmdKind"'), main.indexOf('ipcMain.handle("mcd:cmd", async')), handlers = {};
  new Function("ipcMain", "seedgate", "rpc", kh)({ handle: (n, f) => { handlers[n] = f; } }, G, require("../main/rpc.js"));
  const k = handlers["mcd:cmdKind"](null, "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD keyuses:5");
  assert.equal(k.secretValues, true, "kept out of the Terminal's ↑ history"); assert.ok(!k.shown.includes("0x1234ABCD"), "and echoed without it");
  // what the node echoes in "params" (Command.getJSONReply), at any depth, for one command or a chain
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {};
  const reply = (c) => /^backup/.test(c) ? { command: "backup", params: { password: "hunter22", file: "b.bak" }, status: true }
    : [{ command: "sendfrom", params: { privatekey: "0x1234ABCD", amount: "1" }, status: true, response: { inner: { params: { Phrase: "a b c" } } } }];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => ({}), async () => ({}), { rpcCall: async (p, s, c) => reply(c) }, { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const b = await hs["mcd:cmd"](null, "backup password:hunter22 file:b.bak");
  assert.deepEqual(b.params, { password: "•••", file: "b.bak" });
  const s = JSON.stringify(await hs["mcd:cmd"](null, "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD"));
  assert.ok(!s.includes("0x1234ABCD") && !s.includes("a b c") && s.includes('"amount":"1"'), s);
});
