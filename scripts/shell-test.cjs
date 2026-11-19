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
  assert.deepEqual(tray, ["core=Minima Core", "mail=MinimaMail", "ethwallet=ETH Wallet", "vestr=Minima Vestr", "faucet=Minima Faucet",
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

test("tray order: Minima Core pinned, saved ids kept once, unknown ids dropped, new apps appended", () => {
  const trayOrder = new Function(app.match(/function trayOrder\(saved, ids\) \{[\s\S]+?\n\}/)[0] + "; return trayOrder;")();
  const ids = ["core", "mail", "ethwallet", "vestr", "parlons"];
  assert.deepEqual(trayOrder(null, ids), ids, "nothing saved: the default order");
  assert.deepEqual(trayOrder("parlons,mail", ids), ["core", "parlons", "mail", "ethwallet", "vestr"]);
  assert.deepEqual(trayOrder("vestr,core,vestr,casino,mail", ids), ["core", "vestr", "mail", "ethwallet", "parlons"], "core cannot be moved; duplicates and removed apps are ignored");
  assert.ok(/shellOrder/.test(app) && /dragstart/.test(app) && /altKey/.test(app), "saved, draggable, and movable by keyboard");
});

test("Apps tab: a Hide switch per app, Minima Core locked, no Freeze switch yet", () => {
  assert.ok(/role="switch"/.test(app) && /shellHidden/.test(app), "a real switch, saved");
  assert.ok(/core \? " disabled" : ""/.test(app), "Minima Core cannot be hidden");
  assert.ok(/Always on/.test(app) && /In app drawer/.test(app) && /Hidden from drawer/.test(app), "the phone's three states");
  assert.ok(!/Freeze<|>Freeze/.test(app + html), "Freeze comes with the engines: no dead switch");
  assert.ok(!/External/.test(html.slice(html.indexOf('id="view-apps"'), html.indexOf('id="view-faucet"'))), "no External sub-tab");
});
