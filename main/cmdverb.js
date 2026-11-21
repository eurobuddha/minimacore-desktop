/*
 * cmdverb.js: which command the node runs for a piece of command text. Ported unchanged (below this header) from the
 * released desktop's main/cmdverb.js (0.18.174 and 0.18.184, security/backport-2026-11-20 d0260c91ea325f6c442ef77646372a066993af24)
 * in 0.19.187. Every verb check in the main process goes through here: the secret-command gate (main/seedgate.js), and
 * the readers of command text after it (the signing queue, the send pin, the coin guard, the RPC timeout, the restore
 * checks, the Dexicon bridge).
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
const fold = (s) => String(s).replace(/\u0130/g, "i").toUpperCase().toLowerCase();   // Kelvin sign → k, long s → s; İ → i (0.19.223: a Turkish JVM folds it so)

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
/** The text the parameter regexes read: quotes dropped, " : " closed up (the fast path's key : value).
 *  NOT in the released file (0.19.192 here): a "quoted" first word is ended by its closing quote, so `"txninput"id:a` reads
 *  as `txninput id:a`, as the node's fast path reads it (released: `txninputid:a`, and its id: was not seen). */
// An empty quoted value (`password:""`) is kept as "" (0.19.250): dropped, it left `password:` followed by a space, which the
// closing-up of " : " then joined to the next name (`password:action:wipekeys`), and that name was no longer read.
function paramsText(part) { return jtrim(jtrim(String(part)).replace(/^"([^"]*)"/, "$1 ").replace(/""/g, "\u0000").replace(/"/g, "").replace(/\u0000/g, '"" ')).replace(/[ \t]*:[ \t]*/g, ":"); }

/** The parameter names of ONE command, in order, repeats kept (0.18.184): every top-level `name:` after the verb. The node
 *  keeps the LAST of a repeated name. Read from namesText since 0.19.218 (released 0.18.189 / 0.18.197). */
function paramNames(part) {
  const rest = namesText(part).replace(/^\S+/, "");
  return [...rest.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+):/g)].map(m => fold(m[1]));
}
/** The text the parameter NAMES are read from (released 0.18.189 / 0.18.197, ported 0.19.218): quotes become spaces (a name
 *  glued after a closing quote, `action:"list"action:genkey`, is its own name, as the node reads it), whatever stands inside
 *  {…} or […] is blanked (a key in a state's JSON is not a parameter), a { or [ inside a quoted value opens nothing, and
 *  " : " is closed up. Values that need quotes are not read here. */
function namesText(part) {
  const s = jtrim(String(part));
  let out = "", depth = 0, quoted = false, opened = -1;
  for (const ch of s) {
    // an empty quoted value stays "" (0.19.250): two spaces after a colon were closed up into the next name, which hid it
    if (ch === '"') { if (!quoted) opened = out.length; else if (depth === 0 && out.length === opened + 1) out += '""'; quoted = !quoted; out += " "; continue; }
    if (quoted) { out += depth > 0 ? " " : ch; continue; }
    if (ch === "{" || ch === "[") { depth++; out += ch; continue; }
    if ((ch === "}" || ch === "]") && depth > 0) { depth--; out += ch; continue; }
    out += depth > 0 ? " " : ch;
  }
  return out.replace(/[ \t]*:[ \t]*/g, ":");
}
/** The LAST top-level value of `name` in ONE command (as the node keeps it), or null (released 0.18.196). */
function paramValue(part, name) {
  const all = [...namesText(part).matchAll(new RegExp("(?:^|\\s)" + name + ":(\\S*)", "gi"))];
  return all.length ? all[all.length - 1][1] : null;
}
/** The names that appear more than once in ONE command (lower-cased). */
function repeated(part, only) {
  const seen = new Set(), twice = new Set();
  for (const n of paramNames(part)) { if (only && !only.includes(n)) continue; if (seen.has(n)) twice.add(n); seen.add(n); }
  return [...twice];
}

/**
 * oneCommand(text) (0.19.194, released 0.18.177): a command the APP builds is one command. The node splits a text on EVERY
 * ";", even inside quotes and JSON, so a ";" carried in by a pasted seed, a peer's media ref, a password or a coin's state on
 * the chain started a second command of the sender's choosing. Every builder outside the Terminal and the vendored engines
 * (Mail, miniMall, Chat, Vestr, the Web Wallet, Future Cash Next) sends through this; it throws, and nothing is sent.
 * It lives here, not in main/rpc.js as in the released desktop, so that a module whose tests stand in for rpc.js keeps it. The
 * Terminal's own chains go through mcd:cmd; the AtomiX, PandaPools, Dexicon and casino engines chain txnbasics;txnpost
 * of their own making.
 */
function oneCommand(command) {
  if (String(command).includes(";")) throw new Error("This command holds \";\", which would start a second command. Nothing was sent.");
  return command;
}
module.exports = { jtrim, fold, parts, verbs, is, beginsAs, paramsText, namesText, paramNames, repeated, paramValue, oneCommand };
