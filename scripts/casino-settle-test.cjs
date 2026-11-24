// 0.18.330: P2P Chance SETTLE-ONLY mode (main/casino-settle.js). The casino was removed in 0.18.318; a wallet may still have an offer
// or a bet on chain, and it must be able to cancel, reveal, collect and claim it, and nothing else.
// The stand-in below behaves like the real node where it matters: a command text is split on EVERY ";" and each piece is run; the
// LAST value of a repeated parameter wins; `coins` never returns a spent coin (spent or unknown: []); txnpost answers at once with
// the pre-mining id at response.txpowid and the transaction is judged only when a block is mined (an invalid one is dropped
// silently); `coins` lists the NEWEST coin first and answers [] while the node is syncing; a state that is not there makes the
// covenant throw. The covenant is re-implemented here from its script, with Node's own SHA3, so a built transaction is checked by
// something other than the code under test.
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const S = require("../main/casino-settle");
const CONTRACT = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const hx = (b, n = 32) => "0x" + b.repeat(n);
const K1 = hx("A1"), K2 = hx("A2"), ADDR1 = hx("B1"), ADDR2 = hx("B2");          // this wallet: two keys, two addresses
const XK = hx("E1"), XA = hx("E2");                                                // a stranger
const up = (s) => String(s).toUpperCase();
const sha3 = (hex) => "0x" + crypto.createHash("sha3-256").update(Buffer.from(hex.slice(2), "hex")).digest("hex").toUpperCase();
const cid = (n) => "0x" + n.toString(16).toUpperCase().padStart(64, "C0");

// ---- the node's own value rules (kissvm Value.getValue, StateVariable, MiniNumber; read from the node source and proven with
// the classes of resources/minima.jar): a state is hex, a number within +-(2^64-1), TRUE / FALSE or a [string]; anything else, or
// a state that is not there, makes the contract THROW, which fails the whole spend.
const MAXN = (1n << 64n) - 1n, SCALE = 10n ** 44n;
function val(s) {
  if (typeof s !== "string") throw new Error("state missing");
  if (s.startsWith("[") && s.endsWith("]")) return { t: "s", v: s.slice(1, -1) };
  if (s.startsWith("0x")) { if (!/^0x[0-9a-fA-F]+$/.test(s) || s.length > 2 + 2 * 65536) throw new Error("bad hex"); const h = s.slice(2); return { t: "h", v: (h.length % 2 ? "0" + h : h).toUpperCase() }; }
  if (s === "TRUE" || s === "FALSE") return { t: "b", v: s === "TRUE" };
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s); if (!m) throw new Error("Invalid value : " + s);
  const n = BigInt(m[2]) * SCALE + BigInt((m[3] || "").slice(0, 44).padEnd(44, "0"));   // 44 decimals, cut (never rounded)
  if (n > MAXN * SCALE) throw new Error("MiniNumber outside the allowed range");
  return { t: "n", v: m[1] ? -n : n };
}
const str = (x) => x.t === "h" ? "0x" + x.v : x.t === "b" ? (x.v ? "TRUE" : "FALSE") : x.t === "s" ? x.v : (x.v < 0n ? "-" : "") + ((a) => (a / SCALE) + ((a % SCALE) ? "." + (a % SCALE).toString().padStart(44, "0").replace(/0+$/, "") : ""))(x.v < 0n ? -x.v : x.v);
/** What `txnstate value:` stores (StateVariable): the canonical text, or a throw. */
const stored = (v) => { const x = val(v); return x.t === "s" ? v : str(x); };
const D = (x) => { const v = val(String(x)); if (v.t !== "n") throw new Error("not a number"); return v.v; };

/**
 * The covenant, statement by statement from its script, as the node's VM runs it: every PREVSTATE / STATE is read through val()
 * (missing or unreadable: throw); "AND" evaluates BOTH sides; EQ / GT need both sides of one type; SIGNEDBY needs hex. A throw
 * is a failed spend. (CHANGELOG 0.18.330 names this as the check that is independent of the code under test.)
 */
function covenant(c, t, age) {
  try {
    const P = (n) => val(c.st[n]), St = (n) => val(t.state[n]), need = (x, ty) => { if (x.t !== ty) throw new Error("type"); return x.v; };
    const signed = (k) => t.signed.includes("0X" + need(k, "h")), is = (x, k) => need(x, "n") === BigInt(k) * SCALE;
    const same = (a, b) => { for (let n = a; n <= b; n++) if (str(P(n)) !== str(St(n))) return false; return true; };
    const out = (i, addr, amt, keep) => { const o = t.outputs[i]; return !!o && up(o.address) === "0X" + need(addr, "h") && D(o.amount) === amt && up(o.tokenid) === up(c.tokenid) && o.storestate === keep; };
    const must = (b) => { if (!b) throw new Error("ASSERT"); }, sha = (x) => sha3("0x" + need(x, "h")).slice(2);
    const amt = D(c.value), ADDR = { t: "h", v: CONTRACT.slice(2) };
    if (c.tokenScriptFalse) return false;                                   // a token's own script is run as well
    if (t.outputs.reduce((a, o) => a + D(o.amount), 0n) > amt) return false;
    const hpk = P(0), ha = P(1), hc = P(2), rng = P(3), po = P(4), bt = P(5), ph = P(6), to = P(7);
    { const a = is(ph, 0), b = signed(hpk); if (a && b) return true; }
    if (is(ph, 0)) { must(same(0, 5)); must(is(St(6), 1)); must(need(St(7), "n") === need(to, "n")); { const a = need(St(11), "n") >= 0n, b = need(St(11), "n") < need(rng, "n"); must(a && b); } must(out(0, ADDR, amt + need(bt, "n"), true)); return true; }
    const qk = P(8), pk = P(11);
    { const a = is(ph, 1), b = signed(hpk); if (a && b) { must(same(0, 5)); must(is(St(6), 2)); must(same(7, 11)); must(sha(St(12)) === need(hc, "h")); must(out(0, ADDR, amt, true)); return true; } }
    { const a = is(ph, 1), b = BigInt(age) * SCALE > need(to, "n"), s = signed(qk); if (a && b && s) return true; }
    { const a = is(ph, 2), b = signed(qk); if (a && b) {
      const ps = St(13); must(sha(ps) === need(P(10), "h"));
      const h = sha({ t: "h", v: need(P(12), "h") + need(ps, "h") }), r = BigInt(parseInt(h.slice(0, 8), 16)) % (need(rng, "n") / SCALE);
      if (r * SCALE === need(pk, "n")) { const w = need(bt, "n") * need(po, "n") / SCALE; must(out(0, P(9), w, false)); if (amt > w) must(out(1, ha, amt - w, false)); }
      else must(out(0, ha, amt, false));
      return true; } }
    { const a = is(ph, 2), b = BigInt(age) * SCALE > need(to, "n"), s = signed(hpk); if (a && b && s) return true; }
    return false;
  } catch (e) { return false; }
}

function standin(opt = {}) {
  const n = { tip: 5000, keys: [K1, K2], addrs: [ADDR1, ADDR2], coins: [], txns: new Map(), mempool: [], script: true, texts: [], ran: [], verdicts: [], fail: {}, shortKeys: null, nextId: 1, syncing: false, dropAll: false };
  Object.assign(n, opt);
  const params = (piece) => { const o = {}; for (const m of piece.matchAll(/([A-Za-z]+):("[^"]*"|\S+)/g)) o[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, ""); return o; };   // the LAST one wins
  const json = (c) => { const o = { coinid: c.coinid, amount: c.tokenid === "0x00" ? c.value : "0.0000000000000000000000000000000000001", address: c.address, tokenid: c.tokenid, state: Object.keys(c.st).map(p => ({ port: Number(p), type: 1, data: c.st[p] })), spent: false, created: String(c.created), age: String(n.tip - c.created) }; if (c.tokenid !== "0x00") o.tokenamount = c.value; return o; };
  function exec(piece) {
    const verb = piece.split(/[\s:]/)[0].toLowerCase(), p = params(piece);
    if (verb in n.fail) { const f = n.fail[verb]; if (f === "throw") throw new Error("RPC timeout"); return f; }
    if (verb === "block") return { status: true, response: { block: String(n.tip) } };
    if (verb === "keys") { const all = (n.shortKeys || n.keys); const rows = (p.publickey ? n.keys.filter(k => k === "0x" + up(p.publickey.slice(2))) : all).map(k => ({ publickey: k, uses: 1 })); return { status: true, response: { keys: rows, total: rows.length } }; }
    if (verb === "scripts") {
      const rows = n.addrs.map((a, i) => ({ script: "RETURN SIGNEDBY(" + n.keys[i] + ")", address: a, simple: true, default: true, publickey: n.keys[i], track: true })).concat(n.script ? [{ script: "…", address: CONTRACT, simple: false, default: false, publickey: "0x00", track: false }] : []);
      if (!p.address) return { status: true, response: rows };
      const row = rows.find(r => r.address === p.address);   // case-sensitive, like the node
      return row ? { status: true, response: row } : { status: false, error: "Script with that address not found" };
    }
    if (verb === "newscript") { n.script = true; return { status: true, response: { address: CONTRACT } }; }
    if (verb === "getaddress") return { status: true, response: { address: n.addrs[0], publickey: n.keys[0], simple: true } };
    if (verb === "coins") {   // never a spent coin; the newest first (the node walks back from its tip); [] while it is syncing
      if (n.syncing) return { status: true, response: [] };
      const live = n.coins.map((c, i) => [c, i]).filter(([c]) => !c.spent && (p.coinid ? up(c.coinid) === up(p.coinid) : up(c.address) === up(p.address))).sort((a, b) => (b[0].created - a[0].created) || (b[1] - a[1])).map(([c]) => c);
      return { status: true, response: live.map(json) };
    }
    if (verb === "txncreate") { n.txns.set(p.id, { id: p.id, inputs: [], outputs: [], state: {}, signed: [] }); return { status: true, response: {} }; }
    const t = n.txns.get(p.id); if (!t) return { status: false, error: "Transaction not found : " + p.id };
    if (verb === "txninput") { const c = n.coins.find(c => !c.spent && up(c.coinid) === up(p.coinid)); if (!c) return { status: false, error: "Coin not found" }; t.inputs.push(c); return { status: true, response: {} }; }
    if (verb === "txnoutput") { t.outputs.push({ amount: p.amount, address: p.address, tokenid: p.tokenid, storestate: p.storestate === "true" }); return { status: true, response: {} }; }
    if (verb === "txnstate") { try { t.state[p.port] = stored(p.value); } catch (e) { return { status: false, error: String(e.message) }; } return { status: true, response: {} }; }
    if (verb === "txnsign") { if (!n.keys.includes("0x" + up(p.publickey.slice(2)))) return { status: false, error: "Public key not found" }; t.signed.push(up(p.publickey)); return { status: true, response: {} }; }
    if (verb === "txnbasics") return { status: true, response: {} };
    if (verb === "txnpost") { const txpowid = "0x" + (n.nextId++).toString(16).toUpperCase().padStart(64, "0"); n.mempool.push(JSON.parse(JSON.stringify(Object.assign({}, t, { inputs: t.inputs.map(c => c.coinid) })))); return { status: true, response: { txpowid } }; }
    if (verb === "txndelete") { n.txns.delete(p.id); return { status: true, response: {} }; }
    return { status: false, error: "Command not found" };
  }
  n.run = async (text) => { n.texts.push(text); let first; for (const piece of String(text).split(";").map(s => s.trim()).filter(Boolean)) { n.ran.push(piece); const r = exec(piece); if (first === undefined) first = r; } return first; };
  /** A block: every posted transaction is judged by the covenant; a valid one spends its coin and makes its outputs. */
  n.mine = (blocks = 1) => {
    for (const t of n.mempool.splice(0)) {
      const c = n.coins.find(c => !c.spent && c.coinid === t.inputs[0]);
      const ok = !n.dropAll && !!c && n.script && covenant(c, t, n.tip + 1 - c.created); n.verdicts.push(ok);
      if (!ok) continue;
      c.spent = true;
      t.outputs.forEach((o, i) => n.coins.push({ coinid: cid(0x900000 + n.nextId * 16 + i), address: o.address, tokenid: o.tokenid, value: o.amount, created: n.tip + 1, st: o.storestate ? Object.assign({}, t.state) : {} }));
    }
    n.tip += blocks;
  };
  n.built = () => n.ran.filter(p => /^txn/.test(p)).map(p => p.replace(/cs_[a-z]+_\d+_\d+/, "ID"));
  n.coinsAt = (addr) => n.coins.filter(c => !c.spent && up(c.address) === up(addr));
  return n;
}
/** A coin at the contract. */
function coin(n, id, value, st, extra = {}) { const c = Object.assign({ coinid: cid(id), address: CONTRACT, tokenid: "0x00", value: String(value), created: n.tip - 10, st: Object.assign({}, st) }, extra); n.coins.push(c); return c; }
const HS = hx("5A"), HC = sha3(HS), PS = hx("6B"), PC = sha3(PS);       // a house secret and a player secret, with their commits
const offer = (o = {}) => Object.assign({ 0: K1, 1: ADDR1, 2: HC, 3: "2", 4: "2", 5: "0.07", 6: "0", 7: "1500" }, o);
const taken = (o = {}) => Object.assign(offer({ 6: "1" }), { 8: XK, 9: XA, 10: PC, 11: "1" }, o);
const revealed = (o = {}) => Object.assign(taken({ 6: "2" }), { 12: HS }, o);
const result = (hs, ps, range) => parseInt(sha3(hs + ps.slice(2)).slice(2, 10), 16) % range;

const TRIES = 3, PER_PASS = 4, PER_DAY = 24, CLAIMS_DAY = 12;   // the bounds of automatic signing, as numbers (the module's must equal them)
const signs = (n) => n.ran.filter(p => /^txnsign/.test(p)).length;
function use(n, secrets = {}) {
  let mem = {}; const notes = [];
  n.clock = 1800000000000; if (S._setClock) S._setClock(() => n.clock);
  S.invalidate(); S._setRunner(n.run); S._setSecrets((name) => secrets[name] || null); S._setStore({ load: () => JSON.parse(JSON.stringify(mem)), save: (o) => { mem = JSON.parse(JSON.stringify(o)); } });
  S.emitter.removeAllListeners("notify"); S.emitter.on("notify", (m) => notes.push(m));
  return { notes, posted: () => (mem.posted || {}), mem: () => mem };
}
const houseSecret = { ["casino_secret_for_" + HC]: HS }, playerSecret = { ["casino_psecret_for_" + PC]: PS };
/** No text ever holds ";", and nothing but the listed verbs ever reached the node. */
function clean(n) {
  for (const t of n.texts) assert.ok(!/[;\x00-\x1f\x7f]/.test(t), "a command held a ; or a control character: " + JSON.stringify(t));
  for (const p of n.ran) assert.match(p, /^(block|keys|scripts|getaddress|coins|newscript|txncreate|txninput|txnoutput|txnstate|txnsign|txnbasics|txnpost|txndelete)\b/, "an unexpected command: " + p);
}

test("(a) CANCEL: an open offer of this wallet goes back to its own address, signed with the offer's key; exactly these commands", async () => {
  const n = standin({ script: false }), c = coin(n, 1, "0.07", offer()); use(n);
  const l = await S.list();
  assert.equal(l.ok, true); assert.equal(l.rows.length, 1);
  assert.deepEqual([l.rows[0].coinid, l.rows[0].phase, l.rows[0].role, l.rows[0].action, l.rows[0].auto, l.rows[0].amount, l.rows[0].token], [c.coinid, 0, "House", "cancel", false, "0.07", "MINIMA"]);
  assert.equal("plan" in l.rows[0], false, "no plan (it can hold a secret) leaves the main process");
  assert.deepEqual(n.built(), [], "listing builds nothing");
  const before = n.ran.length;
  assert.deepEqual((await S.pass()).done, [], "an open offer is never cancelled by the block pass");
  const r = await S.settle(c.coinid);
  assert.equal(r.ok, true); assert.equal(r.txpowid, "0x" + "1".padStart(64, "0")); assert.ok(r.message.includes(c.coinid) && r.message.includes(r.txpowid), "the ids whole in what is said");
  assert.deepEqual(n.ran.slice(before).filter(p => !/^(block|keys|scripts$|coins)/.test(p)).map(p => p.replace(/cs_[a-z]+_\d+_\d+/, "ID")), [
    "scripts address:" + CONTRACT, 'newscript script:"' + S.SCRIPT + '" trackall:false', "getaddress",
    "txncreate id:ID", "txninput id:ID coinid:" + c.coinid, "txnoutput id:ID amount:0.07 address:" + ADDR1 + " tokenid:0x00 storestate:false",
    "txnsign id:ID publickey:" + K1, "txnbasics id:ID", "txnpost id:ID", "txndelete id:ID"]);
  n.mine(); assert.deepEqual(n.verdicts, [true]);
  assert.deepEqual(n.coinsAt(CONTRACT), []); assert.deepEqual(n.coinsAt(ADDR1).map(x => x.value), ["0.07"]);
  clean(n);
});

test("(a) Cancel all my open offers: every offer of this wallet, MxUSD by its token amount, one transaction each; a stranger's offer untouched", async () => {
  const n = standin(), a = coin(n, 1, "0.07", offer()), b = coin(n, 2, "175", offer({ 0: K2, 3: "36", 4: "36", 5: "5", 2: hx("77") }), { tokenid: MXUSD }), x = coin(n, 3, "9", offer({ 0: XK, 1: XA }));
  use(n);
  const r = await S.cancelAll();
  assert.deepEqual(r.done.map(d => d.coinid).sort(), [a.coinid, b.coinid]); assert.deepEqual(r.failed, []);
  assert.ok(n.built().includes("txnoutput id:ID amount:175 address:" + ADDR1 + " tokenid:" + MXUSD + " storestate:false"), "the token amount, in its own token");
  assert.ok(n.built().includes("txnsign id:ID publickey:" + K2));
  assert.ok(!n.ran.some(p => p.includes(x.coinid)), "the stranger's offer is in no command");
  n.mine(); assert.deepEqual(n.verdicts, [true, true]); assert.deepEqual(n.coinsAt(CONTRACT).map(c => c.coinid), [x.coinid]);
  assert.deepEqual((await S.cancelAll()).done, [], "nothing left to cancel");
  clean(n);
});

test("(b) REVEAL: a taken offer of this wallet whose secret it holds is revealed by the block pass; exactly these commands; said once; not built again each block", async () => {
  const n = standin(), c = coin(n, 1, "0.14", taken()); const u = use(n, houseSecret);
  const r = await S.pass();
  assert.deepEqual(r.done.map(d => [d.action, d.coinid]), [["reveal", c.coinid]]);
  const st = taken();
  assert.deepEqual(n.built(), ["txncreate id:ID", "txninput id:ID coinid:" + c.coinid, "txnoutput id:ID amount:0.14 address:" + CONTRACT + " tokenid:0x00 storestate:true"]
    .concat([0, 1, 2, 3, 4, 5].map(p => "txnstate id:ID port:" + p + " value:" + st[p]), ["txnstate id:ID port:6 value:2"], [7, 8, 9, 10, 11].map(p => "txnstate id:ID port:" + p + " value:" + st[p]),
      ["txnstate id:ID port:12 value:" + HS, "txnsign id:ID publickey:" + K1, "txnbasics id:ID", "txnpost id:ID", "txndelete id:ID"]));
  assert.equal(u.notes.length, 1); assert.ok(u.notes[0].includes(c.coinid), "the notification names the whole coin id");
  assert.match(u.notes[0], /^Sent the reveal of the house secret of a taken offer; not confirmed yet/, "at post time it is SENT, nothing more");
  assert.ok(u.notes[0].includes("id before mining 0x" + "1".padStart(64, "0")), "the id the node gives at post time is the one before mining");
  assert.equal(u.posted()[c.coinid].action, "reveal"); assert.equal(u.posted()[c.coinid].txpowid, "0x" + "1".padStart(64, "0"));
  // the same block and the next ones, not mined yet: nothing is built again
  const k = n.built().length; await S.pass(); n.tip += S.REPOST_AFTER - 1; await S.pass();
  assert.equal(n.built().length, k, "a posted transaction is not rebuilt");
  assert.equal((await S.list()).rows[0].held, true);
  await assert.rejects(S.settle(c.coinid), /was sent at block 5000 .*Nothing more was sent/);
  n.mine(); assert.deepEqual(n.verdicts, [true], "the covenant accepts the reveal");
  const p2 = n.coinsAt(CONTRACT); assert.equal(p2.length, 1); assert.deepEqual([p2[0].st[6], p2[0].st[12], p2[0].value], ["2", HS, "0.14"]);
  await S.list();   // a scan that lists coins at the contract (the revealed bet) and not this one: only now is it said to be spent
  assert.deepEqual([u.posted()[c.coinid].done, u.posted()[c.coinid].tries, u.posted()[c.coinid].sent], [5010, 1, true], "the record is kept, marked done at the block of that scan");
  assert.equal(u.notes.length, 2); assert.ok(u.notes[1].startsWith("Coin " + c.coinid + " is now spent (seen at block 5010), after this app sent the reveal"), u.notes[1]);
  await S.list(); assert.equal(u.notes.length, 2, "said once");
  clean(n);
});

test("(b) a posted reveal that the chain dropped is built again after REPOST_AFTER blocks; a taker's hex or number in ports 8-11 is copied as it is", async () => {
  const n = standin(), c = coin(n, 1, "0.14", taken({ 8: "0xAB", 9: "0x00", 10: "17", 11: "1.0" })); use(n, houseSecret);
  await S.pass(); n.mempool.length = 0; n.tip += S.REPOST_AFTER;   // dropped
  const k = n.built().length; await S.pass();
  assert.equal(n.built().length, 2 * k, "built again");
  assert.ok(n.built().includes("txnstate id:ID port:9 value:0x00") && n.built().includes("txnstate id:ID port:11 value:1.0"));
  n.mine(); assert.deepEqual(n.verdicts, [true]); assert.equal(c.spent, true);
  clean(n);
});

test("(c) RESOLVE: a revealed bet this wallet WON is paid out by the pass: winnings bet x payout to state 9, the rest to the house; a lost one sends nothing", async () => {
  const win = result(HS, PS, 6);
  { // won, pot above the winnings: two outputs, in the covenant's order
    const n = standin(), c = coin(n, 1, "0.5", revealed({ 0: XK, 1: XA, 3: "6", 4: "6", 5: "0.07", 8: K2, 9: ADDR2, 11: String(win) })); const u = use(n, playerSecret);
    const l = await S.list(); assert.deepEqual([l.rows[0].action, l.rows[0].role, l.rows[0].phase], ["resolve", "Player", 2]);
    assert.deepEqual((await S.pass()).done.map(d => d.action), ["resolve"]);
    assert.deepEqual(n.built(), ["txncreate id:ID", "txninput id:ID coinid:" + c.coinid, "txnoutput id:ID amount:0.42 address:" + ADDR2 + " tokenid:0x00 storestate:false",
      "txnoutput id:ID amount:0.08 address:" + XA + " tokenid:0x00 storestate:false", "txnstate id:ID port:13 value:" + PS, "txnsign id:ID publickey:" + K2, "txnbasics id:ID", "txnpost id:ID", "txndelete id:ID"]);
    n.mine(); assert.deepEqual(n.verdicts, [true]); assert.deepEqual(n.coinsAt(ADDR2).map(x => x.value), ["0.42"]); assert.equal(u.notes.length, 1);
    clean(n);
  }
  { // won, the pot is exactly the winnings: one output
    const n = standin(); coin(n, 1, "0.42", revealed({ 0: XK, 1: XA, 3: "6", 4: "6", 8: K1, 9: ADDR1, 11: String(win) })); use(n, playerSecret);
    await S.pass(); assert.equal(n.built().filter(p => p.startsWith("txnoutput")).length, 1); n.mine(); assert.deepEqual(n.verdicts, [true]); clean(n);
  }
  { // lost: nothing is sent, and it is said
    const n = standin(); coin(n, 1, "0.42", revealed({ 0: XK, 1: XA, 3: "6", 4: "6", 8: K1, 9: ADDR1, 11: String((win + 1) % 6) })); use(n, playerSecret);
    assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.deepEqual(n.built(), []);
    assert.match((await S.list()).rows[0].note, /^Lost: the pot goes to the house/); clean(n);
  }
  { // won, but the secret is not on this computer / the winnings address is not this wallet's / the pot is smaller than the winnings
    const n = standin(); const a = coin(n, 1, "0.42", revealed({ 0: XK, 1: XA, 3: "6", 4: "6", 8: K1, 9: XA, 11: String(win) })), b = coin(n, 2, "0.41", revealed({ 0: XK, 1: XA, 3: "6", 4: "6", 8: K1, 9: ADDR1, 11: String(win) })); use(n, playerSecret);
    assert.deepEqual(await S.pass(), { done: [], failed: [] });
    const l = await S.list();
    assert.match(l.rows.find(r => r.coinid === a.coinid).problem, new RegExp("the winnings would go to " + XA + ", which the node does not list")); assert.equal(l.rows.find(r => r.coinid === a.coinid).manualOk, true);
    assert.match(l.rows.find(r => r.coinid === b.coinid).problem, /the pot \(0\.41\) is smaller than the winnings \(0\.42\)/);
    use(n, {}); assert.match((await S.list()).rows[1].problem, /the secret of this bet is not on this computer/);
    assert.deepEqual(n.built(), []); clean(n);
  }
});

test("(d) TIMEOUT claims: phase 1 as the player and phase 2 as the house, only once the coin's age is ABOVE the timeout", async () => {
  const n = standin(), p1 = coin(n, 1, "0.14", taken({ 0: XK, 1: XA, 8: K2, 9: ADDR2 }), { created: 5000 - 1500 }), p2 = coin(n, 2, "0.14", revealed(), { created: 5000 - 1500 }); use(n, {});
  assert.deepEqual(await S.pass(), { done: [], failed: [] }, "age 1500 is not above 1500");
  assert.deepEqual((await S.list()).rows.map(r => [r.blocksLeft, r.leftFor]), [[1, "until this wallet can claim the pot"], [1, "until this wallet can claim the pot"]]);
  n.tip += 1;
  assert.deepEqual((await S.pass()).done.map(d => [d.action, d.coinid]), [["claim", p1.coinid], ["claim", p2.coinid]]);
  assert.deepEqual(n.built().filter(p => /^txn(output|sign|state)/.test(p)), [
    "txnoutput id:ID amount:0.14 address:" + ADDR1 + " tokenid:0x00 storestate:false", "txnsign id:ID publickey:" + K2,
    "txnoutput id:ID amount:0.14 address:" + ADDR1 + " tokenid:0x00 storestate:false", "txnsign id:ID publickey:" + K1]);
  n.mine(); assert.deepEqual(n.verdicts, [true, true]); assert.deepEqual(n.coinsAt(CONTRACT), []);
  clean(n);
});

test("blocks left before the other side can take the pot are shown for a taken offer whose secret is missing, and it is listed as not settled", async () => {
  const n = standin(), c = coin(n, 1, "0.14", taken(), { created: 5000 - 300 }); use(n, {});
  const r = (await S.list()).rows[0];
  assert.deepEqual([r.coinid, r.blocksLeft, r.leftFor, r.action], [c.coinid, 1201, "before the player can take the whole pot", null]);
  assert.match(r.problem, /the secret of this offer is not on this computer/);
  assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.deepEqual(n.built(), []);
  use(n, { ["casino_secret_for_" + HC]: hx("5B") }); assert.match((await S.list()).rows[0].problem, /does not match its commit/); assert.deepEqual(n.built(), []);
});

test("a coin with a ; or an odd value in ANY port, its coin id, token or amount is never turned into a command, and is listed whole", async () => {
  const evil = ["0xAB;send amount:1 address:" + XA, "1500 address:" + XA, '0xAB" address:"' + XA, "[text]", "TRUE", "0xABC", "1e3", "-1", "0xAB\n", "", " 0x" + "AB".repeat(32)];
  const kinds = { reveal: [() => taken(), houseSecret, "0.14"], resolve: [() => revealed({ 0: XK, 1: XA, 8: K1, 9: ADDR1, 11: String(result(HS, PS, 2)) }), playerSecret, "0.14"], claim: [() => taken({ 0: XK, 8: K1 }), {}, "0.14"], cancel: [() => offer(), {}, "0.07"] };
  // the ports each action reads: an odd value there and NOTHING is built (not even txncreate); in any other port the value is never read,
  // the action goes through and the covenant accepts it
  // (0.18.336: the contract itself reads states 0-7 before anything else, and 8 and 11 of a taken bet: an odd value there fails every spend)
  const reads = { reveal: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], resolve: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], claim: [0, 1, 2, 3, 4, 5, 6, 7, 8, 11], cancel: [0, 1, 2, 3, 4, 5, 6, 7] };
  let listed = 0;
  for (const [kind, [mk, secrets, value]] of Object.entries(kinds)) for (let port = 0; port <= 13; port++) for (const v of evil) {
    const n = standin(), c = coin(n, 1, value, Object.assign(mk(), { [port]: v }), kind === "claim" ? { created: 1 } : {}); use(n, secrets);
    await S.pass(); await S.cancelAll().catch(() => {}); await S.settle(c.coinid).catch(() => {});
    const l = await S.list();
    for (const p of n.built()) assert.ok(!p.includes(v) || v === "", kind + " port " + port + ": the value " + JSON.stringify(v) + " reached " + p);
    assert.ok(!n.ran.some(p => /^send/.test(p)), "a second command ran"); clean(n);
    if (l.rows.length && l.rows[0].problem) { assert.equal(l.rows[0].coinid, c.coinid); listed++; }
    const where = kind + " port " + port + " " + JSON.stringify(v);
    if (reads[kind].includes(port)) assert.deepEqual(n.built(), [], where + ": nothing is built");
    else assert.equal(n.built().filter(p => p === "txnpost id:ID").length, 1, where + ": a port the action does not read does not stop it");
    n.mine(); assert.ok(n.verdicts.every(Boolean), where + ": whatever was posted is valid under the covenant");
  }
  assert.ok(listed > 150, "the odd coins of this wallet are listed as not settled, with their whole coin id (" + listed + ")");
  // the coin itself
  for (const bad of [{ coinid: "0xC1;send amount:1 address:" + XA }, { tokenid: "0x00 tokenid:" + MXUSD }, { value: "0.14 amount:99" }, { created: "12;quit" }]) {
    const n = standin(); coin(n, 1, "0.14", taken(), bad); use(n, houseSecret);
    await S.pass(); assert.deepEqual(n.built(), []); clean(n);
    const row = (await S.list()).rows[0]; assert.ok(row.problem, JSON.stringify(bad)); if (bad.coinid) assert.equal(row.coinid, bad.coinid, "listed with the coin id as the node gave it, whole");
  }
  // a state that is not a list of single ports
  { const n = standin(), c = coin(n, 1, "0.14", taken()); use(n, houseSecret); const run = n.run; S._setRunner(async (t) => { const r = await run(t); if (/^coins/.test(t)) r.response[0].state.push({ port: 2, type: 1, data: HC }); return r; }); await S.pass(); assert.deepEqual(n.built(), [], "a port given twice"); assert.ok(c); }
});

test("the module sends only its own command shapes: anything else, a ; chain or a control character is refused before the node", async () => {
  const n = standin(); use(n);
  for (const c of ["send amount:1 address:" + XA, "txnpost id:cs_cancel_1_1;send amount:1 address:" + XA, "txnsign id:cs_cancel_1_1 publickey:auto", "txnstate id:cs_reveal_1_1 port:12 value:[x]", "txnstate id:cs_reveal_1_1 port:14 value:1",
    "txnoutput id:cs_cancel_1_1 amount:1 address:" + ADDR1 + " tokenid:0x00 storestate:false address:" + XA, "coins address:" + XA + " depth:4096", "txncreate id:x", "keys action:genkey", "block\n", "vault"]) {
    await assert.rejects(S._run(c), (e) => e.notSent === true, c);
  }
  assert.deepEqual(n.texts, [], "nothing reached the node");
  assert.equal((await S._run("block")).status, true);
});

test("a FORGED phase-1 coin never makes the wallet show the secret of an offer that is still open", async () => {
  const leaked = (n) => n.texts.some(t => t.includes(HS.slice(2)));
  { // dust forgery (not bet x payout): nothing at all is built, by the pass
    const n = standin(), o = coin(n, 1, "0.07", offer()), f = coin(n, 2, "0.000001", taken()); use(n, houseSecret);
    assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.deepEqual(n.built(), []); assert.equal(leaked(n), false);
    const row = (await S.list()).rows.find(r => r.coinid === f.coinid); assert.match(row.problem, /the pot is not bet x payout/); assert.equal(row.manualOk, true);
    // the user's own click on it: the open offer is cancelled, the secret still not shown
    const r = await S.settle(f.coinid); assert.deepEqual([r.action, r.coinid], ["cancel", o.coinid]); assert.equal(leaked(n), false);
    clean(n);
  }
  { // a forgery that paid the whole pot: the OPEN OFFER is cancelled first; the secret is shown only once that offer is spent
    const n = standin(), o = coin(n, 1, "0.07", offer()), f = coin(n, 2, "0.14", taken()); use(n, houseSecret);
    const r = await S.pass();
    assert.deepEqual(r.done.map(d => [d.action, d.coinid]), [["cancel", o.coinid]]); assert.equal(leaked(n), false, "no reveal while the offer is on chain");
    assert.ok(!n.built().some(p => p.includes("port:12")));
    await S.pass(); n.tip += 3; await S.pass(); assert.equal(leaked(n), false, "still unmined: still no reveal");
    n.mine(); assert.equal(o.spent, true, "the offer is back in the wallet");
    assert.deepEqual((await S.pass()).done.map(d => [d.action, d.coinid]), [["reveal", f.coinid]]);   // nothing left to protect: the forger's own stake is now a fair bet
    assert.equal(leaked(n), true); clean(n);
  }
  { // the forgery names ANOTHER key of this wallet, and the node's key list comes back short (without the offer's key): still no reveal
    const n = standin({ shortKeys: [K2] }), o = coin(n, 1, "0.07", offer({ 0: K1 })), f = coin(n, 2, "0.14", taken({ 0: K2 })); use(n, houseSecret);
    const r = await S.pass();
    assert.equal(leaked(n), false); assert.deepEqual(r.done.map(d => [d.action, d.coinid]), [["cancel", o.coinid]]);
    assert.ok(n.ran.includes("keys publickey:" + K1), "the offer's key is asked for by itself");
    assert.ok(f); clean(n);
  }
  { // the same, and the node cannot say whose the offer's key is: nothing is revealed, and it is listed
    const n = standin({ shortKeys: [K2] }), o = coin(n, 1, "0.07", offer({ 0: K1 })), f = coin(n, 2, "0.14", taken({ 0: K2 })); use(n, houseSecret);
    const run = n.run; S._setRunner(async (t) => /^keys publickey/.test(t) ? { status: false } : run(t));
    assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.equal(leaked(n), false);
    assert.match((await S.list()).rows.find(r => r.coinid === f.coinid).problem, new RegExp("coin " + o.coinid + "\\) and the node could not say"));
  }
  { // a stranger's phase-0 coin that merely copies the commit is not this wallet's offer: it does not block a real reveal
    const n = standin(), x = coin(n, 1, "0.07", offer({ 0: XK, 1: XA })), c = coin(n, 2, "0.14", taken()); use(n, houseSecret);
    assert.deepEqual((await S.pass()).done.map(d => [d.action, d.coinid]), [["reveal", c.coinid]]); assert.ok(!n.ran.some(p => p.includes(x.coinid)));
  }
});

test("nothing is done for coins that are not this wallet's, in any phase, expired or not", async () => {
  const n = standin(); use(n, Object.assign({}, houseSecret, playerSecret));
  const mine = (o) => Object.assign(o, { 0: XK, 1: XA, 8: XK, 9: XA });
  const ids = [coin(n, 1, "0.07", mine(offer())), coin(n, 2, "0.14", mine(taken())), coin(n, 3, "0.14", mine(revealed())), coin(n, 4, "0.14", mine(taken()), { created: 1 }), coin(n, 5, "0.14", mine(revealed()), { created: 1 }),
    coin(n, 6, "0.14", mine(taken({ 1: ADDR1, 9: ADDR1 })))].map(c => c.coinid);   // this wallet's ADDRESS in the state is not ownership: only a key signs
  assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.deepEqual(await S.cancelAll(), { done: [], failed: [] });
  for (const id of ids) await assert.rejects(S.settle(id), /The node does not list a key of that coin as this wallet's\. Nothing was sent\./);
  await assert.rejects(S.settle(cid(99)), /no longer at the contract/); await assert.rejects(S.settle("0xC1;send"), /not a coin id/);
  assert.deepEqual((await S.list()).rows, []); assert.deepEqual(n.built(), []); clean(n);
});

test("every error path runs txndelete; a refused post is forgotten, an unanswered one stays recorded as sent", async () => {
  for (const verb of ["txninput", "txnoutput", "txnsign", "txnbasics"]) {
    const n = standin(), c = coin(n, 1, "0.07", offer()); const u = use(n); n.fail[verb] = { status: false, error: "busy" };
    await assert.rejects(S.settle(c.coinid), new RegExp(verb + " failed \\(busy\\)\\. Nothing was sent\\."));
    assert.equal(n.built().at(-1), "txndelete id:ID", verb); assert.ok(!n.built().includes("txnpost id:ID")); assert.equal(n.txns.size, 0);
    // a signature the node made stays counted (txnbasics failed after it); one it refused, or never asked for, is not
    if (verb === "txnbasics") assert.deepEqual([u.posted()[c.coinid].tries, u.posted()[c.coinid].sent], [1, false]); else assert.deepEqual(u.posted(), {}, verb);
  }
  { const n = standin(), c = coin(n, 1, "0.07", offer()); const u = use(n); n.fail.txnpost = { status: false, error: "Coin already in mempool" };
    await assert.rejects(S.settle(c.coinid), /the node refused the transaction \(Coin already in mempool\)\. Nothing was sent\./);
    assert.equal(n.built().at(-1), "txndelete id:ID"); assert.deepEqual([u.posted()[c.coinid].tries, u.posted()[c.coinid].sent], [1, false], "its signature stays counted; it is not 'sent'");
    delete n.fail.txnpost; assert.equal((await S.list()).rows[0].held, false); assert.equal((await S.settle(c.coinid)).ok, true, "a refused post may be tried again at once"); assert.equal(u.posted()[c.coinid].tries, 2); }
  { const n = standin(), c = coin(n, 1, "0.07", offer()); const u = use(n); n.fail.txnpost = "throw";
    const r = await S.settle(c.coinid); assert.deepEqual([r.ok, r.unknown, r.coinid], [true, true, c.coinid]); assert.match(r.message, /may or may not have gone through/);
    assert.equal(n.built().at(-1), "txndelete id:ID"); assert.equal(u.posted()[c.coinid].action, "cancel", "kept: it is not built again while it may be in the mempool");
    delete n.fail.txnpost; const k = n.built().length; await assert.rejects(S.settle(c.coinid), /Nothing more was sent/); assert.equal(n.built().length, k); }
  { // the contract's script row is gone and cannot be registered: nothing is built
    const n = standin({ script: false }), c = coin(n, 1, "0.07", offer()); use(n); n.fail.newscript = { status: false };
    await assert.rejects(S.settle(c.coinid), /could not be registered on the node, so nothing was built/); assert.deepEqual(n.built(), []); }
  { // the node gives an address it does not list as its own: nothing is built
    const n = standin(), c = coin(n, 1, "0.07", offer()); use(n); n.fail.getaddress = { status: true, response: { address: XA } };
    await assert.rejects(S.settle(c.coinid), /no address it lists as this wallet's own/); assert.deepEqual(n.built(), []); }
});

test("a node that cannot be read: nothing is done, and the list says so", async () => {
  for (const verb of ["block", "keys", "scripts", "coins"]) {
    const n = standin(); coin(n, 1, "0.14", taken()); use(n, houseSecret); n.fail[verb] = { status: false };
    await assert.rejects(S.pass(), /Nothing was done/); const l = await S.list(); assert.equal(l.ok, false); assert.match(l.error, /Nothing was done/); assert.deepEqual(n.built(), []);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 0.18.336 (review of 0.18.330, CRITICAL 2): anyone can write ANY coin at the contract, with this wallet's public key in it. Nothing
// is signed that the contract would refuse, and automatic signing is bounded: per coin, per pass and per day.
const claimable = (o = {}) => taken(Object.assign({ 0: XK, 1: XA, 7: "0", 8: K1, 9: ADDR1 }, o));   // "the timeout has passed: this wallet can take the pot"
const without = (st, port) => { const o = Object.assign({}, st); delete o[port]; return o; };

test("a forged coin the contract never lets this wallet spend is never signed for: a missing state, a key that is not hex, one key on both sides, a token of its own", async () => {
  const cases = [];
  for (const port of [1, 2, 3, 4, 5]) cases.push(["claim-looking, state " + port + " missing", (n) => coin(n, 1, "5", without(claimable(), port)), new RegExp("state " + port + " is missing or is not 0x hex or a plain number: the contract cannot read it and refuses every spend")]);
  cases.push(["claim-looking, state 11 missing", (n) => coin(n, 1, "5", without(claimable(), 11)), /state 11 is missing/]);
  cases.push(["claim-looking, state 0 a number", (n) => coin(n, 1, "5", claimable({ 0: "5" })), /state 0 is not 0x hex: the contract's signature check throws/]);
  cases.push(["a revealed bet past its timeout, state 8 a number", (n) => coin(n, 1, "5", revealed({ 8: "7" }), { created: 1 }), /state 8 is not 0x hex/]);
  cases.push(["claim-looking, the same key in states 0 and 8", (n) => coin(n, 1, "5", claimable({ 0: K1 })), /states 0 and 8 hold the same key/]);
  cases.push(["an open offer with state 3 missing (the button)", (n) => coin(n, 1, "5", without(offer(), 3)), /state 3 is missing/]);
  cases.push(["an open offer with state 7 missing (the button)", (n) => coin(n, 1, "5", without(offer(), 7)), /state 7 \(the timeout\) is not a plain number|state 7 is missing/]);
  for (const [name, make, why] of cases) {
    const n = standin(), c = make(n); use(n, houseSecret);
    await S.pass(); await S.cancelAll(); await S.settle(c.coinid).catch(() => {});
    assert.equal(signs(n), 0, name + ": nothing is signed"); assert.deepEqual(n.built(), [], name + ": nothing is built");
    const row = (await S.list()).rows.find(r => r.coinid === c.coinid); assert.ok(row, name + ": listed"); assert.match(row.problem, why, name); assert.equal(row.manualOk, false, name);
    await assert.rejects(S.settle(c.coinid), /This coin cannot be settled here: .*Nothing was sent\./, name);
    // and the stand-in's contract does refuse it, whoever signs: the check is not stricter than the chain
    for (const key of [K1, K2]) assert.equal(covenant(c, { inputs: [c.coinid], outputs: [{ amount: c.value, address: ADDR1, tokenid: c.tokenid, storestate: false }], state: {}, signed: [up(key)] }, 99999), false, name + ": the contract refuses it");
  }
  { // a token of its own (its script may answer FALSE): never by itself; the user's click may try
    const n = standin(), c = coin(n, 1, "5", claimable(), { tokenid: hx("77"), tokenScriptFalse: true }); use(n);
    assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.equal(signs(n), 0);
    const row = (await S.list()).rows[0]; assert.match(row.problem, /its token is not MINIMA or MxUSD: nothing is signed for it automatically/); assert.equal(row.manualOk, true);
  }
  { // MxUSD is worked on by itself, as MINIMA is
    const n = standin(), c = coin(n, 1, "5", claimable(), { tokenid: MXUSD }); use(n);
    assert.deepEqual((await S.pass()).done.map(d => [d.action, d.coinid]), [["claim", c.coinid]]); n.mine(); assert.deepEqual(n.verdicts, [true]);
  }
});

test("600 forged claimable-looking coins the contract will not pay cost NO signature, and a real, older taken offer is revealed in the first pass", async () => {
  const n = standin(), real = coin(n, 1, "0.14", taken(), { created: 5000 - 100 });
  for (let i = 0; i < 600; i++) coin(n, 1000 + i, "0.000001", without(claimable(), 3), { created: 5000 - 1 });   // newer: the node lists them first
  use(n, houseSecret);
  const first = await S.pass();
  assert.deepEqual(first.done.map(d => [d.action, d.coinid]), [["reveal", real.coinid]], "the real offer, in the first pass");
  for (let b = 0; b < 31; b++) { n.mine(); await S.pass(); }
  assert.equal(signs(n), 1, "one signature in 32 passes: the reveal");
  assert.deepEqual(n.verdicts, [true]); assert.equal(real.spent, true);
  assert.equal(n.coinsAt(CONTRACT).filter(c => c.st[6] === "2" && c.st[12] === HS).length, 1, "the bet is revealed on chain");
  clean(n);
});

test("600 forged coins that ARE claimable: at most 4 signatures a pass, 12 claims a day, largest first; the real taken offer is revealed first", async () => {
  const n = standin(), real = coin(n, 1, "0.14", taken(), { created: 5000 - 100 });
  for (let i = 0; i < 600; i++) coin(n, 1000 + i, "0.000001", claimable(), { created: 5000 - 1 });
  const big = coin(n, 5000, "3", claimable(), { created: 5000 - 2 });
  use(n, houseSecret);
  const first = await S.pass();
  assert.equal(signs(n), PER_PASS, "no more than " + PER_PASS + " in one pass");
  assert.deepEqual(first.done.slice(0, 2).map(d => [d.action, d.coinid]), [["reveal", real.coinid], ["claim", big.coinid]], "the reveal before every claim, then the largest claim");
  for (let b = 0; b < 60; b++) { n.mine(); await S.pass(); }
  assert.equal(signs(n), 1 + CLAIMS_DAY - 1, "claims stop when the day's count reaches " + CLAIMS_DAY + ": the rest of the day's " + PER_DAY + " is kept for reveals and payouts");
  assert.ok(n.verdicts.every(Boolean), "everything signed was valid"); assert.equal(real.spent, true);
  const l = await S.list(); assert.deepEqual([l.auto.perCoin, l.auto.perPass, l.auto.perDay, l.auto.usedToday, l.auto.reached], [TRIES, PER_PASS, PER_DAY, CLAIMS_DAY, false]);
  // a taken offer that turns up later the same day still gets its signature
  const late = coin(n, 2, "0.14", taken(), { created: n.tip - 3 });
  assert.deepEqual((await S.pass()).done.map(d => [d.action, d.coinid]), [["reveal", late.coinid]]);
  n.clock += 86400000; await S.pass(); assert.equal(signs(n), CLAIMS_DAY + 1 + PER_PASS, "a day later the claims go on");
  clean(n);
});

test("the day's limit: 24 automatic signatures in 24 hours, then none until the oldest is a day old; the list says the limit is reached", async () => {
  const n = standin(); for (let i = 0; i < 40; i++) coin(n, 100 + i, "0.000002", taken({ 5: "0.000001" }), { created: 5000 - 3 });   // 40 forged, VALID reveals of one old commit
  use(n, houseSecret);
  for (let b = 0; b < 12; b++) { await S.pass(); n.mine(); }
  assert.equal(signs(n), PER_DAY); assert.ok(n.verdicts.every(Boolean));
  const l = await S.list(); assert.deepEqual([l.auto.usedToday, l.auto.reached], [PER_DAY, true]);
  assert.match(fs.readFileSync(path.resolve(__dirname, "../renderer/app.js"), "utf8"), /The automatic limit is reached<\/div>\s*<div class="view__desc">This app signed \$\{esc\(r\.auto\.usedToday\)\} P2P Chance transactions by itself in the last 24 hours/, "and the dialog says so");
  // the user's own click is not held by the limit, and is not counted in it
  const open = l.rows.find(r => r.action === "reveal" && !r.held); assert.equal((await S.settle(open.coinid)).ok, true); assert.equal(signs(n), PER_DAY + 1); assert.equal((await S.list()).auto.usedToday, PER_DAY);
  n.clock += 86400000 - 1; await S.pass(); assert.equal(signs(n), PER_DAY + 1, "one millisecond short of a day: still none");
  n.clock += 1; await S.pass(); assert.equal(signs(n), PER_DAY + 1 + PER_PASS);
});

test("many small forged bets with short timeouts do not keep a large real one waiting: nearest deadline and largest amount take turns", async () => {
  const n = standin(), real = coin(n, 1, "0.14", taken(), { created: 5000 - 100 });
  for (let i = 0; i < 60; i++) coin(n, 100 + i, "0.000002", taken({ 5: "0.000001", 7: "20" }), { created: 5000 - 5 });
  use(n, houseSecret);
  const r = await S.pass();
  assert.equal(r.done.length, PER_PASS); assert.equal(r.done[1].coinid, real.coinid, "the second signature of the pass goes to the largest amount");
  assert.ok(r.done.filter(d => d.coinid !== real.coinid).every(d => d.action === "reveal"));
});

test("a transaction the chain keeps dropping is signed 3 times for one coin, never a 4th by itself; the coin is then listed, and the button still works", async () => {
  const n = standin({ dropAll: true }), c = coin(n, 1, "0.14", taken()); const u = use(n, houseSecret);
  for (let b = 0; b < 8; b++) { await S.pass(); n.mine(S.REPOST_AFTER); }
  assert.equal(signs(n), TRIES); assert.equal(u.posted()[c.coinid].tries, TRIES);
  const row = (await S.list()).rows[0];
  assert.match(row.problem, /^this app signed 3 transactions for it \(the last at block 5020\) and it is still at the contract: it is not signed for automatically any more$/); assert.equal(row.manualOk, true);
  assert.equal((await S.settle(c.coinid)).ok, true, "the user's click"); assert.equal(signs(n), TRIES + 1); assert.equal(u.posted()[c.coinid].tries, TRIES + 1);
  n.mine(S.REPOST_AFTER); assert.deepEqual(await S.pass(), { done: [], failed: [] }, "and the pass does not take it up again"); assert.equal(signs(n), TRIES + 1);
});

test("an empty or failed scan drops nothing: a node that is syncing answers [], and the sent record, its hold and its count stay", async () => {
  const n = standin(), c = coin(n, 1, "0.14", taken()); const u = use(n, houseSecret);
  await S.pass(); assert.equal(signs(n), 1); const rec = JSON.stringify(u.posted()[c.coinid]);
  n.syncing = true;
  assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.deepEqual((await S.list()).rows, []);
  assert.equal(JSON.stringify(u.posted()[c.coinid]), rec, "the record is untouched by an empty answer"); assert.equal(u.notes.length, 1, "and nothing is said to be spent");
  n.syncing = false; n.fail.coins = { status: false }; await assert.rejects(S.pass(), /Nothing was done/); delete n.fail.coins;
  assert.equal(JSON.stringify(u.posted()[c.coinid]), rec);
  await S.pass(); n.tip += 3; await S.pass();
  assert.equal(signs(n), 1, "the coin is back in the list and still held: not signed again");
  assert.equal((await S.list()).rows[0].held, true);
  // a wallet's ONLY coin, spent: the node then lists nothing at the contract, which is also what a syncing node shows. It stays "sent".
  const m = standin(), o = coin(m, 1, "0.07", offer()); const w = use(m);
  await S.settle(o.coinid); m.mine(); assert.deepEqual(m.verdicts, [true]); await S.list();
  assert.deepEqual([w.posted()[o.coinid].sent, w.posted()[o.coinid].done], [true, 0]); assert.equal(w.notes.length, 0);
  coin(m, 2, "9", offer({ 0: XK, 1: XA })); await S.list();   // any coin listed at the contract, and not this one: now it is known
  assert.equal(w.posted()[o.coinid].done, m.tip); assert.equal(w.notes.length, 1); assert.match(w.notes[0], /^Coin 0x[0-9A-F]{64} is now spent \(seen at block 5001\), after this app sent the cancel of an open offer for it at block 5000\.$/);
});

test("an amount the node gave as a JSON number (it has been through a double) is not used; the bounds are the stated ones", async () => {
  const n = standin(), c = coin(n, 1, "0.14", taken()); use(n, houseSecret);
  const run = n.run; S._setRunner(async (t) => { const r = await run(t); if (/^coins/.test(t)) for (const x of r.response) x.amount = Number(x.amount); return r; });
  assert.deepEqual(await S.pass(), { done: [], failed: [] }); assert.equal(signs(n), 0);
  assert.match((await S.list()).rows[0].problem, /its token, amount or creation block cannot be read/); assert.ok(c);
  assert.deepEqual([S.AUTO_TRIES, S.AUTO_PER_PASS, S.AUTO_PER_DAY, S.CLAIMS_PER_DAY], [TRIES, PER_PASS, PER_DAY, CLAIMS_DAY]);
});

test("the window: one dialog from the notice and from Settings, ids copyable, Cancel offer / Settle now / Cancel all; no bet, offer or take channel", () => {
  const D0 = path.resolve(__dirname, ".."), rd = (f) => fs.readFileSync(path.join(D0, f), "utf8");
  const main = rd("main/main.js"), pre = rd("main/preload.js"), app = rd("renderer/app.js");
  assert.deepEqual([...main.matchAll(/"mcd:casino\w*"/g)].map(m => m[0]).sort(), ['"mcd:casinoNotice"', '"mcd:casinoNoticeSeen"', '"mcd:casinoSettle"', '"mcd:casinoSettleCancelAll"', '"mcd:casinoSettleList"', '"mcd:casinoSettleOne"']);
  assert.deepEqual([...pre.matchAll(/\b(\w*[cC]asino\w*):/g)].map(m => m[1]).sort(), ["casinoNotice", "casinoNoticeSeen", "casinoSettleCancelAll", "casinoSettleList", "casinoSettleOne", "onCasinoSettle"]);
  assert.match(app, /id="setCasinoSettle">Show my open offers and bets</); assert.match(app, /P2P Chance was removed: your open offers and bets/);
  assert.match(app, /id="cnOpen">Show my open offers and bets</, "reachable from the notice");
  assert.match(app, /\$\{idHtml\(n\.contract\)\}/); assert.match(app, /\$\{idHtml\(n\.command\)\}/); assert.match(app, /\$\{idHtml\(x\.coinid\)\}/);
  for (const label of ["Cancel offer", "Settle now", "Cancel all my open offers"]) assert.ok(app.includes(">" + label + "<"), label);
  assert.doesNotMatch(main, /showMessageBox\([^)]*casino/i, "the notice is no longer a native message box (its text could not be copied)");
  assert.ok(main.includes("const c = config.load(); if (c.casinoEnabled || c.casinoAgeCertified) casinoSettle.startLoop();"), "the block pass runs only for a wallet that used P2P Chance");
  assert.equal(main.split("casinoSettle.startLoop()").length - 1, 1);
  const src = rd("main/casino-settle.js");
  assert.doesNotMatch(src, /\bsend amount|"random"|txnsign[^\n]*publickey:auto|casino_secret_for_"\s*\+[^\n]*setSecret/, "no offer, no take, no new secret");
});
