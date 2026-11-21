/*
 * keyuses.js — the chain's key-use figure for one public key, read in the MAIN process (0.18.262), so the Web Wallet's
 * confirmed count is checked against it here and not only in the window (a window that sent a count below the chain's
 * figure made the next send sign with a one-time key a second time). Taken from Pandamonium Desktop's main/keyuses.js
 * (0.19.255): onchainUses with its parsing (whole, parseUsage); that file's node-key audit and address derivation, the
 * only parts that hash (main/sha3.js there, never Node's crypto), are not part of this desktop. No electron.
 */
"use strict";

const BASE = "https://eurobuddha.com";            // the only host this module ever names (main.js KEYUSES_BASE)
// The most one reply may weigh: a /keyaudit row is under 450 bytes, so one key's answer is far below it.
const MAX_BODY_BYTES = 512 * 1024;
const PK = /^0x[0-9a-fA-F]{64}$/;

/** A whole number as the server wrote it (5, "5", "5.0"), or null. Never a guess, never a default. */
function whole(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== "string" || !/^-?\d{1,15}(\.0+)?$/.test(v)) return null;
  return Number(v.split(".")[0]);
}
/** /keyaudit rows → [{ publickey, address, sigs, coins }]; a row with an error or a bad count is left out. */
function parseUsage(arr) {
  const out = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    if (!o || typeof o !== "object" || typeof o.publickey !== "string" || !o.publickey || "error" in o) continue;
    const sigs = whole("spend_blocks" in o ? o.spend_blocks : o.onchain_signatures), coins = whole("spent_coins" in o ? o.spent_coins : o.spent_coins_upperbound);
    if (sigs == null || coins == null || sigs < 0 || coins < 0) continue;
    out.push({ publickey: o.publickey, address: typeof o.address === "string" ? o.address : "", sigs, coins });
  }
  return out;
}
/**
 * One key's on-chain use figure: the larger of the spend blocks and the spent coins the archive counted. get(url) → parsed
 * JSON or null (https, no redirect, bounded). → a whole number, or NULL when it was not read: no answer, an error row, a row
 * for another key, a count that is not a whole number. Never 0 for "unknown": a figure that is too low reuses a one-time signature.
 */
async function onchainUses(publicKey, get) {
  if (typeof publicKey !== "string" || !PK.test(publicKey)) return null;
  let j; try { j = await get(BASE + "/keyaudit?keys=" + encodeURIComponent(publicKey)); } catch (e) { return null; }
  if (!j || j.status !== true) return null;
  const row = parseUsage(j.keys).find(u => u.publickey.toUpperCase() === publicKey.toUpperCase());
  return row ? Math.max(row.sigs, row.coins) : null;
}

module.exports = { onchainUses, parseUsage, whole, BASE, MAX_BODY_BYTES };
