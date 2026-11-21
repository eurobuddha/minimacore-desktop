// Languages (0.19.140+): the helper, the catalogs and the chooser. The key of a text is its English, so English can
// never be missing; what this file keeps true is that the other three languages are WHOLE and SAFE:
//   - every key the code translates (a literal first argument of t / th / tr / N_, and every data-i18n in index.html)
//     is in zh, ru and uk, with the same placeholders, not empty, and not left as its English unless listed as "same";
//   - a translated value is data: no "<" or ">", and a quote (" ' `) or ampersand only where its English has one;
//   - a plural (an object in en.js) has every form its language needs.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), ts = require("typescript");
const ROOT = path.join(__dirname, ".."), R = path.join(ROOT, "renderer");
const I18N = require("../renderer/i18n.js");
const OTHERS = ["zh", "ru", "uk"].filter(c => fs.existsSync(path.join(R, "i18n", c + ".js")));
require("../renderer/i18n/en.js"); for (const c of OTHERS) require("../renderer/i18n/" + c + ".js");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8");
const FORMS = { en: ["one", "other"], zh: ["other"], ru: ["one", "few", "many", "other"], uk: ["one", "few", "many", "other"] };
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");

/** Every key the code translates: [key, where]. Vendored engine files are never scanned (they are never edited). */
function usedKeys() {
  const out = [], files = [];
  for (const f of fs.readdirSync(R)) if (f.endsWith(".js") && f !== "i18n.js" && f !== "qrcode.js") files.push(path.join(R, f));
  files.push(path.join(R, "i18n", "start.js"));
  for (const f of fs.readdirSync(path.join(ROOT, "main"))) if (f.endsWith(".js")) files.push(path.join(ROOT, "main", f));
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8"); if (!/\b(t|th|tr|N_|L_)\(/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const walk = (n) => {
      if (ts.isCallExpression(n) && n.arguments.length) {
        const c = n.expression, name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && /^(I18N|lang|L)$/.test(c.expression.text) ? c.name.text : "";
        const a = n.arguments[0];
        if (/^(t|th|tr|N_|L_)$/.test(name) && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) out.push([a.text, path.relative(ROOT, file) + ":" + (sf.getLineAndCharacterOfPosition(a.pos).line + 1)]);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  const P = require("../renderer/params.js");   // the Startup Params table: its group names, labels, helps and notes are shown through th()
  for (const g of P.GROUPS) { out.push([g.group, "renderer/params.js"]); for (const it of g.items) { out.push([it.label, "renderer/params.js " + it.flag]); out.push([it.help, "renderer/params.js " + it.flag]); } }
  for (const m of P.MANAGED_INFO) out.push([m.note, "renderer/params.js " + m.flag]);
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]*)"/g)) out.push([m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"), "renderer/index.html"]);
  return out;
}

test("t, th, tr: the key is the English; named placeholders; a missing key shows its English, never a blank", () => {
  I18N.set("en");
  assert.equal(I18N.t("Send"), "Send");
  assert.equal(I18N.t("Sent {amount} to {to}", { amount: "1.50", to: "0xAB" }), "Sent 1.50 to 0xAB");
  assert.equal(I18N.t("{a} of {b}", { a: 1 }), "1 of {b}", "a placeholder with no value stays as written, in sight");
  assert.equal(I18N.t("Total {n}", { n: "1234567.000000000000000001" }), "Total 1234567.000000000000000001", "an amount is the string given: no grouping, no rounding, a point");
  assert.equal(I18N.th("Backup & Recovery"), "Backup &amp; Recovery");
  assert.equal(I18N.th("From {who}", { who: '<img src=x onerror="1">' }), "From &lt;img src=x onerror=&quot;1&quot;&gt;", "th escapes what a peer or the node supplied");
  assert.equal(I18N.tr("From {who}", { who: "<b>x</b>" }), "From <b>x</b>", "tr inserts what the caller already made safe");
  assert.equal(I18N.t(""), ""); assert.equal(I18N.t("{constructor}", {}), "{constructor}", "only the caller's own fields fill a placeholder");
  assert.equal(I18N.N_("Receive"), "Receive");
});

test("the system's language picks one of the four, else English", () => {
  for (const [tag, code] of [["zh-CN", "zh"], ["zh", "zh"], ["zh-Hans-CN", "zh"], ["zh-TW", "zh"], ["zh_CN", "zh"], ["ru", "ru"], ["ru-RU", "ru"], ["uk", "uk"], ["uk-UA", "uk"], ["en-GB", "en"], ["de-DE", "en"],
    ["", "en"], [null, "en"], [undefined, "en"], ["rue", "en"], ["ukr", "en"], ["zhx", "en"]]) assert.equal(I18N.pick(tag), code, String(tag));
  assert.deepEqual(I18N.CODES, ["en", "zh", "ru", "uk"]);
  assert.deepEqual(I18N.NAMES, { en: "English", zh: "简体中文", ru: "Русский", uk: "Українська" }, "each language in its own name, as the phone's chooser");
  assert.equal(I18N.set("de"), false); assert.equal(I18N.lang(), "en");
});

test("plurals: Intl.PluralRules chooses the form from params.n; the number itself is written as given", () => {
  const J = require("../renderer/i18n.js");
  J.add("en", { "{n} test things": { one: "{n} test thing", other: "{n} test things" } });
  J.add("ru", { "{n} test things": { one: "{n} вещь", few: "{n} вещи", many: "{n} вещей", other: "{n} вещи" }, "Test only": "Только тест" });
  J.set("en"); assert.equal(J.t("{n} test things", { n: 1 }), "1 test thing"); assert.equal(J.t("{n} test things", { n: "4" }), "4 test things");
  J.set("ru");
  for (const [n, want] of [[1, "1 вещь"], [2, "2 вещи"], [4, "4 вещи"], [5, "5 вещей"], [11, "11 вещей"], [21, "21 вещь"], [22, "22 вещи"], [100, "100 вещей"]]) assert.equal(J.t("{n} test things", { n }), want);
  assert.equal(J.t("Test only"), "Только тест"); assert.equal(J.t("Not in the catalog"), "Not in the catalog", "English, never a blank or a key name");
  let seen = ""; J.onChange(c => { seen = c; }); J.set("en"); assert.equal(seen, "en");
  for (const c of ["en", "ru"]) { delete J.catalog(c)["{n} test things"]; } delete J.catalog("ru")["Test only"];
});

test("every translated key is in zh, ru and uk: same placeholders, not empty, not left in English, no markup", () => {
  const used = usedKeys(), en = I18N.catalog("en");
  assert.ok(used.some(([k]) => k === "Language"), "the scan finds the chooser's own key");
  for (const code of OTHERS) {
    const cat = I18N.catalog(code), same = new Set(I18N.same(code)), ours = new Set(I18N.review(code)), bad = [];
    for (const [key, where] of used) {
      if (!Object.hasOwn(cat, key)) { bad.push("missing: " + JSON.stringify(key) + " (" + where + ")"); continue; }
      const v = cat[key], vals = v && typeof v === "object" ? Object.values(v) : [v];
      if (Object.hasOwn(en, key) !== (v && typeof v === "object")) bad.push("plural in one language only: " + JSON.stringify(key));
      for (const s of vals) {
        if (typeof s !== "string" || !s.trim()) { bad.push("empty: " + JSON.stringify(key)); continue; }
        if (holes(s) !== holes(key) && !(typeof v === "object")) bad.push("placeholders differ: " + JSON.stringify(key) + " -> " + JSON.stringify(s));
        if (typeof v === "object" && [...s.matchAll(/\{(\w+)\}/g)].some(m => !holes(key).split(",").includes(m[1]))) bad.push("unknown placeholder: " + JSON.stringify(s));
        if (s === key && !same.has(key)) bad.push("left in English: " + JSON.stringify(key) + " (" + where + ")");
        if (/[<>]/.test(s) && !/[<>]/.test(key)) bad.push("markup: " + JSON.stringify(s));
        for (const ch of ['"', "&", "`", "'"]) if (s.includes(ch) && !key.includes(ch)) bad.push("a " + ch + " its English does not have: " + JSON.stringify(s));
        if (s.includes("—") && !key.includes("—") && ours.has(key)) bad.push("an em dash: " + JSON.stringify(s));   // the phone's own wording is taken as it is; what was translated for the desktop has none
        if (/MxUSDT|mxUSDT/.test(s)) bad.push("the Minima dollar token is MxUSD: " + JSON.stringify(s));
      }
    }
    for (const k of Object.keys(en)) { const v = cat[k]; if (v === undefined) continue; for (const f of FORMS[code]) if (!v || typeof v !== "object" || !v[f]) bad.push("plural form " + f + " missing: " + JSON.stringify(k)); }
    for (const k of I18N.review(code)) if (!Object.hasOwn(cat, k)) bad.push("in the review list but not in the catalog: " + JSON.stringify(k));
    for (const k of same) if (cat[k] !== k) bad.push("listed as the same in both languages, but is not: " + JSON.stringify(k));
    assert.deepEqual(bad.slice(0, 40), [], code + ": " + bad.length + " problem(s)");
  }
  for (const k of Object.keys(en)) for (const f of FORMS.en) assert.ok(en[k] && en[k][f], "en plural " + f + ": " + k);
});

test("no helper is hidden by a local name: where a function has its own t, th or tr, the call goes through I18N", () => {
  // `const t = el("toast"); … t("Copied")` would call an element. The renderer has many locals named t.
  const bad = [];
  for (const f of fs.readdirSync(R).filter(f => f.endsWith(".js") && f !== "i18n.js" && f !== "qrcode.js")) {
    const src = fs.readFileSync(path.join(R, f), "utf8"), sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const names = (fn) => { const out = new Set(), bind = (n) => { if (!n) return; if (ts.isIdentifier(n)) out.add(n.text); else if (n.elements) n.elements.forEach(e => bind(e.name)); };
      const w = (n) => { if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) bind(n.name); if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) out.add(n.name.text); ts.forEachChild(n, w); }; w(fn); return out; };
    const cache = new Map(), walk = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(t|th|tr|N_|L_)$/.test(n.expression.text) && n.arguments.length && ts.isStringLiteral(n.arguments[0]))
        for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) { if (!cache.has(p)) cache.set(p, names(p)); if (cache.get(p).has(n.expression.text)) { bad.push(f + ":" + (sf.getLineAndCharacterOfPosition(n.pos).line + 1)); break; } }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  assert.deepEqual(bad, []);
});

test("the page's fixed text: every entry of the PAGE table is the English the page itself carries", () => {
  const src = fs.readFileSync(path.join(R, "i18n", "start.js"), "utf8"), rows = [...src.matchAll(/\[('[^']+'|"[^"]+"), "([a-z-]*)", N_\("((?:[^"\\]|\\.)*)"\)\]/g)];
  assert.ok(rows.length >= 50, "the table is read (" + rows.length + " rows)");
  const h = (s) => s.replace(/&/g, "&amp;");
  for (const [, , attr, key] of rows) assert.ok(html.includes(attr ? attr + '="' + h(key) + '"' : ">" + h(key) + "<"), (attr || "text") + ": " + key);
});

test("what must never be translated is the same in every language", () => {
  for (const code of OTHERS) {
    const cat = I18N.catalog(code);
    for (const [k, v] of Object.entries(cat)) for (const s of (v && typeof v === "object" ? Object.values(v) : [v])) {
      if (typeof s !== "string") continue;
      for (const word of ["MxUSD", "Dexicon", "Pandamonium", "Minima Core", "Parlons", "MegaMMR"]) if (k.includes(word)) assert.ok(s.includes(word), code + ": " + word + " kept in " + JSON.stringify(k));
      for (const typed of ["SHOW KEY", "RESTORE"]) if (new RegExp("\\b[Tt]yp(e|ing) " + typed + "\\b").test(k)) assert.ok(s.includes(typed), code + ": the words to type stay as they are: " + JSON.stringify(k));
    }
  }
});

test("the chooser: in the tray, in the overflow menu and on the first-run launcher; saved by the main process", () => {
  assert.ok(/<button class="tray__lang" id="trayLang" data-i18n="Language">Language<\/button>\s*<div class="tray__mode"/.test(html), "pinned at the bottom of the tray, above the mode line");
  assert.ok(/data-act="shutdown">[^<]*<\/button>\s*<button class="menu__item" role="menuitem" data-act="language" data-i18n="Language">/.test(html), "in the overflow menu after Shutdown, as the phone's");
  assert.ok(/act === "language"\) chooseLanguage\(\)/.test(app) && /el\("trayLang"\)\.onclick/.test(app) && /el\("frLang"\)\.onclick = chooseLanguage/.test(app));
  assert.ok(/await api\.langSet\(code\); \} catch \(e\) \{ toast\(ipcError\(e\), "err"\); return; \}[^\n]*\n\s*I18N\.set\(code\);/.test(app), "the window switches only after the main process has saved the choice");
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 2), ["i18n.js", "i18n/en.js"]); assert.ok(order.indexOf("i18n/start.js") > 1 && order.indexOf("i18n/start.js") < order.indexOf("qrcode.js"), "the language is set before any screen script runs");
  for (const c of OTHERS) assert.ok(order.indexOf("i18n/" + c + ".js") > 0 && order.indexOf("i18n/" + c + ".js") < order.indexOf("i18n/start.js"), c + " catalog loaded before the start");
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), pre = fs.readFileSync(path.join(ROOT, "main", "preload.js"), "utf8"), cfg = fs.readFileSync(path.join(ROOT, "main", "config.js"), "utf8");
  assert.ok(/language: "",/.test(cfg), "config key declared (save() drops undeclared keys)");
  assert.ok(/ipcMain\.on\("mcd:langGet"/.test(main) && /if \(!lang\.set\(code\)\) throw new Error\("Unknown language\."\);\s*config\.save\(\{ language: code \}\);/.test(main), "a code that is not one of the four is refused before anything is saved");
  assert.ok(/ipcRenderer\.sendSync\("mcd:langGet"\)/.test(pre) && /langSet: \(code\) => ipcRenderer\.invoke\("mcd:langSet", code\)/.test(pre));
});

test("main/lang.js: the saved language wins, then the system's, then English; an unknown code changes nothing", () => {
  const lang = require("../main/lang.js");
  assert.equal(lang.resolve("", "de-DE"), "en"); assert.equal(lang.resolve("xx", ""), "en"); assert.equal(lang.resolve("en", "ru-RU"), "en", "a saved choice is not overridden by the system");
  for (const c of OTHERS) { assert.equal(lang.resolve(c, "en-US"), c); assert.equal(lang.resolve("", I18N.TAGS[c]), c, "the system's language when nothing was picked"); }
  assert.equal(lang.init("", "en-GB"), "en"); assert.equal(lang.set("de"), false); assert.equal(lang.set(null), false); assert.equal(lang.set({}), false); assert.equal(lang.current(), "en");
  for (const c of OTHERS) { assert.equal(lang.set(c), true); assert.equal(lang.current(), c); } lang.set("en");
});

// 0.19.149: English the review of 0.19.140 to 0.19.144 found inside translated screens. Each is display-only (read in the code
// before it was wrapped); a value that is compared, sent or stored stays English and is translated where shown.
test("the English the review found in translated screens is said in every language", async () => {
  for (const c of OTHERS) require("../renderer/i18n/" + c + ".js");
  const AX = require("../renderer/dexicon-ax.js"), Act = require("../renderer/apps-act.js");
  try {
    for (const code of OTHERS) {
      I18N.set(code);
      for (const [st, en] of [["COMPLETE", "Complete"], ["REJECTED", "Rejected"], ["EXPIRED", "Expired"]]) { const s = AX.dealStatus({ status: st }); assert.equal(s, I18N.t(en)); assert.notEqual(s, en, code + " " + st); }
      const sig = Act.keyuses.signing({ block: { used: 2427000, cap: 3000000, count: 2 } });
      assert.ok(!/^position /.test(sig[0].value) && sig[0].value.includes(Act.keyuses.num(2427000)) && sig[0].value.includes(Act.keyuses.num(3000000)), code + ": " + sig[0].value);
      const v = Act.keyuses.verdict({ verdict: "OK", complete: true, classicKeys: 64, blockKeys: 32 });
      assert.ok(!/^Checked scope/.test(v.scope) && v.scope.includes("64") && v.scope.includes("32"), code + ": " + v.scope);
      let said = null, sent = null;
      await Act.vestr.create({ vestrCreate: async (o) => { sent = o; } }, { confirm: async (t, m) => { said = m; return true; } }, { tokenid: "0x00", amount: "5", beneficiary: "MxG0X", startMs: 1, endMs: 2, graceHours: "24", burn: "", password: "" }, "Minima", "Daily");
      assert.ok(said.includes(I18N.t("Daily")) && !/\bDaily\b/.test(said), code + ": the period's name is shown translated");
      assert.equal(sent.graceHours, 24, "what is sent is the number of hours, as before"); assert.ok(!JSON.stringify(sent).includes(I18N.t("Daily")));
    }
  } finally { I18N.set("en"); }
  // the rest: the bare English is gone from the source (each now goes through t / th)
  const src = (f) => fs.readFileSync(path.join(R, f), "utf8");
  for (const [f, bare] of [["dexicon-ax.js", ': "a few blocks"'], ["dexicon-ax.js", 'HIDE_ASK(s.role === "RESPONDER"), "Hide")'], ["dexicon-ax.js", '}), "Set", {'], ["dexicon-ax.js", '? "less than a minute ago"'], ["dexicon-ax.js", '"sells up to "'],
    ["dexicon-ui.js", '? "you were the maker"'], ["dexicon-ui.js", 'dialog("History"'], ["dexicon-ui.js", 'dialog("Trade"'], ["dexicon-ui.js", 'dialog("Activity"'], ["dexicon-ui.js", ': "on-chain book and pools"'], ["dexicon-ui.js", 'title="Click to copy"'], ["dexicon-ui.js", '  available<br>'], ["dexicon-ui.js", '? "no live orders"'], ["dexicon-ui.js", '(buy ? "Paid " : "Received ")'],
    ["dexicon-pp.js", '? "migrate soon" : "healthy"'], ["dexicon-pp.js", ': "Add", "ppadd"'], ["dexicon-pp.js", 'lpBtn("Migrate"'], ["dexicon-pp.js", 'lpBtn("Close"'],
    ["mail.js", '" · block " + groupInt'], ["mail.js", ': "On-chain" +'], ["mail.js", 'D.toast("Re-posting…"'],
    ["app.js", 'stat.textContent = "connecting…"'], ["app.js", "this Mac's IP address"], ["app.js", "(this Mac)"], ["app.js", ': "your router"'], ["app.js", "{ mode: KEYMODE.mode, mode2: mode }"]])
    assert.ok(!src(f).includes(bare), f + " still has " + bare);
});

// 0.19.150: a CSS value is code, not text: the chart's font family went through t() and sat in every catalog as "the same"
test("no CSS value is a catalog key, and the pool chart's font is a plain value", () => {
  for (const code of OTHERS) for (const k of Object.keys(I18N.catalog(code))) assert.ok(!/(^|,\s*)(sans-serif|serif|monospace)$|^#[0-9A-Fa-f]{3,8}$|^var\(--/.test(k), code + ": " + k);
  assert.ok(fs.readFileSync(path.join(R, "dexicon-pp.js"), "utf8").includes('font: "Inter, sans-serif"'));
});

// 0.19.152: a catalog that throws while loading must not stop the main process (main.js requires lang.js at its top)
test("main/lang.js: a broken catalog is skipped and the app runs in English", () => {
  const { spawnSync } = require("node:child_process");
  const probe = `const M = require("module"), real = M.prototype._compile;
    M.prototype._compile = function (src, file) { if (/i18n[\\\\/]ru\\.js$/.test(file)) throw new SyntaxError("Unexpected token (a broken catalog)"); return real.apply(this, arguments); };
    const lang = require(${JSON.stringify(path.join(ROOT, "main", "lang.js"))});
    process.stdout.write(JSON.stringify({ broken: lang.broken, saved: lang.resolve("ru", ""), sys: lang.resolve("", "ru-RU"), set: lang.set("ru"), now: lang.current(), zh: lang.set("zh"), t: lang.t("Language") }));`;
  const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { broken: ["ru"], saved: "en", sys: "en", set: false, now: "en", zh: true, t: "语言" }, "Russian is not offered; the others load; nothing stops");
  assert.match(r.stderr, /\[lang\] the ru catalog could not be loaded, so it is not offered: Unexpected token/);
});

// 0.19.154: code that decides by matching TEXT breaks as soon as that text is translated (0.19.142 to 0.19.144 shipped two:
// the Dexicon Trade buttons and the Market offline card). Every regex literal, and every string compared with ===, !==, a
// case, includes, startsWith, endsWith or indexOf, in the shipped renderer and main files (vendored engines and catalogs
// excluded), is checked against the translated catalog keys: a phrase of 9+ characters found inside a translated key, or a
// whole translated key, fails unless listed below with the reason it is safe.
test("no code decides by matching text that is translated (regex, ===, includes, startsWith…), except the listed cases", () => {
  for (const c of OTHERS) require("../renderer/i18n/" + c + ".js");
  const ALLOW = {
    "renderer/apps-act.js International": "a delivery label as stored and sent (a wire value), compared before it is translated for the screen",
    "renderer/app.js BAD_TOTAL": "a miniMall order state as stored (a wire value), compared before it is translated for the screen",
    "main/shop-store.js WRONG_TOKEN": "the order state as stored (a wire value), compared in main; never translated there",
    "renderer/dexicon-ax.js AtomiX is halted": "the AtomiX glue's own refusal (main/atomix.js), which reaches the window in English",
    "renderer/dexicon-core.js Only your own orders are at this price": "the Exchange engine's own English sentence (dexicon/lib/ownskip.js), matched before anything is translated",
    "renderer/mail.js validate the recipient": "main/mail.js's own English error",
    "renderer/mail.js may have been submitted": "main/mail.js's own English error, read from the raw message (never translated)",
    "renderer/dexicon-ui.js CONFIRMED": "the Exchange engine's own stage name (dexicon/lib/activity.js chip), read for its tone before it is translated for the screen",
    "main/node-manager.js  Parlons Node ": "a line of the parlons-node jar's own log",
    "main/pandapools.js  MINIMA for ": "the PandaPools engine's English summary of a swap"
  };
  const keys = new Set(); for (const c of OTHERS) { const cat = I18N.catalog(c); for (const k of Object.keys(cat)) if (cat[k] !== k) keys.add(k); }
  const K = [...keys], files = [...fs.readdirSync(R).filter(f => f.endsWith(".js") && f !== "qrcode.js").map(f => path.join(R, f)), ...fs.readdirSync(path.join(ROOT, "main")).filter(f => f.endsWith(".js")).map(f => path.join(ROOT, "main", f))];
  const runs = (pat) => pat.replace(/\\[sSdDwWbB]/g, "\u0000").replace(/\\(.)/g, "$1").split(/[\u0000^$()[\]?*+{}|.]/).filter(x => x.length >= 9);
  const found = [], used = new Set();
  const scan = (rel, src, out) => {
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const hit = (n, lits) => { for (const l of lits) { const k = keys.has(l) ? l : /[A-Za-z] +[A-Za-z]/.test(l) ? K.find(x => x.includes(l)) : null; if (!k) continue;
      if (Object.hasOwn(ALLOW, rel + " " + l)) { used.add(rel + " " + l); continue; } out.push(rel + ":" + (sf.getLineAndCharacterOfPosition(n.getStart()).line + 1) + " " + JSON.stringify(l) + " is in the key " + JSON.stringify(k).slice(0, 80)); } };
    const str = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.length >= 9;
    const walk = (n) => {
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) { const x = n.getText(); hit(n, runs(x.slice(1, x.lastIndexOf("/")))); }
      if (ts.isBinaryExpression(n) && /^(===|!==|==|!=)$/.test(n.operatorToken.getText())) for (const side of [n.left, n.right]) if (str(side)) hit(side, [side.text]);
      if (ts.isCaseClause(n) && str(n.expression)) hit(n, [n.expression.text]);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(includes|startsWith|endsWith|indexOf)$/.test(n.expression.name.text) && str(n.arguments[0])) hit(n, [n.arguments[0].text]);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  };
  for (const file of files) scan(path.relative(ROOT, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8"), found);
  assert.deepEqual(found, [], "code matching translated text");
  assert.deepEqual(Object.keys(ALLOW).filter(k => !used.has(k)), [], "an allow-list entry that no longer matches anything: remove it");
  // the scan itself: the 0.19.144 Trade-button test, and the same text compared or searched for, are found
  const probe = []; scan("renderer/probe.js", 'const dead = !!why && !/No relay answers/.test(why); if (s === "Market offline") x(); if (m.includes("a FAST order may not be heard")) y();', probe);
  assert.equal(probe.length, 3, probe.join("\n"));
});

// 0.19.155: a safety reason must keep its reason. The phone's Russian and Ukrainian for KeyUses' "Common causes" said only
// "can lead to a repeat", losing what is repeated; every text about a one-time key must say "one-time key" in each language.
test("every text about a one-time key says one-time key in each language", () => {
  const WORD = { zh: /一次性/, ru: /одноразов/i, uk: /одноразов/i };
  for (const code of OTHERS) for (const [k, v] of Object.entries(I18N.catalog(code))) if (/one-time key/i.test(k))
    for (const s of (v && typeof v === "object" ? Object.values(v) : [v])) assert.match(s, WORD[code], code + ": " + k);
});

// 0.19.161: the short tables read at load that 0.19.141 to 0.19.144 did not reach: month names, Dexicon's single-word chips,
// miniMall's order states. The values stay English (compared, stored, sent); they are said in the app's language where drawn.
test("months, chips and order states are said in each language where drawn; the values stay English", () => {
  for (const c of OTHERS) require("../renderer/i18n/" + c + ".js");
  const inflight = require("../main/inflight.js"), NOW = new Date(2026, 10, 20, 12, 0).getTime(), JUL = new Date(2026, 6, 16, 9, 5).getTime();
  assert.equal(inflight.clock(JUL, NOW), "09:05 on 16 Jul", "English as before");
  const src = (f) => fs.readFileSync(path.join(R, f), "utf8"), app = src("app.js");
  const blockTime = new Function(app.match(/function clock\(t\) \{[^\n]*\}/)[0] + "\n" + app.slice(app.indexOf("function blockTime(t) {"), app.indexOf("\n}", app.indexOf("function blockTime(t) {")) + 2) + "; return blockTime;")();
  assert.equal(blockTime("Thu Jul 16 14:54:04 BST 2026"), "Jul 16, 2026, 14:54:04 BST", "English as before");
  try {
    for (const code of OTHERS) {
      I18N.set(code);
      for (const [i, m] of I18N.MONTHS.entries()) { assert.notEqual(I18N.t(m), m, code + " " + m); assert.ok(I18N.t(m) && !/[A-Za-z]{3}/.test(I18N.t(m)), code + ": " + I18N.t(m)); void i; }
      const said = inflight.clock(JUL, NOW, I18N.t);
      assert.ok(said.includes(I18N.t("Jul")) && said.includes("09:05") && said.includes("16") && !/ on |Jul/.test(said), code + ": " + said);
      const bt = blockTime("Thu Jul 16 14:54:04 BST 2026"); assert.ok(bt.includes(I18N.t("Jul")) && bt.includes("2026") && bt.includes("14:54:04 BST") && !/Jul/.test(bt), code + ": " + bt);
      for (const w of ["LIVE", "DONE", "FAILED", "REFUNDED", "LOST", "UNKNOWN", "WAITING", "BID", "ASK", "ENQUIRY", "PENDING", "PAID", "CONFIRMED", "SHIPPED", "DELIVERED", "UNDERPAID", "WRONG_TOKEN", "BAD_TOTAL", "UNCHECKED", "ALL", "SETTLING", "IN BLOCK", "CO-SIGNED"]) assert.notEqual(I18N.t(w), w, code + ": " + w);
    }
  } finally { I18N.set("en"); }
  // drawn through the catalog; the value under it unchanged
  assert.ok(app.includes('data-chip="${s}" aria-pressed="${shopFilter === s}">${th(s)}</button>') && app.includes('data-advance="${s}"${s === next ? "" : " disabled"}>${th(s)}</button>') && app.includes("${esc(t(s))}</span>`; }"), "miniMall: the state is translated where shown, the data value is the wire's");
  assert.ok(src("dexicon-ax.js").includes('<span class="dx-chip" data-tone="${it.tone}">${th(it.chip)}</span>') && src("dexicon-ui.js").includes('${th(fs.chip)}</span>') && src("dexicon-ui.js").includes("${esc(I18N.t(chip))}</span>"));
  assert.ok(/var MON = I18N\.MONTHS;/.test(src("mail.js")) && src("mail.js").includes('I18N.t("{day} {month} {year}"') && src("dexicon-ui.js").includes('month: I18N.t(I18N.MONTHS[d.getMonth()])'));
  const AX = require("../renderer/dexicon-ax.js"); assert.equal(AX.dealStatus({ status: "COMPLETE" }), "Complete");
});

// 0.19.162: the Terminal's completion descriptions, from the phone's own translated help (renderer/i18n/terminal.js)
test("Terminal help: the phone's words for the completion descriptions; names, parameters and values kept; the screens' catalogs untouched", () => {
  const src = fs.readFileSync(path.join(R, "i18n", "terminal.js"), "utf8"), rows = {};
  const J = require("../renderer/i18n.js"); for (const c of OTHERS) require("../renderer/i18n/" + c + ".js");
  const before = {}; for (const c of OTHERS) before[c] = Object.assign({}, J.catalog(c));
  const box = { I18N: { add: (code, e) => { rows[code] = e; } } }; new Function("I18N", src)(box.I18N);
  for (const c of OTHERS) assert.deepEqual(Object.keys(rows[c]).sort(), Object.keys(rows.zh).sort(), c + ": the same texts in each language");
  assert.ok(Object.keys(rows.zh).length >= 300, "the phone's help is brought over (" + Object.keys(rows.zh).length + ")");
  globalThis.TERM_HELP = require("../renderer/termhelp.js"); const TC = require("../renderer/termcomplete.js");
  const shown = new Set(); for (const c of Object.keys(TERM_HELP)) { shown.add(TC.commandBrief(c)); for (const it of TC.suggest(c + " ", c.length + 1).items) shown.add(it.desc); }
  const tok = (s) => s.match(/[A-Za-z0-9_]+:|0x[0-9A-Fa-f.]+|Mx[0-9A-Za-z.]*|\b\d[\d.,]*\b/g) || [];
  for (const [en, zh] of Object.entries(rows.zh)) {
    assert.ok(shown.has(en), "a text the completion actually shows: " + en.slice(0, 80));
    for (const c of OTHERS) {
      const v = rows[c][en]; assert.ok(typeof v === "string" && v.trim() && !/[<>]/.test(v), c + ": " + en);
      for (const x of tok(en)) assert.ok(v.includes(x), c + ": " + JSON.stringify(x) + " kept in " + JSON.stringify(v).slice(0, 120));
      assert.ok(!Object.hasOwn(before[c], en) || before[c][en] === v, c + ": a text of the screens is not overridden: " + en);
      assert.ok(!/MxUSDT/i.test(v), "MxUSD");
    }
    void zh;
  }
  require("../renderer/i18n/terminal.js");
  J.set("ru"); assert.equal(J.t("Search for coins"), rows.ru["Search for coins"]); assert.notEqual(J.t("Search for coins"), "Search for coins"); J.set("en");
  const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  assert.ok(app.includes('<span class="termsug__d">${esc(I18N.t(it.desc))}</span>'), "the description is drawn through the catalog");
  assert.ok(html.indexOf('<script src="i18n/terminal.js">') > html.indexOf('<script src="i18n/uk.js">') && html.indexOf('<script src="i18n/terminal.js">') < html.indexOf('<script src="i18n/start.js">'));
});
