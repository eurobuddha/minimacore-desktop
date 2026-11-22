// Source scans of the desktop-authored main/*.js and renderer/*.js (never the vendored engines). Two accidents are
// caught here: code typed after a `//` comment on the same line (0.19.194 lost Future Cash's `dir`, 0.19.212 its
// signCap and notify actions, both silently), and a Future Cash action the screen calls that main.js does not route.
// main.js cannot be loaded without Electron, so it is read as text.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const files = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(".js")).map(f => dir + "/" + f);

/** The text of the first `//` comment on a line that has code before it ("" when none). Strings and block comments are skipped. */
function trailingComment(ln) {
  let q = null;
  for (let j = 0; j < ln.length; j++) {
    const c = ln[j];
    if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "/" && ln[j + 1] === "/") return ln.slice(0, j).trim() ? ln.slice(j + 2) : "";
    if (c === "/" && ln[j + 1] === "*") { const e = ln.indexOf("*/", j + 2); if (e < 0) return ""; j = e + 1; }
  }
  return "";
}
/** Comment text that reads as code: an option `k: () =>`, `k: v =>`, a call closed with `,` / `;`, a closer, a declaration. */
const looksLikeCode = (t) => /\b[A-Za-z_$][\w$]*\s*:\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(t) || /\)\s*[,;]\s*$/.test(t) || /[}\]]\s*\)\s*;?\s*$/.test(t) || /\b(const|let|var|return)\s+[\w$]+\s*=/.test(t);
// Known false positives, by their exact line content (a regex literal's `//`, a type note), never by line number.
const ALLOWED = new Set([
  "main/dexicon-room.js\0" + "  const page = frames.filter(f => { try { return /^dxroom:\\/\\/exchange\\//.test(String(f.url)); } catch (e) { return false; } });",
  "renderer/termcomplete.js\0" + "  const DOCS_CACHE = new Map(); // command -> Map(param -> {required, desc})",
]);
function scan(rel, text) {
  const hits = [];
  text.split("\n").forEach((ln, i) => { const t = trailingComment(ln); if (t && looksLikeCode(t) && !ALLOWED.has(rel + "\0" + ln)) hits.push(rel + ":" + (i + 1) + ": " + ln.trim()); });
  return hits;
}

test("no code hides after a // comment on the same line in main/*.js or renderer/*.js", () => {
  const hits = [].concat(...files("main").concat(files("renderer")).map(f => scan(f, fs.readFileSync(path.join(ROOT, f), "utf8"))));
  assert.deepEqual(hits, []);
});

test("the scan itself: it finds the two lines that broke Future Cash, and lets an ordinary trailing note pass", () => {
  assert.equal(scan("x.js", 'run: (c) => go(c),   // ONE command each (0.19.194): it sends no chain dir: () => app.getPath("userData"),').length, 1);
  assert.equal(scan("x.js", 'handedOut: (a) => f(a),   // read only signCap: (v) => futurecash.setSignCap(v), notify: (on) => futurecash.setFlag("notify", on === true),').length, 1);
  assert.equal(scan("x.js", 'const a = 1;   // the first one (see b)').length, 0);
  assert.equal(scan("x.js", 'const u = "http://x/y";').length, 0);
});

test("every Future Cash action the screen calls is routed by main.js FC_OPS", () => {
  const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8");
  const at = main.indexOf("const FC_OPS = {"); assert.ok(at > 0, "FC_OPS found");
  // the object literal, to its matching brace; comments dropped so a swallowed key does not count
  let depth = 0, end = at + "const FC_OPS = ".length;
  for (; end < main.length; end++) { const c = main[end]; if (c === "{") depth++; else if (c === "}" && --depth === 0) break; }
  const body = main.slice(at, end).split("\n").map(ln => { const t = trailingComment(ln); return t ? ln.slice(0, ln.length - t.length - 2) : ln; }).join("\n");
  const keys = new Set([...body.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*\(/g)].map(m => m[1]));
  const screen = fs.readFileSync(path.join(ROOT, "renderer/futurecash.js"), "utf8");
  const ops = [...new Set([...screen.matchAll(/api\.fc\(\s*"([A-Za-z_$][\w$]*)"/g)].map(m => m[1]))];
  assert.ok(ops.length >= 20, "the screen's calls were read (" + ops.length + ")");
  assert.deepEqual(ops.filter(op => !keys.has(op)), [], "actions the screen calls that FC_OPS lacks");
  assert.ok(keys.has("notify") && keys.has("signCap"), "the notify switch and the signature limit are routed");
});
