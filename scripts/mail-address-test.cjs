/*
 * mail-address-test.cjs — the Mail merged from 0.18.65 to 0.18.69, and what 0.19.x adds, in the main process, run on a store in a temp folder with a recorded
 * node (no Electron, no node, no socket: scripts/no-reach.cjs).
 *
 * Vectors: apks/mail app/src/androidTest/java/com/eurobuddha/mail/PublicAddressTest.java (identity from the vault
 * seed, six words, signed card, link rules, the currency picker) and app/src/test/.../MailBeaconTest.java (the
 * beacon's creation block; a renewal posts only after a successful, empty lookup with a signable coin).
 *
 * Run: node --test scripts/mail-address-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const leak = require("./no-reach.cjs").install();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcd-mail-"));
const root = path.resolve(__dirname, "..");
const fake = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, children: [], paths: [], exports }; };
fake(require.resolve("electron"), { app: { getPath: () => dir } });
const secrets = {};
fake(require.resolve(path.join(root, "main/config.js")), { getSecret: (a) => secrets[a] || null, setSecret: (v, a) => { secrets[a] = v; }, deleteSecret: (a) => { delete secrets[a]; }, rpcSecret: () => "" });
fake(require.resolve(path.join(root, "main/node-manager.js")), { rpcPort: () => 0, log() {} });
fake(require.resolve(path.join(root, "main/sendpin.js")), { pinMinimaSend: async (run, cmd) => { const r = await run("coins relevant:true sendable:true"); return r && r.fund ? cmd + " fromaddress:" + r.fund : cmd; } });

// an older store: the file must be copied aside before this version writes to it
const OLD = JSON.stringify({ version: 1, messages: {}, contacts: {}, meta: { myname: "Fixture" } });
fs.writeFileSync(path.join(dir, "mail.json"), OLD);

const codec = require("../main/mailaddress");
const mail = require("../main/mail");
const store = require("../main/mail-store");

const SEED = "0x" + "a5".repeat(32);
const ME = "0xf1c17825d7c99e703a34e7bc20b13653de34f663fd9ab91a771d2c03b79abb0f9ca62f408455ca596471b9476fb61a7755d4af8d59cfaf9eba634f97d616e002";
const KEY = "0xf5c4c50a4d94600b5e627399c7c5f425a10e48eb0b30f8f7f31e121b77a0474f1670f4a31f47d1d404648a8e118e6aa0ae5fef863163c89ac90e333f208269c6";
const WORDS = "reunion-sting-lazy-tornado-liberty-bubble";
const SIG = "27c067e038ba079f96ff07b42e0c26e49ee5a91db0963edf364e846192aec8479bde0782bd70c669e956ba3d3f4d6f4a3cad5b4c6fd61f955794690536d5ca05";
const FUND = "0x" + "AB".repeat(32);
const beacon = (words, key, sig, created) => ({ address: codec.ADDRESS, tokenid: "0x00", created, state: { 0: codec.tag(words), 1: key, 2: "0x" + sig } });

let lookup = () => ({ status: true, response: [] }), fund = FUND, balance = [], sends = [], asked = [];
mail._setRunner(async (cmd) => {
  asked.push(cmd);
  if (cmd === "vault action:seed") return { status: true, response: { locked: false, seed: SEED, phrase: "fixture words" } };
  if (cmd === "getaddress") return { status: true, response: { miniaddress: "MxG0FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTURE00" } };
  if (cmd.startsWith("coinnotify")) return { status: true };
  if (cmd.startsWith("coins address:" + codec.ADDRESS)) return lookup(cmd);
  if (cmd.startsWith("coins relevant:")) return { fund };
  if (cmd === "balance") return { status: true, response: balance };
  if (cmd === "block") return { status: true, response: { block: 2427900 } };
  if (cmd.startsWith("checkaddress ")) return { status: true, response: { simple: true } };
  if (cmd.startsWith("send ")) { sends.push(cmd); return { status: true, response: { txpowid: "0x" + "FA4E".repeat(16) } }; }
  return { status: false, error: "unexpected in a test: " + cmd };
});
const settle = () => new Promise((r) => setTimeout(r, 400));   // the store writes 300 ms after a change

test("the unlocked vault produces the phone's Mail identity and six words (PublicAddressTest)", async () => {
  await mail.init();
  const me = mail.myIdentity();
  assert.equal(me.publicId, ME);
  assert.equal(me.words, "assist-purpose-unveil-talk-tomato-subject");
  assert.equal(me.theme, "light", "Paper unless the owner chose Dark");
});

test("the store of the older version is kept aside, byte for byte, before the first write", async () => {
  await settle();
  assert.equal(fs.readFileSync(path.join(dir, "mail.json.before-0.18.148"), "utf8"), OLD);
  const now = JSON.parse(fs.readFileSync(path.join(dir, "mail.json"), "utf8"));
  assert.equal(now.version, 1); assert.equal(now.rev, 2);
  assert.equal(now.meta.myname, "Fixture", "nothing that was there is lost");
});

test("0.19.9: nothing is posted for this install's own address until the one-time notice is answered; publishing stays the default choice", async () => {
  const cardOf = async () => codec.card(await require("../main/mailcrypto").ready(), await require("../main/mailcrypto").deriveIdentity(SEED));
  const mine = await cardOf();
  assert.equal(store.metaGet("mail-address-notice"), undefined);
  assert.equal(mail.myIdentity().published, false, "not said to be published before the owner has chosen");
  sends = []; lookup = () => ({ status: true, response: [] }); fund = FUND;
  for (let i = 0; i < 3; i++) await mail._renewAddresses();
  assert.equal(sends.length, 0, "the renewal loop finds no beacon, has a coin, and still posts nothing");
  lookup = () => ({ status: false });
  assert.equal(await mail.publishNoticeDue(), false, "the chain cannot be read: not asked yet (and nothing posted)");
  lookup = () => ({ status: true, response: [] });
  assert.equal(await mail.publishNoticeDue(), true, "no beacon of ours on chain: the notice is due");
  assert.equal(sends.length, 0);
  // "Don't publish": off, remembered, never posted
  let me = await mail.answerPublishNotice(false);
  assert.equal(me.published, false); assert.equal(store.metaGet("mail-address-off:" + ME), true); assert.equal(store.metaGet("mail-address-notice"), "declined");
  await mail._renewAddresses(); assert.equal(sends.length, 0);
  assert.equal(await mail.publishNoticeDue(), false, "one time only");
  // the other answer, on an install that has not answered: the card is posted at once
  store.metaSet("mail-address-notice", undefined); store.metaSet("mail-address-off:" + ME, false); store.metaSet("mail-address-publications", { [ME]: { card: mine, next: Date.now() + 3600000, pending: false } });
  assert.equal(await mail.publishNoticeDue(), true);
  me = await mail.answerPublishNotice(true);
  assert.equal(me.published, true); assert.equal(store.metaGet("mail-address-notice"), "publish");
  assert.equal(sends.length, 1, "posted now, not four hours later"); assert.ok(sends[0].includes(codec.tag(mine.phrase)));
  // an install whose card is already on chain (published by 0.18.67 to 0.19.8) is not asked: there is nothing to choose
  store.metaSet("mail-address-notice", undefined);
  lookup = () => ({ status: true, response: [beacon(mine.phrase, mine.key, mine.sig, "2427000")] });
  assert.equal(await mail.publishNoticeDue(), false); assert.equal(store.metaGet("mail-address-notice"), "published-before");
  assert.equal(mail.myIdentity().published, true);
  sends = []; lookup = () => ({ status: true, response: [] });
});

test("the owner's address is published by default and a stop is remembered (0.5.22)", async () => {
  assert.equal(mail.myIdentity().published, true);
  await mail.setPublication(ME, false);
  assert.equal(mail.myIdentity().published, false);
  assert.equal(store.metaGet("mail-address-off:" + ME), true);
  await mail.setPublication(ME, true);
  assert.equal(mail.myIdentity().published, true);
  assert.equal(store.metaGet("mail-address-off:" + ME), false);
});

test("a renewal posts only after a successful, empty lookup with a signable coin (MailBeaconTest)", async () => {
  const sodium = await require("../main/mailcrypto").ready();
  const mine = codec.card(sodium, { publicId: ME, signSk: null, ...(await require("../main/mailcrypto").deriveIdentity(SEED)) });
  const run = async (reply, enabled, pending, coin) => {
    sends = []; asked = []; lookup = () => reply; fund = coin === undefined ? FUND : coin;
    const jobs = {}; if (enabled) jobs[ME] = { card: mine, next: 0, pending };
    store.metaSet("mail-address-publications", jobs);
    await mail._renewAddresses().catch(() => {});   // a failed read throws to the loop, which ignores it
    return sends.length;
  };
  const empty = { status: true, response: [] }, fresh = { status: true, response: [beacon(mine.phrase, mine.key, mine.sig, "2427841")] };
  assert.equal(await run(fresh, true, false), 0, "already visible");
  assert.equal(await run({ status: false }, true, false), 0, "a failed read is not an empty one");
  assert.equal(await run(empty, false, false), 0, "not enabled");
  assert.equal(await run(empty, true, true), 0, "an earlier post of unknown outcome is never repeated");
  assert.equal(await run(empty, true, false, ""), 0, "no signable coin");
  assert.equal(await run(empty, true, false), 1);
  assert.ok(asked.some((c) => c.startsWith("coins address:" + codec.ADDRESS) && c.includes(" depth:1000") && c.includes(" state:" + codec.tag(mine.phrase))));
  assert.ok(sends[0].startsWith("send amount:0.000000001 address:" + codec.ADDRESS + " tokenid:0x00 state:"));
  assert.ok(sends[0].endsWith(" fromaddress:" + FUND));
  assert.deepEqual(JSON.parse(/state:(\{.*\}) fromaddress/.exec(sends[0])[1]), { 0: codec.tag(mine.phrase), 1: ME, 2: "0x" + mine.sig });
});

test("the live beacon check gives the creation block (0.5.23)", async () => {
  const sodium = await require("../main/mailcrypto").ready();
  const id = await require("../main/mailcrypto").deriveIdentity(SEED), mine = codec.card(sodium, id);
  lookup = () => ({ status: true, response: [beacon(mine.phrase, mine.key, mine.sig, "2427841"), beacon(mine.phrase, mine.key, mine.sig, "2427000")] });
  assert.deepEqual(await mail.checkOwnBeacon(), { block: 2427841 });
  lookup = () => ({ status: true, response: [beacon(mine.phrase, mine.key, mine.sig)] });
  assert.deepEqual(await mail.checkOwnBeacon(), { block: 0 });
  lookup = () => ({ status: true, response: [] });
  assert.equal(await mail.checkOwnBeacon(), null);
  lookup = () => ({ status: false });
  await assert.rejects(mail.checkOwnBeacon(), /Could not read Mail address beacons/);
});

test("six words resolve before sending: known keys first, then the signed beacon; a forged card is nothing", async () => {
  sends = [];
  lookup = () => ({ status: true, response: [beacon(WORDS, KEY, SIG, "2427841")] });
  assert.equal(await mail.resolveRecipient("  Reunion sting lazy tornado LIBERTY bubble "), KEY);
  lookup = () => ({ status: true, response: [beacon("assist-purpose-unveil-talk-tomato-subject", ME, "00".repeat(64), "1")] });
  assert.equal(await mail.resolveRecipient("assist purpose unveil talk tomato subject"), ME, "our own words need no beacon");
  lookup = () => ({ status: true, response: [beacon(WORDS, KEY, "00" + SIG.slice(2), "1")] });
  await assert.rejects(mail.resolveRecipient("lemon sting lazy tornado liberty bubble"), /No published address found on this node/);
  await assert.rejects(mail.resolveRecipient("five words are not enough"), /Enter six address words, a contact link or a Mail key\./);
  assert.equal(await mail.resolveRecipient(KEY.slice(2).toUpperCase()), KEY, "a key without 0x");
  assert.equal(await mail.resolveRecipient(WORDS + "\n" + codec.link(KEY)), KEY);
  await assert.rejects(mail.resolveRecipient(codec.link(KEY).replace("reunion", "lemon")), /Enter six address words/);
  assert.equal(sends.length, 0, "looking up never sends");
});

test("address rules of MailAddress.java (PublicAddressTest)", () => {
  assert.equal(codec.display(KEY.slice(2)), WORDS);
  assert.equal(codec.display("Odile"), "Odile");
  assert.equal(codec.direct(codec.link(KEY)), KEY);
  assert.equal(codec.direct(WORDS.replace("reunion", "lemon") + "\n" + codec.link(KEY)), null);
  assert.equal(codec.direct(codec.link(KEY) + "|address"), null);
});

test("Send funds offers Minima and MxUSD only, by token id, with the sendable balance (PaymentCurrency)", async () => {
  const meta = JSON.stringify({ name: "MxUSD", description: "unrelated token" });
  balance = [{ tokenid: "0x" + KEY.slice(2, 66), sendable: "100", token: meta }, { tokenid: "0x00", confirmed: "9" }];
  assert.deepEqual(await mail.payOptions(), [{ tokenid: "0x00", name: "Minima", balance: "9" }, { tokenid: mail.MXUSD, name: "MxUSD", balance: "0" }]);
  balance.push({ tokenid: mail.MXUSD.toLowerCase(), confirmed: "3", sendable: "0.001" });
  assert.deepEqual((await mail.payOptions())[1], { tokenid: mail.MXUSD, name: "MxUSD", balance: "0.001" });
  assert.equal(mail.MXUSD, "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90");
});

test("a payment: only the two currencies, the command as before, the receipt in the thread it was sent from", async () => {
  const PAY = "MxG0PAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEE00";
  sends = []; fund = "";   // the pin itself is main/sendpin.js, tested in mail-test.cjs
  await assert.rejects(mail.pay(KEY, PAY, "0.25", mail.MXUSD, "MxUSD", "", ""), /Confirm the recipient's Mail key first/);   // 0.19.9: KEY was resolved from six words through a beacon above
  mail.confirmRecipient(KEY);
  await assert.rejects(mail.pay(KEY, PAY, "1", "0x" + KEY.slice(2, 66), "MxUSD", "", ""), /Minima and MxUSD only/);
  assert.equal(sends.length, 0);
  const m = await mail.pay(KEY, PAY, "0.25", mail.MXUSD.toLowerCase(), "anything", "for the stall", "Saturday market");
  assert.equal(sends[0], "send amount:0.25 address:" + PAY + " tokenid:" + mail.MXUSD, "the payment command is built as it always was");
  assert.equal(m.type, "payment"); assert.equal(m.tokenname, "MxUSD"); assert.equal(m.tokenid, mail.MXUSD); assert.equal(m.amount, "0.25");
  assert.equal(m.subject, "Saturday market");
  assert.equal(m.hashref, mail.threadKey(ME, KEY, "Saturday market"));
  assert.equal(sends.length, 2, "one payment, one receipt coin");
});

test("0.19.9: six words found only through a beacon: the whole key and the beacon's age come back, and nothing is sent to that key until it is confirmed", async () => {
  const mc = require("../main/mailcrypto"), sodium = await mc.ready();
  const stranger = await mc.deriveIdentity("0x" + "c3".repeat(32)), card = codec.card(sodium, stranger), K = stranger.publicId;
  lookup = () => ({ status: true, response: [beacon(card.phrase, card.key, card.sig, "2427890"), beacon(card.phrase, card.key, card.sig, "2400000")] });
  const d = await mail.resolveDetail(card.phrase.replace(/-/g, " "));
  assert.deepEqual(d, { key: K, via: "beacon", block: 2427890, first: 2400000, tip: 2427900, confirm: true });
  assert.equal(d.key.length, 2 + 128, "the whole key");
  sends = []; fund = "";
  await assert.rejects(mail.sendMessage(K, { message: "hello" }), /Confirm the recipient's Mail key first/);
  await assert.rejects(mail.pay(K, "MxG0PAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEE00", "1", "0x00", "Minima", "", ""), /Confirm the recipient's Mail key first/);
  assert.equal(sends.length, 0, "no mail and no payment before the confirmation");
  await assert.rejects((async () => mail.confirmRecipient("0x12"))(), /Invalid Mail key/);
  assert.equal(mail.confirmRecipient(K), true);
  await mail.sendMessage(K, { message: "hello" });
  assert.equal(sends.length, 1, "after it: sent");
  const again = await mail.resolveDetail(card.phrase);
  assert.equal(again.via, "sent"); assert.equal(again.confirm, false, "the FIRST send only: now a key we have written to");
  // the other ways a recipient is known need no confirmation
  assert.deepEqual(await mail.resolveDetail(KEY), { key: KEY, via: "key", confirm: false });
  assert.deepEqual(await mail.resolveDetail(codec.link(KEY)), { key: KEY, via: "link", confirm: false });
  assert.equal((await mail.resolveDetail(WORDS)).via, "sent", "the payment above went to this key");
  // a key known ONLY from mail it sent us is not trusted for its words either
  const other = await mc.deriveIdentity("0x" + "d4".repeat(32)), OK2 = other.publicId;
  store.addMessage({ hashref: mail.threadKey(ME, OK2, ""), randomid: "r-in", frompublickey: OK2, topublickey: ME, incoming: true, subject: "", message: "hi", date: Date.now(), type: "text" });
  const r = await mail.resolveDetail(codec.phrase(OK2));
  assert.equal(r.via, "received"); assert.equal(r.confirm, true);
  await assert.rejects(mail.sendMessage(OK2, { message: "re" }), /Confirm the recipient/);
  store.addContact(OK2, "Saved by hand");
  assert.equal((await mail.resolveDetail(codec.phrase(OK2))).confirm, false, "a saved contact");
  await mail.sendMessage(OK2, { message: "re" });
});

test("0.19.9: the words of the two dialogs: what is published, that it is public and permanent and linked to a wallet address; the whole key and the beacon's age", () => {
  const win = { PayLabel: require("../renderer/paylabel.js"), micon: () => "" };
  new Function("window", fs.readFileSync(path.join(root, "renderer", "mail.js"), "utf8"))(win);
  const ui = win.MailPanel._test({});
  for (const need of [/six words, your Mail key and a signature/, /0\.000000001 MINIMA/, /public and permanent/, /cannot be removed/, /links your Mail address to that wallet address/, /Don't publish/])
    assert.match(ui.NOTICE_TEXT, need);
  const t = ui.confirmText({ key: KEY, via: "beacon", block: 2427890, first: 2400000, tip: 2427900, confirm: true });
  assert.ok(t.includes(KEY), "the whole key, not a short form"); assert.match(t, /first seen by this node at block 2400000 \(about 16 days ago, 27900 blocks\), last renewed at block 2427890/);
  assert.match(ui.confirmText({ key: KEY, via: "beacon", block: 0, first: 0, tip: 5, confirm: true }), /could not tell how old/);
  const r = ui.confirmText({ key: KEY, via: "received", confirm: true }); assert.ok(r.includes(KEY)); assert.match(r, /known only from mail it sent you/);
});

test("0.19.9: a wallet reset that cannot move the old mail aside says so and leaves the old inbox where it is", async () => {
  await settle();
  const file = path.join(dir, "mail.json"), before = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Object.keys(before.messages).length > 0, "there is an inbox to lose");
  const restoreMod = require("../main/restore"), realMove = restoreMod.moveAside;
  restoreMod.moveAside = () => { throw new Error("EACCES: the folder is read-only"); };
  try { assert.throws(() => mail.invalidateIdentity(), /EACCES/, "the failure reaches the reset chain's NOT reset list"); }
  finally { restoreMod.moveAside = realMove; }
  await settle();
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(after.messages).sort(), Object.keys(before.messages).sort(), "every old message is still in mail.json");
  assert.deepEqual(Object.keys(store.exportAll().messages).sort(), Object.keys(before.messages).sort(), "and still in the store: it was not emptied");
  // and when the move works, the old mail is in the dated file and the store starts empty
  mail.invalidateIdentity();
  assert.ok(fs.readdirSync(dir).some((f) => /^mail\.json-legacy-keys-\d{8}/.test(f)));
  assert.deepEqual(store.exportAll().messages, {});
});

test("nothing outside the process was reached", () => { assert.deepEqual(leak.reached, []); fs.rmSync(dir, { recursive: true, force: true }); });
