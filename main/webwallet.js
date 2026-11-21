/*
 * webwallet.js — a LOCAL, in-app "Web Wallet" for minimaCore Desktop. A NATIVE reproduction of Minima's official
 * Web Wallet v2.5.2 (access a wallet straight from a SEED PHRASE via a -megammr node) — faithful to the original's
 * exact command flow, but auditable, integral to the wrapper, and hardened. Everything runs against the LOCAL node
 * over loopback RPC, so the seed NEVER leaves this machine. It is NOT a server and binds no socket.
 *
 * The public wallet.minima.global drained users because a REMOTE host saw the seed (it signed server-side). Here
 * the "server" is the user's own node on 127.0.0.1 — the seed reaches only the local node, which derives the key
 * with `keys action:genkey` (a pure derivation — NOT written to the wallet DB) and signs node-side.
 *
 * Command flow (VERBATIM from the real webWallet bundle + minima-core source):
 *   derive:  keys action:genkey phrase:"<seed>"            -> { address, miniaddress, publickey, script, privatekey }
 *   read:    balance megammr:true address:<addr>           -> the MegaMMR coin set for the (untracked) address
 *   send:    sendfrom fromaddress:<addr> address:<to> amount:<a> tokenid:<t> script:"<s>" privatekey:<p>
 *            keyuses:<n> mine:false                         -> sendfrom pulls untracked coins from the MegaMMR,
 *                                                             signs node-side (txnsign publickey:custom), broadcasts.
 *
 * SEED = ANY PHRASE (anyphrase). `keys genkey` runs BIP39.convertStringToSeed on the phrase VERBATIM — there is NO
 * dictionary or word-count validation, and the seed is CASE- and SPACING-SENSITIVE. So a seed is NOT "12–24 words":
 * it is whatever string the wallet was created with. It MUST be passed faithfully (never lowercased/collapsed — that
 * derives a different wallet). This mirrors the desktop's own restore flow (renderer/app.js:286-294).
 * (Note: the node parser normalises a `:` inside the quoted phrase and routes `{`/`[` via a different path; we're
 * internally consistent — derive & send use the IDENTICAL string — so the address shown is exactly where a send pulls
 * from. Only matters when importing an external wallet whose passphrase contains those chars.)
 *
 * FUND-CRITICAL — keyuses: the node does NOT track uses for a genkey-derived key, so WE must. keyuses is the WOTS
 * one-time-leaf index; signing twice at the same value leaks the private key = fund loss. We persist a per-address
 * monotonic counter, RESERVE-BEFORE-SIGN (write n+1 durably BEFORE the send that uses n), require an explicit user
 * acknowledgement of the seed's prior-use count, and never reuse a value (over-skip is safe). Per-install: do NOT
 * drive the SAME seed from two installs / a cloud-synced userData at once — they'd hand out the same leaf twice.
 */
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { rpcCall, oneCommand } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();
const LOG_RING = [];

let runner0 = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
const runner = (cmd) => { try { return runner0(oneCommand(cmd)); } catch (e) { return Promise.reject(e); } };   // ONE command each (main/rpc.js, 0.18.177)
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
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 34 || c === 92 || c === 59 || c === 127) return false; }  // reject control chars, double-quote(34), backslash(92), ";"(59: the node starts a second command there, 0.18.177) and DEL
  return true;
}
function isAmount(a) { return typeof a === "string" && /^\d{1,30}(\.\d{1,30})?$/.test(a) && Number(a) > 0; }
function isTokenid(t) { return t === "0x00" || (typeof t === "string" && /^0x[0-9A-Fa-f]{64}$/.test(t)); }
function isScript(s) { return typeof s === "string" && /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{2,140}\)$/.test(s); }
function isPrivKey(p) { return typeof p === "string" && /^0x[0-9A-Fa-f]{2,200}$/.test(p); }

// ---------------------------------------------------------------------------
// keyuses store — durable, monotonic, reserve-before-sign. { "<0xaddr>": { keyuses, ack } }
// ---------------------------------------------------------------------------
function storePath() { return path.join(app ? app.getPath("userData") : ".", "webwallet-keyuses.json"); }
/**
 * The counters, read strictly (0.18.203). It returned {} on ANY error: a damaged or unreadable file made every address
 * start again at key use 0 (signing a one-time key a second time exposes it) and the next write wiped every other
 * address's counter. Now only a missing file is a fresh start; a file that cannot be read or is not an object refuses with
 * the reason and nothing is signed. One damaged entry (0.18.215) refuses only that address: its counter is unknown, so it
 * must be confirmed again (the screen asks for a whole number at least as high as the chain shows); others are untouched.
 */
function loadStore() {
  let raw;
  try { raw = fs.readFileSync(storePath(), "utf8"); }
  catch (e) { if (e && e.code === "ENOENT") return {}; throw new Error("The Web Wallet's key-use counters (" + storePath() + ") cannot be read (" + ((e && e.code) || e) + "). Nothing was signed."); }
  let j; try { j = JSON.parse(raw); } catch (e) { j = undefined; }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("The Web Wallet's key-use counters (" + storePath() + ") are damaged. Nothing was signed; keep that file and ask for help rather than deleting it.");
  return j;
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
const entryOk = (v) => !!v && typeof v === "object" && Number.isSafeInteger(v.keyuses) && v.keyuses >= 0;
function entryFor(store, addr) {
  if (!Object.hasOwn(store, addr)) return { keyuses: 0, ack: false };
  return entryOk(store[addr]) ? store[addr] : { keyuses: 0, ack: false, damaged: true };   // unknown: must be confirmed again
}

// The chain's figure for a key (main.js: main/keyuses.js onchainUses over the pinned, no-redirect fetch, 0.18.262, as Pandamonium
// Desktop 0.19.255): a whole number, or null when it was not read. The public key of each address this session derived, so main
// asks for the right key itself and never takes one from the window.
let onchainOf = async () => null;
const derivedKeys = new Map();
function setOnchain(fn) { if (typeof fn === "function") onchainOf = fn; }
const DAMAGED_UNREAD = "This wallet's saved key-use count is damaged, and the chain's figure for this key could not be read (the key-use service may be unreachable). Nothing was saved; confirm again when it can be read.";
// The ceiling (0.18.265). The node signs a Web Wallet send with TreeKey.createDefault (sendfrom runs "txnsign publickey:custom
// privatekey:… keyuses:" + keyuses; txnsign.java builds TreeKey.createDefault(privkey) and setUses(uses.getAsInt())): 64 keys per level,
// 3 levels, 64^3 = 262144 one-time leaves, numbered 0 to 262143. keyuses is the leaf THIS send signs at; the store keeps the NEXT one
// (reserveFrom returns n and stores n + 1, one leaf per send). TreeKey.sign at a leaf >= 262144 logs "SERIOUS ERROR : MAX TREEKEYS
// USED" and signs at leaf 0 AGAIN (and getAsInt keeps only the low 32 bits of a larger figure), which reuses a one-time key. So the
// last leaf that can sign is MAX_USES = 262143: a count to confirm is at most that, and a stored next leaf above it signs nothing.
const TREE_LEAVES = 262144, MAX_USES = TREE_LEAVES - 1;
// The chain's figure is max(spend blocks, spent coins), and one signature can spend several coins, so a figure at the limit may count
// more than the key signed (0.18.271: it was said as the key being used up, with advice to use another wallet, which would have to
// sign with this same key); what is true is said: the figure is at the limit, and this app will not sign from this address.
const USED_UP = (chain) => "The chain's figure for this key (" + chain + ") is at or above the limit of a key of this wallet (" + TREE_LEAVES + " one-time uses, numbered 0 to " + MAX_USES + "). The figure can count more uses than the key signed, but this app will not sign from this address: signing past the last use would reuse a one-time key, which can lose funds. Nothing was saved.";
const OVER_MAX = "The key-use count can be at most " + MAX_USES + " (a key of this wallet has " + TREE_LEAVES + " one-time uses, numbered 0 to " + MAX_USES + "). Nothing was saved.";
const FIRST_UNREAD = "The chain's figure for this key could not be read (the key-use service may be unreachable), so the count you confirm cannot be checked against it. Nothing was saved; confirm again when it can be read.";

/** Record the user's attested prior-use count for an address (monotonic floor) and mark it acknowledged. An entry not yet
 *  acknowledged (a first confirmation, one whose file went missing, a damaged one) is unknown: its figure must be at least what
 *  the chain shows, checked HERE, in main (0.18.262 for a damaged entry, 0.18.263 for every unacknowledged one: the window's floor
 *  alone took any count), and it is refused while that figure cannot be read. An acknowledged entry only goes up and needs no read. */
async function ackKeyuses(address, count) {
  if (!/^0x[0-9A-Fa-f]{1,64}$/.test(String(address))) throw new Error("bad address");
  // a whole number of 0 or more, as a number or as plain digits only ("1e6", "0x10", " 5 " are refused, 0.18.265), before anything else
  const n = typeof count === "number" ? count : (typeof count === "string" && /^\d{1,15}$/.test(count) ? Number(count) : NaN);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("The key uses must be a whole number of at least 0.");   // "1e309" was Infinity, stored as null, read back as 0 (0.18.203)
  const was = entryFor(loadStore(), address);
  // an entry not yet confirmed: the chain is read FIRST (0.18.274), so a chain figure at the limit is explained as such rather than
  // the bare "can be at most 262143" the window's max(typed, chain) ran into
  if (!was.ack || was.damaged) {
    const pk = derivedKeys.get(String(address).toLowerCase());
    let chain = null; if (pk) { try { chain = await onchainOf(pk); } catch (e) { chain = null; } }
    if (!Number.isSafeInteger(chain) || chain < 0) throw new Error(was.damaged ? DAMAGED_UNREAD : FIRST_UNREAD);
    if (chain > MAX_USES) throw new Error(USED_UP(chain));   // never adopted (0.18.265)
    if (n > MAX_USES) throw new Error(OVER_MAX);
    if (n < chain) throw new Error("The chain shows " + chain + " uses of this key. Confirm at least that many. Nothing was saved.");
  }
  if (n > MAX_USES) throw new Error(OVER_MAX);   // the ceiling (0.18.265): past it the node signs at leaf 0 again
  // a damaged entry whose old value still reads as a whole number ("57", 57.4) is a floor too (0.18.267): that many leaves may be used
  if (was.damaged) {
    const raw = (loadStore()[address] || {}).keyuses;
    // a decimal written as text ("57.4") is read as the number is (0.18.270: it was ignored)
    const num = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,15}(\.\d+)?\s*$/.test(raw) ? Number(raw.trim()) : NaN;
    const old = Number.isFinite(num) && num > 0 ? Math.ceil(num) : 0;
    if (old > MAX_USES) throw new Error(overCount(old));   // a floor nobody can confirm (0.18.270): said why, as a send says it
    if (n < old) throw new Error("This key's saved count read " + old + " before it was damaged. Confirm at least that many. Nothing was saved.");
  }
  const store = loadStore();   // read again after the wait: written once, from what is on disk now
  const e = entryFor(store, address);
  e.keyuses = e.damaged ? n : Math.max(e.keyuses || 0, n);   // never lower a counter (over-skip is safe; under is fund loss); a damaged one is unknown
  delete e.damaged; e.ack = true;
  store[address] = e;
  writeStore(store);
  return { address, keyuses: e.keyuses, ack: true };
}
/** Current stored keyuses info for an address (does not mutate). */
function keyusesInfo(address) { const e = entryFor(loadStore(), address); return Object.assign({ address, keyuses: e.keyuses || 0, ack: !!e.ack }, e.damaged ? { damaged: true } : {}); }
/** Why a stored next leaf above the last one cannot sign (0.18.265). Exactly TREE_LEAVES: every leaf was used. Above it: a count
 *  confirmed above the ceiling (possible before 0.18.265, which advised that over-estimating is safe); the true count is unknown, so
 *  it is never lowered here. */
function overCount(n) {
  const why = " This app will not sign from this address: signing past the last use (" + MAX_USES + ") would reuse a one-time key, which can lose funds. Nothing was sent.";
  return n === TREE_LEAVES
    ? "This wallet's count for this key has reached the limit of a key of this wallet (" + TREE_LEAVES + " one-time uses, numbered 0 to " + MAX_USES + ")." + why
    : "This wallet's saved key-use count (" + n + ") is above the limit of a key of this wallet (" + TREE_LEAVES + " one-time uses, numbered 0 to " + MAX_USES + "). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered." + why;
}
/** RESERVE: durably advance the counter to n+1 and return n (the leaf to sign at). Reserve-before-sign. */
function reserveKeyuse(address) { return reserveFrom(loadStore(), address); }
function reserveFrom(store, address) {
  const e = entryFor(store, address);
  const n = e.keyuses || 0;
  if (n > MAX_USES) throw new Error(overCount(n));   // the leaf this send would sign at does not exist: the node would sign at leaf 0 again (0.18.265)
  e.keyuses = n + 1;                          // persist BEFORE the caller signs at n
  store[address] = e;
  writeStore(store);
  return n;
}

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
// Whether a seed is the node's OWN wallet decides the whole send path (the node signs with its own counters, or this app
// signs at its own counter). A read that fails must not answer "no" (0.18.204): the node's own seed then went down the
// foreign path and signed at the wrong key use. Either read failing refuses, and nothing is sent.
const CANNOT_TELL = "Could not tell whether this is the node's own wallet (the node did not answer, or its wallet is locked). Nothing was sent.";
async function nodeHasPubkey(pubkey) {
  if (!pubkey) return false;
  let r; try { r = await runner("keys action:list"); } catch (e) { r = null; }
  const keys = r && r.status === true && r.response && Array.isArray(r.response.keys) ? r.response.keys : null;
  if (!keys) throw new Error(CANNOT_TELL);
  const pk = String(pubkey).toLowerCase();
  return keys.some(k => k && k.publickey && String(k.publickey).toLowerCase() === pk);
}
/** The node's seed phrase, for the second comparison below; null when it cannot be read (a locked vault). */
async function nodeSeedPhrase() {
  let r; try { r = await runner("vault action:seed"); } catch (e) { r = null; }
  const v = r && r.status === true ? resp(r) : null;
  const p = v && (v.phrase || v.seedphrase || v.seed);
  return typeof p === "string" && p ? p : null;
}

/** Is the entered seed the running node's OWN wallet? True if the derived key-0 pubkey is in the node's key set, else if
 *  it is the node's seed phrase. Throws only when the key list cannot be read (0.18.215): a readable list without the key
 *  says the seed is foreign, and a locked vault does not change that. */
async function isNodeOwnSeed(pubkey, seed) {
  if (await nodeHasPubkey(pubkey)) return true;
  const np = await nodeSeedPhrase();
  return !!np && String(np) === String(seed);
}

/** Derive the wallet's key-0 address from the seed. Also reports whether this is the node's OWN wallet, so the
 *  balance can be the node's FULL total (a real wallet spreads coins over many keys). PUBLIC material only. */
async function derive(seed) {
  if (!isPhrase(seed)) throw new Error('Enter your seed phrase (a " or \\ or line break can\'t be carried safely)');
  if (!(await isMegammr())) throw new Error("Web Wallet needs a MegaMMR node");
  const r = await runner('keys action:genkey phrase:"' + seed + '"');   // VERBATIM — anyphrase, case-sensitive
  const d = resp(r);
  if (!d || !d.address) throw new Error("Could not derive wallet from seed");
  const isNodeSeed = await isNodeOwnSeed(d.publickey, seed);
  if (/^0x[0-9A-Fa-f]{1,64}$/.test(String(d.address)) && d.publickey) derivedKeys.set(String(d.address).toLowerCase(), String(d.publickey));   // public material only (0.18.262)
  return { address: d.address, miniaddress: d.miniaddress, publickey: d.publickey, script: d.script, isNodeSeed };
}

/** Balances. For the node's OWN seed use `balance` — the FULL wallet total across ALL its addresses (coins are
 *  spread over many keys, so a single genkey address reads ~0). For a foreign seed, the single megammr address. */
async function read(address, nodeSeed) {
  if (!/^0x[0-9A-Fa-f]{1,64}$/.test(String(address)) && !looksLikeMinimaAddress(address)) throw new Error("bad address");
  const r = await runner(nodeSeed ? "balance" : ("balance megammr:true address:" + address)).catch(() => null);
  const rows = (r && Array.isArray(r.response)) ? r.response : [];
  return rows.map(b => ({
    tokenid: b.tokenid,
    name: b.tokenid === "0x00" ? "MINIMA" : ((b.token && (b.token.name || b.token)) || String(b.tokenid)),   // the whole token id when it has no name (0.18.211)
    confirmed: String(b.confirmed != null ? b.confirmed : "0"),
    sendable: String(b.sendable != null ? b.sendable : "0"),
    unconfirmed: String(b.unconfirmed != null ? b.unconfirmed : "0"),
    decimals: (b.token && b.token.decimals != null) ? b.token.decimals : (b.tokenid === "0x00" ? 0 : null)
  }));
}

/**
 * FUND-CRITICAL send. Re-derives the private key from the seed IN-MEMORY (never persisted, wiped after use),
 * validates every argument, RESERVES the keyuses leaf durably before signing, then runs the single `sendfrom`.
 * Requires the user to have acknowledged the address's prior-use count (ackKeyuses) first.
 */
async function send(opts) {
  const { seed, to, amount, tokenid } = opts || {};
  if (!isPhrase(seed)) throw new Error("Invalid seed phrase");
  if (!looksLikeMinimaAddress(to)) throw new Error("Invalid recipient address");
  if (!isAmount(amount)) throw new Error("Invalid amount");
  const tok = tokenid || "0x00";
  if (!isTokenid(tok)) throw new Error("Invalid token id");
  if (!(await isMegammr())) throw new Error("Web Wallet needs a MegaMMR node");

  // confirm the recipient is a real, spendable address on this node
  const chk = resp(await runner("checkaddress address:" + to).catch(() => null));
  if (!chk || !chk["0x"]) throw new Error("Recipient address failed validation");

  // derive key material (private key stays in this scope only) — phrase passed VERBATIM
  let script = null, privatekey = null, fromaddress = null, pubkey = null;
  {
    const d = resp(await runner('keys action:genkey phrase:"' + seed + '"'));
    if (!d || !d.address || !d.script || !d.privatekey) throw new Error("Could not derive signing key");
    script = d.script; privatekey = d.privatekey; fromaddress = d.address; pubkey = d.publickey;
  }
  if (!isScript(script) || !isPrivKey(privatekey) || !/^0x[0-9A-Fa-f]{1,64}$/.test(fromaddress)) {
    privatekey = null; throw new Error("Derived key material failed validation");
  }

  // If this is the running node's OWN wallet, let the NODE send: it coin-selects across ALL its addresses and
  // manages its own keyuses (no single-address / manual-keyuses limits). Same path as the desktop Wallet tab.
  if (await isNodeOwnSeed(pubkey, seed)) {
    privatekey = null;   // not needed — the node signs with its own keys
    let cmd = "send amount:" + amount + " address:" + to + " tokenid:" + tok;
    try { cmd = await pinMinimaSend(runner, cmd); } catch (e) {}   // dodge shared-node beacon-dust NPE
    let nr;
    try { nr = await runner(cmd); }
    catch (e) { return { ok: false, ambiguous: true, message: "Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying." }; }
    const nok = nr && (nr.status === true || nr.pending === true);
    if (!nok) return { ok: false, message: (nr && (nr.error || nr.message)) || "Send failed" };
    log("sent " + amount + " " + (tok === "0x00" ? "MINIMA" : "token " + tok) + " to " + to + " (node wallet)");   // identifiers whole (0.18.180)
    emitter.emit("update");
    const ntx = resp(nr) && (resp(nr).txpowid || (resp(nr).body && resp(nr).body.txn && resp(nr).body.txn.transactionid));
    return { ok: true, txnid: ntx || null };
  }

  // FOREIGN seed → single-address non-custodial sendfrom with the durable keyuses gate.
  // keyuses gate: the user MUST have acknowledged the seed's prior-use count for this address
  // ONE read of the counters for both the acknowledgement and the reservation (0.18.203): a read that fails refuses here
  let store; try { store = loadStore(); } catch (e) { privatekey = null; throw e; }
  const entry = entryFor(store, fromaddress);
  if (entry.damaged) { privatekey = null; throw new Error("This wallet's saved key-use count is damaged. Confirm its key uses again (at least what the chain shows) before sending. Nothing was sent."); }
  if (!entry.ack) { privatekey = null; throw new Error("Confirm this wallet's key-uses count before sending"); }
  if ((entry.keyuses || 0) > MAX_USES) { privatekey = null; throw new Error(overCount(entry.keyuses)); }   // before reserving (0.18.265)

  // RESERVE-BEFORE-SIGN: durably advance to n+1, sign at n. A crash/failure merely skips a leaf (safe).
  const n = reserveFrom(store, fromaddress);
  const cmd = "sendfrom fromaddress:" + fromaddress
    + " address:" + to
    + " amount:" + amount
    + " tokenid:" + tok
    + ' script:"' + script + '"'
    + " privatekey:" + privatekey
    + " keyuses:" + n
    + " mine:false";
  let r;
  try {
    r = await runner(cmd);
  } catch (e) {
    // AMBIGUOUS: a transport/timeout error means the node MAY still have posted the txn. NEVER auto-retry — a
    // retry burns a fresh leaf (no key reuse) but selects different coins and could pay the recipient TWICE.
    // Return an ambiguous result (not a throw, so the flag survives the IPC boundary) so the UI blocks retry.
    return { ok: false, ambiguous: true, keyuse: n, message: "Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying (a blind retry could pay twice)." };
  } finally {
    privatekey = null;   // best-effort scrub
  }
  const ok = r && (r.status === true || r.pending === true);
  if (!ok) return { ok: false, keyuse: n, message: (r && (r.error || r.message)) || "Send failed" };
  log("sent " + amount + " " + (tok === "0x00" ? "MINIMA" : "token " + tok) + " from " + fromaddress + " to " + to + " (keyuse " + n + ")");   // identifiers whole (0.18.180)
  emitter.emit("update");
  const txnid = resp(r) && (resp(r).txpowid || (resp(r).body && resp(r).body.txn && resp(r).body.txn.transactionid));
  return { ok: true, keyuse: n, txnid: txnid || null };
}

function status() { return { log: LOG_RING.slice(-20) }; }

module.exports = { setOnchain, MAX_USES,
  emitter, isMegammr, derive, read, send,
  keyusesInfo, ackKeyuses, status,
  _setRunner: (fn) => { runner0 = fn; },
  // exported for unit tests
  _validators: { looksLikeMinimaAddress, isPhrase, isAmount, isTokenid, isScript, isPrivKey }
};
