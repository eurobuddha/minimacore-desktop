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
  assert.ok(/pin: \(c\) => pinMinimaSend\(run, c\)/.test(main) && !/\/\^send\\s\/\.test\(command\)/.test(main), "mcd:cmd no longer decides with /^send\\s/ (its pin goes through checkCommand since 0.18.201)");
});
test("the RPC write timeout reads the verb as the node does", () => {
  const { _timeoutFor } = require("../main/rpc");
  for (const c of ['"send" amount:1', "\u0002vault", 'v"ault"', "status;send amount:1", "SEEDRANDOM modifier:x"]) assert.equal(_timeoutFor(c), 180000, JSON.stringify(c));
  for (const c of ["status", "balance", '"status"']) assert.equal(_timeoutFor(c), 30000, c);
});

// ---- 0.18.187: the last tokenid/amount, a top-level fromaddress only; mcd:cmd refuses a send that repeats one ----
test("the pin reads the LAST tokenid and amount and a top-level fromaddress only, as the node does", async () => {
  const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  let r = rig(); assert.equal(await pinMinimaSend(r.run, "send amount:1 address:0xCD tokenid:0x00 tokenid:" + MX), "send amount:1 address:0xCD tokenid:0x00 tokenid:" + MX, "the last tokenid is MxUSD: not pinned");
  r = rig(); const c = "send amount:1 address:0xCD tokenid:" + MX + " tokenid:0x00"; assert.equal(await pinMinimaSend(r.run, c), c + " fromaddress:" + A, "the last tokenid is MINIMA: pinned");
  r = rig(); const st = 'send amount:1 address:0xCD state:{"1":"fromaddress:0xEE"}'; assert.equal(await pinMinimaSend(r.run, st), st + " fromaddress:" + A, "fromaddress: inside a state's JSON is not the parameter");
  r = rig(); const big = "send amount:1 amount:9 address:0xCD"; await pinMinimaSend(r.run, big);
  assert.ok(r.asked.some(q => q.startsWith("coins ")), "the amount looked for is the last one (9)");
  await assert.rejects(require("../main/cmdgate").checkCommand("send amount:1 tokenid:0x00 tokenid:0x01 address:0xA", { take: () => false, running: () => true }), /This send names tokenid more than once/, "mcd:cmd refuses a send that repeats one (checkCommand, 0.18.201)");
  const V = require("../main/cmdverb");
  assert.deepEqual(V.repeated("send amount:1 address:0xA address : 0xB", ["amount", "tokenid", "address", "fromaddress"]), ["address"]);
  assert.deepEqual(V.repeated('send amount:1 address:0xA state:{"address":"x"}', ["address"]), [], "a key inside a state's JSON is not a parameter");
});

test("0.18.189: the pin sees a tokenid glued after a quoted value", async () => {
  const MX = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  let r = rig(), c = 'send amount:1 address:0xCD tokenid:"0x00"tokenid:' + MX;
  assert.equal(await pinMinimaSend(r.run, c), c, "the last tokenid is MxUSD: not pinned"); assert.deepEqual(r.asked, []);
  r = rig(); c = 'send amount:1 address:0xCD tokenid:"' + MX + '"tokenid:0x00';
  assert.equal(await pinMinimaSend(r.run, c), c + " fromaddress:" + A, "the last tokenid is MINIMA (read as its own name after the quote): pinned");
});

// ---- 0.18.197: quote state, a quoted first word, unreadable amounts and multi sends ----
test("an unbalanced bracket inside a quoted value hides nothing; a quoted first word ends at its quote; an unreadable amount or a multi send is not pinned", async () => {
  const V = require("../main/cmdverb"), MX = "0x" + "CD".repeat(32);
  // CHANGED on purpose (0.18.219): the node's slow splitter counts a { or [ even inside quotes, so it reads ONE password value up to
  // the end (no amount, no tokenid): these are the node's readings, and mcd:cmd refuses such a send as unclear (main/cmdverb.js)
  assert.deepEqual(V.paramNames('send password:"ab{c" amount:50 address:0xAA tokenid:' + MX), ["password"]);
  assert.deepEqual(V.repeated('send password:"ab[c" amount:1 amount:2 address:0xAA', ["amount"]), []);
  assert.match(V.unclear('send password:"ab[c" amount:1 amount:2 address:0xAA'), /differently from how it is written/);
  // the [ inside the state's quoted value is never closed for the node, so state runs to the end and fromaddress is part of it
  assert.deepEqual(V.paramNames('send amount:50 address:0xAA state:{"0":"["} fromaddress:0xBB'), ["amount", "address", "state"]);
  assert.match(V.unclear('send amount:50 address:0xAA state:{"0":"["} fromaddress:0xBB'), /differently from how it is written/, "refused by mcd:cmd before any pin");
  assert.deepEqual(V.read('"txninput"id:a coinid : 0x01').params, [["id", "a"], ["coinid", "0x01"]]);
  let r = rig(); let c = 'send password:"ab{c" amount:50 address:0xAA tokenid:' + MX; assert.equal(await pinMinimaSend(r.run, c), c, "a token send stays a token send");
  r = rig(); c = 'send amount:50 address:0xAA state:{"0":"[x]"} fromaddress:0xBB'; assert.equal(await pinMinimaSend(r.run, c), c, "its own fromaddress is seen");
  r = rig(); c = 'send multi:["0xAA:10","0xBB:10"] split:2'; assert.equal(await pinMinimaSend(r.run, c), c); assert.deepEqual(r.asked, []);
  r = rig(); c = "send amount:all address:0xAA"; assert.equal(await pinMinimaSend(r.run, c), c, "an amount that is not a number"); assert.deepEqual(r.asked, []);
  r = rig(); c = "send address:0xAA"; assert.equal(await pinMinimaSend(r.run, c), c, "no amount");
});
