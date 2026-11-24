const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const app = read("renderer/app.js"), main = read("main/main.js"), manager = read("main/node-manager.js");
const panda = app.includes("function renderApps()");
function fn(source, name) {
  const match = source.match(new RegExp("^function " + name + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m"));
  assert.ok(match, name);
  return match[0];
}

test("the node reports the launched Keets setting until restart, then uses the next start's setting", () => {
  const method = manager.match(/^  keetsEnabled\(\) \{[\s\S]*?^  \}/m);
  assert.ok(method, "node transport policy");
  const params = { keets: false, keetschatonly: true };
  const node = vm.runInNewContext("({" + method[0] + "})", { config: { load: () => ({ params }) } });
  assert.equal(node.keetsEnabled(), false);
  node.proc = {};
  for (const on of [true, false]) {
    node.keetsAtStart = on;
    params.keets = !on;
    assert.equal(node.keetsEnabled(), on);
  }
  node.proc = null;
  assert.equal(node.keetsEnabled(), true);
  assert.match(manager, /this\.keetsAtStart = config\.load\(\)\.params\.keets === true && require\("\.\/keets-mode"\)\.enabledInArgs\(args\);[\s\S]*?this\.spawnFn\(/);
  assert.match(manager, /keetsEnabled: this\.keetsEnabled\(\)/);
});

test("switching to classic removes Chat and rejects a stale notification or direct route", () => {
  const tab = { hidden: true }, body = { replaceChildren() {} }, badge = {};
  const panels = { chatTab: tab, chatBody: body, chatBadge: badge };
  let resets = 0, focuses = 0, updates = 0;
  const calls = [];
  const ctx = vm.createContext({ el: id => panels[id], activeView: "balances", lastTabView: "chat",
    lastShellView: "chat", selectTab(view) { calls.push(view); ctx.activeView = view; },
    ChatPanel: { reset() { resets++; }, focusLatest() { focuses++; }, onUpdate() { updates++; } },
    refreshChatBadge() {}, renderApps() {} });
  for (const name of ["setChatAvailable", "focusChat", "onChatUpdate"]) vm.runInContext(fn(app, name), ctx);
  ctx.setChatAvailable(true);
  assert.equal(tab.hidden, false);
  ctx.focusChat(); ctx.onChatUpdate();
  assert.equal(focuses, 1);
  assert.equal(updates, 1);
  ctx.setChatAvailable(false);
  assert.equal(tab.hidden, true);
  assert.deepEqual(calls, ["chat", "balances"]);
  if (panda) assert.equal(ctx.lastTabView, "balances");
  ctx.focusChat(); ctx.onChatUpdate();
  assert.equal(focuses, 1);
  assert.equal(updates, 1);
  assert.equal(resets, 1);
  vm.runInContext(fn(app, "selectTab"), ctx);
  ctx.selectTab("chat"); // returns before touching any other screen or shell controls
  assert.equal(ctx.activeView, "balances");
  assert.match(app, /api\.onChatFocus\(focusChat\)/);
  assert.match(app, /setChatAvailable\(s\.keetsEnabled === true\)/);
  assert.doesNotMatch(app, /chtab\.hidden = false/);
  if (panda) assert.match(fn(app, "renderApps"), /a\.id !== "chat" \|\| !el\("chatTab"\)\.hidden/);
  else assert.match(read("renderer/app.css"), /\.tab\[hidden\] *\{ *display: none/);
});

test("chat IPC refuses access when off and forwards the original arguments when on", () => {
  const handlers = new Map();
  let on = false, calls = 0;
  const ctx = vm.createContext({ node: { keetsEnabled: () => on }, ipcMain: { handle: (key, handler) => handlers.set(key, handler) } });
  vm.runInContext(fn(main, "requireChat"), ctx);
  vm.runInContext(fn(main, "handleChat"), ctx);
  ctx.handleChat("mcd:chatThread", (_, peer) => { calls++; return peer; });
  assert.throws(() => handlers.get("mcd:chatThread")(null, "peer"), /Keets/);
  assert.equal(calls, 0);
  on = true;
  assert.equal(handlers.get("mcd:chatThread")(null, "peer"), "peer");
  assert.equal(calls, 1);
  const unguarded = Array.from(main.matchAll(/ipcMain\.handle\("(mcd:chat[^"]*)"/g), m => m[1]);
  assert.deepEqual(unguarded.sort(), ["mcd:chatApplyBackup", "mcd:chatExportBackup", "mcd:chatOpenBackup"]);
});


test("launch arguments read both node kinds with a saved override or a chat-only sidecar", () => {
  const { enabledInArgs } = require("../main/keets-mode");
  for (const [flags, on] of [
    [[], false], [["-keetschatonly"], false], [["-keets"], true], [["-keets", "-keetschatonly"], true],
    [["-keets", "-port", "9001", "-keets", "false"], false], [["-keets", "true"], true]
  ]) {
    assert.equal(enabledInArgs(["-jar", "minima.jar", ...flags]), on);
    assert.equal(enabledInArgs(["-Dparlons.node.args=" + flags.join(" "), "-jar", "parlons.jar"]), on);
  }
});

test("disabling a live panel closes its photo and dialog and discards pending audio", async () => {
  const tab = { hidden: false }, removed = [], listeners = new Set();
  const events = { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const ui = new Map([["chatTab", tab]]);
  const document = { ...events, body: { insertAdjacentHTML(_, html) {
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) ui.set(id, {
      style: {}, querySelector: () => null, querySelectorAll: () => [], remove: () => { removed.push(id); ui.delete(id); }
    });
  } } };
  const window = { ...events };
  let deliver, plays = 0;
  const ctx = vm.createContext({ window, document, I18N: { t: s => s }, L_: s => s, th: s => s,
    Audio: class { play() { plays++; } } });
  const source = read("renderer/chat.js").replace("window.ChatPanel = {",
    "window.openChatTest = { dialog, lightbox, toggleAudio }; window.ChatPanel = {");
  vm.runInContext(source, ctx);
  window.ChatPanel.init({ el: id => ui.get(id), esc: s => s, toast() {},
    api: { chatMedia: () => new Promise(resolve => { deliver = resolve; }) } });
  const { dialog, lightbox, toggleAudio } = window.openChatTest;
  const result = dialog({ title: "Contact", actions: [] });
  lightbox("data:image/png;base64,AQ==", "");
  const audio = toggleAudio("keets://drive/voice", () => {});
  tab.hidden = true;
  window.ChatPanel.reset();
  tab.hidden = false; // a late response still belongs to the session that was disabled
  deliver("data:audio/ogg;base64,AQ==");
  await audio;
  assert.equal(plays, 0);
  assert.ok(removed.includes("chatLb"));
  assert.ok(removed.includes("chatOv"));
  assert.equal(listeners.size, 0);
  assert.equal(await result, null);
});
