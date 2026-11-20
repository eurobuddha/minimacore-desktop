// The commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026): `vault` and `seedrandom` reach the
// node from a window only after the phrase typed for that exact command and the system's prompt (main/seedgate.js), once,
// within a minute. Nothing here reaches a node: `run` is a recording stand-in.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const G = require("../main/seedgate.js");
const SRC = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const VECTORS = [["vault", "seed"], ["VAULT action:seed", "seed"], ["  Vault  action:wipekeys", "seed"], ["vault action:passwordlock password:x", "seed"], ["balance;vault", "seed"], ["balance ; VaUlT", "seed"],
  ["seedrandom modifier:ethbridge", "key"], ["SEEDRANDOM", "key"], ["status;seedrandom modifier:x", "key"], ["seedrandom;vault", "seed"],
  ["keys action:genkey", "key"], ["KEYS Action:GenKey", "key"], ["status; keys action:\"genkey\"", "key"], ["keys action:list", null], ["keys", null], ["keys action:genkeys", null], ["keys publickey:genkey", null],
  ["vaults", null], ["balance vault", null], ["send amount:1 address:vault", null], ["", null], ["status", null], ["seedrandomx", null], [";;", null]];
const os = (o) => { const asked = []; return { asked, can: () => !!o.can, prompt: async (why) => { asked.push(why); if (o.refuse) throw new Error("no"); } }; };

test("which commands are gated: vault (any action) and seedrandom (any modifier), in any case, anywhere in a ; chain; nothing else", () => {
  for (const [c, k] of VECTORS) assert.equal(G.secretKind(c), k, JSON.stringify(c));
  // the Terminal decides the same way before it asks (renderer/app.js termSecretKind)
  const app = SRC("renderer/app.js"), fn = app.match(/function termSecretKind\(c\) \{[^\n]*\}/)[0];
  const termSecretKind = new Function(fn + "; return termSecretKind;")();
  for (const [c] of VECTORS) assert.equal(termSecretKind(c), G.secretKind(c), "the window and main agree: " + JSON.stringify(c));
});

test("the gate: the phrase for the kind, then the system's prompt, then that exact command once within a minute", async () => {
  let now = 1000; const sys = os({ can: true }), g = G.create(sys, () => now);
  assert.equal(g.take("vault"), false, "nothing passes before the gate was opened");
  await assert.rejects(g.open("vault", "show seed"), /Type SHOW SEED exactly to continue\./); assert.deepEqual(sys.asked, [], "a wrong phrase: no system prompt");
  await assert.rejects(g.open("vault", "SHOW KEY"), /SHOW SEED/); await assert.rejects(g.open("seedrandom modifier:x", "SHOW SEED"), /Type SHOW KEY exactly/);
  await assert.rejects(g.open("balance", "SHOW SEED"), /This command needs no check\./);
  assert.equal(g.take("vault"), false, "a refused open leaves no pass");
  assert.deepEqual(await g.open("vault", " SHOW SEED "), { system: true }); assert.deepEqual(sys.asked, ["show the wallet's seed phrase"]);
  assert.equal(g.take("vault action:seed"), false, "another command: refused, and the pass is spent");
  assert.equal(g.take("vault"), false);
  await g.open("vault", "SHOW SEED"); assert.equal(g.take("vault"), true, "the exact command, once"); assert.equal(g.take("vault"), false, "single use");
  await g.open("seedrandom modifier:a", "SHOW KEY"); now += G.PASS_MS + 1; assert.equal(g.take("seedrandom modifier:a"), false, "not after a minute");
  await g.open("seedrandom modifier:a", "SHOW KEY"); now += G.PASS_MS; assert.equal(g.take("seedrandom modifier:a"), true, "within it");
  const refusing = G.create(os({ can: true, refuse: true }));
  await assert.rejects(refusing.open("vault", "SHOW SEED"), /^Error: Cancelled$/); assert.equal(refusing.take("vault"), false, "a refused system prompt leaves no pass");
  const none = G.create(os({ can: false })); assert.deepEqual(await none.open("vault", "SHOW SEED"), { system: false }, "no system prompt here: said as such");
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
  assert.ok(/^ipcMain\.handle\("mcd:cmd", async \(_e, command\) => \{\n  if \(typeof command !== "string" \|\| !command\.trim\(\)\) throw new Error\("empty command"\);\n  requireRunning\(\);\n  if \(seedgate\.secretKind\(command\) && !secretGate\.take\(command\)\) throw new Error\("vault and seedrandom show what controls your funds/.test(h), "the first thing the handler checks");
  assert.ok(/ipcMain\.handle\("mcd:secretGate", \(_e, command, typed\) => \{ requireRunning\(\); return secretGate\.open\(command, typed\); \}\);/.test(main));
  assert.ok(/if \(!firstRunOpen \|\| c\.walletDone \|\| c\.walletMode !== "new"\) throw new Error\("The seed is shown here only while a new wallet is being made\."\);/.test(main) && /if \(c\.walletDone\) firstRunOpen = false;/.test(main), "the first-run seed: only in that step");
  assert.equal((main.match(/"vault"/g) || []).length, 1, "main asks for the vault in one place of its own (the first-run step); the reveal is in seedgate.js");
  // the window: no command of its own asks for the vault; the Terminal keeps no secret command and no secret reply
  for (const f of fs.readdirSync(path.join(__dirname, "..", "renderer")).filter(x => x.endsWith(".js"))) {
    const s = SRC("renderer/" + f); assert.ok(!/(cmd|tryCmd)\(\s*["'`](vault|seedrandom)/i.test(s), f + " asks the node for a secret directly");
  }
  const app = SRC("renderer/app.js"), run = app.slice(app.indexOf("async function termRun()"), app.indexOf("function renderTerminal()"));
  assert.ok(run.indexOf("if (secret) {") < run.indexOf("TERM_HIST.push(c)") && /secretReveal\(c, JSON\.stringify\(r, null, 2\), !!\(g && g\.system\)\);[^\n]*\n\s*\}\);\n\s*return;\n\s*\}/.test(run), "a secret command returns before the history and the output");
  assert.ok(/appendTerm\(c\.split\(\/\\s\+\/\)\[0\], "cmd"\)/.test(run), "only its verb is shown in the output");
  const reveal = app.slice(app.indexOf("function secretReveal("), app.indexOf("// Export: the phone asks"));
  assert.ok(!/appendTerm|TERM_ITEMS|clip|copy\(/.test(reveal) && /setTimeout\(end, 60000\)/.test(reveal) && /window\.addEventListener\("blur", end\)/.test(reveal), "the reply: never in the output or a copy, gone after a minute and on blur");
  assert.ok(/\$\("bkShow"\)\.onclick = \(\) => secretAsk\("seed", t\("Show seed phrase"\), async \(typed\) => \{\s*const r = await api\.revealSeed\(typed\);\s*secretReveal\(t\("Seed phrase"\), r\.phrase, r\.system\);/.test(app), "Show seed phrase goes through the same gate");
});
