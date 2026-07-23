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
const { rpcCall } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
let app = null; try { app = require("electron").app; } catch (e) {}

const emitter = new EventEmitter();
const LOG_RING = [];

let runner = (cmd) => {
  const config = require("./config"), node = require("./node-manager");
  return rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
};
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
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 34 || c === 92) return false; }  // reject control chars, double-quote(34) and backslash(92)
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
function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), "utf8")) || {}; } catch (e) { return {}; } }
function writeStore(obj) {
  const p = storePath(), tmp = p + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);   // atomic replace
  // fsync the DIRECTORY too, so the rename (i.e. the counter advance) survives power-loss. Without this a crash
  // between rename and the dir flush could revert to a LOWER counter → reuse a WOTS leaf next boot = fund loss.
  try { const dfd = fs.openSync(path.dirname(p), "r"); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch (e) {}
}
function entryFor(store, addr) { return store[addr] || { keyuses: 0, ack: false }; }

/** Record the user's attested prior-use count for an address (monotonic floor) and mark it acknowledged. */
function ackKeyuses(address, count) {
  if (!/^0x[0-9A-Fa-f]{1,64}$/.test(String(address))) throw new Error("bad address");
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const store = loadStore();
  const e = entryFor(store, address);
  e.keyuses = Math.max(e.keyuses || 0, n);   // never lower a counter (over-skip is safe; under is fund loss)
  e.ack = true;
  store[address] = e;
  writeStore(store);
  return { address, keyuses: e.keyuses, ack: true };
}
/** Current stored keyuses info for an address (does not mutate). */
function keyusesInfo(address) { const e = entryFor(loadStore(), address); return { address, keyuses: e.keyuses || 0, ack: !!e.ack }; }
/** RESERVE: durably advance the counter to n+1 and return n (the leaf to sign at). Reserve-before-sign. */
function reserveKeyuse(address) {
  const store = loadStore();
  const e = entryFor(store, address);
  const n = e.keyuses || 0;
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
async function nodeHasPubkey(pubkey) {
  if (!pubkey) return false;
  const r = resp(await runner("keys action:list").catch(() => null));
  const keys = (r && r.keys) || [];
  const pk = String(pubkey).toLowerCase();
  return keys.some(k => k && k.publickey && String(k.publickey).toLowerCase() === pk);
}

/** Derive the wallet's key-0 address from the seed. Also reports whether this is the node's OWN wallet, so the
 *  balance can be the node's FULL total (a real wallet spreads coins over many keys). PUBLIC material only. */
async function derive(seed) {
  if (!isPhrase(seed)) throw new Error('Enter your seed phrase (a " or \\ or line break can\'t be carried safely)');
  if (!(await isMegammr())) throw new Error("Web Wallet needs a MegaMMR node");
  const r = await runner('keys action:genkey phrase:"' + seed + '"');   // VERBATIM — anyphrase, case-sensitive
  const d = resp(r);
  if (!d || !d.address) throw new Error("Could not derive wallet from seed");
  const isNodeSeed = await nodeHasPubkey(d.publickey);
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
    name: b.tokenid === "0x00" ? "MINIMA" : ((b.token && (b.token.name || b.token)) || String(b.tokenid).slice(0, 12)),
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
  if (await nodeHasPubkey(pubkey)) {
    privatekey = null;   // not needed — the node signs with its own keys
    let cmd = "send amount:" + amount + " address:" + to + " tokenid:" + tok;
    try { cmd = await pinMinimaSend(runner, cmd); } catch (e) {}   // dodge shared-node beacon-dust NPE
    let nr;
    try { nr = await runner(cmd); }
    catch (e) { return { ok: false, ambiguous: true, message: "Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying." }; }
    const nok = nr && (nr.status === true || nr.pending === true);
    if (!nok) return { ok: false, message: (nr && (nr.error || nr.message)) || "Send failed" };
    log("sent " + amount + " " + (tok === "0x00" ? "MINIMA" : tok.slice(0, 10)) + " (node wallet)");
    emitter.emit("update");
    const ntx = resp(nr) && (resp(nr).txpowid || (resp(nr).body && resp(nr).body.txn && resp(nr).body.txn.transactionid));
    return { ok: true, txnid: ntx || null };
  }

  // FOREIGN seed → single-address non-custodial sendfrom with the durable keyuses gate.
  // keyuses gate: the user MUST have acknowledged the seed's prior-use count for this address
  const info = keyusesInfo(fromaddress);
  if (!info.ack) { privatekey = null; throw new Error("Confirm this wallet's key-uses count before sending"); }

  // RESERVE-BEFORE-SIGN: durably advance to n+1, sign at n. A crash/failure merely skips a leaf (safe).
  const n = reserveKeyuse(fromaddress);
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
  log("sent " + amount + " " + (tok === "0x00" ? "MINIMA" : tok.slice(0, 10)) + " from " + fromaddress.slice(0, 10) + " (keyuse " + n + ")");
  emitter.emit("update");
  const txnid = resp(r) && (resp(r).txpowid || (resp(r).body && resp(r).body.txn && resp(r).body.txn.transactionid));
  return { ok: true, keyuse: n, txnid: txnid || null };
}

function status() { return { log: LOG_RING.slice(-20) }; }

module.exports = {
  emitter, isMegammr, derive, read, send,
  keyusesInfo, ackKeyuses,
  _setRunner: (fn) => { runner = fn; },
  // exported for unit tests
  _validators: { looksLikeMinimaAddress, isPhrase, isAmount, isTokenid, isScript, isPrivKey }
};
