/*
 * sha3.js: SHA3-256 in plain JS (0.18.247; the same code as Pandamonium Desktop 0.19.312's main/sha3.js, this comment apart). Electron's crypto is BoringSSL, which has
 * no SHA-3: createHash("sha3-256") throws in the packaged app while it works under plain Node, where the tests run. Every SHA-3 of
 * the desktop's own code goes through here: the Mx address checksum of the miniMall payout-address check (main/shop.js mxToHex,
 * 0.18.227, which read every address as valid in the packaged app). Keccak-f[1600] on BigInt lanes; inputs are small.
 */
"use strict";
const M = (1n << 64n) - 1n;
const RC = ["0x0000000000000001", "0x0000000000008082", "0x800000000000808A", "0x8000000080008000", "0x000000000000808B", "0x0000000080000001",
  "0x8000000080008081", "0x8000000000008009", "0x000000000000008A", "0x0000000000000088", "0x0000000080008009", "0x000000008000000A",
  "0x000000008000808B", "0x800000000000008B", "0x8000000000008089", "0x8000000000008003", "0x8000000000008002", "0x8000000000000080",
  "0x000000000000800A", "0x800000008000000A", "0x8000000080008081", "0x8000000000008080", "0x0000000080000001", "0x8000000080008008"].map(BigInt);
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];   // ROT[x][y]
const rotl = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M : v);
function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map(x => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    const D = [0, 1, 2, 3, 4].map(x => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
    for (let i = 0; i < 25; i++) A[i] ^= D[i % 5];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & M) & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[r];
  }
}
/** SHA3-256 of bytes (a Buffer, a Uint8Array or a string as UTF-8) → a 32-byte Buffer. */
function sha3_256(data) {
  const msg = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const rate = 136, q = rate - (msg.length % rate), p = Buffer.alloc(msg.length + q);
  msg.copy(p); p[msg.length] ^= 0x06; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) { for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + 8 * i); keccakF(A); }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], 8 * i);
  return out;
}
module.exports = { sha3_256 };
