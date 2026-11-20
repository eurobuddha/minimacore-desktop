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
function display(key) {
  if (typeof key === "string" && /^[a-f0-9]{128}$/i.test(key)) key = "0x" + key;
  return isKey(key) ? phrase(key) : key;
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
/** The signed card for six words, or null. info (optional) receives { first }: the oldest beacon's block, 0 = not known.
 *  It is not part of the card, which is stored and compared as it is. */
async function find(run, sodium, address, depth, info) {
  if (!address || normalize(address) !== address || ![1000, 1500].includes(depth)) throw new Error("Invalid Mail address");
  const t = tag(address);
  const reply = await run("coins address:" + ADDRESS + " tokenid:0x00 state:" + t + " simplestate:true order:desc depth:" + depth);
  if (reply?.status !== true || !Array.isArray(reply.response)) throw new Error("Could not read Mail address beacons.");
  let found = null, oldest = 0;
  for (const coin of reply.response) {
    const state = coin?.state;
    if (String(coin?.address).toUpperCase() !== ADDRESS.toUpperCase() || String(coin.tokenid).toLowerCase() !== "0x00" ||
        String(state?.[0]).toUpperCase() !== t.toUpperCase() || typeof state[2] !== "string" || !/^0x/i.test(state[2])) continue;
    const sig = state[2].slice(2), key = state[1];
    if (!verify(sodium, key, sig, address)) continue;
    if (found && found.key !== key.toLowerCase()) throw new Error("Multiple keys match. Ask for a contact link.");
    const made = Number(coin.created) || 0, block = Math.max(found?.block || 0, made);
    const first = made > 0 ? Math.min(oldest || made, made) : oldest;   // the oldest beacon in the window: how long this key has held the words
    found = { key: key.toLowerCase(), sig: sig.toLowerCase(), phrase: address };
    if (Number.isSafeInteger(block) && block > 0) found.block = block;
    oldest = first;
  }
  if (info) info.first = found && Number.isSafeInteger(oldest) ? oldest : 0;
  return found;
}
module.exports = { words, phrase, display, normalize, link, direct, tag, card, verify, find, isKey, ADDRESS };
