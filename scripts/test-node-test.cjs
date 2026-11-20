/*
 * test-node-test.cjs — no script in this repo reaches a node or a docker container unless the caller names a test
 * node (0.18.161). Runs nothing live: test-node.cjs is exercised with a stand-in transport and process.exit trapped,
 * and the scripts that boot the AtomiX engine are READ, never run.
 * Run: node --test scripts/test-node-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { testNode, balanceProblem } = require("./test-node.cjs");

const exitTrap = (fn) => { const real = process.exit, err = console.error, log = console.log; let code = null; process.exit = (c) => { code = c; throw new Error("exit " + c); }; console.error = () => {}; console.log = () => {};
  try { fn(); } catch (e) { if (code == null) throw e; } finally { process.exit = real; console.error = err; console.log = log; } return code; };

test("nothing named: no node; half named or not owned: refused before anything is sent", () => {
  assert.equal(testNode([], {}), null);
  let sent = 0; const t = async () => { sent++; return { status: true, response: [] }; };
  assert.equal(exitTrap(() => testNode([], { AX_TEST_NODE_CONTAINER: "c1" }, t)), 2, "a container with no RPC address");
  assert.equal(exitTrap(() => testNode([], { AX_TEST_NODE_RPC: "http://127.0.0.1:1234" }, t)), 2, "not said to be the caller's own");
  assert.equal(exitTrap(() => testNode([], { AX_TEST_NODE_RPC: "http://127.0.0.1", AX_TEST_NODE_I_OWN_THIS: "yes" }, t)), 2, "no port written");
  assert.equal(exitTrap(() => testNode([], { AX_TEST_NODE_RPC: "http://127.0.0.1:1", AX_TEST_NODE_CONTAINER: "a;b", AX_TEST_NODE_I_OWN_THIS: "yes" }, t)), 2);
  assert.equal(sent, 0);
});

test("a node that holds funds is refused unless it owns the address the caller wrote", async () => {
  const funded = async (c) => (c === "balance" ? { status: true, response: [{ tokenid: "0x00", confirmed: "5", unconfirmed: "0", sendable: "5" }] } : { status: true, response: { simple: false } });
  assert.match(await balanceProblem(funded, ""), /HOLDS FUNDS/);
  assert.match(await balanceProblem(funded, "0x" + "AB".repeat(32)), /is NOT one of its own/);
  assert.equal(await balanceProblem(async () => ({ status: true, response: [{ tokenid: "0x00", confirmed: "0", unconfirmed: "0", sendable: "0" }] }), ""), "");
  assert.match(await balanceProblem(async () => { throw new Error("down"); }, ""), /did not answer/);
  const asked = [], n = testNode(["x"], { AX_TEST_NODE_RPC: "http://127.0.0.1:1234", AX_TEST_NODE_I_OWN_THIS: "yes" }, async (c) => { asked.push(c); return { status: true, response: [] }; });
  const log = console.log; console.log = () => {}; try { await n.run("status"); } finally { console.log = log; }
  assert.deepEqual(asked, ["balance", "status"], "balance first, then the caller's command");
});

test("no script names the custody container or runs docker itself; the engine-booting scripts need a named node", () => {
  const dir = __dirname;
  for (const f of fs.readdirSync(dir).filter(f => /\.(c?js|sh)$/.test(f) && f !== "test-node-test.cjs")) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/minimega/i.test(src), f + " names a fixed container");
    if (f !== "test-node.cjs") assert.ok(!/["']docker["']/.test(src), f + " runs docker itself");
  }
  for (const f of ["atomix-boot-gate.js", "atomix-s2-gate.js"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(/const NODE = testNode\(/.test(src) && /if \(!NODE\) \{ console\.error\("S[12] (BOOT )?GATE NOT RUN: no test node was named\.[^\n]*process\.exit\(1\); \}/.test(src) && /atomix\._setRunner\(NODE\.run\)/.test(src), f);
    assert.ok(src.indexOf("if (!NODE)") < src.indexOf("(async () =>"), f + ": refuses before anything starts");
  }
  const unit = fs.readFileSync(path.join(dir, "atomix-unit.js"), "utf8");
  assert.ok(/const NODE = testNode\(/.test(unit) && /if \(!NODE\) \{\s*skipped\+\+;/.test(unit) && /const real = NODE\.run;/.test(unit), "atomix-unit's one live check uses a named node or skips");
  assert.ok(/if \(!process\.env\.AX_TEST_NODE_RPC && !process\.env\.AX_TEST_NODE_CONTAINER\) \{\s*const cp = require\("child_process"\);/.test(unit) && /if \(LEAKS\.length\) \{ fail\+\+;/.test(unit), "and fails if it starts a child process with none named");
  assert.ok(/const PORT = Number\(process\.env\.AX_TEST_CDP_PORT\);/.test(fs.readFileSync(path.join(dir, "cdp-eval.js"), "utf8")), "cdp-eval names no app port");
});
