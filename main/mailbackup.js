/*
 * mailbackup.js — passphrase-encrypts the minimaMail identity backup (which contains the PRIVATE keys).
 * Byte-for-byte compatible with the native com.eurobuddha.comms.BackupCrypto so a backup made on the Android
 * app restores on desktop and vice-versa:
 *   PBKDF2WithHmacSHA256, 120000 iterations, 256-bit key → AES-256-GCM, 128-bit tag.
 *   16-byte random salt + 12-byte random IV per encrypt.
 *   Container JSON: { "v":1, "salt":hex, "iv":hex, "ct":hex }.
 * CRITICAL interop detail: Java's `AES/GCM/NoPadding` appends the 16-byte GCM tag to the ciphertext, so `ct`
 * here is ciphertext‖tag (Node returns the tag separately via getAuthTag()); decrypt splits the last 16 bytes.
 */
const crypto = require("crypto");

const ITERATIONS = 120000;
const KEYLEN = 32;      // 256-bit AES key
const TAGLEN = 16;      // 128-bit GCM tag
const SALTLEN = 16;
const IVLEN = 12;

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(Buffer.from(String(passphrase), "utf8"), salt, ITERATIONS, KEYLEN, "sha256");
}

/** Encrypt UTF-8/Buffer plaintext → the container JSON string. */
function encrypt(passphrase, plaintext) {
  const salt = crypto.randomBytes(SALTLEN);
  const iv = crypto.randomBytes(IVLEN);
  const key = deriveKey(passphrase, salt);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAGLEN });
  const body = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  const tag = c.getAuthTag();
  const ct = Buffer.concat([body, tag]);   // match Java: ciphertext‖tag
  return JSON.stringify({ v: 1, salt: salt.toString("hex"), iv: iv.toString("hex"), ct: ct.toString("hex") });
}

/** Decrypt a container JSON string → the plaintext Buffer. Throws on a wrong passphrase / tampered file. */
function decrypt(passphrase, json) {
  const o = JSON.parse(json);
  const salt = Buffer.from(String(o.salt), "hex");
  const iv = Buffer.from(String(o.iv), "hex");
  const ct = Buffer.from(String(o.ct), "hex");
  if (ct.length < TAGLEN) throw new Error("backup ciphertext too short");
  const body = ct.subarray(0, ct.length - TAGLEN);
  const tag = ct.subarray(ct.length - TAGLEN);
  const key = deriveKey(passphrase, salt);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAGLEN });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);   // .final() throws if the tag doesn't verify
}

module.exports = { encrypt, decrypt };
