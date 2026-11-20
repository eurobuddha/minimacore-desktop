// The Pandamonium shell (0.18.69+): pins the six tabs, the tray, the overflow menu and the system theme,
// so a later change cannot quietly bring back the old seventeen-tab strip or the theme toggle.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
const css = fs.readFileSync(path.join(R, "style.css"), "utf8");
const shell = fs.readFileSync(path.join(R, "shell.css"), "utf8");

test("the tab strip is Pandamonium's six, in order, and nothing else is a tab", () => {
  const tabs = [...html.matchAll(/<button class="tab[^"]*"[^>]*data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ["wallet", "dexicon", "history", "apps", "chat", "node"]);
  const labels = [...html.matchAll(/<span class="tab__l">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ["Wallet", "Dexicon", "History", "Apps", "Chat", "Node"], "sentence case, as the phone");
  assert.ok(!/data-view="(receive|send|terminal|logs|settings|mail|ethwallet|vestr|minimall|webwallet|parlons)"/.test(html), "the old tabs are not tabs");
});

test("every existing view still has its screen, and each is reachable from its new place", () => {
  for (const v of ["balances", "receive", "send", "webwallet", "mail", "chat", "pandapools", "atomix", "ethwallet", "minimall",
    "parlons", "vestr", "history", "terminal", "logs", "settings", "node", "apps", "faucet"]) {
    assert.ok(html.includes(`id="view-${v}"`), "view-" + v + " exists");
    assert.ok(new RegExp(`activeView === "${v}"`).test(app), v + " is rendered by renderActive");
  }
  const tabOf = app.match(/const TAB_OF = \{([^}]+)\}/)[1];
  for (const v of ["balances", "atomix", "pandapools", "history", "apps", "chat", "node"]) assert.ok(tabOf.includes(v + ":"), v + " sits under a tab");
  const sub = app.match(/const SUB_TITLE = \{([^}]+)\}/)[1];
  for (const v of ["receive", "send", "logs", "terminal", "settings"]) assert.ok(sub.includes(v + ":"), v + " is a titled sub screen");
  const tray = [...app.match(/const TRAY_APPS = \[([\s\S]+?)\n\];/)[1].matchAll(/id: "([a-z]+)", name: "([^"]+)"/g)].map(m => m[1] + "=" + m[2]);
  assert.deepEqual(tray, ["core=Minima Core", "mail=MinimaMail", "ethwallet=ETH Wallet", "explorer=Minima Explorer", "vestr=Minima Vestr", "entropy=Entropy", "keyuses=KeyUses", "faucet=Minima Faucet",
    "minimall=miniMall", "webwallet=Web Wallet", "parlons=Parlons"], "the tray's default order; no row for an app the desktop does not have");
  assert.ok(/id="walSend"/.test(html) && /id="walReceive"/.test(html), "Send and Receive open from the Wallet's buttons");
});

test("the overflow menu is the phone's desktop subset, in the phone's order", () => {
  const acts = [...html.matchAll(/role="menuitem" data-act="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(acts, ["logs", "terminal", "backup", "params", "shutdown", "settings"]);
  for (const a of acts) assert.ok(app.includes(`"${a}"`), a + " has a handler");
  assert.ok(!/App Lock|Allow Screenshots|Battery/.test(html), "phone-only items are left out");
});

test("the badges survived the move", () => {
  assert.ok(/id="chatBadge"/.test(html), "chat count on the Chat tab");
  assert.ok(/badge: "mailBadge"/.test(app) && /badge: "shopBadge"/.test(app), "mail and miniMall counts on their tray rows");
  assert.ok(/id="chatTab"[^>]*hidden/.test(html), "the Chat tab stays hidden until boot() shows it");
});

test("the theme follows the system: no toggle, Pandamonium's exact tokens", () => {
  assert.ok(!/themeBtn|cycleTheme|setTheme/.test(html + app), "no theme toggle anywhere");
  assert.ok(/prefers-color-scheme: light/.test(css) && /prefers-color-scheme: light/.test(app));
  const dark = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: light)"));
  const light = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
  for (const [k, v] of Object.entries({ "--orange": "#FF4A2B", "--blue": "#2F6BF6", "--bg": "#0F1114", "--surface": "#16181C", "--surface2": "#1C2026",
    "--border": "#262A31", "--text": "#F4F6F8", "--dim": "#9AA0A8", "--dim2": "#5E646D", "--green": "#34C759", "--amber": "#FFB020", "--red": "#FF5A3D" }))
    assert.ok(new RegExp(k + ":\\s*" + v + ";").test(dark), "dark " + k + " is " + v);
  for (const [k, v] of Object.entries({ "--bg": "#F4F5F7", "--surface": "#FFFFFF", "--surface2": "#F0F2F4", "--border": "#E4E7EB", "--text": "#14171B",
    "--dim": "#5B616B", "--dim2": "#9CA2AB", "--green": "#1F9D48", "--amber": "#B8791A", "--red": "#D33B22" }))
    assert.ok(new RegExp(k + ":\\s*" + v + ";").test(light), "light " + k + " is " + v);
  for (const v of ["#12171B", "#192024", "#F4F4EB", "#A1AEAC", "#DAE199"]) assert.ok(shell.includes(v), "tray colour " + v);
  assert.ok(/--radius-card: 16px/.test(css) && /--radius: 12px/.test(css) && /--radius-btn: 13px/.test(css), "one corner system: 16 / 12 / 13");
});

test("shell text: sentence case and no em dash", () => {
  assert.ok(!/text-transform:\s*uppercase/.test(shell.replace(/\.eyebrow \{[^}]+\}/, "")), "only the phone's section eyebrow is uppercase");
  const chrome = html.slice(html.indexOf('<div class="shell"'), html.indexOf('<main class="main"'));
  assert.ok(!chrome.includes("—"), "no em dash in the shell markup");
});

test("tray order: Minima Core pinned, saved ids kept once, unknown ids dropped, a new app takes its default place", () => {
  const trayOrder = new Function(app.match(/function trayOrder\(saved, ids\) \{[\s\S]+?\n\}/)[0] + "; return trayOrder;")();
  const ids = ["core", "mail", "ethwallet", "vestr", "parlons"];
  assert.deepEqual(trayOrder(null, ids), ids, "nothing saved: the default order");
  assert.deepEqual(trayOrder("parlons,mail", ids), ["core", "parlons", "mail", "ethwallet", "vestr"]);
  assert.deepEqual(trayOrder("vestr,core,vestr,casino,mail", ids), ["core", "vestr", "parlons", "mail", "ethwallet"], "core cannot be moved; duplicates and removed apps are ignored; an app never saved goes after its default neighbour");
  // an existing user's saved order (0.19.124's seven apps, two of them moved) when a new version adds rows: each new row sits after the app before it by default
  const now = ["core", "mail", "ethwallet", "vestr", "keyuses", "faucet", "minimall", "webwallet", "parlons"];
  assert.deepEqual(trayOrder("mail,ethwallet,vestr,faucet,minimall,webwallet,parlons", now), now, "an untouched order: the new row is at its default place, not at the end");
  assert.deepEqual(trayOrder("parlons,mail,ethwallet,faucet,minimall,webwallet,vestr", now), ["core", "parlons", "mail", "ethwallet", "faucet", "minimall", "webwallet", "vestr", "keyuses"], "it follows the app it comes after by default, wherever that was moved to");
  const real = [...app.match(/const TRAY_APPS = \[([\s\S]+?)\n\];/)[1].matchAll(/id: "([a-z]+)"/g)].map(m => m[1]);
  const old = real.filter(id => !["keyuses", "explorer", "entropy", "futurecash"].includes(id));
  assert.deepEqual(trayOrder(old.slice(1).join(","), real), real, "the shipped list: a 0.19.124 order replayed gives today's default order");
  assert.ok(/shellOrder/.test(app) && /dragstart/.test(app) && /altKey/.test(app), "saved, draggable, and movable by keyboard");
});

test("Apps tab: a Hide and a Freeze switch per app (0.19.117), Minima Core locked", () => {
  assert.ok(/role="switch"/.test(app) && /shellHidden/.test(app), "a real switch, saved");
  assert.ok(/core \|\| a\.tab \? " disabled" : ""/.test(app), "Minima Core cannot be hidden (nor a tab: it has no drawer row)");
  assert.ok(/Always on/.test(app) && /In app drawer/.test(app) && /Hidden from drawer/.test(app), "the phone's three states");
  assert.ok(/<span>Freeze<\/span>/.test(app) && /api\.freezeSet\(id, on\)/.test(app) && /Deep frozen/.test(app), "Freeze is a real switch: the main process freezes, or says why not (scripts/apps-screens.test.cjs)");
  assert.ok(!/External/.test(html.slice(html.indexOf('id="view-apps"'), html.indexOf('id="view-faucet"'))), "no External sub-tab");
});

test("Node tab: the phone's NODE and IDENTITY cards, then the desktop's own controls", () => {
  const node = app.slice(app.indexOf("function renderNode(s)"), app.indexOf("let logLines"));
  const rows = [...node.matchAll(/row\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(rows.slice(0, 7), ["Block", "Block time", "Connections", "Incoming", "Random peer", "Minima", "App version"]);
  assert.ok(/>Status</.test(node) && /"Online"/.test(node) && /"Waiting for node"/.test(node), "the Status row and the phone's two states");
  for (const id of ["nRestart", "nContrib", "nReconfig", "nReclaim"]) assert.ok(node.includes(`id="${id}"`) && node.includes(`el("${id}")`), id + " kept and wired");
  assert.ok(/tryCmd\("keys"\), tryCmd\("peers"\), tryCmd\("network"\)/.test(app), "the phone's three read-only dashboard commands");
});

// ---- executed, not read: the functions are lifted out of app.js and run ----
function lift(names, extra) {   // a one-line definition, or a block that ends at the first "}" in column 0
  const src = names.map(n => {
    const m = app.match(new RegExp("\\n((?:const|function) " + n + "\\b[^\\n]*)")); assert.ok(m, n + " found in app.js");
    return /\{$/.test(m[1]) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
  }).join("\n");
  return new Function((extra || "") + src + "; return { " + names.filter(n => /^[a-z]/.test(n)).join(", ") + " };")();
}

test("block time: the node's Java date is read without Date parsing (BST, CET, GMT, no blocks, nothing)", () => {
  const { clock, blockTime } = lift(["clock", "blockTime"]);
  for (const zone of ["BST", "CET", "GMT", "JST"]) {
    const t = "Thu Jul 16 14:54:04 " + zone + " 2026";
    assert.equal(clock(t), "14:54:04", zone + " footer clock");
    assert.equal(blockTime(t), "Jul 16, 2026, 14:54:04 " + zone, zone + " Node tab block time");
  }
  assert.equal(blockTime("Mon Nov 2 03:04:05 CET 2026"), "Nov 2, 2026, 03:04:05 CET");
  for (const none of ["NO BLOCKS YET", "", null, undefined]) assert.equal(clock(none), "", "no clock for " + none);
  assert.equal(blockTime("NO BLOCKS YET"), "No blocks yet");
  assert.equal(blockTime(""), ""); assert.equal(blockTime(undefined), "");
  assert.equal(blockTime("2026-07-16 14:54:04"), "2026-07-16 14:54:04", "an unknown format with a clock is shown as the node gave it");
  assert.ok(isNaN(new Date("Thu Jul 16 14:54:04 BST 2026")), "the reason: JavaScript cannot parse the zone name");
});

test("tab selection: where a view sits decides what the shell wears", () => {
  const { shellMode, viewOfTab } = lift(["TAB_OF", "SUB_TITLE", "viewOfTab", "shellMode"], 'let dexView = "pandapools";\n');
  assert.deepEqual(shellMode("balances"), { tab: "wallet", mode: "tabs" });
  assert.deepEqual(shellMode("pandapools"), { tab: "dexicon", mode: "dex" }, "Dexicon is full screen: none of the shell's bars");
  assert.deepEqual(shellMode("dexicon"), { tab: "dexicon", mode: "dex" });
  assert.deepEqual(shellMode("node"), { tab: "node", mode: "tabs" });
  for (const v of ["send", "receive", "logs", "terminal", "settings"]) assert.deepEqual(shellMode(v), { tab: "", mode: "sub" }, v);
  for (const v of ["mail", "ethwallet", "faucet", "parlons"]) assert.deepEqual(shellMode(v), { tab: "", mode: "app" }, v);
  assert.equal(viewOfTab("wallet"), "balances");
  assert.equal(viewOfTab("dexicon"), "pandapools", "the Dexicon tab reopens the panel it last showed");
  assert.equal(viewOfTab("history"), "history");
});

test("Shutdown asks the main process what is in flight (the Quit warning's own source), and a stopped node shows a strip with Start", () => {
  // the words themselves, and "could not be checked", are pinned in scripts/inflight-test.cjs (main/inflight.js says them for Shutdown and Quit alike)
  assert.ok(/const w = await Promise\.race\(\[api\.inFlight\("shutdown"\)\.catch\(\(\) => null\)/.test(app) && !/function shutdownWarning|api\.ppWork|api\.dxWork/.test(app), "one source: no second copy of the warning in the window");
  assert.ok(/\|\| \{ title: "Shut down the node\?", message: "Could not be checked: /.test(app), "no answer from the main process is said, never shown as idle");
  assert.ok(/id="stopBar"[^>]*hidden/.test(html) && /id="stopStart"/.test(html) && /api\.nodeStart\(\)/.test(app), "a stopped node shows a strip with Start");
});

test("a hidden app's unread still counts: the tray dot, and its Apps tab row", () => {
  const { trayDotOn } = lift(["trayDotOn"]);
  const row = (count, hidden) => ({ count, hidden });
  assert.equal(trayDotOn([row(false, false), row(false, true)], false), false, "nothing unread: no dot");
  assert.equal(trayDotOn([row(true, false)], false), true, "a shown app, tray closed: dot");
  assert.equal(trayDotOn([row(true, false)], true), false, "a shown app, tray open: its row shows the count");
  assert.equal(trayDotOn([row(true, true)], false), true, "a hidden app, tray closed: dot");
  assert.equal(trayDotOn([row(true, true)], true), true, "a hidden app, tray open: its row is not there, so the dot stays");
  assert.equal(trayDotOn([row(false, true), row(true, true)], true), true);
  assert.ok(/data-count="\$\{a\.badge\}"/.test(app) && /function paintAppsCounts/.test(app), "the count is drawn on the Apps tab row");
});

test("the overflow menu is reachable from sub screens and tray apps; an overlaying tray is modal", () => {
  const hides = [...shell.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)].map(m => m[1]).join(",");
  assert.ok(/data-mode="sub"\] \.bar__tray/.test(hides), "the scan sees the hide rules");
  for (const mode of ["sub", "app"]) assert.ok(!hides.includes('data-mode="' + mode + '"] .bar__more'), mode + " screens keep the overflow button");
  assert.ok(/el\("stage"\)\.inert = open && NARROW\.matches/.test(app) && /id="stage"/.test(html), "the screen under an overlaying tray is inert");
});

// 0.19.126: 0.19.125 removed a helper and left its name in MailPanel.init's list, at the top level of app.js: a
// ReferenceError there stops the script, and with it every screen. No test read the renderer as a program.
// 0.19.131: this one does, the whole of it. The script list is index.html's own <script src> tags; nothing here names
// a renderer script or one of its exports.
//   1. every renderer/*.js on disk is loaded by a tag (a dropped tag fails even where the code tolerates the absence);
//   2. every file's top level runs, in tag order, in ONE vm context whose only stand-ins are the browser's own objects
//      (a name used at a top level before its script has loaded throws, as in the window);
//   3. every name a script uses anywhere, also inside its functions, is defined once all have loaded. The names come
//      from TypeScript's checker over the same files with the browser's own type library ("Cannot find name", and a
//      property read off window); one is settled when the vm context holds it, or when the file itself asks
//      `typeof name` first.
const vm = require("node:vm"), ts = require("typescript");
const readRenderer = (f) => fs.readFileSync(path.join(R, f), "utf8");
function rendererLoads(page, read = readRenderer) {
  const any = () => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? () => any() : any()), apply: () => any(), construct: () => any() });   // a then() that never answers: boot() stops at its first await
  const order = [...page.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]), box = {};
  for (const f of fs.readdirSync(R)) if (f.endsWith(".js") && !order.includes(f)) throw new Error(f + ": no script tag loads it");
  for (const k of ["document", "localStorage", "navigator", "location", "mcd", "crypto", "matchMedia", "addEventListener", "requestAnimationFrame", "setTimeout", "setInterval", "clearTimeout", "clearInterval"]) box[k] = any();   // the browser's, and the preload's bridge
  box.window = box;
  const ctx = vm.createContext(box);
  for (const f of order) { try { vm.runInContext(read(f), ctx, { filename: f }); } catch (e) { throw new Error(f + ": " + e.name + ": " + e.message); } }
  const host = ts.createCompilerHost({}), lib = host.getSourceFile.bind(host), files = new Map(order.map(f => [path.join(R, f), f]));
  host.getSourceFile = (name, ...rest) => (files.has(name) ? ts.createSourceFile(name, read(files.get(name)), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS) : lib(name, ...rest));
  const prog = ts.createProgram([...files.keys()], { allowJs: true, checkJs: true, noEmit: true, noResolve: true, types: [], lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], target: ts.ScriptTarget.ES2022 }, host);
  for (const [file, f] of files) for (const d of prog.getSemanticDiagnostics(prog.getSourceFile(file))) {
    const m = /^(?:Cannot find name|Property) '([A-Za-z_$][\w$]*)'(\.| does not exist on type 'Window & typeof globalThis')/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "));
    if (m && vm.runInContext("typeof " + m[1], ctx) === "undefined" && !new RegExp("typeof (?:window\\.)?" + m[1].replace(/\$/g, "\\$") + "\\b").test(read(f)))
      throw new Error(f + ": ReferenceError: " + m[1] + " is not defined (line " + (prog.getSourceFile(file).getLineAndCharacterOfPosition(d.start).line + 1) + ")");
  }
  return order;
}
test("the renderer loads: every script of index.html, in its order, and no name is used that nothing defines", () => {
  const order = rendererLoads(html), tag = (f) => '<script src="' + f + '"></script>';
  assert.equal(order[order.length - 1], "app.js"); assert.ok(order.length >= 20);
  const edit = (f, from, to) => (g) => { const s = readRenderer(g); if (g !== f) return s; assert.ok(s.includes(from), f + " has " + from); return s.split(from).join(to); };
  assert.throws(() => rendererLoads(html, edit("app.js", "api, esc, el, toast, copy, relTime,", "api, esc, el, toast, copy, short, relTime,")), /app\.js: ReferenceError: short is not defined/, "the 0.19.125 slip is caught");
  for (const f of order) assert.throws(() => rendererLoads(html.replace(tag(f), "")), /no script tag loads it|is not defined/, "a dropped tag: " + f);
  const swap = (a, b) => html.replace(tag(a), "\u0000").replace(tag(b), tag(a)).replace("\u0000", tag(b));
  assert.throws(() => rendererLoads(swap("apps-act.js", "app.js")), /app\.js: ReferenceError: \w+ is not defined/, "app.js before the scripts whose names its top level uses");
  assert.throws(() => rendererLoads(swap("dexicon-core.js", "dexicon-ui.js")), /dexicon-ui\.js: ReferenceError: DexCore is not defined/);
  assert.throws(() => rendererLoads(html, edit("entropy-core.js", "root.EntropyCore = make()", "root.EntropyKore = make()")), /apps-tools\.js: ReferenceError: EntropyCore is not defined/, "an export renamed, used only inside functions");
  assert.throws(() => rendererLoads(html, edit("apps-tools.js", "function entropyNode()", "function entropyNodes()")), /app\.js: ReferenceError: entropyNode is not defined/, "a function renamed in one script and still called in another");
  assert.throws(() => rendererLoads(html, edit("mailicons.js", "g.micon", "g.mikon")), /mail\.js: ReferenceError: micon is not defined/, "a name read off window");
});
