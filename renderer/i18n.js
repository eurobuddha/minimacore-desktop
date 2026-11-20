/*
 * i18n.js: the four languages of Pandamonium (English, 简体中文, Русский, Українська), for the window and the main process.
 *
 * THE KEY IS THE ENGLISH TEXT. t("Send") shows "Send" in English and the catalog's value in another language; a key
 * a catalog does not hold shows its English, never a blank and never a key name. Catalogs are renderer/i18n/<code>.js,
 * loaded by script tags in the window and by require() in the main process (main/lang.js).
 *
 *   t(key, params)    plain text, for textContent, toasts, dialogs, attributes set as properties
 *   th(key, params)   the same, HTML-escaped as a whole (params included): for text put into markup
 *   tr(key, html)     the translated text escaped, the params inserted AS GIVEN: only for values the caller has
 *                     already escaped or built as markup (what the template inserted before it was translated)
 *   N_(key)           marks a key held in a table and translated where it is shown: returns the key unchanged
 *   L_(key)           a text fixed while a script loads (a constant, a table of help texts): a String that reads as its
 *                     translation whenever it is shown (in a template, a +, textContent, esc()), in the language of that moment
 *
 * Placeholders are named: "{n} coins". A catalog value may be an object of plural forms ({ one, few, many, other }),
 * chosen by Intl.PluralRules from params.n. NUMBERS ARE NEVER FORMATTED HERE: an amount is inserted as the string the
 * caller passes, exactly. Translated text is data: it is never parsed as HTML (scripts/i18n-test.cjs also refuses a
 * catalog value that carries "<", ">", or a quote or ampersand its English does not).
 */
(function (root) {
  "use strict";
  const CODES = ["en", "zh", "ru", "uk"];
  const NAMES = { en: "English", zh: "简体中文", ru: "Русский", uk: "Українська" };   // each in its own language, as the phone's chooser
  const TAGS = { en: "en", zh: "zh-Hans", ru: "ru", uk: "uk" };
  const CAT = { en: {} }, REVIEW = {}, SAME = {}, RULES = {}, listeners = [];
  let lang = "en";

  /** A system or browser language tag to one of the four: any Chinese is 简体中文 (the only Chinese the phone has); anything else unknown is English. */
  function pick(tag) {
    const s = String(tag == null ? "" : tag).toLowerCase();
    return s === "zh" || s.startsWith("zh-") || s.startsWith("zh_") ? "zh" : /^ru([-_]|$)/.test(s) ? "ru" : /^uk([-_]|$)/.test(s) ? "uk" : "en";
  }
  const supported = (code) => CODES.includes(code);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fill = (s, p, f) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (own(p, k) ? f(p[k]) : m)) : s);
  const str = (v) => String(v == null ? "" : v);

  /** The text for a key in the current language: the catalog's, else English's own plural entry, else the key itself. */
  function text(key, p, use) {
    key = String(key); const lang = use || current();   // `use`: a given language whatever is on show (tIn: a log line stays English)
    let v = lang !== "en" && CAT[lang] && own(CAT[lang], key) ? CAT[lang][key] : own(CAT.en, key) ? CAT.en[key] : key, code = v === key || !CAT[lang] || !own(CAT[lang], key) ? "en" : lang;
    if (v && typeof v === "object") {
      let form = "other";
      try { form = (RULES[code] || (RULES[code] = new Intl.PluralRules(TAGS[code]))).select(Number(p && p.n)); } catch (e) { /* no Intl: "other" */ }
      v = own(v, form) ? v[form] : own(v, "other") ? v.other : key;
    }
    return typeof v === "string" && v ? v : key;
  }
  const current = () => lang;
  const t = (key, p) => fill(text(key, p), p, str);
  /** t() in one given language, whatever language is on show. */
  const tIn = (code) => (key, p) => fill(text(key, p, supported(code) ? code : "en"), p, str);
  const th = (key, p) => fill(esc(text(key, p)), p, esc);
  const tr = (key, p) => fill(esc(text(key, p)), p, str);
  const N_ = (key) => key;
  /** The short month names as the app writes them in English: catalog keys, translated where a date is shown
   *  (t("{day} {month}") and its variants put day, month and year in each language's order). */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** The English plural "s" for a count, and nothing in any other language: for the few sentences still built around
   *  an English noun + "s" (their translations are worded so that the count needs no ending: "orders: 3"). */
  const s = (n) => (lang === "en" && Number(n) !== 1 ? "s" : "");
  /** A String object over the English text whose toString / valueOf give the text in the language on show at that moment. It is an
   *  object: never compare one with === (the code that holds them only shows them). */
  class Later extends String { toString() { return t(String.prototype.toString.call(this)); } valueOf() { return this.toString(); } }
  const L_ = (key) => new Later(key);

  /** A catalog, or more of one. meta.review: keys translated for the desktop (no phone text existed), for a native speaker to check.
   *  meta.same: keys whose text is rightly the same as the English (a name, a unit). */
  function add(code, entries, meta) {
    if (!supported(code)) throw new Error("i18n: unknown language " + code);
    CAT[code] = Object.assign(CAT[code] || {}, entries);
    if (meta && meta.review) REVIEW[code] = (REVIEW[code] || []).concat(meta.review);
    if (meta && meta.same) SAME[code] = (SAME[code] || []).concat(meta.same);
  }
  /** Switch language. False for a language with no catalog loaded (the picker never offers one). */
  function set(code) {
    if (!supported(code) || !CAT[code]) return false;
    if (code === lang) return true;
    lang = code;
    if (root.document && root.document.documentElement && root.document.documentElement.setAttribute) root.document.documentElement.setAttribute("lang", TAGS[code]);
    for (const fn of listeners.slice()) { try { fn(code); } catch (e) { /* one screen's repaint must not stop the others */ } }
    return true;
  }
  /** The page's own fixed text. Two ways in: data-i18n="key" on an element (its text), and the PAGE table
   *  (renderer/i18n/start.js): [selector, attribute or "" for the text, key], for the markup of index.html as it stands. */
  const PAGE = [];
  function apply(scope) {
    if (!scope || !scope.querySelectorAll) return;
    for (const n of scope.querySelectorAll("[data-i18n]")) n.textContent = t(n.getAttribute("data-i18n"));
    for (const [sel, attr, key] of PAGE) for (const n of scope.querySelectorAll(sel)) { if (attr) n.setAttribute(attr, t(key)); else n.textContent = t(key); }
  }

  const I18N = { CODES, NAMES, TAGS, PAGE, MONTHS, pick, supported, add, set, apply, t, th, tr, tIn, N_, L_, s,
    lang: () => lang, tag: () => TAGS[lang],
    languages: () => CODES.filter(c => CAT[c]),                 // the languages that have a catalog, in the phone's order
    onChange: (fn) => { listeners.push(fn); },
    catalog: (code) => CAT[code] || null, review: (code) => (REVIEW[code] || []).slice(), same: (code) => (SAME[code] || []).slice() };

  root.I18N = I18N; root.t = t; root.th = th; root.tr = tr; root.N_ = N_; root.L_ = L_;
  if (typeof module !== "undefined" && module.exports) module.exports = I18N;
})(typeof window !== "undefined" ? window : globalThis);
