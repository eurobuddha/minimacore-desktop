// For the tests that pin a screen's English words in the renderer's SOURCE: the source as it read before its text
// was wrapped for translation. Only a call with a literal key and no params is unwrapped (the key is the English
// text, so nothing is lost): `${th("Save")}` -> Save, `" + th("Save") + "` -> Save, t("Save") and N_("Save") -> "Save".
// A call with params stays as written. Code lifted from this view runs the same in English.
"use strict";
const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const html = (json) => JSON.parse('"' + json + '"').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plain(src) {
  return String(src)
    .replace(new RegExp("\\$\\{(?:I18N\\.)?th\\(" + STR + "\\)\\}", "g"), (_m, k) => html(k).replace(/\n/g, "\\n"))
    .replace(new RegExp("([\"']) \\+ (?:I18N\\.)?th\\(" + STR + "\\) \\+ \\1", "g"), (_m, _q, k) => html(k).replace(/\n/g, "\\n"))
    .replace(new RegExp("\\b(?:I18N\\.)?(?:th?|N_)\\(" + STR + "\\)", "g"), (_m, k) => '"' + k + '"');
}
module.exports = { plain };
