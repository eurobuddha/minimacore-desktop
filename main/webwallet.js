/* Classic Web Wallet key zero, independent of the node wallet mode. The helper takes
 * secrets on stdin. RPC only reads public chain data and relays signed transactions.
 * The saved per-address count reserves each one-time leaf before signing. */
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { rpcCall } = require("./rpc"), { oneCommand } = require("./cmdverb");
const { toUnits } = require("./sendpin");
const { randomUUID } = require("crypto");
const helper = require("./classic-webwallet");
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();
const LOG_RING = [];

let runner0 = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
const runner = (cmd) => { try { return runner0(oneCommand(cmd)); } catch (e) { return Promise.reject(e); } };   // ONE command each (main/rpc.js, 0.19.194)
function log(line) { const e = new Date().toISOString().slice(11, 19) + " " + String(line); LOG_RING.push(e); if (LOG_RING.length > 200) LOG_RING.shift(); }

// ---------------------------------------------------------------------------
// validation — NEVER interpolate unvalidated free-text into a command string
// (the node's parser is space-tokenised + last-wins, so injection = fund redirect).
// ---------------------------------------------------------------------------
// A real Minima receiving address: Mx… (base58 alphanumeric, len 40–80) or 0x + up to 64 hex. Charset-locked
// (copied from mail.js looksLikeMinimaAddress — a length-only check let "Mx… address:0x<attacker>" through).
function looksLikeMinimaAddress(a) {
  if (typeof a !== "string") return false;
  if (/^0x[0-9A-Fa-f]{1,64}$/.test(a)) return true;
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  return false;
}
// ANY non-empty phrase of any length/case is a valid Minima seed (anyphrase — see header). Reject ONLY what would
// break out of phrase:"…" (`"` / `\`) or silently change the derived seed (control chars / newlines). This is the
// desktop restore flow's guard (renderer/app.js:293-294): NOT a word-count or dictionary check.
function isPhrase(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 1024) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 34 || c === 92 || c === 59 || c === 127) return false; }  // reject control chars, double-quote(34), backslash(92), ";"(59: the node starts a second command there, 0.19.194) and DEL
  return true;
}
function isAmount(a) { return typeof a === "string" && /^\d{1,30}(\.\d{1,30})?$/.test(a) && Number(a) > 0; }
function isTokenid(t) { return t === "0x00" || (typeof t === "string" && /^0x[0-9A-Fa-f]{64}$/.test(t)); }
function isScript(s) { return typeof s === "string" && /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{2,140}\)$/.test(s); }

// ---------------------------------------------------------------------------
// keyuses store — durable, monotonic, reserve-before-sign. { "<0xaddr>": { keyuses, ack } }
// ---------------------------------------------------------------------------
function storePath() { return path.join(app ? app.getPath("userData") : ".", "webwallet-keyuses.json"); }
// 0.19.230: only a store that does not exist yet is empty. Any other failure (unreadable, not JSON, a counter that is not
// a whole number of 0 or more) THROWS, so nothing is signed: reading it as {} restarted every counter at 0 = a key use twice.
const STORE_BAD = "The Web Wallet's key-use record could not be read, so nothing was sent (a send now could use a one-time key twice). Check the file webwallet-keyuses.json in the app's data folder.";
function loadStore() {
  let raw;
  try { raw = fs.readFileSync(storePath(), "utf8"); } catch (e) { if (e && e.code === "ENOENT") return {}; throw new Error(STORE_BAD); }
  let j; try { j = JSON.parse(raw); } catch (e) { throw new Error(STORE_BAD); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(STORE_BAD);
  return j;   // one damaged entry refuses only its own address (0.19.255, as released 0.18.215): entryFor
}
function writeStore(obj) {
  const p = storePath(), tmp = p + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);   // atomic replace
  // fsync the DIRECTORY too, so the rename (i.e. the counter advance) survives power-loss. Without this a crash
  // between rename and the dir flush could revert to a LOWER counter → reuse a WOTS leaf next boot = fund loss.
  try { const dfd = fs.openSync(path.dirname(p), "r"); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch (e) {}
}
// The official classic tree has 64 keys per level and three levels.
const KEY_USES = 262144, LAST_USE = KEY_USES - 1;
// The released tree's sentences, word for word (0.19.341, as 0.18.265 / 0.18.270 / 0.18.271 / 0.18.275).
const OVER_MAX = "The key-use count can be at most 262143 (a key of this wallet has 262144 one-time uses, numbered 0 to 262143). Nothing was saved.";
const USED_UP = (chain) => "The chain's figure for this key (" + chain + ") is at or above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). The figure can count more uses than the key signed, but this app will not sign from this address: signing past the last use would reuse a one-time key, which can lose funds. Nothing was saved.";
/** Why a stored next use past the last one cannot sign (as released 0.18.265): exactly 262144, every use was made; above it, a count confirmed
 *  too high before the ceiling existed, never lowered here. saving: said on a refused confirmation, which ends "Nothing was saved". */
function overCount(n, saving) {
  if (n === KEY_USES) return saving ? "This wallet's count for this key has reached the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was saved."
    : "This wallet's count for this key has reached the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.";
  return saving ? "This wallet's saved key-use count (" + n + ") is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was saved."
    : "This wallet's saved key-use count (" + n + ") is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.";
}
const BELOW_SAVED = (n) => "The saved next key use is " + n + ". Enter at least that number.";
const DAMAGED_BELOW = (n) => "This key's saved count read " + n + " before it was damaged. Confirm at least that many. Nothing was saved.";
// What a damaged entry's old value still says (0.19.324): a count written as a number or as digits, a fraction rounded UP (57.5 and
// "57.5" read 58), is a floor too; anything else reads 0 (unknown: the chain's figure is the floor then)
function oldCount(v) {
  const k = v && typeof v === "object" ? v.keyuses : undefined;
  const x = typeof k === "number" ? k : typeof k === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(k) ? Number(k) : NaN;
  if (x === Infinity) return Infinity;   // 1e400 in the file, or a digit run too long for a double: over every limit (0.19.334), never 0
  return Number.isFinite(x) && x >= 0 ? Math.ceil(x) : 0;
}
const entryOk = (v) => !!v && typeof v === "object" && Number.isSafeInteger(v.keyuses) && v.keyuses >= 0;
/** An address's entry; a damaged one (a counter that is not a whole number of 0 or more) is unknown, so it must be confirmed again. */
function entryFor(store, addr) {
  if (!Object.hasOwn(store, addr)) return { keyuses: 0, ack: false };
  return entryOk(store[addr]) ? store[addr] : { keyuses: oldCount(store[addr]), ack: false, damaged: true };
}
// The chain's figure for a key (main.js: main/keyuses.js onchainUses over the pinned, no-redirect fetch): a whole number, or
// null when it was not read. The public key of each address this session derived, so main asks for the right key.
let onchainOf = async () => null;
const derivedKeys = new Map();
function setOnchain(fn) { if (typeof fn === "function") onchainOf = fn; }
const DAMAGED_UNREAD = "This wallet's saved key-use count is damaged, and the chain's figure for this key could not be read (the key-use service may be unreachable). Nothing was saved; confirm again when it can be read.";
const FIRST_UNREAD = "The chain's figure for this key could not be read (the key-use service may be unreachable), so the count you confirm cannot be checked against it. Nothing was saved; confirm again when it can be read.";

/** A payment checks the current archive figure, then reserves the typed position durably before signing.
 * Ordinary acknowledgements update the saved floor without reserving a signing position. */
async function ackKeyuses(address, count, reserve = false) {
  if (!/^0x[0-9A-Fa-f]{1,64}$/.test(String(address))) throw new Error("bad address");
  // a whole number of 0 or more, as a number or as plain digits only (0.19.341, as released 0.18.265: " 5 " is refused too)
  const n = typeof count === "number" ? count : (typeof count === "string" && /^\d{1,15}$/.test(count) ? Number(count) : NaN);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("The key uses must be a whole number of at least 0.");   // 0.19.230: "abc" was 0
  const was = entryFor(loadStore(), address);
  // an entry not yet confirmed: the chain is read FIRST (0.19.340, as released 0.18.274), so a chain figure at the limit is explained as such
  // rather than the bare ceiling the window's max(typed, chain) ran into; a figure above the ceiling is refused for that whether the chain
  // answered or not (as released 0.18.279)
  if (reserve || !was.ack || was.damaged) {
    const pk = derivedKeys.get(String(address).toLowerCase());
    let chain = null; if (pk) { try { chain = await onchainOf(pk); } catch (e) { chain = null; } }
    if (!Number.isSafeInteger(chain) || chain < 0) throw new Error(n > LAST_USE ? OVER_MAX : was.damaged ? DAMAGED_UNREAD : FIRST_UNREAD);
    if (chain >= KEY_USES) throw new Error(USED_UP(chain));   // never adopted: no count this app can sign with (0.19.323)
    if (n > LAST_USE) throw new Error(OVER_MAX);
    if (n < chain) throw new Error("The chain shows " + chain + " uses of this key. Confirm at least that many. Nothing was saved.");
  }
  if (n > LAST_USE) throw new Error(OVER_MAX);   // 0.19.323: the node wraps or restarts a count past the key's last use
  // a damaged entry's old count is a floor (0.19.324); one past the last use is said as an over-count, ending "Nothing was saved"
  if (was.damaged && was.keyuses >= KEY_USES) throw new Error(overCount(was.keyuses, true));
  if (was.damaged && n < was.keyuses) throw new Error(DAMAGED_BELOW(was.keyuses));
  const store = loadStore();   // read again after the wait: written once, from what is on disk now
  const e = entryFor(store, address);
  if (reserve) {
    if (e.keyuses >= KEY_USES) throw new Error(overCount(e.keyuses));
    const floor = Math.max(was.keyuses, e.keyuses);
    if (n < floor) throw new Error(BELOW_SAVED(floor));
    store[address] = { keyuses: n + 1, ack: true };
    try { writeStore(store); } catch { throw new Error(STORE_BAD); }
    return n;
  }
  e.keyuses = e.damaged ? Math.max(n, e.keyuses || 0) : Math.max(e.keyuses || 0, n);   // never lower a counter (over-skip is safe; under is fund loss); a damaged one is unknown
  delete e.damaged; e.ack = true;
  store[address] = e;
  writeStore(store);
  return { address, keyuses: e.keyuses, ack: true };
}
/** Current stored keyuses info for an address (does not mutate). */
function keyusesInfo(address) { const e = entryFor(loadStore(), address); return Object.assign({ address, keyuses: e.keyuses || 0, ack: !!e.ack }, e.damaged ? { damaged: true } : {}); }
// ---------------------------------------------------------------------------
// node interaction
// ---------------------------------------------------------------------------
function resp(r) { return (r && r.response) || null; }

/** Authoritative megammr check — read straight from the node (defense in depth vs the renderer's status push). */
async function isMegammr() {
  const r = await runner("status").catch(() => null);
  const d = resp(r);
  return !!(d && d.megammr);
}

/** Does the running node's OWN wallet contain this public key? If so, the entered seed IS the node's own seed
 *  (keys genkey uses modifier 0 = the wallet's first key; the node derives 0,1,2,… from the same base seed). */
async function nodeHasPubkey(pubkey) {
  const r = await checkedCommand("keys action:list").catch(() => null);
  const keys = r && r.keys;
  // A new or restoring wallet can briefly have no keys. It has not established ownership yet.
  if (!Array.isArray(keys) || !keys.length || !keys.every(k => /^0x[0-9a-f]{64}$/i.test(k?.publickey || "")))
    throw new Error("The node's keys could not be read, so the app cannot tell whether this is the node's own wallet. Nothing was sent.");
  return keys.some(k => k.publickey.toLowerCase() === pubkey.toLowerCase());
}

/** Derive the same single receive address in either node mode. */
async function derive(seed, account = null) {
  if (!isPhrase(seed)) throw new Error('Enter your seed phrase (a " or \\ or line break can\'t be carried safely)');
  if (!account && !(await isMegammr())) throw new Error("Web Wallet needs a MegaMMR node");
  const d = await helper.run({ action: "derive", seed, ...account });
  if (!/^0x[0-9a-f]{64}$/i.test(d.address) || !/^0x[0-9a-f]{64}$/i.test(d.publickey)
      || !isScript(d.script) || !looksLikeMinimaAddress(d.miniaddress)) throw new Error("Could not derive wallet from seed");
  const isNodeSeed = await nodeHasPubkey(d.publickey);
  derivedKeys.set(d.address.toLowerCase(), d.publickey);
  return { address: d.address, miniaddress: d.miniaddress, publickey: d.publickey, script: d.script, isNodeSeed };
}

async function read(address, mega = true) {
  if (!looksLikeMinimaAddress(address)) throw new Error("bad address");
  const rows = await checkedCommand("balance " + (mega ? "megammr:true " : "") + "address:" + address);
  if (!Array.isArray(rows)) throw new Error("Could not read the Web Wallet balance");
  return rows.map(b => ({
    tokenid: b.tokenid,
    name: b.tokenid === "0x00" ? "MINIMA" : ((b.token && (b.token.name || b.token)) || String(b.tokenid)),   // the whole id, never cut (0.19.230)
    confirmed: String(b.confirmed != null ? b.confirmed : "0"),
    sendable: String(b.sendable != null ? b.sendable : "0"),
    unconfirmed: String(b.unconfirmed != null ? b.unconfirmed : "0"),
    decimals: (b.token && b.token.decimals != null) ? b.token.decimals : (b.tokenid === "0x00" ? 0 : null)
  }));
}

async function checkedCommand(cmd) {
  const r = await runner(cmd);
  if (!r || r.status !== true) throw new Error((r && r.error) || "Could not read the node reply");
  return r.response;
}

// Select by exact displayed units, largest first, then export only those inputs.
// The signer rechecks the actual serialized coins and computes change in raw chain units.
async function coinProofs(address, token, amount, mega) {
  const coins = await checkedCommand("coins " + (mega ? "megammr:true" : "relevant:true") + " checkmempool:true coinage:3 address:" + address + " tokenid:" + token);
  if (!Array.isArray(coins)) throw new Error("Could not read Web Wallet coins");
  const candidates = coins.map(c => {
    const value = token === "0x00" ? c.amount : c.tokenamount;
    if (!/^0x[0-9a-f]{64}$/i.test(c.coinid) || String(c.address).toLowerCase() !== address.toLowerCase()
        || String(c.tokenid).toLowerCase() !== token.toLowerCase() || !/^\d+(?:\.\d{1,44})?$/.test(String(value)))
      throw new Error("Invalid Web Wallet coin");
    return { coinid: c.coinid, value: toUnits(value) };
  });
  candidates.sort((a,b) => a.value === b.value ? 0 : a.value > b.value ? -1 : 1);
  let total = 0n;
  const chosen = [], needed = toUnits(amount);
  for (const coin of candidates) {
    chosen.push(coin.coinid);
    total += coin.value;
    if (total >= needed) break;
  }
  if (total < needed) throw new Error("Insufficient spendable funds at this Web Wallet address");
  const proofs = [];
  for (const coinid of chosen) {
    const proof = await checkedCommand("coinexport coinid:" + coinid);
    if (!proof || !/^0x(?:[0-9a-f]{2})+$/i.test(proof.data)) throw new Error("Could not read a coin proof");
    proofs.push({ coinid, data: proof.data });
  }
  return proofs;
}

const BLOCK_CAPACITY = 268435456;
async function paymentFloor(address, publickey, blockRoot) {
  const chain = await onchainOf(publickey).catch(() => null);
  if (!Number.isSafeInteger(chain) || chain < 0) throw new Error("Could not verify key uses. Check your connection and try again.");
  let height = 0;
  if (blockRoot) {
    const tip = await checkedCommand("block");
    const raw = String(tip?.block ?? "");
    if (!/^\d{1,10}$/.test(raw)) throw new Error("Could not read the block height.");
    height = Number(raw);
    if (!height) throw new Error("Wait for the node to sync before signing.");
  }
  const store = loadStore();
  const local = Math.max(entryFor(store, address).keyuses, blockRoot ? entryFor(store, "block:" + blockRoot).keyuses : 0);
  return { chain, local, height, minimum: Math.max(chain, local, height), last: blockRoot ? BLOCK_CAPACITY - 1 : LAST_USE };
}

async function reserveBlockUse(address, publickey, root, typed) {
  const floor = await paymentFloor(address, publickey, root);
  const n = Number(typed), store = loadStore();
  const minimum = Math.max(floor.minimum, entryFor(store, address).keyuses, entryFor(store, "block:" + root).keyuses);
  if (n < minimum) throw new Error(BELOW_SAVED(minimum));
  if (n >= BLOCK_CAPACITY) throw new Error("The block key has reached its signing limit.");
  store[address] = { keyuses: n + 1, ack: true };
  store["block:" + root] = { keyuses: n + 1, ack: true };
  writeStore(store);
  return n;
}

const sending = new Set();
async function send(opts, account = null) {
  const { seed, to, amount, tokenid = "0x00" } = opts || {};
  if (!isPhrase(seed)) throw new Error("Invalid seed phrase");
  if (!looksLikeMinimaAddress(to)) throw new Error("Invalid recipient address");
  if (!isAmount(amount)) throw new Error("Invalid amount");
  if (!isTokenid(tokenid)) throw new Error("Invalid token id");
  const options = account?.options;
  const { address, publickey, isNodeSeed } = await derive(seed, options);
  if (account && address !== account.address) throw new Error("The selected wallet address changed.");
  if (account && !isNodeSeed && await nodeHasPubkey(account.rootKey)) throw new Error("This node owns the signing key. Use the Wallet tab to send.");
  const blockRoot = options?.accountMode === "block" ? account.root : null;
  const mega = account ? await isMegammr() : true;
  if (isNodeSeed) throw new Error("This node owns the signing key. Use the Wallet tab to send.");
  if (sending.has(address)) throw new Error("A payment from this address is already in progress.");
  sending.add(address);
  try {
    if (!resp(await runner("checkaddress address:" + to))?.["0x"]) throw new Error("Recipient address failed validation");
    const id = randomUUID();
    const saved = entryFor(loadStore(), address);
    if (!blockRoot && saved.keyuses >= KEY_USES) throw new Error(overCount(saved.keyuses));
    if (typeof opts.keyuses !== "string" || !/^\d{1,15}$/.test(opts.keyuses)) {
      if (saved.damaged) throw new Error("This wallet's saved key-use count is damaged. Confirm its key uses again (at least what the chain shows) before sending. Nothing was sent.");
      throw new Error("Confirm this wallet's key-uses count before sending");
    }
    if (!blockRoot && Number(opts.keyuses) > LAST_USE) throw new Error(OVER_MAX);
    if (Number(opts.keyuses) < saved.keyuses) throw new Error(saved.damaged ? DAMAGED_BELOW(saved.keyuses) : BELOW_SAVED(saved.keyuses));
    const proofs = await coinProofs(address, tokenid, amount, mega);
    const leaf = blockRoot ? await reserveBlockUse(address, publickey, blockRoot, opts.keyuses)
      : await ackKeyuses(address, opts.keyuses, true);
    const signed = await helper.run({ action: "sign", seed, ...options, to, amount, tokenid, proofs, leaf: String(leaf), id });
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(signed.data)) throw new Error("Invalid signed Web Wallet transaction");
    await checkedCommand("txnimport id:" + id + " data:" + signed.data);
    try {
      const checked = await checkedCommand("txncheck id:" + id);
      if (!checked || checked.validtransaction !== true) throw new Error("The node could not validate the signed Web Wallet payment.");
      let posted;
      try { posted = await runner("txnpost id:" + id + " mine:false"); } catch { /* unknown delivery */ }
      if (posted && posted.status === false) return { ok: false, keyuse: leaf, message: posted.error || "Send failed" };
      if (!posted || posted.status !== true || !/^0x[0-9a-f]{64}$/i.test(posted.response?.txpowid || ""))
        return { ok: false, ambiguous: true, keyuse: leaf, message: "Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying (a blind retry could pay twice)." };
      log("sent " + amount + " " + (tokenid === "0x00" ? "MINIMA" : "token " + tokenid) + " from " + address + " to " + to + " (keyuse " + leaf + ")");
      emitter.emit("update");
      return { ok: true, keyuse: leaf, txnid: posted.response.txpowid };
    } finally { await runner("txndelete id:" + id).catch(() => {}); }
  } finally { sending.delete(address); }
}

function status() { return { log: LOG_RING.slice(-20) }; }

module.exports = { setOnchain, paymentFloor, checkedCommand, nodeHasPubkey,
  emitter, isMegammr, derive, read, send,
  keyusesInfo, ackKeyuses, status, KEY_USES, LAST_USE,
  _setRunner: (fn) => { runner0 = fn; },
  // exported for unit tests
  _validators: { looksLikeMinimaAddress, isPhrase, isAmount, isTokenid, isScript }
};
