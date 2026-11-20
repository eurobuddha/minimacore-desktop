/*
 * panels-test.cjs — the shared guard over every APK-parity panel sheet.
 *
 * 0.18.141: the PandaPools and AtomiX panels (renderer/pools.js, pools.css, atomix-ui.js, atomix-ui.css) were removed
 * after the parity audit (docs/DEXICON_PARITY_AUDIT.md); Dexicon rooms 2 and 1 draw them. Their render tests went
 * with the files. What they pinned that still matters is pinned on the rooms at the end of this file; the calls
 * and arguments of every money action are pinned against the old panels' recorded answers in
 * scripts/dexicon-ax.test.cjs and scripts/dexicon-pp.test.cjs (scripts/fixtures/old-*-panel.json).
 *
 * Each of these panels (Mail, PandaPools, and Casino/AtomiX as they land) carries its OWN palette so it can
 * look like its phone app without repainting the rest of minimaCore. That only holds while every selector in
 * the sheet stays inside the panel's wrapper, so the scope assertion below runs over all of them at once —
 * the generalisation of the single-sheet check that shipped with Mail in 0.17.15.
 */
const test = require("node:test");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const R = path.join(__dirname, "..", "renderer");

/** Every panel sheet, with the wrapper class it must never paint outside of. */
const PANELS = [
  { css: "mail.css", wrap: "mailapp", host: "view-mail", js: "mail.js" }
];
// Font stacks are shared on purpose — the shell's face is the OS face, and a panel that redeclared it would
// only drift. Colour and geometry tokens are what must never be borrowed.
const SHARED_TOKENS = ["--sans", "--mono"];

function selectorsOf(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")
    .map((b) => b.split("{")[0].trim()).filter(Boolean)
    .flatMap((s) => s.split(",").map((x) => x.trim())).filter(Boolean)
    .filter((s) => !s.startsWith("@") && !/^(from|to|\d+%)$/.test(s));
}

for (const p of PANELS) {
  test(`${p.css} cannot leak into the rest of the app`, () => {
    const css = fs.readFileSync(path.join(R, p.css), "utf8");
    const wrap = new RegExp(`(^|\\s|\\()\\.${p.wrap}\\b`);
    const host = new RegExp(`^#${p.host}\\b`);
    const loose = selectorsOf(css).filter((s) => !wrap.test(s) && !host.test(s) && !/^:root\[data-theme/.test(s));
    assert.deepEqual(loose, [], `unscoped selectors would leak: ${loose.join(" | ")}`);
  });

  test(`${p.css} declares its whole palette — no shell token reaches in`, () => {
    const css = fs.readFileSync(path.join(R, p.css), "utf8");
    // A var() the panel reads must be one the panel itself defines. Borrowing --accent/--surface from app.css
    // is how a panel silently starts following the shell's theme button again.
    const read = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    // `@property --x { ... }` declares a token too - and more strongly than a plain custom property,
    // since it also fixes its syntax and initial-value. Registering an animatable angle that way is the
    // only way to transition one, so a panel that does it was failing this guard for declaring its token
    // properly. The guard's point is that the token comes from the PANEL, not the shell, and it does.
    const declared = new Set([
      ...[...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
      ...[...css.matchAll(/@property\s+(--[a-z0-9-]+)/g)].map((m) => m[1]),
    ]);
    const borrowed = read.filter((v) => !declared.has(v) && !SHARED_TOKENS.includes(v));
    assert.deepEqual(borrowed, [], "panel reads a colour/geometry token it does not define: " + borrowed.join(" "));
  });

  test(`${p.css} is linked, and something actually wears its wrapper`, () => {
    const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
    const js = fs.readFileSync(path.join(R, p.js), "utf8");
    assert.ok(html.includes(`href="${p.css}"`), `${p.css} is linked`);
    assert.ok(html.includes(`src="${p.js}"`), `${p.js} is loaded`);
    const worn = new RegExp(`\\b${p.wrap}\\b`);
    assert.ok(worn.test(html) || worn.test(js), `the .${p.wrap} wrapper is applied somewhere`);
  });
}

// ------------------------------------------------------------------ the cascade-collision guard
// Panel dialogs are created as "overlay <wrap>" so the panel's tokens scope them. Every panel sheet is linked
// AFTER app.css, so a property the root wrapper declares that .overlay also sets wins by source order and
// breaks the dialog. It shipped twice: 0.17.19's .ppapp background painted an opaque sheet over the scrim;
// 0.17.21's .axapp position:relative turned every AtomiX dialog into an in-flow block at the bottom of <body>.
function ruleBody(css, selector) {
  const m = new RegExp("(^|\\n)" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return m ? m[2] : null;
}
function propsOf(body) {
  return new Set((body || "").split(";").map((d) => d.split(":")[0].trim()).filter((k) => k && !k.startsWith("--") && !k.startsWith("/*")));
}
test("no panel wrapper declares a property that app.css's .overlay owns, unless it restates it on .wrap.overlay", () => {
  const app = fs.readFileSync(path.join(R, "app.css"), "utf8");
  const overlayProps = propsOf(ruleBody(app, ".overlay"));
  assert.ok(overlayProps.has("position") && overlayProps.has("background"), "sanity: .overlay sets position and background");
  const bad = [];
  let checked = 0;
  for (const p of PANELS) {
    // only panels that put "overlay <wrap>" on ONE element are exposed to this; Mail uses the shell's dialogs
    // and P2P Chance carries its own .cz-ov, so neither shares a box with .overlay
    const js = fs.readFileSync(path.join(R, p.js), "utf8");
    if (!new RegExp('(class="|className = ")overlay ' + p.wrap + '"').test(js)) continue;
    checked++;
    const css = fs.readFileSync(path.join(R, p.css), "utf8");
    const root = propsOf(ruleBody(css, "." + p.wrap));
    const restated = propsOf(ruleBody(css, "." + p.wrap + ".overlay"));
    for (const prop of root) if (overlayProps.has(prop) && !restated.has(prop)) bad.push(p.css + " ." + p.wrap + " { " + prop + " }");
  }
  assert.deepEqual(bad, [], "wrapper properties that would beat .overlay by source order: " + bad.join(" | "));
  assert.equal(checked, 0, "no panel shares a box with .overlay any more: the two that did (PandaPools, AtomiX) were removed in 0.18.141; a new one is checked by the loop above");
});

// ------------------------------------------------------------------ P2P Chance is gone (0.18.68)
test("P2P Chance left the app: no tab, no screen, no way to start a game — only the settle status is wired", () => {
  const app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "app.js"), "utf8"));
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(R, "..", "main", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(R, "..", "main", "main.js"), "utf8");
  for (const f of ["casino.js", "casinoart.js", "casino.css"]) assert.ok(!fs.existsSync(path.join(R, f)), f + " is deleted");
  assert.ok(!/casino/i.test(html), "index.html has no tab, view, stylesheet or script for it");
  assert.ok(!/CasinoPanel|casinoEnabled|casinoAgeGate|setCasino/.test(app), "app.js has no panel, enable card or 18+ gate");
  const calls = [...new Set((preload + main).match(/mcd:casino\w*/g))].sort();
  assert.deepEqual(calls, ["mcd:casino", "mcd:casinoInvalidate", "mcd:casinoOpen"], "the IPC surface is status + wallet-reset only");
  assert.ok(/delete patch\.casinoEnabled/.test(main), "the renderer cannot switch the settle-only gate");
  // 0.18.86: the wallet-reset chains share walletReplaced() (scripts/core-screens-test.cjs pins who calls it)
  assert.ok(/node\.onWalletReplaced = async \(\) => \{[\s\S]*?casino\.invalidate\(\)/.test(main), "every wallet reset still drops the cached identity (0.18.106: in the main process, inside the resync)");
});


// ------------------------------------------------------------------ what the removed panels' tests pinned, on the rooms
// The old "0.17.20 review fixes stay fixed" test read pools.js and pools.css. It had failed since 0.18.32 for a reason
// of its own: it counted dialog sites written with double quotes, and the backup dialog was rewritten with single
// quotes, so it found 8 sites and 9 style stamps. Every dialog was in fact stamped. Of its four properties:
//   scrim              kept below (room dialogs are native <dialog>: the scrim is ::backdrop, nothing can paint over it)
//   MxUSD naming       kept below, on both rooms
//   quote race         kept below, on room 2 (and the preview's stale-answer guard on room 1)
//   style-stamped dialogs   dropped: the "Original" style and its per-dialog stamp do not exist on the new side;
//                           room dialogs sit inside #shell, which carries the one Dexicon theme
const code = (f) => fs.readFileSync(path.join(R, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
test("rooms 1 and 2: the old panels are gone, and nothing they were wired with is left", () => {
  const app = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "app.js"), "utf8")), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  for (const f of ["pools.js", "pools.css", "atomix-ui.js", "atomix-ui.css"]) assert.ok(!fs.existsSync(path.join(R, f)), f + " is deleted");
  assert.ok(!/PoolsPanel|AtomixPanel|renderPandapools|ppBody|axBody/.test(app + html), "no wiring, element, sheet or script of the old panels");
  assert.ok(/function resetPpState\(\) \{ DexPools\.reset\(\); \}/.test(app) && /function resetAxState\(\) \{ DexAx\.reset\(\); \}/.test(app), "a wallet reset clears the rooms");
  assert.ok(!/function renderPpSwap|ppMineHtml|function renderAxSwap|function axMakerEditor|function axLadder|function axShort/.test(app), "none of the panels' internals is in app.js");
  assert.ok(app.includes("idHtml(shopIdentity.publicId)"), "miniMall's shop id is copyable in full (it never went through a truncating helper again)");
});
test("RULE 2 on the rooms: the dollar token is written MxUSD; the engine's own key and label are only ever read, never shown", () => {
  const pp = code("dexicon-pp.js"), ax = code("dexicon-ax.js");
  assert.ok(!/mxUSDT/i.test(pp), "room 2 has no mxUSDT in code or copy");
  assert.ok(pp.includes('"Get MxUSD first"'), "the create gate names the token correctly");
  const PP = require("../renderer/dexicon-pp.js"), AX = require("../renderer/dexicon-ax.js");
  assert.equal(PP.tokLabel(PP.MXUSD || "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", "USDT"), "MxUSD", "by token id, whatever the name says");
  assert.equal(PP.tokLabel("0x" + "EE".repeat(32), "MxUSD"), "(not MxUSD) \u2068MxUSD\u2069");
  // room 1 reads the engine's "mxusdt" key and "mxUSDT" label and writes MxUSD: every literal left is a key, a storage name or the rewrite itself
  for (const line of ax.split("\n").filter((l) => /mxusdt/i.test(l))) assert.ok(/["'`]mxusdt["'`]|mxusdt:|\.mxusdt|mxUSDT\/gi?|\/.*mxusdt.*\/i?/i.test(line), "room 1 shows mxUSDT to the user: " + line.trim().slice(0, 160));
  assert.equal(AX.ccyName ? AX.ccyName("mxusdt") : "MxUSD", "MxUSD");
});
test("quote race on the rooms: a late answer never repaints over a newer amount, and clearing the amount retires the quote in flight", () => {
  const pp = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "dexicon-pp.js"), "utf8")), ax = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "dexicon-ax.js"), "utf8"));
  assert.ok(pp.includes('if (!amountOk(a)) { S.qseq++; S.q = null;'), "room 2: the early return bumps the quote sequence (the old ppQuoteSeq++)");
  assert.ok(/const seq = \+\+S\.qseq, dir = S\.dir, r = await api\(\)\.ppQuote\(t\.tok, dir, a\)[^\n]*\n\s*if \(seq !== S\.qseq \|\| !\$\("ppQuote"\)\) return;/.test(pp), "room 2: an answer to an older question is dropped");
  assert.ok(pp.includes('if (S.tab === "swap" && $("ppAmt") && !C.gate.on) requote();'), "room 2: the quote on screen is asked again when the pools move, as the old panel did (0.18.141)");
  assert.ok(/sell !== S\.sell \|\| amt !== amount\(\)/.test(ax), "room 1: a preview for another side or amount is dropped");
});
test("scrim: a room dialog is a native <dialog> with its own backdrop, so no wrapper can paint over it", () => {
  const css = fs.readFileSync(path.join(R, "dexicon.css"), "utf8"), ui = require("./i18n-plain.cjs").plain(fs.readFileSync(path.join(R, "dexicon-ui.js"), "utf8"));
  assert.ok(/\.dx-dlg::backdrop \{ background: rgba\(0,0,0,\.55\); \}/.test(css)); assert.ok(/showModal\(\)/.test(ui));
});
