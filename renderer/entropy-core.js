/*
 * entropy-core.js: the maths of Entropy (Phase 5b), ported line for line from Pandamonium's Entropy
 * (apks/base integrated/entropy, 1c60c2593325f70cba5089e2ba430925d6ccca3c: Bip39.java, RollEngine.java, and the
 * bookkeeping of DiceView.java; standalone apks/entropy 0.1.14), itself bit-identical to iancoleman/bip39 v0.4.3.
 * No DOM, no node, no randomness of its own: it is handed dice faces, hashes and random bytes, so every line is tested
 * with the original's fixed vectors (scripts/entropy-test.cjs).
 *
 * WHAT IT MAKES IS A WALLET SEED. Nothing here stores, logs or sends anything; the caller keeps the result in memory only.
 *
 *   dice → bits   "base 6 (dice)", unbiased: face 6 counts as 0; digits 0..3 give two bits, 4 and 5 give one bit
 *   bits → ENT    raw mode: the LAST floor(len / 32) * 32 bits
 *   ENT → words   the ENT / 32 leading bits of SHA-256(ENT) appended, cut into 11-bit word numbers
 *   a die face    SHA3(node random ++ device random) → the first 4 bytes as a number n → n % 6 + 1, and n at or above
 *                 floor(2^32 / 6) * 6 is thrown again, so the face is exactly uniform
 */
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.EntropyCore = make(); })(this, function () {
  "use strict";
  var WORDS = null, INDEX = null;
  var LENGTHS = [12, 15, 18, 21, 24], DICE = 5;
  var REJECT_THRESHOLD = 4294967292, REJECT_LIMIT = 25;   // RollEngine: floor(2^32 / 6) * 6; rerolls before the source is called broken
  var SRC = { NODE_DEVICE: "node-sha3+device", DEVICE_ONLY: "device-only", PHYSICAL: "physical" };
  var EVENT_BITS = ["00", "01", "10", "11", "0", "1"];

  /** SHA-256 of bytes → Promise<Uint8Array>. WebCrypto in the window, and in Node for the tests. */
  var sha256 = function (bytes) { return crypto.subtle.digest("SHA-256", bytes).then(function (b) { return new Uint8Array(b); }); };

  function init(words) {
    if (!Array.isArray(words) || words.length !== 2048) throw new Error("BIP39 wordlist must have 2048 words");
    WORDS = words.slice(); INDEX = new Map();
    for (var i = 0; i < WORDS.length; i++) INDEX.set(WORDS[i], i);
  }
  function ready() { return WORDS !== null; }
  function wordIndex(w) { var i = INDEX.get(w); return i === undefined ? -1 : i; }
  /** ENT bits for a phrase length; -1 when the length is not a BIP39 length. */
  function entTarget(n) { return n === 12 ? 128 : n === 15 ? 160 : n === 18 ? 192 : n === 21 ? 224 : n === 24 ? 256 : -1; }
  function facesToBits(faces) { var s = ""; for (var i = 0; i < faces.length; i++) s += EVENT_BITS[faces[i] === 6 ? 0 : faces[i]]; return s; }
  function rawTruncate(bits) { var use = Math.floor(bits.length / 32) * 32; return bits.substring(bits.length - use); }
  function bitsToBytes(bits) { var out = new Uint8Array(bits.length / 8); for (var i = 0; i < out.length; i++) out[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2); return out; }
  function bytesToBits(bytes, count) { var s = ""; for (var i = 0; i < bytes.length && s.length < count; i++) for (var b = 7; b >= 0 && s.length < count; b--) s += (bytes[i] >> b) & 1; return s; }
  function pad(n, len) { var b = n.toString(2); while (b.length < len) b = "0" + b; return b; }

  /** entropy bits (a multiple of 32) → the full phrase, checksum appended (jsbip39 toMnemonic). */
  function entropyBitsToWords(entBits) {
    return sha256(bitsToBytes(entBits)).then(function (hash) {
      var all = entBits + bytesToBits(hash, entBits.length / 32), out = [];
      for (var i = 0; i < all.length / 11; i++) out.push(WORDS[parseInt(all.substring(i * 11, i * 11 + 11), 2)]);
      return out;
    });
  }
  /** Is this a complete phrase with a correct checksum (jsbip39 check)? */
  function check(phrase) {
    var n = phrase.length, bits = "";
    if (entTarget(n) < 0) return Promise.resolve(false);
    for (var i = 0; i < n; i++) { var ix = wordIndex(phrase[i]); if (ix < 0) return Promise.resolve(false); bits += pad(ix, 11); }
    var ent = n * 11 * 32 / 33, claimed = bits.substring(ent);
    return sha256(bitsToBytes(bits.substring(0, ent))).then(function (hash) { return claimed === bytesToBits(hash, n * 11 - ent); });
  }
  /** The first N-1 words of an N-word phrase → EVERY valid last word: { candidates, free, cs, n } or { error }. 12: 128, 15: 64, 18: 32, 21: 16, 24: 8. */
  function lastWordCandidates(words) {
    var n = words.length + 1, ent = entTarget(n), prior = "";
    if (ent < 0) return Promise.resolve({ error: "enter 11, 14, 17, 20 or 23 words (got " + words.length + ")" });
    for (var i = 0; i < words.length; i++) { var ix = wordIndex(words[i]); if (ix < 0) return Promise.resolve({ error: "word " + (i + 1) + " (\"" + words[i] + "\") is not in the BIP39 list" }); prior += pad(ix, 11); }
    var cs = ent / 32, free = 11 - cs, jobs = [];
    for (var c = 0; c < (1 << free); c++) jobs.push(entropyBitsToWords(prior + pad(c, free)).then(function (full) { return full[full.length - 1]; }));
    return Promise.all(jobs).then(function (out) { return { candidates: out, free: free, cs: cs, n: n }; });
  }
  function hexToBits(hex) { var s = ""; for (var i = 0; i < hex.length; i++) s += pad(parseInt(hex.charAt(i), 16), 4); return s; }

  /** The fixed-vector self-test (Bip39.selfTest): → null when everything passes, else what failed. Nothing is generated until it has passed. */
  function selfTest() {
    var run = async function () {
      if (!ready()) return "wordlist not loaded";
      if (WORDS.length !== 2048) return "wordlist has " + WORDS.length + " words";
      if (WORDS[0] !== "abandon" || WORDS[2047] !== "zoo") return "wordlist bounds wrong";
      var v = [["00000000000000000000000000000000", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"],
        ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f", "legal winner thank year wave sausage worth useful legal winner thank yellow"],
        ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote"]];
      for (var i = 0; i < v.length; i++) {
        var got = await entropyBitsToWords(hexToBits(v[i][0]));
        if (got.join(" ") !== v[i][1]) return "BIP39 vector " + (i + 1) + " failed";
        if (!(await check(got))) return "check() rejects valid vector " + (i + 1);
      }
      // the dice vector: its phrase was produced by the genuine iancoleman code
      var faces = "25262423135241341562253664545432446414112156541463663153452544512632242356432255434125363".split("").map(Number);
      var bits = facesToBits(faces);
      if (bits.length !== 143) return "dice encoding length check failed";
      var ent = rawTruncate(bits);
      if (ent.length !== 128) return "raw truncation check failed";
      if ((await entropyBitsToWords(ent)).join(" ") !== "wedding crawl scout then coast emotion bridge spot demise together holiday tray") return "dice-to-phrase vector failed";
      var eleven = []; for (var k = 0; k < 11; k++) eleven.push("abandon");
      var lw = await lastWordCandidates(eleven);
      if (lw.error || lw.candidates.length !== 128) return "last-word tool: candidate count failed";
      if (lw.candidates.indexOf("about") < 0) return "last-word tool: known candidate missing";
      if (!(await check(eleven.concat("about")))) return "last-word tool: validator rejects known phrase";
      if (await check(eleven.concat("abandon"))) return "last-word tool: validator accepts invalid phrase";
      for (var c = 0; c < lw.candidates.length; c++) if (!(await check(eleven.concat(lw.candidates[c])))) return "last-word tool: candidate fails checksum";
      return null;
    };
    return run().catch(function (e) { return "self-test exception: " + ((e && e.message) || e); });
  }

  // ---- a die face (RollEngine) ----
  /** The node's hash of (node random ++ device random) → { n, face }, { reject: true } (thrown again: no modulo bias), or { error }. */
  function faceFromHash(hash) {
    if (typeof hash !== "string" || hash.indexOf("0x") !== 0 || hash.length < 10) return { error: "Node hash failed" };
    var h = hash.substring(2, 10);
    if (!/^[0-9a-fA-F]{8}$/.test(h)) return { error: "Node hash unparseable" };   // a malformed hash fails loudly, it is never mis-read
    var n = parseInt(h, 16);
    if (n >= REJECT_THRESHOLD) return { reject: true };
    return { n: n, face: (n % 6) + 1 };
  }
  /** One byte from the device's CSPRNG → a face 1..6, or 0 for "take another byte" (252 and above: byte rejection). */
  function faceFromByte(v) { return v >= 252 ? 0 : (v % 6) + 1; }
  /** What `hash data:` is given: the node's secret with the device's secret appended (CONCAT(a b)). */
  function hashInput(a, b) { return a + b.substring(2); }
  var isHex = function (s) { return typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s); };

  // ---- the run (DiceView) ----
  /** Add one throw's faces to the run, stopping EXACTLY when the target is reached (the raw-mode rule). → how many were taken. */
  function record(faces, audits, results, auds, target) {
    var taken = 0;
    for (var i = 0; i < results.length; i++) {
      if (facesToBits(faces).length >= target) break;
      faces.push(results[i]); audits.push(auds[i]); taken++;
    }
    return taken;
  }
  var SOURCE_LABEL = {}; SOURCE_LABEL[SRC.NODE_DEVICE] = "node SHA3 + device"; SOURCE_LABEL[SRC.DEVICE_ONLY] = "device only"; SOURCE_LABEL[SRC.PHYSICAL] = "physical";
  /** The lines under a finished phrase (DiceView.finish): the count line, the sources, and the two warnings when they apply. */
  function summary(faces, audits, allBits, entBits, words) {
    var count = {}, order = [], i;
    for (i = 0; i < audits.length; i++) { if (!(audits[i].src in count)) { count[audits[i].src] = 0; order.push(audits[i].src); } count[audits[i].src]++; }
    var lines = [faces.length + " rolls → " + allBits + " unbiased bits → " + entBits + " entropy bits + " + (entBits / 32) + "-bit SHA-256 checksum = " + words + " words",
      "sources: " + order.map(function (s) { return count[s] + " × " + (SOURCE_LABEL[s] || s); }).join(", ")];
    if (SRC.DEVICE_ONLY in count) lines.push("⚠ some rolls used a single entropy source (node unavailable)");
    if (SRC.PHYSICAL in count) {
      var fc = {}, kinds = 0, max = 0;
      for (i = 0; i < faces.length; i++) { if (!fc[faces[i]]) { fc[faces[i]] = 0; kinds++; } if (++fc[faces[i]] > max) max = fc[faces[i]]; }
      if (kinds < 4 || max * 2 > faces.length) lines.push("⚠ roll distribution looks non-random: use a real, fair die");
    }
    return lines;
  }
  /** The per-roll audit log. It reveals every roll's secrets: whoever reads it can recompute the phrase. */
  function auditLog(audits) {
    return audits.map(function (a, i) {
      if (a.src === SRC.PHYSICAL) return "#" + (i + 1) + " face:" + a.face + " (physical)";
      if (a.src === SRC.DEVICE_ONLY) return "#" + (i + 1) + " face:" + a.face + " (device CSPRNG only)";
      return "#" + (i + 1) + " A:" + a.a + " B:" + a.b + " n:" + a.n + " face:" + a.face;
    }).join("\n");
  }
  /** Up to nine list words that start with what is typed (LastWordView.suggestionsFor). */
  function suggestions(prefix) {
    var out = []; if (!prefix) return out;
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i].indexOf(prefix) === 0) { out.push(WORDS[i]); if (out.length > 8) break; }
    return out;
  }

  return { init: init, ready: ready, wordIndex: wordIndex, entTarget: entTarget, facesToBits: facesToBits, rawTruncate: rawTruncate, entropyBitsToWords: entropyBitsToWords, check: check,
    lastWordCandidates: lastWordCandidates, selfTest: selfTest, faceFromHash: faceFromHash, faceFromByte: faceFromByte, hashInput: hashInput, isHex: isHex, record: record, summary: summary,
    auditLog: auditLog, suggestions: suggestions, LENGTHS: LENGTHS, DICE: DICE, REJECT_THRESHOLD: REJECT_THRESHOLD, REJECT_LIMIT: REJECT_LIMIT, SRC: SRC, _setSha256: function (f) { sha256 = f; } };
});
