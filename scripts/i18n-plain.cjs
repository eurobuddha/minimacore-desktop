// For the tests that pin a screen's English words in the renderer's SOURCE: the source as it read before its text
// was wrapped for translation. Only a call with a literal key and no params is unwrapped (the key is the English
// text, so nothing is lost): `${th("Save")}` -> Save, `" + th("Save") + "` -> Save, t("Save") and N_("Save") -> "Save".
// A call with params stays as written. Code lifted from this view runs the same in English.
"use strict";
require("../renderer/i18n.js");   // code lifted from this view still calls t(), th(), tr() where a text carries values: the helpers are global, as in the window
const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const html = (json) => JSON.parse('"' + json + '"').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plain(src) {
  return String(src)
    .replace(new RegExp("\\$\\{(?:I18N\\.)?th\\(" + STR + "\\)\\}", "g"), (_m, k) => html(k).replace(/\n/g, "\\n"))
    .replace(new RegExp("([\"']) \\+ (?:I18N\\.)?th\\(" + STR + "\\) \\+ \\1", "g"), (_m, q, k) => html(k).replace(/\n/g, "\\n").split(q).join("\\" + q))   // inside a quoted string: its own quote stays escaped
    .replace(new RegExp("\\b(?:I18N\\.)?(?:th?|N_|L_)\\(" + STR + "\\)", "g"), (_m, k) => '"' + k + '"');
}
/** For a test that runs a renderer script in its own vm context: the helpers the window would have. */
const globals = () => { const I18N = require("../renderer/i18n.js"); return { I18N, t: I18N.t, th: I18N.th, tr: I18N.tr, N_: I18N.N_, L_: I18N.L_ }; };
module.exports = { plain, globals };
