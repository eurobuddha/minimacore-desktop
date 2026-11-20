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

module.exports = { jtrim, fold, parts, verbs, is, beginsAs, paramsText };
