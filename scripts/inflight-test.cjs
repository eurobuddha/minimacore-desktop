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
  assert.equal((main.match(/inFlightWork/g) || []).length, 3, "defined once, used by mcd:inFlight (Shutdown) and by before-quit (Quit)");
  assert.match(pre, /inFlight: \(how\) => ipcRenderer\.invoke\("mcd:inFlight", how\)/); assert.match(app, /api\.inFlight\("shutdown"\)/);
  assert.ok(!/mcd:ppWork|mcd:dxWork/.test(main + pre), "the two reads the old Shutdown warning used are gone with it");
  const q = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf("// ---- ", main.indexOf('app.on("before-quit"')) > 0 ? undefined : undefined);
  const order = ["if (quitting) return;", "e.preventDefault();", "inflight.decideQuit({ os: systemQuit.on(), stopped: node.state === \"stopped\", gather: inFlightWork", "if (!go) return;", "quitting = true;", "await node.stop()", "app.quit();"].map((x) => q.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "held, asked, and only then the node is stopped and the app quits: " + order);
  assert.match(main, /powerMonitor\.on\("shutdown", \(\) => \{ systemQuit\.mark\(\); \}\)/); assert.match(main, /w\.on\("session-end", \(\) => \{ systemQuit\.mark\(\); \}\)/);
  assert.match(main, /const systemQuit = inflight\.recently\(\);/); assert.ok(!/systemQuit = true|os: systemQuit,|\|\| systemQuit;/.test(main), "no flag that stays set for the session");
  assert.match(main, /buttons: \["Quit anyway", "Stay open"\], defaultId: 1, cancelId: 1/, "Enter and Esc both stay open");
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
