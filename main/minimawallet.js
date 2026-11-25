// A minimaWallet profile lives independently of the node wallet. Only public addresses leave main.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { app, safeStorage } = require("electron");
const wallet = require("./webwallet");

let current, busy = false;
const addresses = new Map();
let trackedNode;
const file = () => path.join(app.getPath("userData"), "minimawallet.profile");
function secureStorage() {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"))
    throw new Error("Unlock the system keyring to use minimaWallet.");
  return safeStorage;
}
function save(profile) {
  const encrypted = secureStorage().encryptString(JSON.stringify(profile));
  const dest = file(), tmp = dest + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dest);
  current = profile;
  addresses.clear();
  trackedNode = null;
}
function existing() {
  if (current) return current;
  let bytes;
  try { bytes = fs.readFileSync(file()); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const profile = JSON.parse(secureStorage().decryptString(bytes));
    if (!wallet._validators.isPhrase(profile.seed) || !["classic", "block"].includes(profile.mode) || !profile.id) throw Error();
    return current = profile;
  } catch { throw new Error("Could not unlock the saved minimaWallet profile."); }
}
async function create(seed, mode, source, expectedSeed) {
  if (!["classic", "block"].includes(mode) || !wallet._validators.isPhrase(seed) || (source === "manual" && seed.trim().length < 16))
    throw new Error("Enter a seed phrase of at least 16 characters and choose a key mode.");
  const options = { accountMode: mode, keyIndex: "0" };
  if (expectedSeed) options.expectedSeed = expectedSeed;
  const root = await wallet.derive(seed, options);
  const profile = { id: randomUUID(), seed, source, mode };
  save(profile);
  addresses.set(0, root);
  return profile;
}
async function fromNode() {
  const v = await wallet.checkedCommand("vault");
  if (v?.locked !== false || !/^0x[0-9a-f]{64,128}$/i.test(v.seed) || !v.phrase)
    throw new Error("Unlock the node wallet to set up minimaWallet.");
  return create(v.phrase, "classic", "node", v.seed);
}
async function exclusive(operation) {
  if (busy) throw new Error("A minimaWallet operation is in progress.");
  busy = true;
  try { return await operation(); } finally { busy = false; }
}
function verify(profile, id) {
  if (!profile || profile.id !== id) throw new Error("The wallet changed. Open minimaWallet again.");
}
async function key(profile, index) {
  if (!Number.isInteger(index) || index < 0 || index >= (profile.mode === "classic" ? 64 : 32)) throw new Error("Invalid wallet address index.");
  if (!addresses.has(index)) addresses.set(index, await wallet.derive(profile.seed, { accountMode: profile.mode, keyIndex: String(index) }));
  return addresses.get(index);
}
async function prepare(profile) {
  const root = await key(profile, 0);
  const count = profile.mode === "classic" ? 64 : 32;
  if (addresses.size !== count) {
    const { keys } = await require("./classic-webwallet").run({ action:"addresses", seed:profile.seed, keyIndex:"0", accountMode:profile.mode });
    if (!Array.isArray(keys) || keys.length !== count || keys[0].address !== root.address ||
        keys.some(k => !/^0x[0-9a-f]{64}$/i.test(k.address) || !/^0x[0-9a-f]{64}$/i.test(k.publickey)
          || k.script !== "RETURN SIGNEDBY(" + k.publickey + ")" || !wallet._validators.looksLikeMinimaAddress(k.miniaddress)))
      throw new Error("Could not verify the wallet address book.");
    keys.forEach((k,i) => addresses.set(i,k));
  }
  const native = (await wallet.checkedCommand("keys action:list"))?.keys;
  if (!Array.isArray(native) || !native.length || !native.every(k=>/^0x[0-9a-f]{64}$/i.test(k.publickey))) throw new Error("Could not read the node wallet.");
  const nativeKeys = new Set(native.map(k=>k.publickey.toUpperCase()));
  const identity = native[0].publickey;
  if (trackedNode !== identity && !nativeKeys.has(root.publickey.toUpperCase())) {
    for (const item of addresses.values()) {
      if (nativeKeys.has(item.publickey.toUpperCase())) continue;
      const known = await wallet.checkedCommand("checkaddress address:" + item.address);
      if (known?.["0x"]?.toLowerCase() !== item.address.toLowerCase()) throw new Error("Could not verify the wallet address book.");
      if (!known.relevant && !known.simple) await wallet.checkedCommand('newscript trackall:true script:"' + item.script + '"');
    }
  }
  trackedNode = identity;
}
async function portfolio(id) {
  return exclusive(async () => {
    const profile = existing(); verify(profile, id);
    await prepare(profile);
    const mega = await wallet.isMegammr(), out = [];
    for (const [index, item] of addresses) {
      const rows = await wallet.read(item.address, mega);
      const balances = rows.filter(row => Number(row.confirmed) > 0 || Number(row.unconfirmed) > 0);
      if (balances.length) out.push({index, address:item.miniaddress, balances});
    }
    return out;
  });
}
async function selected(profile, index) {
  const root = await key(profile, 0), item = await key(profile, index);
  const owned = await wallet.nodeHasPubkey(root.publickey) || (index !== 0 && await wallet.nodeHasPubkey(item.publickey));
  return { item, root, owned };
}
async function open(id, index = 0) {
  return exclusive(async () => {
    let p = existing();
    if (id) verify(p, id);
    if (!p) p = await fromNode();
    await prepare(p);
    const { item, owned } = await selected(p, index);
    const mega = await wallet.isMegammr();
    const balances = await wallet.read(item.address, mega);
    return { id: p.id, mode: p.mode, source: p.source, index, address: item.address, miniaddress: item.miniaddress, owned, balances, mega };
  });
}
async function replace(id, options) {
  return exclusive(async () => {
    verify(existing(), id);
    const p = options?.source === "node" ? await fromNode() : await create(options?.seed, options?.mode, "manual");
    return p.id;
  });
}
async function audit(id, index) {
  return exclusive(async () => {
    const p = existing(); verify(p, id);
    const { item, root, owned } = await selected(p, index);
    if (owned) throw new Error("This node owns the signing key. Use the Wallet tab to send.");
    return wallet.paymentFloor(item.address, item.publickey, p.mode === "block" ? root.address : null);
  });
}
async function send(id, index, opts) {
  return exclusive(async () => {
    const p = existing(); verify(p, id);
    const { item, root, owned } = await selected(p, index);
    if (owned) throw new Error("This node owns the signing key. Use the Wallet tab to send.");
    return wallet.send({ seed: p.seed, to: opts.to, tokenid: opts.tokenid, amount: opts.amount, keyuses: opts.keyuses }, {
      address: item.address, root: root.address, rootKey: root.publickey, options: { accountMode: p.mode, keyIndex: String(index) }
    });
  });
}
module.exports = { open, replace, audit, send, portfolio, nodeChanged: () => { trackedNode = null; } };
