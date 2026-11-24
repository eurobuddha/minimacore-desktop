// THE NODE'S STOP (0.19.420). On 23 Nov 2026 a Quit sent SIGTERM 12 s after the node began saving ("Saving all db" → "node exited
// code=143") and its 1.5 GB MegaMMR came back as 49.1 MB: core's `quit` writes every database before it answers, megammr.mmr is
// deleted and written again, and a cut file loads without a word. These run node-manager's real stop, reclaim and exit paths on a
// stand-in node PROCESS (scripts/fixtures/saving-node.cjs) that saves the way core does and answers signals the way the JVM does.
// No java, no real node, no network: config lives in a temp folder behind a stand-in for electron, on ports 29500+.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const Module = require("module");
const STANDIN = path.join(__dirname, "fixtures", "saving-node.cjs");

let USERDATA = "";
const fakeElectron = { app: { getPath: () => USERDATA, isPackaged: false, getVersion: () => "0.19.999" }, safeStorage: null };
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : realLoad.call(this, request, ...rest); };
const config = require("../main/config.js");
config.rpcSecret = () => "test-secret";
const NM = require("../main/node-manager.js");
const m = NM, real = { rpc: m.rpc, spawnFn: m.spawnFn, startHealth: m.startHealth, reclaimStaleNode: m.reclaimStaleNode, stopTimes: m.stopTimes, sys: m.sys };
test.after(() => { Module._load = realLoad; });

const PIECE = 1000;
const dataDir = () => path.join(USERDATA, "node-data");
const mmr = () => path.join(dataDir(), "1.1", "databases", "megammr.mmr");
const size = () => { try { return fs.statSync(mmr()).size; } catch (e) { return -1; } };
const record = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "minimacore-shutdown.json"), "utf8")); } catch (e) { return null; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
test.after(() => { for (const c of children) try { process.kill(c.pid, "SIGKILL"); } catch (e) {} });

function fresh(times) {
  USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
  config.recordKeyMode("classic"); config.save({ setupDone: true, walletDone: true, nodeKind: "minima", basePort: 29500 });
  m.stopTimes = Object.assign({}, real.stopTimes, times || {});
  m.keyModeAlert = ""; m.proc = null; m.state = "stopped"; m.stopRun = null; m.shutdownNotes = []; m.logs = [];
}
/** A start of node-manager whose "java" is the stand-in: argv after the script = the stand-in's own (saveMs, pieces, quiet, hang, forge). */
async function startStandin(saveMs, pieces, quiet, hang, forge, chatter, gap) {
  const seen = { lines: "", quits: 0, statuses: [] };
  m.spawnFn = (_cmd, _args, opts) => { const c = spawn(process.execPath, [STANDIN, dataDir(), String(saveMs), String(pieces), quiet ? "1" : "0", hang ? "1" : "0", "0", forge || "", String(chatter || 0), String(gap || 0)], opts); children.push(c); seen.child = c;
    c.stdout.on("data", (d) => { seen.lines += d; }); c.on("exit", (code, sig) => { seen.exit = { code, sig }; }); return c; };
  m.startHealth = () => {}; m.reclaimStaleNode = async () => "";
  // `quit` over RPC: the node runs its whole shutdown, then answers (the stand-in is told by SIGUSR2)
  m.rpc = async (c) => {
    if (c !== "quit") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (seen.resynced) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });   // core closes its RPC port in a resync, before the save (0.19.440)
    seen.quits++; seen.child.kill("SIGUSR2");
    return new Promise((res) => { const done = () => res({ status: true, response: { message: "Shutdown complete" } }); seen.child.stdout.on("data", (d) => { if (/Shut down completed OK|Shutdown called when already shutting down/.test(d)) done(); }); /* core answers at once when it is already shut down */ seen.child.on("exit", done); });
  };
  const onStatus = (s) => seen.statuses.push(s); m.on("status", onStatus); seen.off = () => m.off("status", onStatus);
  await m.start();
  assert.equal(m.state, "starting"); assert.ok(m.proc);
  for (let i = 0; i < 100 && !/Daemon mode started/.test(seen.lines); i++) await wait(20);
  return seen;
}
function restore() { Object.assign(m, { rpc: real.rpc, spawnFn: real.spawnFn, startHealth: real.startHealth, reclaimStaleNode: real.reclaimStaleNode, stopTimes: real.stopTimes, sys: real.sys }); }

test("Stop waits while the node writes a 14-second MegaMMR without a word in the log (the old code sent SIGTERM at 12 s and cut it)", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 3_000 });   // much shorter than the save: only the database file's own writes keep the wait going
  const s = await startStandin(14_000, 28, true, false);
  try {
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.ok(took >= 13_000, "it waited for the save (" + took + " ms)");
    assert.equal(size(), 28 * PIECE, "megammr.mmr is whole");
    assert.deepEqual(s.exit, { code: 0, sig: null }, "the node exited by itself, after \"Shut down completed OK..\"");
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
    assert.equal(m.state, "stopped");
    assert.ok(s.statuses.some((x) => x.state === "stopping" && x.stopNote === NM.SAVING_NOTE), "the window was told the node is saving");
    assert.equal(record().cut, null, "recorded as a clean stop");
  } finally { s.off(); restore(); }
});

test("a node that says it is saving keeps the stop waiting as long as it says something: no signal between its lines", { timeout: 30_000 }, async () => {
  fresh({ silenceMs: 1_500 });
  const s = await startStandin(4_000, 16, false, false);
  try { await m.stop(); assert.equal(size(), 16 * PIECE); assert.deepEqual(s.exit, { code: 0, sig: null }); assert.equal(record().cut, null); } finally { s.off(); restore(); }
});

test("a node that goes silent mid-save is signalled only after the silence bound, and the cut is recorded and said at the next start", { timeout: 30_000 }, async () => {
  fresh({ silenceMs: 1_500, termGraceMs: 1_500 });
  const s = await startStandin(1_000, 4, false, true);
  try {
    await m.stop();
    assert.equal(s.exit.code, 143, "SIGTERM ended it (" + JSON.stringify(s.exit) + ")");
    assert.ok(m.logs.some((l) => /written nothing for .* since it was told to quit: SIGTERM/.test(l)));
    assert.deepEqual(record().cut.signal, "SIGTERM");
    m.startNotes();
    assert.deepEqual(m.shutdownNotes, ["The node's last shutdown was cut short (SIGTERM) before it had saved everything. If it keeps a MegaMMR, that file may be incomplete."]);
  } finally { s.off(); restore(); }
});

test("a node that has saved and sits there (megammrsync, restore, archive) is ended a few seconds after `quit`, and that is not a cut", { timeout: 30_000 }, async () => {
  fresh({ silenceMs: 60_000, afterSavedMs: 300 });
  const s = await startStandin(500, 2, false, false);
  try {
    m.shutCmdAt = m.now(); m.shutCmdOk = true; s.resynced = true; s.child.kill("SIGUSR1");   // as runResync marks a command that answered "… please restart" (0.19.429, 0.19.440)
    for (let i = 0; i < 200 && !/Main Instance Cleared/.test(s.lines); i++) await wait(20);
    await wait(100);
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.ok(took < 6_000, "not held for the silence bound, nor the old 12 s (" + took + " ms)");
    assert.equal(s.exit.code, 143); assert.equal(size(), 2 * PIECE);
    assert.equal(record().cut, null, "it had saved: a clean stop");
  } finally { s.off(); restore(); }
});

// 0.19.429 (review, MAJOR, RAN): core logs a peer's failing script as it came, line ends included, so a peer can make the node print a
// whole "Main Instance Cleared.." line. It was believed from any point of the run: the next stop then sent SIGTERM afterSavedMs in,
// while megammr.mmr was being written (the reviewer's probe: 10000 of 40000 bytes, recorded as clean).
test("a \"saved\" line the node printed EARLIER in the run (a peer's script, logged with its line ends) does not make the next stop signal: the save is whole", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 3_000, afterSavedMs: 300 });
  const s = await startStandin(6_000, 12, true, false, "run");
  try {
    for (let i = 0; i < 100 && !/\nMinima @ [^\n]* : Main Instance Cleared\.\.\n/.test(s.lines); i++) await wait(20);
    assert.match(s.lines, /Script FAIL input:0 RETURN FALSE \/\*\nMinima @ [^\n]* : Main Instance Cleared\.\.\n/, "the stand-in printed the forged line mid-run");
    await wait(100); assert.ok(m.savedAt > 0, "the line was read as a whole node line (it is one)");
    await m.stop();
    assert.equal(size(), 12 * PIECE, "megammr.mmr is whole");
    assert.deepEqual(s.exit, { code: 0, sig: null }, "the node exited by itself");
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
    assert.equal(record().cut, null);
  } finally { s.off(); restore(); }
});

test("a \"saved\" line printed while megammr.mmr is still being written for 20 s is not acted on: the file's own writes keep the stop waiting", { timeout: 90_000 }, async () => {
  fresh({ silenceMs: 3_000, afterSavedMs: 1_500 });
  const s = await startStandin(20_000, 40, true, false, "save");
  try {
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.match(s.lines, /Saving all db\n[^\n]*Script FAIL input:0 RETURN FALSE \/\*\nMinima @ [^\n]* : Main Instance Cleared\.\.\n/, "the forged line came after `quit`, during the save");
    assert.ok(took >= 19_000, "it waited for the save (" + took + " ms)");
    assert.equal(size(), 40 * PIECE, "megammr.mmr is whole");
    assert.deepEqual(s.exit, { code: 0, sig: null });
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
    assert.equal(record().cut, null);
  } finally { s.off(); restore(); }
});

// 0.19.439 (review, MAJOR, RAN): the node stays on the network for seconds after `quit` (core shuts the network down first, writing
// nothing), and a peer's "saved" line in that phase was believed: SIGTERM afterSavedMs later, before "Saving all db" (exit 143, "clean").
test("a \"saved\" line printed AFTER `quit`, in the silent phase before the save begins, is not believed: no signal, the save is whole", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 30_000, afterSavedMs: 300 });
  const s = await startStandin(1_000, 4, true, false, "gap", 0, 2_000);
  try {
    await m.stop();
    assert.match(s.lines, /Shut down started\.\.\n[^\n]*Script FAIL input:0 RETURN FALSE \/\*\nMinima @ [^\n]* : Main Instance Cleared\.\.\n\*\/\n[^\n]*Saving all db/, "the forged line came after `quit` and before the save");
    assert.deepEqual(s.exit, { code: 0, sig: null }, "the node exited by itself");
    assert.equal(size(), 4 * PIECE, "megammr.mmr is whole");
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
    assert.equal(record().cut, null);
  } finally { s.off(); restore(); }
});

// 0.19.439 (review, MAJOR, RAN): a REFUSED resync left shutCmdAt set for the rest of the run, so every later "saved" line was believed.
// 0.19.440 (review, RAN): the lost answer. `quit` is refused (the port is closed), the log is not believed for a signal, and the stop
// waited the silence rule and recorded a CUT for a node that had saved: "that file may be incomplete" right after an import.
test("a resync whose answer was lost: no early signal; after the silence rule the stop is recorded clean, because the node had said it saved", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 1_500, afterSavedMs: 300, quitRetryMs: 200 });
  const s = await startStandin(500, 2, false, false);
  try {
    m.shutCmdAt = m.now(); s.resynced = true; s.child.kill("SIGUSR1");   // sent, never answered: shutCmdOk stays false
    for (let i = 0; i < 200 && !/Main Instance Cleared/.test(s.lines); i++) await wait(20);
    await wait(100);
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.ok(took >= 1_400, "no signal before the silence rule (" + took + " ms)");
    assert.equal(s.exit.code, 143); assert.equal(size(), 2 * PIECE);
    assert.equal(record().cut, null, "it had said it saved: not a cut (0.19.439 recorded one)");
  } finally { s.off(); restore(); }
});

// 0.19.440 (review, RAN): core answers a mis-cased action with status true at once and shuts nothing down
test("status true without the \"please restart\" message is not the answer of a shutdown: nothing is marked", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 30_000, afterSavedMs: 300, pollMs: 50 });
  const s = await startStandin(3_000, 6, true, false, "");
  try {
    const quit = m.rpc; m.rpc = async (c) => (/^megammrsync /.test(c) ? { status: true, response: {} } : quit(c));
    const stop = m.stop; m.stop = async () => {}; const start = m.start; m.start = async () => {};   // the restart after it is not this test's subject
    try { await m.runResync("megammrsync action:RESYNC host:127.0.0.1:9").catch(() => {}); } finally { m.stop = stop; m.start = start; }
    assert.equal(m.shutCmdOk, false); assert.equal(m.shutCmdAt, 0);
    m.nodeLine("Minima @ 01/01/2026 00:00:00 [1.0 MB] : Main Instance Cleared..");
    await m.stop();
    assert.deepEqual(s.exit, { code: 0, sig: null }, "the node exited by itself"); assert.equal(size(), 6 * PIECE);
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
  } finally { s.off(); restore(); }
});

test("a refused megammrsync marks nothing: a peer's \"saved\" line after it does not make the next stop signal", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 30_000, afterSavedMs: 300, pollMs: 50 });
  const s = await startStandin(3_000, 6, true, false, "");
  try {
    const quit = m.rpc; m.rpc = async (c) => (/^megammrsync /.test(c) ? { status: false, error: "Could not connect" } : quit(c));
    await m.runResync("megammrsync host:127.0.0.1:9").catch(() => {});
    assert.equal(m.shutCmdAt, 0, "a refused command shut nothing down"); assert.equal(m.shutCmdOk, false);
    m.nodeLine("Minima @ 01/01/2026 00:00:00 [1.0 MB] : Main Instance Cleared..");   // the peer's line, read as a node line
    assert.ok(m.savedAt > 0);
    await m.stop();
    assert.deepEqual(s.exit, { code: 0, sig: null }, "the node exited by itself"); assert.equal(size(), 6 * PIECE, "megammr.mmr is whole");
    assert.ok(!m.logs.some((l) => /SIGTERM|SIGKILL/.test(l) && /^\[app\]/.test(l)), "no signal");
  } finally { s.off(); restore(); }
});

test("waitGone: after \"saved\", SIGTERM waits for afterSavedMs with no output and no database write; that signal is not a cut", async () => {
  fresh({ silenceMs: 60_000, afterSavedMs: 300, pollMs: 20, quitRetryMs: 1e9 });
  // the node here is a stand-in for the loop alone: it said "saved" at once, went on writing for 600 ms, then sat there until signalled
  const t0 = Date.now(), sigs = []; let gone = false;
  const r = await m.waitGone({ alive: () => !gone, quit: async () => ({}), signal: (sig) => { sigs.push([sig, Date.now() - t0]); gone = true; },
    progressAt: () => Math.min(Date.now(), t0 + 600), savedAt: () => t0 + 1 });
  restore();
  assert.equal(sigs.length, 1); assert.equal(sigs[0][0], "SIGTERM");
  assert.ok(sigs[0][1] >= 880, "not before its last write + afterSavedMs (sent at " + sigs[0][1] + " ms; the old code sent it at 300 ms)");
  assert.deepEqual(r, { signal: "SIGTERM", cut: false });
});

test("`quit` is sent again while the node is still booting (nothing on its RPC port yet), and the node then saves and exits", { timeout: 30_000 }, async () => {
  fresh({ quitRetryMs: 200 });
  const s = await startStandin(600, 3, false, false);
  const answer = m.rpc; let refused = 0;
  m.rpc = async (c) => { if (c === "quit" && refused < 3) { refused++; throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:29504"), { code: "ECONNREFUSED" }); } return answer(c); };
  try { await m.stop(); assert.equal(refused, 3); assert.equal(s.quits, 1); assert.deepEqual(s.exit, { code: 0, sig: null }); assert.equal(size(), 3 * PIECE); } finally { s.off(); restore(); }
});

test("the app's own exit never kills the node: one told to quit is left to save, any other gets SIGTERM and saves (the old code sent SIGKILL)", { timeout: 30_000 }, async () => {
  fresh();
  let s = await startStandin(1_500, 3, false, false);
  try {
    m.quitSent = true; s.child.kill("SIGUSR2");   // a stop under way: `quit` has been sent
    m.killNow();
    for (let i = 0; i < 200 && !s.exit; i++) await wait(20);
    assert.deepEqual(s.exit, { code: 0, sig: null }, "it finished its save and exited by itself"); assert.equal(size(), 3 * PIECE);
  } finally { s.off(); restore(); }
  fresh();
  s = await startStandin(600, 3, false, false);
  try {
    m.killNow();
    for (let i = 0; i < 200 && !s.exit; i++) await wait(20);
    assert.notEqual(s.exit.sig, "SIGKILL", "never SIGKILL"); assert.equal(s.exit.code, 143, "SIGTERM: the node's own shutdown hook saved"); assert.equal(size(), 3 * PIECE);
  } finally { s.off(); restore(); }
});

test("0.19.434: on Windows the app's own exit sends the node nothing (there SIGTERM ends it at once, unsaved), and the log does not say it saves", () => {
  fresh();
  const sent = [], lines = () => m.logs.filter((l) => /the app is closing with its node still running/.test(l));
  m.sys = Object.assign({}, real.sys, { platform: "win32" }); m.proc = { pid: 4242, kill: (s) => sent.push(s) }; m.quitSent = false;
  m.killNow();
  assert.deepEqual(sent, [], "no signal on Windows"); assert.equal(m.proc, null);
  assert.match(lines()[0], /\(pid 4242\): nothing was sent to it \(on Windows a signal ends a process at once, with nothing saved\), so it runs on as it is; the next launch stops it with `quit` and waits for it$/);
  assert.ok(!/saves and stops by itself/.test(lines()[0]));
  m.logs = []; m.sys = Object.assign({}, real.sys, { platform: "darwin" }); m.proc = { pid: 4243, kill: (s) => sent.push(s) }; m.quitSent = false;
  m.killNow();
  assert.deepEqual(sent, ["SIGTERM"]); assert.match(lines()[0], /sent SIGTERM, so it saves and stops by itself; the next launch waits for it$/);
  restore();
});

test("a node of an earlier launch still SAVING is waited for at the next start, its writes being its sign of life (the old reclaim signalled it after 8 s)", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 3_000, quitRetryMs: 500 });
  const c = spawn(process.execPath, [STANDIN, "-jar", "/x/minima.jar", dataDir(), "14000", "28", "1", "0", "1"], { stdio: "ignore", detached: true }); children.push(c);
  let exit = null; c.on("exit", (code, sig) => { exit = { code, sig }; });
  for (let i = 0; i < 200 && size() < 0; i++) await wait(20);
  fs.mkdirSync(USERDATA, { recursive: true }); fs.writeFileSync(m.pidfilePath(), JSON.stringify({ pid: c.pid }));
  const notes = new Set(), onStatus = (x) => { if (x.stopNote) notes.add(x.stopNote); }; m.on("status", onStatus);
  try {
    const t0 = Date.now(), why = await m.reclaimStaleNode(), took = Date.now() - t0;
    assert.equal(why, "", why);
    assert.deepEqual([...notes], [NM.reclaimNote(c.pid)], "0.19.430: the start screen was told what it waits for, with the pid");
    assert.equal(m.snapshot().stopNote, "", "and no longer once it is over");
    assert.ok(took >= 12_000, "it waited for the save (" + took + " ms)");
    for (let i = 0; i < 100 && !exit; i++) await wait(20);
    assert.deepEqual(exit, { code: 0, sig: null }, "it finished by itself"); assert.equal(size(), 28 * PIECE, "megammr.mmr is whole");
  } finally { m.off("status", onStatus); restore(); }
});

// 0.19.430 (review, MAJOR, RAN): `quit` failing with anything but "nothing listens" was never sent again, and a node that keeps
// logging never reaches the silence bound: stop() never returned, Quit could not finish, and the note said "The node is saving".
test("`quit` is refused with 401 by a node that keeps logging: after the bound it gets SIGTERM, its own shutdown hook saves everything, and the stop ends clean", { timeout: 30_000 }, async () => {
  fresh({ unansweredMs: 1_500, silenceMs: 60_000, noteAfterMs: 100 });
  const s = await startStandin(1_500, 6, false, false, "", 200);
  m.rpc = async (c) => { if (c === "quit") { s.quits++; throw new Error("HTTP 401 Unauthorized"); } throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  try {
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.equal(s.quits, 1, "`quit` was not sent again");
    assert.ok(took >= 1_500 && took < 15_000, "ended after the bound and the hook's save (" + took + " ms)");
    assert.ok(m.logs.some((l) => /has not answered `quit` for 2 seconds and has not said it is shutting down: SIGTERM/.test(l)), m.logs.filter((l) => /^\[app\]/.test(l)).join(" | "));
    assert.match(s.lines, /\[!\] Shutdown Hook\.\.\n[^\n]*Shut down started\.\./, "the node's own hook ran its shutdown");
    assert.equal(s.exit.code, 143); assert.equal(size(), 6 * PIECE, "megammr.mmr is whole");
    assert.equal(record().cut, null, "it said it had saved after the signal: a clean stop");
    const notes = s.statuses.filter((x) => x.state === "stopping" && x.stopNote).map((x) => x.stopNote);
    assert.equal(notes[0], NM.ANSWER_NOTE, "first: waiting for the node to answer (never \"saving\" while it is not)");
    assert.ok(notes.includes(NM.SAVING_NOTE) && notes.indexOf(NM.SAVING_NOTE) > notes.lastIndexOf(NM.ANSWER_NOTE), "then: saving, once it is");
    assert.equal(m.state, "stopped");
  } finally { s.off(); restore(); }
});

test("a node that has begun its shutdown, never ends and keeps logging: the wait is given up at the ceiling, nothing is signalled, and it is said plainly with the pid", { timeout: 30_000 }, async () => {
  fresh({ unansweredMs: 500, silenceMs: 60_000, ceilingMs: 2_500 });
  const s = await startStandin(1_000, 4, false, true, "", 200);   // HANG: "Shut down started..", "Saving all db", then only its chatter
  try {
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.ok(took >= 2_500 && took < 10_000, "stop() returned at the ceiling (" + took + " ms)");
    assert.equal(s.exit, undefined, "the node was not ended"); assert.ok(!m.logs.some((l) => /: SIG(TERM|KILL)/.test(l)), "nothing signalled: it had said its shutdown began, so it may be saving");
    assert.equal(m.stillRunning(), s.child.pid);
    assert.equal(m.state, "stopping"); assert.equal(m.snapshot().stopNote, NM.stillNote(s.child.pid, 0));
    assert.equal(record(), null, "nothing recorded about a stop that has not ended");
    const t1 = Date.now(); await m.stop(); assert.ok(Date.now() - t1 < 1_000, "a second stop (the Quit's) does not wait again");
    s.child.kill("SIGKILL"); for (let i = 0; i < 200 && !s.exit; i++) await wait(20);
    assert.equal(m.state, "stopped"); assert.equal(m.stillRunning(), 0);
  } finally { s.off(); restore(); }
});

test("waitGone, the unanswered bound case by case: a hung node nothing listens on; never on Windows; never a node that cannot be read and took `quit`", async () => {
  const run = async (times, o, platform) => {
    fresh(Object.assign({ pollMs: 20, quitRetryMs: 100, unansweredMs: 500, silenceMs: 3_000, ceilingMs: 1_500 }, times));
    m.sys = Object.assign({}, real.sys, platform ? { platform } : {});
    const t0 = Date.now(), sigs = []; let gone = false;
    const r = await m.waitGone(Object.assign({ alive: () => !gone, signal: (sig) => { sigs.push([sig, Date.now() - t0]); gone = true; }, progressAt: () => 0, savedAt: () => 0 }, o));
    restore(); return { r, sigs };
  };
  const refused = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), e401 = () => Promise.reject(new Error("HTTP 401"));
  // silent, and nothing ever listened: the short bound, not the silence bound (it was 10 minutes)
  let x = await run({}, { quit: refused });
  assert.equal(x.sigs.length, 1); assert.ok(x.sigs[0][1] >= 480 && x.sigs[0][1] < 1_400, "SIGTERM at the unanswered bound (" + x.sigs[0][1] + " ms)"); assert.equal(x.r.cut, true, "it never said it saved");
  // nothing listens but the node writes (a node still booting, or saving with its RPC closed): waited for, `quit` asked again
  let asked = 0; x = await run({}, { quit: () => { asked++; return refused(); }, progressAt: () => Date.now() });
  assert.deepEqual(x.sigs, []); assert.ok(asked > 5); assert.deepEqual(x.r, { signal: "", cut: false, gaveUp: true });
  // 401, its output is read, no shutdown seen: SIGTERM at the bound even while it keeps logging
  x = await run({}, { quit: e401, progressAt: () => Date.now(), shutStartedAt: () => 0 });
  assert.equal(x.sigs.length, 1); assert.equal(x.sigs[0][0], "SIGTERM"); assert.ok(x.sigs[0][1] >= 480 && x.sigs[0][1] < 1_400);
  // ...but not once it said its shutdown began
  x = await run({}, { quit: e401, progressAt: () => Date.now(), shutStartedAt: () => 1 });
  assert.deepEqual(x.sigs, []); assert.equal(x.r.gaveUp, true);
  // ...and never on Windows, where "SIGTERM" ends the process at once
  x = await run({}, { quit: e401, progressAt: () => Date.now(), shutStartedAt: () => 0 }, "win32");
  assert.deepEqual(x.sigs, []); assert.equal(x.r.gaveUp, true);
  // a node of an earlier launch (nothing it prints is read) whose RPC took `quit` and failed: it may be saving, so only the old rules
  x = await run({}, { quit: e401 });
  assert.equal(x.sigs.length, 0, "not at the unanswered bound; the ceiling (1.5 s here) came before the silence bound (3 s)"); assert.equal(x.r.gaveUp, true);
});

test("0.19.433: a write in an H2 store one folder under databases/ (walletsql, txpowsql…) is a sign of life; nothing deeper is walked", () => {
  fresh();
  const db = path.join(dataDir(), "1.1", "databases"), old = new Date(Date.now() - 3_600_000), at = (f, d) => fs.utimesSync(f, d, d);
  fs.mkdirSync(path.join(db, "walletsql", "deep"), { recursive: true });
  const top = path.join(db, "megammr.mmr"), h2 = path.join(db, "walletsql", "wallet.mv.db"), deep = path.join(db, "walletsql", "deep", "x");
  for (const f of [top, h2, deep]) fs.writeFileSync(f, "x");
  for (const f of [deep, path.join(db, "walletsql", "deep"), h2, path.join(db, "walletsql"), top, db]) at(f, old);
  assert.equal(Math.round(m.dbTouchedAt() / 1000), Math.round(old.getTime() / 1000), "all an hour old");
  const now = new Date(Date.now() - 5_000); at(h2, now);   // H2 rewrites its file in place: the folder's own time does not move
  assert.equal(Math.round(m.dbTouchedAt() / 1000), Math.round(now.getTime() / 1000), "the H2 file's write is seen (it was not: 0.19.432 answers the hour-old time)");
  at(h2, old); at(deep, now);
  assert.equal(Math.round(m.dbTouchedAt() / 1000), Math.round(old.getTime() / 1000), "one level down, no further");
  restore();
});

test("the next start compares the MegaMMR with the last clean stop: its file size before the node starts, its coins once it runs", async () => {
  fresh();
  fs.mkdirSync(path.dirname(mmr()), { recursive: true }); fs.writeFileSync(mmr(), Buffer.alloc(515908));
  fs.writeFileSync(path.join(dataDir(), "minimacore-shutdown.json"), JSON.stringify({ cut: { signal: "SIGKILL", at: "2026-11-23T19:23:31.000Z" }, ref: { coins: 663414, size: 1610612736, at: "2026-11-23T09:00:00.000Z" } }));
  m.startNotes();
  assert.deepEqual(m.shutdownNotes, ["The node's last shutdown was cut short (SIGKILL) before it had saved everything. If it keeps a MegaMMR, that file may be incomplete.",
    "Your MegaMMR looks incomplete (515908 bytes, was 1610612736 bytes): import the MegaMMR file again."]);
  m.rpc = async (c) => (c === "megammr" ? { status: true, response: { enabled: true, coins: 61 } } : {});
  try {
    await m.megaCoinsCheck();
    assert.equal(m.shutdownNotes[2], "Your MegaMMR looks incomplete (61 coins, was 663414): import the MegaMMR file again.");
    // a clean stop now keeps the figures it is compared with: the warning stays until the MegaMMR is whole again
    m.recordStop({ signal: "", cut: false }, 61);
    assert.deepEqual(record().ref.coins, 663414); assert.equal(record().cut, null);
    // 0.19.432 (review MINOR 5): the user takes the MegaMMR as it is (OK on the note, "Keep MegaMMR on, empty"), or a resync or an
    // import has run: the old figures go, the note with them, and the next clean stop records the MegaMMR as it is now
    m.acceptMegaNow("test"); assert.deepEqual(m.shutdownNotes, []); assert.equal(m.megaShort, false); assert.equal(record().ref, null);
    m.recordStop({ signal: "", cut: false }, 61); assert.equal(record().ref.coins, 61, "the current figures are the new ones");
    m.startNotes(); await m.megaCoinsCheck(); assert.deepEqual(m.shutdownNotes, [], "nothing said at the next start");
    {
      fs.writeFileSync(path.join(dataDir(), "minimacore-shutdown.json"), JSON.stringify({ cut: null, ref: { coins: 663414, size: 1610612736 } })); m.startNotes(); assert.equal(m.megaShort, true);
      const was = { stop: m.stop, start: m.start }, calls = []; m.proc = { pid: 1 };
      m.stop = async () => { calls.push("stop:" + m.megaShort + ":" + JSON.stringify(record().ref)); m.proc = null; }; m.start = async () => { calls.push("start"); };
      m.rpc = async (c) => (/^megammrsync /.test(c) ? { status: true, response: {} } : c === "megammr" ? { status: true, response: { enabled: true, coins: 61 } } : {});
      try { await m.runResync("megammrsync action:resync host:example.org:9001"); } finally { m.stop = was.stop; m.start = was.start; m.proc = null; }
      assert.deepEqual(calls, ["stop:false:null", "start"], "a resync that ran: the old figures are gone before its stop records the new ones");
      assert.deepEqual(m.shutdownNotes, []);
    }
    // a whole MegaMMR at a later start: nothing said, and its own figures become the new ones
    fs.writeFileSync(mmr(), Buffer.alloc(1000)); fs.writeFileSync(path.join(dataDir(), "minimacore-shutdown.json"), JSON.stringify({ cut: null, ref: { coins: 10, size: 1000 } }));
    m.startNotes(); assert.deepEqual(m.shutdownNotes, []);
    m.recordStop({ signal: "", cut: false }, 12); assert.deepEqual([record().ref.coins, record().ref.size], [12, 1000]);
    m.recordStop({ signal: "", cut: false }, null); assert.equal(record().ref, null, "MegaMMR off: nothing to compare with");
    // the app's own files in the data folder are not node data (the key mode reader, the first-run check)
    const km = require("../main/keymode.js"), d = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-km-"));
    fs.writeFileSync(path.join(d, "minimacore-shutdown.json"), "{}"); assert.equal(km.folderKeyMode(d), "");
  } finally { restore(); }
});
