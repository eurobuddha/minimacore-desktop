/*
 * chatfiles.js — KeetChat file transfers (main process), the CommonJS twin of the phone's
 *   apks/base app/.../chat/ChatFiles.java, ChatFileDelivery.java, ChatKeetsTransport.java
 *   apks/base maxima-core/.../core/chat/ChatFile.java, KeetsMediaClient.java, KeetsWire.fileControl
 *   apks/base maxima-core/.../files/FileCrypto.java, KeetsFiles.java, FileDelivery.java
 *   apks/base maxima-core/.../core/util/Json.java (the flat writer/reader the ref and manifest bytes come from)
 * The Java is the source of truth: every byte that crosses the wire (file ref, manifest, AES-GCM
 * records, control messages) must stay identical. Change the Java first, then this file.
 *
 * What travels where: the sealed chat message carries only the OFFER (state:"file", ref = "pf1:" +
 * base64url JSON holding the AES key, nonce, name, plaintext digest and the manifest url). The file
 * itself is AES-256-GCM ciphertext cut into 112 KiB blocks on the sender's keets drive under
 * /private/<id>/<n> plus /private/<id>/manifest. Nothing downloads until the user asks; plaintext
 * (verified.bin) exists only after every GCM record and the whole-file SHA-256 verified.
 *
 * No Electron import: the caller passes the storage root (userData/chat-files) and the node-command
 * runner, so plain-node tests drive it with a temp dir and a fake node (scripts/chatfiles-test.cjs).
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

// ---- limits (Java file:line in the header of each) --------------------------------------------
const PREFIX = "pf1:";                              // ChatFile.java:10
const MAX_BYTES = 512 * 1024 * 1024;                // ChatFile.java:11 (read bound for legacy offers)
const TRANSFER_MAX_BYTES = 100 * 1024 * 1024;       // ChatFile.java:13
const MAX_REF_CHARS = 65536;                        // ChatFile.java:14
const PIECE = 1024 * 1024;                          // FileCrypto.java:19
const PLAIN_PIECE = PIECE - 16;                     // FileCrypto.java:20
const BLOCK = 112 * 1024;                           // KeetsFiles.java:19
const MANIFEST_LIMIT = 64 * 1024;                   // KeetsFiles.java:20
const FETCH_MAX = 8 * 1024 * 1024;                  // ChatKeetsTransport.java:35, KeetsMediaClient.java:28
const MAX_TRANSFERS = 32;                           // ChatFiles.java:70
const MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;     // ChatFiles.java:70
const FREE_MARGIN = 32 * 1024 * 1024;               // ChatFiles.java:71
const OFFER_STATE_MAX = 100000;                     // ChatFiles.java:100, ChatFileDelivery.java:35
const DELIVERY_STATE_MAX = 16384;                   // FileDelivery.java:30
const CONTROL_MAX = 1024;                           // FileDelivery.java:45, KeetsWire.java:185
const REPLY_QUEUE_MAX = 128;                        // FileDelivery.java:55
const RESEND_MS = 15000, RESEND_CAP_MS = 600000;    // FileDelivery.java:72
const TICK_FIRST_MS = 1000, TICK_MS = 5000;         // ChatFileDelivery.java:28
const HTTP_DEADLINE_MS = 50000, HTTP_READ_MS = 40000;   // KeetsMediaClient.java:60,62
const APPLICATION = "maxima_chat_v1";
const ZERO_DIGEST = "0".repeat(64);
const PATH_RE = /^\/private\/[a-f0-9]{32}\/(manifest|[0-9]+)$/;   // ChatKeetsTransport.java:28
const HASH = "[a-f0-9]{64}";

// The phone's English texts (app/src/main/res/values strings: chat_files_*).
const TEXT = {
  limit: "Choose a local file up to 100 MB",
  failed: "File transfer failed. Tap Resume to retry.",
  storage: "Remove a finished transfer to free file-sharing storage.",
  paused: "Transfer paused",
  incomplete: "Preparation was interrupted. Remove this local transfer and choose the file again.",
  contact: "This contact was removed. Add the contact before transferring files."
};

function paused() { const e = new Error(TEXT.paused); e.code = "PAUSED"; return e; }
function check(cancelled) { if (cancelled && cancelled()) throw paused(); }
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function randomHex(bytes) { return crypto.randomBytes(bytes).toString("hex"); }

// ---- Json.java: the flat writer/reader. NOT JSON.stringify: the manifest's hash is over these bytes.
function jsonEscape(v) {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i], n = v.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (n < 0x20) out += "\\u" + n.toString(16).padStart(4, "0");
    else out += c;
  }
  return out;
}
/** pairs = [[key, stringValue], ...] or [key, value, true] for a raw (unquoted) value. */
function jsonWrite(pairs) {
  return "{" + pairs.map(([k, v, raw]) => '"' + jsonEscape(k) + '":' + (raw ? v : '"' + jsonEscape(v == null ? "" : "" + v) + '"')).join(",") + "}";
}
// Character.isWhitespace
function isWs(c) {
  const n = c.charCodeAt(0);
  return (n >= 9 && n <= 13) || (n >= 0x1c && n <= 0x20) || n === 0x1680 || (n >= 0x2000 && n <= 0x2006)
    || (n >= 0x2008 && n <= 0x200a) || n === 0x2028 || n === 0x2029 || n === 0x205f || n === 0x3000;
}
function skipWs(s, i) { while (i < s.length && isWs(s[i])) i++; return i; }
function readString(s, i) {
  let out = ""; i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i++; if (i >= s.length) break;
      const e = s[i];
      if (e === "n") out += "\n"; else if (e === "r") out += "\r"; else if (e === "t") out += "\t";
      else if (e === "u") {
        const h = s.substring(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new Error("Bad escape");
        out += String.fromCharCode(parseInt(h, 16)); i += 4;
      } else out += e;
      i++;
    } else if (c === '"') return [i + 1, out];
    else { out += c; i++; }
  }
  throw new Error("Unterminated string");
}
/** Flat object -> { key: string }. Unquoted values (numbers, booleans) come back as their text. Throws on anything else. */
function jsonParse(json) {
  const out = Object.create(null);
  const s = ("" + json).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");   // String.trim()
  if (!s.startsWith("{") || !s.endsWith("}")) throw new Error("Not a JSON object");
  let i = 1; const end = s.length - 1;
  while (i < end) {
    i = skipWs(s, i);
    if (i >= end) break;
    if (s[i] === ",") { i++; continue; }
    if (s[i] !== '"') throw new Error("Expected key at " + i);
    let key, val;
    [i, key] = readString(s, i);
    i = skipWs(s, i);
    if (i >= end || s[i] !== ":") throw new Error("Expected ':' at " + i);
    i = skipWs(s, i + 1);
    if (i >= s.length) throw new Error("Truncated");
    const c = s[i];
    if (c === '"') { [i, val] = readString(s, i); out[key] = val; }
    else if (c === "{" || c === "[") throw new Error("Nested JSON not supported for key " + key);
    else {
      const st = i;
      while (i < end && s[i] !== "," && !isWs(s[i])) i++;
      out[key] = s.substring(st, i);
    }
  }
  return out;
}

// ---- ChatFile.java: the offer ---------------------------------------------------------------------
const hasCtl = (s) => { for (let i = 0; i < s.length; i++) { const n = s.charCodeAt(i); if (n < 32 || n === 127) return true; } return false; };
/** A validated, frozen offer. `ref` is the canonical wire string (ChatFile.ref()). Throws "Invalid private file offer". */
function chatFile(id, name, mime, size, key, nonce, digest, torrent) {
  const str = (v) => typeof v === "string";
  if (!str(id) || !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES
      || !str(name) || name === "" || name.length > 240 || name === "." || name === ".."
      || hasCtl(name) || name.includes("/") || name.includes("\\")
      || !str(mime) || mime.length > 160 || hasCtl(mime)
      || !str(key) || !/^[a-f0-9]{64}$/.test(key)
      || !str(nonce) || !/^[a-f0-9]{16}$/.test(nonce)
      || !str(digest) || !/^[a-f0-9]{64}$/.test(digest)
      || !str(torrent) || torrent.length > 32768) throw new Error("Invalid private file offer");
  const json = jsonWrite([["v", "1"], ["id", id], ["name", name], ["mime", mime], ["size", "" + size], ["key", key],
    ["nonce", nonce], ["digest", digest], ["torrent", torrent]]);
  return Object.freeze({ id, name, mime, size, key, nonce, digest, torrent,
    ref: PREFIX + Buffer.from(json, "utf8").toString("base64url") });
}
function isKeets(f) { return f.torrent.startsWith("keets://"); }
// java.util.Base64.getUrlDecoder(): strict alphabet, padding optional but correct when present
function b64urlStrict(s) {
  const m = /^([A-Za-z0-9_-]*)(={0,2})$/.exec(s);
  if (!m) throw new Error("bad base64");
  const r = m[1].length % 4;
  if (r === 1 || (m[2] && (m[1].length + m[2].length) % 4 !== 0)) throw new Error("bad base64");
  return Buffer.from(m[1], "base64url");
}
/** ChatFile.parse: "pf1:..." -> offer. Throws. */
function parseRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(PREFIX) || ref.length > MAX_REF_CHARS)
    throw new Error("Unsupported file offer; update Parlons");
  try {
    const m = jsonParse(b64urlStrict(ref.substring(PREFIX.length)).toString("utf8"));
    if (m.v !== "1" || typeof m.size !== "string" || !/^[+-]?[0-9]{1,18}$/.test(m.size)) throw new Error();
    return chatFile(m.id, m.name, m.mime, Number(m.size), m.key, m.nonce, m.digest, m.torrent);
  } catch (e) { throw new Error("Invalid private file offer"); }
}
/** KeetsFiles.validate: a downloadable offer (100 MiB cap, manifest url on a keets drive under this id). Throws. */
function validate(f) {
  if (f.size > TRANSFER_MAX_BYTES
      || !new RegExp("^keets://" + HASH + "/private/" + f.id + "/manifest\\?hash=" + HASH + "$").test(f.torrent))
    throw new Error("Invalid Keets file offer; update both apps");
}
/** What the inbox drainer needs: the validated offer for an inbound state:"file" ref, or null (ack and drop). */
function inboundOffer(ref) {
  try { const f = parseRef(ref); validate(f); return f; } catch (e) { return null; }
}

// ---- FileCrypto.java: AES-256-GCM in bounded records ---------------------------------------------
function cipherSize(size) { return size + Math.max(1, Math.floor((size + PLAIN_PIECE - 1) / PLAIN_PIECE)) * 16; }
// iv = nonce(8) || index(int32 BE); aad = id(16) || size(int64 BE) || index(int32 BE)
function gcm(decrypt, id, size, key, nonce, index) {
  const iv = Buffer.alloc(12); Buffer.from(nonce, "hex").copy(iv); iv.writeUInt32BE(index, 8);
  const aad = Buffer.alloc(28); Buffer.from(id, "hex").copy(aad); aad.writeBigUInt64BE(BigInt(size), 16); aad.writeUInt32BE(index, 24);
  const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)("aes-256-gcm", Buffer.from(key, "hex"), iv, { authTagLength: 16 });
  c.setAAD(aad);
  return c;
}
function sealRecord(plain, id, size, key, nonce, index) {
  const c = gcm(false, id, size, key, nonce, index);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function openRecord(record, id, size, key, nonce, index) {
  const c = gcm(true, id, size, key, nonce, index);
  c.setAuthTag(record.subarray(record.length - 16));
  return Buffer.concat([c.update(record.subarray(0, record.length - 16)), c.final()]);   // throws on a bad tag
}
async function readFully(fh, buf, count, pos) {
  let off = 0;
  while (off < count) {
    const { bytesRead } = await fh.read(buf, off, count - off, pos + off);
    if (bytesRead <= 0) throw new Error("Incomplete file");
    off += bytesRead;
  }
}
/** Stream source -> target (created new) as GCM records; returns the plaintext SHA-256 hex. One PLAIN_PIECE in memory. */
async function encrypt(sourcePath, target, id, size, key, nonce, cancelled, progress) {
  if (size < 0 || size > TRANSFER_MAX_BYTES) throw new Error("Choose a file up to 100 MB");
  const digest = crypto.createHash("sha256");
  let ok = false, src = null, out = null;
  try {
    out = await fsp.open(target, "wx");
    src = await fsp.open(sourcePath, "r");
    const buffer = Buffer.alloc(PLAIN_PIECE);
    let done = 0, index = 0;
    do {
      check(cancelled);
      const count = Math.min(PLAIN_PIECE, size - done);
      await readFully(src, buffer, count, done);
      const plain = buffer.subarray(0, count);
      digest.update(plain);
      await out.writeFile(sealRecord(plain, id, size, key, nonce, index++));
      done += count; if (progress) progress(done);
    } while (done < size);
    if ((await src.read(Buffer.alloc(1), 0, 1, done)).bytesRead > 0) throw new Error("File changed while preparing it");
    ok = true;
  } finally {
    if (src) await src.close().catch(() => {});
    if (out) { await out.close().catch(() => {}); if (!ok) await fsp.rm(target, { force: true }); }
  }
  return digest.digest("hex");
}
/** payload.bin -> verified.bin. The target appears (atomic rename) only after every record AND the whole digest verified. */
async function decrypt(source, target, f, cancelled) {
  if ((await fsp.stat(source)).size !== cipherSize(f.size)) throw new Error("Incomplete file");
  const tmp = path.join(path.dirname(target), ".verifying-" + randomHex(8) + ".tmp");
  let ok = false, src = null, out = null;
  try {
    const digest = crypto.createHash("sha256");
    src = await fsp.open(source, "r"); out = await fsp.open(tmp, "wx");
    const buffer = Buffer.alloc(PIECE);
    let done = 0, pos = 0, index = 0;
    do {
      check(cancelled);
      const n = Math.min(PLAIN_PIECE, f.size - done);
      await readFully(src, buffer, n + 16, pos);
      let plain;
      try { plain = openRecord(buffer.subarray(0, n + 16), f.id, f.size, f.key, f.nonce, index++); }
      catch (e) { throw new Error("File verification failed"); }
      digest.update(plain); await out.writeFile(plain); done += plain.length; pos += n + 16;
    } while (done < f.size);
    if ((await src.read(Buffer.alloc(1), 0, 1, pos)).bytesRead > 0
        || !crypto.timingSafeEqual(digest.digest(), Buffer.from(f.digest, "hex"))) throw new Error("File verification failed");
    await out.close(); out = null;
    check(cancelled);
    await fsp.rename(tmp, target);
    ok = true;
  } finally {
    if (src) await src.close().catch(() => {});
    if (out) await out.close().catch(() => {});
    if (!ok) await fsp.rm(tmp, { force: true });
  }
}

// ---- KeetsFiles.java: ciphertext blocks + manifest on the keets drive ----------------------------
function manifestBytes(id, total, hashes) {
  return Buffer.from(jsonWrite([["v", "1"], ["id", id], ["size", "" + total], ["block", "" + BLOCK], ["hashes", hashes.join("\n")]]), "utf8");
}
/** Publish an already-encrypted payload; a retry reuses the same paths and keys. Returns the offer with its manifest url. */
async function publish(transport, payload, f, cancelled, progress) {
  if (f.size > TRANSFER_MAX_BYTES || (await fsp.stat(payload)).size !== cipherSize(f.size)) throw new Error("Invalid encrypted file size");
  const prefix = "/private/" + f.id + "/", total = cipherSize(f.size), hashes = [];
  let base = null, done = 0;
  const fh = await fsp.open(payload, "r");
  try {
    const buffer = Buffer.alloc(BLOCK);
    for (let index = 0; done < total; index++) {
      check(cancelled);
      const n = Math.min(BLOCK, total - done);
      await readFully(fh, buffer, n, done);
      const block = Buffer.from(buffer.subarray(0, n));
      const hash = sha(block), p = prefix + index;
      const url = await transport.publish(p, block);
      const suffix = p + "?hash=" + hash;
      if (typeof url !== "string" || !new RegExp("^keets://" + HASH + "$").test(url.slice(0, 72)) || url.slice(72) !== suffix)
        throw new Error("Keets did not confirm the encrypted block");
      const drive = url.substring(0, 72);
      if (base === null) base = drive + prefix;
      if (drive + prefix !== base) throw new Error("Keets node changed during upload");
      hashes.push(hash); done += n; if (progress) progress(Math.min(f.size, done));
    }
  } finally { await fh.close().catch(() => {}); }
  check(cancelled);
  const manifest = manifestBytes(f.id, total, hashes);
  if (manifest.length > MANIFEST_LIMIT) throw new Error("File manifest too large");
  const url = await transport.publish(prefix + "manifest", manifest);
  if (base + "manifest?hash=" + sha(manifest) !== url) throw new Error("Keets did not confirm the file manifest");
  return chatFile(f.id, f.name, f.mime, f.size, f.key, f.nonce, f.digest, url);
}
async function checkedFetch(transport, url, max) {
  const bytes = await transport.fetch(url, max);
  if (!Buffer.isBuffer(bytes) || bytes.length > max || !url.endsWith("?hash=" + sha(bytes))) throw new Error("File block verification failed");
  return bytes;
}
/** Download into directory/payload.bin (resuming hash-verified blocks), then decrypt to directory/verified.bin. */
async function download(transport, f, directory, cancelled, progress) {
  validate(f); check(cancelled);
  const m = jsonParse((await checkedFetch(transport, f.torrent, MANIFEST_LIMIT)).toString("utf8"));
  const total = cipherSize(f.size);
  const hashes = (m.hashes === undefined ? "" : m.hashes).split("\n");
  if (m.v !== "1" || m.id !== f.id || m.size !== "" + total || m.block !== "" + BLOCK
      || hashes.length !== Math.floor((total + BLOCK - 1) / BLOCK)) throw new Error("Invalid Keets file manifest");
  for (const h of hashes) if (!/^[a-f0-9]{64}$/.test(h)) throw new Error("Invalid file block hash");
  const base = f.torrent.substring(0, f.torrent.indexOf("/manifest?")) + "/";
  await fsp.mkdir(directory, { recursive: true });
  const payload = path.join(directory, "payload.bin");
  const fh = await fsp.open(payload, fs.existsSync(payload) ? "r+" : "w+");
  try {
    let length = (await fh.stat()).size;
    if (length > total) { await fh.truncate(total); length = total; }
    let offset = 0;
    for (let i = 0; i < hashes.length; i++) {
      check(cancelled);
      const count = Math.min(BLOCK, total - offset);
      let cached = false;
      if (length >= offset + count) {
        const have = Buffer.alloc(count);
        await readFully(fh, have, count, offset);
        cached = sha(have) === hashes[i];
      }
      if (!cached) {
        const data = await checkedFetch(transport, base + i + "?hash=" + hashes[i], count);
        if (data.length !== count) throw new Error("Incomplete file block");
        check(cancelled);
        await fh.write(data, 0, count, offset);
        length = Math.max(length, offset + count);
      }
      offset += count; if (progress) progress(Math.min(f.size, offset));
    }
    await fh.truncate(total);
  } finally { await fh.close().catch(() => {}); }
  await decrypt(payload, path.join(directory, "verified.bin"), f, cancelled);
}

// ---- KeetsMediaClient.java: the bounded, authenticated loopback client (127.0.0.1 ONLY) ----------
// java.net.URLEncoder.encode(s, "UTF-8")
function urlEncode(s) {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9.\-*_]/.test(c) ? c : b === 0x20 ? "+" : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
function validRef(url) { return typeof url === "string" && /^keets:\/\/\S+$/.test(url); }   // KeetsTransport.validRef
/**
 * The default `http` function. Contract (what a test double must honour):
 *   http({ port, method, path, headers, body|null, max }) -> Promise<{ status, body: Buffer }>
 * Always 127.0.0.1, never follows a redirect, a 200 body over `max` rejects, a non-200 body is cut at 4 KB.
 */
function loopbackHttp({ port, method, path: route, headers, body, max }) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body) h["Content-Length"] = body.length;
    let settled = false, deadline = null;
    const done = (err, val) => { if (settled) return; settled = true; clearTimeout(deadline); if (err) { req.destroy(); reject(err); } else resolve(val); };
    const req = require("http").request({ host: "127.0.0.1", port, method, path: route, headers: h, agent: false }, (res) => {
      const ok = res.statusCode === 200, limit = ok ? max : 4096;
      if (ok && Number(res.headers["content-length"]) > max) return done(new Error("Keets media exceeds size limit"));
      const parts = []; let n = 0;
      res.on("data", (d) => {
        n += d.length;
        if (n <= limit) return parts.push(d);
        if (ok) done(new Error("Keets media exceeds size limit"));
        else { done(null, { status: res.statusCode, body: Buffer.alloc(0) }); req.destroy(); }
      });
      res.on("end", () => done(null, { status: res.statusCode, body: Buffer.concat(parts) }));
      res.on("error", (e) => done(e));
    });
    deadline = setTimeout(() => done(new Error(TEXT.paused)), HTTP_DEADLINE_MS);
    req.setTimeout(HTTP_READ_MS, () => done(new Error("File block unavailable; keep both nodes online and tap Resume")));
    req.on("error", (e) => done(e));
    req.end(body || undefined);
  });
}
function mediaClient(port, token, http) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Keets is starting; try again shortly");
  http = http || loopbackHttp;
  async function request(method, route, body, max) {
    const r = await http({ port, method, path: route, headers: { "x-keets-token": token, "Accept-Encoding": "identity" }, body: body || null, max });
    if (r.status === 401) throw new Error("Keets restarted; tap Resume");
    if (r.status !== 200) {
      let msg = "";
      try { msg = jsonParse(Buffer.from(r.body || "").subarray(0, 4096).toString("utf8")).error || ""; } catch (e) { /* generic text */ }
      throw new Error(msg || "File block unavailable; keep both nodes online and tap Resume");
    }
    if (!Buffer.isBuffer(r.body) || r.body.length > max) throw new Error("Keets media exceeds size limit");
    return r.body;
  }
  return {
    async fetch(url, max) {
      if (!validRef(url) || !Number.isInteger(max) || max < 1 || max > FETCH_MAX) throw new Error("Invalid Keets media request");
      return request("GET", "/media?url=" + urlEncode(url) + "&maxbytes=" + max, null, max);
    },
    async sharing(file, enabled) {
      validate(file);
      const body = Buffer.from(jsonWrite([["url", file.torrent], ["sharing", "" + !!enabled]]), "utf8");
      const r = jsonParse((await request("POST", "/private-sharing", body, 4096)).toString("utf8"));
      if (r.sharing !== "" + !!enabled) throw new Error("Node did not confirm file sharing state");
    },
    async forget(file) {
      validate(file);
      const body = Buffer.from(jsonWrite([["url", file.torrent]]), "utf8");
      const r = jsonParse((await request("POST", "/private-forget", body, 4096)).toString("utf8"));
      if (r.forgotten !== "true") throw new Error("Node did not confirm file removal");
    }
  };
}
/** KeetsMediaClient.local: the per-boot token is <node data dir>/keets/apitoken (at most 128 bytes). */
function mediaClientLocal(port, dataDirectory, http) {
  const file = path.join("" + dataDirectory, "keets", "apitoken");
  if (!path.isAbsolute(file) || fs.statSync(file).size > 128) throw new Error("Invalid Keets node directory");
  return mediaClient(port, fs.readFileSync(file, "latin1").trim(), http);
}

// ---- ChatKeetsTransport.java ----------------------------------------------------------------------
function toDataHex(payload) { return "0x" + Buffer.from(payload, "utf8").toString("hex").toUpperCase(); }   // ChatSchema.toDataHex
/**
 * nodeCmd(command) -> Promise<response>; it must THROW when the node answers status:false (main/chat.js nodeCmd).
 * tmpDir holds one ciphertext block at a time for the `keets action:publish ... file:` hand-off.
 */
/**
 * A folder the node can be handed a path in. The node's command reader splits on whitespace (CommandRunner), and its
 * quoting is not the same on every path it takes (a Windows path goes through another splitter), so the path must
 * have no space. A Windows user name with a space puts one in the temp folder: its short (8.3) name is the same
 * private folder without it. Where that cannot be had, the old refusal stands, with the path whole.
 */
function shortPathWin(dir) {
  return ("" + require("child_process").execFileSync("cmd.exe", ["/d", "/s", "/c", 'for %I in ("' + dir + '") do @echo %~sI'],
    { windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 })).trim();
}
function spaceFreeDir(dir, shortOf) {
  if (!/\s/.test(dir)) return dir;
  let alt = "";
  try { if (shortOf || process.platform === "win32") alt = "" + (shortOf || shortPathWin)(dir); } catch (e) { /* refused below */ }
  if (alt && !/\s/.test(alt) && path.isAbsolute(alt) && fs.existsSync(alt) && fs.statSync(alt).isDirectory()) return alt;
  throw new Error("The temporary folder path contains a space, and the node cannot be handed a file there: " + dir);
}
/** The mark the system puts on a downloaded file, on a file saved from a chat: macOS asks before opening it, Windows
 *  shows its "came from another computer" warning. Best effort: a file system without the mark still has the file. */
async function markDownloaded(dest, platform = process.platform, execFile = require("child_process").execFile) {
  try {
    if (platform === "darwin") await new Promise((res) => execFile("/usr/bin/xattr",
      ["-w", "com.apple.quarantine", "0081;" + Math.floor(Date.now() / 1000).toString(16) + ";" + require("./flavor").productName + ";", dest], { timeout: 5000 }, () => res()));
    else if (platform === "win32") await fsp.writeFile(dest + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch (e) { /* never fails the save */ }
}
function createTransport({ nodeCmd, http, tmpDir, shortOf }) {
  let media = null;
  const t = { via: "" };
  async function client() {
    if (media) return media;
    const info = await nodeCmd("keets action:info");
    if (!info || info.boundedMedia !== true) throw new Error("Update your Keets node to receive files");
    if (!/^[0-9]+$/.test("" + info.apiport)) throw new Error("Keets is starting; try again shortly");
    media = mediaClientLocal(parseInt("" + info.apiport, 10), "" + (await nodeCmd("status")).data, http);
    return media;
  }
  // every media call drops the cached client on failure: the sidecar may have restarted on a new port/token
  const guarded = (fn) => async (...a) => { try { return await fn(await client(), ...a); } catch (e) { media = null; throw e; } };
  t.send = async (peer, payload) => {
    if (!/^0x[0-9a-f]{64}$/i.test(peer)) throw new Error("Invalid contact");
    const r = await nodeCmd("keets action:send to:" + peer + " datahex:" + toDataHex(payload));
    t.via = "" + (r && r.delivered);
    return t.via;
  };
  t.publish = async (p, bytes) => {
    if (!PATH_RE.test(p)) throw new Error("Invalid file path");
    // the node command tokenizer splits on whitespace: a spaced path would rewrite the command
    const tmp = path.join(spaceFreeDir(tmpDir || os.tmpdir(), shortOf), "chat-file-" + randomHex(8) + ".bin");
    try {
      await fsp.writeFile(tmp, bytes, { flag: "wx", mode: 0o600 });
      return "" + (await nodeCmd("keets action:publish path:" + p + " file:" + tmp)).url;
    } finally { await fsp.rm(tmp, { force: true }); }
  };
  t.fetch = guarded((m, url, max) => m.fetch(url, max === undefined ? FETCH_MAX : max));
  t.sharing = guarded((m, file, enabled) => m.sharing(file, enabled));
  t.forget = async (file) => { await t.sharing(file, false); await guarded((m) => m.forget(file))(); };
  return t;
}

// ---- KeetsWire.fileControl + the file message ---------------------------------------------------
/** The chat payload that carries one delivery-receipt control. body = the control JSON; no name, key or bytes. */
function fileControl(body, now) {
  if (typeof body !== "string" || body.length > CONTROL_MAX) throw new Error("Invalid file control");
  const ts = now || Date.now();
  return jsonWrite([["application", APPLICATION], ["id", "pn-" + ts + "-" + crypto.randomInt(0x7fffffff).toString(16)],
    ["body", body], ["name", ""], ["ts", "" + ts, true], ["state", "file-control"]]);
}
function controlBody(id, digest, kind) { return jsonWrite([["v", "1"], ["id", id], ["digest", digest], ["kind", kind]]); }
/** The state:"file" chat payload (ChatFiles.java:181): body = file name, ref = the offer, id = kf-<file id>. */
function fileMessage(f, senderName, ts) {
  return JSON.stringify({ application: APPLICATION, id: "kf-" + f.id, body: f.name, name: "" + (senderName || ""), ts, ref: f.ref, state: "file" });
}

// ---- FileDelivery.java: durable verified-download receipts ----------------------------------------
/** send(peer, controlBody) and stop(id) may be async and may throw (hello/complete are durable and re-sent). */
function createDelivery(send, stop) {
  const states = new Map();
  let replies = [], ticking = false;
  const csv = (set) => [...set].sort().join(",");
  function save(s) {
    const json = jsonWrite([["digest", s.file.digest], ["mine", "" + s.mine], ["peers", csv(s.peers)], ["complete", "" + s.complete],
      ["acked", "" + s.acked], ["keep", "" + s.keep], ["stopped", "" + s.stopped], ["capable", csv(s.capable)], ["delivered", csv(s.delivered)]]);
    const tmp = path.join(path.dirname(s.path), "delivery.tmp");
    fs.writeFileSync(tmp, json); fs.renameSync(tmp, s.path);
  }
  const get = (id) => { const s = states.get(id); if (!s) throw new Error("Transfer not found"); return s; };
  const all = (s) => s.peers.size > 0 && [...s.peers].every((p) => s.delivered.has(p));
  const reply = (peer, body) => { if (replies.length < REPLY_QUEUE_MAX) replies.push([peer, body]); };
  return {
    register(f, directory, mine, peers) {
      const old = states.get(f.id);
      if (old) { if (old.file.ref !== f.ref) throw new Error("Conflicting transfer"); return; }
      const s = { file: f, path: path.join(directory, "delivery.json"), mine: !!mine, complete: false, acked: false, keep: false,
        stopped: false, stopping: false, peers: new Set(), capable: new Set(), delivered: new Set(), next: 0, backoff: 0, error: "" };
      for (const p of peers) s.peers.add(p.toLowerCase());
      if (fs.existsSync(s.path)) {
        if (fs.statSync(s.path).size > DELIVERY_STATE_MAX) throw new Error("Invalid delivery state");
        const m = jsonParse(fs.readFileSync(s.path, "utf8"));
        if (f.digest !== m.digest || "" + s.mine !== m.mine || csv(s.peers) !== m.peers) throw new Error("Conflicting delivery state");
        s.complete = m.complete === "true"; s.acked = m.acked === "true"; s.keep = m.keep === "true"; s.stopped = m.stopped === "true";
        for (const k of ["capable", "delivered"]) if (m[k] !== undefined) for (const x of m[k].split(",")) if (s.peers.has(x)) s[k].add(x);
      }
      states.set(f.id, s);
    },
    verified(id) { const s = get(id); if (!s.mine && !s.complete) { s.complete = true; s.next = 0; save(s); } },
    keep(id, keep) {
      const s = get(id);
      if (s.stopping) throw new Error("Sharing is stopping; try again shortly");
      s.keep = !!keep; if (keep) s.stopped = false; s.next = 0; save(s);
    },
    forget(id) { states.delete(id); },
    /** peer = the transport-authenticated sender. Throws on a control that is not flat JSON, exactly as the Java does. */
    inbound(peer, control) {
      if (typeof control !== "string" || control.length > CONTROL_MAX) return;
      const m = jsonParse(control), s = states.get(m.id);
      peer = ("" + peer).toLowerCase();
      if (!s || !s.peers.has(peer) || m.v !== "1" || s.file.digest !== m.digest) return;
      s.backoff = 0;   // the peer is answering: re-send at the fast cadence again
      if (m.kind === "hello" && !s.mine) reply(peer, controlBody(s.file.id, s.file.digest, "capable"));
      else if (m.kind === "capable" && s.mine) { s.capable.add(peer); save(s); }
      else if (m.kind === "complete" && s.mine) { s.capable.add(peer); s.delivered.add(peer); save(s); reply(peer, controlBody(s.file.id, s.file.digest, "ack")); }
      else if (m.kind === "ack" && !s.mine && s.complete) { s.acked = true; save(s); }
    },
    /** hello/complete re-send gaps: 15 s, 30 s, ... capped at 10 min while the peer is silent; an answer resets to 15 s. */
    async tick(now) {
      if (ticking) return;
      ticking = true;
      try {
        if (now === undefined) now = Date.now();
        const sends = replies, stops = []; replies = [];
        for (const s of states.values()) {
          if (!s.stopped && !s.keep && ((s.mine && all(s)) || (!s.mine && s.complete && s.acked))) stops.push(s);
          if (now < s.next) continue;
          const before = sends.length;
          if (s.mine) { for (const p of [...s.peers].sort()) if (!s.delivered.has(p)) sends.push([p, controlBody(s.file.id, s.file.digest, "hello")]); }
          else if (s.complete && !s.acked) for (const p of [...s.peers].sort()) sends.push([p, controlBody(s.file.id, s.file.digest, "complete")]);
          if (sends.length === before) continue;
          s.next = now + Math.min(RESEND_MS * 2 ** s.backoff, RESEND_CAP_MS); if (s.backoff < 6) s.backoff++;
        }
        for (const [p, body] of sends) try { await send(p, body); } catch (e) { /* durable, retried */ }
        for (const s of stops) {
          if (states.get(s.file.id) !== s || s.keep || s.stopped) continue;
          s.stopping = true;
          try {
            await stop(s.file.id);
            if (!s.keep) { s.stopped = true; s.error = ""; s.stopping = false; save(s); }
          } catch (e) { s.stopping = false; s.error = "Downloaded; could not stop sharing: " + (e && e.message); }
        }
      } finally { ticking = false; }
    },
    status(id) {
      const s = states.get(id), out = {};
      if (!s) return out;
      out.mine = "" + s.mine; out.keepSharing = "" + s.keep; out.sharingStopped = "" + s.stopped;
      out.downloaded = "" + s.delivered.size; out.recipients = "" + s.peers.size; out.digest = s.file.digest;
      if (s.mine) out.delivery = all(s) ? (s.stopped ? "Downloaded and verified · sharing stopped" : "Downloaded and verified · sharing")
        : s.capable.size === 0 ? "Download confirmation unavailable" : "Waiting for verified download";
      if (!s.mine && s.stopped) out.delivery = "Downloaded and verified · sharing stopped";
      if (s.error) out.deliveryError = s.error;
      return out;
    }
  };
}

// ---- the save-dialog default name --------------------------------------------------------------
/** A peer-supplied file name made safe as a save dialog DEFAULT: one path component, never empty, never hidden. */
function safeName(name) {
  let s = (typeof name === "string" ? name : "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, "")   // controls + bidi overrides (extension spoofing)
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (s.length > 120) {
    const dot = s.lastIndexOf("."), ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length).replace(/[.\s]+$/, "") + ext;
  }
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)) s = "_" + s;   // Windows device names
  return s || "file";
}

// ---- ChatFiles.java + ChatFileDelivery.java: the state machine ------------------------------------
/**
 * create({
 *   root,                     absolute dir, e.g. path.join(app.getPath("userData"), "chat-files")
 *   nodeCmd,                  (command) -> Promise<response>, throws on status:false
 *   hasContact,               (pubkey) -> boolean | Promise<boolean>
 *   myName,                   () -> this user's display name (default "")
 *   addMessage, setStatus,    chat-store's addMessage(m) / setStatus(msgid, patch) for the outgoing message row
 *   onUpdate,                 (id) -> void, a transfer changed (refresh the UI)
 *   sendPayload,              (peer, payload) -> Promise<via>; default = keets action:send through nodeCmd
 *   http, tmpDir, freeSpace, markDownloaded   test seams: loopback http function, publish temp dir, (root) -> free bytes, the downloaded mark
 * })
 */
function create(opts) {
  const root = opts.root;
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("chatfiles: root must be an absolute path");
  const transport = createTransport({ nodeCmd: opts.nodeCmd, http: opts.http, tmpDir: opts.tmpDir });
  const hasContact = async (p) => !!(await opts.hasContact(p));
  const sendPayload = opts.sendPayload || ((peer, payload) => transport.send(peer, payload));
  const freeSpace = opts.freeSpace || ((dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; });
  const changed = (t) => { try { if (opts.onUpdate) opts.onUpdate(t.file.id); } catch (e) { /* UI hook */ } };
  const live = new Map();   // id -> transfer being worked on (the phone's `active` set)
  let closed = false, chain = Promise.resolve(), timer = null;
  const job = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };   // one worker, like the phone's single-thread executor

  const dirOf = (id) => path.join(root, id);
  const offerPath = (t) => path.join(t.dir, "offer.json");
  function transfer(file, peer, mine) {
    return { file, dir: dirOf(file.id), peer, mine, msgid: "kf-" + file.id, ts: Date.now(), sent: false, prepared: true,
      running: false, done: 0, error: "", paused: true };
  }
  function ready(t) {
    try { const s = fs.statSync(path.join(t.dir, "verified.bin")); return s.isFile() && s.size === t.file.size; } catch (e) { return false; }
  }
  function write(t) {
    const tmp = path.join(t.dir, "offer.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ ref: t.file.ref, peer: t.peer, mine: t.mine, msgid: t.msgid, ts: t.ts, sent: t.sent, prepared: t.prepared }));
    fs.renameSync(tmp, offerPath(t));
  }
  function read(dir) {
    const p = path.join(dir, "offer.json");
    if (fs.statSync(p).size > OFFER_STATE_MAX) throw new Error("Invalid file state");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const f = parseRef(j.ref);
    if (path.basename(dir) !== f.id || typeof j.peer !== "string" || typeof j.mine !== "boolean"
        || typeof j.msgid !== "string" || !Number.isSafeInteger(j.ts)) throw new Error("Invalid file state");
    const t = transfer(f, j.peer, j.mine);
    t.sent = j.sent === true; t.prepared = j.prepared === undefined ? true : j.prepared === true; t.msgid = j.msgid; t.ts = j.ts;
    if (ready(t)) t.done = f.size;
    return t;
  }
  const subdirs = () => { try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch (e) { return []; } };
  function capacity(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > TRANSFER_MAX_BYTES) throw new Error(TEXT.limit);
    fs.mkdirSync(root, { recursive: true });
    let count = 0, used = 0;
    for (const d of subdirs()) {
      count++;
      try { used += 2 * cipherSize(read(d).file.size); } catch (e) { used += TRANSFER_MAX_BYTES * 2; }
    }
    if (count >= MAX_TRANSFERS || used + 2 * cipherSize(size) > MAX_STORE_BYTES || freeSpace(root) < 2 * cipherSize(size) + FREE_MARGIN)
      throw new Error(TEXT.storage);
  }
  function view(t) {
    const f = t.file, done = ready(t);
    return { id: f.id, name: f.name, mime: f.mime, size: f.size, ref: f.ref, peer: t.peer, mine: t.mine, msgid: t.msgid, ts: t.ts,
      sent: t.sent, prepared: t.prepared, running: t.running, done: done ? f.size : t.done, error: t.error, ready: done,
      canSave: done, canRemove: !t.running, canRun: !t.running && !(done && (!t.mine || t.sent)), delivery: delivery.status(f.id) };
  }
  function load(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("Transfer not found");
    if (live.has(id)) return live.get(id);
    try { return read(dirOf(id)); } catch (e) { throw new Error("Transfer not found"); }
  }

  // --- ChatFileDelivery: account-lifetime receipts, contacts only ---
  const delivery = createDelivery(
    async (peer, body) => { if (await hasContact(peer)) await transport.send(peer, fileControl(body)); },
    async (id) => { await transport.sharing(parseRef(JSON.parse(fs.readFileSync(path.join(dirOf(id), "offer.json"), "utf8")).ref), false); });
  const register = (t) => delivery.register(t.file, t.dir, t.mine, [t.peer]);
  async function restore() {
    for (const dir of subdirs()) try {
      if (!/^[a-f0-9]{32}$/.test(path.basename(dir))) continue;
      const t = read(dir);
      if (!isKeets(t.file) || !(await hasContact(t.peer))) continue;
      register(t);
      if (!t.mine && ready(t)) delivery.verified(t.file.id);
    } catch (e) { /* one bad directory never blocks the rest */ }
  }
  async function tick() { if (closed) return; try { await restore(); await delivery.tick(); } catch (e) { /* next tick */ } }

  // --- ChatFiles.enqueue: the one worker ---
  function enqueue(t, resume) {
    if (closed || t.running) return Promise.resolve(view(t));
    t.running = true; if (resume) t.paused = false; t.error = ""; live.set(t.file.id, t); changed(t);
    const cancelled = () => closed || t.paused;
    return job(async () => {
      try {
        if (cancelled()) throw paused();
        if (!t.prepared) throw new Error(TEXT.incomplete);
        if (!(await hasContact(t.peer))) throw new Error(TEXT.contact);
        if (fs.existsSync(offerPath(t))) {
          const saved = read(t.dir);
          if (saved.peer !== t.peer || saved.mine !== t.mine || saved.file.ref !== t.file.ref)
            throw new Error("File state changed. Close this sheet and reopen the file transfer.");
          t.sent = t.sent || saved.sent;
        } else if (fs.existsSync(t.dir)) throw new Error(TEXT.incomplete);
        else { capacity(t.file.size); fs.mkdirSync(t.dir); write(t); }
        const progress = (n) => { t.done = n; };
        const payload = path.join(t.dir, "payload.bin"), verified = path.join(t.dir, "verified.bin");
        if (t.mine) {
          if (!isKeets(t.file)) { t.done = 0; t.file = await publish(transport, payload, t.file, cancelled, progress); write(t); }
          register(t);
          if (!ready(t)) await decrypt(payload, verified, t.file, cancelled);
          if (cancelled()) throw paused();
          if (!t.sent) {
            const name = opts.myName ? "" + (opts.myName() || "") : "";
            if (opts.addMessage) opts.addMessage({ msgid: t.msgid, pubkey: t.peer, incoming: false, body: t.file.name, name, ref: t.file.ref,
              state: "file", ts: t.ts, via: "", read: true, status: "sending" });
            changed(t);
            try {
              const via = await sendPayload(t.peer, fileMessage(t.file, name, t.ts));
              if (opts.setStatus) opts.setStatus(t.msgid, { via, status: via === "direct" ? "delivered" : "mailboxed" });
              t.sent = true; write(t);
            } catch (e) {
              if (opts.setStatus) opts.setStatus(t.msgid, { via: "FAILED", status: "failed", error: e.message });
              throw e;
            }
          }
        } else {
          register(t);
          if (!ready(t)) await download(transport, t.file, t.dir, cancelled, progress);
          delivery.verified(t.file.id);
        }
        t.done = t.file.size;
      } catch (e) { t.error = (e && e.message) || TEXT.failed; }
      finally { t.running = false; t.paused = true; live.delete(t.file.id); changed(t); }
      return view(t);
    });
  }

  const api = {
    /**
     * Encrypt a local file, publish it and send the offer to `peer`. o = { name, mime } (defaults: the base name,
     * application/octet-stream). Resolves with the transfer's status; a failure is status.error, as on the phone.
     */
    prepare(peer, sourcePath, o) {
      return job(async () => {
        let t = null;
        try {
          const st = await fsp.stat(sourcePath);
          if (!st.isFile()) throw new Error(TEXT.limit);
          const size = st.size, name = (o && o.name) || path.basename(sourcePath), mime = (o && o.mime) || "application/octet-stream";
          capacity(size);
          const id = randomHex(16);
          const initial = chatFile(id, name, mime, size, randomHex(32), randomHex(8), ZERO_DIGEST, "");
          t = transfer(initial, peer, true); t.prepared = false;
          fs.mkdirSync(t.dir); write(t);
          t.running = true; t.paused = false; live.set(id, t); changed(t);
          const tr = t;
          const digest = await encrypt(sourcePath, path.join(t.dir, "payload.bin"), id, size, initial.key, initial.nonce,
            () => closed || tr.paused, (n) => { tr.done = n; });
          t.file = chatFile(id, name, initial.mime, size, initial.key, initial.nonce, digest, ""); t.prepared = true; write(t);
          t.running = false;
          if (closed || t.paused) { live.delete(id); changed(t); return t; }
          return t;
        } catch (e) {
          if (!t) throw e;
          t.running = false; t.error = (e && e.message) || TEXT.failed; live.delete(t.file.id);
          if (!fs.existsSync(offerPath(t))) fs.rmSync(t.dir, { recursive: true, force: true });
          changed(t);
          return t;
        }
      }).then((t) => (t.error || t.paused || closed ? view(t) : enqueue(t, false)));
    },
    /** Look at an offer from a chat row. Never downloads and never writes to disk. Throws on an invalid or conflicting offer. */
    offer(peer, ref) {
      const f = parseRef(ref); validate(f);
      if (live.has(f.id)) return view(live.get(f.id));
      const t = fs.existsSync(path.join(dirOf(f.id), "offer.json")) ? read(dirOf(f.id)) : transfer(f, peer, false);
      if (t.peer !== peer || t.file.ref !== ref) throw new Error("Conflicting file offer");
      return view(t);
    },
    /** The user asked for it: download (or resume) the offer from `peer`, then verify. */
    download(peer, ref) {
      const f = parseRef(ref); validate(f);
      const t = live.get(f.id) || (fs.existsSync(path.join(dirOf(f.id), "offer.json")) ? read(dirOf(f.id)) : transfer(f, peer, false));
      if (t.peer !== peer || t.file.ref !== ref) throw new Error("Conflicting file offer");
      return enqueue(t, true);
    },
    /** Send / resume (mine) or download / resume (theirs) a stored transfer. */
    resume(id) { return enqueue(load(id), true); },
    pause(id) { const t = live.get(id); if (t) { t.paused = true; changed(t); } },
    status(id) { return view(load(id)); },
    /** Stored transfers of one chat. */
    transfers(peer) {
      const out = [];
      for (const d of subdirs()) try { const t = read(d); if (t.peer === peer) out.push(view(live.get(t.file.id) || t)); } catch (e) { /* skip */ }
      return out;
    },
    /** Remove the local copy (and stop serving it). Refused while the transfer is running. */
    remove(id) {
      const t = load(id);
      if (t.running) return Promise.reject(new Error("Pause the transfer before removing it"));
      return job(async () => {
        if (isKeets(t.file)) await transport.forget(t.file);
        delivery.forget(t.file.id);
        fs.rmSync(t.dir, { recursive: true, force: true }); live.delete(t.file.id); changed(t);
      });
    },
    /** "Keep sharing" checkbox (my files): keep serving after the peer's verified download. */
    keep(id, on) {
      const t = load(id);
      return job(async () => { delivery.keep(t.file.id, !!on); if (on) await transport.sharing(t.file, true); return view(t); });
    },
    shareAgain(id) { return api.keep(id, true); },
    /** Copy the VERIFIED file to a path the caller chose (a save dialog). Nothing is ever opened. */
    async save(id, destPath) {
      const t = load(id);
      if (!ready(t)) throw new Error(TEXT.failed);
      const dest = path.resolve("" + destPath);
      if (!path.isAbsolute("" + destPath) || (dest + path.sep).startsWith(path.resolve(root) + path.sep)) throw new Error("Choose a different place to save the file");
      try { await fsp.copyFile(path.join(t.dir, "verified.bin"), dest); }
      catch (e) { await fsp.rm(dest, { force: true }).catch(() => {}); throw e; }
      await (opts.markDownloaded || markDownloaded)(dest);
      return dest;
    },
    /** Inbox drainer hook for state:"file-control". Contacts only; never throws (a malformed control must not wedge the drain). */
    async inboundControl(from, body) {
      try { if (await hasContact(from)) { await restore(); delivery.inbound(from, body); } } catch (e) { /* consumed */ }
    },
    inboundOffer,
    tick,
    /** Receipts keep working with no chat open: first pass after 1 s, then every 5 s. */
    startLoop() {
      if (timer || closed) return;
      const arm = (ms) => { timer = setTimeout(async () => { await tick(); if (timer) arm(TICK_MS); }, ms); if (timer.unref) timer.unref(); };
      arm(TICK_FIRST_MS);
    },
    stopLoop() { if (timer) { clearTimeout(timer); timer = null; } },
    /** Pause everything (app quitting / node stopping). Paused work resumes with resume(id). */
    close() { closed = true; api.stopLoop(); for (const t of live.values()) t.paused = true; return chain; },
    _delivery: delivery, _transport: transport
  };
  return api;
}

module.exports = {
  create, safeName, inboundOffer,
  // protocol pieces (pure; used by the tests and by anything that only needs to look at an offer)
  chatFile, parseRef, validate, isKeets, cipherSize, encrypt, decrypt, sealRecord, openRecord, publish, download, manifestBytes,
  fileMessage, fileControl, controlBody, createDelivery, createTransport, mediaClient, mediaClientLocal, loopbackHttp,
  jsonWrite, jsonParse, urlEncode, validRef, toDataHex, randomHex, spaceFreeDir, markDownloaded,
  PREFIX, MAX_BYTES, TRANSFER_MAX_BYTES, MAX_REF_CHARS, PIECE, PLAIN_PIECE, BLOCK, MANIFEST_LIMIT, FETCH_MAX, MAX_TRANSFERS,
  MAX_STORE_BYTES, FREE_MARGIN, CONTROL_MAX, PATH_RE, TEXT
};
