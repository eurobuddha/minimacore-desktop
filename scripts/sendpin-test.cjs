/*
 * sendpin-test.cjs — main/sendpin.js pinMinimaSend: a chain of commands (;) is never pinned (0.18.154).
 * Run: node --test scripts/sendpin-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const { pinMinimaSend } = require("../main/sendpin");

const A = "0x" + "AB".repeat(32);
const rig = () => { const asked = []; return { asked, run: async (c) => { asked.push(c); return c.startsWith("coins ") ? { status: true, response: [{ coinid: "0x01", amount: "5", address: A }] } : c.startsWith("checkaddress") ? { status: true, response: { simple: true } } : { status: true }; } }; };

test("a single MINIMA send is still pinned to a signable coin", async () => {
  const r = rig();
  assert.equal(await pinMinimaSend(r.run, "send amount:1 address:0xCD"), "send amount:1 address:0xCD fromaddress:" + A);
});

test("a chain is sent as typed: no fromaddress: on the last command, and no coin looked up", async () => {
  for (const chain of ["send amount:1 address:0xCD; status", "send amount:1 address:0xCD;send amount:2 address:0xEF", "send amount:1 address:0xCD tokenid:0x00 ; balance"]) {
    const r = rig();
    assert.equal(await pinMinimaSend(r.run, chain), chain);
    assert.deepEqual(r.asked, [], chain);
  }
});

// ---- 0.18.175: the verb and parameters read as the node reads them ----
test("a send written with quotes, a control character or ':' spacing is pinned like a plain one; a token send or one with its own fromaddress is not", async () => {
  for (const c of ['"send" amount:1 address:0xCD', '\u0001send amount:1 address:0xCD', 'SEND amount:1 address:0xCD', 'send amount : 1 address:0xCD', 's"en"d amount:1 address:0xCD', '"send"amount:1 address:0xCD']) {
    const r = rig(); assert.equal(await pinMinimaSend(r.run, c), c + " fromaddress:" + A, JSON.stringify(c));
  }
  for (const c of ['"send" amount:1 address:0xCD tokenid : 0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', "send amount:1 address:0xCD fromaddress : 0xEE", 'send amount:1 address:0xCD "fromaddress":0xEE', "sendpoll action:list", "sendfrom amount:1 address:0xCD"]) {
    const r = rig(); assert.equal(await pinMinimaSend(r.run, c), c, JSON.stringify(c)); assert.deepEqual(r.asked, []);
  }
  const main = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/const pinned = await pinMinimaSend\(run, command\);/.test(main) && !/\/\^send\\s\/\.test\(command\)/.test(main), "mcd:cmd no longer decides with /^send\\s/");
});
test("the RPC write timeout reads the verb as the node does", () => {
  const { _timeoutFor } = require("../main/rpc");
  for (const c of ['"send" amount:1', "\u0002vault", 'v"ault"', "status;send amount:1", "SEEDRANDOM modifier:x"]) assert.equal(_timeoutFor(c), 180000, JSON.stringify(c));
  for (const c of ["status", "balance", '"status"']) assert.equal(_timeoutFor(c), 30000, c);
});
