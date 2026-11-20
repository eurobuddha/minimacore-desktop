// Languages (0.19.140+): the helper, the catalogs and the chooser. The key of a text is its English, so English can
// never be missing; what this file keeps true is that the other three languages are WHOLE and SAFE:
//   - every key the code translates (a literal first argument of t / th / tr / N_, and every data-i18n in index.html)
//     is in zh, ru and uk, with the same placeholders, not empty, and not left as its English unless listed as "same";
//   - a translated value is data: no "<" or ">", and a quote or ampersand only where its English has one;
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
        for (const ch of ['"', "&", "`"]) if (s.includes(ch) && !key.includes(ch)) bad.push("a " + ch + " its English does not have: " + JSON.stringify(s));
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
