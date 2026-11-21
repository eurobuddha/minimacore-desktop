/*
 * entropy.js — what Entropy may ask (main process). After Pandamonium's Entropy (apks/base integrated/entropy
 * RollEngine.java, as the standalone Entropy 0.1.16 has it): the node is asked for `random` and nothing else.
 *
 * THE NODE NEVER SEES THE DEVICE BYTES AND NEVER HASHES (0.19.163, security review 2026-11-20). 0.19.132 checked the
 * node's `hash` answer, but sending `hash data:A||B` still told whoever answers the node every die (B included), and let
 * it veto throws it disliked by answering with an error. Now:
 *   random → the node's own random value, passed on only as 32 bytes of hex (the command's default size), else "".
 *   sha3   → SHA3-256 of one roll's 64 bytes (node 32 ++ device 32), worked out HERE and never sent to the node. It is
 *            the digest Minima's `hash data:0x…` gives (core `commands/base/hash.java`: type defaults to "sha3",
 *            `Crypto.hashData` = BouncyCastle SHA3Digest(256)), so every roll stays checkable with `runscript`.
 * A node that fails or answers badly is the screen's to handle: the roll is thrown away and the node checked again.
 *
 * THE VALUES ARE SEED MATERIAL: whoever holds the two inputs of every roll can recompute the phrase. The device's value
 * (B) comes here only to be hashed and goes back to the screen with the digest; nothing here is logged, kept or written
 * anywhere. rpcCall logs no command and no reply.
 */
"use strict";
const RANDOM = /^0x[0-9a-fA-F]{64}$/, INPUT = /^0x[0-9a-fA-F]{128}$/;
/** SHA3-256 of the bytes a 0x hex string spells, as 0x lower-case hex (what Minima's `hash data:` gives by default). */
// main/sha3.js, never crypto's sha3-256 (0.19.312: Electron's BoringSSL has none, so the roll's hash threw in the packaged app)
const sha3 = (hex) => "0x" + require("./sha3").sha3_256(Buffer.from(hex.slice(2), "hex")).toString("hex");
/** The node command for one ask: `random`, or null (the only command Entropy ever sends; `sha3` never reaches the node). */
function command(kind) { return kind === "random" ? "random" : null; }
/**
 * One ask. run(command) → the node's reply (through rpcCall); a node that fails throws, and the screen says so.
 * random → the node's 32 bytes as 0x hex, or "" when it gave anything else.
 * sha3   → the digest of the 64 bytes of one roll, worked out here; the node is not asked.
 */
async function ask(kind, arg, run) {
  if (kind === "sha3") {
    if (typeof arg !== "string" || !INPUT.test(arg)) throw new Error("Entropy hashes only the 64 bytes of one roll.");
    return sha3(arg);
  }
  const c = command(kind);
  if (!c) throw new Error("Entropy asks the node only for a random value.");
  const j = await run(c), v = j && j.status === true && j.response ? j.response.random : "";
  return typeof v === "string" && RANDOM.test(v) ? v : "";
}
module.exports = { command, ask, sha3 };
