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

module.exports = { createNodeLog, DEFAULT_MAX_BYTES };
