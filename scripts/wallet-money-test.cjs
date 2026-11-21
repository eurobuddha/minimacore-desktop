// The Wallet's money paths (Send, Split, Consolidate, Receive), pinned while their SCREENS are rebuilt to
// Pandamonium's (0.18.79+). The handlers are lifted out of renderer/app.js and RUN against a stand-in page and
// a stand-in node bridge; nothing here talks to a node. The command strings below were recorded from 0.18.78:
// the same user input must still put the same bytes on the wire, behind the same checks, in the same order.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"));
const mainJs = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");

const TO = "MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1";
const OWN = "MxG081OWNADDRESS0FTHEWALLET0000000000000000000000000000000000001";
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const TOKENS = () => [
  { tokenid: "0x00", name: "Minima", sendable: "1250.75", ticker: "MINIMA" },
  { tokenid: MXUSD, name: "MxUSD", sendable: "300.50000001", ticker: "MxUSD" }
];

// a one-line definition, or a block that ends at the first "}" in column 0 (as scripts/shell-test.cjs)
function source(name, src) {
  const app_ = src || app, m = app_.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  const code = m[1].replace(/\s+\/\/.*$/, "");   // a trailing comment is not part of the question "does this line open a block"
  return /\{$/.test(code) ? app_.slice(m.index + 1, app_.indexOf("\n}", m.index) + 2) : m[1];
}
const CORE = ["validAddr", "validAmt", "validTok", "cmd", "tryCmd", "esc", "absCmp", "consolidateToken"];
// The names of the screen functions, in one place: they move when a screen is rebuilt, the checks below do not.
const SCREEN = ["sendForm", "splitDialog", "renderReceive", "getRecvAddress", "setRecv", "renderRecvLabel", "drawQR", "labelFor", "summaryAmount"];

function harness(opts) {
  opts = opts || {};
  const log = [], toasts = [], els = {};
  const node = () => ({ value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, onclick: null, onchange: null, oninput: null, className: "", title: "",
    dataset: {}, style: {}, parentNode: { insertBefore() {} }, classList: { toggle() {}, add() {}, remove() {} }, focus() {}, remove() {}, setAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML() {}, addEventListener() {} });
  const el = (id) => els[id] || (els[id] = node());
  const api = {
    cmd: async (c) => {
      log.push("cmd:" + c);
      const head = c.split(" ")[0];
      if ((opts.fail || []).includes(head)) return { status: false, error: "node says no" };
      return { status: true, response: head === "getaddress" || head === "newaddress" ? { miniaddress: OWN, address: "0x01" } : head === "send" ? { txpowid: "0xFEED" } : {} };
    },
    ppConsolidationCheck: async () => { log.push("keycheck"); return opts.unsafe || null; },
    saveConfig: async (p) => p, clip: async () => true
  };
  const env = {
    el, api, TOKENS: TOKENS(),
    toast: (m, k) => toasts.push((k || "") + ":" + m),
    copy: async () => {},
    showConfirm: async (title, message) => { log.push("confirm:" + title); h.asked.push(message); return opts.confirm !== false; },
    TOK: { tidyAmount: (s) => { s = String(s == null ? "" : s); return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, ""); }, tokenName: (t, id) => id },
    document: { body: node(), createElement: node, getElementById: el, activeElement: null, querySelectorAll: () => [] },
    qrcode: undefined
  };
  const names = CORE.concat(SCREEN.filter(n => new RegExp("\\n(?:async )?function " + n + "\\b").test(opts.src || app)));
  const prelude = 'const MINIMA = "0x00"; let SEND_TOKENS = TOKENS; let SEND_PRESELECT = null; let running = true; let CFG = { labels: {} }; let RECV_ADDR = null; let nodeState = "running";\n' +
    "function tokenOptions() { return ''; }\n";
  const fns = new Function(...Object.keys(env), prelude + names.map(n => source(n, opts.src)).join("\n") + "; return { " + names.join(", ") + " };")(...Object.values(env));
  const h = { log, toasts, els, el, fns, asked: [], cmds: () => log.filter(l => l.startsWith("cmd:")).map(l => l.slice(4)) };
  return h;
}

// ---- the drivers: how a user fills each screen today. Only these change when a screen moves. ----
async function driveSend(h, { to, amt, tok, max }) {
  h.fns.sendForm();
  h.el("sTok").value = tok; h.el("sTo").value = to;
  if (max) h.el("sMax").onclick(); else h.el("sAmt").value = amt;
  await h.el("sGo").onclick();
}
async function driveSplit(h, { amt, n, tok }) {
  h.fns.splitDialog(tok, "the token");                 // opened from the token's coins dialog (0.18.80)
  h.el("spAmt").value = amt; h.el("spN").value = n;
  await h.el("spGo").onclick();
}

test("Send: the command string for a given input is the one 0.18.78 sent", async () => {
  const cases = [
    [{ to: TO, amt: "1.5", tok: "0x00" }, "send address:" + TO + " amount:1.5"],
    [{ to: TO, amt: "0.25", tok: MXUSD }, "send address:" + TO + " amount:0.25 tokenid:" + MXUSD],
    [{ to: "  " + TO + " ", amt: " 2 ", tok: "0x00" }, "send address:" + TO + " amount:2"],
    [{ to: TO, amt: ".5", tok: "0x00" }, "send address:" + TO + " amount:.5"],
    [{ to: TO, amt: "0.000000000000000000000000000000000000000001", tok: "0x00" }, "send address:" + TO + " amount:0.000000000000000000000000000000000000000001"],
    [{ to: "0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A", amt: "1250.75", tok: "0x00" }, "send address:0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A amount:1250.75"],
    [{ to: TO, max: true, tok: MXUSD }, "send address:" + TO + " amount:300.50000001 tokenid:" + MXUSD]   // Max is the whole sendable figure, not rounded
  ];
  for (const [input, want] of cases) {
    const h = harness();
    await driveSend(h, input);
    assert.deepEqual(h.log, ["cmd:checkaddress address:" + String(input.to).trim(), "confirm:" + h.log[1].slice(8), "cmd:" + want], JSON.stringify(input));
    assert.ok(h.asked[0].includes(String(input.to).trim()), "the review shows the whole address");
    assert.equal(h.el("sTo").value, "", "the form is cleared only after the node accepted");
  }
});

test("Send: every check still stops the send, before anything reaches the node", async () => {
  const nothing = [
    { to: TO + " burn:100", amt: "1", tok: "0x00" },            // the injected-parameter paste
    { to: TO + "\tamount:999", amt: "1", tok: "0x00" },
    { to: TO + " tokenid:0x00", amt: "1", tok: "0x00" },
    { to: "Mx", amt: "1", tok: "0x00" }, { to: "", amt: "1", tok: "0x00" }, { to: "bc1qxyz", amt: "1", tok: "0x00" },
    { to: TO, amt: "", tok: "0x00" }, { to: TO, amt: "0", tok: "0x00" }, { to: TO, amt: "-1", tok: "0x00" }, { to: TO, amt: "1e5", tok: "0x00" },
    { to: TO, amt: "1,5", tok: "0x00" }, { to: TO, amt: "1 split:20", tok: "0x00" }, { to: TO, amt: "1.2.3", tok: "0x00" },
    { to: TO, amt: "1", tok: "0x00 burn:5" }, { to: TO, amt: "1", tok: "MxUSD" },
    { to: TO, amt: "1250.750000000000000000000000000000000000000001", tok: "0x00" },   // one grain over the sendable figure
    { to: TO, amt: "301", tok: MXUSD }
  ];
  for (const input of nothing) {
    const h = harness();
    await driveSend(h, input);
    assert.deepEqual(h.log, [], "nothing asked, nothing sent: " + JSON.stringify(input));
    assert.equal(h.toasts.length, 1, "and the user is told why");
  }
  let h = harness({ fail: ["checkaddress"] });
  await driveSend(h, { to: TO, amt: "1", tok: "0x00" });
  assert.deepEqual(h.log, ["cmd:checkaddress address:" + TO], "an address the node cannot check is not sent to");
  h = harness({ confirm: false });
  await driveSend(h, { to: TO, amt: "1", tok: "0x00" });
  assert.equal(h.log.length, 2); assert.ok(h.log[1].startsWith("confirm:"), "declined at the review: no send");
  assert.equal(h.el("sTo").value, TO, "inputs kept");
  h = harness({ fail: ["send"] });
  await driveSend(h, { to: TO, amt: "1", tok: "0x00" });
  assert.ok(h.toasts.some(t => t === "err:node says no"), "the node's own words on a failed send");
  assert.equal(h.el("sTo").value, TO, "inputs kept after a failed send");
});

test("Send: the main process still pins a MINIMA send to a signable coin, and only a send", () => {
  assert.ok(mainJs.includes("const pinned = await pinMinimaSend(run, command, { minCoinage: 3 });"), "CHANGED on purpose (0.19.190): the pin itself reads the verb (main/cmdverb.js) and passes any other command unchanged");
  assert.ok(mainJs.includes("return seedgate.scrubReply(await run(pinned));"));
});

// 0.19.154: the same Send and Split, lifted from the SHIPPED source (not the English view) and run with the app in each
// other language: the review, the toasts and the dialogs are translated; the bytes sent to the node are the same
test("Send and Split in Chinese, Russian and Ukrainian: the same command strings and the same refusals as in English", async () => {
  const I18N = require("../renderer/i18n.js"); for (const c of ["zh", "ru", "uk"]) require("../renderer/i18n/" + c + ".js");
  const raw = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  try {
    for (const code of ["zh", "ru", "uk"]) {
      I18N.set(code);
      for (const [input, want] of [[{ to: TO, amt: "1.5", tok: "0x00" }, "send address:" + TO + " amount:1.5"], [{ to: TO, max: true, tok: MXUSD }, "send address:" + TO + " amount:300.50000001 tokenid:" + MXUSD]]) {
        const h = harness({ src: raw });
        await driveSend(h, input);
        assert.deepEqual(h.cmds(), ["checkaddress address:" + TO, want], code + " " + JSON.stringify(input));
        assert.ok(h.asked[0].includes(TO) && h.asked[0].includes(want.match(/amount:(\S+)/)[1]), code + ": the review shows the whole address and the amount as typed");
      }
      for (const input of [{ to: TO, amt: "1,5", tok: "0x00" }, { to: TO + " burn:100", amt: "1", tok: "0x00" }, { to: TO, amt: "301", tok: MXUSD }]) {
        const h = harness({ src: raw });
        await driveSend(h, input);
        assert.deepEqual(h.log, [], code + ": nothing asked, nothing sent: " + JSON.stringify(input)); assert.equal(h.toasts.length, 1, code + ": and the user is told why");
        assert.ok(!/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/.test(h.toasts[0]), code + ": told in " + code + ", not English: " + h.toasts[0]);
      }
      const h = harness({ src: raw });
      await driveSplit(h, { amt: "10", n: "4", tok: "0x00" });
      assert.deepEqual(h.cmds(), ["getaddress", "send address:" + OWN + " amount:10 split:4"], code + ": split");
    }
  } finally { I18N.set("en"); }
});

test("Split: the command string for a given input is the one 0.18.78 sent", async () => {
  let h = harness();
  await driveSplit(h, { amt: "10", n: "4", tok: "0x00" });
  assert.deepEqual(h.cmds(), ["getaddress", "send address:" + OWN + " amount:10 split:4"]);
  h = harness();
  await driveSplit(h, { amt: " 0.5 ", n: "20", tok: MXUSD });
  assert.deepEqual(h.cmds(), ["getaddress", "send address:" + OWN + " amount:0.5 split:20 tokenid:" + MXUSD]);
  for (const bad of [{ amt: "10", n: "1", tok: "0x00" }, { amt: "10", n: "21", tok: "0x00" }, { amt: "10", n: "x", tok: "0x00" },
    { amt: "0", n: "4", tok: "0x00" }, { amt: "1 burn:5", n: "4", tok: "0x00" }, { amt: "1", n: "4", tok: "0x00 burn:5" }]) {
    h = harness();
    await driveSplit(h, bad);
    assert.deepEqual(h.log, [], "nothing sent: " + JSON.stringify(bad));
  }
});

test("Consolidate: asks first, then checks the pool owner keys, and refuses when one cannot safely sign", async () => {
  let h = harness();
  assert.equal(await h.fns.consolidateToken("0x00", "Minima"), true);
  assert.deepEqual(h.log, ["confirm:Consolidate Minima?", "keycheck", "cmd:consolidate tokenid:0x00"], "ask, check, then the node's own command");
  assert.ok(h.asked[0].includes("consolidate tokenid:0x00"), "the question shows the command");
  h = harness();
  await h.fns.consolidateToken(MXUSD, "MxUSD");
  assert.equal(h.cmds()[0], "consolidate tokenid:" + MXUSD);

  h = harness({ unsafe: "Nothing consolidated: your wallet holds a pool owner key that cannot sign.\n\nkey 0xAB is paused" });
  assert.equal(await h.fns.consolidateToken("0x00", "Minima"), false);
  assert.deepEqual(h.log, ["confirm:Consolidate Minima?", "keycheck", "confirm:Not consolidated"], "refused: no consolidate command");
  assert.ok(h.asked[1].includes("cannot sign"), "the reason is shown in the engine's words");
  assert.deepEqual(h.cmds(), []);

  h = harness({ confirm: false });
  assert.equal(await h.fns.consolidateToken("0x00", "Minima"), false);
  assert.deepEqual(h.log, ["confirm:Consolidate Minima?"], "declined: no key check, no command");
  h = harness();
  assert.equal(await h.fns.consolidateToken("0x00 burn:1", "Minima"), false);
  assert.deepEqual(h.log, [], "a token id that is not clean hex never reaches a command");
});

test("Split and Consolidate live in the token's coins dialog, wired to the same handlers", () => {
  const coins = app.slice(app.indexOf("async function showCoins(b)"), app.indexOf("function showCoinDetail"));
  assert.ok(/el\("coinsSplit"\)\.onclick = \(\) => splitDialog\(tid, name\)/.test(coins));
  assert.ok(/await consolidateToken\(tid, name\)/.test(coins), "Consolidate goes through the ask-first, key-checking function");
  assert.ok(!/cmd\(`?"?consolidate/.test(coins) && !/send address/.test(coins), "the dialog itself builds no fund-moving command");
  assert.equal((app.match(/cmd\(cmdText\)/g) || []).length, 1, "one place issues consolidate");
  assert.equal((app.match(/split:\$\{n\}/g) || []).length, 1, "one place issues a split");
  assert.ok(!/sendModes|tok-tool|consolidate-btn/.test(app), "no second route on the rows or the Send screen");
});

test("token order: Minima pinned first, the saved order replayed for tokens still held, new tokens at the end", () => {
  const tokenOrder = new Function('const MINIMA = "0x00";' + source("tokenOrder") + "; return tokenOrder;")();
  assert.deepEqual(tokenOrder(null, ["0xAA", "0x00", "0xBB"]), ["0x00", "0xAA", "0xBB"], "nothing saved: Minima first, then as the node listed them");
  assert.deepEqual(tokenOrder("0xBB,0xAA", ["0x00", "0xAA", "0xBB", "0xCC"]), ["0x00", "0xBB", "0xAA", "0xCC"], "a token just received is appended, never lost");
  assert.deepEqual(tokenOrder("0xBB,0x00,0xBB,0xGONE", ["0x00", "0xAA", "0xBB"]), ["0x00", "0xBB", "0xAA"], "Minima cannot be moved; duplicates and tokens no longer held are ignored");
  assert.deepEqual(tokenOrder("0xBB", ["0xAA", "0xBB"]), ["0xBB", "0xAA"], "a wallet with no Minima row");
  assert.ok(/store\("walletOrder"/.test(app) && /dragstart/.test(app) && /if \(WAL_DRAG\) return;/.test(app), "saved; the 15 s rebuild waits for a drag to end");
});

test("Receive: Get Address reads a default address and never makes the node mint a key", async () => {
  const h = harness();
  await h.fns.renderReceive();
  assert.deepEqual(h.cmds(), ["getaddress"], "opening Receive reads the address once");
  assert.equal(h.el("recvAddr").textContent, OWN, "the whole address is shown");
  await h.el("recvGet").onclick(); await h.el("recvGet").onclick(); await h.el("recvGet").onclick();
  assert.deepEqual(h.cmds(), ["getaddress", "getaddress", "getaddress", "getaddress"], "each press is a read");
  await h.fns.renderReceive();
  assert.equal(h.cmds().length, 4, "coming back to the screen shows the address already in hand");
  assert.ok(!h.cmds().some(c => /newaddress/i.test(c)));
  const wallet = app.slice(app.indexOf("// ---- Wallet tab"), app.indexOf("// ---- shared dialogs"));
  assert.ok(!/["`]newaddress/.test(app.replace(/\/\/[^\n]*/g, "")), "nothing in the renderer issues newaddress");
  assert.ok(wallet.length > 1000);
  // the label saved from Receive is still keyed by the address on show
  h.el("recvLabelIn").value = "Savings";
  let saved = null; h.fns.renderRecvLabel(OWN); h.el("recvLabelIn").value = "Savings";
  await h.el("recvLabelSave").onclick();
  assert.ok(h.toasts.some(t => t === "ok:Label saved ✓"));
  const failing = harness({ fail: ["getaddress"] });
  await failing.fns.renderReceive();
  assert.ok(/could not be read/.test(failing.el("recvAddr").textContent), "a failed read says so and shows no address");
});

// ---- 0.19.190: the send pin and the RPC timeout read a command as the node does (main/cmdverb.js; released 0.18.175, 0.18.187) ----
const PIN_A = "0x" + "AB".repeat(32);
const pinRig = () => { const asked = []; return { asked, run: async (c) => { asked.push(c); return c.startsWith("coins ") ? { status: true, response: [{ coinid: "0x01", amount: "50", address: PIN_A }] } : c.startsWith("checkaddress") ? { status: true, response: { simple: true } } : { status: true }; } }; };
test("the send pin: a send written with quotes, a control character or ':' spacing is pinned like a plain one; a token send or its own fromaddress is not", async () => {
  const { pinMinimaSend } = require("../main/sendpin");
  for (const c of ['"send" amount:1 address:0xCD', "\u0001send amount:1 address:0xCD", "SEND amount:1 address:0xCD", "send amount : 1 address:0xCD", 's"en"d amount:1 address:0xCD', '"send"amount:1 address:0xCD', "send tokenid : 0x00 amount:1 address:0xCD"]) {
    const r = pinRig(); assert.equal(await pinMinimaSend(r.run, c), c + " fromaddress:" + PIN_A, JSON.stringify(c));
  }
  for (const c of ['"send" amount:1 address:0xCD tokenid : ' + MXUSD, "send amount:1 address:0xCD fromaddress : 0xEE", 'send amount:1 address:0xCD "fromaddress":0xEE', "sendpoll action:list", "sendfrom amount:1 address:0xCD", 'send amount:1 address:0xCD tokenid:"' + MXUSD + '"']) {
    const r = pinRig(); assert.equal(await pinMinimaSend(r.run, c), c, JSON.stringify(c)); assert.deepEqual(r.asked, [], JSON.stringify(c));
  }
  assert.ok(/const pinned = await pinMinimaSend\(run, command, \{ minCoinage: 3 \}\);/.test(mainJs) && !/\/\^send\\s\/i?\.test\(command\)/.test(mainJs), "mcd:cmd no longer decides with /^send\\s/");
});
test("the send pin reads the LAST tokenid and amount and a top-level fromaddress only, as the node does", async () => {
  const { pinMinimaSend } = require("../main/sendpin");
  let r = pinRig(); assert.equal(await pinMinimaSend(r.run, "send amount:1 address:0xCD tokenid:0x00 tokenid:" + MXUSD), "send amount:1 address:0xCD tokenid:0x00 tokenid:" + MXUSD, "the last tokenid is MxUSD: not pinned");
  r = pinRig(); const c = "send amount:1 address:0xCD tokenid:" + MXUSD + " tokenid:0x00"; assert.equal(await pinMinimaSend(r.run, c), c + " fromaddress:" + PIN_A, "the last tokenid is MINIMA: pinned");
  r = pinRig(); const st = 'send amount:1 address:0xCD state:{"1":"fromaddress:0xEE"}'; assert.equal(await pinMinimaSend(r.run, st), st + " fromaddress:" + PIN_A, "fromaddress: inside a state's JSON is not the parameter");
  r = pinRig(); assert.equal(await pinMinimaSend(r.run, "send amount:1 amount:60 address:0xCD"), "send amount:1 amount:60 address:0xCD", "the amount looked for is the last one (60): no coin of 50 covers it, so nothing is pinned");
});
test("the send pin: an empty quoted value does not hide the tokenid after it (0.19.250)", async () => {
  const { pinMinimaSend } = require("../main/sendpin");
  for (const c of ['send amount:1 address:"" tokenid:' + MXUSD, 'send amount:1 address : "" tokenid:' + MXUSD, 'send amount:1 address:""tokenid:' + MXUSD]) {
    const r = pinRig(); assert.equal(await pinMinimaSend(r.run, c), c, "an MxUSD send is not pinned: " + c); assert.deepEqual(r.asked, [], c);
  }
});
test("the RPC write timeout reads the verb as the node does", () => {
  const { _timeoutFor } = require("../main/rpc");
  for (const c of ['"send" amount:1', "\u0002vault", 'v"ault"', "status;send amount:1", "SEEDRANDOM modifier:x", '"txnpost" id:a']) assert.equal(_timeoutFor(c), 180000, JSON.stringify(c));
  for (const c of ["status", "balance", '"status"']) assert.equal(_timeoutFor(c), 30000, c);
});

// ---- 0.19.191: mcd:cmd refuses a send that names amount, tokenid, address or fromaddress twice (released 0.18.187) ----
test("a send that repeats amount, tokenid, address or fromaddress is refused before anything is sent; a key inside a state's JSON is not a parameter", async () => {
  const V = require("../main/cmdverb"), FOUR = ["amount", "tokenid", "address", "fromaddress"];
  assert.deepEqual(V.repeated("send amount:1 address:0xA address : 0xB", FOUR), ["address"]);
  assert.deepEqual(V.repeated('send amount:1 "amount":2 address:0xA', FOUR), ["amount"]);
  assert.deepEqual(V.repeated("send amount:1 address:0xA tokenid:0x00 TOKENID:" + MXUSD, FOUR), ["tokenid"]);
  assert.deepEqual(V.repeated('send amount:1 address:0xA state:{"address":"x"}', FOUR), [], "a key inside a state's JSON is not a parameter");
  assert.deepEqual(V.repeated("send amount:1 address:0xA fromaddress:0xB", FOUR), []);
  // the handler, run: the refusal comes before the node is asked anything
  const h = mainJs.slice(mainJs.indexOf('ipcMain.handle("mcd:cmd"'));
  const body = h.slice(h.indexOf("{") + 1, h.indexOf("\n  requireRunning();"));
  const run0 = new Function("cmdverb", "restore", "command", body), run = (V, c) => run0(V, require("../main/restore"), c);
  for (const c of ["send amount:1 address:0xA amount:9", '"send" address:0xA amount:1 "address":0xB', "status;send amount:1 tokenid:0x00 address:0xA tokenid:" + MXUSD])
    assert.throws(() => run(V, c), /^Error: This send names (amount|address|tokenid) more than once \(the node would use only the last\)\. Write each once\.$/, c);
  for (const c of ["send amount:1 address:0xA", "sendpoll action:list action:remove", "txnoutput id:a amount:1 amount:2"]) assert.doesNotThrow(() => run(V, c), c);
});

// ---- 0.19.236: the Wallet names a token by its id, never by the name its creator wrote on the chain ----
test("token names on the Wallet: Minima and MxUSD by their ids; any other token its name and whole id; a name imitating them, the id alone; stored names untouched", () => {
  const ctx = { window: {} }; require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "tokenicons.js"), "utf8"), ctx);
  const TOK = ctx.window.TOK, FAKE = "0x" + "FA".repeat(32);
  assert.equal(TOK.label(null, "0x00"), "Minima"); assert.equal(TOK.label({ name: "Something" }, MXUSD), "MxUSD"); assert.equal(TOK.label(null, MXUSD.toLowerCase()), "MxUSD");
  assert.equal(TOK.label({ name: "Gold" }, FAKE), "Gold (" + FAKE + ")"); assert.equal(TOK.label({ name: { name: "Gold" } }, FAKE), "Gold (" + FAKE + ")");
  for (const fake of ["MxUSD", "mxusd", "MxUSDT", "MхUSD", "MINIMA", "Minima", "M1nima", "Mіnima", "USD", "Mx​USD", "ＭxUSD"]) assert.equal(TOK.label({ name: fake }, FAKE), FAKE, JSON.stringify(fake) + " shows the id alone");
  assert.equal(TOK.label("Gold", FAKE), "Gold (" + FAKE + ")", "a name already stored (History) is labelled the same way");
  assert.equal(TOK.tokenName({ name: "MxUSD" }, FAKE), "MxUSD", "the stored / exported name is not changed");
  for (const site of ['<span class="balrow__name">${esc(TOK.label(b.token, tid))}</span>', 'SEND_TOKENS = bal.map(b => ({ tokenid: b.tokenid || MINIMA, name: TOK.label(b.token, b.tokenid),', 'l1 = sign + TOK.tidyAmount(r.amount) + "  " + TOK.label(r.tokenName, r.tokenid);'])
    assert.ok(app.includes(site), site);
  assert.ok(app.includes("return [histDate(r.time), histType(r), r.direction || \"\", TOK.tidyAmount(r.amount), r.tokenName,"), "the CSV keeps the stored name");
});
