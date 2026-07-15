/*
 * mailcrypto.js — minimaMail on-chain "ChainMail" crypto, a byte-for-byte port of the native
 * com.eurobuddha.comms LocalEcCryptoProvider / CommsIdentity / Hkdf (libsodium). Interop-critical: identities +
 * sealed blobs must match the native Android app on the shared CHAINMAIL address.
 *
 *   seed(vault) --HKDF-SHA256(salt=0x00*32, info "minima-comms-box-v1"/"-sign-v1")--> box(X25519)+sign(Ed25519)
 *   publicId = "0x" + hex(boxPk) + hex(signPk)
 *   seal: sig = Ed25519_detached(boxPk‖signPk‖plaintext, signSk);
 *         cipher = crypto_box_seal({f:publicId, b:hex(plaintext), s:hex(sig)} UTF-8, recipientBoxPk); -> hex
 *   open: crypto_box_seal_open(cipher, myBoxPk, myBoxSk) -> {f,b,s}; verify Ed25519 over from64‖body
 *
 * All keys stay in the main process; the renderer only ever gets the publicId + decrypted text.
 */
const crypto = require("crypto");
const _sodium = require("libsodium-wrappers");

const BOX_INFO = "minima-comms-box-v1";
const SIGN_INFO = "minima-comms-sign-v1";

let sodium = null;
async function ready() { if (!sodium) { await _sodium.ready; sodium = _sodium; } return sodium; }

function hkdf32(ikm, info) {
  // HKDF-SHA256, RFC5869, salt = 32 zero bytes, L = 32 (matches com.eurobuddha.comms.Hkdf).
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(32), info, 32));
}

/** vault seed string -> IKM bytes: raw hex if it starts 0x, else UTF-8 bytes (matches the native app). */
function ikmFromSeed(seedStr) {
  const s = String(seedStr || "");
  if (/^0x/i.test(s)) {
    const hex = s.slice(2);
    // Fail loudly on a malformed hex seed rather than letting Buffer.from silently truncate a trailing nibble —
    // a silent truncation would derive a DIFFERENT identity than a strict native decoder, breaking interop invisibly.
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error("node seed is not valid hex");
    return Buffer.from(hex, "hex");
  }
  return Buffer.from(s, "utf8");
}

/** Derive the messaging identity. Returns { boxPk,boxSk,signPk,signSk (Uint8Array), publicId ("0x"+128hex) }. */
async function deriveIdentity(seedStr) {
  const s = await ready();
  const ikm = ikmFromSeed(seedStr);
  const box = s.crypto_box_seed_keypair(new Uint8Array(hkdf32(ikm, BOX_INFO)));
  const sign = s.crypto_sign_seed_keypair(new Uint8Array(hkdf32(ikm, SIGN_INFO)));
  const publicId = "0x" + s.to_hex(box.publicKey) + s.to_hex(sign.publicKey);
  return { boxPk: box.publicKey, boxSk: box.privateKey, signPk: sign.publicKey, signSk: sign.privateKey, publicId };
}

// --- publicId helpers (64 raw bytes = boxPk[32] || signPk[32]) ---
// Decode with Buffer (strict-validated first) rather than _sodium.from_hex, so isValidPublicId/boxPkOf/signPkOf work
// even before libsodium's async ready() has resolved (e.g. addContact called at startup) and reject malformed hex.
function idBytes(publicId) {
  const hex = String(publicId).replace(/^0x/i, "");
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error("bad publicId hex");
  return new Uint8Array(Buffer.from(hex, "hex"));
}
function boxPkOf(publicId) { return idBytes(publicId).slice(0, 32); }
function signPkOf(publicId) { return idBytes(publicId).slice(32, 64); }
function isValidPublicId(publicId) { try { return idBytes(publicId).length === 64; } catch (e) { return false; } }

/** Seal `plaintext` (Uint8Array/Buffer) to `toPublicId`. Returns bare lowercase hex (no 0x). */
async function seal(identity, toPublicId, plaintext) {
  const s = await ready();
  const pt = plaintext instanceof Uint8Array ? plaintext : Buffer.from(plaintext);
  const from = idBytes(identity.publicId);                         // 64 raw bytes
  const signed = new Uint8Array(from.length + pt.length);
  signed.set(from, 0); signed.set(pt, from.length);
  const sig = s.crypto_sign_detached(signed, identity.signSk);     // Ed25519 detached, 64 bytes
  const payload = JSON.stringify({ f: identity.publicId, b: s.to_hex(pt), s: s.to_hex(sig) });
  const cipher = s.crypto_box_seal(s.from_string(payload), boxPkOf(toPublicId));
  return s.to_hex(cipher);
}

/** Open a sealed blob (hex, optional 0x). Returns { valid, fromPublicId, plaintext(Uint8Array) } or null if not for me. */
async function open(identity, blobHex) {
  const s = await ready();
  let cipher;
  try { cipher = s.from_hex(String(blobHex).replace(/^0x/i, "")); } catch (e) { return null; }
  if (cipher.length <= s.crypto_box_SEALBYTES) return null;
  let payloadBytes;
  try { payloadBytes = s.crypto_box_seal_open(cipher, identity.boxPk, identity.boxSk); } catch (e) { return null; }
  if (!payloadBytes) return null;
  let p;
  try { p = JSON.parse(s.to_string(payloadBytes)); } catch (e) { return null; }
  const from = p.f || "";
  if (!isValidPublicId(from)) return { valid: false, fromPublicId: from, plaintext: new Uint8Array() };
  let body, sig;
  try { body = s.from_hex(p.b || ""); sig = s.from_hex(p.s || ""); } catch (e) { return { valid: false, fromPublicId: from, plaintext: new Uint8Array() }; }
  if (sig.length !== s.crypto_sign_BYTES) return { valid: false, fromPublicId: from, plaintext: body };
  const fb = idBytes(from);
  const signed = new Uint8Array(fb.length + body.length);
  signed.set(fb, 0); signed.set(body, fb.length);
  let valid = false;
  try { valid = s.crypto_sign_verify_detached(sig, signed, signPkOf(from)); } catch (e) { valid = false; }
  return { valid, fromPublicId: from, plaintext: body };
}

// --- keychain serialization (store the derived keys, never the seed) ---
function serializeIdentity(id) {
  return JSON.stringify({ publicId: id.publicId, boxPk: _sodium.to_hex(id.boxPk), boxSk: _sodium.to_hex(id.boxSk),
    signPk: _sodium.to_hex(id.signPk), signSk: _sodium.to_hex(id.signSk) });
}
function loadIdentity(json) {
  const o = JSON.parse(json);
  return { publicId: o.publicId, boxPk: _sodium.from_hex(o.boxPk), boxSk: _sodium.from_hex(o.boxSk),
    signPk: _sodium.from_hex(o.signPk), signSk: _sodium.from_hex(o.signSk) };
}

module.exports = { ready, deriveIdentity, seal, open, serializeIdentity, loadIdentity, isValidPublicId, boxPkOf, signPkOf };
