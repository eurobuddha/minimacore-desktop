/* Headless glue test for the casino module — MOCK runner, no node. Verifies:
 *  - the vm boots service.js + engine.js and exposes ctx.CASINO
 *  - checkmode is synthesised to WRITE
 *  - the house-create `send` is routed through pinMinimaSend (fromaddress appended)
 *  - createBet emits the exact covenant `send` (state ports 0..7, phase 0)
 *  - takeBet builds the correct txn sequence (contract input + funding + pot output storestate:true + states + auto sign)
 */
const path = require("path");
// Inject an in-memory keychain (config.getSecret/setSecret are used by casino.js's keypair shim; real config needs
// electron). `let` on the setSecret so the negative durability test can force it to fail.
const cfg = require(path.join(__dirname, "..", "main/config.js"));
const mem = {};
let secretWritesOk = true;
cfg.getSecret = (acct) => (acct in mem ? mem[acct] : null);
cfg.setSecret = (val, acct) => { if (!secretWritesOk) return false; mem[acct] = String(val); return true; };
cfg.deleteSecret = (acct) => { delete mem[acct]; };
const casino = require(path.join(__dirname, "..", "main/casino.js"));

const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
const sent = [];   // every command the engine issued through the shim → runner

// A signable wallet coin (66-char addr, >= any stake) + a sentinel beacon dust coin (short addr, unsignable).
const WALLET_ADDR = "0x" + "AB".repeat(32);            // 66 chars
const BEACON_ADDR = "0x50414E4441504F4F4C53";          // "PANDAPOOLS" — short, anyone-can-spend
const OPEN_BET = {   // someone else's phase-0 Coin Flip open bet at the contract
  coinid: "0xBET1", amount: "1", age: 3,
  state: [
    { port: 0, data: "0xHOUSEPK" }, { port: 1, data: "0xHOUSEADDR" }, { port: 2, data: "0xCOMMIT" },
    { port: 3, data: "2" }, { port: 4, data: "2" }, { port: 5, data: "1" }, { port: 6, data: "0" }, { port: 7, data: "1500" }
  ]
};

casino._setRunner(async (cmd) => {
  sent.push(cmd);
  if (/^block\b/.test(cmd)) return { status: true, response: { block: 100 } };
  if (/^newscript\b/.test(cmd)) return { status: true, response: { address: CONTRACT } };
  if (/^keys\b/.test(cmd)) return { status: true, response: [{ publickey: "0xMYPK" }] };
  if (/^getaddress\b/.test(cmd)) return { status: true, response: { publickey: "0xMYPK", address: WALLET_ADDR, miniaddress: "MxWALLET" } };
  if (/^balance\b/.test(cmd)) return { status: true, response: [{ sendable: "500" }] };
  if (/^coins relevant:true tokenid:0x00\b/.test(cmd)) return { status: true, response: [{ amount: "500", address: WALLET_ADDR, coinid: "0xFUND1" }] };
  if (/^coins relevant:true sendable:true tokenid:0x00\b/.test(cmd)) return { status: true, response: [
    { amount: "1", address: BEACON_ADDR, coinid: "0xDUST", state: [] },      // must be skipped (short addr)
    { amount: "19.84626467552", address: WALLET_ADDR, coinid: "0xFUND1", state: [] }   // 11-dp coin: change must NOT round up
  ] };
  if (/^checkaddress\b/.test(cmd)) return { status: true, response: { simple: /address:0x[0-9A-Fa-f]{64}\b/.test(cmd) } };
  if (/^coins address:/.test(cmd)) return { status: true, response: [OPEN_BET] };
  if (/^random\b/.test(cmd)) return { status: true, response: { random: "0x" + "11".repeat(32) } };
  if (/^hash data:/.test(cmd)) return { status: true, response: { hash: "0x" + "22".repeat(32) } };
  if (/^txncreate\b/.test(cmd)) return { status: true };
  if (/^txninput\b/.test(cmd)) return { status: true };
  if (/^txnoutput\b/.test(cmd)) return { status: true };
  if (/^txnstate\b/.test(cmd)) return { status: true };
  if (/^txnsign\b/.test(cmd)) return { status: true };
  if (/txnpost/.test(cmd)) return [{ status: true }, { status: true }];
  return { status: true, response: {} };
});

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exitCode = 1; } else console.log("ok  " + msg); };
const has = (re) => sent.some(c => re.test(c));

(async () => {
  await casino.init();
  assert(casino.status().contract === CONTRACT, "status contract = " + CONTRACT);
  assert(has(/^newscript script:".*" trackall:true/), "registered script with trackall:true");

  // read-model
  const open = await casino.openBets();
  assert(Array.isArray(open) && open.length === 1 && open[0].game === "Coin Flip", "openBets surfaces the external Coin Flip bet");

  // checkmode is synthesised in the shim (never reaches the runner) → WRITE mode; service.js then auto-processes
  // on NEWBLOCK, which is observable as a `coins address:CONTRACT` scan through the runner.
  sent.length = 0;
  casino._fire("NEWBLOCK");
  await new Promise(r => setTimeout(r, 80));
  assert(has(/^coins address:0xD65ADBBB/), "checkmode→WRITE: service.js scans the contract on NEWBLOCK");

  // HOUSE create — the covenant send + pin
  sent.length = 0;
  const cr = await casino.create("flip", "10");
  assert(cr && cr.ok && cr.stake === 10, "createBet ok, stake = bet*(payout-1) = 10");
  const send = sent.find(c => /^send /.test(c));
  assert(!!send, "createBet emitted a send");
  assert(/amount:10 address:0xD65ADBBB/.test(send), "send stakes 10 to the contract");
  assert(/state:\{"0":"0xMYPK","1":"0x[A-F]{64}","2":"0x2222.*","3":"2","4":"2","5":"10","6":"0","7":"1500"\}/.test(send), "send carries state ports 0..7 phase 0");
  assert(/fromaddress:0x[0-9A-Fa-f]{64}/.test(send), "house-send pinned to a signable coin (beacon dust excluded)");

  // PLAYER take — the txn sequence
  sent.length = 0;
  const tk = await casino.take("0xBET1", 1);
  assert(tk && tk.ok, "takeBet ok");
  assert(has(/^txninput id:take_.* coinid:0xBET1/), "take inputs the contract bet coin");
  assert(has(/^txninput id:take_.* coinid:0xFUND1/) && !has(/coinid:0xDUST/), "take funds from the signable coin, NOT beacon dust");
  assert(has(/^txnoutput id:take_.* amount:2 address:0xD65ADBBB.* storestate:true/), "take pot output = amount+bet back to contract, storestate:true");
  assert(has(/^txnoutput id:take_.* amount:18\.84626467552 address:0xAB.* storestate:false/), "take change is EXACT (18.84626467552), NOT rounded up to 18.84626468 → balances, node accepts");
  assert(has(/^txnstate id:take_.* port:6 value:1/), "take sets phase → 1");
  assert(has(/^txnstate id:take_.* port:8 value:0xMYPK/), "take writes player pubkey (port 8)");
  assert(has(/^txnstate id:take_.* port:11 value:1/), "take writes pick (port 11)");
  assert(has(/^txnsign id:take_.* publickey:auto/), "take signs publickey:auto");

  // C1: if the preimage can't be persisted durably, createBet must ABORT and NEVER send (no stranded pot).
  secretWritesOk = false;
  sent.length = 0;
  let aborted = false;
  try { await casino.create("flip", "10"); } catch (e) { aborted = true; }
  assert(aborted, "C1: createBet REJECTS when the secret write fails");
  assert(!sent.some(c => /^send /.test(c)), "C1: NO send was issued when the preimage wasn't durable");
  secretWritesOk = true;

  console.log(process.exitCode ? "\n=== SOME CHECKS FAILED ===" : "\n=== ALL GLUE CHECKS PASSED ===");
  process.exit(process.exitCode || 0);
})().catch(e => { console.error("harness error:", e); process.exit(1); });
