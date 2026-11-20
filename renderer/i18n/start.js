// The language to start in: the one saved by the main process (window.mcd.lang, read by the preload), else the
// system's when it is one of the four, else English. Runs after the catalogs and before every screen script, so a
// table built while a script loads is already in that language; then the page's own fixed text is set.
(function () {
  "use strict";
  const saved = window.mcd && window.mcd.lang;
  I18N.set(typeof saved === "string" && I18N.supported(saved) ? saved : I18N.pick(typeof navigator !== "undefined" && navigator.language));
  I18N.apply(document);
})();
