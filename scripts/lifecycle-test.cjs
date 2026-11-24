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
const m = NM, real = { rpc: m.rpc, spawnFn: m.spawnFn, startHealth: m.startHealth, reclaimStaleNode: m.reclaimStaleNode, stopTimes: m.stopTimes };
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
  m.keyModeAlert = ""; m.proc = null; m.state = "stopped"; m.stopRun = null; m.shutdownNotes = [];
}
/** A start of node-manager whose "java" is the stand-in: argv after the script = the stand-in's own (saveMs, pieces, quiet, hang). */
async function startStandin(saveMs, pieces, quiet, hang) {
  const seen = { lines: "", quits: 0, statuses: [] };
  m.spawnFn = (_cmd, _args, opts) => { const c = spawn(process.execPath, [STANDIN, dataDir(), String(saveMs), String(pieces), quiet ? "1" : "0", hang ? "1" : "0"], opts); children.push(c); seen.child = c;
    c.stdout.on("data", (d) => { seen.lines += d; }); c.on("exit", (code, sig) => { seen.exit = { code, sig }; }); return c; };
  m.startHealth = () => {}; m.reclaimStaleNode = async () => "";
  // `quit` over RPC: the node runs its whole shutdown, then answers (the stand-in is told by SIGUSR2)
  m.rpc = async (c) => {
    if (c !== "quit") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    seen.quits++; seen.child.kill("SIGUSR2");
    return new Promise((res) => { const done = () => res({ status: true, response: { message: "Shutdown complete" } }); seen.child.stdout.on("data", (d) => { if (/Shut down completed OK/.test(d)) done(); }); seen.child.on("exit", done); });
  };
  const onStatus = (s) => seen.statuses.push(s); m.on("status", onStatus); seen.off = () => m.off("status", onStatus);
  await m.start();
  assert.equal(m.state, "starting"); assert.ok(m.proc);
  for (let i = 0; i < 100 && !/Daemon mode started/.test(seen.lines); i++) await wait(20);
  return seen;
}
function restore() { Object.assign(m, { rpc: real.rpc, spawnFn: real.spawnFn, startHealth: real.startHealth, reclaimStaleNode: real.reclaimStaleNode, stopTimes: real.stopTimes }); }

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
    s.child.kill("SIGUSR1");
    for (let i = 0; i < 200 && !/Main Instance Cleared/.test(s.lines); i++) await wait(20);
    await wait(100);
    const t0 = Date.now(); await m.stop(); const took = Date.now() - t0;
    assert.ok(took < 6_000, "not held for the silence bound, nor the old 12 s (" + took + " ms)");
    assert.equal(s.exit.code, 143); assert.equal(size(), 2 * PIECE);
    assert.equal(record().cut, null, "it had saved: a clean stop");
  } finally { s.off(); restore(); }
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

test("a node of an earlier launch still SAVING is waited for at the next start, its writes being its sign of life (the old reclaim signalled it after 8 s)", { timeout: 60_000 }, async () => {
  fresh({ silenceMs: 3_000, quitRetryMs: 500 });
  const c = spawn(process.execPath, [STANDIN, "-jar", "/x/minima.jar", dataDir(), "14000", "28", "1", "0", "1"], { stdio: "ignore", detached: true }); children.push(c);
  let exit = null; c.on("exit", (code, sig) => { exit = { code, sig }; });
  for (let i = 0; i < 200 && size() < 0; i++) await wait(20);
  fs.mkdirSync(USERDATA, { recursive: true }); fs.writeFileSync(m.pidfilePath(), JSON.stringify({ pid: c.pid }));
  try {
    const t0 = Date.now(), why = await m.reclaimStaleNode(), took = Date.now() - t0;
    assert.equal(why, "", why);
    assert.ok(took >= 12_000, "it waited for the save (" + took + " ms)");
    for (let i = 0; i < 100 && !exit; i++) await wait(20);
    assert.deepEqual(exit, { code: 0, sig: null }, "it finished by itself"); assert.equal(size(), 28 * PIECE, "megammr.mmr is whole");
  } finally { restore(); }
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
