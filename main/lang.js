/*
 * lang.js: the app's language in the main process. The same helper and the same catalogs as the window
 * (renderer/i18n.js, renderer/i18n/<code>.js), so a dialog, a menu or a notice made here uses the words the screens use.
 * The saved choice is config "language" ("" = follow the system when it is one of the four, else English).
 * No Electron here: main.js passes the saved value and the system's language in.
 */
const I18N = require("../renderer/i18n.js");
// A catalog that cannot be loaded (a broken file) must not stop the main process: that language is simply not offered
// (resolve() falls back to English, set() refuses it) and the reason is said once on stderr.
const broken = [];
for (const code of ["en", "zh", "ru", "uk"]) {
  try { require("../renderer/i18n/" + code + ".js"); }
  catch (e) { broken.push(code); console.error("[lang] the " + code + " catalog could not be loaded, so it is not offered: " + ((e && e.message) || e)); }
}

/** The language to run in: the saved one if it is one of the four, else the system's, else English. */
function resolve(saved, system) { const c = I18N.supported(saved) ? saved : I18N.pick(system); return I18N.catalog(c) ? c : "en"; }
function init(saved, system) { const c = resolve(saved, system); I18N.set(c); return c; }
/** A language picked in the window: true when it is one of the four with a catalog (and now current). */
function set(code) { return typeof code === "string" && I18N.set(code); }

module.exports = { init, set, resolve, current: I18N.lang, t: I18N.t, I18N, broken };
