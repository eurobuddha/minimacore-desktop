/*
 * entropy.js — what Entropy may ask the node (main process). After Pandamonium's Entropy (apks/base integrated/entropy
 * RollEngine.java): two commands and nothing else. `random` gives the node's own random value; `hash data:<hex>` is the
 * node's SHA3 of (that value ++ the app's own random value), the same hash the casino contract proves on chain.
 *
 * THE NODE DOES NOT DECIDE A DIE FACE (0.19.132). The original takes the node's word for the hash, so a node that
 * answers `hash` with a value of its choosing chooses the face. Here the hash is worked out in this process first:
 * Minima's `hash data:0x…` is SHA3-256 of the raw bytes (core `commands/base/hash.java`: type defaults to "sha3",
 * `Crypto.hashData` = BouncyCastle SHA3Digest(256); the same digest main/keyuses.js derives addresses with, pinned by
 * its golden vectors). The node's answer is passed on only when it IS that digest; anything else is "" and the roll
 * is thrown away by the screen. `random` is passed on only as 32 bytes of hex (the command's default size), and the
 * value hashed is exactly 64 bytes (the node's 32 ++ the device's 32), so a short or empty node value can never
 * shorten what the device adds.
 *
 * THE VALUES ARE SEED MATERIAL: whoever holds the two inputs of every roll can recompute the phrase. They are handed to
 * the node (as the original hands them) and back to the screen, and that is all: nothing here is logged, kept or
 * written anywhere. rpcCall logs no command and no reply.
 */
"use strict";
const crypto = require("crypto");
const RANDOM = /^0x[0-9a-fA-F]{64}$/, INPUT = /^0x[0-9a-fA-F]{128}$/;
/** SHA3-256 of the bytes a 0x hex string spells, as 0x lower-case hex: what a truthful node answers to `hash data:`. */
const sha3 = (hex) => "0x" + crypto.createHash("sha3-256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
/** The node command for one ask, or null when the kind is unknown or the value is not the 64 bytes of plain hex a roll hashes. */
function command(kind, arg) {
  if (kind === "random") return "random";
  if (kind === "hash") return typeof arg === "string" && INPUT.test(arg) ? "hash data:" + arg : null;
  return null;
}
/**
 * One ask. run(command) → the node's reply (through rpcCall).
 * random → the node's 32 bytes as 0x hex, or "" when it gave anything else.
 * hash   → the node's hash when it equals the digest worked out here (any letter case), or "" (no match: not to be used).
 */
async function ask(kind, arg, run) {
  const c = command(kind, arg);
  if (!c) throw new Error("Entropy asks the node only for a random value or the hash of the 64 bytes of one roll.");
  const mine = kind === "hash" ? sha3(arg) : "";
  const j = await run(c), v = j && j.status === true && j.response ? j.response[kind === "random" ? "random" : "hash"] : "";
  if (typeof v !== "string") return "";
  return kind === "random" ? (RANDOM.test(v) ? v : "") : (v.toLowerCase() === mine ? v : "");
}
module.exports = { command, ask, sha3 };
