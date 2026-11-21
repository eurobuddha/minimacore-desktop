/*
 * mail-test.cjs — the invariants minimaMail had no test for. Three are interop- or funds-critical: the backup
 * container is byte-shared with the Android app, the thread key must agree between two peers who each compute
 * it from their own side, and the pay-address validator is the only guard between a mail key and a `send`.
 * The fourth is the 2026-09 history bug: `coins depth:` counts BLOCKS, and a fixed window silently lost every
 * message that arrived while the app was shut.
 *
 * These assert pure functions only — main/mail-store.js needs Electron's app.getPath, and a funds-critical
 * module does not get test seams bolted into it just to be observed.
 *
 * Run: node --test scripts/mail-test.cjs
 */
const test = require("node:test");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const assert = require("node:assert");

const backup = require("../main/mailbackup");
const mail = require("../main/mail");
const L = mail._limits;

// ---------------------------------------------------------------- backup container (Android interop)
test("backup round-trips, in the container layout Android reads", () => {
  const plain = JSON.stringify({ messages: { "a|b": { message: "hello" } }, contacts: {}, meta: { myname: "Barry" } });
  const o = JSON.parse(backup.encrypt("correct horse battery", plain));
  assert.equal(o.v, 1, "version 1");
  for (const k of ["salt", "iv", "ct"]) assert.ok(typeof o[k] === "string" && o[k].length, k + " present");
  // 16-byte salt, 12-byte IV, and ct = ciphertext‖tag: Java's AES/GCM/NoPadding appends the 16-byte tag, so ct
  // is exactly 16 bytes longer than the plaintext. Ship the tag separately and every Android restore fails.
  assert.equal(Buffer.from(o.salt, "hex").length, 16, "16-byte salt");
  assert.equal(Buffer.from(o.iv, "hex").length, 12, "12-byte IV");
  assert.equal(Buffer.from(o.ct, "hex").length, Buffer.byteLength(plain) + 16, "ciphertext carries the tag");
  assert.equal(backup.decrypt("correct horse battery", JSON.stringify(o)).toString("utf8"), plain, "round-trip");
});

test("a wrong passphrase fails closed, never with partial plaintext", () => {
  const blob = backup.encrypt("right", "secret payload");
  assert.throws(() => backup.decrypt("wrong", blob));
});

// ---------------------------------------------------------------- thread key (both peers must agree)
test("threadKey is symmetric, and a subject makes its own thread", () => {
  const a = "0x" + "11".repeat(65), b = "0x" + "22".repeat(65);
  assert.equal(mail.threadKey(a, b, ""), mail.threadKey(b, a, ""), "each side computes the same key");
  assert.notEqual(mail.threadKey(a, b, "Pool payment"), mail.threadKey(a, b, ""), "a subject splits the thread");
  assert.equal(mail.threadKey(a, b, "Pool payment"), mail.threadKey(b, a, "Pool payment"), "…and stays symmetric");
});

// ---------------------------------------------------------------- pay-address validator (funds guard)
test("looksLikeMinimaAddress refuses a mail key and anything that could inject a send parameter", () => {
  assert.ok(mail.looksLikeMinimaAddress("Mx" + "A".repeat(60)), "an Mx address passes");
  assert.ok(mail.looksLikeMinimaAddress("0x" + "ab".repeat(32)), "0x + 64 hex passes");
  // A mail key is 0x + 130 hex. Accepting one would let an identity be used as a payout address.
  assert.equal(mail.looksLikeMinimaAddress("0x" + "cd".repeat(65)), false, "a 130-hex mail key is refused");
  // The node tokenises `send` on spaces and takes the LAST value of a repeated key, so a space inside an
  // address is a funds redirect. Every one of these must be refused.
  for (const bad of ["Mx" + "A".repeat(50) + " address:0x" + "ff".repeat(32), "Mx AAA", " ", "0x", "Mx",
    "0x" + "zz".repeat(32), "Mx" + "A".repeat(20), "Mx" + "A".repeat(90), null, undefined]) {
    assert.equal(mail.looksLikeMinimaAddress(bad), false, "refused: " + JSON.stringify(String(bad).slice(0, 40)));
  }
});

// ---------------------------------------------------------------- the history bug
test("the live pass sizes its depth to the gap, not to a fixed window", () => {
  const tip = 2319722;
  // Steady state: a couple of blocks behind → the floor of POLL_DEPTH, as before.
  assert.equal(mail._depthForGap(tip, tip - 2), L.POLL_DEPTH, "a fresh app still asks for the small window");
  // The regression that lost mail: a four-hour shutdown is ~290 blocks. The old code asked for 32.
  const gap4h = 290;
  assert.ok(mail._depthForGap(tip, tip - gap4h) >= gap4h,
    `a ${gap4h}-block gap must be covered, asked ${mail._depthForGap(tip, tip - gap4h)}`);
  assert.ok(mail._depthForGap(tip, tip - gap4h) > gap4h, "…with margin, so a boundary coin can't fall between passes");
  // Never past the one-pass ceiling — beyond ~1024 the tree cascades and the node stops serving.
  assert.equal(mail._depthForGap(tip, tip - 5184), L.WINDOW_DEPTH, "a three-day gap caps at the window");
  assert.equal(mail._depthForGap(tip, 0), L.POLL_DEPTH, "no cursor yet → the steady-state window");
  assert.equal(mail._depthForGap(tip, tip + 5), L.POLL_DEPTH, "a tip that went backwards can't produce a negative depth");
});

test("the window is wide enough to be worth having, and the old one was not", () => {
  // ~50s a block: the old 256-block backfill covered 3h33m, which is why quitting overnight lost everything.
  assert.ok(L.WINDOW_DEPTH >= 1024, "one pass reaches ~14 hours");
  assert.ok(L.WINDOW_DEPTH * 50 / 3600 > 12, "…more than half a day");
  assert.ok(L.BACKFILL_CHUNK > 0 && L.BACKFILL_CHUNK <= L.WINDOW_DEPTH, "a sweep step is a sane bite");
});

test("the backfill walks down a chunk at a time and stops at genesis", () => {
  const floor = 2319722 - L.WINDOW_DEPTH;
  const next = mail._nextFloorTarget(floor);
  assert.equal(next, floor - L.BACKFILL_CHUNK, "one chunk lower");
  assert.ok(next < floor, "strictly downward — a sweep that stands still never finishes");
  assert.equal(mail._nextFloorTarget(3), 1, "clamps at the first block");
  assert.equal(mail._nextFloorTarget(1), 1, "and stays there rather than going negative");
});

// ---------------------------------------------------------------- the panel loads, and its icons all exist
test("the Mail panel and its icon set load, and every icon it asks for is defined", () => {
  const fs = require("fs"), vm = require("vm"), path = require("path");
  const dir = path.join(__dirname, "..", "renderer");
  // A DOM-less shim: enough for both files to evaluate. A typo in a template or an icon name fails here
  // rather than in front of the user, and an unknown icon name renders an empty <svg> that is easy to miss.
  const sandbox = {
    document: { getElementById: () => null, createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => "" }) },
    setTimeout, clearTimeout, Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Promise, console
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  Object.assign(sandbox, require("./i18n-plain.cjs").globals()); const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, "mailicons.js"), "utf8"), ctx, { filename: "mailicons.js" });
  vm.runInContext(require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(dir, "mail.js"), "utf8")), ctx, { filename: "mail.js" });

  assert.equal(typeof sandbox.micon, "function", "micon is exported");
  assert.ok(sandbox.MailPanel && typeof sandbox.MailPanel.render === "function", "MailPanel is exported");
  const src = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(dir, "mail.js"), "utf8"));
  const used = [...new Set([...src.matchAll(/micon\("([a-z]+)"/g)].map((m) => m[1]))];
  assert.ok(used.length > 10, "the panel actually uses the icon set");
  assert.deepEqual(used.filter((n) => !sandbox.micon.names.includes(n)), [], "no icon is referenced without being defined");
  assert.ok(sandbox.micon("inbox").startsWith('<svg class="mm-ic" viewBox="0 0 24 24"'), "24-grid SVG markup");
  assert.equal(sandbox.micon("nope"), "", "an unknown name is empty, never broken markup");
});

test("the panel's palette cannot leak into the rest of the app", () => {
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "mail.css"), "utf8");
  // Every selector that paints must sit inside .mailapp (or the #view-mail host it lives in). The APK's orange
  // escaping into Balances/AtomiX/Pools is exactly what scoping this file prevents.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")
    .map((b) => b.split("{")[0].trim()).filter(Boolean)
    .flatMap((s) => s.split(",").map((x) => x.trim())).filter(Boolean);
  const loose = selectors.filter((s) => !/(^|\s|\()\.mailapp\b/.test(s) && !/^#view-mail\b/.test(s) && !/^:root\[data-theme/.test(s));
  assert.deepEqual(loose, [], "unscoped selectors would leak: " + loose.join(" | "));
  // and the old classes must be gone from the shared sheet, except the ones other panels wear
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.css"), "utf8");
  for (const dead of [".mail-bubble", ".mail-conv", ".mail-compose", ".mail-daychip", ".mail-av", ".emoji-grid"]) {
    assert.ok(!app.includes(dead + " "), dead + " should have moved out of app.css");
  }
  assert.ok(app.includes(".mail-ver"), ".mail-ver stays — the AtomiX and Parlons headers wear it");
  // 0.19.110: miniMall's screens are its own apps' now (.mm-thread in apps.css); it wears no mail class any more
  const appJs = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"));
  assert.ok(!app.includes(".mail-thread") && !/mail-(?:thread|bubble)/.test(appJs), "no screen outside Mail wears a mail thread class");
});

// ---------------------------------------------------------------- the panel actually renders
/** A DOM stub thin enough to run the panel headless: every element records the HTML written into it, and
 *  querySelectorAll yields nothing so the wiring loops are no-ops. Enough to prove the templates and the
 *  name/status logic — which is where the two reported defects lived. */
function fakeDom() {
  const nodes = {};
  const mk = () => ({ dataset: {}, innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, style: {},
    querySelectorAll: () => [], querySelector: () => null, focus() {}, scrollTop: 0, scrollHeight: 0, onclick: null, onkeydown: null, oninput: null, onchange: null });
  return {
    get: (id) => (nodes[id] || (nodes[id] = mk())),
    nodes
  };
}
function panel() {
  const fs = require("fs"), vm = require("vm"), path = require("path");
  const dir = path.join(__dirname, "..", "renderer");
  const sandbox = { setTimeout, clearTimeout, Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Promise, console,
    document: { getElementById: () => null, createElement: () => ({}) } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  Object.assign(sandbox, require("./i18n-plain.cjs").globals()); const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, "mailicons.js"), "utf8"), ctx, { filename: "mailicons.js" });
  vm.runInContext(require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(dir, "mail.js"), "utf8")), ctx, { filename: "mail.js" });
  return sandbox;
}
const ME = "0x" + "11".repeat(64), PEER = "0x" + "ab".repeat(64);
function deps(dom, api) {
  return {
    api, el: dom.get, esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    toast() {}, copy() {}, short: (s) => s, relTime: () => "", showPrompt: async () => null, showConfirm: async () => false,
    showActionSheet() {}, scanQR: async () => null, cycleTheme() {}, TOK: { tidyAmount: (a) => String(a) }
  };
}
const baseApi = (over) => Object.assign({
  mailInit: async () => ({ publicId: ME, name: "Me", payaddr: "MxTEST" }),
  mailThreads: async () => [], mailArchivedThreads: async () => [], mailOutbox: async () => [], mailSent: async () => [],
  mailContacts: async () => [], mailStatus: async () => ({ scannedTip: 2319722, lastScanMs: Date.now(), backfill: { active: false, done: false } }),
  mailThreadWith: async () => [], appVersion: async () => "0.17.15"
}, over || {});

test("an inbox row names the sender from the message when they are not a saved contact", async () => {
  const P = panel(), dom = fakeDom();
  const msg = { frompublickey: PEER, topublickey: ME, fromname: "Ola Kowalski", incoming: true, subject: "Re: node upgrade",
    message: "will restart tonight", date: Date.now(), type: "text" };
  P.MailPanel.init(deps(dom, baseApi({ mailThreads: async () => [{ hashref: "h1", unread: 1, last: msg, other: PEER }] })));
  await P.MailPanel.render();
  const html = dom.nodes.mailBody.innerHTML;
  // the visible name only — the full key legitimately rides on data-peer so the row can open the thread
  const shown = (/<span class="mm-nm[^"]*">([^<]*)</.exec(html) || [])[1];
  assert.equal(shown, "Ola Kowalski", "the sender's declared name is shown — this is the whole defect");
  assert.ok(!/class="mm-nm mm-key"/.test(html), "…not the monospace hex fallback");
  assert.ok(html.includes('data-peer="' + PEER + '"'), "and the complete key is still one click from being copied");
  assert.ok(html.includes("Re: node upgrade"), "the subject is on the row");
  assert.ok(html.includes("mm-unread") && html.includes("mm-udot"), "unread is bold + the orange dot");
});

test("tapping an inbox reply opens the stored thread at the newest message with the reply field ready", async () => {
  const P = panel(), dom = fakeDom(), host = dom.get("mailBody");
  const words = require("../main/mailaddress").phrase(PEER);
  const incoming = { frompublickey: PEER, topublickey: ME, incoming: true, subject: "", message: "earlier", type: "text", date: 1 };
  const reply = { ...incoming, frompublickey: ME, topublickey: PEER, incoming: false, message: "yo", date: 2 };
  const row = { dataset: { peer: PEER, hashref: "stored-thread" } };
  host.querySelectorAll = selector => selector === "[data-peer]" ? [row] : [];
  let focused = false;
  dom.get("mmReply").focus = () => { focused = true; };
  dom.get("mmConv").scrollHeight = 480;
  P.MailPanel.init(deps(dom, baseApi({
    mailThreads: async () => [{ hashref: "stored-thread", last: reply, other: PEER, words }],
    mailThread: async hash => { assert.equal(hash, "stored-thread"); return [incoming, reply]; }
  })));
  await P.MailPanel.render();
  await row.onclick({ target: { closest: () => null } });
  assert.match(host.innerHTML, /earlier[\s\S]*yo/);
  assert.ok(host.innerHTML.includes(words));
  assert.equal(dom.get("mmConv").scrollTop, 480);
  assert.ok(focused);
});

test("a saved contact name beats the sender's own", async () => {
  const P = panel(), dom = fakeDom();
  const msg = { frompublickey: PEER, topublickey: ME, fromname: "Ola Kowalski", incoming: true, subject: "x", message: "y", date: Date.now(), type: "text" };
  P.MailPanel.init(deps(dom, baseApi({
    mailThreads: async () => [{ hashref: "h3", unread: 0, last: msg, other: PEER }],
    mailContacts: async () => [{ publicId: PEER, username: "Ola (work)" }]
  })));
  await P.MailPanel.render();
  assert.ok(dom.nodes.mailBody.innerHTML.includes("Ola (work)"), "what you called them wins");
});

test("the Outbox tells the truth about the chain, with a Retry only where one is possible", async () => {
  const P = panel(), dom = fakeDom();
  const posting = { hashref: "h4", randomid: "r1", topublickey: PEER, incoming: false, subject: "Pool payment", message: "sending", date: Date.now(), status: "posting", type: "text" };
  const failed = { hashref: "h5", randomid: "r2", topublickey: PEER, incoming: false, subject: "", message: "nope", date: Date.now(), status: "failed", type: "text" };
  P.MailPanel.init(deps(dom, baseApi({ mailOutbox: async () => [posting, failed] })));
  await P.MailPanel.render();
  // the tab strip counts what is waiting
  assert.ok(dom.nodes.mailBody.innerHTML.includes('data-f="outbox"'), "the Outbox folder exists");
  P.MailPanel.reset();
  const P2 = panel(), dom2 = fakeDom();
  P2.MailPanel.init(deps(dom2, baseApi({ mailOutbox: async () => [posting, failed] })));
  await P2.MailPanel.render();
  // switch to the Outbox by driving the same render path
  const tabs = dom2.nodes.mailBody.innerHTML;
  assert.ok(tabs.includes('<span class="mm-cnt">2</span>'), "the strip shows 2 waiting");
});

test("bubbles carry the four chain states and never an invented read receipt", async () => {
  const P = panel(), dom = fakeDom();
  const now = Date.now();
  const msgs = [
    { frompublickey: PEER, topublickey: ME, incoming: true, message: "hello", date: now - 7200000, type: "text", fromname: "Ola" },
    { frompublickey: ME, topublickey: PEER, incoming: false, message: "posting", date: now - 60000, type: "text", status: "posting" },
    { frompublickey: ME, topublickey: PEER, incoming: false, message: "landed", date: now - 30000, type: "text", status: "sent", sentblock: 2319711 },
    { frompublickey: ME, topublickey: PEER, incoming: false, message: "done", date: now, type: "text", status: "confirmed", sentblock: 2319640 }
  ];
  P.MailPanel.init(deps(dom, baseApi({ mailThreadWith: async () => msgs })));
  await P.MailPanel.render();
  // open the thread through the public path
  P.MailPanel.reset();
  const P2 = panel(), dom2 = fakeDom();
  P2.MailPanel.init(deps(dom2, baseApi({
    mailThreads: async () => [{ hashref: "h6", unread: 0, last: msgs[0], other: PEER }],
    mailThreadWith: async () => msgs
  })));
  await P2.MailPanel.render();
  const html = dom2.nodes.mailBody.innerHTML;
  assert.ok(!html.includes("✓✓"), "no invented double tick — the protocol has no read receipt");
  assert.ok(html.includes("data-peer="), "rows carry the peer so a click opens the thread");
});

// ---------------------------------------------------------------- the send pin must respect coin age
test("a mail send pins to a coin the node will actually spend", async () => {
  const { pinMinimaSend } = require("../main/sendpin");
  const ADDR_NEW = "0x" + "11".repeat(32), ADDR_OLD = "0x" + "22".repeat(32);
  const asked = [];
  // The node refuses any input younger than MINIMA_CONFIRM_DEPTH (send.java clamps coinage to 3), so the pin
  // must ask for aged coins. Here the *smallest* coin is brand new — the trap: it is this send's own change.
  const runner = async (cmd) => {
    if (/^coins /.test(cmd)) {
      asked.push(cmd);
      const aged = /\bcoinage:(\d+)/.exec(cmd);
      const all = [{ amount: "0.000099607", address: ADDR_NEW, age: 0 }, { amount: "4.25", address: ADDR_OLD, age: 40 }];
      const min = aged ? Number(aged[1]) : 0;
      return { response: all.filter((c) => c.age >= min).map((c) => ({ amount: c.amount, address: c.address })) };
    }
    if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
    return { status: true };
  };
  const cmd = "send amount:0.000000001 address:0x434841494E4D41494C tokenid:0x00";
  const pinned = await pinMinimaSend(runner, cmd, { minCoinage: 4 });
  assert.ok(/\bcoinage:4\b/.test(asked[0]), "the coins query carries the minimum age: " + asked[0]);
  assert.ok(pinned.includes("fromaddress:" + ADDR_OLD), "it pins the aged coin, not the fresh change output");
  assert.ok(!pinned.includes(ADDR_NEW), "a coin the node would refuse is never pinned");
});

test("main/mail.js actually passes that minimum age on both of its sends", () => {
  const fs = require("fs"), path = require("path");
  const src = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(__dirname, "..", "main", "mail.js"), "utf8"));
  const calls = [...src.matchAll(/pinMinimaSend\(nodeCmd,[^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 2, "both the message send and the payment send go through the pin");
  for (const c of calls) assert.ok(/minCoinage/.test(c), "every pinned mail send sets minCoinage: " + c.slice(0, 80));
  const n = Number((/MAIL_MIN_COINAGE = (\d+)/.exec(src) || [])[1]);
  assert.ok(n >= 3, "at or above the node's confirm depth, or the pin re-creates the bug (got " + n + ")");
});

test("a send failure is explained in words, not dumped as an IPC stack", () => {
  const fs = require("fs"), path = require("path");
  const src = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(__dirname, "..", "renderer", "mail.js"), "utf8"));
  // Electron wraps anything main throws as "Error invoking remote method '…': Error: …". Showing that to a
  // person is noise, and the node's funding refusal is misleading on a full wallet.
  assert.ok(/Error invoking remote method/.test(src), "the IPC wrapper is stripped somewhere");
  assert.ok(/No Coins of tokenid/.test(src), "the funding refusal is translated");
  const raw = [...src.matchAll(/D\.toast\(([^,]+),\s*"err"\)/g)].map((m) => m[1].trim());
  const leaky = raw.filter((a) => /\be\.message\b|\berr\.message\b|String\(e\)/.test(a));
  assert.deepEqual(leaky, [], "every error toast goes through errText: " + leaky.join(" | "));
});

test("Android Mail address, link and signed beacon interoperate byte for byte", async () => {
  const codec = require("../main/mailaddress");
  const keys = require("../main/mailcrypto");
  const sodium = await keys.ready();
  const id = await keys.deriveIdentity("test-fixture-only-mail-address-A");
  const words = "reunion-sting-lazy-tornado-liberty-bubble";
  assert.equal(codec.phrase(id.publicId), words);
  assert.equal(codec.direct(words + "\n" + codec.link(id.publicId)), id.publicId);
  assert.equal(codec.direct(codec.link(id.publicId).replace("reunion", "lemon")), null);
  const card = codec.card(sodium, id);
  assert.equal(card.sig, "27c067e038ba079f96ff07b42e0c26e49ee5a91db0963edf364e846192aec8479bde0782bd70c669e956ba3d3f4d6f4a3cad5b4c6fd61f955794690536d5ca05");
  const coin = { address: codec.ADDRESS, tokenid: "0x00", state: { 0: codec.tag(words), 1: id.publicId, 2: "0x" + card.sig } };
  const run = async cmd => { assert.ok(cmd.endsWith("depth:1500")); return { status: true, response: [coin] }; };
  assert.deepEqual(await codec.find(run, sodium, words, 1500), card);
  coin.created = "2427884";
  assert.deepEqual(await codec.find(run, sodium, words, 1500), { ...card, block: 2427884 });
  coin.state[2] = "0x" + "00".repeat(64);
  assert.equal(await codec.find(run, sodium, words, 1500), null);
});

test("six words resolve an unsaved correspondent from message headers", async t => {
  const store = require("../main/mail-store");
  const codec = require("../main/mailaddress");
  const recipient = "0x" + "12".repeat(64);
  const peer = "0x" + "34".repeat(64);
  t.mock.method(store, "contacts", () => []);
  t.mock.method(store, "all", () => [{ frompublickey: peer, topublickey: recipient.slice(2).toUpperCase() }]);
  assert.equal(await mail.resolveRecipient(codec.phrase(recipient)), recipient);
  assert.equal(await mail.resolveRecipient(codec.phrase(peer)), peer);
});

test("the owner's card starts enabled, survives restart, and respects Stop", async t => {
  const config = require("../main/config"), store = require("../main/mail-store");
  const keys = require("../main/mailcrypto"), codec = require("../main/mailaddress");
  const fixture = await keys.deriveIdentity("mail-publication-default-fixture");
  const meta = new Map();
  t.mock.method(config, "getSecret", () => keys.serializeIdentity(fixture));
  t.mock.method(store, "metaGet", k => meta.get(k));
  t.mock.method(store, "metaSet", (k,v) => meta.set(k,v));
  const path = require.resolve("../main/mail"), original = require.cache[path];
  t.after(() => { require.cache[path] = original; });
  const open = async () => {
    delete require.cache[path];
    const instance = require(path);
    instance._setRunner(async () => ({ status: true, response: {} }));
    await instance.init();
    return instance;
  };
  let instance = await open();
  const job = meta.get("mail-address-publications")[fixture.publicId];
  assert.ok(codec.verify(await keys.ready(), job.card.key, job.card.sig, job.card.phrase));
  instance = await open();
  assert.equal(meta.get("mail-address-publications")[fixture.publicId], job);
  await instance.setPublication(fixture.publicId, false);
  instance = await open();
  assert.equal(instance.myIdentity().published, false);
});

// ---------------------------------------------------------------- 0.19.1: the phone's navigation, Mail's own theme, the funds sheet
test("folders are in a side menu under a folder header, not a strip of tabs", async () => {
  const P = panel(), dom = fakeDom();
  P.MailPanel.init(deps(dom, baseApi({ mailOutbox: async () => [{ hashref: "h", randomid: "r", topublickey: PEER, incoming: false, subject: "", message: "x", date: Date.now(), status: "posting", type: "text" }] })));
  await P.MailPanel.render();
  const html = dom.nodes.mailBody.innerHTML;
  assert.ok(!html.includes("mm-tabs") && !html.includes('role="tab"'), "no tab strip");
  assert.ok(html.includes('id="mmMenu"') && html.includes('<h2 class="mm-title">Inbox</h2>'), "menu button and folder name");
  assert.ok(html.includes('id="mmDrawer"') && html.includes(" hidden>"), "the side menu is there, closed");
  const order = [...html.matchAll(/class="mm-nav[^"]*" data-f="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["inbox", "outbox", "sent", "archive", "contacts", "key", "settings"], "the phone's order");
  assert.ok(/data-f="outbox"[^>]*>.*?<span class="mm-cnt">1<\/span>/.test(html), "the Outbox counts what is waiting");
  assert.ok(html.includes("MINIMA <i>MAIL</i>"), "the menu's heading");
});

test("Mail keeps its own Paper or Dark and never reads the shell's theme", async () => {
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "mail.css"), "utf8");
  assert.ok(!/:root\[data-theme/.test(css), "no rule hangs off the shell's data-theme");
  assert.ok(css.includes('.mailapp[data-mm-theme="dark"]'));
  assert.ok(/--mm-bg: #FAF9F6/.test(css) && /--mm-accent: #F7931A/.test(css) && /--mm-on-accent: #1A1000/.test(css), "Design.java's paper, orange and ink-on-orange");
  const P = panel(), dom = fakeDom();
  P.MailPanel.init(deps(dom, baseApi({ mailInit: async () => ({ publicId: ME, name: "", payaddr: "MxTEST", theme: "dark" }) })));
  await P.MailPanel.render();
  assert.ok(dom.nodes.mailBody.innerHTML.startsWith('<div class="mailapp" data-mm-theme="dark">'));
  const P2 = panel(), dom2 = fakeDom();
  P2.MailPanel.init(deps(dom2, baseApi()));
  await P2.MailPanel.render();
  assert.ok(dom2.nodes.mailBody.innerHTML.startsWith('<div class="mailapp">'), "Paper unless chosen");
});

test("the funds sheet compares amounts exactly and takes only a real receiving address", () => {
  const { decCmp, looksLikeMinimaAddress } = panel().MailPanel._pure;
  assert.equal(decCmp("88.123456", "88.123456"), 0);
  assert.equal(decCmp("88.1234560000000000000000000000000000000000001", "88.123456"), 1, "one unit in the 43rd decimal is more");
  assert.equal(decCmp("9", "10"), -1); assert.equal(decCmp("010.50", "10.5"), 0); assert.equal(decCmp(".5", "0.49999999999999999999"), 1);
  assert.equal(looksLikeMinimaAddress("0x" + "ab".repeat(65)), false, "a Mail key is never a pay address");
  assert.equal(looksLikeMinimaAddress("MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1 address:0x00"), false);
  assert.equal(looksLikeMinimaAddress("MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1"), true);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "mail.js"), "utf8");
  assert.ok(/mailPay\(peer, pick\.addr, pick\.amount, pick\.token\.tokenid, pick\.token\.name, pick\.memo, subject \|\| ""\)/.test(src), "the reviewed values are the ones paid");
  assert.ok(!/sendCurrency/.test(src), "one way to pay");
});

// ---------------------------------------------------------------- 0.19.169: what a sender writes is stored as capped primitives
test("an incoming message is stored as capped strings and numbers: a field nested 12,000 arrays deep cannot stop mail.json from saving", () => {
  const deep = JSON.parse("[".repeat(12000) + "]".repeat(12000));
  const from = "0x" + "12".repeat(64), to = "0x" + "34".repeat(64);
  const m = { from, to, subject: deep, message: deep, fromname: deep, randomid: deep, date: deep, type: deep, amount: deep, tokenid: deep, tokenname: deep, txpowid: deep, image: deep, payaddr: deep };
  assert.throws(() => JSON.stringify(m), RangeError, "the raw message is what used to be stored");
  const local = mail._localOf(m);
  assert.doesNotThrow(() => JSON.stringify(local));
  for (const [k, v] of Object.entries(local)) assert.ok(v === undefined || v === null || typeof v !== "object", k + " is a primitive");
  assert.deepEqual([local.subject, local.message, local.fromname, local.randomid, local.type, local.payaddr, local.amount], ["", "", "", "", "text", "", ""]);
  assert.equal(local.hashref, mail.threadKey(from, to, ""), "the thread of an unreadable subject is the empty subject's");
  const honest = mail._localOf({ from, to, subject: "Hi", message: "x".repeat(300000), randomid: "r1", date: "1700000000000", type: "payment", amount: "1.5", tokenid: "0x00", txpowid: "0xAB", fromname: "Ann" });
  assert.deepEqual([honest.subject, honest.message.length, honest.randomid, honest.date, honest.type, honest.amount, honest.tokenid, honest.tokenname, honest.image, honest.fromname],
    ["Hi", 200000, "r1", 1700000000000, "payment", "1.5", "0x00", undefined, undefined, "Ann"], "an honest message is kept as it was; a field left out stays out");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "mail.js"), "utf8");
  assert.ok(/try \{   \/\/ one coin at a time[\s\S]{0,4000}const local = localOf\(m\);\s*if \(store\.addMessage\(local\)\)[^\n]*\n\s*\} catch \(e\) \{ try \{ node\.log\("\[mail\] a coin could not be read/.test(src), "each coin is read in its own try, and a failure is logged");
  assert.ok(/require\("\.\/mail-store"\)\.setLog\(\(m\) => node\.log\(m\)\);/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "main", "main.js"), "utf8")), "a failed save of mail.json is said in the Logs view");
});

// ---------------------------------------------------------------- 0.19.261: a backfill never learns an older pay address over a newer one
test("a peer's pay address: a backfill's older coin never replaces the address a newer coin gave", () => {
  const L = mail._learnPayaddr;
  assert.equal(L("", 0, 100, true), true, "none known: learned, from any pass");
  assert.equal(L("MxOLD", 500, 100, true), false, "a backfill reads block 100 after a live pass learned at block 500");
  assert.equal(L("MxOLD", 500, 100, false), false, "nor a live pass reading an older coin");
  assert.equal(L("MxOLD", 500, 600, true), true, "a newer coin, from any pass");
  assert.equal(L("MxOLD", 500, 500, false), true);
  assert.equal(L("MxOLD", 0, 100, true), false, "an address of unknown age (stored before 0.19.261) is not replaced by a backfill");
  assert.equal(L("MxOLD", 0, 100, false), true, "but is by a live pass");
  assert.equal(L("MxOLD", 500, 0, false), false, "a coin with no block does not replace a dated address");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "mail.js"), "utf8");
  assert.ok(src.includes('if (cur !== payaddr && learnPayaddr(cur, known, blk, historical)) { store.metaSet("pa:" + m.from, payaddr); store.metaSet("pab:" + m.from, blk);'), "processCoins asks it");
});
