/*
 * chatbackup.js — the bears' "Chat backup" file (.kbak), readable and writable on desktop.
 * Format = apks/base ChatBackup.java: a VaultCrypto MVLT container
 *   "MVLT" 01 01 | iterations u32 (210000) | 16 salt | 12 nonce | AES-256-GCM(ct‖tag), AAD = the 40-byte header
 *   key = HKDF-Expand-SHA256(PBKDF2-HMAC-SHA256(pass, salt, 210000), "minima-wallet-vault/aes-256-gcm/v1", 32)
 * around a zip of manifest.json, keets/keypair, chat/contacts.json, chat/messages.json and (phone only)
 * maxchat/**. Rows use the phone's keetchat.db column names; desktop maps them to chat-store objects.
 * Desktop has no MAX# client: it never writes maxchat/ and ignores it on restore.
 * Pure functions (no Electron) so scripts/chatbackup-test.cjs can run them under plain node.
 */
const crypto = require("crypto");
const zlib = require("zlib");

const ROUNDS = 210000;
const INFO = Buffer.from("minima-wallet-vault/aes-256-gcm/v1");
const MAX_FILE = 64 * 1024 * 1024;
const FORMAT = "keets-chat-backup";

function aesKey(pass, salt) {
  const master = crypto.pbkdf2Sync(Buffer.from(String(pass), "utf8"), salt, ROUNDS, 32, "sha256");
  const key = crypto.createHmac("sha256", master).update(Buffer.concat([INFO, Buffer.from([1])])).digest();
  master.fill(0);
  return key;
}

function seal(pass, plain) {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const header = Buffer.alloc(40);
  header.write("MVLT"); header[4] = 1; header[5] = 1; header.writeUInt32BE(ROUNDS, 6);
  header[10] = 16; salt.copy(header, 11); header[27] = 12; nonce.copy(header, 28);
  const key = aesKey(pass, salt);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(header);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  key.fill(0);
  return Buffer.concat([header, ct]);
}

/** Throws Error("BAD_PASSWORD") for a wrong password or any file that is not a chat backup container. */
function unseal(pass, data) {
  data = Buffer.from(data);
  if (data.length < 56 || data.length > MAX_FILE || data.toString("latin1", 0, 6) !== "MVLT\x01\x01"
      || data.readUInt32BE(6) !== ROUNDS || data[10] !== 16 || data[27] !== 12) throw new Error("BAD_PASSWORD");
  const key = aesKey(pass, data.subarray(11, 27));
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(28, 40), { authTagLength: 16 });
    d.setAAD(data.subarray(0, 40));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(40, data.length - 16)), d.final()]);
  } catch (e) {
    throw new Error("BAD_PASSWORD");
  } finally {
    key.fill(0);
  }
}

// ---- zip: STORED on write (Java's ZipInputStream reads sizes from the local header); STORED or
// DEFLATED on read via the central directory (Java's ZipOutputStream writes data descriptors). ----

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8"), crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const KNOWN = /^(manifest\.json|keets\/keypair|chat\/contacts\.json|chat\/messages\.json|maxchat\/seed|maxchat\/(node|chat)\/[^\\]+)$/;

function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a chat backup");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16), total = 0;
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged backup");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    if (!KNOWN.test(name) || name.includes("..")) throw new Error("unexpected entry " + name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE }) : null;
    if (!data || data.length !== size) throw new Error("damaged backup");
    total += size;
    if (total > 4 * MAX_FILE) throw new Error("backup too large");
    out.set(name, data);
  }
  return out;
}

// ---- rows: chat-store objects <-> keetchat.db columns ----

function msgToRow(m) {
  return { msgid: m.msgid, pubkey: m.pubkey, incoming: m.incoming ? 1 : 0, body: m.body || "", name: m.name || "",
    ref: m.ref || "", ts: m.ts || 0, via: m.via || "", read: m.read ? 1 : 0, state: m.state || "", amt: m.amt || "",
    tokname: m.tokname || "", txid: m.txid || "", peerread: m.peerread ? 1 : 0, status: m.status || "" };
}
function rowToMsg(r) {
  const m = { msgid: String(r.msgid), pubkey: String(r.pubkey), incoming: !!Number(r.incoming), body: r.body || "",
    name: r.name || "", ref: r.ref || "", ts: Number(r.ts) || 0, via: r.via || "", read: !!Number(r.read),
    state: r.state || "", amt: r.amt || "", tokname: r.tokname || "", txid: r.txid || "", peerread: !!Number(r.peerread) };
  if (r.status) m.status = r.status;
  return m;
}

/**
 * state = { keypair: Buffer|null, keetsPubkey, chatName, contacts: [chat-store contact], messages: [chat-store msg],
 *           payaddr: { pubkey: addr } }  ->  encrypted .kbak bytes
 */
function exportBackup(pass, state) {
  const contacts = state.contacts.map(c => ({ pubkey: c.pubkey, name: c.name || c.pubkey, maximapk: c.maximapk || "",
    payaddr: (state.payaddr || {})[c.pubkey] || "", lastreceipt: "", added: Date.now() }));
  const messages = state.messages.map(msgToRow);
  const manifest = { format: FORMAT, version: 1, created: Date.now(), keetsPubkey: state.keetsPubkey || "", maxAddress: "",
    contacts: contacts.length, messages: messages.length, chatName: state.chatName || "" };
  const entries = [["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))]];
  if (state.keypair) entries.push(["keets/keypair", Buffer.from(state.keypair)]);
  entries.push(["chat/contacts.json", Buffer.from(JSON.stringify(contacts))]);
  entries.push(["chat/messages.json", Buffer.from(JSON.stringify(messages))]);
  return seal(pass, zip(entries));
}

/** Decrypt + check. Returns { manifest, keypair, contacts:[{pubkey,name,maximapk,payaddr}], messages:[chat-store msg], hasMax }. */
function openBackup(pass, file) {
  const files = unzip(unseal(pass, file));
  const m = files.get("manifest.json");
  if (!m) throw new Error("not a chat backup");
  const manifest = JSON.parse(m.toString("utf8"));
  if (manifest.format !== FORMAT || !(manifest.version <= 1)) throw new Error("not a chat backup (or one made by a newer app)");
  const keypair = files.get("keets/keypair") || null;
  if (keypair && keypair.length !== 32) throw new Error("keets keypair is " + keypair.length + " bytes, expected 32");
  const json = (k) => files.has(k) ? JSON.parse(files.get(k).toString("utf8")) : [];
  return { manifest, keypair, contacts: json("chat/contacts.json"), messages: json("chat/messages.json").map(rowToMsg),
    hasMax: files.has("maxchat/seed") };
}

module.exports = { exportBackup, openBackup, seal, unseal, zip, unzip, FORMAT, MAX_FILE };
