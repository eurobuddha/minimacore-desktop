/* Headless test for what is left of P2P Chance (removed in 0.18.68) — MOCK runner, no node.
 *
 * main/casino.js is now SETTLE-ONLY glue. This proves, through the real engine files in the real vm:
 *  - nothing runs until startLoop, and main.js only calls startLoop when config.casinoEnabled is already true
 *  - it can never start anything: no `send`, no take, no offer renewal reaches the node — even in the worst
 *    case, where the cancel marker cannot be saved and service.js's keepalive tries to renew a due offer
 *  - it does settle: an own open offer is withdrawn to the wallet, a taken bet is revealed, an expired pot is
 *    claimed, a stranger's coin is never touched
 *  - a failed scan is never read as "nothing open"; the bet secrets and history are never deleted or rewritten
 *  - the covenant is still registered trackall:false and the hygiene sweep still spares every own coin
 */
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const cfg = require(path.join(__dirname, "..", "main/config.js"));
const mem = {}, deleted = [];
let secretWritesOk = true;
cfg.getSecret = (acct) => (acct in mem ? mem[acct] : null);
cfg.setSecret = (val, acct) => { if (!secretWritesOk) return false; mem[acct] = String(val); return true; };
cfg.deleteSecret = (acct) => { deleted.push(acct); delete mem[acct]; };
const acct = (key) => "casino-" + crypto.createHash("sha256").update(key).digest("hex");   // casino.js kpAccount
const casino = require(path.join(__dirname, "..", "main/casino.js"));

const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
const WALLET = "0x" + "AB".repeat(32), MYPK = "0xA1A1", OTHER = "0xB2B2";
const st = (arr) => arr.map((data, port) => ({ port, data }));
const coinsFor = (age) => [
  { coinid: "0x0F01", amount: "1", tokenid: "0x00", age: 600 + age, state: st([MYPK, WALLET, "0xC0C0", "2", "2", "1", "0", "1500"]) },                          // my open offer, due for renewal
  { coinid: "0x0F02", amount: "2", tokenid: "0x00", age: 5 + age, state: st([MYPK, WALLET, "0xC1C1", "2", "2", "1", "1", "1500", OTHER, "0xDD", "0xEE", "1"]) },   // my offer, taken → I must reveal
  { coinid: "0x0F03", amount: "2", tokenid: "0x00", age: 1600 + age, state: st([OTHER, "0xDD", "0xC2C2", "2", "2", "1", "1", "1500", MYPK, WALLET, "0xEE", "0"]) }, // I took it, house never revealed → timeout claim
  { coinid: "0x0F04", amount: "1", tokenid: "0x00", age: 700 + age, state: st([OTHER, "0xDD", "0xC3C3", "2", "2", "1", "0", "1500"]) }                            // a stranger's open offer
];
mem[acct("casino_secret_for_0xC0C0")] = "0x5EC0";   // so a renewal WOULD go through if nothing stopped it
mem[acct("casino_secret_for_0xC1C1")] = "0x5EC1";
mem[acct("casino_history")] = '[{"coinid":"0xOLD"}]';
const precious = () => JSON.stringify([mem[acct("casino_secret_for_0xC0C0")], mem[acct("casino_secret_for_0xC1C1")], mem[acct("casino_history")]]);
const PRECIOUS = precious();

const sent = [];   // every command that REACHED the node
let block = 100, age = 0, scan = "coins";
casino._setRunner(async (cmd) => {
  sent.push(cmd);
  if (/^block\b/.test(cmd)) return { status: true, response: { block } };
  if (/^newscript\b/.test(cmd)) return { status: true, response: { address: CONTRACT } };
  if (/^scripts address:/.test(cmd)) return { status: true, response: { address: CONTRACT } };
  if (/^scripts\b/.test(cmd)) return { status: true, response: [{ address: WALLET, simple: true }] };
  if (/^keys\b/.test(cmd)) return { status: true, response: { keys: [{ publickey: MYPK }] } };
  if (/^getaddress\b/.test(cmd)) return { status: true, response: { publickey: MYPK, address: WALLET, miniaddress: "MxWALLET" } };
  if (/^coins relevant:true address:/.test(cmd)) return { status: true, response: [   // the hygiene sweep's view
    { coinid: "0xSTRANGERBET", state: st([OTHER, "0xDD"]) },                                 // foreign → untrack
    { coinid: "0xMINEBYKEY", state: st([MYPK]) },                                            // my key → spare
    { coinid: "0xMINEBYADDR", state: [{ port: 0, data: OTHER }, { port: 9, data: WALLET }] }  // my address → spare
  ] };
  if (/^coins address:/.test(cmd)) return scan === "fail" ? { status: false } : { status: true, response: scan === "empty" ? [] : coinsFor(age) };
  if (/^maths\b/.test(cmd)) return { status: true, response: { result: "1" } };
  if (/^txnbasics .*;txnpost/.test(cmd)) return [{ status: true }, { status: true }];
  return { status: true, response: {} };
});

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exitCode = 1; } else console.log("ok  " + msg); };
const has = (re) => sent.some(c => re.test(c));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const pass = async () => { sent.length = 0; casino.startLoop(); await wait(250); casino.stopLoop(); };   // one settle pass on the current block
// What must NEVER reach the node: a send, or any covenant output that is not the house reveal.
const starts = () => sent.filter(c => /(^|;)\s*send\b/.test(c) || (/^txnoutput\b/.test(c) && c.toUpperCase().includes(CONTRACT) && !/^txnoutput id:svc_reveal_/.test(c)));

(async () => {
  // ---- nothing runs unless it was already enabled ----
  assert(sent.length === 0, "loading the module talks to no node");
  casino.invalidate();   // a wallet reset on an install that never enabled it
  await wait(50);
  assert(sent.length === 0 && casino.open() === null, "a wallet reset does not start the loop on an install that never enabled it");
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main/main.js"), "utf8");
  const gate = mainSrc.slice(mainSrc.indexOf("let casinoStarted = false;"), mainSrc.indexOf('node.on("status", (s) => { if (s.state === "running") startCasinoIfEnabled();'));
  for (const enabled of [false, true]) {
    let started = 0;
    const c = vm.createContext({ node: { state: "running" }, require: () => ({ load: () => ({ casinoEnabled: enabled }) }), casino: { startLoop() { started++; } } });
    vm.runInContext(gate + ";startCasinoIfEnabled();startCasinoIfEnabled();", c);
    assert(started === (enabled ? 1 : 0), "main.js: casinoEnabled " + enabled + " → the loop " + (enabled ? "starts once" : "does NOT start"));
  }
  assert((mainSrc.match(/casino\.startLoop\(\)/g) || []).length === 1, "main.js has exactly one startLoop call, behind that gate");
  assert(!["create", "take", "setCurrency", "cancel", "reveal", "resolve"].some(k => k in casino), "the glue exports no create / take / currency action");

  // ---- the refusal rule itself ----
  assert(casino.refused('send amount:10 address:' + CONTRACT + ' tokenid:0x00 state:{"6":"0"}'), "refused: the createBet send");
  assert(casino.refused("txnoutput id:take_1_1 amount:2 address:" + CONTRACT + " tokenid:0x00 storestate:true"), "refused: the takeBet pot output");
  assert(casino.refused("txnoutput id:svc_offer_1_1 amount:1 address:" + CONTRACT.toLowerCase() + " tokenid:0x00 storestate:true"), "refused: the offer renewal output (any letter case)");
  assert(casino.refused("txncreate id:x;send amount:1 address:0xAA"), "refused: a send hidden behind ';'");
  assert(!casino.refused("txnoutput id:svc_reveal_1 amount:2 address:" + CONTRACT + " tokenid:0x00 storestate:true"), "allowed: the house reveal");
  assert(!casino.refused("txnoutput id:svc_offer_1_1 amount:1 address:" + WALLET + " tokenid:0x00 storestate:false"), "allowed: an offer withdrawn to the wallet");
  assert(!casino.refused("txnoutput id:timeout_1_1 amount:2 address:" + WALLET + " tokenid:0x00 storestate:false"), "allowed: a timeout claim to the wallet");

  // ---- WORST CASE: the cancel marker cannot be saved, so service.js's keepalive tries to RENEW the due offer ----
  secretWritesOk = false;
  await pass();
  assert(has(/^newscript script:".*" trackall:false/) && !has(/^newscript .*trackall:true/), "the covenant is registered trackall:false, never trackall:true");
  const unt = sent.filter(c => /^cointrack enable:false coinid:/.test(c));
  assert(unt.length === 1 && /0xSTRANGERBET/.test(unt[0]) && !has(/^cointrack .*coinid:0xMINE/), "the hygiene sweep untracks ONLY the stranger's coin, never one carrying an own key/address");
  assert(has(/^txncreate id:svc_offer_/), "worst case: the keepalive did try to renew (the test is not vacuous)");
  assert(starts().length === 0, "worst case: no send and no covenant output except a reveal reached the node");
  assert(!has(/txnpost id:svc_offer_/), "worst case: the renewal was never posted");
  assert(has(/^txndelete id:svc_offer_/), "worst case: the refused renewal was cleaned up");
  assert(has(/^txnoutput id:svc_reveal_.* address:0xD65ADBBB.* storestate:true/) && has(/txnpost id:svc_reveal_/), "worst case: the taken bet is still revealed");
  secretWritesOk = true;

  // ---- NORMAL: marker saved → the offer is withdrawn, the bet revealed, the timeout claimed ----
  block += 10; age += 10;
  await pass();
  assert(mem[acct("casino_cancel_for_0xC0C0")] === "1", "the durable cancel marker is written for my open offer");
  assert(mem[acct("casino_cancel_for_0xC3C3")] === undefined, "…and not for the stranger's");
  assert(has(new RegExp("^txnoutput id:svc_offer_.* amount:1 address:" + WALLET + " tokenid:0x00 storestate:false")) && has(/^txnpost id:svc_offer_/), "my open offer is withdrawn to my wallet and posted");
  assert(has(/^txnsign id:svc_reveal_.* publickey:0xA1A1/) && has(/txnpost id:svc_reveal_/), "the taken bet is revealed");
  assert(has(new RegExp("^txnoutput id:timeout_.* amount:2 address:" + WALLET + " tokenid:0x00 storestate:false")) && has(/txnpost id:timeout_/), "the expired pot is claimed to my wallet");
  assert(!has(/coinid:0x0F04/), "the stranger's offer is never an input");
  assert(starts().length === 0, "normal pass: nothing that starts a bet reached the node");
  assert(JSON.stringify(casino.open()) === '{"offers":1,"bets":2}', "the Settings card is told 1 open offer + 2 bets in play");

  block += 1;   // next block, coins not yet mined away: the claim is not re-posted inside its cooldown
  await pass();
  assert(!has(/id:timeout_/), "a posted timeout claim is not re-posted on the next block");

  // ---- a failed scan is not "nothing open"; a clean empty scan is ----
  block += 1; scan = "fail";
  await pass();
  assert(JSON.stringify(casino.open()) === '{"offers":1,"bets":2}', "a failed coin scan leaves the count as it was");
  block += 1; scan = "empty";
  await pass();
  assert(JSON.stringify(casino.open()) === '{"offers":0,"bets":0}', "a clean empty scan → nothing open (the card disappears)");
  assert(sent.filter(c => /^coins address:/.test(c)).length === 1 && !has(/^txn/), "with nothing open the engine is not driven: one read-only scan, no transaction");

  // ---- the crown jewels ----
  assert(precious() === PRECIOUS, "bet secrets and casino_history are byte-for-byte untouched");
  const identity = ["casino_pubkey", "casino_hexaddr", "casino_miniaddr"].map(acct);
  assert(deleted.every(a => identity.includes(a)), "the only keychain entries ever deleted are the cached identity (wallet reset)");

  console.log(process.exitCode ? "\n=== SOME CHECKS FAILED ===" : "\n=== ALL SETTLE-ONLY CHECKS PASSED ===");
  process.exit(process.exitCode || 0);
})().catch(e => { console.error("harness error:", e); process.exit(1); });
