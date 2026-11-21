/*
 * inflight-test.cjs — the Quit warning and the Shutdown warning (0.18.142). One function says both
 * (main/inflight.js), from the engines' own activeWork(); "could not be checked" is said, never read as idle; a quit
 * the system asked for is never held behind a question.
 */
const test = require("node:test"), assert = require("node:assert"), fs = require("node:fs"), path = require("node:path");
const { inFlight, decideQuit, clock } = require("../main/inflight.js");
const ROOT = path.resolve(__dirname, ".."), read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const NOW = new Date(2026, 10, 19, 13, 0, 0).getTime(), H = (n) => "0x" + String(n).repeat(64).slice(0, 64);
const IDLE = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], dexicon: { ready: true, orders: [], pending: 0, takes: 0, unknown: 0 }, casino: null, casinoOn: false };
const With = (o) => Object.assign({}, IDLE, o);

test("nothing in flight: no question at Quit, the plain question at Shutdown", () => {
  const q = inFlight(IDLE, "quit", NOW), s = inFlight(IDLE, "shutdown", NOW);
  assert.equal(q.any, false); assert.deepEqual(q.busy, []); assert.deepEqual(q.unread, []);
  assert.equal(s.title, "Shut down the node?"); assert.equal(s.message, "The node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until you start it again.");
  // a data folder that never had an engine store: nothing can be in flight, and nothing is said to be unchecked
  assert.equal(inFlight({ atomix: { ready: false, hasStore: false }, pools: [], dexicon: { ready: false, hasStore: false } }, "quit", NOW).any, false);
});

test("an AtomiX swap not finished: named, with the nearest time limit as a clock time, and what quitting does", () => {
  const one = inFlight(With({ atomix: { ready: true, swaps: [H(1)], nearestMs: NOW + 95 * 60000, nearestApprox: false } }), "quit", NOW);
  assert.equal(one.title, "Quit with work in flight?");
  assert.equal(one.busy[0], "1 AtomiX swap is not finished. A swap in progress cannot settle while the app is closed and can time out at 14:35. Open the app again well before then: if the other side completes its part in the meantime, this app must be running to claim yours.");
  const three = inFlight(With({ atomix: { ready: true, swaps: [H(1), H(2), H(3)], nearestMs: NOW + 30 * 3600000, nearestApprox: true } }), "shutdown", NOW);
  assert.match(three.busy[0], /^3 AtomiX swaps are not finished\. A swap in progress cannot settle while the node is stopped and can time out at about 19:00 on 20 Nov \(the first of them\)\. Start the node again well before then/);
  assert.equal(three.title, "Shut down with trades in flight?");
  assert.match(inFlight(With({ atomix: { ready: true, swaps: [H(1)], nearestMs: NOW - 1 } }), "quit", NOW).busy[0], /can time out: the time limit of its lock has already passed and its refund is waiting to be made\./);
  assert.match(inFlight(With({ atomix: { ready: true, swaps: [H(1)], nearestMs: null } }), "quit", NOW).busy[0], /while the app is closed and can time out\. Open the app again/, "a time limit that is not known is not invented");
  assert.equal(clock(NOW + 60000, NOW), "13:01");
});

test("a live maker order, OTC availability and open OTC deals are each named", () => {
  const w = inFlight(With({ atomix: { ready: true, swaps: [], maker: true, otcOffer: true, otcDeals: 2 } }), "quit", NOW);
  assert.deepEqual(w.busy, ["Your AtomiX market is on the book. Its orders stay there, but a swap someone starts against them is not answered while the app is closed.",
    "Your AtomiX OTC availability is live. A proposal sent to you is not answered while the app is closed.", "2 AtomiX OTC deals are open and cannot go on while the app is closed."]);
});

test("pool operations pending, Exchange takes and fills with an unknown outcome, P2P Chance bets", () => {
  const rows = [{ type: "SWAP", ts: NOW - 60000, confirmed: false }, { type: "STATUS", ts: NOW }, { type: "SWAP", ts: NOW - 2 * 3600000, confirmed: false }, { type: "ADD", ts: NOW - 5000, failed: true }, { type: "ADD", ts: NOW - 5000, confirmed: true }];
  const w = inFlight(With({ pools: rows, dexicon: { ready: true, orders: [H(7)], pending: 1, takes: 2, unknown: 1 }, casino: { offers: 1, bets: 2 }, casinoOn: true }), "quit", NOW);
  assert.equal(w.busy[0], "1 pool transaction sent in the last hour is not confirmed yet. The app cannot check or finish it while the app is closed.");
  assert.match(w.busy[1], /^2 Exchange trades are sent and not yet answered\. While the app is closed they cannot be voided, so the other side could still complete them later at the price you signed\./);
  assert.match(w.busy[2], /^1 fill of your Exchange orders has an outcome that is not known yet/);
  assert.equal(w.busy[3], "1 Exchange order is still waiting for a block.");
  assert.match(w.busy[4], /^P2P Chance: 2 bets and 1 offer still open\. They are revealed and paid out only while the app and its node run/);
  assert.equal(w.busy.length, 5, "an order resting on the chain is not 'in flight': it stays where it is");
});

test("an engine that has not started is SAID, never read as idle", () => {
  const w = inFlight({ atomix: { ready: false, hasStore: true, error: "the swap store could not be opened" }, pools: null, dexicon: null, casino: null, casinoOn: true }, "quit", NOW);
  assert.deepEqual(w.busy, []); assert.equal(w.any, true); assert.equal(w.title, "Quit without the check?");
  assert.match(w.message, /^Could not be checked: AtomiX swaps, market and OTC \(AtomiX has not started: the swap store could not be opened\); pool operations \(PandaPools has not started\); Exchange trades waiting for an answer \(Dexicon could not be asked\); P2P Chance bets \(not read yet\)\. If you are not sure nothing is in flight, stay open/);
  assert.match(inFlight({}, "shutdown", NOW).message, /^Could not be checked: AtomiX swaps, market and OTC \(AtomiX could not be asked\); pool operations/);
  // Dexicon's quick half is up while the chain is still read: its takes are known, and that is used
  const half = inFlight(With({ dexicon: { ready: false, hasStore: true, takes: 1 } }), "quit", NOW);
  assert.deepEqual(half.unread, []); assert.match(half.busy[0], /^1 Exchange trade is sent/);
});

test("Quit: asked when a user quits with work in flight; never asked for a system quit, a stopped node or an idle app; all logged", async () => {
  const run = async (o) => { const log = [], asked = []; const go = await decideQuit(Object.assign({ gather: async () => With({ atomix: { ready: true, swaps: [H(1)], nearestMs: NOW + 60000 } }), ask: async (w) => { asked.push(w); return o.answer; }, log: (l) => log.push(l), now: () => NOW }, o)); return { go, log, asked }; };
  let r = await run({ answer: false }); assert.equal(r.go, false); assert.equal(r.asked.length, 1); assert.match(r.log[0], /^\[app\] quit asked with work in flight \(1 AtomiX swap is not finished.*\): the user chose to stay open$/);
  r = await run({ answer: true }); assert.equal(r.go, true); assert.match(r.log[0], /the user chose to quit$/);
  r = await run({ os: true, answer: false }); assert.equal(r.go, true); assert.equal(r.asked.length, 0, "a system shutdown is never held behind a dialog"); assert.match(r.log[0], /^\[app\] quit asked by the system: no question was shown\. In flight: 1 AtomiX swap is not finished/);
  r = await run({ stopped: true, answer: false }); assert.equal(r.go, true); assert.equal(r.asked.length, 0); assert.match(r.log[0], /node already stopped/);
  r = await run({ gather: async () => IDLE }); assert.equal(r.go, true); assert.equal(r.asked.length, 0); assert.deepEqual(r.log, []);
  // a read that never answers does not hold the quit: it is asked, and says what could not be checked
  r = await run({ gather: () => new Promise(() => {}), waitMs: 20, answer: true }); assert.equal(r.asked.length, 1); assert.equal(r.asked[0].busy.length, 0); assert.equal(r.asked[0].unread.length, 3);
  r = await run({ gather: async () => { throw new Error("x"); }, answer: false }); assert.equal(r.go, false); assert.equal(r.asked[0].unread.length, 3);
});

test("wiring: one gather for Shutdown and Quit; the quit is asked before the node is stopped, and never for a system quit", () => {
  const main = read("main/main.js"), pre = read("main/preload.js"), app = read("renderer/app.js");
  assert.match(main, /const inFlightWork = async \(\) => \(\{ atomix: await atomix\.activeWork\(\)\.catch\(\(\) => null\), pools: await pandapools\.activeWork\(\)\.catch\(\(\) => null\),\n\s*dexicon: await dexicon\.activeWork\(\)\.catch\(\(\) => null\), casino: /);
  assert.equal((main.match(/inFlightWork/g) || []).length, 5, "defined once, used by mcd:inFlight (Shutdown), by before-quit (Quit), since 0.19.117 by the Freeze check of Dexicon (main/freeze.js) and since 0.19.268 by the guard of every node stop");
  assert.match(pre, /inFlight: \(how, action\) => ipcRenderer\.invoke\("mcd:inFlight", how, action\)/); assert.match(app, /api\.inFlight\("shutdown", action\)/);
  assert.ok(!/mcd:ppWork|mcd:dxWork/.test(main + pre), "the two reads the old Shutdown warning used are gone with it");
  const q = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf("// ---- ", main.indexOf('app.on("before-quit"')) > 0 ? undefined : undefined);
  const order = ["if (quitting) return;", "e.preventDefault();", "inflight.decideQuit({ os: systemQuit.on(), stopped: node.state === \"stopped\", gather: inFlightWork", "if (!go) return;", "quitting = true;", "await node.stop()", "app.quit();"].map((x) => q.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "held, asked, and only then the node is stopped and the app quits: " + order);
  assert.match(main, /powerMonitor\.on\("shutdown", \(\) => \{ systemQuit\.mark\(\); \}\)/); assert.match(main, /w\.on\("session-end", \(\) => \{ systemQuit\.mark\(\); \}\)/);
  assert.match(main, /const systemQuit = inflight\.recently\(\);/); assert.ok(!/systemQuit = true|os: systemQuit,|\|\| systemQuit;/.test(main), "no flag that stays set for the session");
  assert.match(main, /buttons: \[lang\.t\("Quit anyway"\), lang\.t\("Stay open"\)\], defaultId: 1, cancelId: 1/, "Enter and Esc both stay open");
  assert.match(main, /win\.on\("close", e => \{ if \(quitting\) return; e\.preventDefault\(\); if \(process\.platform === "darwin"\) win\.hide\(\); else app\.quit\(\); \}\);/, "off the Mac, closing the window asks through the same quit");
  assert.match(main, /node\.onStopping = \(\) => Promise\.all\(\[dexicon\.stop\(\), atomix\.quiet\(10000\), pandapools\.quiet\(10000\)\]\);/, "the bounded drain every quit goes through (0.18.117)");
});

test("AtomiX activeWork gives the nearest time limit of an unfinished swap: seconds for an Ethereum lock, an estimate from the tip for a Minima lock", async () => {
  require("./no-reach.cjs").install();
  const atomix = require("../main/atomix.js"), NOW = 1800000000000, TIP = 1000;
  const A = (rows) => ({ swapdb: { allSwaps: (cb) => cb(null, rows) }, trading: { isTerminalSwap: (s) => ["COMPLETE", "REFUNDED", "ERROR"].includes(s.status), withinWindow: () => true }, maker: { currentOrder: () => null }, otc: { allDeals: (cb) => cb(null, []), myOffer: () => null } });
  atomix._setCtx({ READY: true, AX: A([{ hash: "0xA", status: "STARTED", myTimelock: NOW / 1000 + 7200, myLegIsMinima: false }, { hash: "0xB", status: "LOCKED", myTimelock: TIP + 36, myLegIsMinima: true }, { hash: "0xC", status: "COMPLETE", myTimelock: 5, myLegIsMinima: false }]) });
  try {
    const w = await atomix._activeWorkFrom(atomix._ctx().AX, TIP, NOW);
    assert.deepEqual(w.swaps, ["0xA", "0xB"]); assert.equal(w.nearestMs, NOW + 36 * 50000, "the Minima lock, 36 blocks away, is first"); assert.equal(w.nearestApprox, true);
    assert.equal((await atomix._activeWorkFrom(atomix._ctx().AX, 0, NOW)).nearestMs, NOW + 7200000, "no tip: a block limit is not turned into a time; the Ethereum one stands"); 
    atomix._setCtx({ READY: true, AX: A([{ hash: "0xB", status: "LOCKED", myTimelock: TIP + 36, myLegIsMinima: true }]) });
    assert.equal((await atomix._activeWorkFrom(atomix._ctx().AX, 0, NOW)).nearestMs, null, "not known is null, never a guess");
  } finally { atomix._setCtx(null); }
});

// ---- 0.19.103 ----
test("a cancelled system shutdown does not silence the Quit question for the session: the system's word lasts about a minute", async () => {
  const { recently, decideQuit } = require("../main/inflight"), clock = { t: 1e12 }, sys = recently(undefined, () => clock.t);
  assert.equal(sys.on(), false, "never asked");
  sys.mark(); assert.equal(sys.on(), true);
  clock.t += 59999; assert.equal(sys.on(), true, "inside the minute a real shutdown is still not held");
  clock.t += 1; assert.equal(sys.on(), false, "a minute on, the shutdown was cancelled: it is the user's quit again");
  // through the quit itself: the same work in flight, asked or not by the clock alone
  const work = async () => ({ atomix: { ready: true, swaps: ["0x" + "51".repeat(32)], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], dexicon: { ready: true, orders: [], pending: 0, takes: 0, unknown: 0 } });
  const quit = async () => { const asked = []; const go = await decideQuit({ os: sys.on(), stopped: false, gather: work, log() {}, ask: async (w) => { asked.push(w.title); return false; } }); return { go, asked: asked.length }; };
  sys.mark(); assert.deepEqual(await quit(), { go: true, asked: 0 }, "the system is shutting down: not held");
  clock.t += 61000; assert.deepEqual(await quit(), { go: false, asked: 1 }, "later, Cmd-Q with a swap in flight is asked again");
  sys.mark(); clock.t += 30000; sys.mark(); clock.t += 45000; assert.equal(sys.on(), true, "a second word from the system starts the minute again");
});

test("languages: the same facts in the app's language for the question, and in English for the log", async () => {
  const I18N = require("../renderer/i18n.js"); for (const c of ["en", "zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const work = { atomix: { ready: true, swaps: [{}, {}], nearestMs: 0 }, pools: [], dexicon: { ready: true, takes: 1, unknown: 0, pending: 5 } };
  const en = inFlight(work, "quit", 1000);
  assert.match(en.message, /^2 AtomiX swaps are not finished\. A swap in progress cannot settle while the app is closed and can time out\. Open the app again well before then/);
  assert.match(en.message, /1 Exchange trade is sent and not yet answered\. While the app is closed it cannot be voided/); assert.match(en.message, /5 Exchange orders are still waiting for a block\./);
  for (const code of ["zh", "ru", "uk"]) {
    const w = inFlight(work, "quit", 1000, I18N.tIn(code));
    assert.equal(w.busy.length, en.busy.length, code + ": the same number of warnings"); assert.equal(w.any, true);
    assert.notEqual(w.title, en.title); for (const line of w.busy) { assert.ok(!/ (is|are) (not|sent|still)/.test(line), code + ": no English sentence left: " + line); assert.ok(/[125]/.test(line), code + ": the count is said"); }
    assert.ok(w.message.includes("AtomiX") && w.message.includes("Dexicon"), code + ": the names stay");
    assert.ok(!/\{[a-z]+\}/.test(w.message), code + ": no placeholder left unfilled: " + w.message);
  }
  // the question in Russian, the log line in English
  const logs = []; I18N.set("ru");
  try { await decideQuit({ os: false, stopped: false, gather: async () => work, log: (l) => logs.push(l), t: I18N.t, ask: async (w) => { assert.ok(/[а-я]/i.test(w.title + w.message), "asked in Russian"); return false; } }); }
  finally { I18N.set("en"); }
  assert.match(logs[0], /^\[app\] quit asked with work in flight \(2 AtomiX swaps are not finished\./, "the log on disk stays English");
});

// ---- 0.19.268: one guard in MAIN in front of every node stop or restart (it replaces the count of the window's call sites) ----
test("stopGuard: with work in flight a stop goes on only with main's own one-time ack (once, for two minutes) or after main's question", async () => {
  const { stopGuard, ACK_MS } = require("../main/inflight.js");
  let t = NOW, running = true, work = With({ pools: [{ type: "ADD", ts: NOW - 60000 }] }); const asked = [], logs = [];
  let answer = false;
  const g = stopGuard({ running: () => running, gather: async () => work, ask: async (w) => { asked.push(w.title); return answer; }, log: (l) => logs.push(l), now: () => t });
  assert.equal(await g.pass(), false, "in flight, no ack: main asks, and a no keeps the node"); assert.equal(asked.length, 1); assert.match(logs[0], /pool transaction.*keep it running/);
  answer = true; assert.equal(await g.pass("not one of main's", "restart"), true); assert.equal(asked.length, 2, "an ack main never issued is no ack"); g.seen("stopped");   // each yes holds until the node stopped (0.19.316)
  answer = false; const a = g.issue("restart"); assert.equal(await g.pass(a, "restart"), true, "the warning the window showed"); assert.equal(asked.length, 2, "no second question"); g.seen("stopped");
  assert.equal(await g.pass(a, "restart"), false, "an ack works once"); assert.equal(asked.length, 3);
  // 0.19.287: an ack is for the one action its warning was asked for
  const k = g.issue("stop"); assert.equal(await g.pass(k, "restart"), false, "a Shutdown ack opens no restart"); assert.equal(await g.pass(k, "stop"), false, "and is spent by that try");
  asked.length = 3; const u = g.issue(); assert.equal(await g.pass(u, ""), false, "an ack named for no action opens nothing"); asked.length = 3;
  const b = g.issue("restart"); t += ACK_MS + 1; assert.equal(await g.pass(b, "restart"), false, "and only for two minutes");
  work = IDLE; assert.equal(await g.pass(), true, "nothing in flight: no question"); assert.equal(asked.length, 4);
  const h = stopGuard({ running: () => true, gather: async () => { throw new Error("down"); }, ask: async (w) => { asked.push(w.message); return false; }, log() {}, now: () => t });
  assert.equal(await h.pass(), false, "what could not be checked is asked, never read as idle"); assert.match(asked[4], /Could not be checked/);
  const slow = stopGuard({ running: () => true, gather: () => new Promise(() => {}), ask: async () => false, log() {}, waitMs: 20 });
  assert.equal(await slow.pass(), false, "a gather that never answers is not idle");
  running = false; work = With({ pools: [{ type: "ADD", ts: NOW - 60000 }] }); assert.equal(await g.pass(), true, "a node that is not running is not stopped by anything");
});
test("main: Restart, Stop, Reclaim, the node kind, the Web Wallet's MegaMMR switch and a Chat backup restore stop nothing unless the guard lets them", async () => {
  const ts = require("typescript"), src = read("main/main.js"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), calls = {};
  const walk = (n) => { if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0])) calls[n.arguments[0].text] = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  const names = ["mcd:nodeRestart", "mcd:nodeStop", "mcd:nodeReclaim", "mcd:setNodeKind", "mcd:wwEnableMegammr", "mcd:chatApplyBackup"];
  for (const allow of [false, true]) for (const name of names) {
    const did = [], acks = [], actions = [], h = {};
    const env = { ipcMain: { handle: (n, f) => { h[n] = f; } }, mayStop: async (ack, action) => { acks.push(ack); actions.push(action); if (!allow) throw new Error("The node keeps running: nothing was stopped."); }, saveConfigPatch: () => did.push("save"),
      node: { state: "running", stop: async () => did.push("stop"), start: async () => did.push("start"), restart: async () => did.push("restart"), snapshot: () => ({}), parlonsBlocker: () => "", jarPath: () => "/x/minima.jar" },
      config: { load: () => ({ params: {}, keyMode: "classic" }), save: () => did.push("save") }, chat: { stopLoop() {}, forgetIdentity() {}, init: async () => {} },
      pendingChatBackup: { contacts: [], messages: [], manifest: {} }, chatStore: { mergeBackup() {} }, fs: { mkdirSync() {}, writeFileSync() {}, renameSync() {} }, path, keetsKeypairFile: () => "/x/k", require, held: (op) => op() };   // held: 0.19.319
    new Function("env", "with (env) { " + calls[name] + "; }")(env);
    const args = name === "mcd:setNodeKind" ? [null, "minima", "ACK"] : [null, "ACK"];
    if (allow) { await h[name](...args).catch(() => {}); assert.ok(did.some(d => d === "stop" || d === "restart"), name + " stops or restarts the node once allowed"); }
    else { await assert.rejects(h[name](...args), /nothing was stopped/, name); assert.deepEqual(did, [], name + ": nothing stopped and nothing saved"); }
    assert.equal(acks.length, 1, name + " asks the guard once");
    if (!/ww|chat/i.test(name)) assert.equal(acks[0], "ACK", name + " hands the window's ack to the guard");
    assert.equal(actions[0], { "mcd:nodeRestart": "restart", "mcd:nodeStop": "stop", "mcd:nodeReclaim": "reclaim", "mcd:setNodeKind": "kind" }[name], name + ": the action its ack must have been issued for (0.19.287)");
  }
  // 0.19.287: a restart that carries the window's config patch saves it only once the guard let it go: asked first, saved after
  for (const allow of [false, true]) {
    const did = [], h = {};
    new Function("env", "with (env) { " + calls["mcd:nodeRestart"] + "; }")({ ipcMain: { handle: (n, f) => { h[n] = f; } }, mayStop: async () => { did.push("ask"); if (!allow) throw new Error("The node keeps running: nothing was stopped."); },
      saveConfigPatch: (p) => did.push("save " + JSON.stringify(p)), node: { restart: async () => did.push("restart"), snapshot: () => ({}) }, held: (op) => op() });
    await h["mcd:nodeRestart"](null, "ACK", { contribute: true }).catch(() => {});
    assert.deepEqual(did, allow ? ["ask", 'save {"contribute":true}', "restart"] : ["ask"], allow ? "saved after the guard, before the restart" : "refused: nothing saved");
  }
  assert.ok(/label: lang\.t\("Restart node"\), click: \(\) => \{ mayStop\(\)\.then\(\(\) => held\(\(\) => node\.restart\(\)\)\)/.test(src), "the tray's Restart node asks the guard first");
  assert.ok(calls["mcd:cmd"].includes("if (restore.isResync(command)) { await mayStop(); return seedgate.scrubReply(await held(() => runResync(command)), command); }"), "a Terminal resync asks the guard first");
  assert.ok(calls["mcd:inFlight"].includes('ack: w.any && how !== "quit" && /^(restart|stop|kind)$/.test(String(action)) ? stopGuard.issue(action) : ""'), "the ack is issued only with a warning that was shown, for its one action");
});

// ---- 0.19.283: the Terminal's commands that stop the node at their end go through the same main-side stop guard ----
test("main: quit, an archive / mysql / reset resync or import and a megammr import ask the stop guard before the node gets them", async () => {
  const R = require("../main/restore.js"), V = require("../main/cmdverb.js"), G = require("../main/seedgate.js");
  const stopping = ["quit", "quit compact:true", '"quit"', "status;quit", "archive action:resync host:h:9001", "archive action:import file:/x/a.gz", "archive action:importold file:/x/a", "archive action:importraw file:/x/a",
    "reset action:chainsync archivefile:/x/a.gz", "mysql action:resync host:h:3306 database:d user:u", "mysql action:reset file:/x/a", "megammr action:import file:/x/m", "megammrsync action:resync host:h:9001"];
  for (const c of stopping) assert.equal(R.stopsNode(c), true, c);
  for (const c of ["status", "archive action:export file:/x", "archive action:inspect file:/x", "mysql action:info", "megammr action:export file:/x", "megammrsync action:mydetails", "send amount:1 address:0xA"]) assert.equal(R.stopsNode(c), false, c);
  const ts = require("typescript"), src = read("main/main.js"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS); let h = "";
  const walk = (n) => { if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "mcd:cmd") h = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  for (const allow of [false, true]) for (const c of stopping.filter(x => !/megammrsync/.test(x))) {
    const sent = [], hs = {};
    new Function("ipcMain", "cmdverb", "restore", "requireRunning", "seedgate", "secretGate", "walletWork", "runResync", "rpc", "node", "config", "pinMinimaSend", "mayStop", "held", h)(
      { handle: (n, f) => { hs[n] = f; } }, V, R, () => {}, G, { take: () => true }, async () => [], async (x) => { sent.push(x); return {}; }, { rpcCall: async (p, s, x) => { sent.push(x); return { status: true }; } },
      { rpcPort: () => 0 }, { rpcSecret: () => "" }, async (run, x) => x, async () => { if (!allow) throw new Error("The node keeps running: nothing was stopped."); }, (op) => op());   // held: 0.19.319
    if (allow) { await hs["mcd:cmd"](null, c); assert.deepEqual(sent, [c], c + " runs once allowed"); }
    else { await assert.rejects(hs["mcd:cmd"](null, c), /nothing was stopped/, c); assert.deepEqual(sent, [], c + ": nothing reached the node"); }
  }
});

// ---- 0.19.288: a miniMall payment at the node is said by the Quit and Shutdown warnings ----
test("a miniMall payment being sent makes Quit and Shutdown ask, from the shop's own count, through main.js's gather", async () => {
  for (const how of ["quit", "shutdown"]) {
    const w = inFlight(With({ shop: 1 }), how, NOW); assert.equal(w.any, true, how);
    assert.ok(w.busy.some(l => /miniMall payment is being sent to the node/.test(l)), how);
    assert.equal(inFlight(With({ shop: 0 }), how, NOW).busy.length, 0);
  }
  const ts = require("typescript"), src = read("main/main.js"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS); let decl = "";
  const walk = (n) => { if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "inFlightWork")) decl = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  const gather = new Function("env", "with (env) { " + decl + "; return inFlightWork; }")({ config: { load: () => ({}) }, casino: { open: () => ({ offers: 0, bets: 0 }), looping: () => false },
    atomix: { activeWork: async () => IDLE.atomix }, pandapools: { activeWork: async () => [] }, dexicon: { activeWork: async () => IDLE.dexicon }, futurecash: { activeWork: () => ({ ready: true, posted: 0 }) },
    shop: { sendingCount: () => 1 } });
  assert.equal(inFlight(await gather(), "quit", NOW).any, true, "main.js asks the shop");
});

// ---- 0.19.294: a backup restore asks the stop guard right before the node gets the resync; Settings' heap goes with the guarded switch ----
test("main: Restore from file asks the stop guard before its resync, and Apply and restart saves the heap size only once the guard let it go", async () => {
  const ts = require("typescript"), src = read("main/main.js"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), calls = {};
  const walk = (n) => { if (ts.isCallExpression(n) && n.expression.getText(sf) === "ipcMain.handle" && ts.isStringLiteral(n.arguments[0])) calls[n.arguments[0].text] = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  for (const allow of [false, true]) {
    const did = [], h = {};
    const env = { ipcMain: { handle: (n, f) => { h[n] = f; } }, mayStop: async () => { did.push("ask"); if (!allow) throw new Error("The node keeps running: nothing was stopped."); },
      restore: { restoreBackup: async (o, d) => d.run("megammrsync action:resync host:h:1 file:b.bak") }, runResync: async (c) => { did.push("resync"); return {}; },
      config: { load: () => ({ keyMode: "classic", params: {} }), save: (p) => did.push("save " + JSON.stringify(p)) }, saveConfigPatch: (p) => did.push("patch " + JSON.stringify(p)),
      node: { state: "running", blockKeysSupported: () => true, parlonsBlocker: () => "", jarPath: () => "/x/minima.jar", restart: async () => did.push("restart"), snapshot: () => ({}) }, chat: { stopLoop() {} }, walletWork: async () => [], path, require, held: (op) => op() };
    for (const n of ["mcd:restoreBackup", "mcd:setNodeKind"]) new Function("env", "with (env) { " + calls[n] + "; }")(env);
    await h["mcd:restoreBackup"](null, { file: "b.bak" }).catch(() => {});
    assert.deepEqual(did, allow ? ["ask", "resync"] : ["ask"], "restore: " + allow); did.length = 0;
    await h["mcd:setNodeKind"](null, "minima", "ACK", { heapMb: 2048 }).catch(() => {});
    assert.deepEqual(did, allow ? ["ask", 'patch {"heapMb":2048}', 'save {"nodeKind":"minima"}', "restart"] : ["ask"], "kind: " + allow);
  }
  assert.ok(!/api\.saveConfig\(\{ heapMb \}\)/.test(read("renderer/app.js")), "the screen no longer saves the heap before the switch");
});

// ---- 0.19.313: the stop guard decides one stop at a time: two requests at once show one question and give one stop ----
test("stopGuard single-flight: a second stop asked while the first one's question is open is refused; one question, one stop", async () => {
  const { stopGuard } = require("../main/inflight.js");
  let answer; const asked = []; const work = With({ pools: [{ type: "ADD", ts: NOW - 60000 }] });
  const g = stopGuard({ running: () => true, gather: async () => work, ask: (w) => new Promise(r => { asked.push(w.title); answer = r; }), log() {}, now: () => NOW });
  const first = g.pass(), stops = [];
  await new Promise(r => setImmediate(r));
  await assert.rejects(g.pass(), /already being stopped or restarted/, "the second request while the question is open");
  assert.equal(asked.length, 1, "one question");
  answer(true); if (await first) stops.push(1);
  assert.deepEqual(stops, [1], "one stop");
  g.seen("stopped"); answer = null; const again = g.pass();   // once the node has stopped (0.19.316) await new Promise(r => setImmediate(r)); answer(false); assert.equal(await again, false, "and the next request is asked again afterwards");
});

// ---- 0.19.316: after a yes the guard holds until the node has stopped (at most 30 s), as the 0.18 branch: one stop, not two ----
test("stopGuard: a request between a yes and the node's stop is refused; the node's status, or 30 s, ends the hold", async () => {
  const { stopGuard } = require("../main/inflight.js");
  let t = NOW, running = true; const asked = [];
  const g = stopGuard({ running: () => running, gather: async () => With({ pools: [{ type: "ADD", ts: NOW - 60000 }] }), ask: async (w) => { asked.push(w.title); return true; }, log() {}, now: () => t });
  assert.equal(await g.pass(), true, "the first: asked, yes");
  await assert.rejects(g.pass(), /already being stopped or restarted/, "the second, before the node has stopped");
  assert.equal(asked.length, 1, "one question, one stop");
  g.seen("running"); await assert.rejects(g.pass(), /already being stopped/, "a running status does not end the hold");
  g.seen("stopping"); assert.equal(await g.pass(), true, "the node's stop ends it"); assert.equal(asked.length, 2);
  t += 30001; assert.equal(await g.pass(), true, "and 30 s end it when no status comes");
  running = false; t += 1; assert.equal(await g.pass(), true, "a node not running is never held");
  const main = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/node\.on\("status", \(s\) => stopGuard\.seen\(s && s\.state\)\);/.test(main), "main gives the guard the node's status");
});
