"use strict";
const keyuses = require("./keyuses");
const helper = require("./classic-webwallet");
const net = require("./netfetch");

async function inspect(seed, mode, knownAddress, migrate) {
  const classic = mode === "classic";
  if ((!classic && mode !== "block") || typeof seed !== "string" || !seed.trim() || seed.length > 2048)
    throw Error("Check the recovery words and wallet type.");
  const {keys} = await helper.run({action:"addresses", accountMode:mode, seed, keyIndex:"0"});
  if (!Array.isArray(keys) || keys.length !== (classic ? 64 : 32) ||
      !keys.some(k=>k.miniaddress === knownAddress || k.address.toLowerCase() === String(knownAddress).toLowerCase()))
    throw Error("That receive address does not match these words and wallet type. Check your old wallet.");
  const rows = keyuses.select({status:true,response:{keys:keys.map(k=>({publickey:k.publickey,uses:0,...keyuses.SHAPES[mode]}))}});
  const found = await keyuses.lookup(rows,url=>net.fetchJson(url,{noRedirect:true,maxBytes:keyuses.MAX_BODY_BYTES}));
  const audit = keyuses.join(rows,found.usage,found.reuse);
  if (!audit.complete || found.tip < 1) throw Error("The key check is incomplete. Try again before restoring.");
  if (!keyuses.selfTest()) throw Error(keyuses.MSG.selfTest);
  const wallet = require("./webwallet");
  const minimum = classic ? Math.max(audit.recommendedKeyUses,...audit.rows.map(r=>r.coins),
    ...keys.map(k=>wallet.keyusesInfo(k.address).keyuses)) : 0;
  const mainKey = migrate && classic ? await helper.run({action:"derive",accountMode:"block",keyIndex:"0",seed}) : keys[0];
  return {minimum,reused:audit.rows.filter(r=>r.reused).length,addresses:keys.map(k=>k.address),mainPublicKey:mainKey.publickey};
}
module.exports = {inspect};
