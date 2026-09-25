/*
 * panels-test.cjs — the shared guard over every APK-parity panel, plus the PandaPools panel's render tests.
 *
 * Each of these panels (Mail, PandaPools, and Casino/AtomiX as they land) carries its OWN palette so it can
 * look like its phone app without repainting the rest of minimaCore. That only holds while every selector in
 * the sheet stays inside the panel's wrapper, so the scope assertion below runs over all of them at once —
 * the generalisation of the single-sheet check that shipped with Mail in 0.17.15.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const R = path.join(__dirname, "..", "renderer");

/** Every panel sheet, with the wrapper class it must never paint outside of. */
const PANELS = [
  { css: "mail.css", wrap: "mailapp", host: "view-mail", js: "mail.js" },
  { css: "pools.css", wrap: "ppapp", host: "view-pandapools", js: "pools.js" },
  { css: "casino.css", wrap: "czapp", host: "view-casino", js: "casino.js" }
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
    const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
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

// ------------------------------------------------------------------ the PandaPools panel, headless
/** Load pools.js in a DOM-less sandbox. A typo in any of its ~40 templates fails here, not in front of a user. */
function panel() {
  const sandbox = { setTimeout, clearTimeout, Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Promise, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {}, insertAdjacentHTML() {} } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }) };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(R, "pools.js"), "utf8"), ctx, { filename: "pools.js" });
  return sandbox;
}

/** Elements that only record what was written into them — enough to assert on the templates. */
function fakeDom() {
  const nodes = {};
  const mk = () => ({ innerHTML: "", textContent: "", value: "", className: "", hidden: false, style: {}, scrollTop: 0, scrollHeight: 0,
    querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {}, addEventListener() {}, appendChild() {}, onclick: null,
    classList: { add() {}, remove() {}, contains: () => false } });
  return { get: (id) => (nodes[id] || (nodes[id] = mk())), nodes };
}

const NOOP_API = new Proxy({}, { get: () => () => Promise.resolve([]) });
const DEPS = (over) => Object.assign({
  api: NOOP_API,
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  el: () => null, toast() {}, copy() {}, short: (s, n) => String(s).slice(0, n),
  TOK: { shortId: (t) => String(t).slice(0, 10), tidyAmount: (a) => String(a), tokenName: (t, id) => String(id) },
  showConfirm: async () => false, showProgress: () => ({ close() {} }), tryCmd: async () => [],
  PoolCalc: { form: () => ({ el: {}, render() {} }) }, MINIMA: "0x00",
  running: () => true, activeView: () => "pandapools"
}, over || {});

test("the PandaPools panel loads and exposes only its wiring surface", () => {
  const s = panel();
  assert.ok(s.PoolsPanel, "PoolsPanel is exported");
  for (const fn of ["init", "render", "onUpdate", "reset", "setVersion", "setBlock"]) {
    assert.equal(typeof s.PoolsPanel[fn], "function", fn + " is on the panel");
  }
});

test("the header carries the APK chrome, and the tab strip keeps its hard-coded colours", async () => {
  const s = panel();
  const dom = fakeDom();
  s.PoolsPanel.init(DEPS({ el: (id) => dom.get(id) }));
  s.PoolsPanel.setVersion("0.17.18");
  await s.PoolsPanel.render();                       // no pools → the swap tab's empty state
  const html = dom.get("ppBody").innerHTML;
  assert.ok(html.includes("PandaPools"), "the wordmark");
  assert.ok(html.includes("LIQUIDITY POOLS · v0.17.18"), "the tracked sub-line carries the version");
  assert.ok(html.includes("◐ STYLE"), "the style pill");
  assert.ok(/pp-tab[" ]/.test(html), "the tab strip renders");
  assert.ok(html.includes(">SWAP<") && html.includes(">MY LP<"), "the APK's uppercase tab labels");
  // the strip's colours are literals in pools.css precisely because the APK does not theme them
  const css = fs.readFileSync(path.join(R, "pools.css"), "utf8");
  assert.ok(/\.pp-tab\.is-on\s*\{[^}]*#F7931A/.test(css), "the active tab is the APK's literal orange");
});

test("all four tabs render against live-shaped data, with the APK's row vocabulary", async () => {
  const s = panel();
  const dom = fakeDom();
  const POOL = "0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A";
  const TOKID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";   // MxUSD
  const pools = [{ address: POOL, tok: TOKID, tokName: "MxUSD", reserveM: "175157.93", reserveT: "784.52", spot: "0.00448", feeGrowthPct: "1.2" }];
  const mine = [{ address: POOL, opk: "0xBB", tok: TOKID, tokName: "MxUSD", reserveM: "175157.93", reserveT: "784.52",
    value: "350000", poolPrice: "0.00448", feesMinima: "12.5", feesPct: "0.9", priceMove: 3.2, il: -0.04, ageBlocks: 5000, kratio: 1.2 }];
  const api = new Proxy({}, { get: (_t, k) => () => {
    if (k === "ppPools") return Promise.resolve(pools);
    if (k === "ppMyPools") return Promise.resolve(mine);
    if (k === "ppPairInfo") return Promise.resolve({ pools: 1, depth: "175157" });
    if (k === "ppMarketToken") return Promise.resolve({ usdt: TOKID });
    if (k === "ppMarket") return Promise.resolve({ mid: "0.00450", fresh: true });
    if (k === "ppActivity") return Promise.resolve([{ type: "SWAP", summary: "Sold 10 MINIMA for 0.04 MxUSD", txpowid: "0xAA",
      ts: 1788896729000, statusText: "3 confirmations · on-chain", confirmed: true }]);
    if (k === "ppFeed") return Promise.resolve([{ kind: "SWAP", minimaIn: true, minimaAmt: "10", tokenAmt: "0.04",
      tokenLabel: "MxUSD", txpowid: "0xBB", ts: 1788896729000, statusText: "3 confirmations · on-chain", confirmed: true }]);
    return Promise.resolve([]);
  } });
  s.PoolsPanel.init(DEPS({ api, el: (id) => dom.get(id), tryCmd: async (c) => (c === "block" ? { block: "1234567" } : [{ tokenid: "0x00", sendable: "500" }]) }));

  const paint = async (v) => { dom.nodes.ppBody = null; delete dom.nodes.ppBody; s.PoolsPanel._setView(v); await s.PoolsPanel.render(); return dom.get("ppBody").innerHTML; };

  const swap = await paint("swap");
  assert.ok(swap.includes("YOU PAY") && swap.includes("YOU RECEIVE"), "the FROM/TO legs");
  assert.ok(swap.includes(">⇅<"), "the flip control sits between them");
  assert.ok(!/slippage/i.test(swap), "the APK has no slippage control here, and neither does this");

  const list = await paint("pools");
  assert.ok(list.includes("MINIMA / MxUSD"), "the pair card");
  assert.ok(list.includes(`data-pool="${POOL}"`), "the row carries the complete pool address");

  const lp = await paint("mylp");
  assert.ok(lp.includes("YOUR LIQUIDITY"), "the summary block");
  assert.ok(lp.includes("K/KMIN 1.20 · healthy"), "the health bar reads the pool's real headroom");
  assert.ok(lp.includes("Pool calculator"), "the calculator is reachable");

  const act = await paint("activity");
  assert.ok(act.includes("3 confirmations · on-chain"), "the confirmation vocabulary is unchanged");
  assert.ok(act.includes("pp-glyph--ok"), "and carries the APK's glyph column");
  assert.ok(act.includes("2026-09-08") && act.includes("UTC"), "times stay absolute UTC");

  for (const html of [swap, list, lp, act]) {
    assert.ok(!/undefined|\[object Object\]/.test(html), "no template hole reached the markup");
  }
});

test("the style toggle is the panel's own, and survives nothing but its own state", () => {
  const s = panel();
  const dom = fakeDom();
  let stored = null;
  s.localStorage = { getItem: () => stored, setItem: (k, v) => { stored = v; }, removeItem() {} };
  s.PoolsPanel.init(DEPS({ el: (id) => dom.get(id) }));
  const css = fs.readFileSync(path.join(R, "pools.css"), "utf8");
  assert.ok(css.includes('[data-ppstyle="original"]'), "the Original look is a data-attribute variant");
  assert.ok(/\[data-ppstyle="original"\][\s\S]*--pp-r:\s*0px/.test(css), "Original is hard-edged");
  assert.ok(/\[data-ppstyle="original"\][\s\S]*--pp-sans:\s*var\(--pp-mono\)/.test(css), "Original is monospace");
});

test("the kv atom keeps the APK's two different value faces", () => {
  const css = fs.readFileSync(path.join(R, "pools.css"), "utf8");
  assert.ok(/\.ppapp \.pp-k\s*\{[^}]*max-width:\s*190px/.test(css), "the key column is capped at 190px");
  assert.ok(/\.ppapp \.pp-v\s*\{[^}]*font-family:\s*var\(--pp-mono\)/.test(css), "kv values are monospace");
  const vc = /\.ppapp \.pp-vc\s*\{([^}]*)\}/.exec(css);
  assert.ok(vc, ".pp-vc exists");
  assert.ok(!/font-family/.test(vc[1]), "MyLpView.kvColored is NOT monospace — the APK's own inconsistency");
});

test("a pool past the product-floor threshold turns the health bar amber and fills Migrate", () => {
  const s = panel();
  const dom = fakeDom();
  s.PoolsPanel.init(DEPS({ el: (id) => dom.get(id) }));
  const mine = (kratio) => [{ address: "0xAAA", opk: "0xBBB", tok: "0xCCC", tokName: "MxUSD",
    reserveM: "100", reserveT: "50", value: "200", poolPrice: "0.5", feesMinima: "1", feesPct: "0.5", kratio }];
  const healthy = s.PoolsPanel._mineHtml(mine(1.2));
  const warn = s.PoolsPanel._mineHtml(mine(1.9));
  assert.ok(healthy.includes("healthy") && !healthy.includes("migrate soon"), "below the threshold reads healthy");
  assert.ok(warn.includes("migrate soon") && warn.includes("is-warn"), "past it the bar and label go amber");
  assert.ok(/class="pp-btn pp-btn--sm pp-btn--fill" data-ppmig=/.test(warn), "Migrate becomes the filled action");
  assert.ok(!/class="pp-btn pp-btn--sm pp-btn--fill" data-ppmig=/.test(healthy), "and is not filled before that");
});

test("RULE 1 — a shortened pool address always carries the complete value to copy", () => {
  const s = panel();
  const dom = fakeDom();
  s.PoolsPanel.init(DEPS({ el: (id) => dom.get(id) }));
  const full = "0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A";
  const html = s.PoolsPanel._mineHtml([{ address: full, opk: "0xBBB", tok: "0xCCC", tokName: "MxUSD",
    reserveM: "100", reserveT: "50", value: "200", poolPrice: "0.5", feesMinima: "1", feesPct: "0.5", kratio: 1 }]);
  assert.ok(html.includes(`data-copy="${full}"`), "the complete address is one click away");
  assert.ok(html.includes(`title="${full}"`), "and readable on hover");
});

test("nothing that moves value changed — the engine calls and guards came across verbatim", () => {
  const src = fs.readFileSync(path.join(R, "pools.js"), "utf8");
  for (const call of ["api.ppQuote(", "api.ppSwap(q.quoteId)", "api.ppCreate(", "api.ppDeposit(",
                      "api.ppMigrate(", "api.ppClose(", "api.ppCollect()", "api.ppRestore(",
                      "api.ppRecoverSaved(", "api.ppConfirmSigning("]) {
    assert.ok(src.includes(call), call + " is still here");
  }
  for (const guard of ["ppSwapBusy", "ppWithdrawBusy", "ppCollectBusy", "ppBackupBusy", "ppStatementBusy", "ppQuoteSeq"]) {
    assert.ok(src.includes(guard), guard + " survived the rewrite");
  }
  // the swap still posts the EXACT quote it showed, not a re-derived one
  assert.ok(/const q = await api\.ppQuote\([^)]*\)[\s\S]{0,900}await showConfirm\("Confirm swap"/.test(src),
    "a fresh quote is frozen before the confirm dialog");
  assert.ok(/await showConfirm\("Confirm swap"[\s\S]{0,900}api\.ppSwap\(q\.quoteId\)/.test(src),
    "and that same quoteId is what gets posted");
});

test("app.js keeps only the wiring, and defines the reset it always called", () => {
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  assert.ok(app.includes("PoolsPanel.init({"), "the panel is injected, not reached into");
  assert.ok(/function resetPpState\(\) \{ PoolsPanel\.reset\(\); \}/.test(app),
    "resetPpState exists — it was called on every seed change but never defined");
  assert.ok(!/function renderPpSwap/.test(app), "the panel's internals left app.js");
  assert.ok(!/ppMineHtml/.test(app), "…all of them");
});

// ------------------------------------------------------------------ the P2P Chance panel, headless
function czPanel() {
  const sandbox = { setTimeout, clearTimeout, Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Promise, console,
    performance, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    devicePixelRatio: 1,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, className: "", innerHTML: "", appendChild() {}, addEventListener() {},
        querySelector: () => ({ textContent: "", classList: { add() {} }, addEventListener() {}, querySelector: () => ({}) }),
        querySelectorAll: () => [], remove() {} }),
      addEventListener() {}, removeEventListener() {}, body: { appendChild() {}, insertAdjacentHTML() {} } } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(R, "casinoart.js"), "utf8"), ctx, { filename: "casinoart.js" });
  vm.runInContext(fs.readFileSync(path.join(R, "casino.js"), "utf8"), ctx, { filename: "casino.js" });
  return sandbox;
}
const CZ_DEPS = (over) => Object.assign({
  api: NOOP_API,
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  el: () => null, toast() {},
  cfg: () => ({}), setCfg() {}, activeView: () => "casino"
}, over || {});

test("the P2P Chance panel loads and exposes only its wiring surface", () => {
  const s = czPanel();
  assert.ok(s.CasinoPanel, "CasinoPanel is exported");
  for (const fn of ["init", "render", "onUpdate", "badge", "activity", "ageGate", "reset", "goToMyBets", "setBlock"]) {
    assert.equal(typeof s.CasinoPanel[fn], "function", fn + " is on the panel");
  }
});

test("the panel is P2P Chance, not Zero Edge Casino, everywhere a user can read it", async () => {
  const s = czPanel();
  const dom = fakeDom();
  s.CasinoPanel.init(CZ_DEPS({ el: (id) => dom.get(id) }));
  await s.CasinoPanel.render();
  const html = dom.get("casinoBody").innerHTML;
  assert.ok(html.includes("P2P CHANCE"), "the wordmark");
  assert.ok(!/Zero Edge/i.test(html), "the old name is gone from the rendered panel");
  const html2 = fs.readFileSync(path.join(R, "index.html"), "utf8");
  assert.ok(html2.includes(">P2P Chance<"), "and from the tab");
  assert.ok(!/>P2PChance</.test(html2), "spelled with the space");
  // the engine files keep the donor's own naming — renaming them would break the byte-parity gate
  assert.ok(fs.readFileSync(path.join(R, "..", "main", "casino", "service.js"), "utf8").includes("Zero Edge Casino"),
    "the donor service is untouched");
});

test("the header carries the APK chrome: tagline, live dot, block, currency and sound", async () => {
  const s = czPanel();
  const dom = fakeDom();
  const api = new Proxy({}, { get: (_t, k) => () => {
    if (k === "casinoStatus") return Promise.resolve({ ready: true, block: 1234567 });
    if (k === "casinoBalance") return Promise.resolve("500");
    if (k === "casinoStakeable") return Promise.resolve("480");
    return Promise.resolve([]);
  } });
  s.CasinoPanel.init(CZ_DEPS({ api, el: (id) => dom.get(id) }));
  await s.CasinoPanel.render();
  const html = dom.get("casinoBody").innerHTML;
  assert.ok(html.includes("TRUE ODDS · NO HOUSE"), "the tagline");
  assert.ok(html.includes('class="cz-dot is-live"'), "the live dot lights when the engine is ready");
  assert.ok(html.includes("#1234567"), "the block number");
  assert.ok(html.includes('id="casinoCcy"') && html.includes('id="casinoMute"'), "the currency and sound pills");
  assert.ok(html.includes('class="cz-ticker"'), "the ticker sits under the header");
  assert.ok(html.includes(">PLAY<") && html.includes(">HOUSE<") && html.includes(">HISTORY<"), "the APK's tab labels");
});

test("the pick grid has the APK's columns: 2 for Flip, 6 for Dice, 6×6 for Roulette", () => {
  const s = czPanel();
  s.CasinoPanel.init(CZ_DEPS());
  const flip = s.CasinoPanel._picker(2, "0xAA", null);
  const dice = s.CasinoPanel._picker(6, "0xAA", null);
  const roul = s.CasinoPanel._picker(36, "0xAA", 3);
  assert.ok(flip.includes("cz-grid--2") && (flip.match(/cz-chip/g) || []).length === 2, "Flip is two chips");
  assert.ok(dice.includes("cz-grid--6") && (dice.match(/cz-chip/g) || []).length === 6, "Dice is six");
  assert.ok(roul.includes("cz-grid--36") && (roul.match(/cz-chip/g) || []).length === 36, "Roulette is a 36-cell grid");
  assert.ok(!/<input/.test(roul), "…not the bare number input it used to be");
  assert.ok(roul.includes('class="cz-chip is-on" data-pick="3"'), "the current pick is the filled chip");
  const css = fs.readFileSync(path.join(R, "casino.css"), "utf8");
  assert.ok(/\.cz-grid--36\s*\{[^}]*repeat\(6, 1fr\)/.test(css), "…laid out six across, as on the phone");
});

test("the type rule holds: bold is monospace, and there is no bold sans in the sheet", () => {
  const css = fs.readFileSync(path.join(R, "casino.css"), "utf8");
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((b) => b.trim()).filter(Boolean);
  const offenders = [];
  for (const b of blocks) {
    const body = b.split("{")[1] || "";
    const weight = /font-weight:\s*([0-9]{3}|bold)/.exec(body);
    if (!weight) continue;
    const w = weight[1] === "bold" ? 700 : parseInt(weight[1], 10);
    if (w < 600) continue;
    const fam = /font-family:\s*([^;]+)/.exec(body);
    // a bold rule must either name the mono stack itself, or sit on an element that inherits it
    if (!fam || !/--cz-mono/.test(fam[1])) offenders.push(b.split("{")[0].trim());
  }
  assert.deepEqual(offenders, [], "bold without the monospace stack: " + offenders.join(" | "));
});

test("the animation timings are the APK's, and only a win gets confetti", () => {
  const s = czPanel();
  const T = s.CasinoArt.T;
  assert.deepEqual(
    [T.COIN_MS, T.COIN_TURNS, T.COIN_EASE, T.COIN_GLYPH_AT], [1100, 5, 3.2, 0.18], "coin");
  assert.deepEqual(
    [T.DICE_MS, T.DICE_SPIN, T.DICE_FLICK_MS, T.DICE_LOCK_AT], [900, 540, 55, 0.82], "dice");
  assert.deepEqual([T.ROU_MS, T.ROU_TURNS, T.ROU_EASE], [2000, 6, 4.4], "roulette");
  assert.deepEqual([T.CONF_N, T.CONF_MS, T.CONF_GRAV, T.CONF_SPIN], [12, 1200, 1.1, 720], "confetti");
  assert.deepEqual([T.OVERLAY_WATCHDOG_MS, T.OVERLAY_DISMISS_MS], [2800, 6000], "the overlay's two safety timers");
  const src = fs.readFileSync(path.join(R, "casino.js"), "utf8");
  assert.ok(/if \(won\) \{ casinoSfx\.win\(\); try \{ CasinoArt\.confetti/.test(src), "confetti fires on a win only");
});

test("the wheel is the zero-edge wheel: 36 pockets and no zero", () => {
  const s = czPanel();
  const W = s.CasinoArt.WHEEL;
  assert.equal(W.length, 36, "36 pockets");
  assert.ok(!W.includes(0), "no zero — that is the whole point of a zero-edge table");
  assert.deepEqual([...W].sort((a, b) => a - b), Array.from({ length: 36 }, (_, i) => i + 1), "1–36 exactly once each");
  assert.equal(Object.keys(s.CasinoArt.REDS).length, 18, "18 reds, 18 blacks");
});

test("nothing that moves value changed in the casino rewrite", () => {
  const src = fs.readFileSync(path.join(R, "casino.js"), "utf8");
  for (const call of ["api.casinoCreate(", "api.casinoTake(", "api.casinoCancel(", "api.casinoReveal",
                      "api.casinoResolve", "api.casinoClaimTimeout", "api.casinoSetCurrency("]) {
    assert.ok(src.includes(call), call + " is still here");
  }
  assert.ok(/casinoBusy\[coinid\] = true/.test(src), "the per-coin busy guard survived");
  assert.ok(/casinoBusy\.create = true/.test(src), "…and the create guard");
  assert.ok(src.includes("casinoAgeGate"), "the 18+ self-cert gate is still in the panel");
  assert.ok(/const snap = new Set\(\);[\s\S]{0,260}api\.casinoCreate\(/.test(src),
    "the pre-post myBets snapshot still fences the create-confirm");
  const art = fs.readFileSync(path.join(R, "casinoart.js"), "utf8");
  assert.ok(!/api\.|Math\.random\(\) \* range/.test(art.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the artwork module touches no engine call and rolls no outcome of its own");
});

test("app.js keeps only the casino wiring", () => {
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  assert.ok(app.includes("CasinoPanel.init({"), "the panel is injected, not reached into");
  assert.ok(!/function renderCasinoPlay/.test(app), "the panel's internals left app.js");
  assert.ok(!/function casinoSpinner/.test(app), "…including the animations");
  assert.equal((app.match(/function resetCasinoState/g) || []).length, 1, "exactly one resetCasinoState");
});
