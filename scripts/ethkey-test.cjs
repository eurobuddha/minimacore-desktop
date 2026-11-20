/*
 * ethkey-test.cjs — the ETH private key (0.18.152): one gated way to it, a clipboard that forgets it, a dialog that
 * closes itself. The AtomiX engine is stood in for; nothing reaches a node or the network.
 * Run: node --test scripts/ethkey-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const SYS = (o) => require("../main/syscheck").create(Object.assign({ can: () => false, prompt: async () => {}, confirm: async () => true, seen: () => false, markSeen: () => {} }, o));   // main/syscheck.js with stand-ins (0.18.176)
const fs = require("fs");
const path = require("path");
const Module = require("module");

const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === "./atomix" && parent && /[\\/]main[\\/]ethwallet\.js$/.test(parent.filename)) return { exportKey: () => "0xKEY", emitter: new (require("events"))() };
  return realLoad.apply(this, arguments);
};
const ethwallet = require("../main/ethwallet");
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const mainJs = rd("main/main.js"), preload = rd("main/preload.js"), app = rd("renderer/app.js"), axui = rd("renderer/atomix-ui.js");

test("main process: no key without the typed phrase; the system's prompt is asked where there is one, and a refusal ends it", async () => {
  let asked = 0;
  for (const typed of [undefined, null, "", "show key", "SHOW KEYS", "yes"]) await assert.rejects(ethwallet.exportKeyGated(typed, SYS({ can: () => true, prompt: async () => { asked++; } })), /Type SHOW KEY/, String(typed));
  assert.equal(asked, 0, "the phrase is checked before anything is prompted");
  assert.deepEqual(await ethwallet.exportKeyGated(" SHOW KEY ", SYS({ can: () => true, prompt: async () => { asked++; } })), { key: "0xKEY", system: true });
  assert.equal(asked, 1);
  await assert.rejects(ethwallet.exportKeyGated("SHOW KEY", SYS({ can: () => true, prompt: async () => { throw new Error("user cancelled"); } })), /^Error: Cancelled$/);
  assert.deepEqual(await ethwallet.exportKeyGated("SHOW KEY", SYS({ can: () => false, prompt: async () => { throw new Error("never"); } })), { key: "0xKEY", system: false }, "no system prompt here: the answer says so");
  assert.deepEqual(await ethwallet.exportKeyGated("SHOW KEY", SYS({ can: () => { throw new Error("x"); } })), { key: "0xKEY", system: false });
  await assert.rejects(ethwallet.exportKeyGated("SHOW KEY", null), /No system check is available/, "CHANGED on purpose (0.18.176): no system check at all is a refusal");
});

test("no ungated path is left: one IPC handler answers with a key, it is the gated one, and the AtomiX panel uses ETH Wallet's dialog", () => {
  for (const [name, src] of [["main.js", mainJs], ["preload.js", preload], ["app.js", app], ["atomix-ui.js", axui]]) assert.ok(!/axExportKey\(\)\.|mcd:axExportKey|axExportKey:/.test(src), name + ": mcd:axExportKey and its bridge are gone");
  const handlers = [...mainJs.matchAll(/ipcMain\.handle\("(mcd:[A-Za-z]+)"[^\n]*(?:exportKey|privKey)[^\n]*/gi)].map(m => m[1]);
  assert.deepEqual(handlers, ["mcd:ewExportKey"]);
  assert.ok(/ipcMain\.handle\("mcd:ewExportKey", \(_e, typed\) =>[^\n]*exportKeyGated\(typed/.test(mainJs), "the handler is the gated one");
  assert.ok(/ewExportKey: \(typed\) => ipcRenderer\.invoke\("mcd:ewExportKey", typed\)/.test(preload));
  assert.ok(/function axExportKey\(\) \{ exportKey\(\); \}/.test(axui) && !/\bpk\b/.test(axui), "the panel holds no key");
  assert.ok(/exportKey: \(\) => ewExportKey\(\)/.test(app));
  assert.ok(/app\.on\("will-quit", \(\) => \{ try \{ clipSecret\.clearNow\(\); \}/.test(mainJs) && /ipcMain\.handle\("mcd:clipSecret", \(_e, text\) => clipSecret\.copy\(text\)\);/.test(mainJs), "the secret clipboard is cleared at quit too");
});

test("a key on the clipboard is cleared after 60 seconds and at quit, and only if the clipboard still holds it", () => {
  const { create, CLEAR_MS } = require("../main/clipsecret"); assert.equal(CLEAR_MS, 60000);
  const rig = () => { const clip = { text: "", cleared: 0, writeText(t) { this.text = t; }, readText() { return this.text; }, clear() { this.text = ""; this.cleared++; } }, due = [];
    const timers = { setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; due.push(t); return t; }, clearTimeout: (t) => { t.on = false; } };
    return { clip, due, s: create(clip, timers), fire: () => due.filter(t => t.on).forEach(t => { t.on = false; t.fn(); }) }; };
  let r = rig(); r.s.copy("0xKEY"); assert.equal(r.clip.text, "0xKEY"); assert.equal(r.due[0].ms, 60000);
  r.fire(); assert.equal(r.clip.text, "", "cleared after the minute"); assert.equal(r.clip.cleared, 1);
  r = rig(); r.s.copy("0xKEY"); r.clip.text = "something the user copied since"; r.fire();
  assert.equal(r.clip.text, "something the user copied since", "never clears what is not the key");
  r = rig(); r.s.copy("0xKEY"); assert.equal(r.s.clearNow(), true, "at quit, before the minute is up"); assert.equal(r.clip.text, "");
  r = rig(); assert.equal(r.s.clearNow(), false, "nothing copied: nothing cleared"); assert.equal(r.clip.cleared, 0);
  r = rig(); r.clip.readText = () => { throw new Error("clipboard unavailable"); }; r.s.copy("0xKEY"); assert.equal(r.s.clearNow(), false, "never throws at quit");
});

test("the key dialog: the key is text in one node, Copy goes through the secret clipboard, it closes after 60 s and when the window is left", () => {
  const i = app.indexOf("\nfunction ewRevealKey("), src = app.slice(i, app.indexOf("\n}\n", i) + 3);
  const make = () => {
    const E = { html: "", nodes: {}, timers: [], win: {}, doc: {}, copied: [], removed: 0, hidden: false };
    const node = (id) => (E.nodes[id] = E.nodes[id] || { id, textContent: "", remove() { E.removed++; } });
    const bag = (b) => ({ addEventListener: (n, f) => { b[n] = f; }, removeEventListener: (n, f) => { if (b[n] === f) delete b[n]; } });
    const document = Object.assign({ body: { insertAdjacentHTML: (_w, h) => { E.html += h; } }, get hidden() { return E.hidden; } }, bag(E.doc));
    const fn = new Function("document", "window", "el", "api", "toast", "setTimeout", "clearTimeout", src + "\nreturn ewRevealKey;")(
      document, bag(E.win), node, { clipSecret: (k) => E.copied.push(k) }, () => {},
      (f, ms) => { E.timers.push({ f, ms, on: true }); return E.timers.length - 1; }, (t) => { if (E.timers[t]) E.timers[t].on = false; });
    return { E, fn };
  };
  let t = make(); t.fn("0xKEY", false);
  assert.ok(!t.E.html.includes("0xKEY"), "the key is not in the markup"); assert.equal(t.E.nodes.ewPkText.textContent, "0xKEY");
  assert.match(t.E.html, /No Touch ID check took place: this computer offered none, so the typed phrase and a confirmation were the only checks\./);
  assert.equal(t.E.timers[0].ms, 60000);
  t.E.nodes.ewPkCopy.onclick(); assert.deepEqual(t.E.copied, ["0xKEY"], "Copy goes through the main process's secret clipboard");
  t.E.timers[0].f(); assert.equal(t.E.removed, 1, "closed by itself after the minute"); assert.deepEqual(Object.keys(t.E.win), []); assert.deepEqual(Object.keys(t.E.doc), [], "its listeners are gone");
  t.E.nodes.ewPkCopy.onclick(); assert.deepEqual(t.E.copied, ["0xKEY"], "after closing, Copy has no key left");
  t = make(); t.fn("0xKEY", true); assert.ok(!/No Touch ID check/.test(t.E.html));
  t.E.win.blur(); assert.equal(t.E.removed, 1, "the window lost focus"); assert.equal(t.E.timers[0].on, false);
  t = make(); t.fn("0xKEY", true); t.E.doc.visibilitychange(); assert.equal(t.E.removed, 0, "still visible"); t.E.hidden = true; t.E.doc.visibilitychange(); assert.equal(t.E.removed, 1, "hidden");
});

// ---- 0.18.165: Settings' Reveal seed phrase goes through the same kind of gate ----
test("seed reveal: no node command without the typed phrase and, where offered, the system's prompt", async () => {
  const { revealSeedGated } = require("../main/seedgate");
  const sent = [], run = async (c) => { sent.push(c); return { status: true, response: { phrase: "ONE TWO THREE" } }; };
  for (const typed of [undefined, "", "show seed", "SHOW KEY", "yes"]) await assert.rejects(revealSeedGated(typed, SYS({ can: () => true }), run), /Type SHOW SEED/);
  await assert.rejects(revealSeedGated("SHOW SEED", SYS({ can: () => true, prompt: async () => { throw new Error("no"); } }), run), /^Error: Cancelled$/);
  assert.deepEqual(sent, [], "nothing asked of the node before both checks");
  assert.deepEqual(await revealSeedGated(" SHOW SEED ", SYS({ can: () => true }), run), { phrase: "ONE TWO THREE", system: true });
  assert.deepEqual(await revealSeedGated("SHOW SEED", SYS({}), run), { phrase: "ONE TWO THREE", system: false });
  assert.deepEqual(sent, ["vault", "vault"]);
  await assert.rejects(revealSeedGated("SHOW SEED", SYS({}), async () => ({ status: true, response: {} })), /Couldn't read the seed/);
  assert.ok(/ipcMain\.handle\("mcd:seedReveal", \(_e, typed\) => \{ requireRunning\(\);[^\n]*revealSeedGated\(typed, sysCheck,/.test(mainJs));
  assert.ok(/el\("setReveal"\)\.onclick = \(\) => settingsRevealSeed\(\);/.test(app) && !/setReveal[^\n]*tryCmd\("vault"\)/.test(app), "Settings no longer reads the seed with one click");
});
test("seed reveal screen: shown as text, hidden after 60 s and when the window is left", async () => {
  const i = app.indexOf("\nasync function settingsRevealSeed("), src = app.slice(i, app.indexOf("\n}\n", i) + 3);
  const make = (answer) => {
    const E = { timers: [], win: {}, doc: {}, hidden: false, box: { style: { display: "none" }, textContent: "" }, toasts: [] };
    const bag = (b) => ({ addEventListener: (n, f) => { b[n] = f; }, removeEventListener: (n, f) => { if (b[n] === f) delete b[n]; } });
    const document = Object.assign({ get hidden() { return E.hidden; } }, bag(E.doc));
    const fn = new Function("document", "window", "el", "api", "toast", "showPrompt", "setTimeout", "clearTimeout", src + "\nreturn settingsRevealSeed;")(
      document, bag(E.win), (id) => (id === "setSeed" ? E.box : null), { seedReveal: async (t) => { E.typed = t; return answer; } }, (t) => E.toasts.push(t), async () => "SHOW SEED",
      (f, ms) => { E.timers.push({ f, ms, on: true }); return E.timers.length - 1; }, (t) => { if (E.timers[t]) E.timers[t].on = false; });
    return { E, fn };
  };
  let t = make({ phrase: "ONE TWO", system: false }); await t.fn();
  assert.equal(t.E.typed, "SHOW SEED"); assert.ok(t.E.box.textContent.startsWith("ONE TWO\n\nNo Touch ID check took place")); assert.equal(t.E.timers[0].ms, 60000);
  t.E.timers[0].f(); assert.equal(t.E.box.textContent, ""); assert.equal(t.E.box.style.display, "none"); assert.deepEqual(Object.keys(t.E.win), []);
  t = make({ phrase: "ONE TWO", system: true }); await t.fn(); assert.ok(!/No Touch ID check/.test(t.E.box.textContent));
  t.E.win.blur(); assert.equal(t.E.box.textContent, "", "hidden when the window is left");
});

// ---- 0.18.176: the system's own check ----
test("syscheck: Touch ID when it can prompt; refused (not phrase only) once Touch ID worked here and cannot prompt now; a named confirmation where it never could", async () => {
  const { create } = require("../main/syscheck");
  let seen = false, asked = [], confirmed = [];
  const io = (o) => Object.assign({ can: () => true, prompt: async (w) => { asked.push(w); }, confirm: async (d) => { confirmed.push(d); return true; }, seen: () => seen, markSeen: () => { seen = true; } }, o);
  assert.deepEqual(await create(io({})).check("run the Terminal command vault action:seed", "detail"), { biometric: true });
  assert.deepEqual(asked, ["run the Terminal command vault action:seed"], "the reason names the command"); assert.equal(seen, true, "Touch ID worked: remembered");
  for (const can of [() => false, () => { throw new Error("x"); }]) await assert.rejects(create(io({ can })).check("r", "d"), /Touch ID has been used on this computer before but cannot be asked now/);
  assert.deepEqual(confirmed, [], "no fall-back to a confirmation while it is remembered");
  seen = false;
  assert.deepEqual(await create(io({ can: () => false })).check("r", "This Terminal command will run once: vault"), { biometric: false });
  assert.deepEqual(confirmed, ["This Terminal command will run once: vault"], "never available: the confirmation names what is shown");
  await assert.rejects(create(io({ can: () => false, confirm: async () => false })).check("r", "d"), /^Error: Cancelled$/);
  await assert.rejects(create(io({ prompt: async () => { throw new Error("no"); } })).check("r", "d"), /^Error: Cancelled$/);
  const G = require("../main/cmdgate"); asked = [];
  await G.create(create(io({}))).arm("vault action:seed", "SHOW SEED");
  assert.deepEqual(asked, ["show a seed phrase by running: vault action:seed"], "CHANGED on purpose (0.18.184): says what is shown, then the whole command");
  for (const [name, re] of [["mcd:seedReveal", /revealSeedGated\(typed, sysCheck,/], ["mcd:ewExportKey", /exportKeyGated\(typed, sysCheck\)/]]) assert.ok(re.test(mainJs), name + " uses the system check");
  assert.ok(/const cmdGate = require\("\.\/cmdgate"\)\.create\(sysCheck\);/.test(mainJs) && !/canPromptTouchID/.test(mainJs), "one system check for every gate");
});
