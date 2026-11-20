// Terminal, Logs and the Apps tab's Freeze (Phase 5a). Executed where the logic is pure; nothing here reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const app = R("renderer/app.js"), html = R("renderer/index.html"), mainJs = R("main/main.js");
// a one-line definition, or a block that ends at the first "}" in column 0 (as scripts/wallet-money-test.cjs)
function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  const code = m[1].replace(/\s+\/\/.*$/, "");
  return /\{$/.test(code) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
const lift = (names, extra) => new Function((extra || "") + names.map(source).join("\n") + "\nreturn { " + names.join(", ") + " };")();

// ---- Terminal ----
test("Terminal: Pandamonium's screen (banner, output, command field, Run) with the desktop's completion kept", () => {
  const view = html.slice(html.indexOf('id="view-terminal"'), html.indexOf('id="view-logs"'));
  for (const id of ["termBanner", "termOut", "termIn", "termRun", "termSug", "termHint"]) assert.ok(view.includes('id="' + id + '"'), id);
  assert.ok(/placeholder="Enter command"/.test(view) && />Run</.test(view));
  assert.ok(view.indexOf('id="termOut"') < view.indexOf('id="termIn"'), "the output is above the field");
  const TERM_BANNER = new Function("return " + app.slice(app.indexOf("const TERM_BANNER = ") + 20, app.indexOf("];", app.indexOf("const TERM_BANNER = ")) + 1))();
  assert.deepEqual(TERM_BANNER, ["**********************************************", "*  __  __  ____  _  _  ____  __  __    __    *", "* (  \\/  )(_  _)( \\( )(_  _)(  \\/  )  /__\\   *",
    "*  )    (  _)(_  )  (  _)(_  )    (  /(__)\\  *", "* (_/\\/\\_)(____)(_)\\_)(____)(_/\\/\\_)(__)(__) *", "*                                            *", "**********************************************"], "TerminalView's banner, line for line");
  assert.ok(TERM_BANNER.every(l => l.length === 46));
  assert.ok(/Welcome to Minima Core /.test(app) && /You can run commands in this Terminal\.\./.test(app));
  assert.ok(/TermComplete\.suggest/.test(app) && /termSugAccept/.test(app), "completion is still wired");
  const term = app.slice(app.indexOf("// ---- Terminal: Pandamonium's TerminalView"), app.indexOf("// ---- Settings ------"));
  assert.ok(!/innerHTML/.test(term), "the Terminal's output is never written as HTML: a reply can carry any text");
});
test("Terminal: JSON is coloured by kind, and the text is exactly the text", () => {
  const { termJsonParts } = lift(["termJsonParts"]);
  const text = JSON.stringify({ command: "status", status: true, pending: false, n: -1.5e3, nothing: null, error: "it failed", list: ["a\"b", 2], html: "<img src=x onload=alert(1)>" }, null, 2);
  const parts = termJsonParts(text);
  assert.equal(parts.map(p => p[1]).join(""), text, "no character is added, dropped or changed");
  const of = (cls) => parts.filter(p => p[0] === cls).map(p => p[1]);
  assert.deepEqual(of("j-key"), ['"command"', '"status"', '"pending"', '"n"', '"nothing"', '"error"', '"list"', '"html"']);
  assert.deepEqual(of("j-str"), ['"status"', '"a\\"b"', '"<img src=x onload=alert(1)>"']);
  assert.deepEqual(of("j-bool"), ["true"]); assert.deepEqual(of("j-null"), ["null"]); assert.deepEqual(of("j-num"), ["-1500", "2"]);
  assert.deepEqual(of("j-err"), ["false", '"it failed"'], "false and failure words in red, as mds/terminalIDE");
  const css = R("renderer/apps.css");
  for (const [cls, dark] of [["key", "#6ea8fe"], ["str", "#7ee787"], ["num", "#f0a45d"], ["bool", "#d2a8ff"], ["null", "#7f909e"], ["err", "#ff6b6b"]]) assert.ok(css.includes("--t-" + cls + ": " + dark), "terminalIDE's " + cls + " colour in dark");
  assert.ok(/prefers-color-scheme: light\) \{ #view-terminal \{ --t-cmd:/.test(css), "darker inks on the light theme");
});
test("Terminal: a typed send leaves the coin guard byte for byte in the default (observe) mode, whatever is held", async () => {
  const { createRegistry } = require("../main/reserve"), { makeNode, coinId, ADDR } = require("./reserve-model.cjs");
  const node = makeNode([{ coinid: coinId(1), amount: "100", address: ADDR(1) }, { coinid: coinId(2), amount: "50", address: ADDR(2) }]), lines = [];
  const reg = createRegistry({ log: (l) => lines.push(l) });
  assert.deepEqual(reg.mode(), { on: true, sends: "observe" });
  reg.setHolds("dexicon", [{ coinid: coinId(1), why: "a live Dexicon order" }]);
  for (const typed of ["send amount:40 address:" + ADDR(7), "SEND  amount:1.50   address:" + ADDR(7) + " tokenid:0x00 burn:0.01", "send amount:500 address:" + ADDR(7),
    'send amount:1 address:' + ADDR(7) + ' state:{"0":"a b","1":"0xFF"}', "send amount:1 address:" + ADDR(7) + " fromaddress:" + ADDR(1)]) {
    const r = await reg.guard("", typed, node.run);   // owner "" = the wallet: what the Terminal's commands are
    assert.notEqual(r && r.reserved, true, "not refused by the guard: " + typed);
    assert.equal(node.saw(/^send\b/i).pop(), typed, "byte-identical");
    node.dropMempool();
  }
  assert.ok(lines.some(l => /^observe: `send` of wallet WOULD HAVE BEEN/.test(l)), "what Enforce would have done is logged, nothing more");
});
test("Terminal: what CAN be added to a typed MINIMA send is the old beacon-dust pin, and the Terminal says so; restores stay refused", async () => {
  const { pinMinimaSend } = require("../main/sendpin"), A = "0x" + "AB".repeat(32);
  const run = async (c) => (c.startsWith("coins ") ? { status: true, response: [{ coinid: "0x01", amount: "5", address: A }] } : c.startsWith("checkaddress") ? { status: true, response: { simple: true } } : { status: true });
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD", { minCoinage: 3 }), "send amount:1 address:0xCD fromaddress:" + A, "main.js adds fromaddress: to a MINIMA send that names none (0.16.x, unchanged here)");
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD fromaddress:0xEE", { minCoinage: 3 }), "send amount:1 address:0xCD fromaddress:0xEE", "the user's own fromaddress: is left alone");
  assert.equal(await pinMinimaSend(run, "send amount:1 address:0xCD tokenid:0x7D39", { minCoinage: 3 }), "send amount:1 address:0xCD tokenid:0x7D39", "a token send is left alone");
  const { termSendNote } = lift(["termSendNote"]);
  assert.match(termSendNote("send amount:1 address:0xCD"), /^note: a MINIMA send with no fromaddress: may be given one/);
  assert.match(termSendNote("SEND amount:1 address:0xCD tokenid:0x00"), /^note:/);
  assert.equal(termSendNote("send amount:1 address:0xCD fromaddress:0xEE"), ""); assert.equal(termSendNote("send amount:1 address:0xCD tokenid:0x7D39"), ""); assert.equal(termSendNote("status"), ""); assert.equal(termSendNote("sendpoll action:list"), "");
  assert.ok(/ipcMain\.handle\("mcd:cmd"[\s\S]{0,700}restore\.loadsBackupFile\(command\)[\s\S]{0,900}restore\.backupCommandProblem\(command\)/.test(mainJs), "restore, restoresync and megammrsync file: are still refused on the command channel");
  assert.ok(/const run = \(c\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\);/.test(mainJs), "a Terminal command goes through rpcCall (signing queue and coin guard) as the wallet");
});
