// Review of the Wallet list, the coins dialog and the Split dialog (0.18.91, 0.18.92). The shipped functions
// are lifted out of renderer/app.js and RUN against a stand-in page and a stand-in node bridge, as
// scripts/wallet-money-test.cjs does. Nothing here talks to a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");

function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  return /\{$/.test(m[1].replace(/\s+\/\/.*$/, "")) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
const TOK = { tidyAmount: (s) => { s = String(s == null ? "" : s); return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, ""); }, tokenName: (t, id) => (id === "0x00" ? "Minima" : "MxUSD") };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// a stand-in element: remembers what was put in it; a list hands back one row per data-i it was given
function page() {
  const els = {};
  const node = (id) => ({ id, value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, className: "", dataset: {}, isConnected: true, warn: null,
    classList: { toggle(c, on) { this.owner.warn = on; }, add() {}, remove() {} }, focus() {}, remove() {}, setAttribute() {}, contains: () => false,
    querySelector: () => null,
    querySelectorAll(sel) { return sel === ".coin-row" ? [...this.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => ({ dataset: { i: m[1] } })) : []; } });
  const el = (id) => { if (!els[id]) { els[id] = node(id); els[id].classList.owner = els[id]; } return els[id]; };
  return { els, el };
}

// ---- 4. the Wallet list and a drag ----
function walletList(opts) {
  const p = page(), calls = [];
  const env = {
    el: p.el, TOK, document: { activeElement: null },
    tryCmd: async (c) => { calls.push(c); if (opts.duringRead) opts.duringRead(api); return opts.balance === undefined ? [{ tokenid: "0x00", confirmed: "5", sendable: "5" }] : opts.balance; },
    summaryAmount: (s) => s, paintWalBreakdown() {}, waitHtml: () => "STOPPED", store: () => null, tokenOrder: (s, present) => present,
    balCardHtml: (b) => "<row " + b.tokenid + " " + b.sendable + ">", initTokenOrder() {}, enhanceTokenIcons() {}, showCoins() {},
    FOOT: null
  };
  const api = new Function(...Object.keys(env), 'const MINIMA = "0x00", NO_FIGURE = "-"; let running = true, BAL_AT = 0, BAL_BY_TID = {}, WAL_MINIMA = null, WAL_DRAG = null, FOOT_KEYS, FOOT_KEYS_AT, NODE_DASH, NODE_DASH_AT, RECV_ADDR;\n' +
    source("walDragCheck") + "\n" + source("renderBalances") + "\n" + source("resetWalletFigures") +
    "; return { renderBalances, resetWalletFigures, drag: (v) => { if (v !== undefined) WAL_DRAG = v; return WAL_DRAG; }, run: (v) => { running = v; } };")(...Object.values(env));
  return Object.assign(api, { list: p.el("balList"), calls, el: p.el });
}

test("Wallet list: a drag that starts while the balance is being read keeps its row", async () => {
  const row = { isConnected: true };
  const w = walletList({ duringRead: (api) => api.drag(row) });
  w.list.innerHTML = "<the rows on screen>";
  await w.renderBalances();
  assert.equal(w.list.innerHTML, "<the rows on screen>", "the list is not rebuilt under the row being dragged");
  assert.equal(w.drag(), row);
});

test("Wallet list: a drag whose row has gone no longer holds the refresh, and a node stop clears it", async () => {
  let w = walletList({});
  w.drag({ isConnected: true });
  w.list.innerHTML = "old";
  await w.renderBalances();
  assert.deepEqual([w.list.innerHTML, w.calls.length], ["old", 0], "a live drag: the rebuild waits");
  w.drag({ isConnected: false });                                    // dragend never came, and the row is off the page
  await w.renderBalances();
  assert.equal(w.list.innerHTML, "<row 0x00 5>", "the balances are read and drawn again");
  assert.equal(w.drag(), null);

  w = walletList({});
  w.drag({ isConnected: true }); w.list.innerHTML = "old balances";
  w.run(false);                                                      // the node stops in the middle of a drag
  await w.renderBalances();
  assert.equal(w.list.innerHTML, "STOPPED", "a stopped node never leaves the old balances up");
  assert.equal(w.drag(), null);
  w.drag({ isConnected: true }); w.resetWalletFigures();
  assert.equal(w.drag(), null, "the stop handler clears it too");
});

// ---- 5 and 6. the coins dialog ----
const COINS = [{ coinid: "0xC1", amount: "600.25" }, { coinid: "0xC2", amount: "400.5" }, { coinid: "0xC3", amount: "12" }];
// the dialog wires each row's onclick on the nodes querySelectorAll gave it; keep those nodes to click them
async function coinsDialogRows(opts) {
  const keep = [];
  const realMatchAll = String.prototype.matchAll;
  const d = await (async () => {
    const p = page(), detail = [];
    let balanceReads = 0;
    const list = p.el("coinsList");
    p.el("coinsConsolidate").hidden = true;                          // as the dialog's markup has it
    list.querySelectorAll = function (sel) { if (sel !== ".coin-row") return []; const rows = [...realMatchAll.call(this.innerHTML, /data-i="(\d+)"/g)].map(m => ({ dataset: { i: m[1] } })); keep.push(...rows); return rows; };
    const env = {
      el: p.el, TOK, esc, copy() {}, toast() {}, document: {}, api: { ppPools: async () => [] },
      cmd: async (c) => {
        if (c === "balance") { const v = opts.balance[Math.min(balanceReads++, opts.balance.length - 1)]; if (v == null) throw new Error("no"); return [{ tokenid: "0x00", confirmed: v[0], unconfirmed: v[1] }]; }
        if (/sendable:true/.test(c)) { if (opts.sendable == null) throw new Error("node busy"); return COINS.filter(x => opts.sendable.includes(x.coinid)); }
        return COINS;
      },
      openDlg: () => ({ root: { isConnected: true } }), showCoinDetail: (c, s) => detail.push([c.coinid, s]),
      showTokenDetail() {}, splitDialog() {}, consolidateToken: async () => true, isNftBal: () => false, validTok: () => true, coinCount: (n) => n + " coins"
    };
    const showCoins = new Function(...Object.keys(env), 'const MINIMA = "0x00", PANDA_SENTINEL = "0x50"; let running = true;\n' +
      ["absCmp", "decAdd", "decSub", "coinsFootText", "showCoins"].map(source).join("\n") + "; return showCoins;")(...Object.values(env));
    await showCoins({ tokenid: "0x00", token: "Minima", sendable: "1000.75", confirmed: opts.shown || "1012.75" });
    return { foot: p.el("coinsFoot"), list, detail, consolidate: p.el("coinsConsolidate") };
  })();
  for (const r of keep) r.onclick();
  return d;
}

test("coins dialog: when the sendable read fails, no coin is called sendable or locked", async () => {
  const d = await coinsDialogRows({ sendable: null, balance: [["1012.75", "0"]] });
  assert.deepEqual(d.detail, [["0xC1", null], ["0xC2", null], ["0xC3", null]], "the detail is told the answer is not known");
  assert.ok(!d.list.innerHTML.includes("LOCKED"));
  assert.ok(d.foot.textContent.includes("locked coins could not be checked") && !/Locked: \d/.test(d.foot.textContent));
  assert.equal(d.consolidate.hidden, true, "Consolidate is not offered on a guess");
  const known = await coinsDialogRows({ sendable: ["0xC1", "0xC2"], balance: [["1012.75", "0"]] });
  assert.deepEqual(known.detail, [["0xC1", true], ["0xC2", true], ["0xC3", false]]);
  assert.equal(known.consolidate.hidden, false);
  assert.equal((known.list.innerHTML.match(/LOCKED/g) || []).length, 1); assert.ok(known.foot.textContent.includes("Locked: 1"));
});

test("coin detail: sendable is yes, no, or not stated at all", () => {
  const run = (sendable) => {
    let got = null;
    const env = { esc, copy() {}, el: () => ({}), openDlg: (id, title, body) => { got = { title, body }; return { root: { querySelectorAll: () => [] } }; } };
    new Function(...Object.keys(env), source("showCoinDetail") + "; return showCoinDetail;")(...Object.values(env))({ coinid: "0xC1", amount: "5" }, sendable);
    return got;
  };
  let d = run(null);
  assert.equal(d.title, "Coin"); assert.ok(!/Sendable<\/div>/.test(d.body), "no Sendable row");
  assert.ok(d.body.includes("Whether this coin is sendable could not be checked."));
  d = run(true); assert.equal(d.title, "Coin, sendable"); assert.ok(/Sendable<\/div>[\s\S]*?>yes</.test(d.body) && !d.body.includes("could not be checked"));
  d = run(false); assert.equal(d.title, "Coin, locked"); assert.ok(d.body.includes("no, locked in a contract"));
});

test("coins dialog footer: the sum is checked against a fresh confirmed + unconfirmed, and only a settled read can warn", async () => {
  // after a receive or a Split: 12 is still under three confirmations. The Wallet tab had confirmed 1000.75 when the dialog opened.
  let d = await coinsDialogRows({ sendable: ["0xC1", "0xC2", "0xC3"], shown: "1000.75", balance: [["1000.75", "12"]] });
  assert.equal(d.foot.textContent, "3 coins  ·  Locked: 0  ·  sum 1012.75"); assert.equal(d.foot.warn, false, "no false warning");
  d = await coinsDialogRows({ sendable: ["0xC1", "0xC2", "0xC3"], balance: [["1000", "0"]] });
  assert.equal(d.foot.textContent, "3 coins  ·  Locked: 0  ·  sum 1012.75\n⚠ These coins add up to 1012.75. The balance, confirmed and unconfirmed, is 1000."); assert.equal(d.foot.warn, true);
  d = await coinsDialogRows({ sendable: ["0xC1"], balance: [null] });
  assert.equal(d.foot.warn, false, "a failed balance read: no warning"); assert.ok(!d.foot.textContent.includes("⚠"));
  d = await coinsDialogRows({ sendable: ["0xC1"], balance: [["1000", "0"], ["1012.75", "0"]] });
  assert.equal(d.foot.warn, false, "the balance moved while the coins were read: no warning from a stale figure");
  d = await coinsDialogRows({ sendable: ["0xC1"], balance: [["1012.75", "0"], ["1000", "0"]] });
  assert.equal(d.foot.warn, false);
  assert.ok(!/[—–≠]/.test(source("coinsFootText")));
});

// ---- 7. dialogs: one at a time, focus inside, nothing closes or re-sends while a split is with the node ----
// A page where an element exists only while its overlay is on it, as in the app (el() of a removed id is null).
function dom() {
  let ids = {}, focused = null;
  const overlays = [];
  const mk = (id) => ({ id, value: "", disabled: false, isConnected: true, tabIndex: 0, onclick: null, onkeydown: null, focus() { focused = this; }, getClientRects: () => [1],
    hasAttribute: () => true, querySelector: () => mk(""), querySelectorAll: () => [] });
  const document = {
    get activeElement() { return focused; },
    body: { insertAdjacentHTML(where, html) {
      const mine = {}; for (const m of html.matchAll(/id="([A-Za-z]+)"/g)) mine[m[1]] = mk(m[1]);
      const root = mine[/id="([A-Za-z]+)"/.exec(html)[1]]; root.html = html;
      root.remove = () => { root.isConnected = false; overlays.splice(overlays.indexOf(root), 1); for (const k of Object.keys(mine)) { mine[k].isConnected = false; if (ids[k] === mine[k]) delete ids[k]; } };
      Object.assign(ids, mine); overlays.push(root);
    } },
    querySelectorAll: (sel) => (sel === "body > .overlay" ? overlays.slice() : overlays.filter(o => "#" + o.id === sel))
  };
  return { document, el: (id) => ids[id] || null, overlays, focus: (n) => { focused = n; }, focused: () => focused };
}
const flush = () => new Promise(r => setImmediate(r));

function splitPage() {
  const d = dom(), sent = [], toasts = [];
  let release = null;
  const env = { document: d.document, el: d.el, esc, toast: (m, k) => toasts.push((k || "") + ":" + m),
    validAmt: (a) => /^[0-9]*\.?[0-9]+$/.test(a) && parseFloat(a) > 0, validTok: () => true,
    cmd: async (c) => { if (c === "getaddress") return { miniaddress: "MxOWN" }; sent.push(c); await new Promise((res, rej) => { release = { ok: res, fail: () => rej(new Error("node says no")) }; }); return {}; } };
  const splitDialog = new Function(...Object.keys(env), 'const MINIMA = "0x00";\n' + source("splitDialog") + "; return splitDialog;")(...Object.values(env));
  return { d, sent, toasts, splitDialog, node: () => release };
}

test("Split dialog: one at a time, focus moves into it, and it cannot be closed or sent twice while the node has the split", async () => {
  const s = splitPage(), opener = { isConnected: true, focus() { s.d.focus(this); } };
  s.d.focus(opener);
  s.splitDialog("0x00", "Minima"); s.splitDialog("0x00", "Minima");            // Enter pressed twice on the button underneath
  assert.equal(s.d.overlays.length, 1, "no second overlay with the same ids");
  assert.equal(s.d.focused(), s.d.el("spAmt"), "focus is in the dialog, not on the Split button under it");
  const ov = s.d.el("splitOv"), go = s.d.el("spGo"), cancel = s.d.el("spCancel");
  assert.ok(/data-modal/.test(ov.html) && /role="dialog" aria-modal="true"/.test(ov.html));
  s.d.el("spAmt").value = "10"; s.d.el("spN").value = "4";
  const first = go.onclick(); await flush();
  assert.deepEqual(s.sent, ["send address:MxOWN amount:10 split:4"]);
  assert.equal(go.disabled && cancel.disabled, true);
  cancel.onclick(); ov.onclick({ target: ov }); ov.onkeydown({ key: "Escape", stopPropagation() {} });
  assert.equal(s.d.overlays.length, 1, "Cancel, a click outside and Escape do nothing while the split is in flight");
  await go.onclick(); s.splitDialog("0x00", "Minima"); await flush();
  assert.equal(s.sent.length, 1, "no second split from a second press or a reopened dialog");
  s.node().ok(); await first;                                                  // threw here before: el("spGo") of a removed dialog is null
  assert.equal(s.d.overlays.length, 0, "closed after the node accepted");
  assert.equal(s.d.el("spGo"), null); assert.equal(s.d.focused(), opener, "focus goes back to what opened it");
  assert.deepEqual(s.toasts, ["ok:Split ✓"]);
});

test("Split dialog: a refused split leaves the form open and usable; Escape closes it when nothing is in flight", async () => {
  const s = splitPage();
  s.splitDialog("0x00", "Minima");
  const ov = s.d.el("splitOv"), go = s.d.el("spGo");
  s.d.el("spAmt").value = "10"; s.d.el("spN").value = "1";
  await go.onclick();
  assert.deepEqual(s.toasts, [":Split into 2 to 20 coins."], "plain words, no dash");
  s.d.el("spN").value = "4";
  const run = go.onclick(); await flush(); s.node().fail(); await run;
  assert.equal(s.d.overlays.length, 1); assert.equal(go.disabled, false); assert.equal(s.toasts[1], "err:node says no");
  ov.onkeydown({ key: "Escape", stopPropagation() {} });
  assert.equal(s.d.overlays.length, 0);
});

test("confirm: one question at a time, focus on Cancel, Escape declines, focus goes back", async () => {
  const d = dom(), opener = { isConnected: true, focus() { d.focus(this); } };
  d.focus(opener);
  const showConfirm = new Function("document", "el", "esc", "let CONFIRM_QUEUE = Promise.resolve();\n" + source("showConfirm") + "; return showConfirm;")(d.document, d.el, esc);
  const a = showConfirm("Consolidate Minima?", "first", "Consolidate"), b = showConfirm("Send 5 Minima?", "second", "Send now");
  await flush();
  assert.equal(d.overlays.length, 1, "the second question waits; before, it shared the first one's button ids");
  assert.ok(d.overlays[0].html.includes("Consolidate Minima?") && /data-modal/.test(d.overlays[0].html));
  assert.equal(d.focused(), d.el("cfCancel"), "Enter on a fresh question cancels; it does not press what is underneath");
  d.el("cfOk").onclick();
  assert.equal(await a, true);
  await flush();
  assert.equal(d.overlays.length, 1); assert.ok(d.overlays[0].html.includes("Send 5 Minima?"), "now the second is asked, with its own buttons");
  d.el("confirmOv").onkeydown({ key: "Escape", stopPropagation() {} });
  assert.equal(await b, false);
  assert.equal(d.overlays.length, 0); assert.equal(d.focused(), opener);
});

test("coins dialog and coin detail: asked for twice, opened once; Tab stays inside the dialog on top", () => {
  const d = dom();
  const f = new Function("document", "el", "esc", source("openDlg") + "\n" + source("modalTab") + "; return { openDlg, modalTab };")(d.document, d.el, esc);
  const one = f.openDlg("coinsDlg", "Minima coins", "", "");
  assert.ok(one && one.root); assert.equal(f.openDlg("coinsDlg", "Minima coins", "", ""), null); assert.equal(d.overlays.length, 1);
  assert.ok(f.openDlg("coinDlg", "Coin", "", "")); assert.equal(f.openDlg("coinDlg", "Coin", "", ""), null); assert.equal(d.overlays.length, 2);
  for (const fn of ["showCoins", "showCoinDetail"]) assert.ok(/if \(!d\) return;/.test(source(fn)), fn + " stops when its dialog is already open");

  const stop = (name, over) => Object.assign({ name, disabled: false, tabIndex: 0, getClientRects: () => [1], focus() { d.focus(this); } }, over);
  const a = stop("a"), b = stop("b"), c = stop("c"), off = stop("off", { disabled: true }), hiddenOne = stop("hidden", { getClientRects: () => [] }), panel = stop("panel", { tabIndex: -1 });
  const top = d.overlays[1]; top.querySelectorAll = () => [panel, a, off, b, hiddenOne, c];
  const tab = (shift) => { let stopped = false; f.modalTab({ key: "Tab", shiftKey: !!shift, preventDefault() { stopped = true; } }); return stopped; };
  d.focus(c); assert.equal(tab(), true); assert.equal(d.focused(), a, "Tab on the last stop goes to the first");
  assert.equal(tab(true), true); assert.equal(d.focused(), c, "Shift+Tab on the first goes to the last");
  d.focus(b); assert.equal(tab(), false, "in the middle the browser moves focus itself");
  d.focus({ name: "the Split button underneath" }); assert.equal(tab(), true); assert.equal(d.focused(), a, "focus outside the dialog is brought in");
  top.hasAttribute = () => false; d.focus(c); assert.equal(tab(), false, "a dialog on top that is not one of these is left alone");
});

// ---- 8. wording: no long or short dash in what these screens say ----
test("wording: Wallet, coins dialog, Split, Receive, Send and History text has no em or en dash", () => {
  const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const cut = (from, to, after) => { const a = code.indexOf(from), b = code.indexOf(to, after ? code.indexOf(after, a) : a); assert.ok(a > 0 && b > a, from); return code.slice(a, b); };
  for (const [from, to, after] of [["async function renderBalances()", "function showActionSheet("], ["function showConfirm(", "CONFIRM_QUEUE = answer"], ["async function renderHistory()", "async function exportHistory()"], ["async function renderSend()", "\n}", "function sendForm()"]])
    assert.deepEqual(cut(from, to, after).split("\n").filter(l => /[—–]/.test(l)), [], from);
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(!/[—–]/.test(html.slice(html.indexOf('id="view-balances"'), html.indexOf('id="view-webwallet"'))));
  assert.ok(!/current address/i.test(app + html), "Receive does not claim one fixed address");
});
