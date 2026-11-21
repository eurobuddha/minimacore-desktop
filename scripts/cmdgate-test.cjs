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
  assert.ok(/const ready = await require\("\.\/cmdgate"\)\.checkCommand\(command, \{ take: cmdGate\.take,[^\n]*\n(?:[^\n]*\n){0,2}?\s*return require\("\.\/cmdgate"\)\.scrubReply\(await run\(ready\), command\);[^\n]*\n\}\);/.test(main), "the handler runs only what checkCommand returns (0.18.201), and its reply is scrubbed of the typed secrets (CHANGED on purpose, 0.18.222; 0.18.223 asks the stop guard in between)");
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
  await assert.rejects(g.arm('keys action:list action:genkey', "SHOW KEY"), /names action more than once/);
  // CHANGED on purpose (0.18.219): a quote glued to the next name is a text the node reads otherwise than it looks: refused as unclear
  await assert.rejects(g.arm('keys action:"list"action:genkey', "SHOW KEY"), /differently from how it is written/);
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
  assert.ok(/ipcMain\.handle\("mcd:cmdKind", \(_e, command\) => \{\n[^\n]*k = G\.classify\(c\), shown = G\.masked\(c\);\n[^\n]*write: rpc\.isWrite\(c\), shown, secretValues:/.test(main), "CHANGED on purpose (0.18.222): the kind with the masked text");
  // 0.18.222: a command carrying a secret value is echoed masked and kept out of ↑ history
  const PK = "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD keyuses:5", m2 = make({ [PK]: { kind: "", chain: false, write: true, shown: G.masked(PK), secretValues: true } });
  const p3 = m2.fn(PK); await new Promise(r => setImmediate(r)); m2.E.resolve.forEach(r => r({ status: true })); await p3;
  assert.deepEqual(m2.E.hist, []); assert.equal(m2.E.out[0], "> sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:••• keyuses:5");
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
  assert.equal(G.masked('vault action:restorekeys "phrase" : "a b c" keyuses:5'), 'vault action:restorekeys phrase:"••• (3 words)" keyuses:5', "CHANGED on purpose (0.18.222): shown as the node reads it; 0.18.230: with its word count");
  // 0.18.230: a 24-word phrase is said as a count, so the Touch ID prompt (120 characters) can still show the restore whole
  let tid = ""; const phr24 = Array.from({ length: 24 }, (_, i) => "word" + i).join(" ");
  await G.create(SYS({ can: () => true, prompt: async (r) => { tid = r; } })).arm('vault action:restorekeys phrase:"' + phr24 + '"', "CHANGE KEYS");
  assert.equal(tid, 'make changes to this wallet\'s keys by running: vault action:restorekeys phrase:"••• (24 words)"');
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

// ---- 0.18.214: a name glued after an unquoted secret value is shown ----
test("masked: a secret holding a quote is hidden through the end of the node's token (CHANGED on purpose, 0.18.219)", () => {
  const G = require("../main/cmdgate");
  // the node reads `seed:0xAB"action":"wipekeys"` as ONE seed value and no action (0.18.214 showed an action the node never reads)
  assert.equal(G.masked('vault seed:0xAB"action":"wipekeys"'), "vault seed:•••");
  assert.equal(G.masked('vault password:hunter2"action":"passwordunlock"'), "vault password:•••");
  assert.equal(G.masked('vault action:passwordunlock password:my"secret'), "vault action:passwordunlock password:•••", "no part of a secret holding a quote is shown");
  assert.equal(G.masked('vault action:restorekeys "phrase" : "a b c" keyuses:5'), 'vault action:restorekeys phrase:"••• (3 words)" keyuses:5', "a quoted value is still hidden whole (CHANGED on purpose, 0.18.222: shown as the node reads it; 0.18.230: with its word count)");
});

// ---- 0.18.219 (as Pandamonium Desktop 0.19.266 / 0.19.250 / 0.19.290): one reader of command text, the node's own ----
test("cmdverb.read gives the node's reading of 400 deterministic texts (a table made by an independent port of CommandRunner)", () => {
  const V = require("../main/cmdverb"), { rows } = require("./fixtures/node-command-reading.json");
  assert.equal(rows.length, 400);
  for (const r of rows) {
    const got = V.read(r.c);
    assert.equal(got.verb, r.verb, JSON.stringify(r.c)); assert.equal(!!got.error, r.error, JSON.stringify(r.c));
    if (!r.error) assert.deepEqual(got.params, r.params, JSON.stringify(r.c));
  }
});
test("every check reads what the node reads, and a text read otherwise than it looks is refused for a command that moves funds or keys", async () => {
  const V = require("../main/cmdverb"), { pinMinimaSend } = require("../main/sendpin");
  const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  // a quoted value of only white space hides nothing: the node keeps the last action, and the checks see it
  assert.equal(V.paramValue('vault action:wipekeys password:" " action:seed', "action"), "seed");
  assert.deepEqual(V.repeated('vault action:wipekeys password:" " action:seed'), ["action"]);
  assert.deepEqual(V.repeated('vault action:wipekeys password:"\t" action:seed'), ["action"]);
  await assert.rejects(G.create(SYS({})).arm('vault action:wipekeys password:" " action:seed', "CHANGE KEYS"), /names action more than once|names password: with no value/, "the seed is never shown under CHANGE KEYS (0.18.222: its empty password is refused first)");
  await assert.rejects(G.create(SYS({})).arm('vault action:wipekeys password:x action:seed', "CHANGE KEYS"), /names action more than once/);
  const mx = 'send amount:1 address:0xCD tokenid:0x00 debug:" " tokenid:' + MX;
  assert.equal(V.paramValue(mx, "tokenid"), MX); assert.deepEqual(V.repeated(mx, ["amount", "tokenid", "address", "fromaddress"]), ["tokenid"]);
  const asked = []; assert.equal(await pinMinimaSend(async (c) => { asked.push(c); return { status: true, response: [] }; }, mx), mx, "an MxUSD send is not pinned"); assert.deepEqual(asked, []);
  // the slow path: a { opens JSON even inside quotes, and a name:"…" inside a quoted token is no parameter: the node runs the DEFAULT action (the seed)
  for (const c of ['vault password:"{" action:wipekeys', 'vault confirm:x"phrase: "x"action:wipekeys', 'vault seed:0xAB"action":"wipekeys"']) {
    assert.equal(V.paramValue(c, "action"), null, c); assert.equal(G.classify(c).kind, "seed", c);
    assert.match(V.unclear(c), /differently from how it is written/, c);
    await assert.rejects(G.create(SYS({ confirm: async () => { throw new Error("no question"); } })).arm(c, "SHOW SEED"), /differently from how it is written/, c);
  }
  // plain texts, quoted values and a state's JSON are not refused
  for (const c of ['vault action:passwordunlock password:"my secret"', 'send amount:1 address:0xCD state:{"0":"a b","1":"[x]"}', '"vault" action:seed', "keys action:list", 'backup password:"abc1"', "status"]) assert.equal(V.unclear(c), "", c);
  // mcd:cmd's policy: refused before anything reaches the running check or the pin
  const seen = [], io = { take: () => true, running: () => { seen.push("running"); return true; }, pin: async (c) => { seen.push(c); return c; } };
  for (const c of ['vault seed:0xAB"action":"wipekeys"', 'send amount:1 address:0xCD tokenid:"0x00"tokenid:' + MX, 'txnpost id:a"b'])
    await assert.rejects(G.checkCommand(c, io), /differently from how it is written/, c);
  assert.deepEqual(seen, []);
  assert.equal(await G.checkCommand("balance", io), "balance", "a plain command still runs");
});
test("an empty quoted value (password:\"\") does not hide the parameter after it: the kind, a repeated name and the value are read", () => {
  const V = require("../main/cmdverb");
  for (const c of ['vault password:"" action:wipekeys', 'vault password : "" action:wipekeys', 'vault phrase:"" action:restorekeys']) assert.equal(G.classify(c).kind, "change", c);
  assert.deepEqual(V.paramNames('vault action:seed password:"" action:wipekeys'), ["action", "password", "action"]);
  assert.deepEqual(V.repeated('vault action:seed password:"" action:wipekeys'), ["action"], "the repeat is seen, so the command is refused");
  assert.equal(V.paramValue('send amount:1 address:"" tokenid:0xAB', "tokenid"), "0xAB");
});
test("unclear lets txnstate's quoted [..] value through, as the node reads it; a bracket in quotes elsewhere is still refused", () => {
  const V = require("../main/cmdverb"), c = 'txnstate id:x port:1 value:"[hello world]"';
  assert.equal(V.unclear(c), ""); assert.deepEqual(V.read(c).params, [["id", "x"], ["port", "1"], ["value", "[hello world]"]]);
  for (const bad of ['send amount:1 address:0xA state:"[a b]"', 'vault password:"{" action:wipekeys', 'txnstate id:x port:1 value:"[a" b]']) assert.match(V.unclear(bad), /differently from how it is written/, bad);
});

// ---- 0.18.220 (as Pandamonium Desktop 0.19.281 / 0.19.291 / 0.19.296): values the node pastes into a command it runs itself ----
test("a value the node pastes, unquoted, into its own second command is refused when it would add parameters there; plain values and Windows paths run", async () => {
  const seen = [], io = { take: () => true, running: () => { seen.push("running"); return true; }, pin: async (c) => { seen.push(c); return c; } };
  for (const c of ['reset action:chainsync archivefile:"/Users/me/archive.gz phrase:abc anyphrase:true" keys:[1]', 'archive action:import file:/Users/me/archive.gz keys:"64 phrase:abc anyphrase:true" address:{}',
    'reset action:chainsync archivefile:"C:\\x.gz phrase:abc anyphrase:true"', 'reset action:chainsync archivefile:"x.gz phrase:abc"', 'archive action:importraw file:x keyuses:"5 phrase:a"', 'archive action:importold file:x anyphrase:"true phrase:a"',
    'mysql action:reset file:"x phrase:a"', 'txpow txpowid:"0x01 action:resync phrase:abc"', 'archive action:import file:"/Users/me/My Archive.gz"', "status;reset action:chainsync archivefile:\"a b\"",
    'mysql action:setlogin host:127.0.0.1:3306 database:db user:u password:"x action:resync phrase:a b"']) {
    assert.match(G.repasted(c), /second command it runs itself/, c);
    await assert.rejects(G.checkCommand(c, io), /second command it runs itself|differently from how it is written/, c);   // a ":" inside quotes is refused as unclear first
  }
  assert.deepEqual(seen, [], "nothing reached the node");
  for (const c of ["reset action:chainsync archivefile:/Users/me/archive.gz", "archive action:import file:/Users/me/archive.gz", "txpow txpowid:0x01", "mysql action:reset file:/x/y.dat", "archive action:resync host:h:9001",
    "reset action:chainsync archivefile:C:\\backup\\a.gz", "archive action:import file:D:\\minima\\archive.gz", "mysql action:setlogin host:127.0.0.1:3306 database:db user:u password:secret1",
    'archive action:resync host:h:9001 phrase:"a b c"', 'send amount:1 address:0xA state:{"0":"a b"}'])
    assert.equal(G.repasted(c), "", c);
  assert.equal(await G.checkCommand("reset action:chainsync archivefile:C:\\backup\\a.gz", io), "reset action:chainsync archivefile:C:\\backup\\a.gz");
});

// ---- 0.18.221 (as Pandamonium Desktop 0.19.291): no second command smuggled in through an escape; mds accept and a multisig spend not run ----
test("an escaped semicolon or control character smuggles no second command; mds accept and a multisig spend are not run from the Terminal; ordinary JSON states still run", async () => {
  const V = require("../main/cmdverb"), SC = "\\u003b";
  const sent = [], io = { take: () => true, running: () => true, pin: async (c) => { sent.push(c); return c; } };
  const refused = [
    ['sendfrom fromaddress:0x01 address:0x02 amount:0.0001 script:"RETURN TRUE" privatekey:0x00 keyuses:1 state:{"1":"[a' + SC + 'send address:0xATT amount:500 tokenid:0x00' + SC + 'b]"}', /escape code/],
    ['multisig action:create amount:1 required:1 publickeys:["0x' + SC + 'rpc action:adduser username:a password:b mode:write' + SC + 'xxxx"]', /escape code/],
    ['send amount:1 address:0xA state:{"0":"a\\u000Aphrase:x"}', /escape code/], ['txnstate id:x port:1 value:{"a":"\\u003B"}', /escape code/],
    ["mds action:accept uid:0x01", /mds action:accept runs a MiniDapp's waiting command/], ["multisig action:spend id:abc amount:1 address:0x02", /multisig spend copies the coin's state/], ["multisigread action:spend data:0x01", /multisig spend/],
    ["sendfrom fromaddress:0x01 address:0x02 address:0x03 amount:1 privatekey:0x00 keyuses:1", /names address more than once/], ["sphincs action:transaction amount:1 amount:2", /names amount more than once/],
    ["sendpoll action:list action:remove", /names action more than once/]];
  for (const [c, why] of refused) await assert.rejects(G.checkCommand(c, io), why, c);
  assert.deepEqual(sent, [], "none reached the node");
  for (const c of ['send amount:1 address:0xA state:{"0":"hello"}', 'txnstate id:x port:1 value:"[hello world]"', 'send amount:1 address:0xA state:{"0":"caf\\u00e9"}', "txnoutput id:a amount:1 amount:2"]) { sent.length = 0; await G.checkCommand(c, io); assert.deepEqual(sent, [c], c); }
  await assert.rejects(G.create(SYS({ confirm: async () => { throw new Error("no question"); } })).arm('vault action:seed password:"a' + SC + 'b"', "SHOW SEED"), /escape code/, "refused before the gate asks");
  assert.throws(() => require("../main/rpc").oneCommand('send state:{"1":"' + SC + '"}'), /escape code/, "and for a command the app builds");
  for (const v of ["sphincs", "sendpoll", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom", "multisig", "multisigread"]) assert.match(V.unclear(v + ' x:"a"b'), /differently from how it is written/, v + " is a sensitive verb");
  // no MDS: refused in the extra node arguments, and never passed to either node kind
  const P = require("../renderer/params.js"); assert.equal(P.mdsArg("-mdsenable"), "-mdsenable"); assert.equal(P.mdsArg('-p2pnodes x "-MDSPASSWORD=y"'), "-mdspassword"); assert.equal(P.mdsArg("-test -nop2p"), "");
  assert.ok(rd("main/config.js").includes("const mds = PARAMS.mdsArg(cfg.extraArgs);") && (rd("main/node-manager.js").match(/require\("\.\.\/renderer\/params\.js"\)\.mdsArg\(tok\)/g) || []).length === 2, "config refuses it, both node kinds skip it");
});

// ---- 0.18.222 (as Pandamonium Desktop 0.19.282 / 0.19.292 / 0.19.293): no secret shown; the node's reply scrubbed; asked-for secrets gated ----
const mcdCmd = (reply) => {   // the real mcd:cmd handler from main.js, its node a stand-in
  const main = rd("main/main.js"), h = main.slice(main.indexOf('ipcMain.handle("mcd:cmd", async'), main.indexOf("// Clipboard writes")), hs = {};
  new Function("ipcMain", "require", "cmdGate", "requireRunning", "rpc", "node", "config", "pinMinimaSend", h)(
    { handle: (n, f) => { hs[n] = f; } }, (m) => require(m.replace(/^\.\//, "../main/")), { take: () => true }, () => {}, { rpcCall: async (p, s, c) => reply(c) }, { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, c) => c);
  return hs["mcd:cmd"];
};
test("secrets stay hidden: privatekey: is masked, the command is shown as the node reads it, and the node's reply is scrubbed before the window gets it", async () => {
  assert.equal(G.masked("sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD keyuses:5"), "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:••• keyuses:5");
  assert.equal(G.masked("vault action:restorekeys phrase:spray lamp"), "vault action:restorekeys phrase:•••", "shown as the node reads it, which drops 'lamp'");
  assert.equal(G.masked("megammrsync action:resync host:h:9001 phrase:w1 w2 w3 w4 keyuses:5"), "megammrsync action:resync host:h:9001 phrase:••• ••• ••• ••• keyuses:5", "a piece the node refuses is hidden word by word");
  assert.equal(G.masked("vault phrase: action:restorekeys"), 'vault phrase:"" action:restorekeys', "an empty secret never hides the action");
  assert.equal(G.masked("status;vault password:x action:passwordunlock"), "status ; vault password:••• action:passwordunlock");
  for (const c of ["vault phrase: action:restorekeys", "vault password: action:passwordlock", 'vault action:passwordunlock password:""'])
    await assert.rejects(G.create(SYS({ confirm: async () => { throw new Error("no question"); } })).arm(c, "CHANGE KEYS"), /names (phrase|password): with no value/, c);
  // the reply: "params" at any depth, every "command" string, and each secret word as a whole word elsewhere
  const typed = "vault action:restorekeys phrase:spray lamp keyz:1";
  const r = G.scrubReply({ command: typed, params: { action: "restorekeys", phrase: "spray", keyz: "1" }, status: false, error: "Invalid parameter : keyz", more: ["Invalid parameters for vault @ lamp", "spraying is a word"] }, typed);
  assert.ok(!/\bspray\b|\blamp\b/.test(JSON.stringify(r)), JSON.stringify(r)); assert.equal(r.more[0], "Invalid parameters for vault @ •••"); assert.equal(r.more[1], "spraying is a word", "whole words only");
  const run = mcdCmd((c) => /^backup/.test(c) ? { command: c, params: { password: "hunter22", file: "b.bak" }, status: false, error: "Invalid parameter : foo" }
    : [{ command: "sendfrom", params: { privatekey: "0x1234ABCD", amount: "1" }, status: true, response: { inner: { params: { Phrase: "a b c" } } } }]);
  const b = await run(null, "backup password:hunter22 file:b.bak foo:1");
  assert.deepEqual(b.params, { password: "•••", file: "b.bak" }); assert.equal(b.command, "backup password:••• file:b.bak foo:1"); assert.ok(!JSON.stringify(b).includes("hunter22"));
  const s = JSON.stringify(await run(null, "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD"));
  assert.ok(!s.includes("0x1234ABCD") && !s.includes("a b c") && s.includes('"amount":"1"'), s);
  // the Terminal echo: mcd:cmdKind hands back the masked text, and says the command carried a secret value
  const main = rd("main/main.js"), kh = main.slice(main.indexOf('ipcMain.handle("mcd:cmdKind"'), main.indexOf('ipcMain.handle("mcd:cmd", async')), ks = {};
  new Function("ipcMain", "require", "rpc", kh)({ handle: (n, f) => { ks[n] = f; } }, (m) => require(m.replace(/^\.\//, "../main/")), require("../main/rpc"));
  const k = ks["mcd:cmdKind"](null, "sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0x1234ABCD keyuses:5");
  assert.equal(k.secretValues, true); assert.ok(!k.shown.includes("0x1234ABCD")); assert.equal(ks["mcd:cmdKind"](null, "balance").secretValues, false);
  // and the node's log file: password:, confirm:, seed: values
  const line = require("../main/nodelog").scrub('cmd: backup password:hunter22 confirm:"a b" seed:0xABCD file:x');
  assert.ok(!/hunter22|a b|0xABCD/.test(line) && line.includes("file:x"), line);
});
test("what the user asks for by name is gated like SHOW KEY: rpc action:listusers, mds / mds action:list, sphincs action:generate", async () => {
  for (const c of ["rpc action:listusers", "mds", "mds action:list", "sphincs action:generate seed:abc"]) assert.equal(G.classify(c).kind, "secret", c);
  for (const c of ["mds action:pending", "rpc", "sphincs action:sign data:0x01"]) assert.equal(G.classify(c).kind, "", c);
  assert.match(G.refusal("rpc action:listusers", () => false), /^GATED:secret: .*shows passwords or a private key.*Type SHOW KEY/);
  let why = null; const g = G.create(SYS({ can: () => false, confirm: async (d) => { why = d; return true; } }));
  await assert.rejects(g.arm("rpc action:listusers", "SHOW SEED"), /Type SHOW KEY exactly/);
  assert.deepEqual(await g.arm("rpc action:listusers", "SHOW KEY"), { system: false, kind: "secret" });
  assert.match(why, /^This shows passwords or a private key\. This Terminal command will run once:\n\nrpc action:listusers$/); assert.equal(G.refusal("rpc action:listusers", g.take), "");
  const seen = [], io = { take: () => false, running: () => true, pin: async (c) => { seen.push(c); return c; } };
  await assert.rejects(G.checkCommand("mds", io), /^Error: GATED:secret:/); assert.deepEqual(seen, []);
  const app = rd("renderer/app.js"); assert.ok(app.includes('kind === "secret" ? "This command shows passwords or a private key"'), "the Terminal's prompt names it");
});

// ---- 0.18.228 (as Pandamonium Desktop 0.19.298): what would hand the node to someone else or send its events out is not run from the Terminal ----
test("rpc enable / password / adduser / removeuser, slavenode enable, webhooks add and mds actions are refused; rpc's status and the gated listings are not", async () => {
  const sent = [], h = mcdCmd((c) => { sent.push(c); return { status: true }; });
  for (const c of ["rpc enable:true", "rpc enable:true password:x", "rpc enable:false", "rpc action:adduser username:u password:p mode:write", "rpc action:removeuser username:u", "rpc ssl:true", "rpc action:listusers enable:true",
    "slavenode enable:true host:10.0.0.1:9001", "slavenode enable:false", "webhooks action:add hook:http://x.example/h", "mds action:install file:x.mds.zip", "mds action:publicmds enable:true", "mds action:permission uid:0x01 trust:write", "status;rpc enable:true"])
    await assert.rejects(h(null, c), /open this node to someone else/, c);
  assert.deepEqual(sent, []);
  for (const c of ["rpc", "rpc action:listusers", "mds", "slavenode", "webhooks", "webhooks action:list", "webhooks action:clear", "network action:list"]) { sent.length = 0; await h(null, c); assert.deepEqual(sent, [c], c); }   // the gate stands in as passed (take: true)
  await assert.rejects(G.checkCommand("mds action:pending", { take: () => true, running: () => true }), /open this node to someone else/, "CHANGED on purpose (0.18.228): mds runs only as its gated listing");
});

// ---- 0.18.230 (as Pandamonium Desktop 0.19.299): a value that would rewrite the commands a builder (sendfrom, rawfrom, multisig …) makes from it is refused ----
test("a multisig key carrying JSON, a multi-word password, a raw output with a space and an escaped quote in a state are refused; ordinary builder commands are not", async () => {
  const V = require("../main/cmdverb"), user = "0x" + "B".repeat(64), att = "0x" + "A".repeat(64);
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
  const sent = [], h = mcdCmd((c) => { sent.push(c); return { status: true }; });
  await assert.rejects(h(null, ms), /builds further commands/); await assert.rejects(h(null, pw), /builds further commands/); assert.deepEqual(sent, []);
});
