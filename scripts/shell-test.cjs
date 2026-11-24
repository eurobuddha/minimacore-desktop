// The Pandamonium shell (0.18.69+): pins the six tabs, the tray, the overflow menu and the theme (follow the system,
// light or dark: 0.19.378), so a later change cannot quietly bring back the old seventeen-tab strip.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const R = path.join(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
const app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "app.js"), "utf8"));
const css = fs.readFileSync(path.join(R, "style.css"), "utf8");
const shell = fs.readFileSync(path.join(R, "shell.css"), "utf8");

test("the tab strip is Pandamonium's six, in order, and nothing else is a tab", () => {
  const tabs = [...html.matchAll(/<button class="tab[^"]*"[^>]*data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ["wallet", "dexicon", "history", "apps", "chat", "node"]);
  const labels = [...html.matchAll(/<span class="tab__l"[^>]*>([^<]+)</g)].map(m => m[1]);
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
  assert.deepEqual(tray, ["core=Minima Core", "mail=MinimaMail", "ethwallet=ETH Wallet", "futurecash=Future Cash Next", "explorer=Minima Explorer", "vestr=Minima Vestr", "entropy=Entropy", "keyuses=KeyUses", "faucet=Minima Faucet",
    "minimall=miniMall", "webwallet=Web Wallet", "parlons=Parlons"], "the tray's default order; no row for an app the desktop does not have");
  assert.ok(/id="walSend"/.test(html) && /id="walReceive"/.test(html), "Send and Receive open from the Wallet's buttons");
});

test("the overflow menu is the phone's desktop subset, in the phone's order", () => {
  const acts = [...html.matchAll(/role="menuitem" data-act="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(acts, ["logs", "terminal", "backup", "params", "shutdown", "language", "settings"], "Language after Shutdown, as the phone's; Settings is the desktop's own, last");
  for (const a of acts) assert.ok(app.includes(`"${a}"`), a + " has a handler");
  assert.ok(!/App Lock|Allow Screenshots|Battery/.test(html), "phone-only items are left out");
});

test("the badges survived the move", () => {
  assert.ok(/id="chatBadge"/.test(html), "chat count on the Chat tab");
  assert.ok(/badge: "mailBadge"/.test(app) && /badge: "shopBadge"/.test(app), "mail and miniMall counts on their tray rows");
  assert.ok(/id="chatTab"[^>]*hidden/.test(html), "the Chat tab stays hidden until boot() shows it");
});

// 0.19.378 (owner: "no light/dark mode toggle"): Follow the system / Light / Dark in Settings, config "theme", applied by the main
// process as nativeTheme.themeSource, which Electron makes every page's prefers-color-scheme follow.
const ROOT = path.join(__dirname, "..");
const configSrc = fs.readFileSync(path.join(ROOT, "main", "config.js"), "utf8"), mainSrc = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
test("the theme: the saved choice x the OS preference gives the applied theme", () => {
  const themeSource = new Function(configSrc.match(/\nfunction themeSource\(v\)[^\n]*/)[0] + "; return themeSource;")();
  // Electron's rule for nativeTheme.themeSource: "system" takes the OS's setting (and follows it live); "light" / "dark" win over it
  const applied = (saved, osDark) => { const src = themeSource(saved); return src === "system" ? (osDark ? "dark" : "light") : src; };
  for (const [saved, os, want] of [["system", true, "dark"], ["system", false, "light"], ["light", true, "light"], ["light", false, "light"], ["dark", false, "dark"], ["dark", true, "dark"],
    ["current", false, "light"], ["current", true, "dark"], ["original-light", true, "dark"], ["original-dark", false, "light"], [undefined, false, "light"], ["", true, "dark"], ["DARK", false, "light"], [{}, true, "dark"]])
    assert.equal(applied(saved, os), want, JSON.stringify(saved) + " with the OS " + (os ? "dark" : "light"));
  assert.ok(/theme: "system",/.test(configSrc), "the default follows the system, as the app always has");
  assert.ok(/if \(k === "theme"\) \{ if \(v === "system" \|\| v === "light" \|\| v === "dark"\) out\[k\] = v; continue; \}/.test(configSrc), "only the three values are saved");
  const win = mainSrc.slice(mainSrc.indexOf("function createWindow()"), mainSrc.indexOf("new BrowserWindow("));
  assert.ok(/nativeTheme\.themeSource = config\.themeSource\(config\.load\(\)\.theme\)/.test(win), "applied before the window exists: the first paint is already in it");
  const save = mainSrc.slice(mainSrc.indexOf("function saveConfigPatch("), mainSrc.indexOf("function saveConfigPatch(") + 900);
  assert.ok(/if \(patch && "theme" in patch\) nativeTheme\.themeSource = config\.themeSource\(c\.theme\)/.test(save), "applied at once on a save, no restart");
});
test("the theme: Settings offers Follow the system, Light and Dark, and saves the choice", () => {
  assert.ok(app.includes('const THEMES = [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]];'), "the three choices");
  const set = app.slice(app.indexOf("async function renderSettings()"), app.indexOf("function keysInfo("));
  assert.ok(set.includes('sec("Appearance"') && set.includes('name="setTheme"'), "an Appearance card with the three choices");
  assert.ok(/input\[name="setTheme"\]'\)\.forEach\(r => r\.onchange = \(\) => setAppTheme\(r\.value\)\);/.test(set) && /CFG = await api\.saveConfig\(\{ theme: v \}\)/.test(app), "a choice is saved at once (setAppTheme, the one save of all three switches)");
  assert.ok(/SYSTEM_LIGHT\.addEventListener\("change", \(\) => \{ applyTheme\(\);/.test(app) && /\napplyTheme\(\);/.test(app), "data-theme follows the applied theme, from the first frame and live");
});
// 0.19.379 (owner: History was dark with the app light): no screen container of the desktop's own stylesheets has a dark
// background written as a colour outside a dark-only block. The exceptions are the tray apps the phone itself draws dark
// in its light theme too (their originals' fixed palettes: docs/reference/pandamonium-2.2.52 light-71b, 74*, 76, 77, 84,
// 75*); they have no light design to follow, so they are listed, not changed.
const FIXED_DARK = { "#view-ethwallet": "ETH Wallet: the original's fixed dark palette (phone: light-71b)", "#view-vestr": "Vestr: fixed dark (phone: light-74*)",
  "#view-minimall": "miniMall: Pandamonium's MallActivity palette (phone: light-84)", "#view-webwallet": "Web Wallet: the Minima web wallet's fixed dark",
  "#view-faucet": "Faucet: fixed dark (phone: light-77)", "#view-keyuses": "KeyUses: fixed dark (phone: light-76)", ".en": "Entropy: fixed dark (phone: light-75*)" };
function cssRules(src) {   // [{ sel, ctx (enclosing @-rules), body }], comments removed
  const out = [], stack = []; let buf = "";
  for (const c of src.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (c === "{") { stack.push(buf.trim()); buf = ""; }
    else if (c === "}") { const sel = stack.pop(); if (buf.trim()) out.push({ sel, ctx: stack.join(" "), body: buf }); buf = ""; }
    else buf += c;
  }
  return out;
}
const darkColour = (v) => [...String(v).matchAll(/#([0-9a-f]{3,8})\b/gi)].some(([, h]) => { if (h.length === 3) h = [...h].map(c => c + c).join(""); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.25; })
  || [...String(v).matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?/g)].some(m => (+m[1] + +m[2] + +m[3]) / 765 < 0.25 && (m[4] == null || +m[4] >= 0.9));
test("every screen container follows the theme: no hard-coded dark background outside a dark-only block (listed exceptions only)", () => {
  const bad = [], seen = new Set();
  for (const f of ["style.css", "app.css", "shell.css", "apps.css", "chat.css", "mail.css", "dexicon.css"]) {
    for (const r of cssRules(fs.readFileSync(path.join(R, f), "utf8"))) {
      if (/prefers-color-scheme:\s*dark/.test(r.ctx)) continue;
      const bg = [...r.body.matchAll(/background(?:-color)?\s*:\s*([^;]+)/g)].map(m => m[1]).filter(darkColour);
      if (!bg.length) continue;
      for (const one of r.sel.split(",").map(x => x.trim())) {
        const top = /^(#view-[a-z]+)(?:\.view--active)?$/.exec(one) || /^\.shell\[data-tab="[a-z]+"\] \.main$/.exec(one) || /^(\.histapp|\.en)$/.exec(one);
        if (!top) continue;
        const key = top[1] || one; seen.add(key);
        if (!FIXED_DARK[key]) bad.push(f + ": " + one + " { background: " + bg.join(", ") + " }");
      }
    }
  }
  assert.deepEqual(bad, [], "a screen that stays dark while the app is light");
  for (const k of Object.keys(FIXED_DARK)) assert.ok(seen.has(k), k + " is no longer fixed dark: take it off the list");
});
test("the screens with a light / dark button of their own start in the app's theme and follow it (Dexicon, Future Cash Next, Minima Explorer)", () => {
  const fc = fs.readFileSync(path.join(R, "futurecash.js"), "utf8"), tools = fs.readFileSync(path.join(R, "apps-tools.js"), "utf8");
  assert.ok(fc.includes('const fcnTheme = () => FCN_PICK || (SYSTEM_LIGHT.matches ? "light" : "dark");') && !/localStorage/.test(fc), "Future Cash: the app's theme unless its button was pressed since; nothing of its own saved");
  assert.ok(tools.includes("const exLight = () => (EX_PICK != null ? EX_PICK : SYSTEM_LIGHT.matches);") && tools.includes("const light = exLight();") && !/explorerTheme/.test(tools), "Explorer: the same");
  assert.ok(/SYSTEM_LIGHT\.addEventListener\("change", \(\) => \{ applyTheme\(\); paintThemeBtn\(\); try \{ DexUI\.followApp\(\); \} catch \(e\) \{\} try \{ fcnFollowApp\(\); \} catch \(e\) \{\} try \{ exFollowApp\(\); \} catch \(e\) \{\} \}\);/.test(app), "a change of the app's theme reaches all three");
});
test("the theme: Pandamonium's exact tokens", () => {
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
  assert.ok(/const w = await Promise\.race\(\[api\.inFlight\("shutdown", action\)\.catch\(\(\) => null\)/.test(app) && !/function shutdownWarning|api\.ppWork|api\.dxWork/.test(app), "one source: no second copy of the warning in the window");
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

test("0.19.139: the copy-failed toast and the TEST window title and tray tooltip carry no em dash", () => {
  const mainJs = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(app.includes('"Copy failed: select the text and press ⌘C"') && !/toast\([^\n]*Copy failed[^\n]*—/.test(app));
  assert.equal((mainJs.match(/ \+ " \(TEST PROFILE\)"/g) || []).length, 2); assert.ok(!/— TEST PROFILE/.test(mainJs));
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
function rendererLoads(page, read = readRenderer, lang) {   // lang: the saved language the preload hands the page (window.mcd.lang)
  const any = () => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? () => any() : any()), apply: () => any(), construct: () => any() });   // a then() that never answers: boot() stops at its first await
  const order = [...page.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]), box = {};
  for (const f of fs.readdirSync(R)) if (f.endsWith(".js") && !order.includes(f)) throw new Error(f + ": no script tag loads it");
  for (const f of fs.readdirSync(path.join(R, "i18n"))) if (f.endsWith(".js") && !order.includes("i18n/" + f)) throw new Error("i18n/" + f + ": no script tag loads it");   // a catalog defines no name: the folder rule is what catches a dropped one
  for (const k of ["document", "localStorage", "navigator", "location", "mcd", "crypto", "matchMedia", "addEventListener", "requestAnimationFrame", "setTimeout", "setInterval", "clearTimeout", "clearInterval"]) box[k] = any();   // the browser's, and the preload's bridge
  if (lang) { const m = any(); box.mcd = new Proxy(m, { get: (_t, k) => (k === "lang" ? lang : m[k]) }); }
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
  return lang ? { order, ctx } : order;
}
// 0.19.154: the whole renderer, started in each language: every script runs its top level (the tables built while a
// script loads, the page's fixed text) with that language already chosen, and the shell's own decisions are unchanged
test("the renderer starts in each language: the language is chosen before any screen script, and the shell decides as in English", () => {
  for (const code of ["zh", "ru", "uk"]) {
    const { ctx } = rendererLoads(html, readRenderer, code);
    assert.equal(vm.runInContext("I18N.lang()", ctx), code, code + ": started in the saved language");
    assert.equal(vm.runInContext('t("Wallet")', ctx), vm.runInContext('I18N.catalog("' + code + '")["Wallet"]', ctx));
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify([shellMode('balances'), shellMode('dexicon'), shellMode('mail'), viewOfTab('wallet'), trayOrder(['mail', 'chat'], ['core', 'chat', 'mail'])])", ctx)),
      JSON.parse(vm.runInContext("I18N.set('en'); JSON.stringify([shellMode('balances'), shellMode('dexicon'), shellMode('mail'), viewOfTab('wallet'), trayOrder(['mail', 'chat'], ['core', 'chat', 'mail'])])", ctx)), code + ": the shell's decisions do not depend on the language");
  }
});
test("the renderer loads: every script of index.html, in its order, and no name is used that nothing defines", () => {
  const order = rendererLoads(html), tag = (f) => '<script src="' + f + '"></script>';
  assert.equal(order[order.length - 1], "app.js"); assert.ok(order.length >= 20);
  const edit = (f, from, to) => (g) => { const s = readRenderer(g); if (g !== f) return s; assert.ok(s.includes(from), f + " has " + from); return s.split(from).join(to); };
  assert.throws(() => rendererLoads(html, edit("app.js", "api, esc, el, toast, copy, relTime,", "api, esc, el, toast, copy, short, relTime,")), /app\.js: ReferenceError: short is not defined/, "the 0.19.125 slip is caught");
  for (const f of order) assert.throws(() => rendererLoads(html.replace(tag(f), "")), /no script tag loads it|is not defined/, "a dropped tag: " + f);
  const swap = (a, b) => html.replace(tag(a), "\u0000").replace(tag(b), tag(a)).replace("\u0000", tag(b));
  assert.throws(() => rendererLoads(swap("apps-act.js", "app.js")), /app\.js: ReferenceError: \w+ is not defined/, "app.js before the scripts whose names its top level uses");
  assert.throws(() => rendererLoads(swap("dexicon-core.js", "dexicon-ui.js")), /dexicon-ui\.js: ReferenceError: DexCore is not defined/);
  assert.throws(() => rendererLoads(html, edit("entropy-core.js", "root.EntropyCore = make()", "root.EntropyKore = make()")), /ReferenceError: EntropyCore is not defined/, "an export renamed, used only inside functions");
  assert.throws(() => rendererLoads(html, edit("apps-tools.js", "function entropyNode()", "function entropyNodes()")), /ReferenceError: entropyNode is not defined/, "a function renamed and still called");
  assert.throws(() => rendererLoads(html, edit("mailicons.js", "g.micon", "g.mikon")), /ReferenceError: micon is not defined/, "a name read off window");
});

// ---- 0.19.257: every path that stops a running node shows Shutdown's in-flight warning first ----
test("Restart node, the node kind, Save & Restart, Contribute, the Parlons switch and a first-run start ask what is in flight first, from Shutdown's own source", () => {
  assert.ok(/async function nodeStopOk\(action = "restart"\) \{\s*lastStopAck = "";\s*if \(!running\) return true;\s*const w = await inFlightWarning\(action\);\s*if \(w\.any && !await showConfirm\(w\.title, w\.message,/.test(app), "one helper over inFlightWarning");
  assert.ok(/else if \(act === "shutdown"\) \{[\s\S]{0,400}const w = await inFlightWarning\("stop"\);/.test(app), "Shutdown uses the same source");
  for (const [where, rx] of [["Restart node", /el\("nRestart"\)\.onclick = async \(\) => \{ if \(!await nodeStopOk\(\)\) return;/], ["the node kind", /el\("setKindApply"\)\.onclick = async \(\) => \{[\s\S]{0,400}if \(!await nodeStopOk\("kind"\)\) return;[\s\S]{0,200}await api\.setNodeKind\(want, stopAck\(\), \{ heapMb \}\)/],
    ["Save & Restart", /"Restart node\?"[\s\S]{0,300}\n\s*if \(!await nodeStopOk\(\)\) return;/], ["Contribute", /if \(!await nodeStopOk\(\)\) return;\s*const params = Object\.assign\(\{\}, CFG\.params, turnOn/],
    ["the Parlons switch", /if \(!await nodeStopOk\("kind"\)\) return;\s*b\.disabled = true; b\.textContent = "Switching…";/], ["a first-run start", /async function frStart\(restore\) \{\s*if \(running && !await nodeStopOk\(\)\) return;/]])
    assert.ok(rx.test(app), where);
  // 0.19.268: the call sites are no longer counted here: main refuses every stop with work in flight unless the window hands it
  // the ack of the warning it showed (scripts/inflight-test.cjs, main's own guard); each call hands it on
  assert.equal((app.match(/api\.nodeRestart\(\)/g) || []).length, 0, "no restart without the warning's ack");
  assert.ok(/api\.nodeStop\(w\.ack \|\| ""\)/.test(app) && (app.match(/api\.setNodeKind\([^;]*stopAck\(\)/g) || []).length === 2);
});

// ---- 0.19.258: the remaining overlays are modal: data-modal, one at a time, Escape, focus in and back ----
test("the token detail, action sheet, prompt, payment result, transaction detail and QR scanner are modal, one at a time, close on Escape and give focus back", () => {
  assert.ok(/function modalize\(ov, onEscape, first\) \{[\s\S]{0,200}ov\.setAttribute\("data-modal", ""\);[\s\S]{0,200}e\.key === "Escape"[\s\S]{0,200}f\.focus\(\);[\s\S]{0,120}opener\.focus\(\)/.test(app), "one helper");
  for (const [id, once] of [["tokDetail", /if \(el\("tokDetail"\)\) return;/], ["sheetOv", /if \(el\("sheetOv"\)\) return;/], ["promptOv", /if \(el\("promptOv"\)\) \{ resolve\(null\); return; \}/],
    ["prOv", /const was = el\("prOv"\); if \(was\) was\.remove\(\);/], ["histDetail", /if \(el\("histDetail"\)\) return;/], ["scanOv", /if \(el\("scanOv"\)\) \{ resolve\(null\); return; \}/]]) {
    assert.ok(once.test(app), id + ": one at a time");
    // 0.19.279: in the function that draws it, not anywhere after it (the whole rest of app.js passed with this overlay's line deleted)
    const at = app.indexOf('id="' + id + '"'), starts = [...app.slice(0, at).matchAll(/\n(?:async )?function /g)], next = /\n(?:async )?function /g; next.lastIndex = at;
    const own = app.slice(starts.length ? starts[starts.length - 1].index : 0, (next.exec(app) || { index: app.length }).index);
    assert.ok(new RegExp("modalize\\((?:el\\(\"" + id + "\"\\)|ov)").test(own), id + ": made modal");
  }
});

// ---- 0.19.259: "Copy the listed rows" guards formulas as the CSV export does; Future Cash's Collect names the real unit ----
test("Copy the listed rows: a cell that leads with a formula trigger gets an apostrophe, and no tab or line break splits a cell; Collect names the stake's own unit", () => {
  const body = app.slice(app.indexOf("async function copyHistory()"), app.indexOf("async function copyHistory()") + 900);
  const m = /const cell = (\(v\) => \{[^\n]*\});/.exec(body); assert.ok(m, "the guard"); const cell = eval(m[1]);
  assert.equal(cell('=HYPERLINK("http://x","y")'), "'=HYPERLINK(\"http://x\",\"y\")"); assert.equal(cell("+1"), "'+1"); assert.equal(cell("-2"), "'-2"); assert.equal(cell("@x"), "'@x");
  assert.equal(cell("a\tb\nc"), "a b c"); assert.equal(cell("Minima"), "Minima"); assert.equal(cell(null), "");
  assert.ok(/histCells\(r\)\.map\(cell\)\.join\("\\t"\)/.test(body));
  const fc = fs.readFileSync(path.join(R, "futurecash.js"), "utf8");
  assert.ok(fc.includes('const unit = x.tokenid === "0x00" ? "MINIMA" : String(x.tokenid).toUpperCase() === FCN_MXUSD ? "MxUSD" : t("of the token {tokenid}", { tokenid: x.tokenid });') && fc.includes('t("{amount} {unit} is collected to its payout address:'), "the real unit, the token id whole");
});

// ---- 0.19.263: review nits: the Web Wallet send after a logout, identifiers never cut, fragments said in every language, the chat dialog's Escape ----
test("C5: the Web Wallet send stops if logged out meanwhile and says main's reason translated; the Mail header and the Send picker never cut an identifier; the chat dialog removes its Escape listener", () => {
  const raw = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const send = raw.slice(raw.indexOf("async function wwDoSend()"), raw.indexOf("function renderActive()"));
  assert.ok(/const r = await AppsAct\.ww\.send\(api, f\);[\s\S]{0,300}if \(!wwAddr\) \{ renderWebWallet\(\); return; \}/.test(send) && /MainSaid\.say\(r\.message \|\| r\.err\)/.test(send) && !/"Sending\.\.\."/.test(send));
  for (const w of ['return t("Unverified");', 'return t("just now");', 'th("awaiting payment")']) assert.ok(raw.includes(w), w);
  assert.ok(!/return "Unverified";|return "just now";|"  awaiting payment"/.test(raw));
  const mailCss = fs.readFileSync(path.join(R, "mail.css"), "utf8"), shellCss = fs.readFileSync(path.join(R, "shell.css"), "utf8");
  assert.ok(!/\.mailapp \.mm-cs \{[^}]*text-overflow: ellipsis/.test(mailCss) && /\.mailapp \.mm-cs \{[^}]*overflow-wrap: anywhere/.test(mailCss), "the Mail header's address is whole");
  assert.ok(/id="sTokId"/.test(raw) && /idb\.textContent = idb\.hidden \? "" : tid; idb\.onclick = \(\) => copy\(tid\);/.test(raw) && /\.send-tokid \{[^}]*overflow-wrap: anywhere/.test(shellCss), "the chosen token's whole id beside the picker, one click to copy");
  const chat = fs.readFileSync(path.join(R, "chat.js"), "utf8");
  assert.ok(/const done = \(v\) => \{ dismissChat\.delete\(cancel\); document\.removeEventListener\("keydown", esc\); ov\.remove\(\); resolve\(v\); \};/.test(chat), "no Escape listener is left behind by a button or a click outside");
  for (const c of ["zh", "ru", "uk"]) { require("../renderer/i18n/" + c + ".js"); const cat = I18N.catalog(c); for (const k of ["just now", "awaiting payment", "Unverified", "Sending…"]) assert.ok(cat[k] && cat[k] !== k, c + ": " + k); }
});

// 0.19.403 (owner: "There is still no light mode/dark mode toggle on the main homepage wallet page of Pandamonium. There is one inside Dexicon."):
// the bar's button, Settings › Appearance and Dexicon's sun save ONE setting (config theme) and each shows it at once
test("0.19.403: the bar's light / dark button: on every screen with the bar, a click saves theme and sets data-theme; Settings and Dexicon follow at once; Dexicon's sun saves the same setting", async () => {
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8"), ts = require("typescript");
  const bar = html.slice(html.indexOf('<header class="bar" id="bar">'), html.indexOf("</header>", html.indexOf('<header class="bar" id="bar">')));
  assert.ok(bar.indexOf('id="themeBtn"') > 0 && bar.indexOf('id="themeBtn"') < bar.indexOf('id="moreBtn"'), "in the shared bar, left of the menu");
  // the real functions of app.js, run over stand-ins
  const sf = ts.createSourceFile("app.js", app, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), decl = {};
  for (const st of sf.statements) { if (ts.isFunctionDeclaration(st) && st.name) decl[st.name.text] = st.getText(sf); if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decl[d.name.text] = st.getText(sf); }
  const attrs = { "data-theme": "dark" }, btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, innerHTML: "", title: "" }, did = [];
  const env = { document: { documentElement: { getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } }, getElementById: (id) => (id === "themeBtn" ? btn : null) },
    t: (s) => s, SYSTEM_LIGHT: { matches: false }, CFG: { theme: "system" }, activeView: "settings", toast: (m) => did.push("toast " + m), ipcError: (e) => e.message,
    api: { saveConfig: async (p) => { did.push("save " + JSON.stringify(p)); return { theme: p.theme }; } }, DexUI: { followApp: (l) => did.push("dexicon " + l) }, renderSettings: () => did.push("settings " + env.CFG.theme) };
  const f = new Function("env", "with (env) { " + ["SUN_SVG", "MOON_SVG", "applyTheme", "paintThemeBtn", "setAppTheme"].map(n => decl[n]).join("\n") + "\n return { paintThemeBtn, setAppTheme }; }")(env);
  f.paintThemeBtn(); assert.equal(btn.attrs["aria-label"], "Switch to the light theme"); assert.ok(/<circle/.test(btn.innerHTML), "dark: the sun, as Dexicon's");
  assert.ok(/Settings › Appearance/.test(btn.title), "says where Follow the system is");
  const click = app.slice(app.indexOf('el("themeBtn").onclick'), app.indexOf('el("themeBtn").onclick') + 200);
  assert.ok(/setAppTheme\(document\.documentElement\.getAttribute\("data-theme"\) === "light" \? "dark" : "light"\)/.test(click), "a click sets the opposite of what is shown now");
  await f.setAppTheme("light");
  assert.deepEqual(did, ['save {"theme":"light"}', "dexicon true", "settings light"]); assert.equal(attrs["data-theme"], "light"); assert.equal(env.CFG.theme, "light", "Settings' radio reads CFG");
  assert.equal(btn.attrs["aria-label"], "Switch to the dark theme");
  // Dexicon's sun: the same setting, through the app's own save
  const sent = []; const C = require("../renderer/dexicon-core.js"), ui = fs.readFileSync(path.join(R, "dexicon-ui.js"), "utf8");
  assert.ok(/\$\("dxTheme"\)\.onclick = \(\) => \{ if \(opts && opts\.setAppTheme\) return void opts\.setAppTheme\(mem\.theme === "ONYX" \? "light" : "dark"\);/.test(ui));
  assert.ok(/DexUI\.init\(\{ go: selectTab, leave: \(\) => selectTab\(lastShellView\), setAppTheme,/.test(app), "the app hands Dexicon its save");
  const mem = C.load(null, false); C.followApp(mem, true); assert.equal(mem.theme, "DAYLIGHT", "followApp(light) as setAppTheme calls it"); sent.push(mem.theme);
  const css = fs.readFileSync(path.join(R, "shell.css"), "utf8"); assert.ok(/\.bar__theme \{ margin-left: auto; \}/.test(css));
});
