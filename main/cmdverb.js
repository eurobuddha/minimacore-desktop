/*
 * cmdverb.js — which command the node runs for a piece of command text (0.18.174). Every verb check in the main process
 * goes through here: the secret-command gate (main/cmdgate.js), the beacon-dust send pin (main/sendpin.js, main.js),
 * the RPC timeout (main/rpc.js).
 *
 * The node does not read a command the way a /^send\s/ test does. CMDHandler trims the text the Java way (every char
 * U+0000 to U+0020 at both ends), runMultiCommand splits on every ";", and getCommand reads the first token two ways:
 * a fast path where ":" is a token of its own and a "quoted" first word is the command, and a slow path that drops
 * quotes. So `"vault"`, U+0001 + `vault`, `va"ul"t`, `"send" amount:1 …` and `keys action :genkey` are all run as written
 * by the node, and slipped past the old checks. verbs() OVER-approximates both readings (lower-cased the way Java's
 * equalsIgnoreCase folds, JS whitespace wider than Java's); a gate built on it may block a text the node would refuse
 * anyway, never the reverse.
 */
const jtrim = (s) => String(s).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");   // Java String.trim()
const fold = (s) => String(s).toUpperCase().toLowerCase();                          // Kelvin sign → k, long s → s

/** The commands of a text, as the node splits them (every ";", empty pieces dropped). */
function parts(command) { return String(command == null ? "" : command).split(";").map(jtrim).filter(Boolean); }

/** Every verb the node may read for ONE command (no ";"). */
function verbs(part) {
  const p = jtrim(part), out = new Set();
  const f = /"([^"]*)"|([^\s"]+)/.exec(p.replace(/:/g, " : "));            // fast path: ":" its own token, a quoted first word
  if (f) out.add(fold(jtrim(f[1] != null ? f[1] : f[2])));
  const slow = jtrim(p.replace(/"/g, ""));                                   // slow path: quotes dropped
  out.add(fold(slow.split(/[\u0000- \s:]/)[0] || ""));
  out.delete("");
  return [...out];
}
/** Is this ONE command run as `verb`? */
function is(part, verb) { return verbs(part).includes(verb); }
/** Does this ONE command begin with `prefix`, however it is quoted or trimmed (for gates: over-blocks on purpose)? */
function beginsAs(part, prefix) { return verbs(part).some(v => v.startsWith(prefix)) || fold(jtrim(String(part).replace(/"/g, ""))).startsWith(prefix); }
/** The text the parameter regexes read: quotes dropped, " : " closed up (the fast path's key : value). */
function paramsText(part) { return jtrim(String(part).replace(/"/g, "")).replace(/[ \t]*:[ \t]*/g, ":"); }

/** The parameter names of ONE command, in order, repeats kept (0.18.184): every top-level `name:` after the verb, read
 *  from paramsText (quotes dropped, " : " closed up). The node keeps the LAST of a repeated name. */
function paramNames(part) {
  const rest = namesText(part).replace(/^\S+/, "");
  return [...rest.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+):/g)].map(m => fold(m[1]));
}
/** The text the parameter NAMES are read from (0.18.189): quotes become spaces (a name glued after a closing quote,
 *  `action:"list"action:genkey`, is its own name, as the node reads it), whatever stands inside {…} or […] is blanked
 *  (a key in a state's JSON is not a parameter), and " : " is closed up. Values that need quotes are not read here. */
function namesText(part) {
  const s = jtrim(String(part)).replace(/"/g, " ");
  let out = "", depth = 0;
  for (const ch of s) {
    if (ch === "{" || ch === "[") { depth++; out += ch; continue; }
    if ((ch === "}" || ch === "]") && depth > 0) { depth--; out += ch; continue; }
    out += depth > 0 ? " " : ch;
  }
  return out.replace(/[ \t]*:[ \t]*/g, ":");
}
/** The names that appear more than once in ONE command (lower-cased). */
function repeated(part, only) {
  const seen = new Set(), twice = new Set();
  for (const n of paramNames(part)) { if (only && !only.includes(n)) continue; if (seen.has(n)) twice.add(n); seen.add(n); }
  return [...twice];
}

module.exports = { jtrim, fold, parts, verbs, is, beginsAs, paramsText, namesText, paramNames, repeated };
