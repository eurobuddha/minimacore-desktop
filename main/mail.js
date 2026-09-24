/*
 * mail.js — minimaMail on-chain transport + orchestration (main process). Node = dumb transport; all crypto/keys
 * stay here. Every message is a 0.000000001 MINIMA coin to the shared CHAINMAIL address with the sealed blob in
 * coin state port 99; the inbox is the set of coins at that address we can crypto_box_seal_open.
 *
 * Identity is derived from the seed EXACTLY ONCE (first run), cached in the macOS Keychain, and thereafter loaded
 * from the Keychain — the raw seed is never fetched again and never reaches the renderer.
 */
const EventEmitter = require("events");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");
const { rpcCall } = require("./rpc");
const { pinMinimaSend } = require("./sendpin");
const mc = require("./mailcrypto");
const store = require("./mail-store");
const backup = require("./mailbackup");

const CHAINMAIL = "0x434841494E4D41494C";
const MSG_AMOUNT = "0.000000001";
const MAIL_KEY_ACCOUNT = "mail-identity";
const SCAN_EVERY_MS = 10000;
/*
 * DEPTH IS BLOCKS, NOT COINS. `coins … depth:N` walks back N BLOCKS from the tip (node search/coins.java), so at
 * ~50s a block, 32 blocks is ~27 minutes and 256 is ~3h33m — the same arithmetic AtomiX documents at
 * main/atomix/lib/settle.js:26. The old code backfilled ONCE per process at 256 and then polled 32 forever, so
 * quitting the app for longer than 3.5 hours meant every message sent in that gap was never fetched, ever.
 *
 * Now: the live pass sizes itself to the gap since the last scan (up to WINDOW_DEPTH), and anything older is
 * swept by a paced backfill that walks DOWN from the covered floor and persists where it got to, so a quit
 * mid-sweep resumes instead of restarting.
 */
const POLL_DEPTH = 32;            // steady state: a few blocks of margin over the ~50s block time
const WINDOW_DEPTH = 1024;        // one pass ceiling (~14h). Past ~1024 the tree cascades — AtomiX's REFUND_SCAN_DEPTH.
const MIN_DEPTH = 4;
const BACKFILL_CHUNK = 512;       // blocks reclaimed per backfill step (~7h), paced one step per scan tick
const GAP_MARGIN = 8;             // blocks of overlap so a boundary coin can never fall between two passes

const emitter = new EventEmitter();
const seenCoins = new Set();   // coinids already trial-decrypted this session (skip re-opening on every poll)
const repliedReq = new Set();  // payaddr-req randomids we've already auto-answered this session (avoid reply storms)
// Hard bounds on the payaddr-reply auto-responder — an attacker can post unlimited payaddr-reqs (fresh randomid +
// fresh publicId each), and every reply is a real coin + one WOTS key-use. Cap replies globally per hour AND per peer.
let autoReplyTimes = [];       // timestamps (ms) of recent auto-replies, pruned to a rolling hour
const paReplyCooldown = new Map();  // peer publicId → last auto-reply ms
const AUTO_REPLY_MAX_PER_HOUR = 24;
const AUTO_REPLY_PEER_COOLDOWN_MS = 10 * 60 * 1000;
let identityGen = 0;           // bumped on any identity swap so a stale in-flight scan can't move the cursors
let identity = null;        // {boxPk,boxSk,signPk,signSk,publicId}
let mypayaddr = "";
let scanTimer = null;
let lastTip = 0;          // newest block seen by the loop (for status())
let lastScanTip = 0;      // block height that last triggered a scan
let scanning = false;
// Backfill cursor, mirrored in the store so it survives a quit: `floor` is the oldest block covered, `target`
// is the block we must reach to close the gap left by the app being shut. `done` means the node stopped
// serving coins that far back — the honest end of what this node can give us.
let backfill = { active: false, floor: 0, target: 0, done: false, steps: 0 };
let lastScanMs = 0;

// swappable node-command runner (overridable in tests via _setRunner)
let runner = (cmd) => rpcCall(node.rpcPort(), config.rpcSecret(), cmd);
function _setRunner(fn) { runner = fn; }
async function nodeCmd(cmd) { return runner(cmd); }

// ---- identity (derive once, cache in Keychain) ----
async function init() {
  if (identity) return identity;
  await mc.ready();
  const cached = config.getSecret(MAIL_KEY_ACCOUNT);
  if (cached) { try { identity = mc.loadIdentity(cached); } catch (e) { identity = null; } }
  if (!identity) {
    const r = await nodeCmd("vault action:seed");
    const resp = (r && r.response) || {};
    const seed = resp.seed || resp.phrase || "";
    if (!seed) throw new Error("Couldn't read the node seed (is the wallet unlocked?).");
    identity = await mc.deriveIdentity(seed);
    config.setSecret(mc.serializeIdentity(identity), MAIL_KEY_ACCOUNT);
  }
  try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; mypayaddr = gr.miniaddress || gr.address || ""; if (mypayaddr) store.metaSet("mypayaddr", mypayaddr); } catch (e) {}
  if (!store.metaGet("coinnotify")) { try { await nodeCmd("coinnotify action:add address:" + CHAINMAIL); store.metaSet("coinnotify", true); } catch (e) {} }
  return identity;
}
/** On wallet restore the seed changed → drop the cached identity AND the old seed's local inbox/contacts/payaddr,
 *  so the restored (different) identity doesn't show the previous wallet's conversations. Called only on seed change. */
function invalidateIdentity() {
  config.deleteSecret(MAIL_KEY_ACCOUNT);
  identity = null; seenCoins.clear(); mypayaddr = "";
  backfill = { active: false, floor: 0, target: 0, done: false, steps: 0 }; lastScanMs = 0;
  identityGen++; repliedReq.clear(); paReplyCooldown.clear(); autoReplyTimes = [];
  try { store.clear(); } catch (e) { /* best effort */ }
}

function threadKey(a, b, subject) { return crypto.createHash("sha256").update([a, b].sort().join("") + (subject || ""), "utf8").digest("hex"); }
function randomId() { return crypto.randomBytes(32).toString("hex"); }
/** A real Minima receiving address: Mx… (base58 alphanumeric, len 40–80) or 0x + exactly 64 hex.
 *  CRUCIALLY rejects a Mail key (0x + 130 hex) so an identity key can never be a pay address, AND enforces the
 *  Mx charset — a whitespace-tolerant length-only check let a crafted "Mx… address:0x<attacker>" pass and, once
 *  interpolated into `send … address:<x> …`, the node's space-tokenised last-wins parser redirected the funds. */
function looksLikeMinimaAddress(a) {
  a = String(a || "").trim();
  if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
  if (a.startsWith("0x")) { const h = a.slice(2); return h.length === 64 && /^[0-9A-Fa-f]+$/.test(h); }
  return false;
}
function toWire(m) {
  const o = { from: m.from, fromname: m.fromname || "", to: m.to, subject: m.subject || "", message: m.message || "",
    randomid: m.randomid, date: m.date, type: m.type || "text", payaddr: m.payaddr || "" };
  if (m.type === "payment") { o.amount = m.amount; o.tokenid = m.tokenid; o.tokenname = m.tokenname; o.txpowid = m.txpowid; }
  if (m.type === "image") o.image = m.image || "";
  return JSON.stringify(o);
}
async function currentBlock() { try { const b = await nodeCmd("block"); return parseInt((b && b.response && (b.response.block != null ? b.response.block : b.response)), 10) || 0; } catch (e) { return 0; } }

// ---- send ----
async function sendBlob(blobHex) {
  const cmd = `send amount:${MSG_AMOUNT} address:${CHAINMAIL} tokenid:0x00 state:${JSON.stringify({ "99": "0x" + blobHex })}`;
  // shared-node fund-safety: pin the 1-nano send to a signable coin so the node can't grab anyone-can-spend
  // beacon dust (PandaPools etc.) as the input → KeyRow.getPrivateKey() null. See main/sendpin.js.
  const r = await nodeCmd(await pinMinimaSend(nodeCmd, cmd));
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "message send failed");
  return r;
}
/** Send a message. base = { message, subject?, type, image?, amount?, tokenid?, tokenname?, txpowid? }.
 *  SUBJECT is part of the thread key on both sides (threadKey hashes it), exactly as the APK does: an empty
 *  subject is one running thread per contact, a named one starts its own thread. It used to be hardcoded "",
 *  which is why the desktop had no subjects at all while the wire format carried the field. */
async function sendMessage(toPublicId, base) {
  await init();
  if (!mc.isValidPublicId(toPublicId)) throw new Error("Invalid recipient mail id.");
  const subject = String((base && base.subject) || "").slice(0, 200);
  const rid = randomId(), date = Date.now();
  const wire = { from: identity.publicId, fromname: store.metaGet("myname") || "", to: toPublicId, subject,
    message: base.message || "", randomid: rid, date, type: base.type || "text", payaddr: mypayaddr,
    amount: base.amount, tokenid: base.tokenid, tokenname: base.tokenname, txpowid: base.txpowid, image: base.image };
  const blob = await mc.seal(identity, toPublicId, Buffer.from(toWire(wire), "utf8"));
  if (blob.length > 49000) throw new Error("Message too large for one on-chain coin — shrink the image.");
  const block = await currentBlock();
  // Record it as POSTING before the coin is broadcast. The Outbox is then truthful even if the send throws or
  // the app dies mid-post, and Retry has something to re-seal — the old code only stored a message that had
  // already succeeded, so a failed send simply vanished.
  const local = { hashref: threadKey(identity.publicId, toPublicId, subject), fromname: wire.fromname, frompublickey: identity.publicId,
    topublickey: toPublicId, subject, message: wire.message, randomid: rid, incoming: false, read: true, date,
    status: "posting", sentblock: block, type: wire.type, amount: base.amount, tokenid: base.tokenid, tokenname: base.tokenname,
    txpowid: base.txpowid, image: base.image, payaddr: mypayaddr };
  store.addMessage(local);
  emitter.emit("update");
  try { await sendBlob(blob); } catch (e) {
    store.setStatus(local.hashref, rid, { status: "failed" });
    local.status = "failed"; emitter.emit("update");
    throw e;
  }
  store.setStatus(local.hashref, rid, { status: "sent", sentblock: block });
  local.status = "sent";
  emitter.emit("update");
  return local;
}
/** Re-seal and re-post a message the chain never took. The randomid is REUSED so the recipient's dedup
 *  (hashref|randomid) collapses a double delivery into one — a retry can never duplicate a conversation. */
async function retrySend(hashref, randomid) {
  await init();
  const m = store.thread(hashref).find(x => x.randomid === randomid);
  if (!m) throw new Error("That message is no longer in the Outbox.");
  if (m.incoming) throw new Error("Only your own messages can be retried.");
  const wire = { from: identity.publicId, fromname: m.fromname || store.metaGet("myname") || "", to: m.topublickey,
    subject: m.subject || "", message: m.message || "", randomid: m.randomid, date: m.date, type: m.type || "text",
    payaddr: mypayaddr, amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image };
  const blob = await mc.seal(identity, m.topublickey, Buffer.from(toWire(wire), "utf8"));
  const block = await currentBlock();
  store.setStatus(hashref, randomid, { status: "posting", sentblock: block });
  emitter.emit("update");
  try { await sendBlob(blob); } catch (e) {
    store.setStatus(hashref, randomid, { status: "failed" });
    emitter.emit("update");
    throw e;
  }
  store.setStatus(hashref, randomid, { status: "sent", sentblock: block });
  emitter.emit("update");
  return true;
}
async function pay(toPublicId, payaddr, amount, tokenid, tokenname, memo) {
  await init();
  if (!looksLikeMinimaAddress(payaddr)) throw new Error("Invalid pay address.");   // rejects a Mail key too
  if (!/^[0-9]*\.?[0-9]+$/.test(String(amount)) || parseFloat(amount) <= 0) throw new Error("Invalid amount.");
  if (!/^0x[0-9A-Fa-f]+$/.test(tokenid) && tokenid !== "0x00") throw new Error("Invalid token.");
  // Defense-in-depth beyond the charset validator: have the node parse/verify the address before any funds move
  // (same gate as the wallet's Send tab). Blocks a charset-valid-but-not-real address, and a belt-and-braces stop
  // for the injection class. Only aborts on a definitive falsy/failed reply, never on node-busy ambiguity.
  let chk; try { chk = await nodeCmd(`checkaddress address:${payaddr}`); } catch (e) { chk = null; }
  if (!chk || chk.status === false) throw new Error("Couldn't validate the recipient address — not sending.");
  const memoStr = String(memo || "");
  let r;
  // pin a MINIMA (0x00) payment to a signable coin that covers the amount (token payments are untouched — beacon
  // dust is 0x00 only). Best-effort: a payment too big for any single signable coin sends unpinned.
  try { r = await nodeCmd(await pinMinimaSend(nodeCmd, `send amount:${amount} address:${payaddr} tokenid:${tokenid}`)); }
  catch (e) {
    // The send may have been ACCEPTED and posted even though the RPC call timed out / the socket reset. Do NOT
    // report a clean failure — that invites a re-pay (double spend). Tell the caller the status is uncertain.
    const amb = new Error("Payment may have been submitted — check your Balance/History before retrying.");
    amb.ambiguous = true; throw amb;
  }
  if (!r || (r.status !== true && r.pending !== true)) throw new Error((r && r.error) || "payment failed");
  if (!store.metaGet("pa:" + toPublicId)) store.metaSet("pa:" + toPublicId, payaddr);   // remember only if we have no signed-learned address
  // The payment is committed here. A receipt-message failure MUST NOT surface as a payment failure —
  // otherwise the user re-pays (double spend). Post the on-chain receipt best-effort.
  const txpowid = (r.response && r.response.txpowid) || "";
  try { return await sendMessage(toPublicId, { type: "payment", message: memoStr, amount: String(amount), tokenid, tokenname: tokenname || "", txpowid }); }
  catch (e) {
    // Receipt-to-peer failed, but the PAYMENT already went through above. Persist a local ledger entry regardless,
    // so the spend is visible in the thread/history after a restart — otherwise a receipt failure hides real funds leaving.
    try {
      const block = await currentBlock();   // the payment IS on-chain — record the block so it can confirm normally
      store.addMessage({ hashref: threadKey(identity.publicId, toPublicId, ""), fromname: store.metaGet("myname") || "",
        frompublickey: identity.publicId, topublickey: toPublicId, subject: "", message: memoStr, randomid: randomId(),
        incoming: false, read: true, date: Date.now(), status: "sent", sentblock: block, type: "payment",
        amount: String(amount), tokenid, tokenname: tokenname || "", txpowid, image: "", payaddr: mypayaddr });
    } catch (e2) { /* best effort */ }
    emitter.emit("update");
    return { status: "sent", type: "payment", amount: String(amount), tokenid, tokenname: tokenname || "", txpowid, receiptFailed: true };
  }
}

/** Post a control coin (payaddr-req / payaddr-reply) — a sealed wire with NO local message record (it's not chat).
 *  Carries my pay address so the peer can also learn it just from the request. Mirrors native sendPayaddrReq. */
async function sendControl(toPublicId, type) {
  await init();
  if (!mc.isValidPublicId(toPublicId)) return false;
  const wire = { from: identity.publicId, fromname: store.metaGet("myname") || "", to: toPublicId, subject: "",
    message: "", randomid: randomId(), date: Date.now(), type, payaddr: mypayaddr };
  const blob = await mc.seal(identity, toPublicId, Buffer.from(toWire(wire), "utf8"));
  if (blob.length > 49000) return false;
  await sendBlob(blob);
  return true;
}
/** Actively ask a peer for their receiving address (the handshake the old port never initiated). */
async function requestPayaddr(toPublicId) { try { return await sendControl(toPublicId, "payaddr-req"); } catch (e) { return false; } }

// ---- scan ----
function statePort99(coin) {
  const st = coin && coin.state;
  if (!st) return "";
  if (Array.isArray(st)) { for (const p of st) if (parseInt(p.port, 10) === 99) return String(p.data || p.value || ""); return ""; }
  if (typeof st === "object") return String(st["99"] || "");
  return "";
}
/** How many BLOCKS the live pass must ask for, given where we last got to. The whole history bug lives in
 *  this one number: it used to be the constant 32. Covers the gap plus a margin, never below the steady-state
 *  window and never past the one-pass ceiling (the remainder is the backfill's job). */
function depthForGap(tip, prevTip) {
  const gap = prevTip ? Math.max(0, tip - prevTip) : 0;   // no cursor yet → nothing to catch up on
  return Math.min(WINDOW_DEPTH, Math.max(POLL_DEPTH, gap + GAP_MARGIN));
}
/** The next block the backfill should reach down to, one chunk below the current floor (never past genesis). */
function nextFloorTarget(floor) { return Math.max(1, floor - BACKFILL_CHUNK); }

async function queryCoins(depth) {
  try {
    const r = await nodeCmd(`coins address:${CHAINMAIL} order:desc depth:${depth}`);
    if (r && r.status === true && Array.isArray(r.response)) return r.response;
    return null;   // over-limit / bad reply
  } catch (e) { return null; }
}
/** Ask for `depth` blocks, halving on refusal so one over-wide request can't lose the whole pass.
 *  Returns { coins, depth } with the depth ACTUALLY served — the caller records coverage from that, never from
 *  what it asked for. The old loop reused the degraded depth as if it had succeeded at full width, so a single
 *  node hiccup silently narrowed that session's history to as little as 4 blocks with nothing said. */
async function queryCoinsDegrading(depth) {
  let d = Math.max(MIN_DEPTH, Math.floor(depth));
  while (d >= MIN_DEPTH) {
    const coins = await queryCoins(d);
    if (coins) {
      if (d < depth) try { node.log(`[mail] coins depth:${depth} refused — served ${d}; history below block tip-${d} deferred to the backfill`); } catch (e) {}
      return { coins, depth: d };
    }
    if (d === MIN_DEPTH) break;
    d = Math.max(MIN_DEPTH, Math.floor(d / 2));
  }
  return { coins: null, depth: 0 };
}
/** Trial-decrypt a page of coins into the store. `historical` suppresses the payaddr auto-reply: a backfill
 *  walks over months of old requests and must not answer any of them with a real coin. Returns {fresh,lastFresh,paLearned}. */
async function processCoins(coins, historical) {
  let fresh = 0, paLearned = false, lastFresh = null;
  const paSeen = new Set();             // learn each peer's payaddr once per pass; coins are order:desc so newest wins
  for (const coin of coins) {
    const blob = statePort99(coin);
    if (!blob) continue;
    const seenKey = coin.coinid || ("b:" + blob);                  // fall back to the blob when a coin lacks a coinid
    if (seenCoins.has(seenKey)) continue;                          // already trial-decrypted this session
    if (seenCoins.size > 40000) seenCoins.clear();
    seenCoins.add(seenKey);
    let o; try { o = await mc.open(identity, blob); } catch (e) { o = null; }
    if (!o || !o.valid) continue;
    let m; try { m = JSON.parse(Buffer.from(o.plaintext).toString("utf8")); } catch (e) { continue; }
    if (o.fromPublicId !== m.from) continue;             // signed-from must equal claimed sender
    if (m.to !== identity.publicId) continue;            // addressed to me
    // Learn the peer's pay address (piggybacked on EVERY message/control coin) — once per pass, newest coin first.
    if (m.payaddr && !paSeen.has(m.from)) {
      paSeen.add(m.from);
      if (store.metaGet("pa:" + m.from) !== m.payaddr) { store.metaSet("pa:" + m.from, m.payaddr); paLearned = true; }
    }
    if (m.type === "payaddr-req" || m.type === "payaddr-reply") {
      // For a REQUEST on a LIVE pass, auto-answer with our own address — the handshake. Suppressed while walking
      // history (no reply coin per historical request) AND hard rate-limited (per-peer cooldown + global hourly
      // cap) so a flood of forged requests can't drain coins / WOTS key-uses.
      if (m.type === "payaddr-req" && !historical && !repliedReq.has(m.randomid)) {
        if (repliedReq.size > 2000) repliedReq.clear();
        repliedReq.add(m.randomid);
        const now = Date.now();
        autoReplyTimes = autoReplyTimes.filter(t => now - t < 3600000);
        const last = paReplyCooldown.get(m.from) || 0;
        if (autoReplyTimes.length < AUTO_REPLY_MAX_PER_HOUR && (now - last) > AUTO_REPLY_PEER_COOLDOWN_MS) {
          autoReplyTimes.push(now); paReplyCooldown.set(m.from, now);
          try { await sendControl(m.from, "payaddr-reply"); } catch (e) { /* best effort */ }
        }
      }
      continue;
    }
    const local = { hashref: threadKey(m.from, m.to, m.subject || ""), fromname: m.fromname || "", frompublickey: m.from,
      topublickey: m.to, subject: m.subject || "", message: m.message || "", randomid: m.randomid, incoming: true, read: false,
      date: parseInt(m.date, 10) || Date.now(), status: "received", sentblock: 0, type: m.type || "text",
      amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image, payaddr: m.payaddr || "" };
    if (store.addMessage(local)) { fresh++; lastFresh = local; }
  }
  return { fresh, paLearned, lastFresh };
}

/**
 * The LIVE pass: cover every block since the last successful scan, not a fixed recent window.
 *
 * The gap drives the depth, so reopening the app after four hours asks for ~290 blocks rather than 32 and the
 * mail sent in that time actually arrives. Anything beyond one window (WINDOW_DEPTH) is handed to the backfill
 * by recording the gap's far edge as its target — that is the case that used to be lost in silence.
 */
async function scanOnce() {
  await init();
  const gen = identityGen;              // if the identity is swapped mid-scan, don't let this stale pass move cursors
  const block = await currentBlock();
  if (!block) return 0;
  const prevTip = Number(store.metaGet("scanned_tip_block") || 0);
  const { coins, depth } = await queryCoinsDegrading(depthForGap(block, prevTip));
  if (!coins) return 0;
  const covered = block - depth;        // oldest block this pass actually saw
  const out = await processCoins(coins, false);
  store.markConfirmed(block);
  if (gen === identityGen) {
    store.metaSet("scanned_tip_block", block);
    lastScanMs = Date.now();
    // Floor tracking: we now cover down to `covered`. On the very first scan that IS the floor; later it only
    // moves down (the backfill's job), never up — otherwise a narrow pass would erase proof of what we hold.
    const floor = Number(store.metaGet("mail_floor_block") || 0);
    if (!floor || covered < floor) store.metaSet("mail_floor_block", covered);
    // A hole opened between what we had and what this pass reached → that is exactly the mail a long shutdown
    // used to lose. Aim the backfill at it; "as far as the node allows" then keeps walking below it.
    if (prevTip && prevTip < covered && !backfill.done) {
      backfill.active = true;
      backfill.target = Math.max(backfill.target, prevTip);
    }
  }
  if (out.fresh || out.paLearned) emitter.emit("update");   // paLearned → an open send-funds sheet can live-fill the address
  if (out.fresh && out.lastFresh) {                          // live (not backfill) → surface an OS notification
    const nm = (store.getContact(out.lastFresh.frompublickey) || {}).username || out.lastFresh.fromname || "";
    const preview = out.lastFresh.type === "image" ? "📷 Photo" : out.lastFresh.type === "payment" ? "💰 Payment" : (out.lastFresh.message || "");
    emitter.emit("incoming", { count: out.fresh, from: out.lastFresh.frompublickey, name: nm, preview });
  }
  return out.fresh;
}

/**
 * ONE step of the backfill: reclaim BACKFILL_CHUNK more blocks below the current floor and persist the new floor,
 * so a quit mid-sweep resumes where it stopped. `depth` is always measured from the tip, so reaching further back
 * means asking WIDER — the step stops for good the moment the node will not serve that width, which is the honest
 * limit of what this node can give us rather than a silent truncation.
 */
async function backfillStep() {
  await init();
  const gen = identityGen;
  const tip = await currentBlock();
  if (!tip) return false;
  let floor = Number(store.metaGet("mail_floor_block") || 0);
  if (!floor) { floor = Math.max(1, tip - POLL_DEPTH); store.metaSet("mail_floor_block", floor); }
  if (floor <= 1) { backfill.active = false; backfill.done = true; return false; }
  const target = nextFloorTarget(floor);
  const { coins, depth } = await queryCoinsDegrading(tip - target);
  // Served no wider than we already hold → this node cannot reach further back. Stop, and say so.
  if (!coins || (tip - depth) >= floor) {
    backfill.active = false; backfill.done = true;
    try { node.log(`[mail] history sweep finished at block ${floor} — the node serves no further back`); } catch (e) {}
    emitter.emit("update");
    return false;
  }
  const out = await processCoins(coins, true);
  const reached = tip - depth;
  if (gen === identityGen) {
    store.metaSet("mail_floor_block", reached);
    backfill.floor = reached; backfill.steps++;
    if (backfill.target && reached <= backfill.target) { backfill.active = false; backfill.target = 0; }
  }
  if (out.fresh) try { node.log(`[mail] history sweep: ${out.fresh} recovered down to block ${reached}`); } catch (e) {}
  emitter.emit("update");   // always: the freshness line is showing this progress
  return backfill.active;
}

/** Live pass, then at most ONE backfill step — the sweep is heavy (a widening query per step), so it is paced by
 *  the block tick rather than run to completion in one go, and the UI stays responsive throughout. */
async function scan() {
  if (scanning) return 0;
  scanning = true;
  try {
    const fresh = await scanOnce();
    if (backfill.active) { try { await backfillStep(); } catch (e) { /* retried on the next tick */ } }
    return fresh;
  } finally { scanning = false; }
}
/** Start (or resume) the deep sweep by hand — "as far as the node allows". */
function startBackfill() {
  backfill.active = true; backfill.done = false;
  backfill.floor = Number(store.metaGet("mail_floor_block") || 0);
  emitter.emit("update");
  return backfillStatus();
}
function backfillStatus() {
  return { active: backfill.active, done: backfill.done, steps: backfill.steps,
    floor: Number(store.metaGet("mail_floor_block") || 0), target: backfill.target };
}
/** Everything the freshness line needs in one call: what we have covered, when we last looked, and whether a
 *  sweep is running. The old panel could only say "just now" — even when hours of mail were missing. */
function status() {
  return { tip: lastTip, scannedTip: Number(store.metaGet("scanned_tip_block") || 0),
    lastScanMs, scanning, backfill: backfillStatus() };
}

function startLoop() {
  if (scanTimer) return;
  // A new block is the trigger, but a running backfill must keep stepping even on a quiet chain — otherwise a
  // sweep stalls for as long as the network does.
  const tick = async () => {
    try {
      const tip = await currentBlock();
      if (tip) lastTip = tip;
      if (tip !== lastScanTip) { lastScanTip = tip; await scan(); }
      else if (backfill.active && !scanning) { scanning = true; try { await backfillStep(); } finally { scanning = false; } }
    } catch (e) {}
  };
  tick();
  scanTimer = setInterval(tick, SCAN_EVERY_MS);
}
function stopLoop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } }

// ---- read model for the renderer ----
function myIdentity() { return { publicId: identity && identity.publicId, name: store.metaGet("myname") || "", payaddr: store.metaGet("mypayaddr") || mypayaddr || "" }; }
function resolvePayaddr(peer) { return store.metaGet("pa:" + peer) || ""; }         // a peer's known receiving address (or "")
function myReceivingAddress() { return store.metaGet("mypayaddr") || mypayaddr || ""; }
function shareString() { const id = identity && identity.publicId; const pa = store.metaGet("mypayaddr") || mypayaddr; return pa ? id + "|" + pa : id; }
function setName(name) { store.metaSet("myname", String(name || "")); emitter.emit("update"); }
// A thread belongs to the CURRENT identity iff I'm one of its two parties (a thread's key pins both, so the last
// message's from/to is definitive). This hides threads orphaned by an identity change — e.g. a seed restore gives a
// new mail identity, and the old conversation, keyed with the previous publicId, would otherwise linger as a duplicate.
function mineThread(t) { const me = identity && identity.publicId; return !!(me && t.last && (t.last.frompublickey === me || t.last.topublickey === me)); }
function threads() { return store.threads().filter(mineThread).map(t => ({ hashref: t.hashref, unread: t.unread, count: t.count, last: t.last, other: otherOf(t.last), subject: (t.last && t.last.subject) || "" })); }
/** Outgoing mail that has not reached the chain yet (Outbox) and outgoing mail that has (Sent) — the APK's two
 *  folders, off the same store. `status` is the on-chain lifecycle: posting → sent → confirmed, or failed. */
function outgoing(match) {
  const me = identity && identity.publicId; if (!me) return [];
  return store.all().filter(m => m && !m.incoming && m.frompublickey === me && match(m.status || "sent"))
    .sort((a, b) => (b.date || 0) - (a.date || 0));
}
function outbox() { return outgoing(st => st === "posting" || st === "failed"); }
function sent() { return outgoing(st => st === "sent" || st === "confirmed"); }
function otherOf(m) { if (!m || !identity) return ""; return m.incoming ? m.frompublickey : m.topublickey; }
// NOTE: emit ONLY when marking-read actually changed something. The renderer's live-update handler calls these
// to refresh an open thread; emitting unconditionally would re-trigger that handler forever (a self-feeding loop).
function thread(hashref) { if (store.markThreadRead(hashref)) emitter.emit("update"); return store.thread(hashref); }
function threadWith(peer, subject) { if (!identity) return []; const h = threadKey(identity.publicId, peer, subject || ""); if (store.markThreadRead(h)) emitter.emit("update"); return store.thread(h); }
function contacts() { return store.contacts(); }
function addContact(share, name) {
  const parts = String(share || "").split("|");
  const id = parts[0].trim();
  if (!mc.isValidPublicId(id)) throw new Error("That doesn't look like a valid mail id.");
  if (parts[1]) store.metaSet("pa:" + id, parts[1].trim());
  store.addContact(id, name || "");
  return { publicId: id };
}
/** Rename a chat/contact — sets the display name for this peer, creating a contact row if none exists.
 *  The thread title reads the contact name, so a rename reflects everywhere immediately. */
function renameContact(peer, name) {
  if (!mc.isValidPublicId(peer)) throw new Error("Invalid mail id.");
  store.renameContact(peer, String(name || "").trim());
  emitter.emit("update");
  return { publicId: peer };
}
function removeContact(peer) { store.removeContact(peer); emitter.emit("update"); return true; }
function deleteThread(hashref) { store.deleteThread(hashref); emitter.emit("update"); return true; }
function archivedThreads() { return store.archivedThreads().filter(mineThread).map(t => ({ hashref: t.hashref, unread: t.unread, count: t.count, last: t.last, other: otherOf(t.last) })); }
function setArchived(hashref, on) { store.setArchived(hashref, !!on); emitter.emit("update"); return true; }

// ---- passphrase-encrypted backup (identity + name + contacts + messages), byte-compatible with the native app ----
async function exportBackup(passphrase) {
  // ASCII-only: Android's PBKDF2 (PBEKeySpec) uses low-byte-per-char, not UTF-8, so a non-ASCII passphrase would
  // derive a different key there and the backup wouldn't restore on the phone. Enforce parity by refusing them.
  if (/[^\x20-\x7E]/.test(String(passphrase))) throw new Error("Use an ASCII passphrase (letters, digits, punctuation) so it restores on every device.");
  await init();
  const sk = JSON.parse(mc.serializeIdentity(identity));   // { publicId, boxPk, boxSk, signPk, signSk } (all hex)
  const root = {
    identity: { boxPk: sk.boxPk, boxSk: sk.boxSk, signPk: sk.signPk, signSk: sk.signSk },
    name: store.metaGet("myname") || "",
    // payaddr is an extra field (native ignores it) so a peer can be paid immediately after a desktop→desktop restore.
    contacts: store.contacts().map(c => ({ name: c.username || "", key: c.publicId, payaddr: store.metaGet("pa:" + c.publicId) || "" })),
    // native reads only the base fields; the extra fields keep desktop's payment/image detail on a desktop restore.
    messages: store.all().map(m => ({ hashref: m.hashref, fromname: m.fromname || "", from: m.frompublickey, to: m.topublickey,
      message: m.message || "", randomid: m.randomid, incoming: !!m.incoming, read: !!m.read, date: m.date, status: m.status || "",
      type: m.type || "text", amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid, image: m.image,
      payaddr: m.payaddr || "", sentblock: m.sentblock || 0 })),
  };
  return backup.encrypt(passphrase, Buffer.from(JSON.stringify(root), "utf8"));   // → container JSON string
}
async function importBackup(passphrase, json) {
  if (/[^\x20-\x7E]/.test(String(passphrase))) throw new Error("Use an ASCII passphrase — a non-ASCII one won't match a backup made on another device.");
  await mc.ready();
  const plain = backup.decrypt(passphrase, json);          // throws on a wrong passphrase / tampered file
  const root = JSON.parse(plain.toString("utf8"));
  const kd = root.identity || {};
  if (!kd.boxPk || !kd.boxSk || !kd.signPk || !kd.signSk) throw new Error("Backup is missing the identity keys.");
  const publicId = "0x" + kd.boxPk + kd.signPk;
  if (!mc.isValidPublicId(publicId)) throw new Error("Backup identity is invalid.");
  const restored = mc.loadIdentity(JSON.stringify({ publicId, boxPk: kd.boxPk, boxSk: kd.boxSk, signPk: kd.signPk, signSk: kd.signSk }));
  if (!mc.keypairConsistent(restored)) throw new Error("Backup identity keys are inconsistent (corrupt file).");
  // Everything above validates BEFORE any mutation — a wrong-passphrase / corrupt file can't leave a half-swapped state.
  identityGen++;
  identity = restored;
  config.setSecret(mc.serializeIdentity(identity), MAIL_KEY_ACCOUNT);
  seenCoins.clear(); repliedReq.clear(); paReplyCooldown.clear(); autoReplyTimes = []; backfilled = false; lastTip = 0;
  store.clear();   // drop the PREVIOUS identity's decrypted mail/contacts (confidentiality on a shared/repurposed node)
  if (root.name != null) store.metaSet("myname", String(root.name));
  for (const c of (root.contacts || [])) {
    if (!c || !c.key || !mc.isValidPublicId(String(c.key))) continue;   // don't import garbage contact keys
    store.addContact(String(c.key), String(c.name || ""));
    if (c.payaddr && looksLikeMinimaAddress(String(c.payaddr))) store.metaSet("pa:" + String(c.key), String(c.payaddr));
  }
  for (const m of (root.messages || [])) {
    if (!m || !m.hashref || !m.randomid) continue;
    store.addMessage({ hashref: m.hashref, fromname: m.fromname || "", frompublickey: m.from || "", topublickey: m.to || "",
      subject: "", message: m.message || "", randomid: m.randomid, incoming: !!m.incoming, read: !!m.read,
      date: parseInt(m.date, 10) || Date.now(), status: m.status || "", sentblock: m.sentblock || 0,
      type: m.type || "text", amount: m.amount, tokenid: m.tokenid, tokenname: m.tokenname, txpowid: m.txpowid,
      image: m.image, payaddr: m.payaddr || "" });
  }
  try { const g = await nodeCmd("getaddress"); const gr = (g && g.response) || {}; mypayaddr = gr.miniaddress || gr.address || ""; if (mypayaddr) store.metaSet("mypayaddr", mypayaddr); } catch (e) {}
  emitter.emit("update");
  scan().catch(() => {});
  return myIdentity();
}

module.exports = { emitter, init, invalidateIdentity, startLoop, stopLoop, scan,
  startBackfill, backfillStatus, status, outbox, sent, retrySend,
  sendMessage, pay, requestPayaddr, resolvePayaddr, myReceivingAddress, looksLikeMinimaAddress,
  myIdentity, shareString, setName, threads, thread, threadWith, contacts, addContact,
  renameContact, removeContact, deleteThread, archivedThreads, setArchived, exportBackup, importBackup,
  _setRunner, CHAINMAIL, threadKey,
  // test seams: the two numbers that decide how much history we fetch (scripts/mail-test.cjs)
  _depthForGap: depthForGap, _nextFloorTarget: nextFloorTarget,
  _limits: { POLL_DEPTH, WINDOW_DEPTH, MIN_DEPTH, BACKFILL_CHUNK, GAP_MARGIN } };
