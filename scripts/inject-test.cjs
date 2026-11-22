/*
 * inject-test.cjs — a command the app builds is ONE command (0.18.177). The node splits a text on every ";", even inside
 * quotes and JSON, so a ";" carried in by a pasted seed, a peer's media ref or a coin's state on the chain started a
 * second command. Stand-in runners record what would have been sent; nothing reaches a node.
 * Run: node --test scripts/inject-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "inject-"));
const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === "electron") return { app: { getPath: () => DIR, getVersion: () => "t" } };
  const from = parent && parent.filename || "";
  if (/[\\/]main[\\/](chat|mail|shop)\.js$/.test(from) && request === "./config") return { rpcSecret: () => "", load: () => ({}), getSecret: () => null, setSecret: () => {}, deleteSecret: () => {} };
  if (/[\\/]main[\\/](chat|mail|shop)\.js$/.test(from) && request === "./node-manager") return { rpcPort: () => 0, log: () => {}, on: () => {} };
  return realLoad.apply(this, arguments);
};
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("rpc.oneCommand refuses a ';' anywhere", () => {
  const { oneCommand } = require("../main/rpc");
  assert.equal(oneCommand("balance"), "balance");
  for (const c of ["a;b", 'keys action:genkey phrase:"a b;vault action:passwordlock password:x"', 'runscript prevstate:{"1":"x;send amount:1 address:Mx"}']) assert.throws(() => oneCommand(c), /second command\. Nothing was sent/);
});

test("Web Wallet: a pasted 'seed' holding ';' never reaches the node", async () => {
  const ww = require("../main/webwallet"), sent = [];
  ww._setRunner(async (c) => { sent.push(c); return { status: true, response: { megammr: true } }; });
  assert.equal(ww._validators.isPhrase("apple banana;vault action:passwordlock password:x"), false);
  assert.equal(ww._validators.isPhrase("apple banana cherry"), true, "any other phrase (anyphrase) still passes");
  await assert.rejects(ww.derive("apple banana;vault action:passwordlock password:x"), /seed phrase/);
  assert.ok(!sent.some(c => c.includes(";")), JSON.stringify(sent));
});

test("Vestr: a contract coin whose state holds ';' (anyone can make one naming this wallet) never puts a second command on the wire", async () => {
  const vestr = require("../main/vestr"), sent = [];
  vestr._setRunner(async (c) => {
    sent.push(c);
    if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
    if (c.startsWith("block")) return { status: true, response: { block: 100 } };
    if (c.startsWith("coins")) return { status: true, response: [{ coinid: "0x01", tokenid: "0x00", amount: "5", created: 1,
      state: [{ port: 199, data: "0x01" }, { port: 1, data: "10;send amount:5 address:MxATTACKER" }, { port: 2, data: "1" }, { port: 3, data: "200" }] }] };
    return { status: true, response: { variables: {} } };
  });
  await vestr.list();
  assert.ok(sent.some(c => c.startsWith("coins")), "the list was read");
  assert.ok(!sent.some(c => c.includes(";")), "no command with ';' was sent: " + JSON.stringify(sent.filter(c => c.includes(";"))));
});

test("Chat: a peer's media ref with ';', ':' or quotes is refused; every chat command is one command", async () => {
  const chat = require("../main/chat"), sent = [];
  chat._setRunner(async (c) => { sent.push(c); return { status: true, response: {} }; });
  for (const ref of ["keets://ab;vault action:wipekeys", 'keets://ab"x', "keets://ab cd", "keets://ab:9", "http://x"]) await assert.rejects(chat.fetchMedia(ref), /bad media ref/, ref);
  await assert.rejects(chat.requestPayAddr("0x" + "AB".repeat(32) + ";vault"), /second command/);
  assert.deepEqual(sent, []);
});

test("Mail and miniMall send every command through oneCommand", () => {
  for (const f of ["main/mail.js", "main/shop.js"]) assert.ok(/async function nodeCmd\(cmd\) \{ return runner\(oneCommand\(cmd\)\); \}/.test(rd(f)), f);
  assert.ok(/const r = await runner\(oneCommand\(cmd\)\);/.test(rd("main/chat.js")));
});

// ---- 0.18.180: the Web Wallet's log line names the token id and the addresses whole ----
test("Web Wallet: a sent payment is logged with its whole token id and addresses", async () => {
  const ww = require("../main/webwallet");
  const FROM = "0x" + "AA".repeat(32), TO = "0x" + "DD".repeat(32), PK = "0x" + "BB".repeat(32), MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("vault") ? { status: true, response: { phrase: "the node's own" } }
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : c.startsWith("sendfrom") ? { status: true, response: { txpowid: "0x01" } } : { status: true, response: {} });
  ww.setOnchain(async () => 0); await ww.derive("alpha beta"); await ww.ackKeyuses(FROM, 0); ww.setOnchain(async () => null);   // a first confirmation is checked against the chain (0.18.263)
  const r = await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: MXUSD });
  assert.equal(r.ok, true);
  const line = ww.status().log.slice(-1)[0];
  assert.ok(line.includes("token " + MXUSD) && line.includes("from " + FROM) && line.includes("to " + TO), line);
});

// ---- 0.18.188: a plain reason before anything is sent; file paths quoted ----
test("a chat file path or a Vestr password with ';' is refused with a plain reason; keets file paths are quoted", async () => {
  const chat = require("../main/chat"), vestr = require("../main/vestr"), sent = [];
  chat._setRunner(async (c) => { sent.push(c); return { status: true, response: { url: "keets://" + "ab".repeat(32) + "/chat/img-1.png" } }; });
  const TO = "0x" + "AB".repeat(32);
  await assert.rejects(chat.sendImageFile(TO, "/Users/me/Pictures/cat;vault action:wipekeys.png"), /holds a ; or a " , which a node command cannot carry\. Rename the file or move it/);
  await assert.rejects(chat.sendImageFile(TO, '/Users/me/a"b.png'), /cannot carry/);
  assert.deepEqual(sent, []);
  await chat.sendImageFile(TO, "/Users/me/My Pictures/cat.PNG").catch(() => {});
  assert.match(sent[0], /^keets action:publish path:\/chat\/img-\d+\.png file:"\/Users\/me\/My Pictures\/cat\.PNG"$/, "the path quoted, spaces and all; the extension checked");
  await assert.rejects(vestr.create({ tokenid: "0x00", amount: "1", beneficiary: "Mx" + "A".repeat(50), startMs: 1, endMs: 2, password: "pa;ss" }), /can't contain ; \(the node would read what follows as a second command\)/);
  const src = rd("main/chat.js");
  assert.ok(src.includes("' file:" + String.fromCharCode(34) + "' + f + '" + String.fromCharCode(34) + "'"), "fetch quotes its file path too");
});

// ---- 0.18.203: the Web Wallet's key-use counters are read strictly ----
test("Web Wallet counters: only a missing file is a fresh start; a damaged or unreadable one refuses and is left as it is; ack takes a whole number only; one read per send", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), A = "0x" + "A1".repeat(32);
  try { fs.rmSync(file, { force: true }); } catch (e) {}
  assert.deepEqual(ww.keyusesInfo(A), { address: A, keyuses: 0, ack: false }, "no file yet: a fresh start");
  for (const bad of ["1e309", "Infinity", "-1", "1.5", "", null, -1, 1.5, Infinity, NaN, "12abc"]) await assert.rejects(ww.ackKeyuses(A, bad), /whole number of at least 0/, String(bad));   // async since 0.18.262
  const PKA = "0x" + "BB".repeat(32);   // a first confirmation is checked against the chain's figure for the key main derived (0.18.263)
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } } : c.startsWith("keys action:genkey") ? { status: true, response: { address: A, script: "RETURN SIGNEDBY(" + PKA + ")", privatekey: "0x" + "CC".repeat(32), publickey: PKA } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta"); ww.setOnchain(async () => 7);
  assert.equal((await ww.ackKeyuses(A, "7")).keyuses, 7); ww.setOnchain(async () => null); assert.equal((await ww.ackKeyuses(A, 3)).keyuses, 7, "never lowered (an acknowledged entry needs no chain read)");
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => ww.keyusesInfo(A), /are damaged\. Nothing was signed/); await assert.rejects(ww.ackKeyuses(A, 9), /damaged/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "a damaged file is never overwritten");
  // CHANGED on purpose (0.18.215): one damaged entry refuses only that address, as unknown (must be confirmed again)
  for (const bad of [-3, null]) { fs.writeFileSync(file, JSON.stringify({ [A]: { keyuses: bad, ack: true } })); assert.deepEqual(ww.keyusesInfo(A), { address: A, keyuses: 0, ack: false, damaged: true }, String(bad)); }
  fs.rmSync(file); fs.mkdirSync(file); assert.throws(() => ww.keyusesInfo(A), /cannot be read/); fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, good);
  // one read per send: the acknowledgement and the reservation come from the same read
  const FROM = A, TO = "0x" + "DD".repeat(32), PK = "0x" + "BB".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("vault") ? { status: true, response: { phrase: "the node's own" } }
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : c.startsWith("sendfrom") ? { status: true, response: { txpowid: "0x01" } } : { status: true, response: {} });
  let reads = 0; const real = fs.readFileSync; fs.readFileSync = function (p) { if (String(p) === file) reads++; return real.apply(this, arguments); };
  try { const r = await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }); assert.equal(r.keyuse, 7); } finally { fs.readFileSync = real; }
  assert.equal(reads, 1, "one read of the counters per send");
  assert.equal(ww.keyusesInfo(A).keyuses, 8, "reserved before signing");
});

// ---- 0.18.204: "is this the node's own wallet?" never answers no on a failed read ----
test("Web Wallet: a failed key list or a locked vault refuses the send instead of taking the foreign path", async () => {
  const ww = require("../main/webwallet"), FROM = "0x" + "A2".repeat(32), TO = "0x" + "DD".repeat(32), PK = "0x" + "B2".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } } : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta").catch(() => {}); ww.setOnchain(async () => 0); await ww.ackKeyuses(FROM, 0); ww.setOnchain(async () => null);   // checked against the chain (0.18.263)
  const rig2 = (keys, vault) => { const sent = []; ww._setRunner(async (c) => { sent.push(c.split(" ")[0] + " " + (c.split(" ")[1] || ""));
    return c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? keys() : c.startsWith("vault") ? vault()
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : { status: true, response: { txpowid: "0x01" } }; }); return sent; };
  for (const [keys, vault, what] of [[() => { throw new Error("timeout"); }, () => ({ status: true, response: { phrase: "x" } }), "the key list did not answer"],
    [() => ({ status: false, error: "busy" }), () => ({ status: true, response: { phrase: "x" } }), "the key list was refused"],
    ]) {   // CHANGED on purpose (0.18.215): a readable key list without the key is a foreign seed, whatever the vault says
    const sent = rig2(keys, vault);
    await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /Could not tell whether this is the node's own wallet[\s\S]*Nothing was sent/, what);
    assert.ok(!sent.some(c => c.startsWith("sendfrom") || c.startsWith("send ")), what + ": nothing sent");
    await assert.rejects(ww.derive("alpha beta"), /Could not tell/, what + " (unlock)");
  }
  const sent = rig2(() => ({ status: true, response: { keys: [] } }), () => ({ status: true, response: { phrase: "the node's own" } }));
  assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).ok, true, "both read: a foreign wallet sends on its own path");
  assert.ok(sent.some(c => c.startsWith("sendfrom")));
});

const TXNCHECK_OK = { status: true, response: { validamounts: true, validtransaction: true, valid: { basic: true, mmrproofs: true, scripts: true } } };   // CHANGED on purpose (0.18.291): a collect is posted only after txncheck says valid
// ---- 0.18.209: Vestr reads a contract coin's state strictly and never calls an unanswered send failed ----
test("Vestr: state checked before use; collected exact; cadence a whole count; every collect step must say true; no answer is 'may have been sent'", async () => {
  const vestr = require("../main/vestr"), B = "0x" + "BE".repeat(32);
  const good = { coinid: "0xC0", tokenid: "0x00", amount: "0.3", created: 1, state: [{ port: 0, data: B }, { port: 1, data: "1.1" }, { port: 2, data: "10" }, { port: 3, data: "20" }, { port: 4, data: "0" }, { port: 5, data: "1" }, { port: 6, data: "1" }, { port: 7, data: "24" }, { port: 8, data: "2" }, { port: 199, data: "0xAB" }] };
  const withState = (p, v) => Object.assign({}, good, { coinid: "0xC" + p, state: good.state.map(s => s.port === p ? { port: p, data: v } : s) });
  let coins = [good, withState(0, "MxNOTHEX"), withState(4, "1 id:x"), withState(7, "24 port:0"), withState(199, "not hex")], step = {}, sent = [];
  vestr._setRunner(async (c) => { sent.push(c);
    const k = c.split(" ")[0];
    if (k in step) { const v = step[k]; if (v === "throw") throw new Error("timed out"); return v; }
    if (k === "newscript") return { status: true, response: { address: vestr.CONTRACT } };
    if (k === "block") return { status: true, response: { block: 15 } };
    if (c.startsWith("coins coinid:")) return { status: true, response: coins.filter(x => c.includes(x.coinid + "")) };
    if (k === "coins") return { status: true, response: coins };
    if (k === "runscript") return { status: true, response: { variables: { cancollect: "0.2", change: "0.1" } } };
    if (k === "checkaddress") return { status: true, response: { "0x": B } };
    if (k === "txncheck") return TXNCHECK_OK;
    return { status: true, response: {} }; });
  const l = await vestr.list();
  assert.deepEqual(l.map(v => v.coinid), ["0xC0"], "only the coin with a readable state is shown");
  assert.equal(l[0].collected, "0.8", "exact (1.1 - 0.3 is 0.8000000000000002 as doubles)");
  assert.ok(!sent.some(c => / port:\d+ value:\S+ \S/.test(c)), "no txnstate with a second parameter");
  await assert.rejects(vestr.collect("0xC4"), /cannot be collected: state 4 is not a plain number/);
  // every step must answer true
  step = { txnoutput: null }; await assert.rejects(vestr.collect("0xC0"), /collect step failed: txnoutput\. Nothing was collected/, "an empty reply is not success");
  step = { txninput: { status: false, error: "busy" } }; await assert.rejects(vestr.collect("0xC0"), /busy\. Nothing was collected/);
  step = {}; assert.equal((await vestr.collect("0xC0")).ok, true);
  // CHANGED on purpose (0.18.291): a coin this session collected is refused again until it is gone from the node's list
  await assert.rejects(vestr.collect("0xC0"), /^Error: This contract coin was collected a moment ago and the node still lists it\. Wait until it is gone from the list before you collect again\. Nothing was sent\.$/);
  const all = coins; coins = all.filter(x => x.coinid !== "0xC0"); await vestr.list(); coins = all;   // gone from the list once
  step = { txnpost: "throw" }; await assert.rejects(vestr.collect("0xC0"), /may have been posted/);
  step = {}; await assert.rejects(vestr.collect("0xC0"), /collected a moment ago/, "a collect that may have been posted is not built again");
  // create
  const base = { tokenid: "0x00", amount: "5", beneficiary: "Mx" + "A".repeat(50), startMs: Date.now() + 1e6, endMs: Date.now() + 2e6 };
  for (const g of ["1e3", "-24", "2.5", "abc", 1.5, -1]) await assert.rejects(vestr.create(Object.assign({}, base, { graceHours: g })), /whole number of hours/, String(g));
  await assert.rejects(vestr.create(Object.assign({}, base, { beneficiary: "Mx" + "A".repeat(50) + " address:0xEVIL" })), /Invalid beneficiary/);
  step = { checkaddress: { status: false, error: "bad" } }; await assert.rejects(vestr.create(base), /Invalid beneficiary/);
  step = { send: "throw" }; await assert.rejects(vestr.create(Object.assign({}, base, { tokenid: "0x" + "AA".repeat(32) })), /may have been sent[\s\S]*lock twice/);
  step = { send: { status: false, error: "Insufficient funds" } }; await assert.rejects(vestr.create(Object.assign({}, base, { tokenid: "0x" + "AA".repeat(32) })), /Insufficient funds\. Nothing was sent/);
  step = {}; sent = []; assert.equal((await vestr.create(Object.assign({}, base, { tokenid: "0x" + "AA".repeat(32), graceHours: "168" }))).ok, true);
  assert.ok(sent.some(c => c.startsWith("send ") && c.includes('"4":"12096"') && c.includes('"7":"168"')), "a whole count of hours goes into the state");
});

// ---- 0.18.215: a readable key list decides; a damaged entry is that address's problem only ----
test("Web Wallet: a locked vault with a readable key list is a foreign seed; one damaged counter refuses only its address and is confirmed again", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const A = "0x" + "A3".repeat(32), B = "0x" + "B3".repeat(32), TO = "0x" + "DD".repeat(32), PK = "0x" + "B4".repeat(32);
  fs.writeFileSync(file, JSON.stringify({ [A]: { keyuses: "x", ack: true }, [B]: { keyuses: 4, ack: true } }));
  assert.deepEqual(ww.keyusesInfo(B), { address: B, keyuses: 4, ack: true }, "the other address is untouched");
  let from = A; const sent = [];
  ww._setRunner(async (c) => { sent.push(c);
    return c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: from, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("vault") ? { status: false, error: "Wallet is locked" }
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : { status: true, response: { txpowid: "0x01" } }; });
  assert.equal((await ww.derive("alpha beta")).isNodeSeed, false, "locked vault, readable list: foreign");
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /saved key-use count is damaged[\s\S]*Nothing was sent/);
  assert.ok(!sent.some(c => c.startsWith("sendfrom")));
  from = B; assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).keyuse, 4, "another address still sends");
  // CHANGED on purpose (0.18.262): a damaged entry is confirmed again only at or above the chain's figure, read in main
  ww.setOnchain(async () => 2); assert.equal((await ww.ackKeyuses(A, 2)).keyuses, 2, "confirmed again at the chain's figure"); ww.setOnchain(async () => null);
  from = A; assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).keyuse, 2);
  assert.equal(ww.keyusesInfo(B).keyuses, 5);
});

// ---- 0.18.262 (as Pandamonium Desktop 0.19.255): a damaged entry is confirmed again only at or above the chain's figure, read in MAIN ----
test("Web Wallet: a damaged key-use entry is confirmed again only at or above the chain's figure, read in main for the key main derived, and refused while unread", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A5".repeat(32), OTHER = "0x" + "A6".repeat(32), PK = "0x" + "B5".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C5".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: "x", ack: true }, [OTHER]: { keyuses: 5, ack: true } }));
  await ww.derive("alpha beta");   // the session's key for FROM is known to main
  let chain = null; const asked = []; ww.setOnchain(async (pk) => { asked.push(pk); return chain; });
  await assert.rejects(ww.ackKeyuses(FROM, 50), /chain's figure for this key could not be read/, "unread: refused, never taken as 0");
  assert.deepEqual(asked, [PK], "the chain is asked for this address's own key, the one main derived");
  chain = 12; await assert.rejects(ww.ackKeyuses(FROM, 3), /The chain shows 12 uses of this key\. Confirm at least that many/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[FROM].keyuses, "x", "nothing saved by a refusal");
  assert.deepEqual(await ww.ackKeyuses(FROM, 12), { address: FROM, keyuses: 12, ack: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))[OTHER], { keyuses: 5, ack: true });
  asked.length = 0; await ww.ackKeyuses(FROM, 2); assert.equal(ww.keyusesInfo(FROM).keyuses, 12, "a sound entry never goes down"); assert.deepEqual(asked, [], "and needs no chain read");
  ww.setOnchain(async () => null);
  assert.ok(rd("main/main.js").includes("webwallet.setOnchain((pk) => keyuses.onchainUses(pk, (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES })));"), "main reads the chain with the same pinned fetch");
});
test("keyuses.onchainUses: the larger of spend blocks and spent coins for THIS key; null for no answer, a status that is not true, an error row, another key's row, a count that is not whole", async () => {
  const K = require("../main/keyuses"), PK = "0x" + "AB".repeat(32), urls = [];
  const get = (reply) => async (url) => { urls.push(url); if (reply instanceof Error) throw reply; return reply; };
  assert.equal(await K.onchainUses(PK, get({ status: true, keys: [{ publickey: PK.toLowerCase(), spend_blocks: 3, spent_coins: "7" }] })), 7);
  assert.equal(urls[0], "https://eurobuddha.com/keyaudit?keys=" + encodeURIComponent(PK), "the pinned host, this key only");
  for (const r of [null, new Error("timeout"), { status: false, keys: [] }, { keys: [{ publickey: PK, spend_blocks: 1, spent_coins: 1 }] }, { status: true, keys: [{ publickey: PK, error: "x", spend_blocks: 1, spent_coins: 1 }] },
    { status: true, keys: [{ publickey: "0x" + "CD".repeat(32), spend_blocks: 1, spent_coins: 1 }] }, { status: true, keys: [{ publickey: PK, spend_blocks: 1.5, spent_coins: 1 }] }, { status: true, keys: [{ publickey: PK, spend_blocks: -1, spent_coins: 1 }] }])
    assert.equal(await K.onchainUses(PK, get(r)), null, JSON.stringify(r && r.message || r));
  assert.equal(await K.onchainUses("0x12", get({ status: true, keys: [] })), null, "a malformed key is never asked about");
});

// ---- 0.18.263 (as Pandamonium Desktop 0.19.270): the chain's floor is applied in main to every key-use entry not yet acknowledged ----
test("Web Wallet: a first confirmation, or one after the key-use file went missing, is taken only at or above the chain's figure, read in main, and refused while unread", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A7".repeat(32), PK = "0x" + "B7".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C7".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  try { fs.rmSync(file); } catch (e) {}
  await ww.derive("alpha beta");
  let chain = null; const asked = []; ww.setOnchain(async (pk) => { asked.push(pk); return chain; });
  await assert.rejects(ww.ackKeyuses(FROM, 0), /chain's figure for this key could not be read .*cannot be checked against it/, "a first confirmation while the chain is unread: refused");
  assert.deepEqual(asked, [PK]); assert.ok(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, "utf8"))[FROM], "nothing saved");
  // (0.18.279) above the ceiling while the chain is unread: the ceiling is what is said, not "could not be read"
  await assert.rejects(ww.ackKeyuses(FROM, 262144), /The key-use count can be at most 262143/); await assert.rejects(ww.ackKeyuses(FROM, "300000"), /can be at most 262143/);
  chain = 9; await assert.rejects(ww.ackKeyuses(FROM, 3), /The chain shows 9 uses of this key/, "below the chain's figure: refused, whatever the window sent");
  assert.deepEqual(await ww.ackKeyuses(FROM, 9), { address: FROM, keyuses: 9, ack: true });
  fs.rmSync(file); chain = 11;   // the file vanished: the entry is unknown again
  await assert.rejects(ww.ackKeyuses(FROM, 9), /The chain shows 11 uses/);
  assert.deepEqual(await ww.ackKeyuses(FROM, 11), { address: FROM, keyuses: 11, ack: true });
  asked.length = 0; await ww.ackKeyuses(FROM, 4); assert.equal(ww.keyusesInfo(FROM).keyuses, 11, "an acknowledged entry never goes down"); assert.deepEqual(asked, [], "and needs no chain read: no new prompt on upgrade");
  // a key this session did not derive (an address the window names) is never confirmed: main has no key of its own to ask about
  await assert.rejects(ww.ackKeyuses("0x" + "AF".repeat(32), 5), /could not be read/);
  // a write that raised the counter while the chain was being read is never lowered
  fs.rmSync(file); chain = 3; ww.setOnchain(async () => { fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 20, ack: false } })); return chain; });
  assert.equal((await ww.ackKeyuses(FROM, 5)).keyuses, 20, "the higher figure written meanwhile is kept");
  ww.setOnchain(async () => null);
});

// ---- 0.18.265: the ceiling: a key of this wallet signs at leaves 0..262143 (TreeKey.createDefault 64x3); past it the node signs at leaf 0 again ----
test("Web Wallet key uses have a ceiling of 262143: above it refused at confirm, a used-up chain figure is never adopted, a stored count above it refuses the send, the last leaf signs once", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A8".repeat(32), PK = "0x" + "B8".repeat(32), TO = "0x" + "DD".repeat(32), signed = [];
  ww._setRunner(async (c) => { if (c.startsWith("sendfrom")) signed.push(Number(/keyuses:(\d+)/.exec(c)[1]));
    return c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C8".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("vault") ? { status: true, response: { phrase: "the node's own" } }
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : c.startsWith("sendfrom") ? { status: true, response: { txpowid: "0x01" } } : { status: true, response: {} }; });
  try { fs.rmSync(file); } catch (e) {}
  await ww.derive("alpha beta"); assert.equal(ww.MAX_USES, 262143);
  let chain = 0; ww.setOnchain(async () => chain);
  for (const bad of [262144, 1000000, 4294967299, "262144"]) await assert.rejects(ww.ackKeyuses(FROM, bad), /can be at most 262143 \(a key of this wallet has 262144 one-time uses, numbered 0 to 262143\)/, String(bad));
  for (const bad of ["1e6", "0x10", " 5 ", "5 "]) await assert.rejects(ww.ackKeyuses(FROM, bad), /whole number of at least 0/, JSON.stringify(bad));
  chain = 262144; await assert.rejects(ww.ackKeyuses(FROM, 5), /The chain's figure for this key \(262144\) is at or above the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. The figure can count more uses than the key signed, but this app will not sign from this address/, "a used-up chain figure is never adopted");
  assert.ok(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, "utf8"))[FROM], "nothing saved");
  chain = 100; assert.deepEqual(await ww.ackKeyuses(FROM, 262143), { address: FROM, keyuses: 262143, ack: true }, "the last leaf is accepted");
  // the boundary: the last leaf signs once, then nothing
  assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).keyuse, 262143); assert.deepEqual(signed, [262143]);
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /count for this key has reached the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. This app will not sign from this address/);
  assert.deepEqual(signed, [262143], "no send at leaf 262144 (the node would sign at leaf 0)"); assert.equal(ww.keyusesInfo(FROM).keyuses, 262144, "nothing reserved by the refusal");
  // a count over-confirmed by an older version: refused with why and what to do, never lowered
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 1000000, ack: true } }));
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /saved key-use count \(1000000\) is above the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)[\s\S]*not lowered\. This app will not sign from this address[\s\S]*Nothing was sent\.$/);
  assert.equal(ww.keyusesInfo(FROM).keyuses, 1000000, "never lowered"); assert.deepEqual(signed, [262143]);
  ww.setOnchain(async () => null);
  const app = rd("renderer/app.js");
  assert.ok(!app.includes("Over-estimating is safe;") && app.includes("is safe only up to 262143, the last one a key of this wallet has") && /id="wwKuIn" type="number" min="0" max="262143"/.test(app), "the screen's wording is true, and the input has its maximum");
});

// ---- 0.18.267: a damaged entry's old value that still reads as a whole number is a floor ----
test("Web Wallet: a damaged entry whose old value reads as a whole number (\"57\", 57.4) is confirmed again only at or above it", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "A9".repeat(32), PK = "0x" + "B9".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C9".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta"); ww.setOnchain(async () => 10);
  for (const [old, floor] of [["57", 57], [" 57 ", 57], [57.4, 58], ["57.4", 58]]) {   // a decimal as text too (0.18.270)
    fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: old, ack: true } }));
    assert.equal(ww.keyusesInfo(FROM).damaged, true, JSON.stringify(old));
    await assert.rejects(ww.ackKeyuses(FROM, floor - 1), new RegExp("saved count read " + floor + " before it was damaged\\. Confirm at least that many"), JSON.stringify(old));
    assert.equal((await ww.ackKeyuses(FROM, floor)).keyuses, floor);
  }
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: "x", ack: true } })); assert.equal((await ww.ackKeyuses(FROM, 10)).keyuses, 10, "an unreadable old value: the chain's figure is the floor");
  ww.setOnchain(async () => null);
});

// ---- 0.18.270: a damaged old value at or above 262144 cannot be confirmed: the over-count explanation, not "confirm at least 1000000" ----
test("Web Wallet: a damaged old value above the ceiling gives the over-count explanation", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AA".repeat(32), PK = "0x" + "BA".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CA".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta"); ww.setOnchain(async () => 10);
  for (const old of ["1000000", 1000000.5]) {
    fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: old, ack: true } }));
    await assert.rejects(ww.ackKeyuses(FROM, 100), (e) => /is above the limit of a key of this wallet \(262144 one-time uses/.test(e.message) && !/Confirm at least/.test(e.message), JSON.stringify(old));
  }
  ww.setOnchain(async () => null);
});

// ---- 0.18.271: the used-up wording says what is true: the chain's figure can over-count, and no wallet is named to move the funds with ----
test("Web Wallet: the limit messages say the figure is at the limit and this app will not sign; never that the key has no uses left, never 'move the funds with another wallet'", () => {
  const src = rd("main/webwallet.js");
  assert.ok(!/no one-time uses left|move the funds with another wallet|Move the funds with the wallet/.test(src), "no claim the figure cannot make, no advice that is not safe");
  assert.ok(src.includes("The figure can count more uses than the key signed, but this app will not sign from this address"));
});

// ---- 0.18.274: for an entry not yet confirmed the chain is read first: a chain figure at the limit is explained, not "can be at most 262143" ----
test("Web Wallet: a first confirmation whose chain figure is at the limit gets the at-the-limit explanation, whatever count the window sent", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AB".repeat(32), PK = "0x" + "BB".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CB".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  try { fs.rmSync(file); } catch (e) {}
  await ww.derive("alpha beta"); ww.setOnchain(async () => 300000);
  for (const sentByWindow of [300000, 5]) await assert.rejects(ww.ackKeyuses(FROM, sentByWindow), /The chain's figure for this key \(300000\) is at or above the limit/, String(sentByWindow));
  ww.setOnchain(async () => 10); await assert.rejects(ww.ackKeyuses(FROM, 300000), /can be at most 262143/, "a chain figure below the limit and a typed figure above it: the ceiling");
  ww.setOnchain(async () => null);
});

// ---- 0.18.275: a refused confirmation says "Nothing was saved"; a damaged {"keyuses":1e400} is an over-count, not 0 ----
test("Web Wallet: a damaged old value above the limit (or Infinity) refuses the confirmation with 'Nothing was saved'", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AC".repeat(32), PK = "0x" + "BC".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta"); ww.setOnchain(async () => 10);
  for (const raw of ['{"' + FROM + '":{"keyuses":1e400,"ack":true}}', JSON.stringify({ [FROM]: { keyuses: "1000000", ack: true } })]) {
    fs.writeFileSync(file, raw);
    await assert.rejects(ww.ackKeyuses(FROM, 100), (e) => /is above the limit of a key of this wallet/.test(e.message) && /Nothing was saved\.$/.test(e.message) && !/Nothing was sent/.test(e.message), raw);
  }
  ww.setOnchain(async () => null);
});

// ---- 0.18.288: a collect never pays out more than the coin; its change is the coin less the payout, exactly ----
test("Vestr collect: an expired contract pays the whole coin with no change output; a partial one returns the exact rest with its state; nothing within the grace wait", async () => {
  const vestr = require("../main/vestr");
  const COIN = "0x23456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01", UNLOCK = "0xA1B2C3D4E5F60718A1B2C3D4E5F60718A1B2C3D4E5F60718A1B2C3D4E5F60718";
  // a sample contract coin as the node reported it: 100 MINIMA, blocks 1000001 to 1000004, no grace, a 16-byte id, created at 1000002
  const owner = [[0, UNLOCK], [1, "100"], [2, "1000001"], [3, "1000004"], [4, "0"], [5, "1700000000000"], [6, "1700000021278"], [7, "0"], [8, "1700000141315"], [199, "0x112233445566778899AABBCCDDEEFF00"]];
  let coin, block, vars, sent = [];
  vestr._setRunner(async (c) => {
    sent.push(c);
    if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
    if (c === "block") return { status: true, response: { block: String(block) } };
    if (c.startsWith("coins coinid:")) return { status: true, response: [coin] };
    if (c.startsWith("runscript")) return { status: true, response: { variables: vars } };
    if (c.startsWith("txncheck")) return TXNCHECK_OK;
    if (c.startsWith("coins address:")) return { status: true, response: [] };
    return { status: true, response: {} };
  });
  const run = async (st, amount, created, tip, v) => {
    coin = { coinid: COIN, tokenid: "0x00", amount, created: String(created), address: vestr.CONTRACT, state: st.map(([port, data]) => ({ port, data })) };
    block = tip; vars = v; await vestr.list(); sent = [];   // CHANGED on purpose (0.18.291): the list read forgets a collected coin no longer listed
    const r = await vestr.collect(COIN, "");
    return { r, txn: sent.filter(c => /^txn/.test(c)).map(c => c.replace(/vc\d+/, "ID")) };
  };
  const states = (st) => st.map(([p, d]) => "txnstate id:ID port:" + p + " value:" + d);
  const whole = (st, tip) => ["txncreate id:ID", "txninput id:ID coinid:" + COIN + " scriptmmr:true",
    "txnoutput id:ID address:" + UNLOCK + " amount:100 tokenid:0x00 storestate:false", ...states(st), "txncheck id:ID", "txnpost id:ID", "txndelete id:ID"];
  // at the final block CHECK_MATHS says cancollect 100 AND change 1 (its change is worked out before the expiry raises cancollect)
  for (const [tip, change] of [[1000004, "1"], [1000078, "0"]]) {
    const { r, txn } = await run(owner, "100", 1000002, tip, { cancollect: "100", change, mustwait: "FALSE", contractexpired: "TRUE" });
    assert.deepEqual(r, { ok: true, collected: "100", tokenid: "0x00" });
    assert.deepEqual(txn, whole(owner, tip), "tip " + tip + ": the whole coin, no change output");
  }
  // expired, the covenant pays the whole coin whatever its age: the grace wait does not apply
  const ownerGraced = owner.map(([p, d]) => [p, p === 4 ? "1728" : d]);
  assert.deepEqual((await run(ownerGraced, "100", 1000003, 1000004, { cancollect: "100", change: "1", mustwait: "FALSE", contractexpired: "TRUE" })).txn, whole(ownerGraced, 1000004));
  // partly vested: 1000 over blocks 999978 to 1000078, 124.5 already collected, tip half-way
  const part = owner.map(([p, d]) => [p, ({ 1: "1000", 2: "999978", 3: "1000078" })[p] || d]);
  const { r, txn } = await run(part, "875.5", 999988, 1000028, { cancollect: "380", change: "495.5", mustwait: "FALSE", contractexpired: "FALSE" });
  assert.deepEqual(r, { ok: true, collected: "380", tokenid: "0x00" });
  assert.deepEqual(txn, ["txncreate id:ID", "txninput id:ID coinid:" + COIN + " scriptmmr:true",
    "txnoutput id:ID address:" + UNLOCK + " amount:380 tokenid:0x00 storestate:false",
    "txnoutput id:ID address:" + vestr.CONTRACT + " amount:495.5 tokenid:0x00 storestate:true",
    ...states(part), "txncheck id:ID", "txnpost id:ID", "txndelete id:ID"], "380 out, the exact 495.5 back to the contract keeping every port (SAMESTATE(0 8), PREVSTATE(199) EQ STATE(199))");
  // the grace wait in force: 40 blocks old and the node says wait; 0 blocks old, where the node's mustwait is FALSE and the covenant still refuses
  const graced = part.map(([p, d]) => [p, p === 4 ? "1728" : d]);
  for (const [created, mustwait] of [[999988, "TRUE"], [1000028, "FALSE"]]) {
    await assert.rejects(run(graced, "875.5", created, 1000028, { cancollect: "380", change: "495.5", mustwait, contractexpired: "FALSE" }), /^Error: The grace period of this contract is still running, so nothing can be collected yet\. Nothing was sent\.$/);
    assert.ok(!sent.some(c => /^txn/.test(c)), "nothing built (created " + created + ")");
  }
  // a payout above the coin is refused, never posted
  await assert.rejects(run(part, "875.5", 999988, 1000028, { cancollect: "875.6", change: "0", mustwait: "FALSE", contractexpired: "FALSE" }), /^Error: The node's figure to collect is more than this contract coin holds\. Nothing was sent\.$/);
  assert.ok(!sent.some(c => /^txn/.test(c)), "nothing built for a payout above the coin");
  vestr._setRunner(() => { throw new Error("no node in a test"); });
});

// ---- 0.18.291: Vestr never builds a second collect of a coin already being collected; the node judges every collect before it is posted;
// the refusals come in the order shape, tip, nothing available, grace; the grace wait counts the age at the next block ----
const vestrRig = () => {
  const vestr = require("../main/vestr");
  const COIN = "0x9A0F5C6E1D2B3A4958677685A4B3C2D1E0F9A8B7C6D5E4F3A2B1C0D9E8F7A6B5", UNLOCK = "0x" + "5E".repeat(32);
  const st = (o) => [[0, UNLOCK], [1, "1000"], [2, "100"], [3, "1100"], [4, "10"], [5, "1"], [6, "1"], [7, "0"], [8, "2"], [199, "0xAB"]].map(([port, data]) => ({ port, data: o && o[port] != null ? o[port] : data }));
  const R = { vestr, COIN, st, sent: [], listed: true };
  vestr._setRunner(async (c) => {
    R.sent.push(c);
    if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
    if (c === "block") { if (R.tip === "throw") throw new Error("timed out"); return R.tip; }
    if (c.startsWith("coins coinid:") || c.startsWith("coins address:")) return { status: true, response: R.listed ? [R.coin] : [] };   // a node that still lists the coin (as one without the mempool flag)
    if (c.startsWith("runscript")) return { status: true, response: { variables: R.vars } };
    if (c.startsWith("txncheck")) return R.txncheck;
    if (c.startsWith("txnpost")) return R.post;
    return { status: true, response: {} };
  });
  R.OK = { status: true, response: { validamounts: true, validtransaction: true, valid: { basic: true, mmrproofs: true, scripts: true } } };
  R.SCRIPTS_FALSE = { status: true, response: { validamounts: true, validtransaction: false, valid: { basic: true, mmrproofs: true, scripts: false } } };
  R.reset = async (o) => { R.listed = false; await vestr.list(); R.coin = Object.assign({ coinid: COIN, tokenid: "0x00", amount: "900", created: "100", address: vestr.CONTRACT, state: st() }, o);
    R.listed = true; R.tip = { status: true, response: { block: "600" } }; R.vars = { cancollect: "400", change: "500", mustwait: "FALSE", contractexpired: "FALSE" }; R.txncheck = R.OK; R.post = { status: true, response: {} }; R.sent = []; };
  R.txns = () => R.sent.filter(c => /^txn/.test(c)).map(c => c.split(" ")[0]);
  R.collect = () => vestr.collect(COIN, "");
  R.done = () => vestr._setRunner(() => { throw new Error("no node in a test"); });
  return R;
};
test("Vestr collect (V1): both reads send checkmempool:true; a coin collected in this session is refused again, nothing built, while the node still lists it", async () => {
  const R = vestrRig();
  await R.reset(); assert.equal((await R.collect()).ok, true);
  assert.ok(R.sent.includes("coins coinid:" + R.COIN + " checkmempool:true"), R.sent.join(" | ")); await R.vestr.list(); assert.ok(R.sent.includes("coins address:" + R.vestr.CONTRACT + " relevant:true checkmempool:true"));
  R.sent = []; await assert.rejects(R.collect(), /^Error: This contract coin was collected a moment ago and the node still lists it\. Wait until it is gone from the list before you collect again\. Nothing was sent\.$/);
  assert.deepEqual(R.txns(), [], "nothing built"); R.listed = false; await assert.rejects(R.collect(), /not found/, "hidden by checkmempool: not found");
  R.done();
});
test("Vestr collect (V2): txncheck after the build and before txnpost; anything but a valid verdict is refused, deleted, never posted", async () => {
  const R = vestrRig();
  for (const bad of [{ status: true, response: { validamounts: false, validtransaction: false, valid: { basic: false, mmrproofs: true, scripts: true } } }, R.SCRIPTS_FALSE, { status: true, response: {} },
    { status: true, response: { validtransaction: "true" } }, { status: true, response: { validtransaction: 1 } }]) {
    await R.reset(); R.txncheck = bad;
    await assert.rejects(R.collect(), /^Error: The node checked this collect and judged it invalid, so it was not sent\. Nothing was collected\.$/, JSON.stringify(bad));
    assert.deepEqual(R.txns().slice(-2), ["txncheck", "txndelete"], "no txnpost");
  }
  await R.reset(); R.txncheck = { status: false, error: "Transaction not found" }; await assert.rejects(R.collect(), /collect step failed: Transaction not found\. Nothing was collected/); assert.ok(!R.txns().includes("txnpost"));
  await R.reset(); assert.equal((await R.collect()).ok, true); assert.deepEqual(R.txns().slice(-3), ["txncheck", "txnpost", "txndelete"]);
  R.done();
});
test("Vestr collect (V3): the coin's shape, then the tip, then nothing available, then the grace wait, counted at the tip (as txncheck and the node's relay check)", async () => {
  const R = vestrRig();
  await R.reset({ state: R.st({ 4: "abc" }) }); R.tip = "throw"; await assert.rejects(R.collect(), /cannot be collected: state 4 is not a plain number/, "the shape first, whatever the tip");
  await R.reset(); R.tip = "throw"; await assert.rejects(R.collect(), /^Error: The node's block height could not be read, so nothing was built\. Nothing was sent\.$/);
  await R.reset(); R.tip = { status: false, error: "busy" }; await assert.rejects(R.collect(), /block height could not be read/); assert.ok(!R.sent.some(c => c.startsWith("runscript")), "no maths without a tip");
  await R.reset({ created: "595" }); R.vars = { cancollect: "0", change: "900", mustwait: "TRUE", contractexpired: "FALSE" };   // young, and nothing vested yet
  await assert.rejects(R.collect(), /^Error: Nothing available to collect yet$/, "nothing available before the grace wait");
  // minblockwait 10, created 100: the age is taken at the tip (txncheck, and the node's relay check of the txpow it mined, run the script with
  // @BLOCK = the tip; a collect only the next block accepts is never forwarded): tip 109 (age 9) waits, tip 110 (age 10) goes; expired, no wait
  await R.reset(); R.tip = { status: true, response: { block: "109" } }; await assert.rejects(R.collect(), /grace period of this contract is still running/); assert.deepEqual(R.txns(), []);
  await R.reset(); R.tip = { status: true, response: { block: "110" } }; assert.equal((await R.collect()).ok, true); assert.ok(R.txns().includes("txnpost"));
  await R.reset({ created: "1099" }); R.tip = { status: true, response: { block: "1100" } }; R.vars = { cancollect: "900", change: "0", mustwait: "FALSE", contractexpired: "TRUE" };
  assert.equal((await R.collect()).ok, true, "at the final block the whole coin goes, whatever its age");
  R.done();
});
test("Vestr: the list's Collect button agrees with collect() at coin age 0 (CHECK_MATHS's mustwait is FALSE there, the covenant refuses)", async () => {
  const R = vestrRig();
  await R.reset({ created: "600", state: R.st({ 4: "1728" }) });
  let [v] = await R.vestr.list(); assert.equal(v.canCollectNow, false); assert.equal(v.mustwait, true); assert.equal(v.mustwaitblocks, "1728");
  await assert.rejects(R.collect(), /grace period/);
  await R.reset({ created: "600", state: R.st({ 4: "1" }) }); [v] = await R.vestr.list(); assert.equal(v.canCollectNow, false, "minblockwait 1 at age 0: waits"); await assert.rejects(R.collect(), /grace period/);
  await R.reset({ created: "599", state: R.st({ 4: "1" }) }); [v] = await R.vestr.list(); assert.equal(v.canCollectNow, true, "age 1"); assert.equal((await R.collect()).ok, true);
  R.done();
});
test("Vestr collect (V5): a pending reply to txnpost is not 'collected'", async () => {
  const R = vestrRig();
  await R.reset(); R.txncheck = R.OK; R.post = { pending: true, status: false }; await assert.rejects(R.collect(), /collect step failed/);
  R.done();
});
