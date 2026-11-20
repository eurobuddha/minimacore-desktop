// Terminal, Logs and the Apps tab's Freeze (Phase 5a). Executed where the logic is pure; nothing here reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
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
  assert.ok(/ipcMain\.handle\("mcd:cmd"[\s\S]{0,700}restore\.loadsBackupFile\(command\)[\s\S]{0,900}restore\.backupCommandProblem\(command\)/.test(mainJs), "restore, restoresync and megammrsync file: are still refused on the command channel");
  assert.ok(/const run = \(c\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\);/.test(mainJs), "a Terminal command goes through rpcCall (signing queue and coin guard) as the wallet");
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
  assert.ok(/ipcMain\.handle\("mcd:logsSave"[\s\S]{0,700}dialog\.showSaveDialog\([\s\S]{0,500}require\("\.\/nodelog"\)\.forFile\(text\)/.test(mainJs), "the file is written by the main process, after a dialog, from forFile()");
  assert.ok(/parlonsNotify\.redact\(l\)/.test(R("main/node-manager.js")), "lines are redacted before they reach the view (node-manager, unchanged)");
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
  assert.ok(/dexicon: \{ start: \(\) => node\.onEnginesRelease\(\), stop: \(\) => node\.onEnginesHold\(\) \}/.test(mainJs), "the hold a wallet replacement uses");
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
