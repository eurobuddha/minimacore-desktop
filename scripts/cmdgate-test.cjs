/*
 * cmdgate-test.cjs — commands that print a seed or a private key run on the general command channel only after a fresh,
 * one-use, main-process gate for that exact command (0.18.173). No node, no network.
 * Run: node --test scripts/cmdgate-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const G = require("../main/cmdgate");
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("which commands are gated: vault (every action), seedrandom (every modifier), keys action:genkey; any case, any place in a chain", () => {
  for (const c of ["vault", "VAULT", "  vault  ", "vault action:seed", "Vault action:wipekeys seed:0x01", "vault action:passwordunlock password:x"]) assert.deepEqual(G.classify(c), { kind: "seed", chain: false }, c);
  for (const c of ["seedrandom modifier:ethbridge", "SEEDRANDOM modifier:\"x\"", "keys action:genkey", "KEYS ACTION:GENKEY", "keys action:\"genkey\" phrase:\"a b\""]) assert.equal(G.classify(c).kind, "key", c);
  for (const c of ["keys", "keys action:list", "keys action:new", "balance", "status", "send amount:1 address:0xAA", "megammrsync action:resync phrase:\"x\" host:h:9001"]) assert.equal(G.classify(c).kind, "", c);
  assert.deepEqual(G.classify("status; vault"), { kind: "seed", chain: true }); assert.deepEqual(G.classify("balance;seedrandom modifier:x;status"), { kind: "key", chain: true });
  assert.equal(G.classify("seedrandom modifier:a;vault").kind, "seed", "the strongest kind in the chain");
});

test("no pass: refused; a pass is for one exact command, once, within 60 s; a chain is never run", async () => {
  let t = 1000; const os = { can: () => false };
  const g = G.create(os, () => t);
  assert.match(G.refusal("vault", g.take), /^GATED:seed: vault, seedrandom and keys action:genkey show a seed or a private key; this one shows the seed phrase\. Type SHOW SEED to run it\.$/);
  assert.match(G.refusal("seedrandom modifier:x", g.take), /^GATED:key:.*Type SHOW KEY/);
  assert.equal(G.refusal("balance", g.take), "", "every other command runs unchanged");
  await assert.rejects(g.arm("vault", "SHOW KEY"), /Type SHOW SEED exactly/);
  await assert.rejects(g.arm("seedrandom modifier:x", "show key"), /Type SHOW KEY exactly/);
  await assert.rejects(g.arm("balance", "SHOW SEED"), /needs no check/);
  await assert.rejects(g.arm("status; vault", "SHOW SEED"), /on its own/);
  assert.match(G.refusal("status; vault", g.take), /^GATED: this chain/, "a chain is refused whatever was passed");
  assert.deepEqual(await g.arm("vault", " SHOW SEED "), { system: false, kind: "seed" });
  assert.equal(G.refusal("vault", g.take), "", "runs once");
  assert.match(G.refusal("vault", g.take), /^GATED:seed:/, "and never again on the same pass");
  await g.arm("vault", "SHOW SEED");
  assert.match(G.refusal("vault action:seed", g.take), /^GATED:seed:/, "a pass is for that exact text only");
  assert.match(G.refusal("vault", g.take), /^GATED:seed:/, "and a mismatched try used it up");
  await g.arm("seedrandom modifier:x", "SHOW KEY"); t += 60001;
  assert.match(G.refusal("seedrandom modifier:x", g.take), /^GATED:key:/, "too late");
  const asked = []; const g2 = G.create({ can: () => true, prompt: async (w) => { asked.push(w); throw new Error("no"); } }, () => t);
  await assert.rejects(g2.arm("vault", "SHOW SEED"), /^Error: Cancelled$/); assert.equal(asked.length, 1, "the system's prompt was asked");
  assert.match(G.refusal("vault", g2.take), /^GATED:seed:/, "a refused prompt leaves no pass");
  const g3 = G.create({ can: () => true, prompt: async () => {} }, () => t);
  assert.deepEqual(await g3.arm("keys action:genkey", "SHOW KEY"), { system: true, kind: "key" }); assert.equal(G.refusal("keys action:genkey", g3.take), "");
});

test("mcd:cmd refuses before anything is sent; the Terminal keeps no gated command or answer; first run reads the seed through the gate", () => {
  const main = rd("main/main.js"), app = rd("renderer/app.js");
  const h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd"'), main.indexOf("});", main.indexOf('ipcMain.handle("mcd:cmd"')));
  assert.ok(/const gated = require\("\.\/cmdgate"\)\.refusal\(command, cmdGate\.take\); if \(gated\) throw new Error\(gated\);\n\s*requireRunning\(\);/.test(h), "the refusal is the handler's first check");
  assert.ok(/ipcMain\.handle\("mcd:cmdGate", \(_e, command, typed\) => cmdGate\.arm\(command, typed\)\);/.test(main));
  assert.equal((main.match(/ipcMain\.handle\("mcd:[A-Za-z]+", (async )?\(_e, (command|cmd)\b/g) || []).length, 2, "mcd:cmd and mcd:cmdGate are the only handlers that take a command text");
  const term = app.slice(app.indexOf("function renderTerminal() {"), app.indexOf("inp.oninput = termSugUpdate;"));
  assert.ok(/if \(gated\) \{ termSecret\(c, gated\[1\]\); return; \}\n\s*TERM_HIST\.push\(c\);/.test(term), "a gated command never reaches the history or the output");
  assert.ok(!/tryCmd\("vault"\)/.test(app), "no screen reads the seed with a plain command");
});

test("the gated answer: shown as text apart from the Terminal, closed after 60 s and when the window is left", async () => {
  const app = rd("renderer/app.js"), i = app.indexOf("\nasync function termSecret("), src = app.slice(i, app.indexOf("\n}\n", i) + 3);
  const E = { html: "", nodes: {}, timers: [], win: {}, doc: {}, appended: [], gate: [], removed: 0 };
  const node = (id) => (E.nodes[id] = E.nodes[id] || { textContent: "", remove() { E.removed++; } });
  const bag = (b) => ({ addEventListener: (n, f) => { b[n] = f; }, removeEventListener: (n, f) => { if (b[n] === f) delete b[n]; } });
  const document = Object.assign({ body: { insertAdjacentHTML: (_w, h) => { E.html += h; } }, hidden: false }, bag(E.doc));
  const fn = new Function("document", "window", "el", "api", "toast", "showPrompt", "appendTerm", "setTimeout", "clearTimeout", src + "\nreturn termSecret;")(
    document, bag(E.win), node, { cmdGate: async (c, t) => { E.gate.push([c, t]); }, cmd: async () => ({ status: true, response: { phrase: "ONE TWO" } }) }, () => {}, async () => "SHOW SEED",
    (s) => E.appended.push(s), (f, ms) => { E.timers.push({ f, ms }); return 0; }, () => {});
  await fn("vault", "seed");
  assert.deepEqual(E.gate, [["vault", "SHOW SEED"]]);
  assert.ok(E.nodes.termSecText.textContent.includes("ONE TWO") && !E.html.includes("ONE TWO"), "the answer is text in one node");
  assert.ok(!E.appended.join().includes("ONE TWO") && !E.appended.join().includes("vault"), "nothing of it reaches the Terminal's output");
  assert.ok(!/copy/i.test(E.html), "no Copy");
  assert.equal(E.timers[0].ms, 60000); E.win.blur(); assert.equal(E.removed, 1, "closed when the window is left");
});

// ---- 0.18.174: the node's own reading of 68 command texts (the release review ran them through minima-core's
// CommandRunner.getCommand: [class:name params] per ";" piece). Every text the node runs as vault, seedrandom or
// keys with a genkey action must be gated; the plain commands must not be. ----
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
    if (mustGate) { gatedByNode++; assert.notEqual(k, "", JSON.stringify(text) + " is run by the node as " + node + " and must be gated"); }
    if (["balance", "keys action:list", "send amount:1 address:0xAA", 'backup password:"x"', 'megammrsync action:resync phrase:"x" host:h:9001'].includes(text)) assert.equal(k, "", text + " is not gated");
  }
  assert.equal(gatedByNode, 46, "46 of the 68 texts are run by the node as a gated command");
  const main = rd("main/main.js");
  assert.ok(/if \(\/\[\\x00-\\x08\\x0b-\\x1f\\x7f\]\/\.test\(command\)\) throw new Error\("This command holds a control character/.test(main), "mcd:cmd refuses a control character first");
});
test("a failed try clears an earlier pass; the refusal names every gated command", async () => {
  const g = G.create({ can: () => false });
  await g.arm("vault", "SHOW SEED");
  await assert.rejects(g.arm("vault", "wrong"), /Type SHOW SEED/);
  assert.match(G.refusal("vault", g.take), /^GATED:seed: vault, seedrandom and keys action:genkey show a seed or a private key/);
});
