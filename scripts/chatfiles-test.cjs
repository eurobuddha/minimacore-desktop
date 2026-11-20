/*
 * chatfiles-test.cjs — KeetChat file transfers and voice-note rules (main/chatfiles.js, main/chatvoice.js).
 * These two modules are ports of the phone's Java; the phone is the other end of every transfer, so the
 * tests pin the bytes: the offer ref, the AES-GCM record framing, the manifest, the control messages.
 *
 * Where the expectations come from:
 *   [java]    ported from a Java unit test, same fixtures and same assertions:
 *             maxima/core/src/junit/.../files/FileDeliveryTest.java, files/KeetsFilesTest.java,
 *             core/chat/KeetsMediaClientTest.java, core/chat/KeetsRefGuardTest.java,
 *             apks/base/app/src/test/.../chat/ChatFilesTest.java
 *   [derived] the Java tests use random keys and assert round-trips only (no fixed ciphertext, ref or
 *             manifest bytes), so these literals were worked out from the Java rules (ChatFile.ref,
 *             Json.Writer, FileCrypto.cipher, KeetsFiles.publish) and are built here a SECOND way,
 *             independent of the code under test. No Java or gradle was run.
 *
 * Hermetic: temp dirs only, a fake node-command runner and a fake loopback http function; no-reach.cjs
 * makes any socket or child process throw.
 *
 * Run: node --test scripts/chatfiles-test.cjs
 */
const reach = require("./no-reach.cjs").install();
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cf = require("../main/chatfiles");
const voice = require("../main/chatvoice");
const schema = require("../main/chatschema");

const temps = [];
const tmpdir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "chatfiles-" + tag + "-")); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); assert.deepEqual(reach.reached, [], "nothing outside the process was reached"); });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

// the fixtures of ChatFilesTest.offer() / FileDeliveryTest.file()
const ID = "a".repeat(32), KEY = "b".repeat(64), NONCE = "c".repeat(16), DIGEST = "d".repeat(64);
const TORRENT = "keets://" + "e".repeat(64) + "/private/" + ID + "/manifest?hash=" + "f".repeat(64);
const offer = () => cf.chatFile(ID, "test file.bin", "application/octet-stream", 100 * 1024 * 1024, KEY, NONCE, DIGEST, TORRENT);
// KeetsFilesTest.input(size): byte at position p = (p*31+7) & 255
const pattern = (size, salt = 7) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 31 + salt) & 255; return b; };
const PEER = "0x" + "1".repeat(64);

// ---- the offer ref ---------------------------------------------------------------------------------
test("[derived] ref string is pf1: + unpadded base64url of the ordered flat JSON, every value a string", () => {
  const f = offer();
  const json = '{"v":"1","id":"' + ID + '","name":"test file.bin","mime":"application/octet-stream","size":"104857600","key":"' + KEY
    + '","nonce":"' + NONCE + '","digest":"' + DIGEST + '","torrent":"' + TORRENT + '"}';
  assert.equal(f.ref, "pf1:" + Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  assert.ok(f.ref.startsWith("pf1:eyJ2IjoiMSIsImlkIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJuYW1lIjoidGVzdCBmaWxlLmJpbiIs"), "pinned prefix");
  assert.equal(sha(f.ref), REF_SHA, "pinned whole-ref digest");
  const back = cf.parseRef(f.ref);
  assert.deepEqual(back, f);
  assert.equal(back.ref, f.ref, "parse then ref is the identity (the phone compares the two strings)");
  cf.validate(back);
});
const REF_SHA = "e40f0729ffd26149b34b21dcebfae451b517b0b1fefbda1e870f94416a391403";

test("[derived] Json.Writer escapes: quote, backslash-free names, non-ASCII stays raw UTF-8", () => {
  assert.equal(cf.jsonWrite([["a", 'x"y'], ["b", "tab\there"], ["c", "\u0001"], ["d", "é/ü"], ["n", "5", true]]),
    '{"a":"x\\"y","b":"tab\\there","c":"\\u0001","d":"é/ü","n":5}');
  assert.deepEqual({ ...cf.jsonParse(' {"a":"x\\"y", "n":5,"t":true,"u":"\\u00e9"} ') }, { a: 'x"y', n: "5", t: "true", u: "é" });
  assert.throws(() => cf.jsonParse('{"a":{"b":1}}'), /Nested/);
  assert.throws(() => cf.jsonParse("[1]"));
  const f = cf.chatFile(ID, 'ré "sumé".pdf', "application/pdf", 3, KEY, NONCE, DIGEST, "");
  assert.equal(cf.parseRef(f.ref).name, 'ré "sumé".pdf');
});

test("offer validation: ChatFile constructor and parse rules", () => {
  const bad = (over) => { const a = Object.assign({ id: ID, name: "n", mime: "m", size: 1, key: KEY, nonce: NONCE, digest: DIGEST, torrent: "" }, over);
    assert.throws(() => cf.chatFile(a.id, a.name, a.mime, a.size, a.key, a.nonce, a.digest, a.torrent), /Invalid private file offer/, JSON.stringify(over)); };
  for (const name of ["", ".", "..", "a/b", "a\\b", "a\nb", "a\u007fb", "x".repeat(241)]) bad({ name });
  bad({ id: "A".repeat(32) }); bad({ id: "a".repeat(31) }); bad({ size: -1 }); bad({ size: cf.MAX_BYTES + 1 }); bad({ size: 1.5 });
  bad({ mime: "x".repeat(161) }); bad({ mime: "a\tb" }); bad({ key: "b".repeat(63) }); bad({ nonce: "c".repeat(17) }); bad({ digest: "D".repeat(64) });
  bad({ torrent: "t".repeat(32769) }); bad({ torrent: null });
  cf.chatFile(ID, "x".repeat(240), "", cf.MAX_BYTES, KEY, NONCE, DIGEST, "");   // the bounds themselves are accepted
  assert.throws(() => cf.parseRef("pf2:abc"), /Unsupported file offer/);
  assert.throws(() => cf.parseRef(null), /Unsupported file offer/);
  assert.throws(() => cf.parseRef("pf1:" + "A".repeat(65536)), /Unsupported file offer/);
  assert.throws(() => cf.parseRef("pf1:not base64!"), /Invalid private file offer/);
  const enc = (o) => "pf1:" + Buffer.from(JSON.stringify(o)).toString("base64url");
  const fields = { v: "1", id: ID, name: "n", mime: "m", size: "1", key: KEY, nonce: NONCE, digest: DIGEST, torrent: "" };
  assert.equal(cf.parseRef(enc(fields)).size, 1);
  assert.equal(cf.parseRef(enc({ ...fields, size: 1 })).size, 1, "an unquoted number parses, as in the flat Java reader");
  assert.throws(() => cf.parseRef(enc({ ...fields, v: "2" })), /Invalid private file offer/);
  assert.throws(() => cf.parseRef(enc({ ...fields, size: "1e3" })), /Invalid private file offer/);
  const { torrent, ...missing } = fields;
  assert.throws(() => cf.parseRef(enc(missing)), /Invalid private file offer/);
});

test("[java KeetsFilesTest] an offer without a keets manifest is not downloadable, and oversize is rejected", () => {
  assert.throws(() => cf.validate(cf.chatFile(ID, "n", "m", 1, KEY, NONCE, DIGEST, "")), /Invalid Keets file offer/);
  assert.throws(() => cf.validate(cf.chatFile(ID, "n", "m", cf.TRANSFER_MAX_BYTES + 1, KEY, NONCE, DIGEST, TORRENT)), /Invalid Keets file offer/);
  const other = "9".repeat(32);
  assert.throws(() => cf.validate(cf.chatFile(ID, "n", "m", 1, KEY, NONCE, DIGEST, TORRENT.replace(ID, other))), /Invalid Keets file offer/, "manifest of another id");
  assert.throws(() => cf.validate(cf.chatFile(ID, "n", "m", 1, KEY, NONCE, DIGEST, TORRENT + " action:publish")), /Invalid Keets file offer/);
  assert.equal(cf.inboundOffer("pf1:junk"), null);
  assert.equal(cf.inboundOffer(offer().ref).name, "test file.bin");
});

test("[java ChatFilesTest] the chat wire decoder preserves the file offer exactly", () => {
  const f = offer();
  const wire = cf.fileMessage(f, "sender", 1700000000000);
  assert.deepEqual(JSON.parse(wire), { application: "maxima_chat_v1", id: "kf-" + ID, body: "test file.bin", name: "sender", ts: 1700000000000, ref: f.ref, state: "file" });
  const d = schema.chatDecode(wire);
  assert.equal(d.state, "file"); assert.equal(d.ref, f.ref); assert.equal(d.body, f.name); assert.equal(d.id, "kf-" + ID);
  cf.validate(cf.parseRef(d.ref));
  // the reverse direction (KeetsFilesTest): a payload written by the Java flat writer
  const reverse = cf.jsonWrite([["application", "maxima_chat_v1"], ["id", "keetchat-reverse"], ["body", f.name], ["name", "KeetChat"], ["state", "file"], ["ref", f.ref], ["ts", "2"]]);
  assert.equal(cf.inboundOffer(schema.chatDecode(reverse).ref).ref, f.ref);
});

// ---- FileCrypto ------------------------------------------------------------------------------------
test("[derived] cipherSize: 16 bytes of tag per 1 MiB record, one record even for an empty file", () => {
  assert.equal(cf.cipherSize(0), 16); assert.equal(cf.cipherSize(1), 17);
  assert.equal(cf.cipherSize(cf.PLAIN_PIECE), cf.PIECE); assert.equal(cf.cipherSize(cf.PLAIN_PIECE + 1), cf.PLAIN_PIECE + 1 + 32);
  assert.equal(cf.cipherSize(200000), 200016);
  assert.equal(cf.cipherSize(cf.TRANSFER_MAX_BYTES), 104859216);   // 101 records
});

test("[derived] AES-256-GCM record: iv = nonce || index, aad = id || size(8) || index(4), tag appended", () => {
  const plain = pattern(40), size = 40, index = 3;
  // built a second way: straight hex concatenation of the Java ByteBuffer layout
  const iv = Buffer.from(NONCE + "00000003", "hex"), aad = Buffer.from(ID + "0000000000000028" + "00000003", "hex");
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv); c.setAAD(aad);
  const expected = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const record = cf.sealRecord(plain, ID, size, KEY, NONCE, index);
  assert.equal(record.toString("hex"), expected.toString("hex"));
  assert.equal(record.length, 56);
  assert.equal(record.toString("hex"), RECORD_HEX, "pinned record");
  assert.deepEqual(cf.openRecord(record, ID, size, KEY, NONCE, index), plain);
  assert.throws(() => cf.openRecord(record, ID, size, KEY, NONCE, index + 1), "a record cannot be replayed at another index");
  assert.throws(() => cf.openRecord(record, ID, size + 1, KEY, NONCE, index), "nor inside a file of another length");
  assert.throws(() => cf.openRecord(record, "9".repeat(32), size, KEY, NONCE, index), "nor in another transfer");
  assert.equal(cf.sealRecord(Buffer.alloc(0), ID, 0, KEY, NONCE, 0).toString("hex"), EMPTY_HEX, "pinned empty-file record (tag only)");
});
const RECORD_HEX = "1a10e58760f182e3ed0cbf8b910c3beb8ac4588d52c503b0284b73d11331a6eeac2c199b8c2d255e55e339d1b9a04d236ca374d8f7a1f501", EMPTY_HEX = "ad91e59c5c674afed5f8562d858597b2";

test("encrypt streams records, returns the plaintext digest, and refuses a source that changed or is too big", async () => {
  const dir = tmpdir("crypto"), size = cf.PLAIN_PIECE + 5, data = pattern(size);
  const src = path.join(dir, "src.bin"), payload = path.join(dir, "payload.bin");
  fs.writeFileSync(src, data);
  const seen = [];
  const digest = await cf.encrypt(src, payload, ID, size, KEY, NONCE, () => false, (n) => seen.push(n));
  assert.equal(digest, sha(data)); assert.deepEqual(seen, [cf.PLAIN_PIECE, size]);
  const out = fs.readFileSync(payload);
  assert.equal(out.length, cf.cipherSize(size));
  assert.deepEqual(out.subarray(0, cf.PIECE), cf.sealRecord(data.subarray(0, cf.PLAIN_PIECE), ID, size, KEY, NONCE, 0));
  assert.deepEqual(out.subarray(cf.PIECE), cf.sealRecord(data.subarray(cf.PLAIN_PIECE), ID, size, KEY, NONCE, 1));
  await rejects(cf.encrypt(src, payload, ID, size, KEY, NONCE), /EEXIST/);   // CREATE_NEW: never overwrite a payload
  const f = cf.chatFile(ID, "n", "m", size, KEY, NONCE, digest, "");
  await cf.decrypt(payload, path.join(dir, "verified.bin"), f, () => false);
  assert.deepEqual(fs.readFileSync(path.join(dir, "verified.bin")), data);
  // wrong digest in the offer: every record authenticates, the whole-file digest does not
  await rejects(cf.decrypt(payload, path.join(dir, "v2.bin"), cf.chatFile(ID, "n", "m", size, KEY, NONCE, DIGEST, ""), () => false), /File verification failed/);
  assert.ok(!fs.existsSync(path.join(dir, "v2.bin")));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".verifying-")), [], "no temp plaintext left behind");
  // source grew / shrank after its size was read
  await rejects(cf.encrypt(src, path.join(dir, "p2.bin"), ID, size - 1, KEY, NONCE), /File changed while preparing it/);
  await rejects(cf.encrypt(src, path.join(dir, "p2.bin"), ID, size + 1, KEY, NONCE), /Incomplete file/);
  assert.ok(!fs.existsSync(path.join(dir, "p2.bin")), "a failed encrypt deletes its target");
  await rejects(cf.encrypt(src, path.join(dir, "p3.bin"), ID, cf.TRANSFER_MAX_BYTES + 1, KEY, NONCE), /Choose a file up to 100 MB/);
  await rejects(cf.encrypt(src, path.join(dir, "p4.bin"), ID, size, KEY, NONCE, () => true), /Transfer paused/);
});

// ---- KeetsFiles ------------------------------------------------------------------------------------
/** KeetsFilesTest.Mesh: real byte storage, the Android IPC limit asserted on every publish. */
function mesh() {
  const store = new Map(), drive = "keets://" + "a".repeat(64);
  const m = { store, drive, fetches: 0, corrupt: false, paths: [],
    async send() { throw new Error("File bytes must not use messaging/mailboxes"); },
    async publish(p, bytes) {
      assert.ok(bytes.length * 2 + 2 <= 240000, "fits existing Android IPC");
      store.set(p, Buffer.from(bytes)); m.paths.push(p);
      return drive + p + "?hash=" + sha(bytes);
    },
    async fetch(url, max) {
      m.fetches++;
      const p = url.substring(drive.length, url.indexOf("?")), bytes = store.get(p);
      if (!bytes) throw new Error("missing"); if (bytes.length > max) throw new Error("too large");
      const out = Buffer.from(bytes); if (m.corrupt && !p.endsWith("manifest")) out[0] ^= 1; return out;
    } };
  return m;
}
async function prepared(dir, size) {
  const id = cf.randomHex(16), key = cf.randomHex(32), nonce = cf.randomHex(8), src = path.join(dir, "source.bin");
  fs.writeFileSync(src, pattern(size));
  const digest = await cf.encrypt(src, path.join(dir, "payload.bin"), id, size, key, nonce, () => false, () => {});
  return cf.chatFile(id, "large test.bin", "application/octet-stream", size, key, nonce, digest, "");
}

test("[java KeetsFilesTest, at 5 MiB instead of 100 MiB] resumes verified blocks across a restart and round-trips", async () => {
  const source = tmpdir("src"), dest = tmpdir("dst"), m = mesh(), size = 5 * 1024 * 1024 + 123;
  const f = await prepared(source, size);
  const published = await cf.publish(m, path.join(source, "payload.bin"), f, () => false, () => {});
  const blocks = Math.ceil(cf.cipherSize(size) / cf.BLOCK);
  assert.deepEqual(m.paths, [...Array(blocks).keys()].map((i) => "/private/" + f.id + "/" + i).concat("/private/" + f.id + "/manifest"));
  for (const p of m.paths) assert.match(p, cf.PATH_RE);
  cf.validate(published);
  // [derived] the manifest bytes, written a second way
  const hashes = [...Array(blocks).keys()].map((i) => sha(m.store.get("/private/" + f.id + "/" + i)));
  const manifest = '{"v":"1","id":"' + f.id + '","size":"' + cf.cipherSize(size) + '","block":"114688","hashes":"' + hashes.join("\\n") + '"}';
  assert.equal(m.store.get("/private/" + f.id + "/manifest").toString(), manifest);
  assert.equal(published.torrent, m.drive + "/private/" + f.id + "/manifest?hash=" + sha(manifest));
  const received = cf.inboundOffer(schema.chatDecode(cf.fileMessage(published, "sender", 1)).ref);
  assert.equal(received.ref, published.ref);
  let pause = false;
  await rejects(cf.download(m, received, dest, () => pause, (n) => { if (n >= 4 * cf.BLOCK) pause = true; }), /Transfer paused/);
  assert.ok(!fs.existsSync(path.join(dest, "verified.bin")));
  const before = m.fetches;
  await cf.download(m, received, dest, () => false, () => {});
  assert.equal(m.fetches - before, 1 + blocks - 4, "manifest plus only missing blocks");
  assert.equal(sha(fs.readFileSync(path.join(dest, "verified.bin"))), received.digest);
  assert.deepEqual(fs.readFileSync(path.join(dest, "verified.bin")), pattern(size));
});

test("[java KeetsFilesTest] an empty file is authenticated, and parsing an offer never downloads", async () => {
  const source = tmpdir("empty"), dest = tmpdir("empty-recv"), m = mesh();
  const f = await cf.publish(m, path.join(source, "payload.bin"), await prepared(source, 0), () => false, () => {});
  assert.equal(fs.statSync(path.join(source, "payload.bin")).size, 16);
  cf.inboundOffer(f.ref); assert.equal(m.fetches, 0);
  await cf.download(m, f, dest, () => false, () => {});
  assert.equal(fs.statSync(path.join(dest, "verified.bin")).size, 0);
});

test("[java KeetsFilesTest] corrupt ciphertext never creates plaintext and can retry", async () => {
  const source = tmpdir("corrupt"), dest = tmpdir("corrupt-recv"), m = mesh();
  const f = await cf.publish(m, path.join(source, "payload.bin"), await prepared(source, 200000), () => false, () => {});
  m.corrupt = true;
  await rejects(cf.download(m, f, dest, () => false, () => {}), /File block verification failed/);
  assert.ok(!fs.existsSync(path.join(dest, "verified.bin")));
  m.corrupt = false;
  await cf.download(m, f, dest, () => false, () => {});
  assert.equal(sha(fs.readFileSync(path.join(dest, "verified.bin"))), f.digest);
});

test("publish refuses a node that does not confirm the block, and download refuses a wrong manifest", async () => {
  const source = tmpdir("confirm"), m = mesh(), f = await prepared(source, 1000);
  const liar = { publish: async (p) => m.drive + p + "?hash=" + "0".repeat(64) };
  await rejects(cf.publish(liar, path.join(source, "payload.bin"), f), /Keets did not confirm the encrypted block/);
  let n = 0;
  const mover = { publish: async (p, b) => "keets://" + String(n++).repeat(64) + p + "?hash=" + sha(b) };
  const two = tmpdir("confirm2"), g = await prepared(two, 200000);
  await rejects(cf.publish(mover, path.join(two, "payload.bin"), g), /Keets node changed during upload/);
  const pub = await cf.publish(m, path.join(source, "payload.bin"), f);
  const wrong = Buffer.from(cf.jsonWrite([["v", "1"], ["id", f.id], ["size", "999"], ["block", "114688"], ["hashes", "0".repeat(64)]]));
  const t = cf.chatFile(f.id, f.name, f.mime, f.size, f.key, f.nonce, f.digest, pub.torrent.replace(/hash=.*/, "hash=" + sha(wrong)));
  await rejects(cf.download({ fetch: async () => wrong }, t, tmpdir("wrong")), /Invalid Keets file manifest/);
});

// ---- KeetsMediaClient ------------------------------------------------------------------------------
const TOKEN = "a".repeat(64), URL1 = "keets://" + "b".repeat(64) + "/private/test?hash=" + "c".repeat(64);
test("[java KeetsMediaClientTest] the request is bound to the sidecar and the size limit is enforced", async () => {
  const hits = [];
  const client = cf.mediaClient(20000, TOKEN, async (r) => { hits.push(r); return { status: 200, body: Buffer.alloc(5) }; });
  await rejects(client.fetch(URL1, 4), /size limit/);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].headers["x-keets-token"], TOKEN); assert.equal(hits[0].headers["Accept-Encoding"], "identity");
  assert.equal(hits[0].method, "GET"); assert.equal(hits[0].port, 20000); assert.equal(hits[0].max, 4);
  // [derived] java.net.URLEncoder form of the url
  assert.equal(hits[0].path, "/media?url=keets%3A%2F%2F" + "b".repeat(64) + "%2Fprivate%2Ftest%3Fhash%3D" + "c".repeat(64) + "&maxbytes=4");
  assert.equal(cf.urlEncode("a b*c~d.e-f_g/é"), "a+b*c%7Ed.e-f_g%2F%C3%A9");
});
test("[java KeetsMediaClientTest] a redirect is an error and is never followed", async () => {
  const hits = [];
  const client = cf.mediaClient(20000, TOKEN, async (r) => { hits.push(r.path); return { status: 302, body: Buffer.alloc(0) }; });
  await rejects(client.fetch(URL1, 4), /File block unavailable/);
  assert.equal(hits.length, 1);
});
test("media client: bad port/token, 401, the sidecar's own error text, request bounds, sharing and forget", async () => {
  assert.throws(() => cf.mediaClient(80, TOKEN), /Keets is starting/);
  assert.throws(() => cf.mediaClient(20000, "A".repeat(64)), /Keets is starting/);
  const reply = (status, body) => cf.mediaClient(20000, TOKEN, async () => ({ status, body: Buffer.from(body) }));
  await rejects(reply(401, "").fetch(URL1, 4), /Keets restarted; tap Resume/);
  await rejects(reply(404, '{"error":"not shared by the sender"}').fetch(URL1, 4), /not shared by the sender/);
  await rejects(reply(200, "").fetch(URL1, cf.FETCH_MAX + 1), /Invalid Keets media request/);
  await rejects(reply(200, "").fetch("keets://x y", 4), /Invalid Keets media request/);
  const posts = [];
  const client = cf.mediaClient(20000, TOKEN, async (r) => { posts.push(r); return { status: 200, body: Buffer.from(r.path === "/private-forget" ? '{"forgotten":true}' : '{"sharing":false}') }; });
  await client.sharing(offer(), false);
  assert.equal(posts[0].method, "POST"); assert.equal(posts[0].path, "/private-sharing");
  assert.equal(posts[0].body.toString(), '{"url":"' + TORRENT + '","sharing":"false"}');
  await rejects(client.sharing(offer(), true), /Node did not confirm file sharing state/);
  await client.forget(offer());
  assert.equal(posts[2].body.toString(), '{"url":"' + TORRENT + '"}');
  // the token file: <data dir>/keets/apitoken, at most 128 bytes
  const data = tmpdir("token"); fs.mkdirSync(path.join(data, "keets"));
  fs.writeFileSync(path.join(data, "keets", "apitoken"), TOKEN + "\n");
  await cf.mediaClientLocal(20000, data, async () => ({ status: 200, body: Buffer.from("ok") })).fetch(URL1, 4);
  fs.writeFileSync(path.join(data, "keets", "apitoken"), "x".repeat(129));
  assert.throws(() => cf.mediaClientLocal(20000, data), /Invalid Keets node directory/);
  assert.throws(() => cf.mediaClientLocal(20000, "relative/dir"));
});
test("[java KeetsRefGuardTest] validRef: one token, no whitespace", () => {
  assert.ok(cf.validRef("keets://abc123/chat/vn-1760000000000.ogg")); assert.ok(cf.validRef("keets://0a1b2c3d/img-1.jpg?x=1"));
  for (const bad of ["keets://x action:publish path:/loot file:/data/data/n/files/keys", "keets://x\naction:publish", "keets://x\taction:publish",
    null, "", "keets://", "http://evil/keets://x", " keets://x"]) assert.ok(!cf.validRef(bad), String(bad));
});

// ---- FileDelivery ----------------------------------------------------------------------------------
const dfile = () => cf.chatFile(ID, "test.bin", "application/octet-stream", 0, KEY, NONCE, DIGEST, "");
const control = (kind, digest) => cf.jsonWrite([["v", "1"], ["id", ID], ["digest", digest], ["kind", kind]]);

test("[derived] control message bodies and the file-control chat payload", () => {
  assert.equal(cf.controlBody(ID, DIGEST, "hello"), '{"v":"1","id":"' + ID + '","digest":"' + DIGEST + '","kind":"hello"}');
  const wire = cf.fileControl(control("complete", DIGEST), 1700000000000);
  assert.match(wire, new RegExp('^\\{"application":"maxima_chat_v1","id":"pn-1700000000000-[0-9a-f]{1,8}","body":"\\{\\\\"v\\\\":\\\\"1\\\\",.*\\}","name":"","ts":1700000000000,"state":"file-control"\\}$'));
  const d = schema.chatDecode(wire);
  assert.equal(d.state, "file-control"); assert.equal(d.body, control("complete", DIGEST)); assert.equal(d.ts, 1700000000000);
  assert.throws(() => cf.fileControl("x".repeat(1025)), /Invalid file control/);
});

test("[java FileDeliveryTest] a verified receipt retries after a restart and acknowledges duplicates", async () => {
  const f = dfile(), a = tmpdir("receipt-sender"), b = tmpdir("receipt-receiver");
  let stops = 0; const sent = [];
  const sender = cf.createDelivery(async (p, c) => { sent.push(c); }, async () => { stops++; }); sender.register(f, a, true, ["bob"]);
  let receiver = cf.createDelivery(async () => {}, async () => {}); receiver.register(f, b, false, ["alice"]);
  await receiver.tick(); assert.equal(sender.status(f.id).downloaded, "0");
  receiver.verified(f.id); await receiver.tick();   // lost receipt
  receiver = cf.createDelivery(async (p, c) => sender.inbound("bob", c), async () => {}); receiver.register(f, b, false, ["alice"]);
  await receiver.tick(); await sender.tick();
  assert.equal(stops, 1); assert.equal(sender.status(f.id).sharingStopped, "true");
  sender.inbound("bob", control("complete", f.digest)); await sender.tick(); assert.equal(stops, 1);
  assert.ok(sent.some((x) => x.includes("ack")));
  const restored = cf.createDelivery(async () => {}, async () => { stops++; }); restored.register(f, a, true, ["bob"]); await restored.tick();
  assert.equal(stops, 1); assert.equal(restored.status(f.id).downloaded, "1");
  // [derived] the durable state file, as the Java writes it
  assert.equal(fs.readFileSync(path.join(a, "delivery.json"), "utf8"),
    '{"digest":"' + DIGEST + '","mine":"true","peers":"bob","complete":"false","acked":"false","keep":"false","stopped":"true","capable":"bob","delivered":"bob"}');
});
test("[java FileDeliveryTest] forged receipts cannot stop sharing, and a group waits for every recipient", async () => {
  const f = dfile(); let stops = 0;
  const d = cf.createDelivery(async () => {}, async () => { stops++; });
  d.register(f, tmpdir("receipt-group"), true, ["bob", "carol"]);
  d.inbound("mallory", control("complete", f.digest)); d.inbound("bob", control("complete", "e".repeat(64))); await d.tick(); assert.equal(stops, 0);
  d.inbound("bob", control("complete", f.digest)); await d.tick(); assert.equal(stops, 0);
  d.keep(f.id, true); d.inbound("carol", control("complete", f.digest)); await d.tick(); assert.equal(stops, 0);
  d.keep(f.id, false); await d.tick(); assert.equal(stops, 1);
});
test("[java FileDeliveryTest] re-sends back off until the peer answers", async () => {
  const f = dfile(), sent = [];
  const d = cf.createDelivery(async (p, c) => { sent.push(c); }, async () => {});
  d.register(f, tmpdir("receipt-backoff"), true, ["bob"]);
  const t = 1000000; await d.tick(t); assert.equal(sent.length, 1);
  await d.tick(t + 14000); assert.equal(sent.length, 1); await d.tick(t + 15000); assert.equal(sent.length, 2);
  await d.tick(t + 15000 + 29000); assert.equal(sent.length, 2); await d.tick(t + 15000 + 30000); assert.equal(sent.length, 3);
  await d.tick(t + 45000 + 59000); assert.equal(sent.length, 3); await d.tick(t + 45000 + 60000); assert.equal(sent.length, 4);
  for (let i = 0; i < 10; i++) await d.tick(t + 105000 + i * 600000);
  assert.equal(sent.length, 13);
  d.inbound("bob", control("capable", f.digest));
  const u = t + 105000 + 10 * 600000; await d.tick(u - 300000); assert.equal(sent.length, 13);
  await d.tick(u); assert.equal(sent.length, 14); await d.tick(u + 15000); assert.equal(sent.length, 15);
  assert.equal(sent[0], control("hello", f.digest));
});
test("[java FileDeliveryTest] a receiver that sends nothing does not back off", async () => {
  const f = dfile(), sent = [];
  const d = cf.createDelivery(async (p, c) => { sent.push(c); }, async () => {});
  d.register(f, tmpdir("receipt-quiet"), false, ["alice"]);
  const t = 1000000; for (let i = 0; i < 10; i++) await d.tick(t + i * 600000); assert.equal(sent.length, 0);
  d.verified(f.id); const v = t + 10 * 600000; await d.tick(v); assert.equal(sent.length, 1);
  await d.tick(v + 14000); assert.equal(sent.length, 1); await d.tick(v + 15000); assert.equal(sent.length, 2);
  assert.equal(sent[0], control("complete", f.digest));
});
test("[java FileDeliveryTest] a failed stop is never reported as stopped and will retry", async () => {
  const f = dfile(); let stops = 0;
  const d = cf.createDelivery(async () => {}, async () => { if (stops++ === 0) throw new Error("offline"); });
  d.register(f, tmpdir("receipt-stop"), true, ["bob"]); d.inbound("bob", control("complete", f.digest)); await d.tick();
  assert.equal(d.status(f.id).sharingStopped, "false"); assert.ok("deliveryError" in d.status(f.id));
  await d.tick(); assert.equal(d.status(f.id).sharingStopped, "true");
});

// ---- the state machine: two desktops (or a desktop and a phone) over one fake mesh -------------------
const ALICE = "0x" + "a1".repeat(32), BOB = "0x" + "b0".repeat(32);
function party(name, pubkey, net, over = {}) {
  const root = path.join(tmpdir(name), "chat-files"), data = tmpdir(name + "-node"), pub = tmpdir(name + "-pub");
  fs.mkdirSync(path.join(data, "keets")); fs.writeFileSync(path.join(data, "keets", "apitoken"), TOKEN);
  const drive = "keets://" + sha(name);
  const p = { root, pubkey, cmds: [], sent: [], messages: [], statuses: [], contacts: new Set(), info: { pubkey, apiport: 20000, boundedMedia: true }, http: [] };
  p.nodeCmd = async (cmd) => {
    p.cmds.push(cmd);
    if (cmd === "keets action:info") return p.info;
    if (cmd === "status") return { data };
    let m;
    if ((m = /^keets action:publish path:(\S+) file:(\S+)$/.exec(cmd))) {
      assert.ok(m[2].startsWith(pub + path.sep), "block hand-off file is in the temp dir given");
      const bytes = fs.readFileSync(m[2]); net.files.set(drive + m[1], bytes);
      return { url: drive + m[1] + "?hash=" + sha(bytes) };
    }
    if ((m = /^keets action:send to:(0x[0-9a-f]{64}) datahex:0x([0-9A-F]+)$/.exec(cmd))) {
      if (p.sendFails) throw new Error("peer unreachable");
      p.sent.push({ to: m[1], payload: Buffer.from(m[2], "hex").toString("utf8") });
      return { delivered: "direct" };
    }
    throw new Error("unexpected node command: " + cmd);
  };
  const httpFn = async (r) => {
    p.http.push(r.method + " " + r.path.split("?")[0]);
    assert.equal(r.headers["x-keets-token"], TOKEN); assert.equal(r.port, 20000);
    if (r.method === "GET") {
      const q = new URLSearchParams(r.path.slice(r.path.indexOf("?") + 1)), url = q.get("url");
      const manifestUrl = url.replace(/\/[0-9]+\?hash=.*$/, "/manifest");
      const bytes = net.files.get(url.split("?")[0]);
      if (!bytes || [...net.stopped].some((s) => s.startsWith(manifestUrl.split("?")[0]))) return { status: 404, body: Buffer.from('{"error":"file is not being shared"}') };
      if (bytes.length > Number(q.get("maxbytes"))) return { status: 413, body: Buffer.from('{"error":"too large"}') };
      return { status: 200, body: Buffer.from(bytes) };
    }
    const body = JSON.parse(r.body.toString());
    if (r.path === "/private-sharing") { if (body.sharing === "true") net.stopped.delete(body.url); else net.stopped.add(body.url); return { status: 200, body: Buffer.from(JSON.stringify({ sharing: body.sharing === "true" })) }; }
    if (r.path === "/private-forget") { net.forgotten.push(body.url); return { status: 200, body: Buffer.from('{"forgotten":true}') }; }
    return { status: 404, body: Buffer.alloc(0) };
  };
  p.files = cf.create(Object.assign({ root, nodeCmd: p.nodeCmd, hasContact: (k) => p.contacts.has(k), myName: () => name,
    addMessage: (m) => p.messages.push(m), setStatus: (id, s) => p.statuses.push([id, s]), http: httpFn, tmpDir: pub, markDownloaded: async (d) => { p.marked.push(d); } }, over));
  p.marked = [];
  return p;
}
const network = () => ({ files: new Map(), stopped: new Set(), forgotten: [] });
/** Hand every chat payload `from` sent to `to`'s drainer logic; returns the decoded non-control messages. */
async function deliver(from, to) {
  const out = [];
  for (const s of from.sent.splice(0)) {
    assert.equal(s.to, to.pubkey);
    const d = schema.chatDecode(s.payload);
    if (d.state === "file-control") await to.files.inboundControl(from.pubkey, d.body); else out.push(d);
  }
  return out;
}

test("end to end: prepare, publish, offer, explicit download, verify, save, receipts, sharing stops, remove", async () => {
  const net = network(), alice = party("alice", ALICE, net), bob = party("bob", BOB, net);
  alice.contacts.add(BOB); bob.contacts.add(ALICE);
  const size = 300000, data = pattern(size, 19), src = path.join(tmpdir("pick"), "holiday photo.jpg");
  fs.writeFileSync(src, data);

  const st = await alice.files.prepare(BOB, src, { mime: "image/jpeg" });
  assert.equal(st.error, ""); assert.ok(st.sent && st.ready && st.mine && !st.running);
  assert.equal(st.name, "holiday photo.jpg"); assert.equal(st.done, size); assert.equal(st.msgid, "kf-" + st.id);
  const dir = path.join(alice.root, st.id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["offer.json", "payload.bin", "verified.bin"]);
  assert.equal(fs.statSync(path.join(dir, "payload.bin")).size, cf.cipherSize(size));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "offer.json"), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["mine", "msgid", "peer", "prepared", "ref", "sent", "ts"]);
  assert.deepEqual({ ...saved, ts: 0 }, { ref: st.ref, peer: BOB, mine: true, msgid: "kf-" + st.id, ts: 0, sent: true, prepared: true });
  // the outgoing chat row, then its status
  assert.deepEqual(alice.messages, [{ msgid: "kf-" + st.id, pubkey: BOB, incoming: false, body: "holiday photo.jpg", name: "alice", ref: st.ref, state: "file", ts: saved.ts, via: "", read: true, status: "sending" }]);
  assert.deepEqual(alice.statuses, [["kf-" + st.id, { via: "direct", status: "delivered" }]]);

  // bob's drainer: a state:"file" message becomes a row; nothing is fetched
  const [m] = await deliver(alice, bob);
  assert.equal(m.state, "file"); assert.equal(m.body, "holiday photo.jpg"); assert.equal(m.id, "kf-" + st.id);
  const f = bob.files.inboundOffer(m.ref);
  assert.equal(f.mime, "image/jpeg"); assert.equal(f.size, size); assert.equal(f.digest, sha(data));
  const shown = bob.files.offer(ALICE, m.ref);   // [java ChatFilesTest] displaying an offer does not download
  assert.ok(!shown.ready && !shown.canSave && shown.canRun && !shown.mine);
  assert.ok(!fs.existsSync(path.join(bob.root, f.id)), "no directory until the user asks"); assert.deepEqual(bob.http, []);
  assert.throws(() => bob.files.status(f.id), /Transfer not found/);
  await rejects(bob.files.save(f.id, path.join(tmpdir("early"), "x")), /Transfer not found/);

  const got = await bob.files.download(ALICE, m.ref);
  assert.equal(got.error, ""); assert.ok(got.ready && got.canSave && !got.canRun);
  assert.deepEqual(fs.readFileSync(path.join(bob.root, f.id, "verified.bin")), data);
  assert.throws(() => bob.files.offer("0x" + "9".repeat(64), m.ref), /Conflicting file offer/, "the same offer from another peer is refused");
  const out = path.join(tmpdir("save"), cf.safeName(got.name));
  assert.equal(await bob.files.save(f.id, out), out); assert.deepEqual(fs.readFileSync(out), data);
  assert.deepEqual(bob.marked, [out], "the saved copy gets the system's downloaded mark");
  await rejects(bob.files.save(f.id, path.join(bob.root, f.id, "x.bin")), /different place/);
  await rejects(bob.files.save(f.id, "relative.bin"), /different place/);
  assert.equal(bob.files.transfers(ALICE).length, 1); assert.equal(bob.files.transfers(BOB).length, 0);

  // receipts: hello -> capable, complete -> ack, then both sides stop serving
  assert.equal(alice.files.status(st.id).delivery.delivery, "Download confirmation unavailable");
  await alice.files.tick();                       // hello
  assert.equal(JSON.parse(alice.sent[0].payload).state, "file-control");
  assert.equal(JSON.parse(alice.sent[0].payload).body, cf.controlBody(st.id, sha(data), "hello"));
  await deliver(alice, bob); await bob.files.tick();   // capable + complete
  assert.deepEqual(bob.sent.map((s) => JSON.parse(JSON.parse(s.payload).body).kind), ["capable", "complete"]);
  await deliver(bob, alice);
  assert.equal(alice.files.status(st.id).delivery.delivery, "Downloaded and verified · sharing");
  await alice.files.tick();                       // ack out, sharing stopped
  assert.deepEqual(alice.sent.map((s) => JSON.parse(JSON.parse(s.payload).body).kind), ["ack"]);
  assert.equal(alice.files.status(st.id).delivery.delivery, "Downloaded and verified · sharing stopped");
  assert.ok(net.stopped.has(cf.parseRef(st.ref).torrent));
  await deliver(alice, bob); await bob.files.tick();
  assert.equal(bob.files.status(f.id).delivery.sharingStopped, "true");
  await alice.files.tick(); await bob.files.tick();
  assert.deepEqual([alice.sent, bob.sent], [[], []], "a finished transfer says nothing more");
  // share again, then remove
  await alice.files.shareAgain(st.id);
  assert.ok(!net.stopped.has(cf.parseRef(st.ref).torrent)); assert.equal(alice.files.status(st.id).delivery.keepSharing, "true");
  await bob.files.remove(f.id);
  assert.ok(!fs.existsSync(path.join(bob.root, f.id))); assert.deepEqual(net.forgotten, [cf.parseRef(st.ref).torrent]);
  assert.throws(() => bob.files.status(f.id), /Transfer not found/);
  await alice.files.close(); await bob.files.close();
});

test("pause and resume a download; a failed send is retried by resume without re-publishing", async () => {
  const net = network(), alice = party("alice2", ALICE, net), bob = party("bob2", BOB, net);
  alice.contacts.add(BOB); bob.contacts.add(ALICE);
  const size = 600000, src = path.join(tmpdir("pick2"), "notes.txt"); fs.writeFileSync(src, pattern(size));
  alice.sendFails = true;
  const st = await alice.files.prepare(BOB, src);
  assert.equal(st.error, "peer unreachable"); assert.ok(!st.sent && st.ready && st.canRun);
  assert.deepEqual(alice.statuses.pop(), ["kf-" + st.id, { via: "FAILED", status: "failed", error: "peer unreachable" }]);
  const publishes = alice.cmds.filter((c) => c.includes("action:publish")).length;
  assert.equal(publishes, Math.ceil(cf.cipherSize(size) / cf.BLOCK) + 1);
  alice.sendFails = false;
  const again = await alice.files.resume(st.id);
  assert.equal(again.error, ""); assert.ok(again.sent);
  assert.equal(alice.cmds.filter((c) => c.includes("action:publish")).length, publishes, "published once");
  assert.equal(alice.messages.length, 2, "same msgid offered to the store again (it dedupes)"); assert.equal(alice.messages[1].msgid, "kf-" + st.id);

  const [m] = await deliver(alice, bob), id = st.id;
  let gets = 0; const real = bob.files._transport.fetch;
  bob.files._transport.fetch = async (u, max) => { if (++gets === 3) bob.files.pause(id); return real(u, max); };
  const half = await bob.files.download(ALICE, m.ref);
  assert.equal(half.error, "Transfer paused"); assert.ok(!half.ready && half.canRun);
  assert.ok(!fs.existsSync(path.join(bob.root, id, "verified.bin")));
  const before = bob.http.length;
  const full = await bob.files.resume(id);
  assert.equal(full.error, ""); assert.ok(full.ready);
  assert.equal(bob.http.length - before, 1 + Math.ceil(cf.cipherSize(size) / cf.BLOCK) - 1, "manifest plus only the blocks not yet on disk (the block in flight at the pause is discarded)");
  await alice.files.close(); await bob.files.close();
});

test("limits: 100 MiB, 32 transfers, 2 GiB of reserved storage, free space; contacts only; old sidecar", async () => {
  const net = network(), src = path.join(tmpdir("pick3"), "a.bin"); fs.writeFileSync(src, pattern(1000));
  let free = Number.MAX_SAFE_INTEGER;
  const alice = party("alice3", ALICE, net, { freeSpace: () => free });
  alice.contacts.add(BOB);
  // free-space rule: twice the ciphertext plus 32 MiB
  free = 2 * cf.cipherSize(1000) + 32 * 1024 * 1024 - 1;
  await rejects(alice.files.prepare(BOB, src), /Remove a finished transfer/);
  free += 1;
  assert.equal((await alice.files.prepare(BOB, src)).error, "");
  free = Number.MAX_SAFE_INTEGER;
  // 100 MiB + 1 (a sparse file: no bytes are written)
  const big = path.join(tmpdir("big"), "big.bin"); fs.closeSync(fs.openSync(big, "w")); fs.truncateSync(big, cf.TRANSFER_MAX_BYTES + 1);
  await rejects(alice.files.prepare(BOB, big), /Choose a local file up to 100 MB/);
  // 2 GiB: every stored transfer reserves twice its ciphertext; an unreadable directory reserves 200 MiB
  for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(alice.root, "junk" + i));
  assert.equal((await alice.files.prepare(BOB, src)).error, "", "10 unreadable dirs = 2000 MiB reserved: still under 2048 MiB");
  fs.mkdirSync(path.join(alice.root, "junk10"));
  await rejects(alice.files.prepare(BOB, src), /Remove a finished transfer/);
  for (let i = 0; i < 11; i++) fs.rmdirSync(path.join(alice.root, "junk" + i));
  // 32 transfers
  const one = fs.readdirSync(alice.root)[0], ref = JSON.parse(fs.readFileSync(path.join(alice.root, one, "offer.json"), "utf8")).ref, of = cf.parseRef(ref);
  for (let i = fs.readdirSync(alice.root).length; i < 32; i++) {
    const id = cf.randomHex(16), d = path.join(alice.root, id); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "offer.json"), JSON.stringify({ ref: cf.chatFile(id, "n", "m", 1, of.key, of.nonce, of.digest, "").ref, peer: BOB, mine: true, msgid: "kf-" + id, ts: 1, sent: false, prepared: true }));
  }
  await rejects(alice.files.prepare(BOB, src), /Remove a finished transfer/);
  assert.equal(alice.files.transfers(BOB).length, 32);

  // contacts only: no transfer work, no control answered, no receipt sent to a non-contact
  const carol = party("carol", BOB, net), offered = cf.chatFile(ID, "n", "m", 1, KEY, NONCE, DIGEST, TORRENT);
  const res = await carol.files.download(ALICE, offered.ref);
  assert.match(res.error, /This contact was removed/); assert.ok(!fs.existsSync(path.join(carol.root, ID))); assert.deepEqual(carol.http, []);
  await carol.files.inboundControl(ALICE, control("hello", DIGEST)); await carol.files.tick();
  assert.deepEqual(carol.sent, []);
  await carol.files.inboundControl(ALICE, "not json");   // never throws

  // a sidecar without boundedMedia cannot receive files
  const old = party("old", BOB, net); old.contacts.add(ALICE); old.info = { pubkey: BOB, apiport: 20000 };
  const r2 = await old.files.download(ALICE, offered.ref);
  assert.equal(r2.error, "Update your Keets node to receive files"); assert.deepEqual(old.http, []);
  for (const p of [alice, carol, old]) await p.files.close();
});

test("transport: path regex, contact shape, datahex, and the temp file is removed", async () => {
  const cmds = [], dir = tmpdir("tr");
  const t = cf.createTransport({ nodeCmd: async (c) => { cmds.push(c); return { url: "u", delivered: "mailbox" }; }, tmpDir: dir });
  for (const p of ["/private/" + ID + "/x", "/private/" + ID + "/1 file:/etc/passwd", "/chat/" + ID + "/1", "/private/" + ID.toUpperCase() + "/1", "/private/" + ID + "/manifest\n"])
    await rejects(t.publish(p, Buffer.from("x")), /Invalid file path/);
  await t.publish("/private/" + ID + "/manifest", Buffer.from("x"));
  assert.match(cmds[0], new RegExp("^keets action:publish path:/private/" + ID + "/manifest file:\\S+chat-file-[0-9a-f]{16}\\.bin$"));
  assert.deepEqual(fs.readdirSync(dir), []);
  await rejects(t.send("0x12", "x"), /Invalid contact/);
  assert.equal(await t.send(PEER, "hé"), "mailbox");
  assert.equal(cmds[1], "keets action:send to:" + PEER + " datahex:0x68C3A9");
  const spaced = cf.createTransport({ nodeCmd: async () => ({ url: "u" }), tmpDir: path.join(dir, "has space") });
  if (process.platform !== "win32") await rejects(spaced.publish("/private/" + ID + "/0", Buffer.from("x")), /contains a space.*has space/);
});

test("0.19.5: a temp folder with a space in its path (a Windows user name): the node is handed the same folder under a space-free name", async () => {
  const base = tmpdir("sp"), spacedDir = path.join(base, "John Smith", "Temp"), alias = path.join(base, "JOHNSM~1");
  fs.mkdirSync(spacedDir, { recursive: true }); fs.symlinkSync(path.join(base, "John Smith"), alias);   // what the 8.3 name is on Windows
  const shortOf = (d) => d.replace("John Smith", "JOHNSM~1"), cmds = [];
  let seen = null;
  const t = cf.createTransport({ tmpDir: spacedDir, shortOf, nodeCmd: async (c) => { cmds.push(c); const f = c.split(" file:")[1]; seen = fs.readFileSync(f, "utf8"); return { url: "u" }; } });
  assert.equal(await t.publish("/private/" + ID + "/0", Buffer.from("block")), "u");
  assert.equal(cmds[0].split(" ").length, 4, "one token per parameter: " + cmds[0]); assert.ok(!/\s/.test(cmds[0].split(" file:")[1]));
  assert.equal(seen, "block", "and the node reads the block there"); assert.deepEqual(fs.readdirSync(spacedDir), [], "removed after");
  assert.equal(cf.spaceFreeDir(spacedDir, shortOf), path.join(alias, "Temp")); assert.equal(cf.spaceFreeDir(base), base);
  // no usable short name: refused with the whole path, never a rewritten command
  for (const bad of [(d) => d, () => "", () => path.join(base, "no-such-dir"), () => { throw new Error("8.3 names are off"); }])
    assert.throws(() => cf.spaceFreeDir(spacedDir, bad), /contains a space.*John Smith/);
});

test("0.19.5: a saved file carries the system's downloaded mark (best effort)", async () => {
  const dir = tmpdir("mark"), f = path.join(dir, "saved.bin"); fs.writeFileSync(f, "x");
  await cf.markDownloaded(f, "win32");
  assert.equal(fs.readFileSync(f + ":Zone.Identifier", "utf8"), "[ZoneTransfer]\r\nZoneId=3\r\n");
  await cf.markDownloaded(path.join(dir, "missing", "x.bin"), "win32");   // never throws
  const ran = [];
  await cf.markDownloaded(f, "darwin", (cmd, args, o, cb) => { ran.push([cmd, ...args]); cb(new Error("no such attribute support")); });   // a failure is swallowed
  assert.equal(ran.length, 1); assert.deepEqual(ran[0].slice(0, 3), ["/usr/bin/xattr", "-w", "com.apple.quarantine"]);
  assert.match(ran[0][3], /^0081;[0-9a-f]+;minimaCore;$/); assert.equal(ran[0][4], f);
  await cf.markDownloaded(f, "darwin", () => { throw new Error("cannot start"); });
  await cf.markDownloaded(f, "linux", () => { throw new Error("not called"); });
});

test("0.19.5: Run from the transfer sheet (main/chat.js fileRun): a first download, one in progress, and one of our own", async () => {
  const dir = tmpdir("chatjs"), fakeMod = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, children: [], paths: [], exports }; };
  const main = path.join(__dirname, "..", "main");
  fakeMod(require.resolve("electron"), { app: { getPath: () => dir } });
  fakeMod(require.resolve(path.join(main, "config.js")), { rpcSecret: () => "" });
  fakeMod(require.resolve(path.join(main, "node-manager.js")), { rpcPort: () => 0, log() {} });
  const chat = require("../main/chat");
  const net = network(), alice = party("alice", ALICE, net), bob = party("bob", BOB, net);
  alice.contacts.add(BOB); bob.contacts.add(ALICE);
  const data = pattern(2 * 1024 * 1024 + 5, 7), src = path.join(tmpdir("pick"), "notes.txt"); fs.writeFileSync(src, data);
  const mine = await alice.files.prepare(BOB, src, {});
  const [m] = await deliver(alice, bob);

  // bob: an offer never seen on this disk. The sheet shows it (offer) and Run passes the id it showed.
  chat._setFileEngine(bob.files);
  const shown = bob.files.offer(ALICE, m.ref);
  assert.throws(() => bob.files.status(shown.id), /Transfer not found/, "nothing on disk yet: the lookup 0.19.2 died on");
  const got = await chat.fileRun(ALICE, m.ref, shown.id);
  assert.equal(got.error, ""); assert.ok(got.ready && !got.mine);
  assert.deepEqual(fs.readFileSync(path.join(bob.root, shown.id, "verified.bin")), data);
  // ...and one in progress: paused part-way, Run resumes the same transfer
  const carol = party("carol", "0x" + "c2".repeat(32), net); carol.contacts.add(ALICE);
  const first = chat._setFileEngine(carol.files) || carol.files.download(ALICE, m.ref);
  carol.files.pause(shown.id);
  const part = await first;
  const again = await chat.fileRun(ALICE, m.ref, shown.id);
  assert.equal(again.error, ""); assert.ok(again.ready, "resumed to the end (was at " + part.done + " of " + data.length + ")");
  assert.deepEqual(fs.readFileSync(path.join(carol.root, shown.id, "verified.bin")), data);
  // alice: her own transfer is resumed by its id, never downloaded
  chat._setFileEngine(alice.files);
  const before = alice.http.length, own = await chat.fileRun(BOB, mine.ref, mine.id);
  assert.ok(own.mine && own.sent && own.ready); assert.equal(alice.http.filter((h, i) => i >= before && /^GET/.test(h)).length, 0, "no download of our own file");
  await rejects((async () => chat.fileRun(ALICE, m.ref, "../x"))(), /Invalid file transfer/);
  chat._setFileEngine(null);
  for (const p of [alice, bob, carol]) await p.files.close();
});

test("safeName: a peer-supplied name as a save dialog default", () => {
  assert.equal(cf.safeName("report.pdf"), "report.pdf");
  assert.equal(cf.safeName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(cf.safeName("..\\..\\boot.ini"), "_.._boot.ini");
  assert.equal(cf.safeName(".bashrc"), "bashrc"); assert.equal(cf.safeName("...   "), "file");
  assert.equal(cf.safeName(""), "file"); assert.equal(cf.safeName(null), "file"); assert.equal(cf.safeName("\u0000\n"), "file");
  assert.equal(cf.safeName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(cf.safeName("invoice\u202Efdp.exe"), "invoicefdp.exe", "a bidi override cannot disguise the extension");
  assert.equal(cf.safeName("CON.txt"), "_CON.txt"); assert.equal(cf.safeName('a:b*c?"d<e>f|g'), "a_b_c__d_e_f_g");
  assert.equal(cf.safeName("name. "), "name");
  const long = cf.safeName("x".repeat(300) + ".tar.gz");
  assert.equal(long.length, 120); assert.ok(long.endsWith(".gz"));
  for (const n of ["a/b", "a\\b", ".x", "x".repeat(500)]) { const s = cf.safeName(n); assert.ok(s.length > 0 && s.length <= 120 && !/[\/\\\u0000-\u001f]/.test(s) && !s.startsWith(".")); }
});

// ---- voice notes -----------------------------------------------------------------------------------
test("voice: limits, fmtSecs, sendable", () => {
  assert.equal(voice.MAX_SECONDS, 60); assert.equal(voice.BAR_COUNT, 32); assert.equal(voice.SAMPLE_MS, 100);
  assert.deepEqual([0, 5, 59, 60, 75, 600].map(voice.fmtSecs), ["0:00", "0:05", "0:59", "1:00", "1:15", "10:00"]);
  assert.ok(voice.sendable(10, 1)); assert.ok(!voice.sendable(10, 0)); assert.ok(!voice.sendable(0, 5));
  assert.equal(voice.clampSecs(61.9), 60); assert.equal(voice.clampSecs(-1), 0);
});
test("[derived] voice: summarise is max-pooled, peak-normalised, 1..15; encode is one nibble per bar", () => {
  assert.equal(voice.encode(voice.summarise([])), "4".repeat(32)); assert.equal(voice.encode(voice.summarise(null)), "4".repeat(32));
  assert.equal(voice.encode(voice.summarise(new Array(50).fill(0))), "1".repeat(32), "silence");
  assert.equal(voice.encode(voice.summarise(new Array(64).fill(900))), "f".repeat(32), "constant level = every bar at the peak");
  // 32 samples, one per bar: level = 1 + min(14, floor(sqrt(v/peak)*14))
  const ramp = [...Array(32).keys()].map((i) => i * 1000);
  assert.equal(voice.encode(voice.summarise(ramp)), "1345667788899aaabbbbcccddddeeeef");
  // fewer samples than bars: bars repeat their sample; more: the max of each window
  assert.equal(voice.encode(voice.summarise([100, 400])), "8".repeat(16) + "f".repeat(16));
  const spiky = new Array(320).fill(0); spiky[5] = 32767; spiky[319] = 8192;
  const s = voice.summarise(spiky); assert.equal(s[0], 15); assert.equal(s[31], 8); assert.equal(s[1], 1);
  assert.deepEqual([0, 1, 32767, 99999, -5, 8192].map(voice.level), [1, 1, 15, 15, 1, 8]);
  assert.equal(voice.encode([0, 1, 9, 10, 15, 16, -3]), "019aff0");
});
test("voice: decode, body build/parse, publish path and extension", () => {
  assert.deepEqual(voice.decode("019aF"), [0, 1, 9, 10, 15]);
  for (const bad of ["", null, "xyz", "f".repeat(65), "12 3"]) assert.equal(voice.decode(bad), null, String(bad));
  assert.equal(voice.decode("f".repeat(64)).length, 64);
  const wave = voice.encode(voice.summarise([1, 2, 3]));
  assert.equal(voice.buildBody(75, wave), "1:15|" + wave); assert.equal(voice.buildBody(7, ""), "0:07");
  assert.deepEqual(voice.parseBody("1:15|" + wave), { duration: "1:15", waveHex: wave, levels: voice.decode(wave) });
  assert.deepEqual(voice.parseBody("0:07"), { duration: "0:07", waveHex: "", levels: null });
  assert.deepEqual(voice.parseBody("0:07|zz"), { duration: "0:07", waveHex: "zz", levels: null });
  assert.deepEqual(voice.parseBody(undefined), { duration: "", waveHex: "", levels: null });
  assert.equal(voice.publishPath("audio/ogg", 1760000000000), "/chat/vn-1760000000000.ogg");
  assert.equal(voice.publishPath("audio/ogg;codecs=opus", 1), "/chat/vn-1.ogg");
  assert.equal(voice.publishPath("audio/mp4", 1), "/chat/vn-1.m4a"); assert.equal(voice.publishPath("", 1), "/chat/vn-1.m4a");
  assert.equal(voice.publishPath("audio/webm;codecs=opus", 1), "/chat/vn-1.webm");
  assert.equal(voice.mimeForRef("keets://" + "a".repeat(64) + "/chat/vn-1.ogg?hash=" + "b".repeat(64)), "audio/ogg");
  assert.equal(voice.mimeForRef("keets://x/chat/vn-1.M4A"), "audio/mp4"); assert.equal(voice.mimeForRef("keets://x/chat/vn-1.webm"), "audio/webm");
  assert.equal(voice.mimeForRef("keets://x/chat/img-1.jpg"), "");
  // the message, as the existing schema builds it
  const d = schema.chatDecode(schema.chatEncodeTyped("me", voice.buildBody(12, wave), { state: "audio", ref: "keets://" + "a".repeat(64) + "/chat/vn-1.ogg?hash=" + "b".repeat(64) }));
  assert.equal(d.state, "audio"); assert.equal(voice.parseBody(d.body).duration, "0:12");
});
