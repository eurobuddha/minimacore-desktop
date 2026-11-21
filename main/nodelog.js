/*
 * nodelog.js — the node's stdout/stderr, on disk.
 *
 * node-manager keeps the last 800 lines in RAM for the Logs view and nothing else. On 15 Sep 2026 the node
 * wrote "Script NOT found for address : 0x0CDCD6…" some forty-five times over two hours while every AtomiX
 * claim was refused; by the time anyone looked, the ring had rolled and the only diagnostic was gone. A
 * multi-hour reconstruction from txnlist and the chain followed. This keeps every redacted line in
 * <userData>/node.log, rotating to node.log.1 at MAX_BYTES, so the last day or two of node output is always
 * one file away. Append-only, best-effort, never throws into the caller: logging must not take the node down.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** createNodeLog(dir, {maxBytes}) → { append(line), file } — dir is created on first append. */
function createNodeLog(dir, opts) {
  const maxBytes = (opts && opts.maxBytes) || DEFAULT_MAX_BYTES;
  const file = path.join(dir, "node.log"), older = path.join(dir, "node.log.1");
  let size = -1;   // unknown until the first append; then tracked so a stat is not needed per line
  function rotateIfNeeded(incoming) {
    if (size < 0) { try { size = fs.statSync(file).size; } catch (e) { size = 0; } }
    if (size + incoming <= maxBytes) return;
    try { fs.renameSync(file, older); } catch (e) { /* first rotation with no file, or a race — start fresh */ }
    size = 0;
  }
  function append(line) {
    try {
      const text = new Date().toISOString() + " " + String(line).replace(/\r?\n$/, "") + "\n";
      const bytes = Buffer.byteLength(text);
      if (size < 0) fs.mkdirSync(dir, { recursive: true });
      rotateIfNeeded(bytes);
      fs.appendFileSync(file, text);
      size += bytes;
    } catch (e) { /* best-effort: a full or unwritable disk must not stop the node */ }
  }
  return { append, file, older };
}

/**
 * scrub(line, secret): what no log line may carry, taken out at the one place every line passes (node-manager log())
 * and again on the way into a saved file (0.19.121):
 *  - the RPC secret, wherever it stands (the node prints its own start parameters, -rpcpassword among them). Only a
 *    secret of 8 characters or more is looked for, so a short or empty value can never blank the log;
 *  - a seed phrase: phrase:"…", "phrase":"…" as a reply's JSON has it, and phrase: followed by bare words (up to 24;
 *    a word that is the next parameter's name, as in "host:", ends it, so the rest of the line stays);
 *  - a private key after privatekey:;
 *  - the "seed", "seedphrase", "mnemonic" and "privatekey" fields of a reply's JSON (0.19.172: `vault` answers with the
 *    wallet's seed as "seed", which the phrase rule did not cover; 0.19.175: the other two names, as the released 0.18.169);
 *  - the bidirectional controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F): a line a remote party wrote
 *    must not be able to reorder what is shown beside it.
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
function scrub(line, secret) {
  let l = String(line).replace(BIDI, "");
  if (typeof secret === "string" && secret.length >= 8) l = l.split(secret).join("•••");
  // ":" with spaces around it is read as the node reads it (0.19.226: `phrase : "…"`, `privatekey : 0x…`), and a reply's
  // "seedrandom" field (the value AtomiX's ETH key is made from) is redacted with the others
  return l.replace(/phrase[ \t]*:[ \t]*"[^"]*"/g, 'phrase:"•••"')
    .replace(/phrase(?::|[ \t]+:[ \t]*)[A-Za-z]+\b(?![ \t]*:)(?: [A-Za-z]+\b(?![ \t]*:)){0,23}/g, "phrase:•••")   // "phrase: none given" (prose) is not one
    .replace(/privatekey[ \t]*:[ \t]*"?0x[0-9A-Fa-f]+"?/gi, "privatekey:•••")
    .replace(/"(phrase|seed|seedphrase|mnemonic|privatekey|seedrandom)"\s*:\s*"[^"]*"/gi, (m, k) => '"' + k + '":"•••"');   // any letter case (0.19.197: "phrase" too, as released 0.18.179)   // any letter case (0.19.197: "phrase" too, as released 0.18.179)
}

/**
 * The text the Logs screen hands over for "Save to file" (0.19.116), as it goes to disk: every line passes the Parlons
 * redaction again (a message line keeps who and that, never the message's words), whatever the screen sent, and the
 * whole is bounded. The screen only ever holds redacted lines; this does not rely on it.
 */
const SAVE_MAX = 2 * 1024 * 1024;
function forFile(text, secret) {
  const { redact } = require("./parlons-notify");
  return String(text == null ? "" : text).slice(-SAVE_MAX).split(/\r?\n/).map(l => scrub(redact(l), secret)).join("\n") + "\n";
}

/** What Save to file writes (0.19.221): the node log FILES on disk (node.log.1 then node.log), never text from the window.
 *  log = createNodeLog's { file, older }. A file that cannot be read is left out. */
function fileText(log) {
  let text = "";
  for (const f of [log && log.older, log && log.file]) { if (!f) continue; try { text += fs.readFileSync(f, "utf8"); } catch (e) { /* not there yet */ } }
  return text;
}
module.exports = { createNodeLog, DEFAULT_MAX_BYTES, forFile, fileText, SAVE_MAX, scrub };
