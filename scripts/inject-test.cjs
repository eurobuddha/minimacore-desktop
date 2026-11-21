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
    return { status: true, response: {} }; });
  const l = await vestr.list();
  assert.deepEqual(l.map(v => v.coinid), ["0xC0"], "only the coin with a readable state is shown");
  assert.equal(l[0].collected, "0.8", "exact (1.1 - 0.3 is 0.8000000000000002 as doubles)");
  assert.ok(!sent.some(c => / port:\d+ value:\S+ \S/.test(c)), "no txnstate with a second parameter");
  await assert.rejects(vestr.collect("0xC4"), /cannot be collected: state 4 is not a plain number/);
  // every step must answer true
  step = { txnoutput: null }; await assert.rejects(vestr.collect("0xC0"), /collect step failed: txnoutput\. Nothing was collected/, "an empty reply is not success");
  step = { txninput: { status: false, error: "busy" } }; await assert.rejects(vestr.collect("0xC0"), /busy\. Nothing was collected/);
  step = { txnpost: "throw" }; await assert.rejects(vestr.collect("0xC0"), /may have been posted/);
  step = {}; assert.equal((await vestr.collect("0xC0")).ok, true);
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
  chain = 262144; await assert.rejects(ww.ackKeyuses(FROM, 5), /this key has no one-time uses left \(a key of this wallet has 262144\)\. Nothing can be sent from this address with this wallet: move the funds with another wallet/, "a used-up chain figure is never adopted");
  assert.ok(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, "utf8"))[FROM], "nothing saved");
  chain = 100; assert.deepEqual(await ww.ackKeyuses(FROM, 262143), { address: FROM, keyuses: 262143, ack: true }, "the last leaf is accepted");
  // the boundary: the last leaf signs once, then nothing
  assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).keyuse, 262143); assert.deepEqual(signed, [262143]);
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /Every one-time use of this key has been used \(262144\)\. Nothing can be sent/);
  assert.deepEqual(signed, [262143], "no send at leaf 262144 (the node would sign at leaf 0)"); assert.equal(ww.keyusesInfo(FROM).keyuses, 262144, "nothing reserved by the refusal");
  // a count over-confirmed by an older version: refused with why and what to do, never lowered
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 1000000, ack: true } }));
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /saved key-use count \(1000000\) is above the last one-time use a key of this wallet has \(262143\)[\s\S]*not lowered\. Nothing was sent\. Move the funds with the wallet this seed was made in/);
  assert.equal(ww.keyusesInfo(FROM).keyuses, 1000000, "never lowered"); assert.deepEqual(signed, [262143]);
  ww.setOnchain(async () => null);
  const app = rd("renderer/app.js");
  assert.ok(!app.includes("Over-estimating is safe;") && app.includes("is safe only up to 262143, the last one a key of this wallet has") && /id="wwKuIn" type="number" min="0" max="262143"/.test(app), "the screen's wording is true, and the input has its maximum");
});
