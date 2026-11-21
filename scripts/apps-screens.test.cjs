// Terminal, Logs and the Apps tab's Freeze (Phase 5a). Executed where the logic is pure; nothing here reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const R = (f) => { const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); return /^renderer\/[^/]+\.js$/.test(f) ? require("./i18n-plain.cjs").plain(s) : s; };   // a renderer script: as it read before its text was wrapped for translation
const app = R("renderer/app.js"), html = R("renderer/index.html"), mainJs = R("main/main.js");
// a one-line definition, or a block that ends at the first "}" in column 0 (as scripts/wallet-money-test.cjs)
function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  const code = m[1].replace(/\s+\/\/.*$/, "");
  return /\{$/.test(code) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
const lift = (names, extra) => new Function((extra || "") + names.map(source).join("\n") + "\nreturn { " + names.join(", ") + " };")();

// ---- Terminal ----
test("Terminal: Pandamonium's screen (banner, output, command field, Run) with the desktop's completion kept", () => {
  const view = html.slice(html.indexOf('id="view-terminal"'), html.indexOf('id="view-logs"'));
  for (const id of ["termBanner", "termOut", "termIn", "termRun", "termSug", "termHint"]) assert.ok(view.includes('id="' + id + '"'), id);
  assert.ok(/placeholder="Enter command"/.test(view) && />Run</.test(view));
  assert.ok(view.indexOf('id="termOut"') < view.indexOf('id="termIn"'), "the output is above the field");
  const TERM_BANNER = new Function("return " + app.slice(app.indexOf("const TERM_BANNER = ") + 20, app.indexOf("];", app.indexOf("const TERM_BANNER = ")) + 1))();
  assert.deepEqual(TERM_BANNER, ["**********************************************", "*  __  __  ____  _  _  ____  __  __    __    *", "* (  \\/  )(_  _)( \\( )(_  _)(  \\/  )  /__\\   *",
    "*  )    (  _)(_  )  (  _)(_  )    (  /(__)\\  *", "* (_/\\/\\_)(____)(_)\\_)(____)(_/\\/\\_)(__)(__) *", "*                                            *", "**********************************************"], "TerminalView's banner, line for line");
  assert.ok(TERM_BANNER.every(l => l.length === 46));
  assert.ok(/Welcome to Minima Core /.test(app) && /You can run commands in this Terminal\.\./.test(app));
  assert.ok(/TermComplete\.suggest/.test(app) && /termSugAccept/.test(app), "completion is still wired");
  const term = app.slice(app.indexOf("// ---- Terminal: Pandamonium's TerminalView"), app.indexOf("// ---- Settings ------"));
  assert.ok(!/innerHTML/.test(term), "the Terminal's output is never written as HTML: a reply can carry any text");
});
test("Terminal: JSON is coloured by kind, and the text is exactly the text", () => {
  const { termJsonParts } = lift(["termJsonParts"]);
  const text = JSON.stringify({ command: "status", status: true, pending: false, n: -1.5e3, nothing: null, error: "it failed", list: ["a\"b", 2], html: "<img src=x onload=alert(1)>" }, null, 2);
  const parts = termJsonParts(text);
  assert.equal(parts.map(p => p[1]).join(""), text, "no character is added, dropped or changed");
  const of = (cls) => parts.filter(p => p[0] === cls).map(p => p[1]);
  assert.deepEqual(of("j-key"), ['"command"', '"status"', '"pending"', '"n"', '"nothing"', '"error"', '"list"', '"html"']);
  assert.deepEqual(of("j-str"), ['"status"', '"a\\"b"', '"<img src=x onload=alert(1)>"']);
  assert.deepEqual(of("j-bool"), ["true"]); assert.deepEqual(of("j-null"), ["null"]); assert.deepEqual(of("j-num"), ["-1500", "2"]);
  assert.deepEqual(of("j-err"), ["false", '"it failed"'], "false and failure words in red, as mds/terminalIDE");
  const css = R("renderer/apps.css");
  for (const [cls, dark] of [["key", "#6ea8fe"], ["str", "#7ee787"], ["num", "#f0a45d"], ["bool", "#d2a8ff"], ["null", "#7f909e"], ["err", "#ff6b6b"]]) assert.ok(css.includes("--t-" + cls + ": " + dark), "terminalIDE's " + cls + " colour in dark");
  assert.ok(/prefers-color-scheme: light\) \{ #view-terminal \{ --t-cmd:/.test(css), "darker inks on the light theme");
});
test("Terminal: a typed send leaves the coin guard byte for byte in the default (observe) mode, whatever is held", async () => {
  const { createRegistry } = require("../main/reserve"), { makeNode, coinId, ADDR } = require("./reserve-model.cjs");
  const node = makeNode([{ coinid: coinId(1), amount: "100", address: ADDR(1) }, { coinid: coinId(2), amount: "50", address: ADDR(2) }]), lines = [];
  const reg = createRegistry({ log: (l) => lines.push(l) });
  assert.deepEqual(reg.mode(), { on: true, sends: "observe" });
  reg.setHolds("dexicon", [{ coinid: coinId(1), why: "a live Dexicon order" }]);
  for (const typed of ["send amount:40 address:" + ADDR(7), "SEND  amount:1.50   address:" + ADDR(7) + " tokenid:0x00 burn:0.01", "send amount:500 address:" + ADDR(7),
    'send amount:1 address:' + ADDR(7) + ' state:{"0":"a b","1":"0xFF"}', "send amount:1 address:" + ADDR(7) + " fromaddress:" + ADDR(1)]) {
    const r = await reg.guard("", typed, node.run);   // owner "" = the wallet: what the Terminal's commands are
    assert.notEqual(r && r.reserved, true, "not refused by the guard: " + typed);
    assert.equal(node.saw(/^send\b/i).pop(), typed, "byte-identical");
    node.dropMempool();
  }
  assert.ok(lines.some(l => /^observe: `send` of wallet WOULD HAVE BEEN/.test(l)), "what Enforce would have done is logged, nothing more");
});
test("Terminal: what CAN be added to a typed MINIMA send is the old beacon-dust pin, and the Terminal says so; restores stay refused", async () => {
  const { pinMinimaSend } = require("../main/sendpin"), A = "0x" + "AB".repeat(32);
  const run = async (c) => (c.startsWith("coins ") ? { status: true, response: [{ coinid: "0x01", amount: "5", address: A }] } : c.startsWith("checkaddress") ? { status: true, response: { simple: true } } : { status: true });
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD", { minCoinage: 3 }), "send amount:1 address:0xCD fromaddress:" + A, "main.js adds fromaddress: to a MINIMA send that names none (0.16.x, unchanged here)");
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD fromaddress:0xEE", { minCoinage: 3 }), "send amount:1 address:0xCD fromaddress:0xEE", "the user's own fromaddress: is left alone");
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD tokenid:0x7D39", { minCoinage: 3 }), "send amount:1 address:0xCD tokenid:0x7D39", "a token send is left alone");
  const { termSendNote } = lift(["termSendNote"]);
  assert.match(termSendNote("send amount:1 address:0xCD"), /^note: a MINIMA send with no fromaddress: may be given one/);
  assert.match(termSendNote("SEND amount:1 address:0xCD tokenid:0x00"), /^note:/);
  assert.equal(termSendNote("send amount:1 address:0xCD fromaddress:0xEE"), ""); assert.equal(termSendNote("send amount:1 address:0xCD tokenid:0x7D39"), ""); assert.equal(termSendNote("status"), ""); assert.equal(termSendNote("sendpoll action:list"), "");
  { const h = mainJs.slice(mainJs.indexOf('ipcMain.handle("mcd:cmd"'), mainJs.indexOf("// Clipboard writes")), g = fs.readFileSync(path.join(__dirname, "..", "main", "seedgate.js"), "utf8"), chk = g.slice(g.indexOf("async function checkCommand("));
    const a = chk.indexOf("R.loadsBackupFile(command)"), b = chk.indexOf("R.backupCommandProblem(command)"), c = h.indexOf("await seedgate.checkCommand(command, "), d = h.indexOf("pinMinimaSend(run, command,");
    // changed on purpose (0.19.327): read in order inside seedgate.js checkCommand, which mcd:cmd calls before anything is sent
    assert.ok(a > 0 && b > a && c > 0 && d > c, "restore, restoresync and megammrsync file: are still refused on the command channel (read in order inside mcd:cmd since 0.19.298, not by a window)"); }
  assert.ok(/const run = \(c\) => \(stops \? \(f\) => held\(f, true\) : \(f\) => f\(\)\)\(\(\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\)\);/.test(mainJs), "a Terminal command goes through rpcCall (signing queue and coin guard) as the wallet");
});
test("Terminal (0.19.122): a chain is never pinned; the note agrees with the main process on what a MINIMA send is", async () => {
  const { pinMinimaSend, pinSend } = require("../main/sendpin"), A = "0x" + "AB".repeat(32); let asked = 0;
  const run = async (c) => { asked++; return c.startsWith("coins ") ? { status: true, response: [{ coinid: "0x01", amount: "5", address: A }] } : c.startsWith("checkaddress") ? { status: true, response: { simple: true } } : { status: true }; };
  for (const chain of ["send amount:1 address:0xCD; status", "send amount:1 address:0xCD;send amount:2 address:0xEF", "send amount:1 address:0xCD tokenid:0x00 ; balance"]) {
    asked = 0;
    assert.equal(await pinMinimaSend(run, chain, { minCoinage: 3 }), chain, "sent as typed: no fromaddress: on the last command of the chain");
    assert.equal(asked, 0, "and no coin is looked up for it");
  }
  const { termSendNote } = lift(["termSendNote"]);
  // one list, both sides: the note is shown exactly when the main process would pin
  for (const c of ["send amount:1 address:0xCD", "SEND amount:1 address:0xCD", "send amount:1 address:0xCD tokenid:0x00", "send amount:1 address:0xCD tokenid:0X00", "send amount:1 address:0xCD tokenid:0x0", "send amount:1 address:0xCD tokenid:0x000",
    "send amount:1 address:0xCD tokenid:0x0000000000000000000000000000000000000000000000000000000000000000", "send amount:1 address:0xCD tokenid:0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", "send amount:1 address:0xCD fromaddress:0xEE",
    "send amount:1 address:0xCD; status", "status; send amount:1 address:0xCD", "sendpoll action:list", "status"]) {
    const pinned = (await pinSend(run, c, { minCoinage: 3, tokens: false, held: () => null })).pinned;
    assert.equal(termSendNote(c) !== "", pinned, c + (pinned ? " is pinned and must say so" : " is not pinned and must not say it may be"));
  }
  assert.equal(termSendNote("send amount:1 address:0xCD tokenid:0x000"), "", "only exactly 0x00 is MINIMA to the pin (the old note also spoke for 0x0 and 0x000)");
});
test("Terminal (0.19.122): a reply too long for the screen is shown as its tail, said to be cut, and copied whole", () => {
  const T = lift(["termText", "appendTerm"], "let TERM_ITEMS = []; const TERM_MAX = 20000; const el = () => null;\n");
  const big = JSON.stringify({ response: Array.from({ length: 3000 }, (_, i) => "0x" + String(i).padStart(64, "A")) });
  assert.ok(big.length > 20000);
  T.appendTerm("coins", "cmd"); T.appendTerm(big, "json");
  const copied = T.termText();
  assert.ok(copied.endsWith(big), "Copy output has the whole reply, first character to last"); assert.ok(copied.includes("0x" + "0".padStart(64, "A")), "its beginning too");
  const shown = new Function("TERM_MAX", "el", "let TERM_ITEMS = [];" + source("appendTerm") + "\nappendTerm(arguments[2], 'json'); return TERM_ITEMS;")(20000, () => null, big);
  assert.equal(shown.length, 1);
  assert.ok(shown[0].text.startsWith("[This output is cut: the last 20000 of its " + big.length + " characters are shown. Copy output copies all of it.]\n"), "the screen says it is cut and how to get it whole");
  assert.equal(shown[0].text.split("\n").slice(1).join("\n"), big.slice(-20000)); assert.equal(shown[0].full, big);
  T.appendTerm("status", "cmd"); T.appendTerm('{"status":true}', "json");
  assert.ok(!T.termText().includes(big.slice(0, 200)) && T.termText().endsWith('> status\n{"status":true}'), "once it has scrolled off the screen it is no longer kept");
});

// ---- Logs ----
test("Logs: Pandamonium's screen (Pause, Clear, the Share as Save to file, Filter, the six verbosity chips, the log)", () => {
  const view = html.slice(html.indexOf('id="view-logs"'), html.indexOf('id="view-settings"'));
  assert.deepEqual([...view.matchAll(/class="logs-btn" id="(\w+)">([^<]+)</g)].map(m => m[1] + "=" + m[2]), ["logsPause=Pause", "logsClear=Clear", "logsSave=Save to file"]);
  assert.ok(/id="logsFilter" placeholder="Filter"/.test(view) && view.indexOf("logsFilter") < view.indexOf("logsChips") && view.indexOf("logsChips") < view.indexOf("logsBox"));
  const { LOGS_CHIPS } = lift(["LOGS_CHIPS"]);
  assert.deepEqual(LOGS_CHIPS, [["scripts", "Scripts"], ["mining", "Mining"], ["blocks", "Blocks"], ["networking", "Networking"], ["ibd", "Initial block download (IBD)"], ["maxima", "Maxima"]], "LogsView.CHIP_KEYS, in order");
  assert.ok(/tryCmd\("logs " \+ k \+ ":" \+ \(logsOn\[k\] \? "false" : "true"\)\)/.test(app) && /tryCmd\("logs"\)/.test(app), "a chip sends `logs <key>:true|false`; the first show asks plain `logs`");
  const logs = app.slice(app.indexOf("let logLines = [];"), app.indexOf("boot();\ninitLogs();"));
  assert.ok(!/innerHTML = [^`]*line|insertAdjacentHTML/.test(logs) && /box\.textContent = logsAppend\(box\.textContent, line\)/.test(logs) && /box\.textContent = logsRender\(logLines, logsFilter\)/.test(logs), "log lines are written with textContent only");
  assert.ok(!/esc\(l(?:ine)?\)/.test(logs), "no log line is ever put into markup");
});
test("Logs: the 30,000-character rule, the filter and the chips' state are LogsView's", () => {
  const { logsRender, logsAppend, logsSync } = lift(["logsRender", "logsAppend", "logsSync"], "const LOGS_CHARS = 30000; const LOGS_CHIPS = [['scripts'], ['mining'], ['blocks'], ['networking'], ['ibd'], ['maxima']]; let logsOn = {}; const state = () => logsOn;\n");
  const lines = ["Minima @ 1 : Block 10 received", "Minima @ 2 : MINING started", "[parlons-node] node: up", "Minima @ 3 : block 11 received"];
  assert.equal(logsRender(lines, ""), lines.join("\n"));
  assert.equal(logsRender(lines, "BLOCK"), lines[0] + "\n" + lines[3], "a filter matches any case, anywhere in the line");
  assert.equal(logsRender(lines, "nothing"), "");
  const many = Array.from({ length: 600 }, (_, i) => "line " + String(i).padStart(3, "0") + " " + "x".repeat(90));
  const shown = logsRender(many, "");
  assert.equal(shown.length, 30000); assert.ok(shown.endsWith(many[599]), "the newest text is kept, the oldest is cut");
  assert.equal(logsAppend("", "a"), "a"); assert.equal(logsAppend("a", "b"), "a\nb");
  const over = "y".repeat(30001), next = logsAppend(over, "tail");
  assert.equal(next, "y".repeat(30000) + "\ntail", "over the limit: the last 30,000 characters, then the line");
  assert.equal(logsAppend("y".repeat(30000), "z").length, 30002, "at the limit the line is appended (it may pass the limit until the next line, as on the phone)");
});
test("Logs, Save to file: every line is redacted again in the main process; a Parlons message never reaches the file with its words", () => {
  const { forFile, SAVE_MAX } = require("../main/nodelog");
  const key = "0x" + "AB".repeat(162), text = ["Minima @ 1 : Block 10 received", "[parlons-node] message from " + key + ": meet me at the usual place", "[parlons-node] message from someone odd: secret words", "[parlons-node] message from " + key + ": (text not logged)"].join("\n");
  const out = forFile(text).split("\n");
  assert.equal(out[0], "Minima @ 1 : Block 10 received");
  assert.equal(out[1], "[parlons-node] message from " + key + ": (text not logged)", "the sender's key whole, the words gone");
  assert.equal(out[2], "[parlons-node] message from (sender not shown): (text not logged)");
  assert.equal(out[3], out[1], "an already redacted line is unchanged");
  assert.ok(!/usual place|secret words/.test(out.join("\n")));
  assert.ok(forFile("x".repeat(SAVE_MAX + 10)).length <= SAVE_MAX + 1);
  assert.ok(/ipcMain\.handle\("mcd:logsSave"[\s\S]{0,700}dialog\.showSaveDialog\([\s\S]{0,500}nl\.forFile\(nl\.fileText\(node\.diskLog\(\)\), config\.rpcSecret\(\)\)/.test(mainJs), "the file is written by the main process, after a dialog, from forFile()");
  assert.ok(/parlonsNotify\.redact\(l\)/.test(R("main/node-manager.js")), "lines are redacted before they reach the view (node-manager, unchanged)");
});
test("0.19.221: Save to file writes the node log files from disk (node.log.1, then node.log) through the scrubber, never the window's text", () => {
  const nl = require("../main/nodelog"), os = require("os"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "logsave-"));
  try {
    const log = nl.createNodeLog(dir, { maxBytes: 400 }), id = "0x" + "CD".repeat(32);
    log.append("first " + id); log.append("x".repeat(200)); log.append("last phrase:\"ONE TWO\" " + id);
    const text = nl.fileText(log), saved = nl.forFile(text, "");
    assert.ok(fs.existsSync(log.older), "rotated: two files");
    assert.ok(text.indexOf("first " + id) < text.indexOf("last "), "the older file first");
    assert.ok(saved.includes("first " + id) && saved.includes('phrase:"•••"') && !saved.includes("ONE TWO"), "whole ids, the phrase scrubbed again");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(/ipcMain\.handle\("mcd:logsSave", async \(\) =>/.test(mainJs), "the handler takes no text from the window");
  assert.ok(/logsSave: \(\) => ipcRenderer\.invoke\("mcd:logsSave"\)/.test(R("main/preload.js")));
  assert.ok(!/out\.push\(a\.length > 60/.test(R("main/node-manager.js")), "start arguments are logged whole");
});

// ---- Freeze ----
const freezeLib = require("../main/freeze");
function rig(saved, work) {
  const calls = [], store = { ids: saved || [] }, logs = [];
  const eng = (id) => ({ start: () => calls.push(id + ".start"), stop: async () => { calls.push(id + ".stop"); } });
  const f = freezeLib.create({ load: () => store.ids, save: (ids) => { store.ids = ids.slice(); calls.push("save:" + ids.join(",")); }, log: (l) => logs.push(l),
    engines: { mail: eng("mail"), minimall: eng("minimall"), vestr: eng("vestr"), chat: eng("chat"), dexicon: eng("dexicon") }, dexiconWork: async () => (typeof work === "function" ? work() : work) });
  return { f, calls, store, logs };
}
const IDLE = () => ({ atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], ownPools: [], dexicon: { ready: true, takes: 0, unknown: 0, pending: 0 }, holds: [], now: 1e12 });
test("Freeze: an app's background work stops, the list is saved first, and unfreezing starts it again", async () => {
  const { f, calls, store } = rig([]);
  assert.equal(f.start("mail"), true); assert.deepEqual(calls.splice(0), ["mail.start"]);
  assert.deepEqual(await f.set("mail", true), ["mail"]);
  assert.deepEqual(calls.splice(0), ["save:mail", "mail.stop"], "recorded before the loop is stopped: a crash in between leaves it frozen, never half running");
  assert.equal(f.start("mail"), false, "a start site does not start a frozen app"); assert.deepEqual(calls.splice(0), []);
  assert.deepEqual(await f.set("mail", true), ["mail"]); assert.deepEqual(calls.splice(0), [], "asked twice: nothing more");
  assert.deepEqual(await f.set("faucet", true), ["mail", "faucet"]); assert.deepEqual(calls.splice(0), ["save:mail,faucet"], "an app with no background work is only put away");
  assert.deepEqual(await f.set("mail", false), ["faucet"]); assert.deepEqual(calls.splice(0), ["save:faucet", "mail.start"]);
  assert.deepEqual(store.ids, ["faucet"]);
  const a = f.set("vestr", true), b = f.set("vestr", false); await Promise.all([a, b]);   // two clicks at once: one after the other
  assert.deepEqual(calls.splice(0), ["save:faucet,vestr", "vestr.stop", "save:faucet", "vestr.start"]);
});
test("Freeze: honoured at startup; Minima Core and Parlons are never frozen; an unknown id is refused", async () => {
  const { f, calls, logs } = rig(["dexicon", "mail", "core", "parlons", "nonsense", "mail"]);
  assert.deepEqual(f.list(), ["dexicon", "mail"], "what is not freezable is dropped from a saved list");
  await f.applyAtStartup();
  assert.deepEqual(calls.splice(0), ["dexicon.stop", "mail.stop"], "Dexicon's engines are held before the node is up");
  assert.equal(f.start("mail"), false); assert.equal(f.start("vestr"), true); assert.deepEqual(calls.splice(0), ["vestr.start"]);
  assert.match(logs[0], /frozen at startup, no background work: dexicon, mail/);
  await assert.rejects(f.set("core", true), /Minima Core is the node and the wallet/);
  await assert.rejects(f.set("parlons", true), /Parlons is part of the node itself/);
  await assert.rejects(f.set("../../etc", true), /Unknown app/);
  assert.deepEqual(freezeLib.clean("mail"), []); assert.deepEqual(freezeLib.clean([1, null, "chat"]), ["chat"]);
  assert.ok(/if \(k === "frozenApps"\) \{ out\[k\] = require\("\.\/freeze"\)\.clean\(v\); continue; \}/.test(R("main/config.js")) && /frozenApps: \[\],/.test(R("main/config.js")), "kept in the config, cleaned on the way in");
  assert.ok(/if \(patch\) delete patch\.frozenApps;/.test(mainJs), "a window cannot write the list past the check");
});
test("Freeze: Dexicon is refused while money is in flight, or while that cannot be read, and the reason is said", async () => {
  const cases = [
    [(w) => { w.atomix.swaps = ["0xA"]; }, /1 AtomiX swap not finished/], [(w) => { w.atomix.maker = true; }, /Your AtomiX market is on the book \(withdraw it first\)/],
    [(w) => { w.atomix.otcOffer = true; }, /OTC availability is live/], [(w) => { w.atomix.otcDeals = 2; }, /2 AtomiX OTC deals open/],
    [(w) => { w.atomix = null; }, /AtomiX could not be asked/], [(w) => { w.atomix = { ready: false, hasStore: true }; }, /AtomiX has not started, so its swaps could not be read/],
    [(w) => { w.atomix = { ready: false, hasStore: true, swaps: ["0xB"] }; }, /1 AtomiX swap not finished/],
    [(w) => { w.pools = null; }, /PandaPools has not started/], [(w) => { w.pools = [{ type: "SWAP", ts: 1e12 - 1000, confirmed: false }]; }, /1 pool transaction not confirmed yet/],
    [(w) => { w.ownPools = [{ address: "0x1" }]; }, /1 pool of this wallet is open \(the app keeps it up\)/], [(w) => { w.ownPools = null; }, /Your pools could not be read/],
    [(w) => { w.dexicon.takes = 1; }, /1 Exchange trade sent and not yet answered/], [(w) => { w.dexicon.unknown = 1; }, /outcome not known yet/], [(w) => { w.dexicon.pending = 3; }, /3 Exchange orders waiting for a block/],
    [(w) => { w.dexicon = null; w.holds = null; }, /Exchange could not be asked/], [(w) => { w.holds = [{ coinid: "0x1" }, { coinid: "0x2" }]; }, /2 coins behind live Exchange orders or trades \(cancel the orders first\)/],
    [(w) => { w.holds = null; }, /live orders could not be read/]
  ];
  for (const [change, want] of cases) {
    const w = IDLE(); change(w);
    const { f, calls, store } = rig([], w);
    await assert.rejects(f.set("dexicon", true), (e) => /^Dexicon is still watching funds in flight\. It can be frozen once they settle\./.test(e.message) && want.test(e.message), String(want));
    assert.deepEqual(calls, [], "nothing stopped, nothing saved"); assert.deepEqual(store.ids, []);
  }
  const thrown = rig([], () => { throw new Error("down"); });
  await assert.rejects(thrown.f.set("dexicon", true), /what is in flight could not be read/i);
  assert.deepEqual(freezeLib.dexiconBlockers(IDLE()), []);
  assert.deepEqual(freezeLib.dexiconBlockers({ atomix: { ready: false, hasStore: false }, pools: [], ownPools: [], dexicon: { ready: false, hasStore: false }, holds: null }), [], "a wallet that never used Dexicon (no stores) has nothing in flight");
  const ok = rig([], IDLE());
  assert.deepEqual(await ok.f.set("dexicon", true), ["dexicon"]); assert.deepEqual(ok.calls, ["save:dexicon", "dexicon.stop"]);
  assert.deepEqual(await ok.f.set("dexicon", false), []);   // unfreezing is never refused
});
test("Freeze, wiring: every start site asks; a frozen Dexicon stays held through a wallet command; ETH Wallet says why it cannot send", async () => {
  for (const id of ["mail", "minimall", "chat", "vestr"]) assert.ok(mainJs.includes('freeze.start("' + id + '")'), id + " starts through freeze.start");
  assert.ok(!/\{ mailStarted = true; mail\.startLoop\(\)/.test(mainJs) && !/vestrStarted = true; vestr\.startLoop\(\)/.test(mainJs) && !/if \(s\.state === "running"\) chat\.startLoop\(\)/.test(mainJs), "no start site left that ignores the switch");
  assert.ok(/node\.onEnginesRelease = \(\) => \{ if \(freeze\.isFrozen\("dexicon"\)\) return; atomix\.release\(\); pandapools\.release\(\); dexicon\.release\(\);/.test(mainJs), "a wallet command's release leaves a frozen Dexicon held");
  assert.ok(/dexicon: \{ gate: async \(\) => \{ dexicon\.gate\(\); await Promise\.all\(\[atomix\.hold\(\), pandapools\.hold\(\)\]\); \}, start: \(\) => node\.onEnginesRelease\(\), stop: \(\) => node\.onEnginesHold\(\) \}/.test(mainJs), "the hold a wallet replacement uses, taken before the read");
  assert.ok(/replacing: \(\) => !!node\.replacingWallet \|\| !!\(node\.walletCheck && node\.walletCheck\.held\),/.test(mainJs) && /node\.on\("status", \(s\) => \{ freeze\.settle\(\); if \(s\.state !== "running"\) freeze\.nodeStopped\(\); \}\);/.test(mainJs), "the freeze knows a wallet replacement and is told of every status");
  assert.ok(/minimall: \{ start: whenRunning\(\(\) => shop\.startLoop\(\)\), stop/.test(mainJs) && /const whenRunning = \(fn\) => \(\) => \{ if \(node\.state === "running"\) return fn\(\); \};/.test(mainJs), "miniMall's start hands its promise to the freeze");
  assert.ok(/dexiconWork: async \(\) => Object\.assign\(await inFlightWork\(\), \{ ownPools: await pandapools\.ownPools\(\)/.test(mainJs), "the check reads what the Shutdown and Quit warnings read, and the wallet's own pools and order coins");
  assert.ok(mainJs.indexOf("freeze.applyAtStartup();") < mainJs.indexOf("if (c.setupDone && c.walletDone) node.start();") && mainJs.indexOf("freeze.applyAtStartup();") > 0, "applied before the node starts");
  const ethwallet = require("../main/ethwallet"), atomix = require("../main/atomix"), real = atomix.ethSendExecute; let sent = 0;
  try {
    ethwallet.setFrozen(() => true);
    await assert.rejects(ethwallet.sendExecute("eth", "0x" + "ab".repeat(20), "1", "med"), /Dexicon is frozen[\s\S]*Nothing was sent\./);
  } finally { ethwallet.setFrozen(() => false); }
  const { appsState } = lift(["appsState"]);
  assert.equal(appsState({ id: "core" }, false, false), "Always on"); assert.equal(appsState({ id: "mail" }, false, true), "In app drawer · Deep frozen");
  assert.equal(appsState({ id: "mail" }, true, true), "Hidden from drawer · Deep frozen"); assert.equal(appsState({ id: "dexicon", tab: true }, false, false), "A tab");
  assert.ok(/r\.hidden = hidden\.includes\(r\.dataset\.app\) \|\| FROZEN\.includes\(r\.dataset\.app\)/.test(app), "a frozen app's tray row is put away");
  assert.ok(/if \(FROZEN\.length && thawOnOpen\(\)\) return;/.test(app), "opening a frozen app unfreezes it first");
});

// ---- 0.19.119: the review of Freeze ----
/** As rig(), with the hold taken before the read (gate), a start that may be a promise, and a stop that may fail. */
function rig2(o) {
  o = o || {}; const calls = [], store = { ids: (o.saved || []).slice() }, logs = [];
  const eng = (id) => ({ start: () => { calls.push(id + ".start"); return o.start ? o.start(id) : undefined; }, stop: async () => { calls.push(id + ".stop"); if (o.stopFails) throw new Error("the engine did not stop"); } });
  const dex = eng("dexicon"); dex.gate = async () => { calls.push("dexicon.gate"); if (o.gateFails) throw new Error("hold failed"); };
  const f = freezeLib.create({ load: () => store.ids, save: (ids) => { store.ids = ids.slice(); calls.push("save:" + ids.join(",")); }, log: (l) => logs.push(l), readMs: o.readMs,
    engines: { mail: eng("mail"), minimall: eng("minimall"), dexicon: dex }, replacing: o.replacing, dexiconWork: async () => { calls.push("read"); return o.work ? o.work() : IDLE(); } });
  return { f, calls, store, logs };
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
test("Freeze (b): the hold is taken first, then what is in flight is read; anything in flight, or a hold that failed, releases it and refuses", async () => {
  const ok = rig2();
  assert.deepEqual(await ok.f.set("dexicon", true), ["dexicon"]);
  assert.deepEqual(ok.calls, ["dexicon.gate", "read", "save:dexicon", "dexicon.stop"], "held before the read: a swap started a moment before the click is either seen or never starts");
  const busy = rig2({ work: () => { const w = IDLE(); w.atomix.swaps = ["0xA"]; return w; } });
  await assert.rejects(busy.f.set("dexicon", true), /1 AtomiX swap not finished/);
  assert.deepEqual(busy.calls, ["dexicon.gate", "read", "dexicon.start"], "the hold is released; nothing saved"); assert.deepEqual(busy.f.list(), []); assert.deepEqual(busy.store.ids, []);
  const noHold = rig2({ gateFails: true });
  await assert.rejects(noHold.f.set("dexicon", true), /What is in flight could not be read\./);
  assert.deepEqual(noHold.calls, ["dexicon.gate", "dexicon.start"], "a hold that failed half way is released too"); assert.deepEqual(noHold.store.ids, []);
});
test("Freeze (c): an engine with a store that has not started is 'could not be read', as the Quit warning has it", () => {
  const w1 = IDLE(); w1.atomix = { ready: false, hasStore: true, swaps: [] };
  assert.deepEqual(freezeLib.dexiconBlockers(w1), ["AtomiX has not started, so its market and OTC offers could not be read"]);
  const w2 = IDLE(); w2.dexicon = { ready: false, hasStore: true, takes: 0, unknown: 0 };
  assert.deepEqual(freezeLib.dexiconBlockers(w2), ["the Exchange has not started, so its orders could not be read"]);
  const w3 = IDLE(); w3.atomix = { ready: false, hasStore: true }; w3.dexicon = { ready: false, hasStore: true };
  assert.deepEqual(freezeLib.dexiconBlockers(w3), ["AtomiX has not started, so its swaps could not be read", "the Exchange has not started, so its trades could not be read"]);
  const inflight = require("../main/inflight").inFlight({ atomix: w1.atomix, pools: [], dexicon: { ready: true, takes: 0 } }, "quit", 1e12);
  assert.equal(inflight.unread.length, 1, "main/inflight.js calls the same state unread");
});
test("Freeze (d): a read that does not answer within its time is 'could not be read', and the next call is not kept waiting", async () => {
  const r = rig2({ readMs: 30, work: () => new Promise(() => {}) });
  const t0 = Date.now();
  await assert.rejects(r.f.set("dexicon", true), /What is in flight could not be read in time\./);
  assert.ok(Date.now() - t0 < 1000); assert.deepEqual(r.calls, ["dexicon.gate", "read", "dexicon.start"]); assert.deepEqual(r.store.ids, []);
  assert.deepEqual(await r.f.set("mail", true), ["mail"], "a later freeze goes through");
  assert.deepEqual(await r.f.set("mail", false), []);
  assert.equal(freezeLib.create({ load: () => [], save() {}, engines: {} }).set.length, 2);
  assert.ok(/READ_MS = 5000/.test(R("main/freeze.js")), "five seconds in the app");
});
test("Freeze (e): an engine that fails to stop leaves the app not frozen, not saved and running, and says so", async () => {
  const r = rig2({ stopFails: true });
  await assert.rejects(r.f.set("mail", true), /It could not be stopped, so it is not frozen \(the engine did not stop\)\. It is running as before\./);
  assert.deepEqual(r.calls, ["save:mail", "mail.stop", "save:", "mail.start"]); assert.deepEqual(r.f.list(), []); assert.deepEqual(r.store.ids, []); assert.equal(r.f.isFrozen("mail"), false);
  const d = rig2({ stopFails: true });
  await assert.rejects(d.f.set("dexicon", true), /could not be stopped/);
  assert.deepEqual(d.calls, ["dexicon.gate", "read", "save:dexicon", "dexicon.stop", "save:", "dexicon.start"], "the hold is released"); assert.deepEqual(d.store.ids, []);
  // the screen: a failed unfreeze-on-open is said, the list is read again, and it is not asked again in a loop
  assert.ok(/\.catch\(async \(e\) => \{[^\n]*\n\s*THAW_FAILED = id; FROZEN = await api\.freezeList\(\)[^\n]*\n\s*openDlg\("freezeNo", "Still frozen"/.test(app), "thawOnOpen shows the error");
  assert.ok(/if \(!FROZEN\.includes\(id\) \|\| THAW_FAILED === id\) return false;/.test(app));
});
test("Freeze (f): one start at a time; a start that ends after the freeze is stopped; a failed start waits for the next node", async () => {
  let done; const slow = rig2({ start: () => new Promise(r => { done = r; }) });
  assert.equal(slow.f.start("minimall"), true); assert.equal(slow.f.start("minimall"), true); assert.equal(slow.f.start("minimall"), true);
  assert.deepEqual(slow.calls, ["minimall.start"], "asked on every node status, started once");
  const frozen = slow.f.set("minimall", true); await tick(5);
  assert.deepEqual(slow.calls, ["minimall.start"], "the freeze waits for the start that is still running");
  done(); assert.deepEqual(await frozen, ["minimall"]);
  assert.deepEqual(slow.calls, ["minimall.start", "save:minimall", "minimall.stop"], "its timer is there to be stopped: the freeze is not undone");
  assert.equal(slow.f.start("minimall"), false);
  // a locked node: the start fails, and is not tried on every status
  let fails = 0; const locked = rig2({ start: () => { fails++; return Promise.reject(new Error("Couldn't read the node seed (is the wallet unlocked?).")); } });
  assert.equal(locked.f.start("minimall"), true); await tick(5);
  for (let i = 0; i < 5; i++) assert.equal(locked.f.start("minimall"), false);
  assert.equal(fails, 1, "once, not on every status"); assert.match(locked.logs.join("\n"), /minimall could not start its background work \(Couldn't read the node seed/);
  locked.f.nodeStopped(); assert.equal(locked.f.start("minimall"), true); await tick(5); assert.equal(fails, 2, "again with the next node");
  await locked.f.set("minimall", true); await locked.f.set("minimall", false); await tick(5); assert.equal(fails, 3, "and when the user unfreezes it");
  const sync = rig2({ start: () => { throw new Error("boom"); } }); assert.equal(sync.f.start("mail"), true); await tick(5); assert.equal(sync.f.start("mail"), false, "a start that throws is a failed start, not an uncaught error");
});
test("Freeze (a): during a wallet replacement Dexicon is not frozen, and unfreezing does not release the engines the replacement holds", async () => {
  let replacing = true; const r = rig2({ saved: ["dexicon"], replacing: () => replacing });
  assert.deepEqual(await r.f.set("dexicon", false), []);
  assert.deepEqual(r.calls, ["save:"], "unfrozen and saved, the engines left to the replacement"); assert.match(r.logs.join("\n"), /the wallet is being replaced, so its engines start when that has settled/);
  r.f.settle(); assert.deepEqual(r.calls, ["save:"], "not while it still holds them");
  await assert.rejects(r.f.set("dexicon", true), /The wallet is being replaced, and Dexicon's engines are stopped for it\. Dexicon can be frozen once that has finished\./);
  assert.deepEqual(r.calls, ["save:"], "no hold, no read, nothing saved"); assert.deepEqual(r.f.list(), []);
  replacing = false; r.f.settle(); r.f.settle();
  assert.deepEqual(r.calls, ["save:", "dexicon.start"], "released once the replacement has let go (a plain resync holds nothing and releases nothing itself)");
  const broken = rig2({ replacing: () => { throw new Error("x"); } });
  await assert.rejects(broken.f.set("dexicon", true), /wallet is being replaced/, "what cannot be asked counts as a replacement");
});
test("Freeze (g, h, i): ETH Wallet says Dexicon is frozen; a frozen engine's refusal names Freeze; the reason a switch is off is on the screen", async () => {
  const ethwallet = require("../main/ethwallet"), atomix = require("../main/atomix"), pandapools = require("../main/pandapools");
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "freeze-test-")); atomix._setDataDir(tmp); pandapools._setDataDir(tmp);   // an empty folder: no store, no engine
  try {
    ethwallet.setFrozen(() => true); assert.equal((await ethwallet.status()).frozen, true);
    ethwallet.setFrozen(() => false); assert.equal((await ethwallet.status()).frozen, false);
  } finally { ethwallet.setFrozen(() => false); }
  assert.ok(app.includes('${st.frozen ? "Dexicon is frozen. Unfreeze it on the Apps tab to use this wallet." : "Setting up wallet…"}'));
  for (const [eng, name, act] of [[atomix, "AtomiX", () => atomix.swapExecute("q")], [pandapools, "PandaPools", () => pandapools.init()]]) {
    await eng.hold(1);
    try {
      await assert.rejects(act(), new RegExp("^Error: " + name + " is stopped while the wallet is being replaced"));
      eng.setHeldReason(() => name + " is stopped because Dexicon is frozen. Unfreeze Dexicon on the Apps tab: it then starts again by itself. Nothing was sent.");
      await assert.rejects(act(), (e) => /is stopped because Dexicon is frozen\. Unfreeze Dexicon on the Apps tab/.test(e.message) && !/wallet is being replaced/.test(e.message));
      eng.setHeldReason(() => ""); await assert.rejects(act(), /wallet is being replaced/, "no reason given: the replacement's own words");
    } finally { eng.setHeldReason(null); eng.release(); }
  }
  const dx = require("../main/dexicon").makeHost({});
  dx.gate(); dx.setHeldReason(() => "Dexicon is frozen. Unfreeze Dexicon on the Apps tab: it then starts again by itself. Nothing was sent.");
  await assert.rejects(dx.command({ op: "cmd", command: "txnpost id:x" }), /^Error: Dexicon is frozen\./);
  dx.release();
  assert.ok(/eng\.setHeldReason\(\(\) => \(freeze\.isFrozen\("dexicon"\) \?/.test(mainJs), "main.js gives the three engines the reason");
  // i: visible text, tied to the switch
  assert.ok(app.includes('${noIce ? `<div class="apps-row__state" id="appsWhy-${a.id}">${esc(t(noIce))}</div>` : ""}') && app.includes('${noIce ? ` disabled aria-describedby="appsWhy-${a.id}"` : ""}'), "the reason is text on the row, and described-by for the switch");
  assert.ok(!/class="apps-row__hide"\$\{noIce \? ` title=/.test(app), "no longer only a title");
  const NO_FREEZE = new Function("return " + app.match(/const NO_FREEZE = (\{[^\n]*\});/)[1])();
  assert.deepEqual(NO_FREEZE, { core: "Cannot be frozen: Minima Core is the node and the wallet.", parlons: "Cannot be frozen: Parlons is part of the node itself." });
});
