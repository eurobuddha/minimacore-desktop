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
  // changed on purpose (0.19.327): the handler's first step is seedgate.js checkCommand, which holds the same checks in the same order
  assert.ok(h.startsWith('ipcMain.handle("mcd:cmd", async (_e, command) => {\n') && /^ipcMain[^\n]*\n(?:  \/\/[^\n]*\n)*  await seedgate\.checkCommand\(command, \{ take: secretGate\.take, running: requireRunning, walletWork, keyMode: \(\) => config\.load\(\)\.keyMode,\n    tip: async \(\) => \{ const r = await rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), "block"\);/.test(h), "the handler checks first, through checkCommand (0.19.329: and the tip)");
  const gsrc = SRC("main/seedgate.js"), chk = gsrc.slice(gsrc.indexOf("async function checkCommand("));
  assert.ok(/^async function checkCommand\(command, io\) \{\n  const R = require\("\.\/restore"\);\n  if \(typeof command !== "string" \|\| !command\.trim\(\)\) throw new Error\("empty command"\);\n[^\n]*\n  if \(\/\[\\x00-\\x08\\x0b-\\x1f\\x7f\]\/\.test\(command\)\) throw new Error\("This command holds a control character\. Type it again without one\."\);\n(?:[^\n]*\n){0,80}?  io\.running\(\);\n[^\n]*\n  const gated = refusal\(command, io\.take\); if \(gated\) throw new Error\(gated\);/.test(chk), "control characters first, then the node, then the gate: the first things checked");
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
  assert.ok(/secret = MainSaid\.has\(raw, "SG_GATED_SEED"\) \? "seed" : MainSaid\.has\(raw, "SG_GATED_KEY"\) \? "key" : MainSaid\.has\(raw, "SG_GATED_CHANGE"\) \? "change" : MainSaid\.has\(raw, "SG_GATED_SECRET"\) \? "secret" : null;\s*\n\s*if \(secret\) \{ ask\(secret\); return; \}/.test(run), "main's refusal still decides, by code");
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
    else { await g.open(longOne, "SHOW KEY"); assert.ok(sys.boxes[0].includes("1".repeat(120)) && sys.boxes[0].includes('phrase:"••• (12 words)"') && !sys.boxes[0].includes("a b c"), "a box shows it whole, the phrase hidden"); sys.boxes.length = 0; g.take(""); }
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
  assert.equal(cs.boxes[0], "This changes this wallet's keys or their lock. This Terminal command will run once:\n\nvault action:restorekeys phrase:\"••• (2 words)\"");   // its word count (0.19.306)
  // 0.19.266: the node reads this as ONE seed value (0xABaction:wipekeys) and no action (0.19.252 showed an action the node never reads): hidden whole
  assert.equal(G.masked('vault seed:0xAB"action":"wipekeys"'), "vault seed:•••");
  assert.equal(G.masked('vault action:passwordunlock password:my"secret'), "vault action:passwordunlock password:•••", "no part of a secret holding a quote is shown");
  assert.equal(G.masked('vault action:passwordunlock password:"my secret" seed : 0xAB confirm:x'), 'vault action:passwordunlock password:"••• (2 words)" seed:••• confirm:•••');   // its word count (0.19.306)
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
  assert.equal(r.shown, 'megammrsync action:resync host:h:9001 phrase:"••• (3 words)" keyuses:9'); assert.equal(r.secretValues, true);   // its word count (0.19.306)
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
  assert.equal(G.masked("vault action:restorekeys phrase:spray lamp"), "vault action:restorekeys phrase:•••", "CHANGED on purpose (0.19.293): shown as the node reads it, which drops 'lamp'");
  assert.equal(G.masked("megammrsync action:resync host:h:9001 phrase:w1 w2 w3 w4 keyuses:5"), 'megammrsync action:resync host:h:9001 phrase:"••• (4 words)" keyuses:5', "a count also where the node would refuse the text (0.19.311)");
  assert.equal(G.masked('vault action:passwordunlock password:"my secret" seed : 0xAB confirm:x'), 'vault action:passwordunlock password:"••• (2 words)" seed:••• confirm:•••', "a spaced name still ends it");
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

// ---- 0.19.290: txnstate keeps a [..] value as plain text, so one written in quotes is not refused as unclear ----
test("unclear lets txnstate's quoted [..] value through, as the node reads it; a bracket in quotes elsewhere is still refused", () => {
  const V = require("../main/cmdverb.js");
  const c = 'txnstate id:x port:1 value:"[hello world]"';
  assert.equal(V.unclear(c), ""); assert.deepEqual(V.read(c).params, [["id", "x"], ["port", "1"], ["value", "[hello world]"]]);
  for (const bad of ['send amount:1 address:0xA state:"[a b]"', 'vault password:"{" action:wipekeys', 'txnstate id:x port:1 value:"[a" b]']) assert.match(V.unclear(bad), /differently from how it is written/, bad);
});

// ---- 0.19.291: an escaped ";" (;) the node decodes in a JSON value, then pastes into a command it runs itself, is refused for every verb ----
test("an escaped semicolon or control character smuggles no second command; mds accept and a multisig spend are not run from the Terminal; ordinary JSON states still run", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), SC = "\\u003b";
  const main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async (c) => { sent.push(c); return {}; }, { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const refused = [
    ['sendfrom fromaddress:0x01 address:0x02 amount:0.0001 script:"RETURN TRUE" privatekey:0x00 keyuses:1 state:{"1":"[a' + SC + 'send address:0xATT amount:500 tokenid:0x00' + SC + 'b]"}', /escape code/],
    ['multisig action:create amount:1 required:1 publickeys:["0x' + SC + 'rpc action:adduser username:a password:b mode:write' + SC + 'xxxx"]', /escape code/],
    ['send amount:1 address:0xA state:{"0":"a\\u000Aphrase:x"}', /escape code/], ['txnstate id:x port:1 value:{"a":"\\u003B"}', /escape code/],
    ["mds action:accept uid:0x01", /mds action:accept runs a MiniDapp's waiting command/], ["multisig action:spend id:abc amount:1 address:0x02", /multisig spend copies the coin's state/], ["multisigread action:spend data:0x01", /multisig spend/],
    ["sendfrom fromaddress:0x01 address:0x02 address:0x03 amount:1 privatekey:0x00 keyuses:1", /names address more than once/], ["sphincs action:transaction amount:1 amount:2", /names amount more than once/]];
  for (const [c, why] of refused) { await assert.rejects(hs["mcd:cmd"](null, c), why, c); }
  assert.deepEqual(sent, [], "none reached the node");
  for (const c of ['send amount:1 address:0xA state:{"0":"hello"}', 'txnstate id:x port:1 value:"[hello world]"', 'send amount:1 address:0xA state:{"0":"caf\\u00e9"}']) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
  await assert.rejects(G.create({ check: async () => { throw new Error("no question"); } }).open('vault action:seed password:"a' + SC + 'b"', "SHOW SEED"), /escape code/, "refused before the gate asks");
  assert.throws(() => V.oneCommand('send state:{"1":"' + SC + '"}'), /escape code/, "and for a command the app builds");
  for (const v of ["sphincs", "sendpoll", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom", "multisig", "multisigread"]) assert.match(V.unclear(v + ' x:"a"b'), /differently from how it is written/, v + " is a sensitive verb");
  // a stored mysql login is pasted by the node's autobackup: white space, a quote or ";" in it is refused; a host:port is not
  assert.equal(R.replacesKeysElsewhere('mysql action:setlogin host:127.0.0.1:3306 database:db user:u password:"x action:resync phrase:a b"'), true);
  assert.equal(R.replacesKeysElsewhere("mysql action:setlogin host:127.0.0.1:3306 database:db user:u password:secret1"), false);
  // no MDS: refused in the extra node arguments, and never passed to the node
  const P = require("../renderer/params.js"); assert.equal(P.mdsArg("-mdsenable"), "-mdsenable"); assert.equal(P.mdsArg('-p2pnodes x "-MDSPASSWORD=y"'), "-mdspassword"); assert.equal(P.mdsArg("-test -nop2p"), "");
  assert.ok(SRC("main/config.js").includes("const mds = PARAMS.mdsArg(cfg.extraArgs);") && (SRC("main/node-manager.js").match(/PARAMS\.mdsArg\(tok\)/g) || []).length === 2, "config refuses it, both node kinds skip it");
});

// ---- 0.19.292: a reply never shows a secret of the typed command; passwords and a private key the user asks for are gated, not hidden ----
test("the node's reply is scrubbed of the typed command's secrets (its 'command' echo, an error naming a phrase word); rpc listusers, mds and sphincs generate need SHOW KEY", async () => {
  const typed = "vault action:restorekeys phrase:spray lamp keyz:1";
  const r = G.scrubReply({ command: typed, params: { action: "restorekeys", phrase: "spray", keyz: "1" }, status: false, error: "Invalid parameter : keyz", more: ["Invalid parameters for vault @ lamp", "spraying is a word"] }, typed);
  const s = JSON.stringify(r);
  assert.ok(!/\bspray\b|\blamp\b/.test(s), s); assert.equal(r.command, 'vault action:restorekeys phrase:"••• (2 words)" keyz:1'); assert.equal(r.more[0], "Invalid parameters for vault @ •••"); assert.equal(r.more[1], "spraying is a word", "whole words only");
  const pk = "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD9 keyuses:5 foo:1";
  assert.ok(!JSON.stringify(G.scrubReply({ command: pk, status: false, error: "Invalid parameter : foo" }, pk)).includes("0x1234ABCD9"));
  // through the real mcd:cmd handler
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {};
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => ({ command: c, status: false, error: "Invalid parameter : foo" }) },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const got = await hs["mcd:cmd"](null, "backup password:hunter22 foo:1");
  assert.equal(got.command, "backup password:••• foo:1"); assert.ok(!JSON.stringify(got).includes("hunter22"));
  // what the user asks for by name: gated like SHOW KEY
  for (const c of ["rpc action:listusers", "mds", "mds action:list", "sphincs action:generate seed:abc"]) assert.equal(G.classify(c).kind, "secret", c);
  for (const c of ["mds action:pending", "rpc", "sphincs action:sign data:0x01"]) assert.equal(G.classify(c).kind, "", c);
  assert.match(G.refusal("rpc action:listusers", () => false), /shows passwords or a private key .*Type SHOW KEY/);
  let why = null; const g = G.create({ check: async (reason) => { why = reason; return { biometric: false }; } });
  await assert.rejects(g.open("rpc action:listusers", "SHOW SEED"), /Type SHOW KEY exactly/); await g.open("rpc action:listusers", "SHOW KEY");
  assert.deepEqual(why, ["show passwords or a private key by running: {command}", { command: "rpc action:listusers" }]); assert.equal(g.take("rpc action:listusers"), true);
  // and the node's log file: password:, confirm:, seed: values
  const NL = require("../main/nodelog.js"), line = NL.scrub('cmd: backup password:hunter22 confirm:"a b" seed:0xABCD file:x');
  assert.ok(!/hunter22|a b|0xABCD/.test(line) && line.includes("file:x"), line);
});

// ---- 0.19.293: what the gate shows is the node's reading, name by name: an empty secret never hides the action; it is refused ----
test("masked shows the command name by name as the node reads it, never hiding the action after an empty secret; a gated command with an empty secret is refused", async () => {
  assert.equal(G.masked("vault phrase: action:restorekeys"), 'vault phrase:"" action:restorekeys');
  assert.equal(G.masked("vault password: action:passwordlock"), 'vault password:"" action:passwordlock');
  assert.equal(G.masked('vault action:restorekeys phrase:"spray lamp a b" keyuses:5'), 'vault action:restorekeys phrase:"••• (4 words)" keyuses:5');
  assert.equal(G.masked("status;vault password:x action:passwordunlock"), "status ; vault password:••• action:passwordunlock");
  const g = G.create({ check: async () => { throw new Error("no question"); } });
  for (const c of ["vault phrase: action:restorekeys", "vault password: action:passwordlock", 'vault action:passwordunlock password:""'])
    await assert.rejects(g.open(c, "CHANGE KEYS"), /names (phrase|password): with no value/, c);
});

// ---- 0.19.298: what would hand the node to someone else or send its events out is not run from the Terminal ----
test("rpc enable / password / adduser / removeuser, slavenode enable, webhooks add and mds actions are refused; rpc's status and the gated listings are not", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ["rpc enable:true", "rpc enable:true password:x", "rpc enable:false", "rpc action:adduser username:u password:p mode:write", "rpc action:removeuser username:u", "rpc ssl:true", "rpc action:listusers enable:true",
    "slavenode enable:true host:10.0.0.1:9001", "slavenode enable:false", "webhooks action:add hook:http://x.example/h", "mds action:install file:x.mds.zip", "mds action:publicmds enable:true", "mds action:permission uid:0x01 trust:write", "status;rpc enable:true"])
    await assert.rejects(hs["mcd:cmd"](null, c), /open this node to someone else/, c);
  assert.deepEqual(sent, []);
  for (const c of ["rpc", "rpc action:listusers", "mds", "slavenode", "webhooks", "webhooks action:list", "webhooks action:clear", "network action:list"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
});

// ---- 0.19.299: a value that would rewrite the commands a builder (sendfrom, rawfrom, multisig …) makes from it is refused ----
test("a multisig key carrying JSON, a multi-word password, a raw output with a space and an escaped quote in a state are refused; ordinary builder commands are not", async () => {
  const V = require("../main/cmdverb.js"), user = "0x" + "B".repeat(64), att = "0x" + "A".repeat(64);
  let fake = '0x00","2":"0","9":"['; fake = fake + "x".repeat(66 - fake.length - 1) + "]";
  assert.equal(fake.length, 66, "it passes the node's own check (0x, 66 characters)");
  const ms = "multisig action:create id:pair amount:10 required:2 publickeys:" + JSON.stringify([user, att, fake]);
  assert.match(V.builtProblem(ms), /builds further commands/, "its escaped quotes");
  assert.match(V.builtProblem("multisig action:create id:pair amount:10 required:1 publickeys:" + JSON.stringify([user, "0x" + "Z".repeat(64)])), /must be 0x followed by 64 hexadecimal digits/);
  assert.match(V.builtProblem("multisig action:create amount:1 required:1 publickeys:" + JSON.stringify([user]) + " root:0x" + "G".repeat(64)), /64 hexadecimal digits/);
  const pw = "multisig action:create id:pair amount:10 required:2 publickeys:" + JSON.stringify([user, att]) + ' password:"pw burn:500"';
  assert.match(V.builtProblem(pw), /builds further commands from its values/);
  assert.match(G.masked(pw), /password:"••• \(2 words\)"/, "the echo shows the password is more than one word");
  for (const c of ['rawfrom inputs:[{"coinid":"0x01"}] outputs:[{"address":"0x02 burn:5","amount":"1","tokenid":"0x00"}]', 'sendfrom fromaddress:0x01 address:0x02 amount:1 privatekey:0x03 keyuses:1 state:{"1":"a\\\\\\" b"}',
    'sendfrom fromaddress:0x01 address:0x02 amount:1 tokenid:"0x00 burn:9" privatekey:0x03 keyuses:1', 'sendfrom fromaddress:0x01 address:0x02 amount:1 privatekey:0x03 keyuses:1 script:RETURN"x'])
    assert.match(V.builtProblem(c), /builds further commands/, c);
  for (const c of ['sendfrom fromaddress:0x01 address:0x02 amount:1 script:"RETURN TRUE" privatekey:0x03 keyuses:1 state:{"1":"hello world"}', "multisig action:create id:pair amount:10 required:2 publickeys:" + JSON.stringify([user, att]),
    'createtokenfrom fromaddress:0x01 name:"My Token" amount:10 privatekey:0x03 keyuses:1 script:"RETURN TRUE"', 'sphincs action:generate seed:"two words"', 'send amount:1 address:0x02 tokenid:"0x00"'])
    assert.equal(V.builtProblem(c), "", c);
  // through the real mcd:cmd handler
  const R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  await assert.rejects(hs["mcd:cmd"](null, ms), /builds further commands/); await assert.rejects(hs["mcd:cmd"](null, pw), /builds further commands/); assert.deepEqual(sent, []);
});

// ---- 0.19.300: only a real \u escape counts: an escaped backslash before u003b is plain text to the node ----
test("smuggled refuses a real escape only: an even run of backslashes before u003b is plain text", () => {
  const V = require("../main/cmdverb.js"), B = String.fromCharCode(92);
  assert.equal(V.smuggled('send state:{"1":"[a' + B + B + 'u003b]"}'), "", "escaped backslash, then plain u003b");
  assert.match(V.smuggled('send state:{"1":"[a' + B + B + B + 'u003b]"}'), /escape code/, "an escaped backslash, then a real escape");
  assert.match(V.smuggled('send state:{"1":"[a' + B + 'u003B]"}'), /escape code/);
  assert.match(V.smuggled('send state:{"1":"' + B + 'u000a"}'), /escape code/);
  assert.equal(V.smuggled('send state:{"1":"caf' + B + 'u00e9"}'), "");
});

// ---- 0.19.302: the node log scrubs a privatekey: in its Mx form too ----
test("the node log hides privatekey: whether written 0x… or Mx…", () => {
  const NL = require("../main/nodelog.js");
  for (const pk of ["0x1234ABCD", "MxG081PTR905VTUGBKY7KHKV76QVHE99BM691QNC09GP2WPCG1P0QZTHD8SWWVQ"]) {
    const line = NL.scrub("cmd: signfrom id:a data:0x01 privatekey:" + pk + " keyuses:3");
    assert.ok(!line.includes(pk) && line.includes("privatekey:•••") && line.includes("keyuses:3"), line);
  }
});

// ---- 0.19.303: a UNC path in a file parameter is refused (a Windows node would connect to that share) ----
test("a file parameter on another computer (\\\\host\\share or //host/share) is refused; a local or drive path is not", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ["reset action:chainsync archivefile:" + B + B + "evil" + B + "share" + B + "a.gz", "archive action:import file://evil/share/a.gz", "backup file:" + B + B + "host" + B + "s" + B + "b.bak", "mysql action:reset file:" + B + B + "h" + B + "x"])
    await assert.rejects(hs["mcd:cmd"](null, c), /A file on another computer/, c);
  assert.deepEqual(sent, []);
  for (const c of ["backup file:/Users/me/b.bak", "backup file:C:" + B + "b.bak", "archive action:export file:/x/a.gz"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
});

// ---- 0.19.306: several secret words are said as a count, so a 24-word restore still fits the Touch ID prompt (as the released 0.18.230) ----
test("a 24-word restore is armed with Touch ID: its phrase is said as a count within the prompt's 120 characters", async () => {
  const phr24 = Array.from({ length: 24 }, (_, i) => "word" + i).join(" ");
  const sys = os({ can: true }), g = G.create(sys);
  await g.open('vault action:restorekeys phrase:"' + phr24 + '"', "CHANGE KEYS");
  assert.equal(sys.asked.length, 1, "Touch ID was asked, not refused for length");
  const why = String(sys.asked[0]); assert.ok(why.includes('vault action:restorekeys phrase:"••• (24 words)"') && why.length <= 120 && !why.includes("word0"), why);
  const mm = G.masked('megammrsync action:resync host:megammr.example:9001 phrase:"' + phr24 + '" keyuses:1000');
  assert.equal(mm, 'megammrsync action:resync host:megammr.example:9001 phrase:"••• (24 words)" keyuses:1000');
  assert.ok(("show a seed phrase by running: " + mm).length <= 120, "a 24-word megammrsync restore fits the prompt too");
  assert.equal(G.masked('vault action:passwordunlock password:"one"'), "vault action:passwordunlock password:•••", "one word stays •••");
});

// ---- 0.19.307: signfrom / postfrom paste the id of the transaction in data: into the commands they run: it must be plain ----
test("a signfrom or postfrom whose transaction id carries a second command is refused through mcd:cmd; a plain one runs; the app's own commands are held to it", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const blob = (id, extra = "00000000") => { const b = Buffer.from(id, "utf8"), l = Buffer.alloc(4); l.writeInt32BE(b.length); return "0x" + Buffer.concat([l, b, Buffer.from(extra, "hex")]).toString("hex").toUpperCase(); };
  const evil = blob("x;send address:0x" + "E".repeat(64) + " amount:100"), pk = " privatekey:0x" + "1".repeat(64) + " keyuses:3";
  const bad = ["postfrom data:" + evil, "signfrom data:" + evil + pk, "postfrom data:0x0011", "postfrom data:0x7FFFFFFF00", "postfrom data:MxG081PTR905VTUGBKY7KHKV76QVHE99BM691QNC09GP2WPCG1P0QZTHD8SWWVQ", "postfrom data:" + blob("a b"),
    "signfrom data:" + blob("ok") + ' id:"a b"' + pk];
  for (const c of bad) await assert.rejects(hs["mcd:cmd"](null, c), /must be 0x hex holding a transaction whose id is plain/, c);
  assert.deepEqual(sent, []);
  for (const c of ["postfrom data:" + blob("txn_1.a-b") + " mine:false", "signfrom data:" + blob("abc") + pk]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
  assert.throws(() => V.oneCommand("postfrom data:" + evil), /whose id is plain/, "a command the app builds is held to it too");
});

// ---- 0.19.308: a state value that is an array or object brings its own quotes into the txnstate a builder pastes it into ----
test("a builder's state value that is an array or object is refused through mcd:cmd; strings, numbers and booleans run; rawfrom and rawtxnfrom are sensitive verbs", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ['sendfrom fromaddress:0x01 address:0x02 amount:1 script:"RETURN TRUE" privatekey:0x03 keyuses:1 state:{"1":[["]"],"[] port:9 value:[x"]} mine:false',
    'rawfrom inputs:[{"coinid":"0x01"}] outputs:[{"address":"0x02","amount":"1"}] state:{"1":["]",["] port:9 value:[x"]]}', 'rawtxnfrom inputs:[{"coinid":"0x01"}] outputs:[] scripts:[] state:{"1":{"a":1}}'])
    await assert.rejects(hs["mcd:cmd"](null, c), /builds further commands|differently from how it is written/, c);
  assert.deepEqual(sent, []);
  for (const v of ["rawfrom", "rawtxnfrom", "constructfrom", "createfrom", "postfrom", "txnauto"]) assert.match(V.unclear(v + ' x:"a"b'), /differently from how it is written/, v);
  const ok = 'sendfrom fromaddress:0x01 address:0x02 amount:1 script:"RETURN TRUE" privatekey:0x03 keyuses:1 state:{"1":"hello","2":5,"3":true} mine:false';
  sent.length = 0; await hs["mcd:cmd"](null, ok); assert.deepEqual(sent, [ok]);
});

// ---- 0.19.309: a UNC path in a file parameter is refused for every command, and in any mix of slashes ----
test("a file on another computer is refused for every command that reads one, with any mix of slashes", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const unc = B + B + "evil" + B + "s" + B + "x.txn";
  for (const c of ["txnimport file:" + unc, "txnexport id:a file:" + unc, "txnview file:" + unc, "hash file:" + unc, "peers action:publish file:" + unc, "sendview file:" + unc,
    "backup file:/" + B + "evil" + B + "s" + B + "b.bak", "backup file:" + B + "/evil/s/b.bak", "nodecount file://evil/s/n.csv"])
    await assert.rejects(hs["mcd:cmd"](null, c), /A file on another computer/, c);
  assert.deepEqual(sent, []);
  for (const c of ["txnexport id:a file:/Users/me/x.txn", "hash file:C:" + B + "x", "txnimport file:x.txn"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
});

// ---- 0.19.310: builders checked by what they really paste: a rawfrom input's script, a multisig id are not; a multisig file is ----
test("rawfrom's input script and a multisig id are not pasted and pass; a multisig file is pasted and is checked (a drive letter allowed)", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const user = "0x" + "B".repeat(64), att = "0x" + "A".repeat(64);
  for (const c of ['rawfrom inputs:[{"coinid":"0x01","script":"RETURN TRUE"}] outputs:[{"address":"0x02","amount":"1","tokenid":"0x00"}]', 'multisig action:create id:"my pair" amount:10 required:2 publickeys:' + JSON.stringify([user, att]),
    "multisig action:view file:C:" + B + "txns" + B + "a.txn", "multisigread action:view file:/Users/me/a.txn"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
  for (const c of ['multisig action:view file:"a b.txn"', "multisig action:sign file:x:y privatekey:0x01", 'rawfrom inputs:[{"coinid":"0x01 burn:5"}] outputs:[]'])
    await assert.rejects(hs["mcd:cmd"](null, c), /builds further commands/, c);
});

// ---- 0.19.311: a text the node would refuse is masked with the word count too: no surface shows one ••• a word ----
test("masked says several hidden words as a count also for a text the node would refuse (a word with no ':')", () => {
  const phr24 = Array.from({ length: 24 }, (_, i) => "word" + i).join(" ");
  const m = G.masked("megammrsync action:resync host:megammr.example:9001 phrase:" + phr24 + " keyuses:1000");
  assert.equal(m, 'megammrsync action:resync host:megammr.example:9001 phrase:"••• (24 words)" keyuses:1000'); assert.ok(!/••• •••/.test(m));
  assert.equal(G.masked("vault seed : 0xAB extra words action:x"), 'vault seed : "••• (3 words)" action:x', "a name spaced from its ':' too");
  assert.equal(G.masked("vault action:restorekeys phrase:one"), "vault action:restorekeys phrase:•••");
});

// ---- 0.19.315: every verb, parameter name and action value is compared folded, as the node folds them (İ → i, ſ → s, K → k) ----
test("a dotted capital İ (or a long ſ) in an action or a parameter name does not slip past any check: compared folded, as the node does", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  const I = "\u0130";
  for (const c of ["arch" + I + "ve act" + I + "on:" + I + "mport f" + I + 'le:"a b"', "archive action:" + I + "mportraw file:a:b", "archive action:" + I + 'mportold file:"a b"',
    "reset act" + I + "on:seedsync phrase:x", "reset action:restore f" + I + "le:/a/b.bak", "mysql act" + I + "on:reset f" + I + "le:a:b", "vault act" + I + "on:resetkeys",
    "txnimport f" + I + "le:" + B + B + "evil" + B + "s" + B + "x.txn", "backup arch" + I + "vef" + I + "le:" + B + B + "evil" + B + "s" + B + "a.raw", "backup f" + I + "le://evil/s/b.bak"])
    await assert.rejects(hs["mcd:cmd"](null, c), Error, c);
  assert.deepEqual(sent, [], "nothing reached the node");
  assert.equal(R.replacesKeysElsewhere("arch" + I + "ve act" + I + "on:" + I + "mport f" + I + 'le:"a b"'), true, "restore.replacesKeysElsewhere folds the action");
  assert.equal(R.replacesKeysElsewhere("reset act" + I + "on:chainsync f" + I + "le:/a.raw"), false, "chainsync stays allowed, folded too");
  assert.equal(R.backupCommandProblem("backup password:abc conf" + I + "rm:a-b"), "A backup password can hold letters and numbers only.", "a backup password's name is read folded");
  const rpcSrc = SRC("main/rpc.js"), resv = SRC("main/reserve.js");
  assert.ok(!/\/\^resync\$\/i/.test(rpcSrc) && /V\.fold\(V\.paramValue\(part, "action"\) \|\| ""\) === "resync"/.test(rpcSrc), "the resync timeout reads the action folded");
  assert.ok(/const k = V\.fold\(n\)/.test(resv), "reserve reads parameter names folded");
});

// ---- 0.19.317: decryptbackup writes the decrypted wallet to output: — a file on another computer there is refused too ----
test("decryptbackup's output on another computer is refused (the decrypted wallet would be written there); a local output runs", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ["decryptbackup file:b.bak password:x output:" + B + B + "host" + B + "share" + B + "x", "decryptbackup file:b.bak password:x output://host/share/x"])
    await assert.rejects(hs["mcd:cmd"](null, c), /A file on another computer/, c);
  assert.deepEqual(sent, [], "nothing reached the node");
  const ok = "decryptbackup file:b.bak password:x output:/Users/me/plain.bak"; await hs["mcd:cmd"](null, ok).catch(() => {});
  assert.ok(!sent.length || sent[0] === ok, "a local output is not refused by this rule");
});

// ---- 0.19.318: Windows' NT-namespace prefix \??\ (\??\UNC\host\share) is a file on another computer too ----
test("a path with the NT prefix (\\??\\UNC\\host\\share, /??/UNC/…) is refused as a file on another computer; a local path runs", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), B = String.fromCharCode(92), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ["backup file:" + B + "??" + B + "UNC" + B + "host" + B + "share" + B + "b.bak", "backup file:/??/UNC/host/share/b.bak", "txnimport file:" + B + "??/UNC/host/share/x.txn",
    "decryptbackup file:b.bak password:x output:/??" + B + "UNC" + B + "host" + B + "share" + B + "x"])
    await assert.rejects(hs["mcd:cmd"](null, c), /A file on another computer/, c);
  assert.deepEqual(sent, []);
  for (const c of ["txnimport file:/Users/me/x.txn", "txnimport file:C:" + B + "x.txn", "txnimport file:" + B + "x.txn"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
});

// ---- 0.19.319: what a yes let go that fails with the node still running ends the guard's hold: a retry is asked, not refused ----
test("a stop the guard let go that failed with the node still running ends the hold: the retry is asked again (mcd:cmd, mcd:nodeRestart)", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), I = require("../main/inflight.js"), main = SRC("main/main.js"), hs = {};
  const h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes"));
  const node = { state: "running", rpcPort: () => 0 }; let asked = 0, reply = { status: false, error: "wrong password" };
  const stopGuard = I.stopGuard({ running: () => node.state === "running", gather: async () => ({}), ask: async () => { asked++; return true; }, log() {} });   // nothing readable: always asked
  const mayStop = async (ack, action) => { if (!await stopGuard.pass(ack, action)) throw new Error("The node keeps running: nothing was stopped."); };
  const at = main.indexOf("async function held(op"); assert.ok(at > 0, "main has held()");
  const held = new Function("stopGuard", "node", main.slice(at, main.indexOf("\n}\n", at) + 2) + "\nreturn held;")(stopGuard, node);
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", "held", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async () => reply },
    node, { rpcSecret: () => "" }, async (run, c) => c, mayStop, held);
  const cmd = "archive action:import file:/Users/me/a.raw";   // ends by stopping the node: asked first
  assert.equal((await hs["mcd:cmd"](null, cmd)).status, false, "the node refused it and kept running");
  assert.equal((await hs["mcd:cmd"](null, cmd)).status, false, "the retry is asked again, not refused for 30 s"); assert.equal(asked, 2);
  reply = { status: true }; await hs["mcd:cmd"](null, cmd); assert.equal(asked, 3);
  await assert.rejects(hs["mcd:cmd"](null, cmd), /already being stopped or restarted/, "a stop that went through still holds until the node has stopped");
  stopGuard.seen("stopped");
  const r0 = main.indexOf('ipcMain.handle("mcd:nodeRestart"'), line = main.slice(r0, main.indexOf("\n", r0));
  new Function("ipcMain", "mayStop", "held", "saveConfigPatch", "node", line)({ handle: (n, f) => { hs[n] = f; } }, mayStop, held, () => { throw new Error("config.json could not be written"); }, node);
  await assert.rejects(hs["mcd:nodeRestart"](null, null, { heap: 2048 }), /could not be written/);
  await assert.rejects(hs["mcd:nodeRestart"](null, null, { heap: 2048 }), /could not be written/, "a settings save that threw: the retry is asked, not refused");
  assert.equal(asked, 5);
});

// ---- 0.19.320: a multisig file with a drive letter and forward slashes (C:/dir/x.txn) is a Windows path, not a pasted ":" ----
test("multisig's file C:/dir/x.txn (a drive letter with forward slashes) runs; a ':' elsewhere is still refused", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {}, sent = [];
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async (p, s, c) => { sent.push(c); return { status: true }; } },
    { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c, async () => {});
  for (const c of ["multisig action:view file:C:/dir/x.txn", "multisigread action:view file:d:/a/b.txn"]) { sent.length = 0; await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c); }
  for (const c of ["multisig action:view file:C:/dir/x:y.txn", "multisig action:view file:dir/C:/x.txn"]) await assert.rejects(hs["mcd:cmd"](null, c), /builds further commands/, c);
});

// ---- 0.19.325 / 0.19.329: keyuses: per kind of command: one signature at that use (262143), every key's uses set (250000), added (10000);
// a block key wallet: the chain's tip plus 10000 (the classic setting bound when the tip cannot be read). Changed on purpose in 0.19.329 ----
test("keyuses: one signature at most 262143; a figure given to every key at most 250000 (restoresync 10000); block: the tip plus 10000; digits only; refused before the node", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js");
  assert.deepEqual([R.KEYUSES_ONE_SIGNATURE, R.KEYUSES_SET, R.KEYUSES_ADD, R.KEYUSES_TIP_MARGIN], [262143, 250000, 10000, 10000]);
  const MEGA = "megammrsync action:resync host:h:1 phrase:\"a b\" keyuses:";
  for (const v of ["250001", "262143", "300000", "4294967296", "250000abc", "1.5", "-1", "1e3", ""]) assert.match(R.keyusesProblem(MEGA + v, "classic"), /keyuses: gives every key of this wallet its uses .*\(the node's own default is 100 to 1000 by command; keys createallkeys has none\), at most 250000\. A figure near a key's 262144 one-time uses leaves keys that run out after a few signatures and then sign with one-time keys again/, v);
  for (const c of [MEGA + "250000", "vault action:restorekeys keyuses:250000", "keys action:createallkeys keyuses:250000", "restoresync file:x keyuses:10000"]) assert.equal(R.keyusesProblem(c, "classic"), "", c);
  for (const c of ["vault action:restorekeys keyuses:250001", "keys action:createallkeys keyuses:262143", "archive action:resync host:h:1 keyuses:262143", "mysql action:resync keyuses:262143"]) assert.match(R.keyusesProblem(c, "classic"), /at most 250000/, c);
  assert.match(R.keyusesProblem("restoresync file:x keyuses:10001", "classic"), /restoresync adds it to them\): .* at most 10000\./);
  for (const v of ["sendfrom", "signfrom", "consolidatefrom", "createtokenfrom", "txnsign"]) {
    for (const m of ["classic", "", undefined, "mixed"]) assert.equal(R.keyusesProblem(v + " keyuses:262143", m), "", v + ": 262143 is the last use of one signature (" + m + ")");
    assert.match(R.keyusesProblem(v + " keyuses:262144", "classic"), /a whole number from 0 to 262143/, v);
  }
  assert.match(R.keyusesProblem("status;sendfrom KEYUSES:300000", "classic"), /0 to 262143/, "any piece, the name folded");
  // a block key wallet: the tip plus 10000 for every kind; restoresync 10000; the tip unread: the classic setting bound
  for (const c of [MEGA + "2410000", "sendfrom keyuses:2410000", "vault action:restorekeys keyuses:2410000"]) {
    assert.equal(R.keyusesProblem(c, "block", 2400000), "", c);
    assert.match(R.keyusesProblem(c.replace("2410000", "2410001"), "block", 2400000), /block key wallet raises the floor under the block number for every key: at most 2410000, the chain's tip \(block 2400000\) plus 10000/, c);
    assert.match(R.keyusesProblem(c.replace("2410000", "268435454"), "block", 2400000), /at most 2410000/, "268435454 would exhaust every key after one signature");
    assert.match(R.keyusesProblem(c.replace("2410000", "250001"), "block", null), /could not be read now, so at most 250000 is taken/, c);
  }
  assert.match(R.keyusesProblem("restoresync file:x keyuses:10001", "block", 2400000), /at most 10000\./);
  const main = SRC("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes"));
  for (const [mode, tipReply] of [["classic", null], ["block", { status: true, response: { block: "2400000" } }], ["block", null]]) {
    const hs = {}, sent = [];
    new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", "held", h)(
      { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async (c) => { sent.push(c); return { status: true }; },
      { rpcCall: async (p, s, c) => { if (c === "block") { if (tipReply) return tipReply; throw new Error("timed out"); } sent.push(c); return { status: true }; } },
      { rpcPort: () => 0 }, { rpcSecret: () => "", load: () => ({ keyMode: mode }) }, async (run, c) => c, async () => {}, (op) => op());
    const set = mode === "classic" || !tipReply ? 250000 : 2410000, one = mode === "classic" ? 262143 : set;
    for (const c of [MEGA + (set + 1), "vault action:restorekeys phrase:\"a b\" keyuses:" + (set + 1), "keys action:createallkeys keyuses:" + (set + 1),
      "sendfrom fromaddress:0x01 address:0x02 amount:1 script:\"RETURN SIGNEDBY(0x03)\" privatekey:0x04 keyuses:" + (one + 1), "consolidatefrom fromaddress:0x01 address:0x02 amount:1 script:\"RETURN SIGNEDBY(0x03)\" privatekey:0x04 keyuses:4294967296"])
      await assert.rejects(hs["mcd:cmd"](null, c), /^Error: keyuses: /, mode + ": " + c);
    assert.deepEqual(sent, [], mode + ": nothing reached the node");
    const ok = MEGA.replace('phrase:"a b"', 'phrase:"a b" anyphrase:true') + set;
    await hs["mcd:cmd"](null, ok); assert.deepEqual(sent, [ok], mode + ": within the bound it runs");
  }
});

// ---- 0.19.326: a Terminal stop with no answer (quit, whose own shutdown can cut the connection) keeps the guard's hold; a refusal ends it ----
test("a quit or import whose connection is cut keeps the stop guard's hold; the node's own refusal still ends it; a restart that threw still ends it", async () => {
  const V = require("../main/cmdverb.js"), R = require("../main/restore.js"), I = require("../main/inflight.js"), main = SRC("main/main.js"), hs = {};
  const h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes"));
  const node = { state: "running", rpcPort: () => 0 }; let asked = 0, answer = () => { const e = new Error("socket hang up"); e.code = "ECONNRESET"; throw e; };
  const stopGuard = I.stopGuard({ running: () => node.state === "running", gather: async () => ({}), ask: async () => { asked++; return true; }, log() {} });
  const mayStop = async (ack, action) => { if (!await stopGuard.pass(ack, action)) throw new Error("The node keeps running: nothing was stopped."); };
  const at = main.indexOf("async function held(op"); assert.ok(at > 0);
  const held = new Function("stopGuard", "node", main.slice(at, main.indexOf("\n}\n", at) + 2) + "\nreturn held;")(stopGuard, node);
  new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", "held", h)(
    { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async () => ({}), { rpcCall: async () => answer() },
    node, { rpcSecret: () => "" }, async (run, c) => c, mayStop, held);
  await assert.rejects(hs["mcd:cmd"](null, "quit"), /socket hang up/); assert.equal(asked, 1);
  await assert.rejects(hs["mcd:cmd"](null, "quit"), /already being stopped or restarted/, "no answer: the node may be stopping, the hold stays");
  stopGuard.seen("stopped"); await assert.rejects(hs["mcd:cmd"](null, "archive action:import file:/Users/me/a.raw"), /socket hang up/);
  await assert.rejects(hs["mcd:cmd"](null, "quit"), /already being stopped or restarted/, "an import with no answer too");
  stopGuard.seen("stopped"); answer = () => ({ status: false, error: "wrong password" });
  assert.equal((await hs["mcd:cmd"](null, "archive action:import file:/Users/me/a.raw")).status, false);
  assert.equal((await hs["mcd:cmd"](null, "archive action:import file:/Users/me/a.raw")).status, false, "the node's own refusal ends the hold (0.19.319)"); assert.equal(asked, 4);
  stopGuard.seen("stopped"); assert.equal(await stopGuard.pass(), true); await assert.rejects(held(async () => { throw new Error("config.json could not be written"); }), /could not be written/);
  assert.equal(await stopGuard.pass(), true, "a restart or settings save that threw (no answerOnly) still ends its own hold");
});

// ---- 0.19.327 (the released 0.18.201): every check of mcd:cmd in one function, seedgate.checkCommand, in one order ----
test("checkCommand holds every Terminal check in one order: the first refusal is the one said; the node, the gate and open work are asked in that order and only when reached", async () => {
  const asked = [], io = (o = {}) => ({ running: () => { asked.push("running"); if (o.down) throw new Error("node not running"); }, take: (c) => { asked.push("take"); return !!o.pass; },
    walletWork: async () => { asked.push("work"); return o.work || []; }, keyMode: () => { asked.push("mode"); return o.mode || "classic"; }, tip: async () => { asked.push("tip"); return 2400000; } });
  const said = async (c, o) => { asked.length = 0; try { await G.checkCommand(c, io(o)); return "ok"; } catch (e) { return e.message; } };
  assert.equal(await said(""), "empty command"); assert.equal(await said(null), "empty command"); assert.deepEqual(asked, []);
  assert.match(await said("send\u0001 amount:1 amount:2"), /control character/, "the control character before the repeated amount");
  assert.match(await said("send amount:1 amount:2 file://h/s keyuses:999999999"), /This send names amount more than once/, "the per-piece refusal before keyuses:");
  assert.match(await said("sendfrom keyuses:262144 privatekey:0x01"), /0 to 262143/); assert.deepEqual(asked, ["mode"], "keyuses: reads the key mode, nothing else yet");
  assert.equal(await said("sendfrom keyuses:262144 privatekey:0x01", { mode: "block" }), "ok", "block: within the tip plus 10000 (0.19.329: the test no longer matches a refusal)"); assert.deepEqual(asked, ["mode", "tip", "running"], "the tip is read in block mode for a keyuses:");
  assert.match(await said("sendfrom keyuses:2410001 privatekey:0x01", { mode: "block" }), /at most 2410000/);
  assert.match(await said("vault", { down: true }), /node not running/); assert.deepEqual(asked, ["mode", "running"], "the node before the gate");
  assert.match(await said("vault"), /Type SHOW SEED/); assert.deepEqual(asked, ["mode", "running", "take"]);
  assert.equal(await said("vault", { pass: true }), "ok");
  assert.match(await said('megammrsync action:resync host:h:1 phrase:"a b"', { work: ["1 AtomiX swap is not finished"] }), /AtomiX swap/); assert.deepEqual(asked, ["mode", "running", "work"], "open work is read only for a wallet replacement");
  assert.equal(await said("status"), "ok"); assert.deepEqual(asked, ["mode", "running"], "a plain command: no gate question, no work read");
  assert.match(await said("backup password:a;b"), /letters and numbers only/, "the backup password last");
});

// ---- 0.19.335: the five single-signature verbs by name; any other verb naming keyuses: gets the lower bound (fails closed); "at least" ----
test("keyuses: only txnsign, sendfrom, signfrom, consolidatefrom and createtokenfrom take 262143; any other verb, known or not, takes the setting bound; the sentence says at least", () => {
  const R = require("../main/restore.js");
  for (const v of ["txnsign", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom"]) assert.equal(R.keyusesProblem(v + " keyuses:262143", "classic"), "", v);
  for (const v of ["vault action:restorekeys", "vault action:resetkeys", "keys action:createallkeys", "newverb", "sendfromx", "txnsignall", "send"]) assert.match(R.keyusesProblem(v + " keyuses:250001", "classic"), /at least the times this wallet's keys have already signed \(the node's own default is 100 to 1000 by command; keys createallkeys has none\), at most 250000/, v + ": fails closed");
});

// ---- 0.19.340 (as released 0.18.284): the single-signature bound only when every reading of the verb is one of the five ----
test("keyuses: a loose reading of a single-signature verb (a quoted or glued word) gets the setting bound, never 262143", () => {
  const R = require("../main/restore.js"), V = require("../main/cmdverb.js");
  for (const c of ['"sendfrom"archive keyuses:262143', "sendfrom:x keyuses:262143", '"sendfrom" keyuses:262143 x"y']) {
    if (V.verbs(c).every(v => ["txnsign", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom"].includes(v))) continue;   // not a loose reading after all
    assert.match(R.keyusesProblem(c, "classic"), /at most 250000/, c + ": " + JSON.stringify(V.verbs(c)));
  }
  assert.equal(R.keyusesProblem("sendfrom keyuses:262143", "classic"), "", "a plain reading keeps 262143");
  assert.ok(['"sendfrom"archive keyuses:262143', "sendfrom:x keyuses:262143"].some(c => /at most 250000/.test(R.keyusesProblem(c, "classic"))), "at least one loose reading is tested");
});
