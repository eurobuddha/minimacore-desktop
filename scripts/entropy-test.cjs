// Entropy (0.19.130): what it makes is a wallet seed, so the maths is pinned by the ORIGINAL's fixed vectors (Bip39.java
// selfTest and Bip39Test.java of apks/base integrated/entropy, 1c60c2593325f70cba5089e2ba430925d6ccca3c, read, not run),
// the die by its exact rule, and the screen by what it may and may not do with the phrase. Nothing reaches a node.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path"), nodeCrypto = require("crypto");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const C = require("../renderer/entropy-core.js"), WORDS = require("../renderer/wordentry.js").WORDS, M = require("../main/entropy.js");
const R = (f) => { const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); return /^renderer\/[^/]+\.js$/.test(f) ? require("./i18n-plain.cjs").plain(s) : s; };   // a renderer script: as it read before its text was wrapped for translation
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
  const asked = [], drawn = [], secure = [], confirms = [], on = {}, els = new Map(); let k = 0;
  const cryptoStub = { getRandomValues: (arr) => { drawn.push(arr.constructor.name + ":" + arr.length); const next = (o.bytes || (() => nodeCrypto.randomBytes(arr.byteLength)))(arr); if (next) new Uint8Array(arr.buffer).set(next); return arr; } };
  const node = async (c) => { if (o.node === "down") throw new Error("node not running"); if (c === "random") return { status: true, response: { random: o.random ? o.random(k) : A64(k) } };
    const input = c.slice("hash data:".length), truth = M.sha3(input); return { status: true, response: { hash: o.hash ? o.hash(k++, input, truth) : (k++, truth.toUpperCase().replace("0X", "0x")) } }; };
  const api = { entropy: async (kind, arg) => { asked.push(kind + (arg ? ":" + arg : "")); return o.main ? o.main(kind, arg, kind === "hash" ? k++ : k) : M.ask(kind, arg, node); }, secureScreen: (v) => { secure.push(v); return Promise.resolve(true); } };
  // o.dom: every element the screen asks for exists as a plain stand-in; #enRoot (the built screen) only with o.root
  const stub = () => ({ hidden: false, disabled: false, textContent: "", innerHTML: "", className: "", value: "", dataset: {}, style: {}, classList: { toggle() {} }, setAttribute(k2, v) { this["@" + k2] = v; } });
  const el = (id) => { if (!o.dom || (id === "enRoot" && !o.root)) return null; if (!els.has(id)) els.set(id, stub()); return els.get(id); };
  const doc = { hidden: false, querySelectorAll: () => [], addEventListener: (t, f) => { on[t] = f; } }, win = { addEventListener: (t, f) => { on[t] = f; } };
  const showConfirm = (title, message, ok, danger) => new Promise(answer => confirms.push({ title, message, ok, danger, answer }));
  const fns = new Function("api", "crypto", "EntropyCore", "Math", "el", "document", "window", "running", "setTimeout", "showConfirm", "activeView", "esc", src.replace(/^"use strict";$/mg, "")
    + "\nreturn { enRollOne, enRandomN, enVerify, enDeviceSecret, enDeviceFace, entropyNew, entropyErase, entropyErased, entropyLeaving, enIdleTick, enHolds, enWords, enSetLength, enCaptureNote, EN_NODE_BAD, EN_IDLE_MS, set: (v) => { EN = v; }, now: () => EN };")
    (api, cryptoStub, C, Object.assign(Object.create(Math), { random: () => { throw new Error("Math.random was used"); } }), el, doc, win, o.running !== false, () => 0, showConfirm, "balances", (t) => String(t).replace(/[&<>"']/g, "?"));
  const EN = fns.entropyNew(); EN.nodeOk = o.node !== "off"; EN.selfErr = null; fns.set(EN);
  return Object.assign(fns, { asked, drawn, secure, confirms, on, doc, els, el, EN });
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
  assert.ok(/if \(why !== EN_NODE_BAD\) return enStatus\("Entropy source error: nothing recorded\. Try again\.", true\);\s*entropyNode\(\);[^\n]*\n\s*return enStatus\(t\("\{ennodebad\} Nothing was recorded\.", \{ ennodebad: t\(EN_NODE_BAD\) \}\), true\);/.test(src), "the screen says so, records nothing, and proves the node again before the next roll");
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
  assert.ok(/set\(true, "BIP39 self-test ✓ node SHA3 \+ device CSPRNG verified"\)/.test(src) && /t\("\{ennodebad\}: device CSPRNG only \(single source\)", \{ ennodebad: \(e && e\.message === EN_NODE_BAD \? "the node's answers did not match" : "node commands failed"\) \}\)/.test(src));
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

test("the phrase stays in the page: no storage, no clipboard, no log, no IPC but the two it needs; concealed until asked, erased on leaving", () => {
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual([...new Set([...code.matchAll(/\bapi\.([A-Za-z]+)/g)].map(m => m[1]))].sort(), ["entropy", "secureScreen"], "the only calls to the main process");
  assert.ok(!/localStorage|sessionStorage|\bstore\(|indexedDB|document\.cookie/.test(code), "nothing is stored");
  assert.ok(!/\bcopy\(|clipboard|data-copy|api\.clip/.test(code), "nothing is put on the clipboard (the original has no copy button)");
  assert.ok(!/console\.|toast\(/.test(code), "nothing is logged or toasted");
  assert.ok(!/Math\.random/.test(code) && !/Math\.random/.test(R("renderer/entropy-core.js")), "no Math.random anywhere, not even for the tumbling faces");
  assert.ok(/crypto\.getRandomValues\(b\)/.test(code) && /new Uint8Array\(32\)/.test(code), "the device's values come from WebCrypto, 32 bytes as the original's SecureRandom");
  assert.ok(/const p = EN\.phrase \|\| \[\], on = EN\.revealed && !!EN\.phrase;/.test(code) && /\$\{on \? esc\(w\) : "••••••"\}/.test(code), "a word is in the page only while revealed");
  assert.ok(/EN\.phrase = phrase; EN\.revealed = false;/.test(code), "a new phrase starts concealed");
  assert.ok(/if \(!good\) \{ EN\.done = false; return enStatus\("INTERNAL MISMATCH: phrase suppressed/.test(code), "a phrase our own checker refuses is never shown");
  assert.ok(/function entropyTab\(tab\) \{\s*EN\.tab = tab;\s*if \(EN\.done && EN\.revealed\) \{ EN\.revealed = false; enWords\(\); \}/.test(code), "a tab switch conceals it");
  assert.ok(/EN\.run\+\+; EN\.faces = \[\]; EN\.audits = \[\]; EN\.phrase = null;/.test(code), "Wipe drops the rolls, the audit values and the phrase");
  assert.ok(/if \(run !== EN\.run\) return;/.test(code), "a throw that answers after a Wipe is not recorded");
  assert.ok(/if \(EN\.busy \|\| EN\.done \|\| enBlocked\(\)\) return;/.test(code) && /if \(EN\.selfErr\) return lwStatus\(t\("Blocked: startup self-test failed/.test(code), "nothing is generated before the self-test has passed");
  assert.ok(/type="\$\{L\.hidden \? "password" : "text"\}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"/.test(code), "typed seed words are kept from autocomplete and spell-check");
});

// 0.19.133 (review): the phone's note says closing the screen destroys the phrase. 0.19.130 kept it (concealed).
const PHRASE = "wedding crawl scout then coast emotion bridge spot demise together holiday tray".split(" ");
function holding(o) {   // a screen with a finished phrase on it, as the page would hold it
  const e = engine(Object.assign({ dom: true }, o)), EN = e.EN;
  EN.phrase = PHRASE.slice(); EN.faces.push(2, 5, 2, 6); EN.audits.push({ src: "node-sha3+device", a: "0xA", b: "0xB", n: 1, face: 2 }); EN.done = true; EN.revealed = true; EN.seen.add("0xa");
  e.el("entropyBody").innerHTML = "<div>wedding crawl 2526 A:0xA B:0xB</div>";
  return e;
}
const erased = (e) => { const now = e.now(); assert.notEqual(now, e.EN, "a new, empty state");
  assert.equal(e.EN.phrase, null); assert.equal(e.EN.faces.length, 0); assert.equal(e.EN.audits.length, 0); assert.equal(e.EN.seen.size, 0, "the old state holds nothing either (a late answer finds nothing)");
  assert.equal(now.phrase, null); assert.deepEqual(now.faces, []); assert.deepEqual(now.audits, []); assert.equal(now.done, false); assert.equal(now.run, e.EN.run + 1, "a throw still in the air belongs to another run");
  assert.ok(/const was = EN; EN = entropyNew\(\);\n  if \(was\) \{ EN\.run = was\.run; EN\.verified = was\.verified; \}/.test(src), "and the screen drawn again keeps counting from there");
  assert.equal(e.el("entropyBody").innerHTML, "", "the words, the roll string, the audit log, the summary and the typed last-word boxes are out of the page"); };

test("leaving Entropy erases the phrase, the rolls, the audit values and their text; a finished phrase is asked about first, once", async () => {
  const e = holding(); let went = 0; const go = () => { went++; };
  assert.equal(e.entropyLeaving(go), false, "not yet: the user is asked"); assert.equal(e.entropyLeaving(go), false); assert.equal(e.confirms.length, 1, "asked once, however many routes fire");
  assert.deepEqual([e.confirms[0].title, e.confirms[0].message, e.confirms[0].ok, e.confirms[0].danger], ["Leave Entropy?", "Leaving erases this phrase. Have you written it down?", "Erase and leave", true]);
  e.confirms[0].answer(false); await null; await null;
  assert.equal(went, 0); assert.deepEqual(e.EN.phrase, PHRASE, "Cancel: nothing is erased and the screen stays"); assert.deepEqual(e.secure, [], "and the window stays protected");
  assert.equal(e.entropyLeaving(go), false); assert.equal(e.confirms.length, 2, "a later attempt asks again");
  e.confirms[1].answer(true); await null; await null;
  assert.equal(went, 1, "then the screen that was asked for is shown"); erased(e);
  assert.equal(e.entropyLeaving(go), true, "selectTab runs again: nothing is held, so it goes on"); assert.deepEqual(e.secure, [false], "and only now may the window be captured again"); assert.equal(e.confirms.length, 2);
  // rolls without a finished phrase, or typed last-word boxes: erased without a question
  const r = engine({ dom: true }); r.EN.faces.push(1, 2, 3); r.EN.audits.push({}, {}, {}); r.el("entropyBody").innerHTML = "123";
  assert.equal(r.enHolds(), true); assert.equal(r.entropyLeaving(go), true); assert.equal(r.confirms.length, 0); erased(r);
  const app = R("renderer/app.js");
  assert.ok(/function selectTab\(view\) \{\n  \/\/[^\n]*\n  if \(activeView === "entropy" && view !== "entropy" && !entropyLeaving\(\(\) => selectTab\(view\)\)\) return;\n/.test(app), "selectTab's first statement: every in-app route (tab, tray row, Back, the overflow menu, a notification) passes it before anything changes");
  assert.equal((app.match(/\bactiveView = /g) || []).length, 2, "the view is changed in selectTab and nowhere else");
});

test("the window hidden or closed, the node stopped, a wallet restore, Hide and Freeze erase without asking", async () => {
  const e = holding(); e.doc.hidden = false; e.on.visibilitychange(); assert.deepEqual(e.EN.phrase, PHRASE, "a visibility event with the window still shown erases nothing");
  e.doc.hidden = true; e.on.visibilitychange(); erased(e); assert.equal(e.confirms.length, 0, "nobody is asked");
  const p = holding(); p.on.pagehide(); erased(p);
  const n = holding(); n.entropyErased("the node stopped."); erased(n); assert.equal(n.confirms.length, 0);
  const app = R("renderer/app.js");
  assert.ok(/if \(wasRunning && !running\) \{[^\n]*entropyErased\("the node stopped\."\);/.test(app), "the node went away");
  assert.ok(/waitingForNode = false;\n    entropyNode\(\);/.test(app), "the node came back: an open screen proves it again (stopped to running, as running to stopped)");
  assert.ok(/async function walletReplaced\(\) \{\n  resetMailState\(\); resetPpState\(\); resetAxState\(\); entropyErased\("the wallet was replaced\."\);/.test(app));
  assert.ok(/const id = sw\.dataset\.hide, now = hiddenApps\(\);\n    if \(id === "entropy"\) entropyErased\("Entropy was hidden\."\);/.test(app) && /const id = sw\.dataset\.freeze; sw\.disabled = true;\n    if \(id === "entropy"\) entropyErased\("Entropy was frozen\."\);/.test(app));
  assert.ok(/if \(open && activeView === "entropy"\) \{ renderEntropy\(\); if \(had\) enStatus\(t\("Everything on this screen was erased: \{why\}", \{ why: why \}\), true\); \}/.test(src), "a screen still open is drawn again, empty, and says why");
});

test("five minutes without input erases, with a countdown through the last minute; a click or a key starts the five minutes again", () => {
  const e = holding({ root: true }), t0 = 1000000, idle = e.el("enIdle"); e.EN.idleAt = t0; idle.hidden = true;
  assert.equal(e.EN_IDLE_MS, 300000);
  e.enIdleTick(t0 + 239000); assert.equal(idle.hidden, true, "four minutes in: nothing is shown yet"); assert.deepEqual(e.EN.phrase, PHRASE);
  e.enIdleTick(t0 + 240000); assert.equal(idle.hidden, false); assert.equal(idle.textContent, "No input for a while. Everything on this screen is erased in 60 s. Click or press a key to keep it.");
  e.enIdleTick(t0 + 299001); assert.equal(idle.textContent, "No input for a while. Everything on this screen is erased in 1 s. Click or press a key to keep it."); assert.deepEqual(e.EN.phrase, PHRASE, "not a second early");
  e.EN.idleAt = t0 + 299500;   // a click (the screen's listener sets this)
  e.enIdleTick(t0 + 300000); assert.deepEqual(e.EN.phrase, PHRASE, "input starts the five minutes again"); assert.equal(idle.hidden, true);
  e.enIdleTick(t0 + 299500 + 300000); erased(e); assert.equal(e.confirms.length, 0);
  // nothing held: nothing to erase, and the clock does not run; dice in the air are not interrupted
  const empty = engine({ dom: true, root: true }); empty.EN.idleAt = t0; empty.enIdleTick(t0 + 900000); assert.equal(empty.now(), empty.EN); assert.equal(empty.EN.idleAt, t0 + 900000);
  const auto = holding({ root: true }); auto.EN.idleAt = t0; auto.EN.auto = true; auto.enIdleTick(t0 + 900000); assert.deepEqual(auto.EN.phrase, PHRASE);
  // rolls alone (no phrase yet) are erased the same way
  const rolls = engine({ dom: true, root: true }); rolls.EN.faces.push(3, 4); rolls.EN.audits.push({}, {}); rolls.EN.idleAt = t0; rolls.el("entropyBody").innerHTML = "34"; rolls.enIdleTick(t0 + 300000); erased(rolls);
  assert.ok(/clearInterval\(EN_TICK\); EN_TICK = setInterval\(\(\) => enIdleTick\(Date\.now\(\)\), 1000\);/.test(src), "once a second while the screen is built");
  assert.ok(/for \(const type of \["pointerdown", "keydown", "input"\]\) root\.addEventListener\(type, \(\) => \{ EN\.idleAt = Date\.now\(\);/.test(src), "any click, key or typed letter on the screen is input");
  assert.ok(/id="enIdle" role="status" hidden>/.test(src));
});

test("while the phrase is concealed, so are the roll string and the audit log", () => {
  const e = holding(); e.EN.revealed = false; e.EN.audit = true; e.enWords();
  const rolls = e.el("enRolls"), audit = e.el("enAudit"), btn = e.el("enAuditBtn"), words = e.el("enWords");
  assert.ok(!/[1-6]/.test(rolls.textContent) && rolls.textContent.includes("reveal the phrase"), "no roll in the page: " + rolls.textContent);
  assert.equal(audit.textContent, ""); assert.equal(e.el("enAuditWrap").hidden, true); assert.equal(e.EN.audit, false, "an open audit log closes when the phrase is concealed");
  assert.equal(btn.disabled, true); assert.equal(btn.textContent, "Per-roll audit log: reveal the phrase first", "the button says why it is off");
  assert.ok(!PHRASE.some(w => words.innerHTML.includes(w)) && words.innerHTML.includes("••••••"));
  e.EN.revealed = true; e.enWords();
  assert.equal(rolls.textContent, "2526"); assert.equal(btn.disabled, false); assert.equal(btn.textContent, "Show per-roll audit log"); assert.equal(audit.textContent, "", "the audit log only when asked for");
  assert.ok(PHRASE.every(w => words.innerHTML.includes(w)));
  e.EN.audit = true; e.enWords(); assert.equal(audit.textContent, "#1 A:0xA B:0xB n:1 face:2"); assert.equal(e.el("enAuditWrap").hidden, false); assert.equal(btn.textContent, "Hide per-roll audit log");
  assert.ok(/function entropyTab\(tab\) \{\s*EN\.tab = tab;\s*if \(EN\.done && EN\.revealed\) \{ EN\.revealed = false; enWords\(\); \}/.test(src), "a tab switch conceals all three");
  assert.ok(/else if \(b\.id === "enAuditBtn"\) \{ EN\.audit = !EN\.audit; enWords\(\); \}/.test(src) && !/enEl\("enRolls"\)\.textContent = EN\.faces/.test(src), "nothing else writes the rolls or the log into the page");
});

test("the phrase length cannot change once a roll exists", () => {
  const e = engine({ dom: true }); assert.equal(e.EN.words, 12);
  assert.equal(e.enSetLength(24), true); assert.equal(e.EN.words, 24, "before the first roll: free");
  e.EN.faces.push(4); e.EN.audits.push({});
  assert.equal(e.enSetLength(12), false); assert.equal(e.EN.words, 24); assert.equal(e.el("enStatus").textContent, "The phrase length cannot change once a roll is recorded. Start over to choose another length.");
  e.el("enStatus").textContent = ""; assert.equal(e.enSetLength(24), false); assert.equal(e.el("enStatus").textContent, "", "the same length again: nothing to say");
  e.EN.faces.length = 0; e.EN.busy = true; assert.equal(e.enSetLength(15), false, "nor while dice are in the air"); assert.equal(e.EN.words, 24);
  assert.ok(/if \(b\.dataset\.len\) enSetLength\(\+b\.dataset\.len\);/.test(src) && /id="enRestart" hidden>↺ Start over \(erases these rolls\)<\/button>/.test(src) && /else if \(b\.id === "enRestart"\) enWipe\(\);/.test(src) && /enEl\("enRestart"\)\.hidden = !EN\.faces\.length \|\| EN\.done;/.test(src), "and Start over is there whenever a roll is");
});

test("the self-test also checks the whole word list by its SHA-256, and the list is frozen", async () => {
  assert.ok(Object.isFrozen(WORDS), "wordentry.js: the list every seed screen uses");
  assert.throws(() => { "use strict"; WORDS[5] = "x"; }, TypeError);
  C.init(WORDS); assert.equal(await C.selfTest(), null);
  const one = WORDS.slice(); one[1000] = one[1000] + "x"; C.init(one); assert.equal(await C.selfTest(), "wordlist digest wrong", "a word no vector uses");
  const swap = WORDS.slice(); [swap[1500], swap[1501]] = [swap[1501], swap[1500]]; C.init(swap); assert.equal(await C.selfTest(), "wordlist digest wrong");
  C.init(WORDS); assert.equal(await C.selfTest(), null);
  assert.ok(/WORDS = Object\.freeze\(words\.slice\(\)\);/.test(R("renderer/entropy-core.js")) && /if \(!Object\.isFrozen\(WORDS\)\) return "wordlist is not frozen";/.test(R("renderer/entropy-core.js")));
});

test("the screen says where a digital roll's values go, and what erases the phrase", () => {
  assert.ok(src.includes(`Digital: each roll's two random values and their hash pass through this app's main process and the node on 127.0.0.1. Whoever could read them there could rebuild the phrase. For a wallet that will hold real value, use Physical dice: real dice never leave this screen.`));
  assert.ok(src.includes("Nothing is stored. Leaving this screen, hiding or closing the window, stopping the node, 5 minutes without input, or Wipe &amp; start over erases the phrase for ever."));
  assert.ok(!/quitting the app, or Wipe/.test(src) && !/sent to the\n\/\/ main process, or put on the clipboard/.test(src), "the old sentence and the old comment are gone");
  assert.ok(/pass through\n\/\/ the main process \(main\/entropy\.js\) and the node on 127\.0\.0\.1/.test(src), "the comment says what the code does");
});

// 0.19.134 (review): the handler answered "protected" for every platform but Linux, whatever happened, and nothing turned it off again.
test("screen capture: the answer is what was set and where; a load, a reload or a crash turns it off; the screen never claims more", () => {
  const S = require("../main/securescreen.js");
  const win = (o) => { const w = { calls: [], on: {}, isDestroyed: () => !!(o && o.destroyed), setContentProtection(v) { if (o && o.throws) throw new Error("no"); w.calls.push(v); }, webContents: { on: (t, f) => { w.on[t] = f; } } }; return w; };
  let w = win(); assert.deepEqual(S.set(w, true, "darwin"), { on: true, platform: "darwin" }); assert.deepEqual(S.set(w, false, "darwin"), { on: false, platform: "darwin" }); assert.deepEqual(w.calls, [true, false]);
  w = win(); assert.deepEqual(S.set(w, true, "win32"), { on: true, platform: "win32" });
  w = win(); for (const v of [1, "true", {}, null, undefined]) assert.equal(S.set(w, v, "darwin").on, false, "only true turns it on"); assert.deepEqual(w.calls, [false, false, false, false, false]);
  w = win(); assert.deepEqual(S.set(w, true, "linux"), { on: false, platform: "linux" }, "Linux has no such switch: nothing is claimed"); assert.deepEqual(w.calls, []);
  assert.deepEqual(S.set(win({ throws: true }), true, "darwin"), { on: false, platform: "darwin" }, "a call that failed set nothing");
  assert.deepEqual(S.set(win({ destroyed: true }), true, "darwin"), { on: false, platform: "darwin" }); assert.deepEqual(S.set(null, true, "darwin"), { on: false, platform: "darwin" });
  w = win(); S.watch(w, "darwin"); assert.deepEqual(Object.keys(w.on).sort(), ["did-finish-load", "render-process-gone"]);
  S.set(w, true, "darwin"); w.on["did-finish-load"](); assert.deepEqual(w.calls, [true, false], "a page loaded or reloaded: off");
  S.set(w, true, "darwin"); w.on["render-process-gone"](); assert.deepEqual(w.calls, [true, false, true, false], "the renderer crashed: off");
  const mainJs = R("main/main.js");
  assert.ok(/ipcMain\.handle\("mcd:secureScreen", \(_e, on\) => secureScreen\.set\(win, on\)\);/.test(mainJs) && /secureScreen\.watch\(win\);[^\n]*\n  win\.loadFile\(/.test(mainJs), "main: the switch and nothing else, watched from before the first page loads");
  assert.ok(!/setContentProtection/.test(mainJs), "one place sets it");
  const e = engine({}), may = "This window may still be captured by screen recording. Make sure nothing is recording the screen.";
  assert.equal(e.enCaptureNote({ on: true, platform: "darwin" }), "Asked the system to keep this window out of screen captures. That was not confirmed here: make sure nothing is recording the screen.");
  assert.equal(e.enCaptureNote({ on: true, platform: "win32" }), e.enCaptureNote({ on: true, platform: "darwin" }));
  for (const r of [{ on: false, platform: "linux" }, { on: true, platform: "linux" }, { on: false, platform: "darwin" }, null, undefined, true, false, { on: "yes", platform: "darwin" }]) assert.equal(e.enCaptureNote(r), may, JSON.stringify(r));
  assert.ok(!/protected|is kept out of|cannot be captured/i.test(e.enCaptureNote({ on: true, platform: "darwin" })), "asked, never promised");
  assert.ok(/<div class="en-banner" id="enCapture" role="status">\$\{esc\(enCaptureNote\(null\)\)\}<\/div>/.test(src), "the banner is always shown, and says 'may still be captured' until the main process has answered");
  assert.ok(/try \{ api\.secureScreen\(true\)\.then\(capture, \(\) => capture\(null\)\); \} catch \(e\) \{ capture\(null\); \}/.test(src));
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
