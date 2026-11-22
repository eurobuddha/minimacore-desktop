/*
 * inject-test.cjs: a command the app builds is ONE command (0.19.194; ported from the released desktop's 0.18.177 test). The node splits a text on every ";", even inside
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

// ---- 0.19.195: the screens that put typed text into a node command refuse ";" (as released 0.18.178) ----
test("the Web Wallet login, every restore and resync screen and the backup password refuse ';' before a command is built", () => {
  const app = require("./i18n-plain.cjs").plain(rd("renderer/app.js"));
  const ww = app.slice(app.indexOf("function renderWwUnlock("), app.indexOf("wwAddr = await api.wwDerive(seed);"));
  const re = /if \((\/[^/]+\/)\.test\(seed\)\) \{ toast\("The key has a \\", \\\\, ; or line break the command can't carry\. Enter it as one clean line\.", "err"\)/.exec(ww);
  assert.ok(re, "the Web Wallet login checks the phrase before deriving");
  const rx = eval(re[1]); for (const s of ["apple; vault", 'a"b', "a\\b", "a\nb"]) assert.ok(rx.test(s), JSON.stringify(s)); assert.ok(!rx.test("apple banana cherry"));
  // resync / restore by phrase: one builder (resyncCommand); backup password: letters and numbers only (backupPasswordProblem)
  const raw = rd("renderer/app.js");
  assert.ok(raw.includes('if (phrase.includes(";")) return { error: t("This seed contains a semicolon (;)'), "the phrase restore refuses ;");
  assert.ok(raw.includes('if (!/^[A-Za-z0-9]+$/.test(pw)) return t("Letters and numbers only");'), "the backup password is letters and numbers only");
  const r = require("../main/restore.js").restoreFileCommand({ host: "h:9001", file: "a;b", password: "" }); assert.match(r.error, /semicolon/);
  assert.match(require("../main/restore.js").restoreFileCommand({ host: "h:9001", file: "a", password: "p;q" }).error, /semicolon/);
});
// ---- 0.19.196 (released 0.18.188): a plain reason before anything is sent; file paths quoted ----
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
test("0.19.196: a peer's media is fetched into a quoted file path (the data folder holds a space)", async () => {
  const chat = require("../main/chat"), sent = [];
  chat._setRunner(async (c) => { sent.push(c); const f = /file:"([^"]+)"$/.exec(c)[1]; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from("x")); return { status: true, response: {} }; });
  await chat.fetchMedia("keets://" + "ab".repeat(32) + "/chat/img-2.png").catch(() => {});
  assert.match(sent[0], /^keets action:fetch url:keets:\/\/[0-9a-f]{64}\/chat\/img-2\.png file:"[^";]+\.png"$/);
});
// ---- 0.19.198 (released 0.18.180): the Web Wallet's log line names the token id and the addresses whole ----
test("Web Wallet: a sent payment is logged with its whole token id and addresses", async () => {
  const ww = require("../main/webwallet");
  const FROM = "0x" + "AA".repeat(32), TO = "0x" + "DD".repeat(32), PK = "0x" + "BB".repeat(32), MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("vault") ? { status: true, response: { phrase: "the node's own" } }
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : c.startsWith("sendfrom") ? { status: true, response: { txpowid: "0x01" } } : { status: true, response: {} });
  ww.setOnchain(async () => 0); await ww.derive("alpha beta"); await ww.ackKeyuses(FROM, 0); ww.setOnchain(async () => null);   // a first confirmation is checked against the chain (0.19.270)
  const r = await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: MXUSD });
  assert.equal(r.ok, true);
  const line = ww.status().log.slice(-1)[0];
  assert.ok(line.includes("token " + MXUSD) && line.includes("from " + FROM) && line.includes("to " + TO), line);
});

// ---- 0.19.230: the Web Wallet's key-use store fails closed; an unreadable key list is never a foreign seed ----
test("Web Wallet: an unreadable or damaged key-use store sends nothing; a bad count is refused; a failed key list never sends as a foreign seed", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), sent = [];
  const FROM = "0x" + "A1".repeat(32), TO = "0x" + "D1".repeat(32), PK = "0x" + "B1".repeat(32);
  let keysOk = true;
  ww._setRunner(async (c) => { sent.push(c); return c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C1".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? (keysOk ? { status: true, response: { keys: [] } } : { status: false, error: "busy" })
    : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : c.startsWith("sendfrom") ? { status: true, response: { txpowid: "0x01" } } : { status: true, response: {} }; });
  const sends = () => sent.filter(c => c.startsWith("send"));
  // CHANGED on purpose (0.19.255, as released 0.18.215): a damaged ENTRY refuses only its own address, with its own reason
  for (const [bad, why] of [["not json", /key-use record could not be read, so nothing was sent/], [JSON.stringify({ [FROM]: { keyuses: "7", ack: true } }), /saved key-use count is damaged\. Confirm its key uses again/],
    [JSON.stringify({ [FROM]: { keyuses: -1, ack: true } }), /saved key-use count is damaged/], [JSON.stringify([1]), /key-use record could not be read/]]) {
    fs.writeFileSync(file, bad); sent.length = 0;
    await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), why, bad);
    assert.deepEqual(sends(), [], "nothing signed: " + bad);
  }
  fs.rmSync(file);
  for (const c of ["abc", -1, 1.5, "", null]) await assert.rejects(ww.ackKeyuses(FROM, c), /whole number of at least 0/, String(c));
  ww.setOnchain(async () => 7); await ww.derive("alpha beta"); await ww.ackKeyuses(FROM, "7"); ww.setOnchain(async () => null);   // checked against the chain's figure (0.19.270)
  sent.length = 0; assert.equal((await ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" })).ok, true);
  assert.match(sends()[0], / keyuses:7 mine:false$/); assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[FROM].keyuses, 8, "reserved durably, from the one read");
  keysOk = false; sent.length = 0;
  await assert.rejects(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }), /node's keys could not be read/);
  assert.deepEqual(sends(), [], "a failed key list never sends as a foreign seed");
  await assert.rejects(ww.derive("alpha beta"), /node's keys could not be read/);
  assert.ok(!/vault action:seed/.test(rd("main/webwallet.js")), "the vault is no longer asked");
});

const TXNCHECK_OK = { status: true, response: { validamounts: true, validtransaction: true, valid: { basic: true, mmrproofs: true, scripts: true } } };   // changed on purpose (0.19.347): a collect is posted only after txncheck says valid
// ---- 0.19.239: Vestr checks what the chain wrote before any command; an unanswered lock or post may have gone ----
test("Vestr: a contract coin with a malformed state signs nothing; an unanswered post or lock is 'may have gone'; grace is a whole number; collected is exact", async () => {
  const vestr = require("../main/vestr"), sent = [], COIN = "0x" + "C9".repeat(32), BEN = "0x" + "BE".repeat(32);
  const st = (o) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 199].map(p => ({ port: p, data: Object.hasOwn(o, p) ? o[p] : (p === 0 ? BEN : p === 199 ? "0x01" : "10") }));
  let state = st({}), postMode = "ok";
  vestr._setRunner(async (c) => {
    sent.push(c);
    if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
    if (c.startsWith("block")) return { status: true, response: { block: 100 } };
    if (c.startsWith("coins coinid:")) return { status: true, response: [{ coinid: COIN, tokenid: "0x00", amount: "10", created: 1, state }] };
    if (c.startsWith("runscript")) return { status: true, response: { variables: { cancollect: "4", change: "6" } } };
    if (c.startsWith("txnpost")) { if (postMode === "throw") throw new Error("RPC timeout"); if (postMode === "garbled") return "not json"; return { status: true }; }
    if (c.startsWith("txncheck")) return TXNCHECK_OK;
    if (c.startsWith("coins address:")) return { status: true, response: [] };
    if (c.startsWith("checkaddress")) return { status: true, response: { "0x": BEN } };
    if (c.startsWith("send ")) throw new Error("RPC timeout");
    return { status: true, response: {} };
  });
  for (const bad of [{ 0: "MxNOTHEX" }, { 3: "10 address:0xEVIL" }, { 7: "a\"b" }]) {
    state = st(bad); sent.length = 0;
    await assert.rejects(vestr.collect(COIN), /state is not one this app can carry\. Nothing was signed/, JSON.stringify(bad));
    assert.ok(!sent.some(c => c.startsWith("txn")), "no transaction built: " + JSON.stringify(bad));
  }
  state = st({});
  // changed on purpose (0.19.351, as released 0.18.296): no list of coins collected in this session; a post that may have gone whose coin the node still
  // lists (not in its mempool) can be collected again; the node's checkmempool:true answer decides (V1)
  for (const m of ["throw", "garbled"]) { postMode = m; await vestr.list(); await assert.rejects(vestr.collect(COIN), (e) => e.ambiguous === true && /may have gone/.test(e.message), m);
    postMode = "ok"; assert.deepEqual(await vestr.collect(COIN), { ok: true, collected: "4", tokenid: "0x00" }, m + ": the post did not take, the coin is still listed"); }
  postMode = "ok"; await vestr.list(); assert.deepEqual(await vestr.collect(COIN), { ok: true, collected: "4", tokenid: "0x00" });
  for (const g of ["1e3", "2.5", "-1", "x"]) await assert.rejects(vestr.create({ tokenid: "0x00", amount: "1", beneficiary: BEN, startMs: 1, endMs: 2, graceHours: g }), /grace period must be a whole number of hours/, g);
  await assert.rejects(vestr.create({ tokenid: "0x" + "7D".repeat(32), amount: "1", beneficiary: BEN, startMs: Date.now() + 1000, endMs: Date.now() + 9e6, graceHours: "24" }), (e) => e.ambiguous === true && /lock may have gone/.test(e.message));
  const src = rd("main/vestr.js"); assert.ok(src.includes("const collected = decSub(total, amount);"), "collected in exact units");
});

// ---- 0.19.255 (released 0.18.215 and the review's open item): one damaged entry is isolated, and confirmed again only at or above the chain's figure, checked in main ----
test("Web Wallet: a damaged key-use entry refuses only its address; it is confirmed again only at or above the chain's figure, read in main, and refused while unread", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A2".repeat(32), OTHER = "0x" + "A3".repeat(32), PK = "0x" + "B2".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C2".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: "x", ack: true }, [OTHER]: { keyuses: 5, ack: true } }));
  assert.deepEqual(ww.keyusesInfo(OTHER), { address: OTHER, keyuses: 5, ack: true }, "another address is untouched");
  assert.deepEqual(ww.keyusesInfo(FROM), { address: FROM, keyuses: 0, ack: false, damaged: true });
  await ww.derive("alpha beta");   // the session's key for FROM is known to main
  let chain = null, asked = []; ww.setOnchain(async (pk) => { asked.push(pk); return chain; });
  await assert.rejects(ww.ackKeyuses(FROM, 50), /chain's figure for this key could not be read/, "unread: refused, never taken as 0");
  assert.deepEqual(asked, [PK], "the chain is asked for this address's own key");
  chain = 12; await assert.rejects(ww.ackKeyuses(FROM, 3), /The chain shows 12 uses of this key\. Confirm at least that many/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[FROM].keyuses, "x", "nothing saved by a refusal");
  assert.deepEqual(await ww.ackKeyuses(FROM, 12), { address: FROM, keyuses: 12, ack: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))[OTHER], { keyuses: 5, ack: true });
  asked.length = 0; await ww.ackKeyuses(FROM, 2); assert.equal(ww.keyusesInfo(FROM).keyuses, 12, "a sound entry never goes down"); assert.deepEqual(asked, [], "and needs no chain read");
  const main = rd("main/main.js");
  assert.ok(main.includes("webwallet.setOnchain((pk) => keyuses.onchainUses(pk, (url) => netfetch.fetchJson(url, { noRedirect: true, maxBytes: keyuses.MAX_BODY_BYTES })));"), "main reads the chain with the same pinned fetch");
  ww.setOnchain(async () => null);
});

// ---- 0.19.270: the chain's floor is applied in main to every key-use entry not yet acknowledged, not only a damaged one ----
test("Web Wallet: a first confirmation, or one after the key-use file went missing, is taken only at or above the chain's figure, read in main, and refused while unread", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A4".repeat(32), PK = "0x" + "B4".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C4".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  try { fs.rmSync(file); } catch (e) {}
  await ww.derive("alpha beta");
  let chain = null, asked = []; ww.setOnchain(async (pk) => { asked.push(pk); return chain; });
  await assert.rejects(ww.ackKeyuses(FROM, 0), /chain's figure for this key could not be read .*cannot be checked against it/, "a first confirmation while the chain is unread: refused");
  assert.deepEqual(asked, [PK]); assert.ok(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, "utf8"))[FROM], "nothing saved");
  chain = 9; await assert.rejects(ww.ackKeyuses(FROM, 3), /The chain shows 9 uses of this key/, "below the chain's figure: refused, whatever the window sent");
  assert.deepEqual(await ww.ackKeyuses(FROM, 9), { address: FROM, keyuses: 9, ack: true });
  fs.rmSync(file); chain = 11;   // the file vanished: the entry is unknown again
  await assert.rejects(ww.ackKeyuses(FROM, 9), /The chain shows 11 uses/);
  assert.deepEqual(await ww.ackKeyuses(FROM, 11), { address: FROM, keyuses: 11, ack: true });
  asked.length = 0; await ww.ackKeyuses(FROM, 4); assert.equal(ww.keyusesInfo(FROM).keyuses, 11, "an acknowledged entry never goes down"); assert.deepEqual(asked, [], "and needs no chain read");
  ww.setOnchain(async () => null);
});

// ---- 0.19.323: a key has 262144 one-time uses (TreeKey 64 x 3); the node wraps a count to 32 bits and starts again at use 0 past the last ----
test("Web Wallet: the key-use count has a ceiling: 262143 is the last; 262144 and more refused at ack, a chain figure at or above it is 'no uses left', a stored count past it sends nothing", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A6".repeat(32), PK = "0x" + "B6".repeat(32), TO = "0x" + "11".repeat(32), sent = [];
  ww._setRunner(async (c) => { if (c.startsWith("sendfrom")) sent.push(c.match(/ keyuses:(\d+)/)[1]);
    return c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C6".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : { status: true, response: { txpowid: "0x01" } }; });
  try { fs.rmSync(file); } catch (e) {}
  await ww.derive("alpha beta"); let chain = 0; ww.setOnchain(async () => chain);
  assert.equal(ww.KEY_USES, 262144); assert.equal(ww.LAST_USE, 262143);
  for (const n of [262144, 1000000, 4294967299, "262144", "4294967299"]) await assert.rejects(ww.ackKeyuses(FROM, n), /The key-use count can be at most 262143 \(a key of this wallet has 262144 one-time uses, numbered 0 to 262143\)\. Nothing was saved\./, String(n));
  assert.ok(!fs.existsSync(file), "nothing saved by those");
  chain = 262144; await assert.rejects(ww.ackKeyuses(FROM, 262143), /The chain's figure for this key \(262144\) is at or above the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. The figure can count more uses than the key signed, but this app will not sign from this address/);   // wording of 0.19.324 (changed on purpose)
  chain = 5000000; await assert.rejects(ww.ackKeyuses(FROM, 0), /The chain's figure for this key \(5000000\) is at or above the limit/, "a huge chain figure is never adopted");
  assert.ok(!fs.existsSync(file));
  // the boundary: 262143 is accepted, its one send signs at 262143, the next is refused
  chain = 262143; assert.deepEqual(await ww.ackKeyuses(FROM, 262143), { address: FROM, keyuses: 262143, ack: true });
  const go = () => ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" });
  assert.equal((await go()).ok, true); assert.deepEqual(sent, ["262143"]);
  await assert.rejects(go(), /This wallet's count for this key has reached the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. This app will not sign from this address: signing past the last use \(262143\) would reuse a one-time key, which can lose funds\. Nothing was sent\./); assert.deepEqual(sent, ["262143"], "nothing more reached the node");
  // a count an older version stored past the last use refuses every send, and is never lowered
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 1000000, ack: true } }));
  await assert.rejects(go(), /This wallet's saved key-use count \(1000000\) is above the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered\. This app will not sign from this address: signing past the last use \(262143\) would reuse a one-time key, which can lose funds\. Nothing was sent\./);
  await ww.ackKeyuses(FROM, 7); assert.equal(ww.keyusesInfo(FROM).keyuses, 1000000, "never lowered"); assert.deepEqual(sent, ["262143"]);
  const app = rd("renderer/app.js");
  assert.ok(app.includes('id="wwKuIn" type="number" min="0" max="262143" step="1"') && !/too high is safe/.test(app) && app.includes("A key has 262144 one-time uses, so this is a whole number from 0 to 262143."), "the window says the limit and no longer that too high is safe");
  ww.setOnchain(async () => null);
});

// ---- 0.19.324: a damaged entry's old value that still reads as a count is a floor (a fraction rounded up); one past the last use says so ----
test("Web Wallet: a damaged entry's old count (57, \"57\", 57.5, \"57.5\") is a floor; one at or past 262144 gives the over-count explanation; the window refuses a typed fraction and says the figure main kept", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json");
  const FROM = "0x" + "A8".repeat(32), PK = "0x" + "B8".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } }
    : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "C8".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  await ww.derive("alpha beta"); ww.setOnchain(async () => 3);
  for (const [old, floor] of [["57", 57], [" 57 ", 57], [57.5, 58], ["57.5", 58]]) {
    fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: old, ack: true } }));
    assert.deepEqual(ww.keyusesInfo(FROM), { address: FROM, keyuses: floor, ack: false, damaged: true }, "the window is offered the old figure: " + JSON.stringify(old));
    await assert.rejects(ww.ackKeyuses(FROM, floor - 1), new RegExp("This key's saved count read " + floor + " before it was damaged\\. Confirm at least that many"), JSON.stringify(old));
    assert.deepEqual(await ww.ackKeyuses(FROM, floor), { address: FROM, keyuses: floor, ack: true });
  }
  for (const old of ["x", "", "-4", "5e3", null, true]) { fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: old, ack: true } })); assert.equal(ww.keyusesInfo(FROM).keyuses, 0, "no count read from " + JSON.stringify(old)); }
  for (const old of [1000000, "1000000", 262144]) {
    fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: old + (typeof old === "number" ? 0.5 : "") , ack: true } }));
    await assert.rejects(ww.ackKeyuses(FROM, 262143), /saved key-use count \(\d+\) is above the limit of a key of this wallet \(262144 one-time uses, numbered 0 to 262143\)\. It was probably confirmed too high before this version checked it, .* Nothing was saved\./, "never 'confirm at least " + old + "'");
  }
  ww.setOnchain(async () => null);
  const Act = require("../renderer/apps-act.js"), app = rd("renderer/app.js");
  for (const bad of ["7.9", "-5", "abc", "1e3", "3 4"]) { assert.equal(Act.ww.wholeCount(bad), false, bad); assert.ok(Number.isNaN(Act.ww.confirmUses(bad, 3)), bad + ": refused, not floored"); }
  for (const ok of ["", " 12 ", "0", 7]) assert.equal(Act.ww.wholeCount(ok), true, String(ok));
  assert.ok(app.includes('if (!AppsAct.ww.wholeCount(typed)) { toast(t("The key uses must be a whole number of at least 0."), "err"); return; }'), "Confirm refuses a typed fraction before anything is read or saved");
  assert.ok(app.includes('toast(t("Secret key uses confirmed: {n}", { n: wwKu.keyuses }), "ok")'), "the toast says the figure main kept");
  assert.ok(/\.toast--copy \{[^}]*overflow-wrap: anywhere/.test(rd("renderer/app.css")), "a whole id in a toast wraps instead of running off the window");
});

// ---- 0.19.333: the Web Wallet is off, in main, on a block key wallet (a seed gives another address there; the count protects nothing) ----
test("Web Wallet on a block key wallet: derive, read, send, the key-use confirmation and its read are refused in main with one sentence; nothing reaches the node", async () => {
  const ww = require("../main/webwallet"), sent = [];
  ww._setRunner(async (c) => { sent.push(c); return { status: true, response: { megammr: true } }; });
  ww.setKeyMode(() => "block");
  const WHY = /^(?:Error: )?The Web Wallet is not available on a block key wallet yet: here a seed gives a different address than on a classic wallet or the official Web Wallet, and the key-use count does not protect it\. Nothing was done\.$/;
  await assert.rejects(ww.derive("alpha beta"), WHY); await assert.rejects(ww.read("0x" + "11".repeat(32), false), WHY);
  await assert.rejects(ww.send({ seed: "alpha beta", to: "0x" + "11".repeat(32), amount: "1", tokenid: "0x00" }), WHY); await assert.rejects(ww.ackKeyuses("0x" + "A9".repeat(32), 1), WHY);
  assert.throws(() => ww.keyusesInfo("0x" + "A9".repeat(32)), WHY);
  assert.deepEqual(sent, [], "nothing reached the node");
  ww.setKeyMode(() => "classic"); await ww.derive("alpha beta").catch(() => {}); assert.ok(sent.length > 0, "a classic wallet goes on");
  ww.setKeyMode(() => { throw new Error("config unreadable"); }); await ww.derive("alpha beta").catch((e) => assert.doesNotMatch(e.message, WHY));
  ww.setKeyMode(() => "");
  assert.ok(rd("main/main.js").includes("webwallet.setKeyMode(() => config.load().keyMode);"), "main gives it the recorded key mode");
});

// ---- 0.19.334: a damaged old count too large for a number (1e400) is over every limit, never 0 ----
test("Web Wallet: a damaged old count of 1e400 or a digit run too long for a number gives the over-count explanation", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AA".repeat(32), PK = "0x" + "BA".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } } : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CA".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  ww.setKeyMode(() => "classic"); await ww.derive("alpha beta"); ww.setOnchain(async () => 3);
  for (const raw of ['{"keyuses":1e400,"ack":true}', '{"keyuses":"' + "9".repeat(400) + '","ack":true}']) {
    fs.writeFileSync(file, '{"' + FROM + '":' + raw + "}");
    assert.equal(ww.keyusesInfo(FROM).keyuses, Infinity, raw.slice(0, 30));
    await assert.rejects(ww.ackKeyuses(FROM, 5), /saved key-use count \(Infinity\) is above the limit of a key of this wallet/, raw.slice(0, 30));
  }
  ww.setOnchain(async () => null); ww.setKeyMode(() => "");
});

// ---- 0.19.340 (as released 0.18.274 / 0.18.279): for an entry not yet confirmed main reads the chain first: a chain figure at the limit gets the
// at-the-limit explanation even when the window sent max(typed, chain); a figure above the ceiling with the service unreadable gets the ceiling ----
test("Web Wallet: an unconfirmed entry's chain figure is read before the ceiling: 262144 from the chain is explained as at the limit; above the ceiling with the chain unread gets the ceiling message", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AB".repeat(32), PK = "0x" + "BB".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } } : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CB".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : { status: true, response: {} });
  try { fs.rmSync(file); } catch (e) {}
  ww.setKeyMode(() => "classic"); await ww.derive("alpha beta");
  let chain = 262144; ww.setOnchain(async () => chain);
  await assert.rejects(ww.ackKeyuses(FROM, 262144), /^Error: The chain's figure for this key \(262144\) is at or above the limit of a key of this wallet/, "what the window sends, max(typed, chain): the chain's figure explained");
  chain = null; await assert.rejects(ww.ackKeyuses(FROM, 300000), /^Error: The key-use count can be at most 262143/, "above the ceiling while the chain is unread: the ceiling, not 'could not be read'");
  await assert.rejects(ww.ackKeyuses(FROM, 5), /could not be read/, "within the ceiling while unread: the chain could not be read");
  ww.setOnchain(async () => null); ww.setKeyMode(() => "");
});

// ---- 0.19.341: the Web Wallet's key-use refusals are the released tree's words exactly (main/webwallet.js there) ----
test("Web Wallet: the ceiling, the chain at the limit, the over-count (sent and saved) and the damaged floor say the released tree's words; ' 5 ' is not a count", async () => {
  const ww = require("../main/webwallet"), file = path.join(DIR, "webwallet-keyuses.json"), FROM = "0x" + "AC".repeat(32), PK = "0x" + "BC".repeat(32), TO = "0x" + "11".repeat(32);
  ww._setRunner(async (c) => c === "status" ? { status: true, response: { megammr: true } } : c.startsWith("keys action:genkey") ? { status: true, response: { address: FROM, script: "RETURN SIGNEDBY(" + PK + ")", privatekey: "0x" + "CC".repeat(32), publickey: PK } }
    : c.startsWith("keys action:list") ? { status: true, response: { keys: [] } } : c.startsWith("checkaddress") ? { status: true, response: { "0x": TO } } : { status: true, response: {} });
  ww.setKeyMode(() => "classic"); await ww.derive("alpha beta"); let chain = 3; ww.setOnchain(async () => chain);
  const msg = async (p) => { try { await p; return ""; } catch (e) { return e.message; } };
  try { fs.rmSync(file); } catch (e) {}
  assert.equal(await msg(ww.ackKeyuses(FROM, 262144)), "The key-use count can be at most 262143 (a key of this wallet has 262144 one-time uses, numbered 0 to 262143). Nothing was saved.");
  assert.equal(await msg(ww.ackKeyuses(FROM, " 5 ")), "The key uses must be a whole number of at least 0.");
  chain = 262144; assert.equal(await msg(ww.ackKeyuses(FROM, 262144)), "The chain's figure for this key (262144) is at or above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). The figure can count more uses than the key signed, but this app will not sign from this address: signing past the last use would reuse a one-time key, which can lose funds. Nothing was saved.");
  const go = () => msg(ww.send({ seed: "alpha beta", to: TO, amount: "1", tokenid: "0x00" }));
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 262144, ack: true } }));
  assert.equal(await go(), "This wallet's count for this key has reached the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.");
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: 300000, ack: true } }));
  assert.equal(await go(), "This wallet's saved key-use count (300000) is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.");
  chain = 3; fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: "57", ack: true } }));
  assert.equal(await msg(ww.ackKeyuses(FROM, 10)), "This key's saved count read 57 before it was damaged. Confirm at least that many. Nothing was saved.");
  fs.writeFileSync(file, JSON.stringify({ [FROM]: { keyuses: "300000", ack: true } }));
  assert.equal(await msg(ww.ackKeyuses(FROM, 10)), "This wallet's saved key-use count (300000) is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was saved.");
  ww.setOnchain(async () => null); ww.setKeyMode(() => "");
});

// ---- 0.19.343: a collect never pays out more than the coin; its change is the coin less the payout, exactly ----
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
    block = tip; vars = v; await vestr.list(); sent = [];   // changed on purpose (0.19.347): the list read forgets a collected coin no longer listed
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

// ---- 0.19.347 (as released 0.18.291 / 0.18.292): Vestr never builds a second collect of a coin already being collected; the node judges every collect before it is posted;
// the refusals come in the order shape, tip, nothing available, grace; the grace wait counts the age at the tip ----
const vestrRig = () => {
  const vestr = require("../main/vestr");
  const COIN = "0x9A0F5C6E1D2B3A4958677685A4B3C2D1E0F9A8B7C6D5E4F3A2B1C0D9E8F7A6B5", UNLOCK = "0x" + "5E".repeat(32);
  const st = (o) => [[0, UNLOCK], [1, "1000"], [2, "100"], [3, "1100"], [4, "10"], [5, "1"], [6, "1"], [7, "0"], [8, "2"], [199, "0xAB"]].map(([port, data]) => ({ port, data: o && o[port] != null ? o[port] : data }));
  const R = { vestr, COIN, st, sent: [], listed: true };
  vestr._setRunner(async (c) => {
    R.sent.push(c);
    if (c.startsWith("newscript")) return { status: true, response: { address: vestr.CONTRACT } };
    if (c === "block") { if (R.tip === "throw") throw new Error("timed out"); return R.tip; }
    if (R.coinRead !== undefined && c === "coins coinid:" + R.COIN + " checkmempool:true") { if (R.coinRead === "throw") throw new Error("timed out"); return R.coinRead; }   // the pre-check's answer
    if (c.startsWith("coins coinid:") || c.startsWith("coins address:")) return { status: true, response: R.listed ? [R.coin] : [] };   // a node that still lists the coin (as one without the mempool flag)
    if (c.startsWith("runscript")) return { status: true, response: { variables: R.vars } };
    if (c.startsWith("txncheck")) return R.txncheck;
    if (c.startsWith("txnpost")) return R.post;
    return { status: true, response: {} };
  });
  R.OK = { status: true, response: { validamounts: true, validtransaction: true, valid: { basic: true, mmrproofs: true, scripts: true } } };
  R.SCRIPTS_FALSE = { status: true, response: { validamounts: true, validtransaction: false, valid: { basic: true, mmrproofs: true, scripts: false } } };
  R.reset = async (o) => { R.listed = false; await vestr.list(); R.coin = Object.assign({ coinid: COIN, tokenid: "0x00", amount: "900", created: "100", address: vestr.CONTRACT, state: st() }, o);
    R.listed = true; R.coinRead = undefined; R.tip = { status: true, response: { block: "600" } }; R.vars = { cancollect: "400", change: "500", mustwait: "FALSE", contractexpired: "FALSE" }; R.txncheck = R.OK; R.post = { status: true, response: {} }; R.sent = []; };
  R.txns = () => R.sent.filter(c => /^txn/.test(c)).map(c => c.split(" ")[0]);
  R.collect = () => vestr.collect(COIN, "");
  R.done = () => vestr._setRunner(() => { throw new Error("no node in a test"); });
  return R;
};
// changed on purpose (0.19.351, as released 0.18.296): the session list of collected coins is gone (it refused a valid collect after a post that did not
// take); the node's checkmempool:true answer decides, by the phone's rule (base-vestr-2.2.76 Contract.alreadySpending)
test("Vestr collect (V1): both reads send checkmempool:true; a clean empty answer is refused with the phone's sentence, nothing built, after the tip refusal; a failed or malformed answer does not block", async () => {
  const R = vestrRig();
  await R.reset(); assert.equal((await R.collect()).ok, true);
  assert.ok(R.sent.includes("coins coinid:" + R.COIN + " checkmempool:true"), R.sent.join(" | ")); await R.vestr.list(); assert.ok(R.sent.includes("coins address:" + R.vestr.CONTRACT + " relevant:true checkmempool:true"));
  R.sent = []; assert.equal((await R.collect()).ok, true, "collected again while the node lists it (not in its mempool): no session list");
  await R.reset(); R.listed = false;
  await assert.rejects(R.collect(), /^Error: A collect of this coin is already waiting for the chain, or the coin is already spent\. Nothing was sent\.$/); assert.deepEqual(R.txns(), [], "nothing built");
  // a node with no tip lists nothing: the tip refusal comes first
  for (const tp of ["throw", { status: true, response: { block: "0" } }]) {
    await R.reset(); R.listed = false; R.tip = tp;
    await assert.rejects(R.collect(), /^Error: The node's block height could not be read, so nothing was built\. Nothing was sent\.$/, JSON.stringify(tp)); assert.deepEqual(R.txns(), []);
  }
  // a failed or malformed answer does not block: the coin is read without the flag, and txninput and txncheck judge the collect
  for (const bad of ["throw", null, { status: false, error: "Invalid parameter : checkmempool" }, { status: true, response: {} }, { status: false, response: [] }]) {
    await R.reset(); R.coinRead = bad;
    assert.equal((await R.collect()).ok, true, JSON.stringify(bad)); assert.ok(R.sent.includes("coins coinid:" + R.COIN), "read without the flag"); assert.ok(R.txns().includes("txnpost"));
  }
  await R.reset(); R.coinRead = null; R.listed = false; await assert.rejects(R.collect(), /^Error: Contract coin not found \(already collected\?\)$/, "neither read finds it");
  assert.ok(!/collectedHere/.test(rd("main/vestr.js")));
  R.done();
});
// the review's scenario (0.19.351, as released 0.18.296): an unanswered post, the coin still listed and not in the mempool, three list refreshes: collected again
test("Vestr collect (V4): after a post the node did not answer, a coin still listed (not in the mempool) can be collected again", async () => {
  const R = vestrRig();
  await R.reset(); R.post = undefined; await assert.rejects(R.collect(), /may have been posted|may have gone/);
  R.post = { status: true, response: {} };
  for (let i = 0; i < 3; i++) await R.vestr.list();
  R.sent = []; assert.deepEqual(await R.collect(), { ok: true, collected: "400", tokenid: "0x00" }); assert.ok(R.txns().includes("txnpost"));
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
  await R.reset(); R.txncheck = { status: false, error: "Transaction not found" }; await assert.rejects(R.collect(), /collect step failed: Transaction not found/); assert.ok(!R.txns().includes("txnpost"));
  await R.reset(); assert.equal((await R.collect()).ok, true); assert.deepEqual(R.txns().slice(-3), ["txncheck", "txnpost", "txndelete"]);
  R.done();
});
test("Vestr collect (V3): the coin's shape, then the tip, then nothing available, then the grace wait, counted at the tip (as txncheck and the node's relay check)", async () => {
  const R = vestrRig();
  await R.reset({ state: R.st({ 4: "abc" }) }); R.tip = "throw"; await assert.rejects(R.collect(), /^Error: This contract coin's state is not one this app can carry\. Nothing was signed\.$/, "the shape first, whatever the tip (a grace of abc read as a number was NaN: no wait)");
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
test("Vestr collect: a pending reply to txnpost is not 'collected' (as this tree already did; the released tree since 0.18.291)", async () => {
  const R = vestrRig();
  await R.reset(); R.txncheck = R.OK; R.post = { pending: true, status: false }; await assert.rejects(R.collect(), /collect step failed/);
  R.done();
});
test("Vestr: decSub gives \"\" for a figure it cannot read (it gave \"0\"), and a collect whose payout cannot be compared with the coin is refused", async () => {
  const R = vestrRig();
  await R.reset({ amount: "9e2" }); await assert.rejects(R.collect(), /state is not one this app can carry/, "an amount that is not plain: refused by its shape");
  await R.reset(); R.vars = { cancollect: "400", change: "500", mustwait: "FALSE", contractexpired: "FALSE" };
  const l = await R.vestr.list(); assert.equal(l[0].collected, "100");
  await R.reset({ state: R.st({ 1: "1e3" }) }); const [v] = await R.vestr.list(); assert.equal(v.collected, "", "unreadable: shown as nothing, never as 0");
  R.done();
});
