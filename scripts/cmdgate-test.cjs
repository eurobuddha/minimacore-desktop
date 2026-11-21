/*
 * cmdgate-test.cjs — commands that print a seed or a private key run on the general command channel only after a fresh,
 * one-use, main-process gate for that exact command (0.18.173). No node, no network.
 * Run: node --test scripts/cmdgate-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const SYS = (o) => require("../main/syscheck").create(Object.assign({ can: () => false, prompt: async () => {}, confirm: async () => true, seen: () => false, markSeen: () => {} }, o));   // main/syscheck.js with stand-ins (0.18.176)
const fs = require("fs"), path = require("path");
const G = require("../main/cmdgate");
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("which commands are gated: vault (every action), seedrandom (every modifier), keys action:genkey; any case, any place in a chain", () => {
  for (const c of ["vault", "VAULT", "  vault  ", "vault action:seed"]) assert.deepEqual(G.classify(c), { kind: "seed", chain: false }, c);
  for (const c of ["Vault action:wipekeys seed:0x01", "vault action:passwordunlock password:x"]) assert.deepEqual(G.classify(c), { kind: "change", chain: false }, c + " (CHANGED on purpose, 0.18.196: its own kind, still gated)");
  for (const c of ["seedrandom modifier:ethbridge", "SEEDRANDOM modifier:\"x\"", "keys action:genkey", "KEYS ACTION:GENKEY", "keys action:\"genkey\" phrase:\"a b\""]) assert.equal(G.classify(c).kind, "key", c);
  for (const c of ["keys", "keys action:list", "keys action:new", "balance", "status", "send amount:1 address:0xAA", "megammrsync action:resync phrase:\"x\" host:h:9001"]) assert.equal(G.classify(c).kind, "", c);
  assert.deepEqual(G.classify("status; vault"), { kind: "seed", chain: true }); assert.deepEqual(G.classify("balance;seedrandom modifier:x;status"), { kind: "key", chain: true });
  assert.equal(G.classify("seedrandom modifier:a;vault").kind, "seed", "the strongest kind in the chain");
});

test("no pass: refused; a pass is for one exact command, once, within 60 s; a chain is never run", async () => {
  let t = 1000; const os = { can: () => false };
  const g = G.create(SYS(os), () => t);
  assert.match(G.refusal("vault", g.take), /^GATED:seed: vault, seedrandom and keys action:genkey show a seed or a private key or change the keys; this one shows the seed phrase\. Type SHOW SEED to run it\.$/);
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
  const asked = []; const g2 = G.create(SYS({ can: () => true, prompt: async (w) => { asked.push(w); throw new Error("no"); } }), () => t);
  await assert.rejects(g2.arm("vault", "SHOW SEED"), /^Error: Cancelled$/); assert.equal(asked.length, 1, "the system's prompt was asked");
  assert.match(G.refusal("vault", g2.take), /^GATED:seed:/, "a refused prompt leaves no pass");
  const g3 = G.create(SYS({ can: () => true, prompt: async () => {} }), () => t);
  assert.deepEqual(await g3.arm("keys action:genkey", "SHOW KEY"), { system: true, kind: "key" }); assert.equal(G.refusal("keys action:genkey", g3.take), "");
});

test("mcd:cmd refuses before anything is sent; the Terminal keeps no gated command or answer; first run reads the seed through the gate", () => {
  const main = rd("main/main.js"), app = rd("renderer/app.js");
  const h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd"'), main.indexOf("});", main.indexOf('ipcMain.handle("mcd:cmd"')));
  assert.ok(/const ready = await require\("\.\/cmdgate"\)\.checkCommand\(command, \{ take: cmdGate\.take,[^\n]*\n\s*return run\(ready\);\n\}\);/.test(main), "the handler runs only what checkCommand returns (0.18.201)");
  assert.ok(/ipcMain\.handle\("mcd:cmdGate", \(_e, command, typed\) => \{ requireRunning\(\); return cmdGate\.arm\(command, typed\); \}\);/.test(main), "CHANGED on purpose (0.18.202): the node is checked first");
  assert.equal((main.match(/ipcMain\.handle\("mcd:[A-Za-z]+", (async )?\(_e, (command|cmd)\b/g) || []).length, 3, "mcd:cmd, mcd:cmdGate and mcd:cmdKind (advice only, 0.18.194) are the only handlers that take a command text");
  const term = app.slice(app.indexOf("async function termSubmit(c) {"), app.indexOf("function renderTerminal() {"));
  assert.ok(term.indexOf("termSecret(c, k.kind)") > 0 && term.indexOf("termSecret(c, k.kind)") < term.indexOf("TERM_HIST.push(c)"), "a gated command never reaches the history or the output (CHANGED on purpose, 0.18.194: the kind is asked first)");
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
  assert.match(E.html, /No Touch ID check took place: this computer offered none, so the typed phrase and a confirmation were the only checks\./, "said when the gate did not report Touch ID (0.18.176)");
  assert.ok(/textContent = phrase \+ \(sys \? "" : "\\n\\nNo Touch ID check took place/.test(app), "the first-run seed says so too");
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
  // CHANGED on purpose (0.18.201): mcd:cmd's policy is checkCommand, tested by its behaviour below
});
test("a failed try clears an earlier pass; the refusal names every gated command", async () => {
  const g = G.create(SYS({ can: () => false }));
  await g.arm("vault", "SHOW SEED");
  await assert.rejects(g.arm("vault", "wrong"), /Type SHOW SEED/);
  assert.match(G.refusal("vault", g.take), /^GATED:seed: vault, seedrandom and keys action:genkey show a seed or a private key/);
});

// ---- 0.18.184: the check shows the whole command, and the pass is for exactly that text ----
test("a gated command is shown whole: too long or a repeated parameter is refused (the node keeps the last); the reason says what is shown", async () => {
  for (const mac of [true, false]) {
    let seen = null;
    const g = G.create(SYS({ can: () => mac, prompt: async (r) => { seen = { touchId: r }; }, confirm: async (d) => { seen = { box: d }; return true; } }));
    const hidden = "keys action:list" + " ".repeat(mac ? 70 : 600) + "action:genkey";
    await assert.rejects(g.arm(hidden, "SHOW KEY"), /names action more than once/, "the reviewer's proof: shown as keys action:list, run as genkey");
    assert.equal(seen, null, "nothing was asked"); assert.match(G.refusal(hidden, g.take), /^GATED:key:/, "and it does not run");
    // CHANGED on purpose (0.18.196): only the Touch ID prompt refuses a command too long for it; the dialog shows it whole
    if (mac) await assert.rejects(g.arm("keys action:genkey modifier:" + "x".repeat(100), "SHOW KEY"), /longer than the Touch ID prompt can show in full/);
    for (const dup of ['vault action:seed action:wipekeys', 'keys action:genkey "action":list', 'seedrandom modifier:a modifier : b']) await assert.rejects(g.arm(dup, dup.startsWith("vault") ? "SHOW SEED" : "SHOW KEY"), /more than once/, dup);
    const c = "keys   action:genkey\u202e  modifier:x";
    await g.arm(c, "SHOW KEY");
    const text = mac ? seen.touchId : seen.box;
    assert.ok(text.includes("keys action:genkey modifier:x"), "the whole command, white space collapsed, the bidi control a space: " + JSON.stringify(text));
    assert.ok(mac ? text === "show a private key by running: keys action:genkey modifier:x" : text.startsWith("This shows a private key."), JSON.stringify(text));
    assert.match(G.refusal("keys action:genkey modifier:x", g.take), /^GATED:key:/, "the pass is for the exact original text only");
    await g.arm(c, "SHOW KEY"); assert.equal(G.refusal(c, g.take), "");
  }
});

// ---- 0.18.189: a name glued after a closing quote is its own name ----
test("a parameter name glued after a quoted value counts as a repeat; a key inside JSON does not", async () => {
  const V = require("../main/cmdverb");
  assert.deepEqual(V.repeated('keys action:"list"action:genkey'), ["action"]);
  assert.deepEqual(V.repeated('send amount:1 address:0xA tokenid:"0xFF"tokenid:0x00', ["tokenid"]), ["tokenid"]);
  assert.deepEqual(V.repeated('send amount:1 address:0xA state:{"address":"x","1":"tokenid:0x00"}', ["amount", "tokenid", "address", "fromaddress"]), [], "keys inside a state's JSON are not parameters");
  const g = G.create(SYS({}));
  await assert.rejects(g.arm('keys action:"list"action:genkey', "SHOW KEY"), /names action more than once/);
});

// ---- 0.18.194: the Terminal asks the kind first and echoes an ordinary command at once ----
test("Terminal: an ordinary command is echoed and kept before it returns; a secret one goes to its gate; a gated chain is refused; a second identical send gets a note", async () => {
  const app = rd("renderer/app.js"), a = app.indexOf("const TERM_BUSY = new Set();"), b = app.indexOf("function renderTerminal() {");
  const make = (kinds) => {
    const E = { out: [], hist: [], secret: [], sent: [], resolve: [] };
    const api = { cmdKind: async (c) => kinds[c] || { kind: "", chain: false, write: false },
      cmd: (c) => { E.sent.push(c); return new Promise(r => { E.resolve.push(r); }); } };
    const fn = new Function("api", "appendTerm", "termSecret", "TERM_HIST", "let termIdx = 0;\n" + app.slice(a, b) + "\nreturn termSubmit;")(api, (s) => E.out.push(s), (c, k) => E.secret.push([c, k]), E.hist);
    return { E, fn };
  };
  const SEND = "send amount:1 address:0xAA";
  const { E, fn } = make({ [SEND]: { kind: "", chain: false, write: true }, vault: { kind: "seed", chain: false, write: true }, "status;vault": { kind: "seed", chain: true, write: true } });
  const p1 = fn(SEND); await new Promise(r => setImmediate(r));
  assert.deepEqual(E.out, ["> " + SEND], "echoed at once, before the node answers"); assert.deepEqual(E.hist, [SEND]);
  await fn(SEND); assert.match(E.out[1], /^note: the same command is still running .* Type it again to run it a second time anyway\.$/); assert.equal(E.sent.length, 1, "not sent twice");
  const p2 = fn(SEND); await new Promise(r => setImmediate(r)); assert.equal(E.sent.length, 2, "typed again after the note: it runs");
  E.resolve.forEach(r => r({ status: true })); await p1; await p2;
  await fn("vault"); assert.deepEqual(E.secret, [["vault", "seed"]]); assert.ok(!E.hist.includes("vault") && !E.out.some(l => l.includes("> vault")), "never in the history or the output");
  await fn("status;vault"); assert.match(E.out[E.out.length - 1], /^error: this chain holds vault, seedrandom or keys action:genkey/); assert.ok(!E.hist.includes("status;vault"));
  const main = rd("main/main.js");
  assert.ok(/ipcMain\.handle\("mcd:cmdKind", \(_e, command\) => \{[^\n]*require\("\.\/cmdgate"\)\.classify\(c\);[^\n]*write: rpc\.isWrite\(c\)/.test(main));
});

// ---- 0.18.196: secret values hidden in the check; vault actions that change keys have their own kind; long commands armable ----
test("must be armable: a restore with a 24-word phrase, wipekeys with a seed, long passwords; the check never shows the phrase, seed or password", async () => {
  const phrase = "SPRAY LAMP ABOUT ABOVE ABSENT ABSORB ABSTRACT ABSURD ABUSE ACCESS ACCIDENT ACCOUNT ACCUSE ACHIEVE ACID ACOUSTIC ACQUIRE ACROSS ACT ACTION ACTOR ACTRESS ACTUAL ADAPT";
  const cases = [['vault action:restorekeys phrase:"' + phrase + '"', "change"], ["vault action:wipekeys seed:0x" + "AB".repeat(32), "change"],
    ["vault action:passwordunlock password:" + "p".repeat(44), "change"], ["vault action:passwordlock password:" + "q".repeat(20) + " confirm:" + "q".repeat(20), "change"],
    ["vault action:passwordunlock password:hunter2", "change"], ["vault action:resetkeys", "change"], ["vault", "seed"], ["vault action:seed", "seed"], ["seedrandom modifier:ethbridge", "key"]];
  for (const mac of [false, true]) {
    for (const [c, kind] of cases) {
      let seen = "";
      const g = G.create(SYS({ can: () => mac, prompt: async (r) => { seen = r; }, confirm: async (d) => { seen = d; return true; } }));
      assert.equal(G.classify(c).kind, kind, c);
      const a = await g.arm(c, G.PHRASE[kind]);
      assert.equal(a.kind, kind); assert.equal(G.refusal(c, g.take), "", "the pass is bound to the exact raw text: " + c.slice(0, 40));
      for (const secret of ["SPRAY", "ADAPT", "AB".repeat(32), "p".repeat(44), "q".repeat(20), "hunter2"]) assert.ok(!seen.includes(secret), (mac ? "Touch ID" : "dialog") + " shows no secret: " + seen);
      if (kind === "change") assert.match(seen, mac ? /^make changes to this wallet's keys by running: vault action:\w+/ : /^This makes changes to this wallet's keys\./);
    }
  }
  assert.equal(G.masked('vault action:restorekeys "phrase" : "a b c" keyuses:5'), 'vault action:restorekeys "phrase" : ••• keyuses:5');
  await assert.rejects(G.create(SYS({})).arm("vault action:passwordunlock password:x", "SHOW SEED"), /Type CHANGE KEYS exactly/, "its own typed phrase");
  await assert.rejects(G.create(SYS({})).arm("vault action:restorekeys phrase:a phrase:b", "CHANGE KEYS"), /names phrase more than once/, "repeats are still refused");
  // only the Touch ID prompt, which cannot show more, refuses a command too long for it; the dialog shows it whole
  const long = "keys action:genkey modifier:" + "x".repeat(100);
  await assert.rejects(G.create(SYS({ can: () => true })).arm(long, "SHOW KEY"), /longer than the Touch ID prompt can show in full/);
  let box = ""; await G.create(SYS({ can: () => false, confirm: async (d) => { box = d; return true; } })).arm("keys action:genkey modifier:" + "y".repeat(100), "SHOW KEY");
  assert.ok(box.includes("y".repeat(100)), "the dialog shows the whole command");
});

// ---- 0.18.201: mcd:cmd's policy is one function ----
test("checkCommand: empty, control characters, a repeated send parameter and the gate are refused before the node is asked; then the pin", async () => {
  const io = (o) => Object.assign({ take: () => false, running: () => true, pin: async (c) => c + " fromaddress:0xPIN" }, o);
  const asked = [];
  const track = io({ running: () => { asked.push("running"); return true; }, pin: async (c) => { asked.push("pin " + c); return c + " fromaddress:0xPIN"; } });
  for (const [c, re] of [["", /empty command/], ["   ", /empty command/], [null, /empty command/], ["status\u0001", /control character/], ["send amount:1\u007f address:0xA", /control character/],
    ["send amount:1 address:0xA amount:2", /names amount more than once/], ['send amount:1 address:0xA "address":0xB', /names address more than once/], ["status; send amount:1 address:0xA address:0xB", /names address more than once/],
    ["vault", /GATED:seed:/], ["status;vault", /GATED: this chain/], ["keys action:genkey", /GATED:key:/], ["vault action:passwordunlock password:x", /GATED:change:/]])
    await assert.rejects(G.checkCommand(c, track), re, JSON.stringify(c));
  assert.deepEqual(asked, [], "nothing reached the running check or the pin");
  assert.equal(await G.checkCommand("send amount:1 address:0xA", track), "send amount:1 address:0xA fromaddress:0xPIN");
  assert.equal(await G.checkCommand("balance\ttokenid:0x00", io({ pin: async (c) => c })), "balance\ttokenid:0x00", "tab is allowed");
  await assert.rejects(G.checkCommand("status", io({ running: () => { throw new Error("node not running"); } })), /node not running/);
  const g = G.create(SYS({})); await g.arm("vault", "SHOW SEED");
  assert.equal(await G.checkCommand("vault", io({ take: g.take, pin: async (c) => c })), "vault", "a passed gate runs, once");
  await assert.rejects(G.checkCommand("vault", io({ take: g.take })), /GATED:seed:/);
});
