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
    if ((m = /^txncreate id:(\S+)$/.exec(c))) { n.txns = n.txns || {}; n.txns[m[1]] = { inputs: [], outputs: [], state: [] }; return { status: true, response: { id: m[1] } }; }
    if ((m = /^txninput id:(\S+) coinid:(0x[0-9A-Fa-f]+)$/.exec(c))) { const coin = n.coins[U(m[2])] || [].concat(n.wallet || [], Object.values(n.at).flat()).find(x => U(x.coinid) === U(m[2])); if (!coin) return { status: false, error: "coin not found" }; n.txns[m[1]].inputs.push(JSON.parse(JSON.stringify(coin))); return { status: true }; }
    if ((m = /^txnoutput id:(\S+) address:(\S+) amount:(\S+) tokenid:(\S+) storestate:false$/.exec(c))) { n.txns[m[1]].outputs.push(m[4] === "0x00" ? { address: m[2], amount: m[3], tokenid: m[4], storestate: false } : { address: m[2], amount: "0.000001", tokenamount: m[3], tokenid: m[4], storestate: false }); return { status: true }; }
    if ((m = /^txnlist id:(\S+)$/.exec(c))) { const t = n.txns[m[1]]; return t ? { status: true, response: { id: m[1], transaction: n.tamper ? n.tamper(JSON.parse(JSON.stringify(t))) : t } } : { status: false, error: "no such txn" }; }
    if ((m = /^(txnbasics|txnsign|txnpost) id:(\S+)/.exec(c))) { if (m[1] === "txnpost") n.posted = (n.posted || []).concat(m[2]); return { status: true, response: m[1] === "txnpost" ? { txpowid: ID(999) } : {} }; }
    if ((m = /^txndelete id:(\S+)$/.exec(c))) { delete (n.txns || {})[m[1]]; return { status: true }; }
    if ((m = /^coins address:(\S+)(?: checkmempool:true| tokenid:(\S+))?$/.exec(c))) {
      const all = [].concat(n.wallet || [], Object.values(n.at).flat(), Object.values(n.coins));
      return { status: true, response: all.filter(x => FC.canon(x.address) === FC.canon(m[1]) && (!m[2] || x.tokenid === m[2])) };
    }
    if (/^send /.test(c)) { n.sends = (n.sends || []).concat(c); return { status: true, response: { txpowid: ID(777) } }; }
    if (/^coins relevant:true sendable:true checkmempool:true tokenid:0x00/.test(c)) return { status: true, response: [] };
    if ((m = /^coins relevant:true address:(0x[0-9A-Fa-f]+)$/.exec(c))) return { status: true, response: (n.at[U(m[1])] || []).filter(x => !x.spent) };
    if ((m = /^coins coinid:(0x[0-9A-Fa-f]+)$/.exec(c))) { const x = n.coins[U(m[1])] || [].concat(n.wallet || [], Object.values(n.at).flat()).find(y => U(y.coinid) === U(m[1])); return { status: true, response: x ? [x] : [] }; }
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
    await assert.rejects(e.stakes(), bad.response && bad.response.length > 5000 ? /More than 5,000 stakes/ : /Could not read the complete stake list/);
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

/** An engine with a fresh, complete audit and the given stakes at the contract. */
async function audited(nodeOpts, extra) {
  const x = await engine(nodeOpts, extra), kv = x.e._store().kv, keys = (await x.node.run("keys action:list")).response.keys;
  kv.set(FC.K.AUDIT_USES, FC.usesFingerprint(keys)); kv.setBool(FC.K.AUDIT_OK, true); kv.set(FC.K.AUDIT_AT, String(Date.now()));
  return x;
}
const steps = (sent) => sent.filter(c => /^txn/.test(c)).map(c => c.replace(/id:FC[A-Z]+\d+_\d+/, "id:ID"));

test("collect by hand: the native's five steps, the node's transaction checked before the post, then txndelete", async () => {
  const s1 = stake(1, PAY0, { mature: 140, amount: "12.5" });
  const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  node.sent.length = 0;
  const r = await e.collectNow(ID(1));
  assert.deepEqual(r, { ok: true, amount: "12.5" });
  assert.deepEqual(steps(node.sent), ["txncreate id:ID", "txninput id:ID coinid:" + ID(1), "txnoutput id:ID address:" + PAY0 + " amount:12.5 tokenid:0x00 storestate:false",
    "txnbasics id:ID", "txnlist id:ID", "txnpost id:ID", "txndelete id:ID"]);
  assert.equal(e._store().collect(ID(1)).status, "COLLECT_POSTED_SAFE", "recorded before the post");
  assert.match((await e.collectNow(ID(1))).error, /already being collected/, "a second click posts nothing");
});

test("collect by hand is refused: not matured, not ours, at risk, no audit, malformed id; nothing is built", async () => {
  const at = { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 999 }), stake(2, STRANGER, { mature: 1 }), stake(3, PAY1, { mature: 1 })] };
  const { e, node } = await audited({ at });
  e._store().kv.set(FC.K.ATRISK_ADDRS, JSON.stringify([PAY1]));
  node.sent.length = 0;
  assert.match((await e.collectNow(ID(1))).error, /Not matured yet: unlocks at block 999 \(now 150\)/);
  assert.match((await e.collectNow(ID(2))).error, /doesn't pay out to this node/);
  assert.match((await e.collectNow(ID(3))).error, /at-risk address/);
  assert.match((await e.collectNow("0x12;send")).error, /Not a valid coin id/);
  assert.match((await e.collectNow(ID(4))).error, /Stake not found/);
  e._store().kv.setBool(FC.K.AUDIT_OK, false); e._store().kv.set(FC.K.ATRISK_ADDRS, "[]");
  assert.match((await e.collectNow(ID(3))).error, /Run a key audit first/);
  assert.deepEqual(node.sent.filter(c => /^txn/.test(c)), []);
});

test("the sign gate refuses every wrong shape: nothing is posted, the transaction is deleted, the whole of it is logged", async () => {
  const tampers = {
    "two outputs": (t) => (t.outputs.push({ address: STRANGER, amount: "1", tokenid: "0x00" }), t),
    "another payee": (t) => (t.outputs[0].address = STRANGER, t),
    "less out than in (a burn)": (t) => (t.outputs[0].amount = "12.4", t),
    "another token": (t) => (t.outputs[0].tokenid = "0xAB", t),
    "an input not at the contract": (t) => (t.inputs[0].address = PAY1, t),
    "another coin": (t) => (t.inputs[0].coinid = ID(5), t),
    "a second input": (t) => (t.inputs.push(Object.assign({}, t.inputs[0], { coinid: ID(6) })), t),
    "transaction state": (t) => (t.state = [{ port: 1, data: "1" }], t),
    "the stake's state names another payout": (t) => (t.inputs[0].state[2].data = PAY1, t),
    "a state-keeping output": (t) => (t.outputs[0].storestate = true, t),
    "no inputs listed": (t) => (delete t.inputs, t)
  };
  for (const [name, tamper] of Object.entries(tampers)) {
    const { e, node, logs } = await audited({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 140, amount: "12.5" })] }, tamper });
    node.sent.length = 0;
    const r = await e.collectNow(ID(1));
    assert.equal(r.ok, false, name); assert.match(r.error, /^Refused before signing: .*Nothing was posted\.$/, name);
    assert.ok(!node.sent.some(c => /^txnpost/.test(c)), name + ": not posted");
    assert.ok(/^txndelete id:FCCOL/.test(node.sent[node.sent.length - 1]), name + ": deleted");
    assert.ok(logs.some(l => /SIGN GATE REFUSED txnpost .*the node's transaction \{/.test(l)), name + ": logged whole");
    assert.equal(e._store().collect(ID(1)).status, "DETECTED", name + ": free to try again");
  }
});

test("the gate's own rules, as a pure function", () => {
  const coin = stake(1, PAY0, { amount: "5" }), txn = () => ({ inputs: [JSON.parse(JSON.stringify(coin))], outputs: [{ address: PAY0, amount: "5.000", tokenid: "0x00", storestate: false }], state: [] });
  const plan = { kind: "collect", coinid: ID(1), tokenid: "0x00", amount: "5", to: PAY0, contracts: [FC.KNOWN_ADDRESS], own: (a) => FC.canon(a) === FC.canon(PAY0) };
  assert.deepEqual(FC.gateCheck(txn(), plan), { ok: true });
  assert.equal(FC.gateCheck(txn(), Object.assign({}, plan, { own: () => false })).ok, false, "a payout of another wallet");
  assert.equal(FC.gateCheck(txn(), Object.assign({}, plan, { amount: "4" })).ok, false);
  assert.equal(FC.gateCheck(txn(), Object.assign({}, plan, { kind: "send" })).ok, false);
  const tok = { inputs: [Object.assign(JSON.parse(JSON.stringify(coin)), { tokenid: "0xAB", amount: "0.001", tokenamount: "7" })], outputs: [{ address: PAY0, amount: "0.001", tokenid: "0xAB" }], state: [] };
  assert.equal(FC.gateCheck(tok, Object.assign({}, plan, { tokenid: "0xAB", amount: "7" })).ok, false, "a token output whose amount the node does not state is refused");
  tok.outputs[0].tokenamount = "7"; assert.equal(FC.gateCheck(tok, Object.assign({}, plan, { tokenid: "0xAB", amount: "7" })).ok, true);
});

test("txndelete follows a failure at every step, and a missing or unreadable reply is never a success", async () => {
  for (const at of ["txncreate", "txninput", "txnoutput", "txnbasics", "txnpost"]) {
    for (const reply of [{ status: false, error: "boom" }, null, { status: "yes" }]) {
      const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 140 })] }, answer: { [at]: async () => (reply === null ? Promise.reject(new Error("timeout")) : reply) } });
      node.sent.length = 0;
      const r = await e.collectNow(ID(1));
      assert.equal(r.ok, false, at);
      assert.match(r.error, reply === null ? new RegExp("didn't respond \\(at " + at + "\\)") : reply.status === false ? new RegExp("boom \\(at " + at + "\\)") : /it may have succeeded/, at);
      assert.ok(/^txndelete id:FCCOL/.test(node.sent[node.sent.length - 1]), at + ": deleted");
      const kept = at === "txnpost" && (reply === null || reply.status === "yes");
      assert.equal(e._store().collect(ID(1)).status, kept ? "COLLECT_POSTED_SAFE" : "DETECTED", at + ": a post that may have gone out stays posted; anything else is free again");
    }
  }
});

test("a posted collect is followed to its end: spent is collected; unspent after 8 blocks is tried again; the fifth failure is said", async () => {
  const s1 = stake(1, PAY0, { mature: 140 });
  const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] }, coins: {} });
  await e.collectNow(ID(1));
  node.n.coins[ID(1)] = Object.assign({}, s1, { spent: false });
  node.n.tip = 155; await e.pass(155);
  assert.equal(e._store().collect(ID(1)).status, "COLLECT_POSTED_SAFE", "unspent, inside the retry window");
  node.n.tip = 158; await e.pass(158);
  assert.equal(e._store().collect(ID(1)).status, "DETECTED", "8 blocks on, unspent: tried again");
  await e.collectNow(ID(1)); node.n.coins[ID(1)].spent = true; node.n.at[FC.KNOWN_ADDRESS] = [];
  await e.pass(159);
  assert.equal(e._store().collect(ID(1)).status, "COLLECTED_SAFE");
  assert.ok(e.activity().some(l => l.msg.startsWith("Collected 10 [safe] | stake:" + ID(1))));
});

test("a clean stake collected elsewhere ends COLLECTED_SAFE, never queued for a sweep (the desktop's one change to the native here)", async () => {
  const s1 = stake(1, PAY0, { mature: 140 });
  const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  await e.pass(150); assert.equal(e._store().collect(ID(1)).status, "DETECTED");
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(1)] = Object.assign({}, s1, { spent: true });
  await e.pass(151); assert.equal(e._store().collect(ID(1)).status, "COLLECTED_SAFE");
});

const SAFE_MX = "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6", SAFE_HEX = "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941";
/** A guardian: audited, an external safe destination set, rescue on, the guardian on, and the grant given (unless grant:false). */
async function guardian(nodeOpts, o = {}) {
  let granted = o.grant !== false;
  const x = await audited(nodeOpts, { granted: () => (granted ? { at: 1, safe: SAFE_MX } : null), get: async (url) => (url.includes("/reuse?") ? { status: true, results: [{ address: SAFE_HEX, reused: false, reuse_count: 0 }] } : null) });
  const kv = x.e._store().kv;
  assert.equal((await x.e.setSafeExternal(SAFE_MX)).ok, true);
  kv.set(FC.K.ATRISK_ADDRS, JSON.stringify(o.atRisk || [PAY1]));
  if (o.auto) kv.setBool(FC.K.AUTO_COLLECT_SAFE, true);
  const g = await x.e.setGuardian(true);
  x.grant = (v) => { granted = v; };
  x.g = g;
  return x;
}

test("no grant, nothing signed in the background: the guardian does not start and a pass only reads", async () => {
  const at = { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 100 }), stake(2, PAY1, { mature: 100 })] };
  const { e, node, g } = await guardian({ at }, { grant: false, auto: true });
  assert.deepEqual([g.ok, g.needsGrant], [false, true]);
  e._store().kv.setBool(FC.K.GUARDIAN_ON, true);   // even with the switch forced on
  node.sent.length = 0; await e.pass(150);
  assert.deepEqual(node.sent.filter(c => /^(txn|send|newscript|newaddress)/.test(c)), []);
  assert.equal((await e.status()).running, false);
});

test("the guardian, granted: a clean matured stake is collected (auto-collect on); an at-risk one is collected, found, and swept to the safe destination", async () => {
  const s0 = stake(1, PAY0, { mature: 100, amount: "3" }), s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s0, s1] } }, { auto: true });
  assert.equal((await e.status()).running, true);
  node.sent.length = 0; await e.pass(150);
  const posted = steps(node.sent).filter(c => /^txnoutput/.test(c));
  assert.deepEqual(posted, ["txnoutput id:ID address:" + PAY0 + " amount:3 tokenid:0x00 storestate:false", "txnoutput id:ID address:" + PAY1 + " amount:7 tokenid:0x00 storestate:false"]);
  assert.equal(e._store().collect(ID(1)).status, "COLLECT_POSTED_SAFE"); assert.equal(e._store().collect(ID(2)).status, "COLLECT_POSTED");
  // the chain: both stakes spent; the at-risk payout now holds the collected coin
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(1)] = Object.assign({}, s0, { spent: true }); node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  node.sent.length = 0; await e.pass(152);
  assert.equal(e._store().collect(ID(1)).status, "COLLECTED_SAFE"); assert.equal(e._store().collect(ID(2)).status, "SWEEP_QUEUED");
  assert.deepEqual(steps(node.sent), ["txncreate id:ID", "txninput id:ID coinid:" + ID(50), "txnoutput id:ID address:" + SAFE_MX + " amount:7 tokenid:0x00 storestate:false",
    "txnlist id:ID", "txnsign id:ID publickey:" + KEY1, "txnbasics id:ID", "txnlist id:ID", "txnpost id:ID", "txndelete id:ID"], "the native's sweep: sign before basics, the gate before each");
  assert.ok(node.sent.includes("coins address:" + PAY1 + " checkmempool:true"), "found by its own address");
  // spent: an external safe cannot be looked at, so it is marked swept
  node.n.wallet[0].spent = true; node.n.coins[ID(50)] = node.n.wallet[0];
  await e.pass(153);
  assert.equal(e._store().sweeps("SWEPT").length, 1);
  assert.ok(e.activity().some(l => l.msg.startsWith("Secured 7 | coin:" + ID(50))));
});

test("the guardian waits rather than guess: no fresh audit, no clean collect; rescue off, no at-risk collect; a locked vault, nothing", async () => {
  const at = { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 100 }), stake(2, PAY1, { mature: 100 })] };
  const a = await guardian({ at }, { auto: true });
  a.e._store().kv.setBool(FC.K.AUDIT_OK, false);
  await a.e.pass(150);
  assert.equal(a.e._store().collect(ID(1)).status, "DETECTED", "no audit: the clean stake stays in the contract");
  assert.equal(a.e._store().collect(ID(2)).status, "COLLECT_POSTED", "the at-risk one does not need the audit");
  const b = await guardian({ at, answer: { status: async () => ({ status: true, response: { locked: true } }) } });
  b.node.sent.length = 0; await b.e.pass(150);
  assert.deepEqual(b.node.sent.filter(c => /^txn/.test(c)), [], "a locked vault: nothing collected onto an exposed address");
  assert.equal((await b.e.status()).vaultLocked, true);
});

test("a pass is bounded: at most 8 collects posted, the rest wait for the next block", async () => {
  const many = []; for (let i = 1; i <= 11; i++) many.push(stake(i, PAY0, { mature: 100 }));
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: many } }, { auto: true });
  node.sent.length = 0; await e.pass(150);
  assert.equal(node.sent.filter(c => /^txnpost/.test(c)).length, FC.CAP_POSTS);
  node.sent.length = 0; await e.pass(151);
  assert.equal(node.sent.filter(c => /^txnpost/.test(c)).length, 3);
});

test("the sign gate on a sweep: another destination, or a coin on a clean address, is refused; nothing is signed", async () => {
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  for (const [name, tamper] of [["another destination", (t) => (t.outputs.length && (t.outputs[0].address = STRANGER), t)], ["a coin on another address", (t) => (t.inputs.length && (t.inputs[0].address = PAY2), t)]]) {
    const { e, node, logs } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
    await e.pass(150);
    node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
    node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
    node.n.tamper = (t) => (t.inputs[0] && t.inputs[0].coinid === ID(50) ? tamper(t) : t);
    node.sent.length = 0; await e.pass(152);
    assert.ok(!node.sent.some(c => /^txnsign/.test(c)), name + ": not signed");
    assert.ok(!node.sent.some(c => /^txnpost/.test(c)), name + ": not posted");
    assert.ok(logs.some(l => /SIGN GATE REFUSED txnsign/.test(l)), name + ": logged");
    assert.equal(e._store().sweeps("PENDING").length, 1, name + ": left to try again");
  }
  assert.equal(FC.gateCheck({ inputs: [{ coinid: ID(1), address: PAY0, amount: "1", tokenid: "0x00" }], outputs: [{ address: SAFE_HEX, amount: "1", tokenid: "0x00" }] },
    { kind: "sweep", coinid: ID(1), tokenid: "0x00", amount: "1", from: PAY0, to: SAFE_MX, safe: SAFE_MX, own: () => true, mayMove: () => false }).ok, false, "a clean address is never swept");
});

test("the rescue destination: a reused one, one of this node's own, or a malformed one is refused", async () => {
  const x = await engine({}, { get: async () => ({ status: true, results: [{ address: SAFE_HEX, reused: true, reuse_count: 3 }] }) });
  assert.match((await x.e.setSafeExternal(SAFE_MX)).error, /already signed 3 time\(s\)/);
  const y = await engine({ keys: [KEY0, "0x0000000000000000000000000000000000000000000000000000000000000000"] }, { get: async () => null });
  assert.match((await y.e.setSafeExternal(SAFE_MX)).error, /belongs to THIS node/);
  assert.match((await y.e.setSafeExternal("Mx123;quit")).error, /Not a valid Mx address/);
  const z = await engine({}, { get: async () => null });
  const r = await z.e.setSafeExternal(SAFE_MX); assert.deepEqual([r.ok, r.verified], [true, false], "unknown reuse: accepted, re-checked by every audit");
  assert.ok(z.e.activity().some(l => /reuse check UNVERIFIED/.test(l.msg)));
  const same = await engine(); const sn = await same.e.setSafeSameNode();
  assert.equal(sn.ok, true); assert.ok(same.node.sent.includes("newaddress"));
});

test("retire: only with the guardian running; never with coins, stakes paying it, or the change pool at 8; the native's newscript; recorded", async () => {
  const keys = []; for (let i = 1; i <= 10; i++) keys.push("0x" + String(i).padStart(2, "0").repeat(32));
  const RISK = ADDR(keys[1]);
  const { e, node } = await guardian({ keys }, { atRisk: [RISK] });
  e._store().kv.setBool(FC.K.GUARDIAN_ON, false);
  assert.match((await e.retire(RISK)).error, /Start the guardian first/);
  e._store().kv.setBool(FC.K.GUARDIAN_ON, true);
  node.n.wallet = [{ coinid: ID(60), address: RISK, amount: "1", tokenid: "0x00", spent: false }];
  assert.match((await e.retire(RISK)).error, /still holds 1 coin/);
  node.n.wallet = []; node.n.at[FC.KNOWN_ADDRESS] = [stake(1, RISK, { mature: 999 })];
  assert.match((await e.retire(RISK)).error, /Stakes still pay out/);
  node.n.at[FC.KNOWN_ADDRESS] = [];
  assert.match((await e.retire(ADDR(keys[2]))).error, /found at risk/, "an address the audit did not flag");
  node.n.scripts.forEach((r, i) => { r.default = i < 8; });
  assert.match((await e.retire(RISK)).error, /Keep at least 8/);
  node.n.scripts.forEach((r) => { r.default = true; });
  node.sent.length = 0;
  const r = await e.retire(RISK);
  assert.deepEqual(r, { ok: true, value: RISK });
  assert.deepEqual(node.sent.filter(c => /^newscript/.test(c)), ['newscript trackall:true script:"RETURN SIGNEDBY(' + keys[1] + ')"']);
  assert.deepEqual(e._store().retired().map(x => x.address), [RISK]);
  assert.ok((await e._scripts(true)).retired.includes(RISK), "the node now lists it retired (key nulled, not default)");
});

test("coins stranded on a retired address are queued and swept to the safe destination with the address's own key", async () => {
  const keys = [KEY0, KEY1, KEY2], RET = PAY2;
  const { e, node } = await guardian({ keys });
  const row = node.n.scripts.find(x => x.address === RET); row.default = false; row.publickey = "0x00";
  node.n.wallet = [{ coinid: ID(70), address: RET, amount: "4", tokenid: "0x00", spent: false }];
  node.sent.length = 0; await e.pass(160);
  assert.ok(node.sent.includes("txnsign id:" + (node.sent.find(c => c.startsWith("txnsign")) || "").split(" ")[1].slice(3) + " publickey:" + KEY2), "the explicit key: auto cannot sign a retired address");
  assert.equal(e._store().sweeps("SWEEP_POSTED").length, 1);
});

test("the grant: asked natively in main, written only by config.setFcGrant, never from a renderer patch; revocable", () => {
  const cfg = fs.readFileSync(path.join(__dirname, "..", "main", "config.js"), "utf8"), main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(/if \(k === "fcGrant"\) continue;/.test(cfg), "sanitisePatch drops fcGrant: mcd:saveConfig cannot set it");
  assert.equal((main.match(/config\.setFcGrant\(/g) || []).length, 3, "three writers: the grant after the native question, Revoke, and a new destination dropping it");
  const fn = main.slice(main.indexOf("async function fcGuardian"), main.indexOf("async function fcRevoke"));
  assert.ok(fn.indexOf("dialog.showMessageBox(") > 0 && fn.indexOf("dialog.showMessageBox(") < fn.indexOf("config.setFcGrant(wk, Date.now(), safe)"), "the question comes before the grant");
  assert.ok(/if \(r\.response !== 0\) return \{ ok: false, declined: true \};/.test(fn), "anything but Allow declines");
  assert.ok(/revoke: \(\) => fcRevoke\(\)/.test(main));
  assert.ok(main.includes("const wk = futurecash.walletKey || null;") && main.includes("config.setFcGrant(wk, null);") && cfg.includes("const all = walletKey === null && !at;"), "Revoke works with no store open: every grant (review L1)");
  const ops = main.slice(main.indexOf("const FC_OPS"), main.indexOf(" * THE ONE NATIVE GRANT"));
  assert.ok(!/setFcGrant|fcGrant:/.test(ops.replace(/fcGuardian|fcRevoke/g, "")), "no screen op writes the grant directly");
});

test("the coin guard: a collected coin waiting for its sweep is held for Future Cash Next until it is swept; other owners cannot take it first", async () => {
  const reg = require("../main/reserve.js").createRegistry({ now: () => Date.now(), log() {} });
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const x = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] } }, { granted: () => ({ at: 1, safe: SAFE_MX }), reserve: reg, get: async () => ({ status: true, results: [{ address: SAFE_HEX, reused: false, reuse_count: 0 }] }) });
  const { e, node } = x, kv = e._store().kv;
  await e.setSafeExternal(SAFE_MX); kv.set(FC.K.ATRISK_ADDRS, JSON.stringify([PAY1])); await e.setGuardian(true);
  node.n.answer.txnsign = async () => ({ status: false, error: "vault busy" });   // the sweep fails this time: the coin stays queued
  await e.pass(150);
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  await e.pass(152);
  const held = reg.list().find(r => r.coinid === ID(50));
  assert.ok(held && held.owner === "futurecash" && held.why === "Future Cash Next", JSON.stringify(reg.list()));
  assert.ok(reg.foreign("pandapools", ID(50)) && reg.foreign("wallet", ID(50)) && !reg.foreign("futurecash", ID(50)), "held from every other owner, not from itself");
  assert.deepEqual(e.coinHolds().map(h => h.coinid).sort(), [ID(50)], "the claimed collect is done; the sweep is still owed");
  delete node.n.answer.txnsign; node.n.tip = 161; await e.pass(161);   // tried again, swept
  node.n.wallet[0].spent = true; await e.pass(162);
  assert.ok(!reg.list().some(r => r.coinid === ID(50) && r.state === "held"), "released once swept");
  await e.stop(); assert.equal(e.coinHolds(), null, "a closed store says nothing: the guard keeps what it holds");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(src.includes('reserve.setHoldSource("futurecash", () => futurecash.coinHolds());'));
});

test("a collect or a sweep under way: the restore gate refuses with the coin ids whole, Quit and Shutdown say it, Freeze refuses; each in every language", async () => {
  const restore = require("../main/restore.js"), { inFlight } = require("../main/inflight.js"), freeze = require("../main/freeze.js");
  const I18N = require("../renderer/i18n.js"); for (const c of ["en", "zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const MS = require("../renderer/mainsaid.js");
  const s1 = stake(1, PAY0, { mature: 140 });
  const { e } = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  assert.deepEqual(e.activeWork(), { ready: true, hasStore: true, collects: [], queued: [], sweeps: [], posted: 0 });
  assert.deepEqual(restore.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], futurecash: e.activeWork() }), []);
  await e.collectNow(ID(1));
  const w = e.activeWork(); assert.equal(w.posted, 1);
  const lines = restore.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], futurecash: w });
  assert.deepEqual(lines, ["1 Future Cash Next collect or sweep is still under way, which only this wallet's keys can finish: " + ID(1)]);
  const said = [restore.activeWorkProblem(lines), restore.activeWorkProblem(restore.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], futurecash: null })),
    restore.activeWorkProblem(restore.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], futurecash: { ready: false, hasStore: true } })),
    restore.skipWarning(restore.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], futurecash: { ready: false, hasStore: true, error: "damaged" } }))];
  const fz = freeze.create({ load: () => [], save() {}, engines: { futurecash: { start() {}, stop() {}, blockers: async () => freeze.futurecashBlockers(w) } }, readMs: 50 });
  await assert.rejects(fz.set("futurecash", true), (err) => (said.push(err.message), /still moving funds[\s\S]*• 1 collect is posted and not confirmed yet\./.test(err.message)));
  const fz2 = freeze.create({ load: () => [], save() {}, engines: { futurecash: { start() {}, stop() {}, blockers: async () => freeze.futurecashBlockers(null) } }, readMs: 50 });
  await assert.rejects(fz2.set("futurecash", true), (err) => (said.push(err.message), /could not be asked/.test(err.message)));
  for (const m of said) {
    I18N.set("en"); assert.ok(MS.read(m), "listed: " + m.slice(0, 120)); assert.equal(MS.say(m), m);
    for (const c of ["zh", "ru", "uk"]) { I18N.set(c); const t = MS.say(m); assert.notEqual(t, m, c); assert.ok(!/Future Cash Next (could not|has not|is still|collect)/.test(t), c + ": an English sentence left: " + t.slice(0, 160)); }
  }
  I18N.set("en");
  const q = inFlight({ futurecash: w, pools: [], atomix: { ready: true, swaps: [] }, dexicon: { ready: true } }, "quit", Date.now());
  assert.ok(q.busy.some(b => /^1 Future Cash Next collect or sweep is under way\. While the app is closed the app cannot follow it/.test(b)), q.busy.join(" | "));
  assert.ok(inFlight({ futurecash: null, pools: [], atomix: { ready: true, swaps: [] }, dexicon: { ready: true } }, "shutdown").unread.some(u => /Future Cash Next could not be asked/.test(u)));
  assert.equal(inFlight({ pools: [], atomix: { ready: true, swaps: [] }, dexicon: { ready: true } }, "quit").any, false, "not asked: nothing said");
  assert.deepEqual(freeze.futurecashBlockers({ ready: true, collects: [], queued: [], sweeps: [] }), []);
  assert.ok(freeze.FREEZABLE.includes("futurecash"));
});

test("the store is this wallet's, moved aside (never deleted) when the wallet is replaced; main joins it to every gate", async () => {
  const { e, dir } = await engine();
  const file = e._store().file;
  assert.ok(/futurecash[\\/]futurecash-pk-0x[0-9a-f]{64}\.sqlite$/.test(file), file);
  const kept = await e.invalidate();
  assert.ok(kept.startsWith(file + "-legacy-keys-") && fs.existsSync(kept) && !fs.existsSync(file));
  assert.deepEqual(e.activeWork(), { ready: false, hasStore: false, error: "" });
  fs.writeFileSync(path.join(dir, "futurecash", "futurecash-pk-0x" + "ab".repeat(32) + ".sqlite"), "not a database");
  assert.equal(e.activeWork().hasStore, true, "a store that is not open counts as could not be read");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  const hook = main.slice(main.indexOf("node.onWalletReplaced = async () => {"), main.indexOf("// Restore from a backup FILE"));
  assert.ok(hook.includes('await each("Future Cash Next", () => futurecash.invalidate());'));
  assert.ok((main.match(/futurecash: await Promise\.resolve\(\)\.then\(\(\) => futurecash\.activeWork\(\)\)\.catch\(\(\) => null\)/g) || []).length === 1 && main.includes("one(() => futurecash.activeWork())"), "the restore gate and Quit / Shutdown: a failed read is null (Quit / Shutdown through one() since 0.19.321)");
  assert.ok(main.includes('frozen: () => freeze.isFrozen("futurecash")') && main.includes('!freeze.isFrozen("futurecash")) { fcBlock = b;'), "frozen: no start, no pass");
  assert.ok(/futurecash: \{ start: whenRunning\(\(\) => futurecash\.start\(\)\), stop: \(\) => futurecash\.stop\(\), blockers:/.test(main));
});

test("the screens: every action that moves coins is asked first, every call is a named main action, ids copy whole, amounts are the node's, no em dash", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "futurecash.js"), "utf8"), main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  const ops = main.slice(main.indexOf("const FC_OPS"), main.indexOf(" * THE ONE NATIVE GRANT"));
  for (const m of src.matchAll(/api\.fc\("(\w+)"/g)) assert.ok(new RegExp("\\b" + m[1] + ": ").test(ops), "a main action: " + m[1]);
  for (const op of ["lock", "collect", "collectAll", "sweep", "retire", "recover", "revoke"]) {
    const at = src.indexOf('api.fc("' + op + '"'); assert.ok(at > 0, op);
    const before = src.slice(Math.max(0, src.lastIndexOf("\n", src.lastIndexOf("\n", at) - 1)), at);
    assert.ok(/await showConfirm\(/.test(before), op + " is asked first");
  }
  assert.ok(!/api\.(cmd|tryCmd)\(|\bcmd\(|tryCmd\(/.test(src), "never the free command channel");
  for (const m of src.matchAll(/\b(?:t|th|tr|N_)\(\s*"((?:[^"\\]|\\.)*)"/g)) assert.ok(!JSON.parse('"' + m[1] + '"').includes("—"), "no em dash: " + m[1].slice(0, 80));
  for (const v of ["x.payout", "x.coinid", "x.tokenid", "st.safe", "r.address", "r.mx || r.hex"]) assert.ok(src.includes("fcnCopy(" + v), "whole and copyable: " + v);
  const fcnAmt = new Function("return " + /const fcnAmt = (\(a\) => \{[\s\S]*?\});/.exec(src)[1])();
  assert.equal(fcnAmt("1000.000000000000000001"), "1000.000000000000000001"); assert.equal(fcnAmt("250.500"), "250.5"); assert.equal(fcnAmt("12"), "12"); assert.equal(fcnAmt("0.123456789"), "0.123456789");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(/\{ id: "ethwallet", [^\n]+\n  \{ id: "futurecash", name: "Future Cash Next", icon: "icons\/futurecash\.svg" \}/.test(app), "the tray row after ETH Wallet, with the ported icon");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "icons", "futurecash.svg"), "utf8").includes('fill="#F7931A"'));
});

test("what the engine says to the screens is listed (mainsaid FC_*), each template still in main/futurecash.js, and said in zh, ru and uk", async () => {
  const I18N = require("../renderer/i18n.js"); for (const c of ["en", "zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const MS = require("../renderer/mainsaid.js"), src = ["futurecash.js", "futurecash-store.js"].map(f => fs.readFileSync(path.join(__dirname, "..", "main", f), "utf8")).join("\n");
  const codes = MS.codes().filter(c => /^FC_/.test(c)); assert.ok(codes.length >= 50);
  for (const c of codes) for (const part of MS.template(c).split(/\{\w+\}/).filter(p => p.length > 12)) assert.ok(src.includes(part), c + ": " + part);
  const said = [];
  const { e } = await audited({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 999 }), stake(2, STRANGER, { mature: 1 })] } });
  said.push((await e.collectNow(ID(1))).error, (await e.collectNow(ID(2))).error, (await e.collectNow("x")).error, (await e.lock("0", 72, "")).error, (await e.lock("1", 72, "Mx1")).error, (await e.setSafeExternal("x")).error, (await e.retire(PAY0)).error);
  for (const m of said) {
    I18N.set("en"); assert.ok(MS.read(m), "listed: " + m); assert.equal(MS.say(m), m);
    for (const c of ["zh", "ru", "uk"]) { I18N.set(c); assert.notEqual(MS.say(m), m, c + ": " + m); }
  }
  I18N.set("en");
});

// 0.19.194: every command Future Cash Next sends is ONE command (main/rpc.js oneCommand, released 0.18.177). It sends no
// chain on purpose: each step of a collect or a sweep is its own command, built from its own checked values.
test("one command each: main.js wraps the engine's runner in rpc.oneCommand; a stake whose state carries ';' never puts one on the wire", async () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(main.includes('run: (c, opts) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), rpc.oneCommand(c), Object.assign({}, opts, { owner: "futurecash" }))'), "every command through oneCommand, its options kept");
  const { oneCommand } = require("../main/rpc");
  assert.throws(() => oneCommand("txnbasics id:a;txnpost id:a"), /second command\. Nothing was sent/);
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "futurecash.js"), "utf8");
  assert.ok(!/["'`][^"'`\n]*;\s*(txn|send|coins|keys|newscript|newaddress)/.test(src), "no chain is written into the engine's commands");
  const evil = stake(3, PAY0 + ";send amount:5 address:" + SAFE_HEX, { mature: 100, amount: "4" }), evil2 = stake(4, "0x01;vault", { mature: 100 });
  const s0 = stake(1, PAY0, { mature: 100, amount: "3" }), s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s0, s1, evil, evil2] } }, { auto: true });
  await e.pass(150);
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  await e.pass(152);
  await e.lock("1", 72, "");
  assert.ok(node.sent.some(c => c.startsWith("txnpost id:")) && node.sent.some(c => c.startsWith("send ")), "collects, a sweep and a lock were sent");
  assert.deepEqual(node.sent.filter(c => c.includes(";")), [], "no command with ';' was built");
  for (const c of node.sent) assert.equal(oneCommand(c), c);
});

// ---- review of 20/21 Nov 2026 (0.19.203+) ----
test("H1: dust stakes naming this wallet never starve the sweep: collects and sweeps have their own budgets, sweeps go first, and only MINIMA of at least the floor is collected by itself", async () => {
  const dust = []; for (let i = 100; i < 120; i++) dust.push(stake(i, PAY0, { mature: 100, amount: "0.00000001" }));
  const big = []; for (let i = 200; i < 212; i++) big.push(stake(i, PAY0, { mature: 100, amount: "2" }));
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } }, { auto: true });
  await e.pass(150);   // our collect of the at-risk stake
  node.n.at[FC.KNOWN_ADDRESS] = dust.concat(big); node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  node.sent.length = 0; await e.pass(152);
  const signs = node.sent.filter(c => /^txnsign/.test(c)), outs = node.sent.filter(c => /^txnoutput/.test(c));
  assert.equal(signs.length, 1, "the sweep is signed in the same pass");
  assert.ok(node.sent.findIndex(c => /^txnsign/.test(c)) < node.sent.findIndex(c => /^txnoutput .* amount:2 /.test(c)), "the sweep before any new collect");
  assert.equal(outs.filter(c => / amount:2 /.test(c)).length, FC.CAP_POSTS, "8 collects of their own budget");
  assert.ok(!outs.some(c => / amount:0\.00000001 /.test(c)), "dust is never collected by itself");
  assert.equal(e._store().collect(ID(100)).status, "DETECTED", "dust stays listed for a collect by hand");
  assert.equal((await e.setMinAuto("0")).ok, false); assert.equal((await e.setMinAuto("abc")).ok, false);
  assert.deepEqual(await e.setMinAuto("0.00000001"), { ok: true, value: "0.00000001" });
  assert.equal((await e.status()).minAuto, "0.00000001");
});

test("H1: a stake whose collect parts() refuses is never claimed and takes no post slot; a row that does not resolve is not asked about every block", async () => {
  const bad = []; for (let i = 300; i < 310; i++) bad.push(stake(i, PAY0, { mature: 100, amount: "0" }));
  const good = stake(9, PAY0, { mature: 100, amount: "5" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: bad.concat([good]) } }, { auto: true });
  await e.setMinAuto("0.00000001");
  node.sent.length = 0; await e.pass(150);
  assert.equal(node.sent.filter(c => /^txnpost/.test(c)).length, 1); assert.equal(e._store().collect(ID(9)).status, "COLLECT_POSTED_SAFE");
  for (let i = 300; i < 310; i++) assert.equal(e._store().collect(ID(i)).status, "DETECTED", "never claimed");
  // forty rows the node no longer shows and cannot say anything about: read once, then left alone for 30 blocks
  const gone = []; for (let i = 400; i < 440; i++) gone.push(stake(i, PAY0, { mature: 999 }));
  node.n.at[FC.KNOWN_ADDRESS] = gone; await e.pass(151);
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.answer["coins coinid:"] = async () => ({ status: false, error: "busy" });
  node.sent.length = 0; await e.pass(152);
  const first = node.sent.filter(c => /^coins coinid:/.test(c)).length;
  node.sent.length = 0; await e.pass(153);
  const second = node.sent.filter(c => /^coins coinid:/.test(c)).length;
  assert.ok(first > 0 && second < first, "asked " + first + " then " + second);
});

test("H2: a manual Sweep that fails gives a sweep the guardian had queued back to it (PENDING, still held); the guardian then moves it", async () => {
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  await e.pass(150);
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  let locked = true;
  node.n.answer.status = async () => ({ status: true, response: { locked } });
  node.n.answer.txnsign = async () => (locked ? { status: false, error: "vault locked" } : undefined);
  await e.pass(152);
  assert.deepEqual(e._store().sweeps("PENDING").map(r => r.coinid), [ID(50)], "queued, waiting for the vault");
  const r = await e.sweepAddress(PAY1);
  assert.equal(r.swept, 0);
  assert.deepEqual(e._store().sweeps("PENDING").map(r => r.coinid), [ID(50)], "back to the guardian, not deleted");
  assert.deepEqual(e.coinHolds().map(h => h.coinid), [ID(50)], "still held");
  locked = false; node.sent.length = 0; await e.pass(153);
  assert.equal(node.sent.filter(c => /^txnsign/.test(c)).length, 1, "swept once the vault is open");
  const fresh = await guardian({}); fresh.node.n.wallet = [{ coinid: ID(60), address: PAY1, amount: "3", tokenid: "0x00", spent: false }];
  fresh.node.n.answer.txnsign = async () => ({ status: false, error: "boom" });
  await fresh.e.sweepAddress(PAY1);
  assert.equal(fresh.e._store().sweepRow(ID(60)), null, "a row the click itself made is removed on failure");
});

test("H3: the grant is bound to the safe destination it named: another destination drops it and stops the guardian; main reads the destination again after the question", async () => {
  const OTHER = "MxG0815C6FG5FMUDRRMYTR8NRT0U7H8DTWK9SPZGJ2EY5RVTN60TJ6SZF7VJ889", s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  let grant = null; const dropped = [];
  const x = await audited({ at: { [FC.KNOWN_ADDRESS]: [s1] } }, { granted: () => grant, dropGrant: (wk) => { dropped.push(wk); grant = null; }, get: async () => ({ status: true, results: [] }) });
  const { e, node } = x, kv = e._store().kv;
  await e.setSafeExternal(SAFE_MX); kv.set(FC.K.ATRISK_ADDRS, JSON.stringify([PAY1]));
  grant = { at: 1, safe: OTHER };
  assert.equal((await e.setGuardian(true)).needsGrant, true, "a grant for another destination is no grant");
  grant = { at: 1, safe: SAFE_MX }; assert.equal((await e.setGuardian(true)).ok, true); assert.equal((await e.status()).running, true);
  await e.setSafeExternal(OTHER);
  assert.equal(dropped.length, 2, "the first destination and the change each drop it"); const st = await e.status(); assert.deepEqual([st.running, st.guardianOn], [false, false]);
  node.sent.length = 0; await e.pass(150);
  assert.deepEqual(node.sent.filter(c => /^txn/.test(c)), [], "nothing signed or posted for the new destination");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8"), fn = main.slice(main.indexOf("async function fcGuardian"), main.indexOf("async function fcRevoke"));
  assert.ok(fn.indexOf("const after = await futurecash.status();") > fn.indexOf("dialog.showMessageBox(") && /after\.safe !== safe/.test(fn), "read again after the answer and compared with what was shown");
  const cfg = fs.readFileSync(path.join(__dirname, "..", "main", "config.js"), "utf8");
  assert.ok(cfg.includes("g[walletKey] = { at: Number(at), safe: String(safe) };") && cfg.includes('typeof r.safe === "string"'), "{ at, safe }; a bare number is no grant");
});

test("M1: on a classic key wallet the guardian signs for one address at most sign_cap times a day by itself; past it, once logged, it waits", async () => {
  const coins = []; for (let i = 0; i < 5; i++) coins.push({ coinid: ID(70 + i), address: PAY2, amount: "4", tokenid: "0x00", spent: false });
  const { e, node } = await audited({}, { granted: () => ({ at: 1, safe: SAFE_MX }), keyMode: () => "classic", get: async () => ({ status: true, results: [] }) });
  await e.setSafeExternal(SAFE_MX); assert.equal((await e.setGuardian(true)).ok, true);
  const row = node.n.scripts.find(r => r.address === PAY2); row.default = false; row.publickey = "0x00";   // retired: its coins are swept
  node.n.wallet = coins; await e.setSignCap("3");
  node.sent.length = 0; await e.pass(160);
  assert.equal(node.sent.filter(c => /^txnsign/.test(c)).length, 3, "three signatures, then the limit");
  await e.pass(161); await e.pass(162);
  assert.equal(node.sent.filter(c => /^txnsign/.test(c)).length, 3, "no more that day");
  assert.equal(e.activity().filter(l => /^Daily limit of unattended signatures reached \(3\)/.test(l.msg)).length, 1, "said once");
  assert.equal((await e.setSignCap("0")).ok, false); assert.equal((await e.status()).signCap, 3);
});

test("M2: an at-risk collect whose coin is never found ends COLLECTED_UNFOUND after 120 blocks: logged, no longer work under way, cleared by Reset history", async () => {
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  await e.pass(150);
  node.n.at[FC.KNOWN_ADDRESS] = []; node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });   // spent, and nothing ever lands on PAY1
  await e.pass(151);
  assert.equal(e._store().collect(ID(2)).status, "COLLECTED"); assert.equal(e.activeWork().posted, 1);
  await e.pass(269); assert.equal(e._store().collect(ID(2)).status, "COLLECTED", "still looked for");
  await e.pass(270);
  assert.equal(e._store().collect(ID(2)).status, "COLLECTED_UNFOUND"); assert.equal(e.activeWork().posted, 0);
  assert.ok(e.activity().some(l => l.msg.startsWith("Collected coin not found on its payout address 120 blocks after the collect")));
  await e.resetHistory(); assert.equal(e._store().collect(ID(2)), null);
});

test("M3: a failed start is tried again with growing pauses for the whole node session, and said once while background signing is allowed", async () => {
  let t = 0, fails = 3, frozen = false, starts = 0; const said = [];
  const st = FC.createStarter({ start: async () => { starts++; if (fails-- > 0) throw new Error("locked"); }, frozen: () => frozen, granted: () => true, notify: () => said.push(1), now: () => t });
  assert.equal(await st.tick(), false); assert.equal(said.length, 1);
  assert.equal(await st.tick(), false); assert.equal(starts, 1, "not again before the pause");
  t += 30000; assert.equal(await st.tick(), false); assert.equal(starts, 2);
  t += 30000; await st.tick(); assert.equal(starts, 2, "the pause doubled");
  t += 30000; await st.tick(); assert.equal(starts, 3); assert.equal(said.length, 1, "said once while failing");
  t += 600000; assert.equal(await st.tick(), true); assert.equal(starts, 4, "started: never given up");
  frozen = true; t += 1e7; assert.equal(await st.tick(), false); assert.equal(starts, 4, "frozen: not started");
});

test("M4: a stake list over 5,000 rows skips detection, but known rows are still settled and swept, and the screen says so", async () => {
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  await e.pass(150);
  node.n.at[FC.KNOWN_ADDRESS] = new Array(5001).fill(stake(9, STRANGER)); node.n.coins[ID(2)] = Object.assign({}, s1, { spent: true });
  node.n.wallet = [{ coinid: ID(50), address: PAY1, amount: "7", tokenid: "0x00", created: "151", spent: false }];
  node.sent.length = 0; assert.equal(await e.pass(152), true);
  assert.equal(node.sent.filter(c => /^txnsign/.test(c)).length, 1, "the known collect's coin is swept");
  assert.equal((await e.status()).tooMany, true);
  assert.equal(e.activity().filter(l => /^More than 5,000 stakes/.test(l.msg)).length, 1);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "renderer", "futurecash.js"), "utf8").includes("st.tooMany"));
});

test("L1: Revoke during a pass: nothing more is posted after the grant is gone", async () => {
  const at = []; for (let i = 1; i <= 4; i++) at.push(stake(i, PAY0, { mature: 100 }));
  let grant = { at: 1, safe: SAFE_MX };
  const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: at } }, { granted: () => grant, get: async () => ({ status: true, results: [] }) });
  await e.setSafeExternal(SAFE_MX); e._store().kv.setBool(FC.K.AUTO_COLLECT_SAFE, true); await e.setGuardian(true);
  node.n.answer.txnpost = async () => { grant = null; return undefined; };   // the user takes it back while the first post is out
  node.sent.length = 0; await e.pass(150);
  assert.equal(node.sent.filter(c => /^txnpost/.test(c)).length, 1, "the post under way ends; no other starts");
});

test("L2: with sends only observed, a Send or a Consolidate still keeps off the coins Future Cash Next holds (and only those)", async () => {
  const { createRegistry } = require("../main/reserve"), { makeNode, coinId, ADDR: RA } = require("./reserve-model.cjs");
  const node = makeNode([{ coinid: coinId(1), amount: "100", address: RA(1) }, { coinid: coinId(2), amount: "50", address: RA(2) }]);
  const reg = createRegistry({ now: () => 1e12, log: () => {}, sends: "observe" }), as = (o) => (c) => reg.guard(o, c, node.run);
  reg.setHolds("futurecash", [{ coinid: coinId(1), why: "" }]);
  const big = await as("wallet")("send amount:120 address:" + RA(9));
  assert.equal(big.status, false); assert.match(big.error, /held for Future Cash Next/);
  const cons = await as("wallet")("consolidate tokenid:0x00");
  assert.equal(cons.status, false); assert.match(cons.error, /Nothing consolidated/);
  reg.setHolds("futurecash", []); reg.setHolds("dexicon", [{ coinid: coinId(1), why: "a live Dexicon order" }]);
  const obs = await as("wallet")("consolidate tokenid:0x00");
  assert.notEqual(obs.reserved, true, "a Dexicon hold is still only observed");
});

test("L3: Retire names the apps that handed the address out; Stop, Take back and Freeze warn while retired addresses exist", async () => {
  const MX = "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6", HEX = "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941";
  assert.deepEqual(FC.handedOut(HEX, [{ app: "minimaMail", address: MX }, { app: "miniMall", address: "" }, { app: "AtomiX", address: HEX.toLowerCase() }, { app: "x", address: PAY0 }]), ["minimaMail", "AtomiX"]);
  const keys = [KEY0, KEY1, KEY2], { e, node } = await guardian({ keys });
  const row = node.n.scripts.find(x => x.address === PAY2); row.default = false; row.publickey = "0x00";
  await e._scripts(true); assert.equal((await e.status()).retired, 1);
  const r = fs.readFileSync(path.join(__dirname, "..", "renderer", "futurecash.js"), "utf8"), app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"), main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(r.includes('api.fc("handedOut", a)') && r.includes('if (await fcnRetiredOk()) fcnAct(() => api.fc("guardian", false)') && r.includes('+ fcnRetiredNote(), t("Take back")'));
  assert.ok(app.includes('id === "futurecash" && !FROZEN.includes(id) && !(await fcnRetiredOk('), "Freeze warns");
  assert.ok(/handedOut: \(addr\) => require\("\.\/futurecash"\)\.handedOut\(addr, \[\{ app: "minimaMail"/.test(main) && main.includes("atomix.status().minimaPk") && main.includes('getMeta("vendorAddress")'));
});

test("L4: the runner keeps the caller's options: Lock's send pin reads coins unfiltered, so it sees and avoids addresses with coins another part of the app holds", async () => {
  const opts = []; const { e, node } = await engine({ tip: 1000 });
  const run0 = node.run; const e2 = FC.create({ run: (c, o) => { opts.push([c, o]); return run0(c, o); }, dir: () => tmp(), get: async () => null, log() {} });
  await e2.start(); await e2.lock("2", 72, PAY0);
  assert.ok(opts.some(([c, o]) => /^coins relevant:true sendable:true checkmempool:true tokenid:0x00/.test(c) && o && o.unfiltered === true), "the pin's read carries unfiltered");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(main.includes('run: (c, opts) => rpc.rpcCall(node.rpcPort(), config.rpcSecret(), rpc.oneCommand(c), Object.assign({}, opts, { owner: "futurecash" }))'), "main passes them on to rpcCall");
});

test("L5: a long activity line keeps every id whole: the cut falls on a space after them", async () => {
  const { e, node } = await audited({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY0, { mature: 140 })] }, answer: { txnpost: async () => ({ status: false, error: "x".repeat(60) + " " + "0x" + "CD".repeat(400) }) } });
  e._store().kv.setBool(FC.K.AUTO_COLLECT_SAFE, true);
  await e.collectNow(ID(1));
  const g = await guardian({ at: { [FC.KNOWN_ADDRESS]: [stake(1, PAY1, { mature: 100 })] }, answer: { txnpost: async () => ({ status: false, error: "y ".repeat(700) }) } }, { atRisk: [PAY1] });
  await g.e.pass(150);
  const line = g.e.activity().find(l => l.msg.startsWith("Collect post failed"));
  assert.ok(line && line.msg.includes("| stake:" + ID(1) + " | to:" + PAY1), "both ids whole: " + (line && line.msg.slice(0, 200)));
  assert.ok(line.msg.length <= 1002 && line.msg.endsWith(" …"));
  for (const l of g.e.activity()) for (const m of l.msg.matchAll(/0x[0-9A-Fa-f]+/g)) assert.ok(m[0].length >= 64 || m[0].length < 10, "no cut id: " + m[0]);
});

test("L6: the reads a click makes are bounded: one address's coins, Harden's addresses, the retire gate's chain-wide contract read", async () => {
  const many = []; for (let i = 0; i < 600; i++) many.push({ coinid: ID(1000 + i), address: PAY1, amount: "1", tokenid: "0x00", spent: false });
  const { e, node } = await guardian({ wallet: many });
  node.n.wallet = many; node.sent.length = 0;
  await e.sweepAddress(PAY1);
  assert.equal(node.sent.filter(c => /^txninput/.test(c)).length, 500, "500 coins of one address in one go");
  const flagged = []; for (let i = 0; i < 100; i++) flagged.push(ADDR("0x" + String(i).padStart(64, "7")));
  e._store().kv.set(FC.K.ATRISK_ADDRS, JSON.stringify(flagged)); node.sent.length = 0;
  await e.harden();
  assert.ok(node.sent.filter(c => /^scripts address:/.test(c)).length <= 64);
  node.n.answer["coins address:" + FC.KNOWN_ADDRESS] = async () => ({ status: true, response: new Array(5001).fill(stake(9, STRANGER)) });
  e._store().kv.set(FC.K.ATRISK_ADDRS, JSON.stringify([PAY2]));
  assert.match((await e.retire(PAY2)).error, /Stakes still pay out/, "too many to look through: refused");
});

test("L7: an at-risk stake whose payout this node cannot sign for is left in the contract (the native's canSweep)", async () => {
  const s1 = stake(2, PAY1, { mature: 100, amount: "7" });
  const { e, node } = await guardian({ at: { [FC.KNOWN_ADDRESS]: [s1] } });
  const row = node.n.scripts.find(x => x.address === PAY1); row.script = "RETURN TRUE"; row.publickey = "0x00"; row.default = true;   // ours (default), but no key to sign a sweep with
  node.sent.length = 0; await e.pass(150);
  assert.deepEqual(node.sent.filter(c => /^txn/.test(c)), [], "not collected onto an address no sweep can follow from");
  assert.equal(e._store().collect(ID(2)).status, "DETECTED");
});

test("L8: a token id or payout from the store reaches a command only in its shape", async () => {
  const { e, node } = await engine();
  const st = e._store(); st.kv.set(FC.K.SAFE_MODE, "samenode"); st.kv.set(FC.K.SAFE_ADDRESS, SAFE_MX); st.kv.setBool(FC.K.ENABLED, true);
  st.kv.set(FC.K.CLEAN_ADDR, JSON.stringify({ mx: SAFE_MX, hex: SAFE_HEX }));
  st.insertSweep(ID(80), PAY1, "0x00 address:0xFF;quit", "1"); st.claimSweepForPost(ID(80), 150);
  st.insertCollect(ID(81), PAY1, "0x00;quit", "1", 100, true); st.setCollectStatus(ID(81), "COLLECTED");
  node.n.coins[ID(80)] = { coinid: ID(80), address: PAY1, amount: "1", tokenid: "0x00", spent: true };
  node.sent.length = 0; await e.pass(160);
  assert.deepEqual(node.sent.filter(c => /quit|0xFF/.test(c)), [], "nothing malformed was sent");
});
