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
 * (0.18.153, from 0.19.121):
 *  - the RPC secret, wherever it stands (the node prints its own start parameters, -rpcpassword among them). Only a
 *    secret of 8 characters or more is looked for, so a short or empty value can never blank the log;
 *  - a seed phrase: phrase:"…", "phrase":"…" as a reply's JSON has it (and "seed", "seedphrase", "mnemonic", 0.18.169; "privatekey", any case, 0.18.179), and phrase: followed by bare words (up to 24;
 *    a word that is the next parameter's name, as in "host:", ends it, so the rest of the line stays);
 *  - a private key after privatekey:;
 *  - the bidirectional controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F): a line a remote party wrote
 *    must not be able to reorder what is shown beside it.
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
function scrub(line, secret) {
  let l = String(line).replace(BIDI, "");
  if (typeof secret === "string" && secret.length >= 8) l = l.split(secret).join("•••");
  return l.replace(/phrase:"[^"]*"/g, 'phrase:"•••"').replace(/"(phrase|seed|seedphrase|mnemonic|privatekey)"\s*:\s*"[^"]*"/gi, (m, k) => '"' + k + '":"•••"')
    .replace(/phrase:[A-Za-z]+\b(?!:)(?: [A-Za-z]+\b(?!:)){0,23}/g, "phrase:•••")
    .replace(/privatekey:0x[0-9A-Fa-f]+/g, "privatekey:•••")
    .replace(/\b(password|confirm|seed)[ \t]*:[ \t]*(?:"[^"]*"|[^\s"]+)/gi, "$1:•••");   // a command's password:, confirm:, seed: (0.18.222)
}

module.exports = { createNodeLog, DEFAULT_MAX_BYTES, scrub };
