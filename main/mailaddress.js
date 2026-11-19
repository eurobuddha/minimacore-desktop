// Wire-compatible with Android MailAddress and MailBeacon (v1).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const words = fs.readFileSync(path.join(__dirname, "mail-address-words.txt"), "utf8").trim().split(/\r?\n/);
if (words.length !== 2048 || new Set(words).size !== 2048) throw new Error("Invalid Mail dictionary");
const dictionary = new Set(words);
const ADDRESS = "0x4D41494C4144445231";
const isKey = key => typeof key === "string" && /^0x[\da-f]{128}$/i.test(key);
function tagged(domain, key) {
  if (!isKey(key)) throw new Error("Invalid Mail key");
  return Buffer.concat([Buffer.from(domain + "\0", "ascii"), Buffer.from(key.slice(2), "hex")]);
}
function phrase(key) {
  const digest = crypto.createHash("sha256").update(tagged("minima-mail-address-v1", key)).digest();
  const result = [];
  for (let start = 0; start < 66; start += 11) {
    let index = 0;
    for (let bit = start; bit < start + 11; bit++) index = index * 2 + ((digest[bit >> 3] >> (7 - bit % 8)) & 1);
    result.push(words[index]);
  }
  return result.join("-");
}
function normalize(input) {
  if (typeof input !== "string" || input.length > 100) return null;
  const parts = input.trim().toLowerCase().split(/[\s-]+/);
  return parts.length === 6 && parts.every(word => dictionary.has(word)) ? parts.join("-") : null;
}
function link(key) { return "minimamail://contact/" + phrase(key) + "?id=" + key.toLowerCase(); }
function direct(input) {
  if (typeof input !== "string" || input.length > 400) return null;
  const match = /^(?:([^\n]+)\n)?(minimamail:\/\/contact\/([a-z]+(?:-[a-z]+){5})\?id=(0x[0-9a-f]{128}))$/.exec(input.trim());
  if (!match || (match[1] && normalize(match[1]) !== match[3]) || link(match[4]) !== match[2]) return null;
  return match[4];
}
function tag(address) { return "0x" + Buffer.from(address, "ascii").toString("hex").toUpperCase(); }
function card(sodium, id) {
  const sig = sodium.crypto_sign_detached(tagged("minima-mail-card-v1", id.publicId), id.signSk);
  return { key: id.publicId.toLowerCase(), sig: Buffer.from(sig).toString("hex"), phrase: phrase(id.publicId) };
}
function verify(sodium, key, sig, address) {
  return isKey(key) && typeof sig === "string" && /^[0-9a-f]{128}$/i.test(sig) && phrase(key) === address
    && sodium.crypto_sign_verify_detached(Buffer.from(sig, "hex"), tagged("minima-mail-card-v1", key), Buffer.from(key.slice(66), "hex"));
}
/** MailBeacon.inspect: the one valid card for these words in the window, and the newest block a matching beacon was created in. */
async function inspect(run, sodium, address, depth) {
  if (!address || normalize(address) !== address || ![1000, 1500].includes(depth)) throw new Error("Invalid Mail address");
  const t = tag(address);
  const reply = await run("coins address:" + ADDRESS + " tokenid:0x00 state:" + t + " simplestate:true order:desc depth:" + depth);
  if (reply?.status !== true || !Array.isArray(reply.response)) throw new Error("Could not read Mail address beacons.");
  let found = null, block = 0;
  for (const coin of reply.response) {
    const state = coin?.state;
    if (String(coin?.address).toUpperCase() !== ADDRESS.toUpperCase() || String(coin.tokenid).toLowerCase() !== "0x00" ||
        String(state?.[0]).toUpperCase() !== t.toUpperCase() || typeof state[2] !== "string" || !/^0x/i.test(state[2])) continue;
    const sig = state[2].slice(2), key = state[1];
    if (!verify(sodium, key, sig, address)) continue;
    if (found && found.key !== key.toLowerCase()) throw new Error("Multiple keys match this address. Ask for a contact link.");
    found = { key: key.toLowerCase(), sig: sig.toLowerCase(), phrase: address };
    const created = /^\d{1,15}$/.test(String(coin.created)) ? Number(coin.created) : 0;   // Java optLong("created", 0)
    block = Math.max(block, created);
  }
  return { card: found, block };
}
async function find(run, sodium, address, depth) { return (await inspect(run, sodium, address, depth)).card; }
/** MailAddress.canonicalKey: a Mail key with or without 0x, lower case; null for anything else. */
function canonicalKey(value) {
  if (typeof value !== "string" || !/^(?:0x)?[a-f0-9]{128}$/i.test(value)) return null;
  return (value.length === 128 ? "0x" + value : value).toLowerCase();
}
/** MailAddress.display: the six words of a key; anything that is not a key is shown as it is. */
function display(value) { const key = canonicalKey(value); return key === null ? value : phrase(key); }
/** MailAddress.lookupReady: is this worth a lookup yet (a key, a link, or six list words). */
function lookupReady(input) {
  input = String(input || "");
  const bar = input.indexOf("|");
  return canonicalKey(bar < 0 ? input : input.slice(0, bar).trim()) !== null || input.includes("minimamail:") || normalize(input) !== null;
}
module.exports = { words, phrase, normalize, link, direct, tag, card, verify, find, inspect, canonicalKey, display, lookupReady, isKey, ADDRESS,
  FRESH: 1000, DISCOVERY: 1500 };
