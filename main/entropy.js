/*
 * entropy.js — what Entropy may ask the node (main process). After Pandamonium's Entropy (apks/base integrated/entropy
 * RollEngine.java): two commands and nothing else. `random` gives the node's own random value; `hash data:<hex>` is the
 * node's SHA3 of (that value ++ the app's own random value), the same hash the casino contract proves on chain.
 *
 * THE VALUES ARE SEED MATERIAL: whoever holds the two inputs of every roll can recompute the phrase. They are handed to
 * the node (as the original hands them) and back to the screen, and that is all: nothing here is logged, kept or
 * written anywhere. rpcCall logs no command and no reply.
 */
"use strict";
const HEX = /^0x[0-9a-fA-F]{2,512}$/;
/** The node command for one ask, or null when the kind is unknown or the value is not plain hex. */
function command(kind, arg) {
  if (kind === "random") return "random";
  if (kind === "hash") return typeof arg === "string" && HEX.test(arg) ? "hash data:" + arg : null;
  return null;
}
/** One ask. run(command) → the node's reply (through rpcCall). → the hex value the node gave, or "" when it gave none of that shape. */
async function ask(kind, arg, run) {
  const c = command(kind, arg);
  if (!c) throw new Error("Entropy asks the node only for a random value or a hash of plain hex.");
  const j = await run(c), v = j && j.status === true && j.response ? j.response[kind === "random" ? "random" : "hash"] : "";
  return typeof v === "string" && HEX.test(v) ? v : "";
}
module.exports = { command, ask };
