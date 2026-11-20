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
