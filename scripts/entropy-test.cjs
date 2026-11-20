// Entropy (0.19.130): what it makes is a wallet seed, so the maths is pinned by the ORIGINAL's fixed vectors (Bip39.java
// selfTest and Bip39Test.java of apks/base integrated/entropy, 1c60c2593325f70cba5089e2ba430925d6ccca3c, read, not run),
// the die by its exact rule, and the screen by what it may and may not do with the phrase. Nothing reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), nodeCrypto = require("crypto");
const C = require("../renderer/entropy-core.js"), WORDS = require("../renderer/wordentry.js").WORDS, M = require("../main/entropy.js");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tools = R("renderer/apps-tools.js"), src = tools.slice(tools.indexOf("// ---- Entropy: Pandamonium's seed dice"));
C.init(WORDS);
const pick = (n) => Array.from({ length: n }, () => WORDS[nodeCrypto.randomInt(2048)]);

test("the word list is the original's, byte for byte, and the original's fixed vectors pass", async () => {
  assert.equal(nodeCrypto.createHash("sha256").update(WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", "sha256 of res/raw/pm_entropy_bip39_english.txt (the BIP39 English list)");
  assert.equal(await C.selfTest(), null);
  const faces = "25262423135241341562253664545432446414112156541463663153452544512632242356432255434125363".split("").map(Number), bits = C.facesToBits(faces);
  assert.equal(bits.length, 143); const ent = C.rawTruncate(bits); assert.equal(ent.length, 128);
  assert.equal((await C.entropyBitsToWords(ent)).join(" "), "wedding crawl scout then coast emotion bridge spot demise together holiday tray", "the dice vector the genuine iancoleman code produced");
  assert.equal((await C.entropyBitsToWords("0".repeat(128))).join(" "), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  assert.equal((await C.entropyBitsToWords("1".repeat(256))).join(" "), "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote");
  assert.deepEqual([12, 15, 18, 21, 24, 11, 13, 0].map(C.entTarget), [128, 160, 192, 224, 256, -1, -1, -1]);
  assert.equal(C.facesToBits([1, 2, 3, 4, 5, 6]), "01" + "10" + "11" + "0" + "1" + "00", "6 counts as 0; 4 and 5 give one bit");
});

test("a broken list or a broken hash blocks generation: the self-test says what failed", async () => {
  const swapped = WORDS.slice(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  C.init(swapped); assert.equal(await C.selfTest(), "BIP39 vector 1 failed");
  const ends = WORDS.slice(); ends[2047] = "zoom"; C.init(ends); assert.equal(await C.selfTest(), "wordlist bounds wrong");
  assert.throws(() => C.init(WORDS.slice(0, 2047)), /BIP39 wordlist must have 2048 words/);
  C.init(WORDS);
  C._setSha256(async () => new Uint8Array(32)); assert.equal(await C.selfTest(), "BIP39 vector 1 failed", "a SHA-256 that is not SHA-256 is caught");
  C._setSha256(async () => { throw new Error("no subtle"); }); assert.equal(await C.selfTest(), "self-test exception: no subtle");
  C._setSha256((bytes) => crypto.subtle.digest("SHA-256", bytes).then(b => new Uint8Array(b))); assert.equal(await C.selfTest(), null);
});

test("the last word: 128 / 64 / 32 / 16 / 8 candidates, all distinct, all valid, and a word outside them is refused (Bip39Test)", async () => {
  for (const [n, count] of [[12, 128], [15, 64], [18, 32], [21, 16], [24, 8]]) for (let r = 0; r < 3; r++) {
    const prior = pick(n - 1), lw = await C.lastWordCandidates(prior);
    assert.equal(lw.error, undefined); assert.equal(lw.candidates.length, count); assert.equal(new Set(lw.candidates).size, count); assert.equal(lw.free + lw.cs, 11); assert.equal(lw.n, n);
    for (const c of lw.candidates) assert.equal(await C.check(prior.concat(c)), true);
    let tried = 0; while (tried < 3) { const w = WORDS[nodeCrypto.randomInt(2048)]; if (lw.candidates.includes(w)) continue; tried++; assert.equal(await C.check(prior.concat(w)), false); }
  }
  assert.deepEqual(await C.lastWordCandidates(pick(12)), { error: "enter 11, 14, 17, 20 or 23 words (got 12)" });
  assert.deepEqual(await C.lastWordCandidates(["abandon", "abandn"].concat(pick(9))), { error: "word 2 (\"abandn\") is not in the BIP39 list" });
  assert.equal(await C.check(pick(13)), false); assert.equal(await C.check(["abandon"]), false);
  assert.deepEqual(C.suggestions("aban"), ["abandon"]); assert.equal(C.suggestions("a").length, 9); assert.deepEqual(C.suggestions(""), []); assert.deepEqual(C.suggestions("zzz"), []);
});

test("the stopping rule: rolls are taken until the bits reach the target and not one roll more, for every length (Bip39Test)", async () => {
  for (const n of C.LENGTHS) for (let r = 0; r < 20; r++) {
    const target = C.entTarget(n), faces = [], audits = [];
    while (C.facesToBits(faces).length < target) { const five = Array.from({ length: 5 }, () => nodeCrypto.randomInt(6) + 1); C.record(faces, audits, five, five.map(f => ({ face: f })), target); }
    assert.ok(C.facesToBits(faces.slice(0, -1)).length < target, "the last roll taken was needed"); assert.equal(audits.length, faces.length);
    const ent = C.rawTruncate(C.facesToBits(faces)); assert.equal(ent.length, target);
    const phrase = await C.entropyBitsToWords(ent); assert.equal(phrase.length, n); assert.equal(await C.check(phrase), true);
  }
  const faces = [], audits = []; assert.equal(C.record(faces, audits, [1, 1, 1], ["a", "b", "c"], 4), 2, "a throw's later dice are left out once the target is met"); assert.deepEqual(faces, [1, 1]); assert.deepEqual(audits, ["a", "b"]);
});

test("a die face is exactly uniform: n % 6 + 1 of the hash's first four bytes, thrown again at or above floor(2^32 / 6) * 6", () => {
  assert.equal(C.REJECT_THRESHOLD, Math.floor(4294967296 / 6) * 6); assert.equal(C.REJECT_THRESHOLD, 4294967292); assert.equal(C.REJECT_LIMIT, 25);
  assert.deepEqual(C.faceFromHash("0x00000000" + "AB".repeat(28)), { n: 0, face: 1 }); assert.deepEqual(C.faceFromHash("0x00000005FF"), { n: 5, face: 6 }); assert.deepEqual(C.faceFromHash("0x0000000600"), { n: 6, face: 1 });
  assert.deepEqual(C.faceFromHash("0xFFFFFFFB00"), { n: 4294967291, face: (4294967291 % 6) + 1 }, "the last value kept"); assert.equal((4294967291 % 6) + 1, 6);
  for (const h of ["0xFFFFFFFC00", "0xFFFFFFFD", "0xfffffffe", "0xFFFFFFFF"]) assert.deepEqual(C.faceFromHash(h), { reject: true }, h);
  for (const bad of ["", null, undefined, 12, "FFFFFFFF00", "0x1234567", "0x"]) assert.deepEqual(C.faceFromHash(bad), { error: "Node hash failed" }, String(bad));
  for (const bad of ["0x12G45678", "0x 1234567", "0x-1234567", "0x1234.678"]) assert.deepEqual(C.faceFromHash(bad), { error: "Node hash unparseable" }, bad + ": a malformed hash is never read as a number");
  const kept = {}; for (let v = 0; v < 256; v++) { const f = C.faceFromByte(v); if (v >= 252) assert.equal(f, 0, "252 and above: another byte"); else kept[f] = (kept[f] || 0) + 1; }
  assert.deepEqual(kept, { 1: 42, 2: 42, 3: 42, 4: 42, 5: 42, 6: 42 }, "the device-only face: each face from exactly 42 of the 252 kept bytes");
  assert.equal(C.hashInput("0xAABB", "0xccdd"), "0xAABBccdd", "CONCAT(a b): the device's value appended to the node's");
});

const A64 = (k) => "0x" + String(k).padStart(64, "A"), BAD = /The node's answer did not match; this roll was not used\./;
test("the node is asked for a random value or the hash of the 64 bytes of one roll, and nothing else", async () => {
  const roll = "0x" + "aB".repeat(64);
  assert.equal(M.command("random"), "random"); assert.equal(M.command("random", "x y"), "random"); assert.equal(M.command("hash", roll), "hash data:" + roll);
  for (const [k, a] of [["hash", roll + " type:sha2"], ["hash", roll + ";quit"], ["hash", roll.slice(2)], ["hash", "0x"], ["hash", ""], ["hash", null], ["hash", "0xAABBccdd"], ["hash", roll.slice(0, -2)], ["hash", roll + "00"], ["hash", roll.slice(0, -1)],
    ["vault", ""], ["seedrandom", "modifier:x"], ["send", "0xAA"], ["constructor", ""]]) assert.equal(M.command(k, a), null, k + " " + a);
  const sent = [], run = (reply) => async (c) => { sent.push(c); return reply; };
  assert.equal(await M.ask("random", undefined, run({ status: true, response: { random: A64(1) } })), A64(1)); assert.equal(await M.ask("hash", roll, run({ status: true, response: { hash: M.sha3(roll) } })), M.sha3(roll));
  assert.deepEqual(sent, ["random", "hash data:" + roll]);
  for (const reply of [null, { status: false }, { status: true }, { status: true, response: { random: 5 } }, { status: true, response: { random: "0xZZ" } }, { status: true, response: { random: "<b>" } },
    { status: true, response: { random: "" } }, { status: true, response: { random: "0x" } }, { status: true, response: { random: "0xABCD" } }, { status: true, response: { random: A64(1) + "00" } }, { status: true, response: { random: A64(1).slice(2) } }])
    assert.equal(await M.ask("random", undefined, run(reply)), "", "a random value that is not 32 bytes of hex is not passed on: " + JSON.stringify(reply));
  await assert.rejects(M.ask("hash", roll + ";quit", run({}))); await assert.rejects(M.ask("vault", "", run({})));
  const mainJs = R("main/main.js"), mod = R("main/entropy.js");
  assert.ok(/ipcMain\.handle\("mcd:entropy", \(_e, kind, arg\) => \{ requireRunning\(\); return entropy\.ask\(kind, arg, \(c\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\)\); \}\);/.test(mainJs));
  assert.ok(!/log\(|console\.|writeFile|appendFile|require\("fs"\)|clipboard/.test(mod), "the main module logs, writes and copies nothing");
});

// 0.19.132 (review, HIGH): the original, and 0.19.130, took the node's word for the hash, so the node chose the face.
test("the node cannot decide a die face: its hash is used only when it is the SHA3-256 the main process worked out itself", async () => {
  assert.equal(M.sha3("0x"), "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a", "SHA3-256 of nothing (FIPS 202)");
  assert.equal(M.sha3("0x616263"), "0x3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532", "SHA3-256 of abc; the same digest main/keyuses.js derives addresses with");
  const roll = "0x" + "01".repeat(32) + "fe".repeat(32), truth = M.sha3(roll), say = (hash) => async () => ({ status: true, response: { hash } });
  assert.equal(await M.ask("hash", roll, say(truth)), truth); assert.equal(await M.ask("hash", roll, say(truth.toUpperCase().replace("0X", "0x"))), truth.toUpperCase().replace("0X", "0x"), "Minima answers in upper case: the same digest in any letter case");
  for (const lie of ["0x00000000" + "00".repeat(28), "0x" + "11".repeat(32), "", "0x", truth.slice(0, -2), truth + "00", truth.slice(2), M.sha3("0x" + "01".repeat(32)), null, 7, { hash: truth }])
    assert.equal(await M.ask("hash", roll, say(lie)), "", "not the digest, so not passed on: " + JSON.stringify(lie));
  assert.equal(await M.ask("hash", roll, async () => ({ status: false, response: { hash: truth } })), "", "a refused command's value is not used");
});

/**
 * The screen's own roll code. o.node: a stand-in NODE behind the real main/entropy.js (random(k) → its random value,
 * hash(k, input, truth) → its hash); o.main: a stand-in for the main process itself. A recording WebCrypto; Math.random throws.
 */
function engine(o) {
  const asked = [], drawn = []; let k = 0;
  const cryptoStub = { getRandomValues: (arr) => { drawn.push(arr.constructor.name + ":" + arr.length); const next = (o.bytes || (() => nodeCrypto.randomBytes(arr.byteLength)))(arr); if (next) new Uint8Array(arr.buffer).set(next); return arr; } };
  const node = async (c) => { if (o.node === "down") throw new Error("node not running"); if (c === "random") return { status: true, response: { random: o.random ? o.random(k) : A64(k) } };
    const input = c.slice("hash data:".length), truth = M.sha3(input); return { status: true, response: { hash: o.hash ? o.hash(k++, input, truth) : (k++, truth.toUpperCase().replace("0X", "0x")) } }; };
  const api = { entropy: async (kind, arg) => { asked.push(kind + (arg ? ":" + arg : "")); return o.main ? o.main(kind, arg, kind === "hash" ? k++ : k) : M.ask(kind, arg, node); } };
  const fns = new Function("api", "crypto", "EntropyCore", "Math", "el", "document", "running", "setTimeout", src.replace(/^"use strict";$/mg, "") + "\nreturn { enRollOne, enRandomN, enVerify, enDeviceSecret, enDeviceFace, entropyNew, EN_NODE_BAD, set: (v) => { EN = v; } };")
    (api, cryptoStub, C, Object.assign(Object.create(Math), { random: () => { throw new Error("Math.random was used"); } }), () => null, { querySelectorAll: () => [] }, o.running !== false, () => 0);
  const EN = fns.entropyNew(); EN.nodeOk = o.node !== "off"; EN.selfErr = null; fns.set(EN);
  return Object.assign(fns, { asked, drawn, EN });
}
const faceOf = (a, b) => { const n = parseInt(M.sha3(a + b.slice(2)).slice(2, 10), 16); return { n, face: (n % 6) + 1 }; };

test("a digital roll: the node's random and 32 WebCrypto bytes; the face is the checked SHA3 of both; both inputs kept for the audit; never Math.random", async () => {
  let e, r; do { e = engine({}); r = await e.enRollOne(); } while (e.asked.length > 2);   // (a rejected value, once in a thousand million, is thrown again: the next test)
  assert.equal(r.audit.src, "node-sha3+device"); assert.match(r.audit.b, /^0x[0-9a-f]{64}$/); assert.equal(r.audit.a, A64(0));
  assert.deepEqual({ n: r.audit.n, face: r.face }, faceOf(r.audit.a, r.audit.b), "the face is n % 6 + 1 of SHA3-256(node 32 bytes ++ device 32 bytes)"); assert.equal(r.audit.face, r.face);
  assert.deepEqual(e.drawn, ["Uint8Array:32"]); assert.deepEqual(e.asked, ["random", "hash:" + r.audit.a + r.audit.b.slice(2)], "the node is given exactly (its value ++ the device's value)");
  const two = engine({}), x = await two.enRollOne(), y = await two.enRollOne(); assert.notEqual(x.audit.b, y.audit.b, "a new device value for every roll");
  assert.equal(e.enDeviceSecret().length, 66);
  // all 32 device bytes count: change the last one and the number changes
  const fixed = (last) => engine({ bytes: () => Buffer.concat([Buffer.alloc(31, 7), Buffer.from([last])]), random: () => A64(0) });
  const p = await fixed(1).enRollOne(), q = await fixed(2).enRollOne(); assert.notEqual(p.audit.n, q.audit.n); assert.deepEqual({ n: q.audit.n, face: q.face }, faceOf(A64(0), "0x" + "07".repeat(31) + "02"));
});

test("a node that answers `hash` with a value of its choosing gets no roll: wrong, constant, empty, and nothing falls back to one source in silence", async () => {
  const one = "0x00000000" + "00".repeat(28);   // would be face 1 on every die if it were believed
  for (const [name, hash] of [["a hash that would make every die a 1", () => one], ["a constant", () => "0x" + "5A".repeat(32)], ["an empty string", () => ""], ["the hash of other bytes", (k, input) => M.sha3(input.slice(0, 66))], ["a short value", (k, i, truth) => truth.slice(0, 10)]]) {
    const e = engine({ hash });
    await assert.rejects(e.enRollOne(), BAD, name); assert.equal(e.EN.faces.length, 0); assert.equal(e.EN.audits.length, 0);
    assert.deepEqual(e.drawn, ["Uint8Array:32"], name + ": no device-only face was drawn in its place");
    assert.deepEqual(await e.enRandomN(), { error: "The node's answer did not match; no word was picked. Try again." }, name + ": the last-word picker picks nothing");
  }
  // five dice at once, one lie among five truthful answers: the whole throw is refused
  const mixed = engine({ hash: (k, i, truth) => (k === 3 ? one : truth) });
  await assert.rejects(Promise.all(Array.from({ length: 5 }, () => mixed.enRollOne())), BAD);
  assert.ok(/if \(why !== EN_NODE_BAD\) return enStatus\("Entropy source error: nothing recorded\. Try again\.", true\);\s*entropyNode\(\);[^\n]*\n\s*return enStatus\(EN_NODE_BAD \+ " Nothing was recorded\.", true\);/.test(src), "the screen says so, records nothing, and proves the node again before the next roll");
  assert.ok(/if \(!got\) \{\s*enStopDice\(1\); EN\.busy = false; EN\.auto = false;/.test(src), "and auto-roll stops");
});

test("the node's random is 32 bytes of hex and never one it gave before: short, empty or repeated, the roll is not used and the device's 32 bytes are never the lesser part", async () => {
  for (const [name, random] of [["empty", () => ""], ["0x alone", () => "0x"], ["one byte", () => "0xAB"], ["31 bytes", () => "0x" + "AB".repeat(31)], ["33 bytes", () => "0x" + "AB".repeat(33)], ["not hex", () => "0x" + "ZZ".repeat(32)], ["no prefix", () => "AB".repeat(32)]]) {
    const e = engine({ random }); await assert.rejects(e.enRollOne(), BAD, name);
    assert.ok(!e.asked.some(a => a.startsWith("hash:")), name + ": nothing was hashed");
  }
  const same = engine({ random: () => A64(9) }), first = await same.enRollOne();
  assert.deepEqual({ n: first.audit.n, face: first.face }, faceOf(A64(9), first.audit.b), "the first use of a value: the face still rests on the 32 device bytes");
  await assert.rejects(same.enRollOne(), BAD, "the same value again");
  const shout = engine({ random: (k) => (k ? A64(9).toLowerCase() : A64(9)) }); await shout.enRollOne(); await assert.rejects(shout.enRollOne(), BAD, "the same value in another letter case");
  // the main-process stand-in: even a main process that passed a short value on would be refused by the screen
  await assert.rejects(engine({ main: (kind) => (kind === "random" ? "0xAB" : "0x00000001" + "00".repeat(28)) }).enRollOne(), BAD);
});

test("\"verified\" rests on the same check: a lying node is never shown as a second source, and its rolls are labelled device only", async () => {
  const good = engine({}); good.EN.nodeOk = false; await good.enVerify(); assert.equal(good.EN.nodeOk, true); assert.equal(good.EN.ready, true);
  assert.equal(good.asked.length, 2); assert.match(good.asked[1], /^hash:0x[0-9A-Fa-f]{128}$/, "one whole node + device hash, as a roll");
  for (const o of [{ hash: () => "0x" + "00".repeat(32) }, { hash: () => "" }, { hash: () => "0x1234567890" }, { random: () => "" }, { random: () => "0xAB" }, { node: "down" }]) {
    const e = engine(o); e.EN.nodeOk = true; await e.enVerify();
    assert.equal(e.EN.nodeOk, false, JSON.stringify(Object.keys(o))); assert.equal(e.EN.ready, true);
    const r = await e.enRollOne(); assert.equal(r.audit.src, "device-only", "what is rolled after that says it had one source");
    assert.equal((await e.enRandomN()).src, "device-only");
  }
  const off = engine({ running: false }); off.EN.nodeOk = true; await off.enVerify(); assert.equal(off.EN.nodeOk, false); assert.deepEqual(off.asked, [], "a stopped node is not asked");
  assert.ok(/set\(true, "BIP39 self-test ✓ node SHA3 \+ device CSPRNG verified"\)/.test(src) && /"the node's answers did not match" : "node commands failed"\) \+ ": device CSPRNG only \(single source\)"/.test(src));
});

test("a rejected value is thrown again with new values on both sides; a source that rejects 26 times, or answers badly, records nothing", async () => {
  const good = (k) => "0x0000000" + (k < 2 ? "0" : "2") + "00".repeat(28);
  const e = engine({ main: (kind, arg, k) => (kind === "random" ? A64(k) : k < 2 ? "0xFFFFFFFC" + "00".repeat(28) : good(k)) }), r = await e.enRollOne();
  assert.equal(r.face, 3); assert.equal(e.asked.filter(a => a === "random").length, 3); assert.equal(e.drawn.length, 3);
  assert.equal(r.audit.a, A64(2), "the audit holds the values of the throw that counted");
  await assert.rejects(engine({ main: (kind, arg, k) => (kind === "random" ? A64(k) : "0xFFFFFFFF" + "00".repeat(28)) }).enRollOne(), /Entropy source misbehaving \(rejection limit\)/);
  await assert.rejects(engine({ main: (kind, arg, k) => (kind === "random" ? A64(k) : "0xZZZZZZZZ00") }).enRollOne(), /Node hash unparseable/);
  await assert.rejects(engine({ node: "down" }).enRollOne(), /node not running/);
});

test("with no node a roll is the device alone, by byte rejection, and is labelled as one source", async () => {
  const bytes = [255, 252, 251, 7]; const e = engine({ node: "off", bytes: () => [bytes.shift()] });
  const r = await e.enRollOne(); assert.deepEqual(r, { face: (251 % 6) + 1, audit: { src: "device-only", a: "", b: "", n: 251 % 6, face: (251 % 6) + 1 } });
  assert.deepEqual(e.asked, [], "the node is not asked"); assert.deepEqual(e.drawn, ["Uint8Array:1", "Uint8Array:1", "Uint8Array:1"], "255 and 252 were thrown away");
  const pickN = await engine({ node: "off" }).enRandomN(); assert.equal(pickN.src, "device-only"); assert.ok(Number.isInteger(pickN.n) && pickN.n >= 0 && pickN.n <= 4294967295);
  const both = engine({ bytes: () => Buffer.alloc(32, 3) }), got = await both.enRandomN(); assert.deepEqual(got, { n: faceOf(A64(0), "0x" + "03".repeat(32)).n, src: "node-sha3+device" });
});

test("what is said under a finished phrase: the counts, the sources, and the two warnings when they apply", () => {
  const nd = (f) => ({ src: "node-sha3+device", a: "0xA", b: "0xB", n: f - 1, face: f }), dev = (f) => ({ src: "device-only", a: "", b: "", n: f - 1, face: f }), ph = (f) => ({ src: "physical", a: "", b: "", n: f - 1, face: f });
  assert.deepEqual(C.summary([1, 2, 3], [nd(1), nd(2), nd(3)], 143, 128, 12), ["3 rolls → 143 unbiased bits → 128 entropy bits + 4-bit SHA-256 checksum = 12 words", "sources: 3 × node SHA3 + device"]);
  assert.deepEqual(C.summary([1, 2], [nd(1), dev(2)], 4, 256, 24).slice(1), ["sources: 1 × node SHA3 + device, 1 × device only", "⚠ some rolls used a single entropy source (node unavailable)"]);
  const fair = [1, 2, 3, 4, 5, 6, 1, 2], lazy = [1, 1, 1, 1, 1, 2, 3, 4], few = [1, 2, 3, 1, 2, 3];
  assert.equal(C.summary(fair, fair.map(ph), 0, 128, 12).length, 2);
  assert.equal(C.summary(lazy, lazy.map(ph), 0, 128, 12)[2], "⚠ roll distribution looks non-random: use a real, fair die"); assert.equal(C.summary(few, few.map(ph), 0, 128, 12)[2], "⚠ roll distribution looks non-random: use a real, fair die");
  assert.equal(C.auditLog([nd(4), dev(2), ph(6)]), "#1 A:0xA B:0xB n:3 face:4\n#2 face:2 (device CSPRNG only)\n#3 face:6 (physical)");
});

test("the phrase stays in the page: no storage, no clipboard, no log, no IPC but the two it needs; concealed until asked, and again on leaving", () => {
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual([...new Set([...code.matchAll(/\bapi\.([A-Za-z]+)/g)].map(m => m[1]))].sort(), ["entropy", "secureScreen"], "the only calls to the main process");
  assert.ok(!/localStorage|sessionStorage|\bstore\(|indexedDB|document\.cookie/.test(code), "nothing is stored");
  assert.ok(!/\bcopy\(|clipboard|data-copy|api\.clip/.test(code), "nothing is put on the clipboard (the original has no copy button)");
  assert.ok(!/console\.|toast\(/.test(code), "nothing is logged or toasted");
  assert.ok(!/Math\.random/.test(code) && !/Math\.random/.test(R("renderer/entropy-core.js")), "no Math.random anywhere, not even for the tumbling faces");
  assert.ok(/crypto\.getRandomValues\(b\)/.test(code) && /new Uint8Array\(32\)/.test(code), "the device's values come from WebCrypto, 32 bytes as the original's SecureRandom");
  assert.ok(/\$\{EN\.revealed \? esc\(w\) : "••••••"\}/.test(code), "a word is in the page only while revealed");
  assert.ok(/EN\.phrase = phrase; EN\.revealed = false;/.test(code), "a new phrase starts concealed");
  assert.ok(/if \(!good\) \{ EN\.done = false; return enStatus\("INTERNAL MISMATCH: phrase suppressed/.test(code), "a phrase our own checker refuses is never shown");
  assert.ok(/function entropyTab\(tab\) \{\s*EN\.tab = tab;\s*if \(EN\.done && EN\.revealed\) \{ EN\.revealed = false; enWords\(\); \}/.test(code), "a tab switch conceals it");
  assert.ok(/function entropyLeave\(\) \{\s*if \(EN && el\("enRoot"\)\) \{ EN\.auto = false; enChips\(\); entropyTab\(EN\.tab\); \}\s*try \{ api\.secureScreen\(false\); \}/.test(code), "leaving the screen stops auto-roll, conceals, and lets the window be captured again");
  assert.ok(/if \(activeView === "entropy" && view !== "entropy"\) entropyLeave\(\);/.test(R("renderer/app.js")));
  assert.ok(/api\.secureScreen\(true\)/.test(code) && /id="enCapture" hidden>This system cannot keep the window out of screenshots/.test(code), "capture protection is asked for on entry, and its absence is said");
  assert.ok(/EN\.run\+\+; EN\.faces = \[\]; EN\.audits = \[\]; EN\.phrase = null;/.test(code), "Wipe drops the rolls, the audit values and the phrase");
  assert.ok(/if \(run !== EN\.run\) return;/.test(code), "a throw that answers after a Wipe is not recorded");
  assert.ok(/if \(EN\.busy \|\| EN\.done \|\| enBlocked\(\)\) return;/.test(code) && /if \(EN\.selfErr\) return lwStatus\("Blocked: startup self-test failed/.test(code), "nothing is generated before the self-test has passed");
  assert.ok(/type="\$\{L\.hidden \? "password" : "text"\}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"/.test(code), "typed seed words are kept from autocomplete and spell-check");
});

test("the screen: the original's wording and palette (no em dash), its icon unchanged, keyboard reachable", () => {
  const css = R("renderer/apps.css"), part = css.slice(css.indexOf("/* ---- Entropy"));
  for (const said of ["ENTROPY", "PROVABLY FAIR BIP39 SEED DICE", "🎲 DICE ROLL", "✓ LAST WORD", "PHRASE LENGTH", "DICE MODE", "Digital (node + device)", "Physical dice", "COLLECT ENTROPY", "Throw 5 dice", "Auto-roll: off", "↺ Undo last", "YOUR SEED PHRASE",
    "VERIFY FAIRNESS", "Show per-roll audit log", "Wipe &amp; start over", "LAST-WORD (CHECKSUM) CALCULATOR", "↺ Clear all", "Calculate valid last words", "VALID LAST WORDS", "🎲 Pick one at random (node + device entropy)", "checking entropy sources…",
    "BIP39 self-test ✓ node SHA3 + device CSPRNG verified", "device CSPRNG only (single source)", "Use a REAL, fair die"]) assert.ok(src.includes(said), said);
  for (const c of ["#0A0E1A", "#121829", "#1A2238", "#2A3550", "#FFD700", "#FF2D78", "#00E5FF", "#35E07A", "#FF3B5C", "#E6A23C", "#EAEAF2", "#8A93AD"]) assert.ok(part.includes(c), "Theme.java's " + c);
  assert.ok(!/—/.test(src.replace(/\/\/[^\n]*/g, "")) && !/—/.test(R("renderer/entropy-core.js").replace(/\/\*[\s\S]*?\*\//g, "")), "no em dash in what is shown");
  assert.ok(/\.en :focus-visible \{ outline: 2px solid #00E5FF/.test(part) && /role="tablist"/.test(src) && /e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"/.test(src));
  assert.ok(/prefers-reduced-motion: reduce\) \{ \.en-die--tumble/.test(part));
  const svg = R("renderer/icons/entropy.svg");
  for (const d of ["M54,27 L81,40.5 L54,54 L27,40.5 Z", "M27,40.5 L54,54 L54,83 L27,69.5 Z", "M54,54 L81,40.5 L81,69.5 L54,83 Z", "M54,27 L81,40.5 L54,54 L27,40.5 Z M27,40.5 L27,69.5 L54,83 L54,54 M81,40.5 L81,69.5 L54,83", "M54,40.5 m-6.2,0 a6.2,3.4 0 1,1 12.4,0 a6.2,3.4 0 1,1 -12.4,0",
    "M37.5,53.5 m-3.4,0 a3.4,3.9 0 1,1 6.8,0 a3.4,3.9 0 1,1 -6.8,0", "M44.5,66.5 m-3.4,0 a3.4,3.9 0 1,1 6.8,0 a3.4,3.9 0 1,1 -6.8,0", "M62,60 m-3.2,0 a3.2,3.7 0 1,1 6.4,0 a3.2,3.7 0 1,1 -6.4,0", "M67.5,64.8 m-3.2,0 a3.2,3.7 0 1,1 6.4,0 a3.2,3.7 0 1,1 -6.4,0",
    "M73,69.6 m-3.2,0 a3.2,3.7 0 1,1 6.4,0 a3.2,3.7 0 1,1 -6.4,0", "M54,86 m-22,0 a22,6 0 1,1 44,0 a22,6 0 1,1 -44,0", "M54,54m-42,0a42,42 0 1,1 84,0a42,42 0 1,1 -84,0", "M54,54m-36,0a36,36 0 1,1 72,0a36,36 0 1,1 -72,0"]) assert.ok(svg.includes('d="' + d + '"'), "the launcher icon's path data: " + d);
  assert.ok(R("renderer/index.html").includes('id="view-entropy"') && require("../main/freeze.js").FREEZABLE.includes("entropy"));
  const order = [...R("renderer/index.html").matchAll(/<script src="([^"]+)"/g)].map(m => m[1]); assert.ok(order.indexOf("wordentry.js") < order.indexOf("entropy-core.js") && order.indexOf("entropy-core.js") < order.indexOf("apps-tools.js"));
});
