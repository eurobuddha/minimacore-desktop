"use strict";
const keyuses = require("./keyuses");
const helper = require("./classic-webwallet");
const net = require("./netfetch");
const wallet = require("./webwallet");

async function inspect(seed, mode, migrate) {
  if (!Object.hasOwn(keyuses.SHAPES, mode) || typeof seed !== "string" || !seed.trim() || seed.length > 2048)
    throw Error("Check the recovery words and wallet type.");
  if (!keyuses.selfTest()) throw Error(keyuses.MSG.selfTest);

  const books = {};
  const descriptors = [];
  for (const [family, count] of [["classic", 64], ["block", 32]]) {
    const {keys} = await helper.run({action:"addresses", accountMode:family, seed, keyIndex:"0"});
    if (!Array.isArray(keys) || keys.length !== count) throw Error("Could not derive the complete wallet address book.");
    books[family] = keys;
    for (const key of keys) {
      if (keyuses.addressOf(key.publickey)?.hex !== key.address) throw Error(keyuses.MSG.selfTest);
      descriptors.push({publickey:key.publickey, uses:0, ...keyuses.SHAPES[family]});
    }
  }

  const rows = keyuses.select({status:true, response:{keys:descriptors}});
  const found = await keyuses.lookup(rows, url => net.fetchJson(url, {noRedirect:true, maxBytes:keyuses.MAX_BODY_BYTES}));
  const audit = keyuses.join(rows, found.usage, found.reuse);
  if (!audit.complete || found.tip < 1) throw Error("The key check is incomplete. Try again before restoring.");

  const source = books[mode];
  const minimum = mode === "classic" ? Math.max(audit.recommendedKeyUses,
    ...audit.rows.filter(row => row.family === "classic").map(row => row.coins),
    ...source.map(key => wallet.keyusesInfo(key.address).keyuses)) : 0;
  return {minimum, reused:audit.rows.filter(row => row.reused).length, classic:audit.classicKeys, block:audit.blockKeys,
    addresses:source.map(key => key.address), mainPublicKey:books[migrate ? "block" : mode][0].publickey};
}
module.exports = {inspect};
