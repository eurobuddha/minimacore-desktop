/*
 * validate.js — the canonical guards for anything that gets interpolated into a node command.
 *
 * WHY THIS IS ONE MODULE. The node's command parser is space-tokenised and LAST-WINS, so a value carrying a
 * space and another `key:` silently rewrites the command around it: `tokenid:"0x00 address:0xATTACKER"` ends
 * up as `... address:<real> tokenid:0x00 address:0xATTACKER`, and the attacker's address wins. This has bitten
 * the family before — a length-only address check let `Mx… address:0x<attacker>` through and redirected funds
 * (see the comment in main/mail.js). The rule, stated in main/webwallet.js, is "NEVER interpolate unvalidated
 * free-text into a command string"; these are the checks that make it enforceable in one place instead of
 * four near-copies that can drift apart.
 *
 * All of them are total: any input type, no throw, boolean out.
 */

/** A real Minima receiving address: Mx… (base58-ish alphanumeric, 40–80) or 0x + up to 64 hex.
 *  The charset lock is load-bearing — a length-only check is what let the injection through. */
function isMinimaAddress(a) {
  if (typeof a !== "string") return false;
  a = a.trim();
  if (/^0x[0-9A-Fa-f]{1,64}$/.test(a)) return true;
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  return false;
}

/** A strict receiving address: 0x + EXACTLY 64 hex, or Mx…. Rejects a 130-hex Mail identity key, which must
 *  never be usable as a pay address (mail.js learned this one the hard way). */
function isPayAddress(a) {
  if (typeof a !== "string") return false;
  a = a.trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}

/** MINIMA (0x00) or a full 32-byte token id. */
function isTokenid(t) {
  return t === "0x00" || (typeof t === "string" && /^0x[0-9A-Fa-f]{64}$/.test(t));
}

/** A coin id / txpow id / public key: 0x + hex, generously bounded, hex-only so it carries no metacharacters. */
function isHexId(v) {
  return typeof v === "string" && /^0x[0-9A-Fa-f]{2,200}$/.test(v);
}

/** A positive decimal amount, as a STRING. Minima amounts run to 44 decimals, so they are never parsed into a
 *  double for anything that matters; this only proves the shape is safe to interpolate. */
function isAmount(a) {
  const s = typeof a === "number" ? String(a) : a;
  return typeof s === "string" && /^\d{1,30}(\.\d{1,44})?$/.test(s) && /[1-9]/.test(s);
}

/** A non-negative integer, as a string or number (block counts, key-uses, grace hours). */
function isCount(n) {
  const s = typeof n === "number" ? String(n) : n;
  return typeof s === "string" && /^\d{1,20}$/.test(s);
}

/** Free text that is safe inside a quoted `key:"…"` argument: no quote, backslash or control character can
 *  close the quoting early. A password containing `"` silently produced a DIFFERENT (unrestorable) backup. */
function isQuotableText(s) {
  if (typeof s !== "string" || !s.length) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 34 || c === 92) return false; }
  return true;
}

/** A bare (unquoted) argument value: no whitespace and none of the quoting characters. */
function isBareValue(s) {
  return typeof s === "string" && s.length > 0 && !/[\s"'\\]/.test(s);
}

module.exports = { isMinimaAddress, isPayAddress, isTokenid, isHexId, isAmount, isCount, isQuotableText, isBareValue };
