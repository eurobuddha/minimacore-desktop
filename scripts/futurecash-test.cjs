// Future Cash Next (main/futurecash.js, main/futurecash-store.js): the contract pinned, the reads it sends, and every
// money path executed against a stand-in node. Nothing here reaches a node or the network.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const FC = require("../main/futurecash.js");

// ---- the contract: the native's text, byte for byte, and the address it hashes to ----
const SCRIPT_SHA256 = "5c20a05308dfa1a4fc9ed4aecfb2f1a375df5519d50ec3bd329bb2a36866dab8";
const NATIVE = "/Users/eurobuddha/Projects/minima/apks/base/integrated/futurecash-next/src/main/java/com/eurobuddha/futurecashnext/FutureCashContract.java";

test("the contract script is the native's, byte for byte, and hashes to the canonical FutureCash address", () => {
  assert.equal(crypto.createHash("sha256").update(FC.SCRIPT, "utf8").digest("hex"), SCRIPT_SHA256);
  assert.equal(FC.SCRIPT, "RETURN (@BLOCK GTE PREVSTATE(1) OR @COINAGE GTE PREVSTATE(4)) AND VERIFYOUT(@INPUT PREVSTATE(2) @AMOUNT @TOKENID FALSE)");
  assert.equal(FC.scriptAddress(FC.SCRIPT), "0xEA8823992AB3CEBBA855D68006F0D05B0C4838FE55885375837D90F98954FA13", "the script's own address (single-leaf MMR, as keyuses.addressOf)");
  assert.equal(FC.KNOWN_ADDRESS, FC.scriptAddress(FC.SCRIPT));
  // the derivation itself, on the native's own MinimaAddressTest vectors (RETURN SIGNEDBY(key) -> address)
  assert.equal(FC.scriptAddress("RETURN SIGNEDBY(0x0000000000000000000000000000000000000000000000000000000000000000)"), "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941");
  assert.equal(FC.scriptAddress("RETURN SIGNEDBY(0xFF00000000000000000000000000000000000000000000000000000000000000)"), "0xBE1611D1E4C14DFAA0BE2694F853A616E320349C7FBDC0B258AFAE36C4A0A369");
  if (fs.existsSync(NATIVE)) {   // on the build machine: read from the native source itself (never compiled or run)
    const java = fs.readFileSync(NATIVE, "utf8");
    assert.ok(java.includes('"' + FC.SCRIPT + '"'), "FutureCashContract.SCRIPT");
    assert.ok(java.includes('"' + FC.KNOWN_ADDRESS + '"'), "FutureCashContract.KNOWN_ADDRESS");
  }
});

test("an Mx address decodes to its hex with its checksum (the native's MinimaAddressTest vectors); anything else is null", () => {
  for (const [hex, mx] of [["0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941", "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6"],
    ["0x25619F02BEDE6EF76AF768BEFA0F1E286F6544F33884C4EA977FEDCC0ECCDCC3", "MxG0815C6FG5FMUDRRMYTR8NRT0U7H8DTWK9SPZGJ2EY5RVTN60TJ6SZF7VJ889"],
    ["0x7159569EA57B8AA753BD82AE8CF3AE8D662E1949EB203DFA39285A64E8B4B592", "MxG083HB5B9T9BRHAJY7FC2YQ6F7BKDCZN1WWFB40UVKE98B9WEHD5YWABB0N4C"],
    ["0x98735D7DD62D70D29BB260EED90720B42E0D59C8CB9ECC0F96C679D884ACCA86", "MxG084ZEDENRYHDE399NCJ0TRCGE85K5Z6YJW6BJR60V5M6F7C89B6AGQYVDG26"]]) {
    assert.equal(FC.mxToHex(mx), hex); assert.equal(FC.canon(mx), FC.canon(hex.toLowerCase()));
  }
  for (const bad of ["MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH7", "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0K", "0x00", "", null, "Mx!!", "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6;quit"])
    assert.equal(FC.mxToHex(bad), null, String(bad));
});

// ---- a stand-in node ----
const U = (h) => "0x" + h.slice(2).toUpperCase();
const ID = (n) => "0x" + String(n).toString(16).toUpperCase().padStart(64, "0");
const KEY0 = "0x" + "11".repeat(32), KEY1 = "0x" + "22".repeat(32), KEY2 = "0x" + "33".repeat(32);
const SIGN = (k) => "RETURN SIGNEDBY(" + k + ")";
const ADDR = (k) => FC.scriptAddress(SIGN(k));
const PAY0 = ADDR(KEY0), PAY1 = ADDR(KEY1), PAY2 = ADDR(KEY2), STRANGER = "0x" + "AB".repeat(32);
const stake = (n, payout, o = {}) => ({ coinid: ID(n), address: o.address || FC.KNOWN_ADDRESS, amount: o.amount || "10", tokenid: o.tokenid || "0x00", tokenamount: o.tokenamount, spent: false, created: String(o.created || 100),
  state: [{ port: 0, data: "0xFF" }, { port: 1, data: String(o.mature || 200) }, { port: 2, data: payout }, { port: 3, data: "1795000000000" }, { port: 4, data: String(o.age || 1000) }] });
/** keys: the wallet's keys; scripts: the script table; coins: coin id -> coin; at: contract address -> stake coins. */
function standIn(o = {}) {
  const sent = [], n = Object.assign({ tip: 150, keys: [KEY0, KEY1, KEY2], scripts: null, coins: {}, at: {}, answer: {} }, o);
  if (!n.scripts) n.scripts = n.keys.map((k, i) => ({ address: ADDR(k), miniaddress: "", script: SIGN(k), publickey: k, default: i < 3, track: true }));
  const keyRows = () => n.keys.map((k, i) => ({ publickey: k, modifier: "0x" + (i ? i.toString(16).padStart(2, "0") : "00"), uses: "0", size: 64, depth: 3, maxuses: 262144 }));
  async function run(c) {
    sent.push(c);
    for (const [pre, fn] of Object.entries(n.answer)) if (c.startsWith(pre)) { const r = await fn(c, n); if (r !== undefined) return r; }
    if (c === "block") return { status: true, response: { block: String(n.tip) } };
    if (c === "keys modifier:0x00") return { status: true, response: { keys: keyRows().slice(0, 1) } };
    if (c === "keys action:list" || c === "keys") return { status: true, response: { keys: keyRows() } };
    let m;
    if (c === "scripts") return { status: true, response: n.scripts };
    if ((m = /^scripts address:(\S+)$/.exec(c))) { const row = n.scripts.find(x => FC.canon(x.address) === FC.canon(m[1]) || (x.miniaddress && x.miniaddress === m[1])); return { status: true, response: row ? [row] : [] }; }
    if ((m = /^newscript trackall:(true|false) (?:clean:true )?script:"(.*)"$/.exec(c))) {
      const address = FC.scriptAddress(m[2]); n.scripts = n.scripts.filter(x => x.address !== address);
      const own = /^RETURN SIGNEDBY\((0x[0-9A-F]+)\)$/i.exec(m[2]);
      n.scripts.push({ address, miniaddress: "", script: m[2], publickey: own ? "0x00" : "0x00", default: false, track: m[1] === "true" });
      return { status: true, response: { address, script: m[2] } };
    }
    if (c === "newaddress") { const k = "0x" + (n.minted = (n.minted || 0x50) + 1).toString(16).repeat(32).slice(0, 64).toUpperCase(); n.keys.push(k); const address = ADDR(k); n.scripts.push({ address, miniaddress: require("../main/keyuses.js").addressOf(k).mx, script: SIGN(k), publickey: k, default: false, track: true }); return { status: true, response: { address, miniaddress: require("../main/keyuses.js").addressOf(k).mx, script: SIGN(k), publickey: k } }; }
    if (/^send /.test(c)) { n.sends = (n.sends || []).concat(c); return { status: true, response: { txpowid: ID(777) } }; }
    if (/^coins relevant:true sendable:true checkmempool:true tokenid:0x00/.test(c)) return { status: true, response: [] };
    if ((m = /^coins relevant:true address:(0x[0-9A-Fa-f]+)$/.exec(c))) return { status: true, response: (n.at[U(m[1])] || []).filter(x => !x.spent) };
    if ((m = /^coins coinid:(0x[0-9A-Fa-f]+)$/.exec(c))) { const x = n.coins[U(m[1])]; return { status: true, response: x ? [x] : [] }; }
    if (c === "status") return { status: true, response: { locked: false } };
    return { status: false, error: "the stand-in does not know: " + c };
  }
  return { run, sent, n };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-"));
async function engine(nodeOpts, extra) {
  const node = standIn(nodeOpts), dir = tmp(), logs = [];
  const e = FC.create(Object.assign({ run: node.run, dir: () => dir, get: async () => null, log: (l) => logs.push(l) }, extra || {}));
  await e.start();
  return { e, node, dir, logs };
}

test("the stake read is scoped to the contract address: never the whole wallet, never the chain", async () => {
  const mine = stake(1, PAY0), other = stake(2, STRANGER), notStake = Object.assign(stake(3, PAY1), { state: [{ port: 2, data: PAY1 }] });
  const { e, node } = await engine({ at: { [FC.KNOWN_ADDRESS]: [mine, other, notStake] } });
  const r = await e.stakes();
  assert.deepEqual(r.stakes.map(s => s.coinid), [ID(1)], "only a stake paying this wallet");
  assert.equal(r.stakes[0].ready, false); assert.equal(r.stakes[0].amount, "10");
  for (const c of node.sent) {
    assert.ok(!/^coins relevant:true\s*$/.test(c), "no unbounded wallet read: " + c);
    if (/^coins /.test(c)) assert.ok(/^coins (relevant:true address:0x[0-9A-F]{64}|coinid:0x[0-9A-F]{64})$/i.test(c), "every coins read names an address or a coin: " + c);
  }
  assert.ok(node.sent.includes("coins relevant:true address:" + FC.KNOWN_ADDRESS));
});

test("an incomplete or oversized stake read is said, never shown as no stakes", async () => {
  for (const bad of [{ status: false, error: "x" }, { status: true, pending: true, response: [] }, { status: true, response: {} }, { status: true, response: [null] }, { status: true, response: new Array(5001).fill(stake(9, PAY0)) }]) {
    const { e } = await engine({ answer: { "coins relevant:true address:": async () => bad } });
    await assert.rejects(e.stakes(), /Could not read the complete stake list/);
  }
});

test("matured is exactly the on-chain unlock: block >= state 1, or coin age >= state 4", () => {
  assert.equal(FC.matured(stake(1, PAY0, { mature: 200 }), 199), false); assert.equal(FC.matured(stake(1, PAY0, { mature: 200 }), 200), true);
  assert.equal(FC.matured(stake(1, PAY0, { mature: 999999, created: 100, age: 50 }), 150), true, "coin age");
  assert.equal(FC.matured(stake(1, PAY0, { mature: 999999, created: 100, age: 50 }), 149), false);
  assert.equal(FC.looksLikeFutureCash(Object.assign(stake(1, PAY0), { state: [{ port: 1, data: "12a" }, { port: 2, data: PAY0 }] })), false);
});

test("a pass reads and records; it sends no transaction command", async () => {
  const { e, node } = await engine({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 140 }), stake(2, PAY1, { mature: 900 })] } });
  node.sent.length = 0;
  assert.equal(await e.pass(), true);
  const st = await e.status();
  assert.equal(st.watching, 2); assert.equal(st.readySafe.n, 1); assert.equal(st.readySafe.total, "10");
  assert.ok(node.sent.every(c => !/^(txn|send|newscript|newaddress)/.test(c)), node.sent.join(" | "));
  assert.ok(e.activity().some(l => l.msg.startsWith("Detected FutureCash (10) | stake:" + ID(1) + " | to:" + PAY0)), "the ids whole, first in the line");
});

test("amounts are summed exactly and never rounded", () => {
  assert.equal(FC.sum(["0.1", "0.2", "1000000000.000000000000000000000000000000000000000001"]), "1000000000.300000000000000000000000000000000000000001");
  assert.equal(FC.sum([]), "0"); assert.equal(FC.sum(["x", "1e5", "2"]), "2");
  assert.equal(FC.decEq("1.50", "1.5"), true); assert.equal(FC.decEq("1.5", "1.500000001"), false); assert.equal(FC.decEq("1", "abc"), false);
});

test("the audit verdict: fresh for 30 minutes, re-confirmed against the node's own counters up to 24 hours, never from a moved key", async () => {
  let t = 1795000000000;
  const { e, node } = await engine({}, { now: () => t });
  const kv = e._store().kv, keys = (await node.run("keys action:list")).response.keys;
  assert.equal((await e.verdict()).mode, "NONE");
  kv.set(FC.K.AUDIT_USES, FC.usesFingerprint(keys)); kv.setBool(FC.K.AUDIT_OK, true); kv.set(FC.K.AUDIT_AT, String(t));
  assert.deepEqual(await e.verdict(), { ok: true, at: t, mode: "FRESH" });
  t += FC.FRESH_MS + 1; assert.equal((await e.verdict()).mode, "RECONFIRMED");
  node.n.keys.push("0x" + "44".repeat(32)); assert.equal((await e.verdict()).ok, false, "a new key: stale");
  node.n.keys.pop(); t += FC.MAX_MS; assert.equal((await e.verdict()).mode, "STALE");
  kv.set(FC.K.AUDIT_AT, String(t + 60000)); assert.equal((await e.verdict()).ok, false, "a clock set back never makes an old verdict fresh");
});

test("the audit asks the pinned host for the node's keys and the rescue destination, and a partial answer never clears an earlier risk", async () => {
  const urls = [];
  const get = async (url) => {
    urls.push(url);
    const q = decodeURIComponent(url.split("=")[1]).split(",");
    if (url.includes("/keyaudit?")) return { status: true, archive_tip: 1, keys: q.map(pk => ({ publickey: pk, address: require("../main/keyuses.js").addressOf(pk).hex, spend_blocks: pk === KEY1 ? 9 : 0, spent_coins: 0 })) };
    return { status: true, results: q.map(a => ({ address: a, reused: false, reuse_count: 0 })) };
  };
  const { e } = await engine({}, { get });
  const kv = e._store().kv;
  kv.set(FC.K.SAFE_ADDRESS, "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6");
  assert.deepEqual(await e.audit(true), { ok: true });
  assert.ok(urls.every(u => u.startsWith("https://eurobuddha.com/")), "one host");
  assert.ok(urls.some(u => u.includes("/reuse?") && decodeURIComponent(u).includes("0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941")), "the safe destination rides in the /reuse batch, in hex");
  const risk = JSON.parse(kv.get(FC.K.ATRISK_ADDRS));
  assert.ok(risk.includes(PAY1) && risk.length === 2, "the heuristic-risk key's address, both spellings: " + risk);
  assert.equal(kv.get(FC.K.AUDIT_OK), "1");
  // a later PARTIAL audit (one key not answered) keeps the earlier risk and does not license a collect
  const partial = async (url) => { const j = await get(url); if (url.includes("/keyaudit?")) j.keys = j.keys.filter(k => k.publickey !== KEY2).map(k => Object.assign(k, { spend_blocks: 0 })); return j; };
  const e2 = FC.create({ run: (await engine()).node.run, dir: () => path.dirname(path.dirname(e._store().file)), get: partial, log() {} });
  await e2.start(); assert.deepEqual(await e2.audit(true), { ok: true });
  assert.equal(e2._store().kv.get(FC.K.AUDIT_OK), "0");
  assert.ok(JSON.parse(e2._store().kv.get(FC.K.ATRISK_ADDRS)).includes(PAY1), "the earlier at-risk address is kept");
});

const CONTRACT_CMD = 'newscript trackall:false clean:true script:"RETURN (@BLOCK GTE PREVSTATE(1) OR @COINAGE GTE PREVSTATE(4)) AND VERIFYOUT(@INPUT PREVSTATE(2) @AMOUNT @TOKENID FALSE)"';

test("the contract is registered at start with exactly the native's command, once, and repaired when it tracks every stake", async () => {
  const { e, node, dir } = await engine();
  assert.deepEqual(node.sent.filter(c => /^newscript/.test(c)), [CONTRACT_CMD]);
  assert.equal(e._store().kv.get(FC.K.SCRIPT_ADDRESS), FC.KNOWN_ADDRESS, "the node's answer is the canonical address");
  await e.stop(); node.sent.length = 0;
  const again = FC.create({ run: node.run, dir: () => dir, get: async () => null, log() {} }); await again.start();
  assert.deepEqual(node.sent.filter(c => /^newscript/.test(c)), [], "present and scoped: nothing is sent (newscript is not a no-op)");
  node.n.scripts.find(x => x.address === FC.KNOWN_ADDRESS).track = true; node.sent.length = 0;
  await again.registerContract();
  assert.deepEqual(node.sent.filter(c => /^newscript/.test(c)), [CONTRACT_CMD], "trackall:true is replaced by trackall:false");
  assert.ok(again.activity().some(l => /^Repairing contract registration/.test(l.msg)));
});

test("lock: the native's send with its exact state; blank pays a fresh clean address of this node; bad input sends nothing", async () => {
  const t = 1795000000123, { e, node } = await engine({ tip: 1000 }, { now: () => t });
  node.sent.length = 0;
  const r = await e.lock("12.5", 1728, "");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(node.sent.filter(c => /^(newaddress|send )/.test(c)), ["newaddress",
    "send amount:12.5 address:" + FC.KNOWN_ADDRESS + ' state:{"0":"0xFF","1":"2728","2":"' + r.payout + '","3":"' + t + '","4":"1728"}']);
  assert.ok(/^0x[0-9A-F]{64}$/.test(r.payout) && !node.n.scripts.find(x => x.address === r.payout).default, "a fresh, non-default address");
  node.sent.length = 0;
  assert.equal((await e.lock("1", 72, "")).payout, r.payout, "minted once and reused");
  assert.ok(!node.sent.includes("newaddress"));
  const mx = "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6"; node.sent.length = 0;
  assert.equal((await e.lock("0.000000000000000000000000000000000000000001", 72, mx)).payout, "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941", "an Mx recipient, decoded with its checksum");
  assert.ok(node.sent.some(c => c.startsWith("send amount:0.000000000000000000000000000000000000000001 ")), "sent as typed, never through a number");
  node.sent.length = 0;
  for (const [a, b, rc, why] of [["0", 72, "", /positive amount/], ["-1", 72, "", /positive amount/], ["1e3", 72, "", /positive amount/], ["1", 0, "", /maturity/], ["1", 1.5, "", /maturity/],
    ["1", 72, "Mx123", /resolve/], ["1", 72, mx.slice(0, -1) + "7", /resolve/], ["1", 72, "0x12 address:0xFF", /resolve/], ["1", 72, PAY0 + ";quit", /resolve/]])
    assert.match((await e.lock(a, b, rc)).error, why, a + " " + b + " " + rc);
  assert.deepEqual(node.sent.filter(c => /^(send|newaddress)/.test(c)), [], "nothing reaches the node");
});

test("lock: a locked vault is said before newaddress, and a node that parks the send is not a lock", async () => {
  const { e, node } = await engine({ answer: { status: async () => ({ status: true, response: { locked: true } }) } });
  assert.match((await e.lock("1", 72, "")).error, /keys are locked/);
  assert.ok(!node.sent.includes("newaddress"));
  const p = await engine({ answer: { "send ": async () => ({ status: true, pending: true }) } });
  assert.match((await p.e.lock("1", 72, PAY0)).error, /did not authorize/);
});
