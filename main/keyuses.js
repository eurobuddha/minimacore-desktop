/*
 * keyuses.js — the KeyUses audit (main process), after Pandamonium's native KeyUses 0.1.4
 * (apks/base integrated/keyreuses, 1c60c2593325f70cba5089e2ba430925d6ccca3c: MainActivity, AuditSelection; and
 * integrated/futurecash-next KeyAudit, AuditApi, MinimaAddress, which it shares), itself the native port of the
 * KeyUses MiniDapp 0.1.55.
 *
 * WHAT IT DOES: reads the node's keys (`keys action:list`, a read: it never signs and never changes a counter),
 * derives each key's default address here, asks the hosted archive index (https://eurobuddha.com, the one host,
 * pinned below) for each key's spend count and for witnessed reuse, and joins the three. It offers no action that
 * signs or changes key uses, as the original offers none.
 *
 * SAFETY-CRITICAL, so it fails closed:
 *  - a key row that is not exactly a classic key (64 / 3 / 262144) or a block key (128 / 4 / 268435456), or whose
 *    counter is not a whole number, refuses the whole audit: nothing is guessed and nothing is shown as zero;
 *  - a wrong address would read as "never spent", so the derivation is self-tested against the original's golden
 *    vectors before every audit and cross-checked against the address the server derived;
 *  - a key the server did not answer for carries null (shown as "Not read"), never 0;
 *  - the keys are read again after the server answered: if anything changed, the audit is refused ("run it again").
 *
 * NOT HERE (the phone has it): the 64 classic and 32 block keys DERIVED FROM THE SEED, and minimaWallet's keys. Both
 * need the seed phrase in this process; this audit covers the keys the node holds.
 */
"use strict";
const crypto = require("crypto");

const BASE = "https://eurobuddha.com";            // AuditApi.BASE: the only host this module ever names
const CHUNK = 64;                                 // AuditApi.CHUNK: entries per request (URL length)
const KEYUSES_MARGIN = 256, REUSE_RED_ABOVE = 3, EXHAUSTION_SLACK = 1000;   // KeyAudit's constants
const SHAPES = { classic: { size: 64, depth: 3, maxuses: 262144 }, block: { size: 128, depth: 4, maxuses: 268435456 } };
const PK = /^0x[0-9a-fA-F]{64}$/;

const MSG = {   // localization/src/main/res/values/bear_strings.xml (English), the phone-only parts taken out
  unavailable: "The node’s keys could not be read. Check that the node is running, then run the audit again.",
  changed: "The node’s keys changed during the audit. Run it again.",
  network: "Could not reach the audit service. Check your connection and try again.",
  selfTest: "Address verification failed. This build cannot run a reliable audit."
};

const sha3 = (bytes) => crypto.createHash("sha3-256").update(bytes).digest();

/** MinimaAddress.fromPublicKey: a public key's default address → { hex, mx }, or null for a malformed key. */
function addressOf(publicKey) {
  if (typeof publicKey !== "string" || !PK.test(publicKey)) return null;
  const script = Buffer.from("RETURN SIGNEDBY(0x" + publicKey.slice(2).toUpperCase() + ")", "utf8");
  const len = Buffer.alloc(4); len.writeUInt32BE(script.length);
  // SHA3( ser(MiniNumber 0) || ser(MiniData script) || ser(MiniNumber 0) ): the single-leaf MMR of the script
  const addr = sha3(Buffer.concat([Buffer.from([0, 1, 0]), len, script, Buffer.from([0, 1, 0])]));
  // Mx: encode32( 0x01 || uint16BE(len) || addr || SHA3(addr)[0..3] ), i/l/o remapped to w/y/z
  const data = Buffer.concat([Buffer.from([1, (addr.length >> 8) & 255, addr.length & 255]), addr, sha3(addr).subarray(0, 4)]);
  const digits = BigInt("0x" + data.toString("hex")).toString(32).replace(/i/g, "w").replace(/l/g, "y").replace(/o/g, "z");
  return { hex: "0x" + addr.toString("hex").toUpperCase(), mx: "Mx" + digits.toUpperCase() };
}

/** Two of MinimaAddressTest's goldens (both confirmed against the live backend there). A miscompiled hash refuses the audit. */
function selfTest() {
  try {
    const a = addressOf("0x3A985DA74FE225B2045C172D6BD390BD855F086E3E9D525B46BFE24511431532"), b = addressOf("0x0000000000000000000000000000000000000000000000000000000000000000");
    return a.hex === "0x39EED202FFBE82E953D234F9CDAFC5C94AEC64875760130C8A596403906B1D8B" && a.mx === "MxG081PTR905VTUGBKY7KHKV76QVHE99BM691QNC09GP2WPCG1P0QZTHD8SWWVQ"
      && b.hex === "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941" && b.mx === "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6";
  } catch (e) { return false; }
}

/** A whole number as the node or the server wrote it (5, "5", "5.0"), or null. Never a guess, never a default. */
function whole(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== "string" || !/^-?\d{1,15}(\.0+)?$/.test(v)) return null;
  return Number(v.split(".")[0]);
}

/**
 * The node's keys from the reply to `keys action:list`, in public-key order (as the phone reads them), each with its
 * family. Throws when the reply is not a non-empty list of well-formed keys of the two known shapes with whole
 * counters and no duplicate (NodeAuditKeys.read, AuditSelection.Entry): an audit of half-read keys is not shown.
 */
function select(reply) {
  const rows = reply && reply.status === true && reply.response && Array.isArray(reply.response.keys) ? reply.response.keys : null;
  if (!rows || !rows.length) throw new Error("no keys in the node's reply");
  const seen = new Set(), keys = [];
  for (const r of rows) {
    const pk = r && r.publickey, size = whole(r && r.size), depth = whole(r && r.depth), maxuses = whole(r && r.maxuses), uses = whole(r && r.uses);
    const family = Object.keys(SHAPES).find(f => SHAPES[f].size === size && SHAPES[f].depth === depth && SHAPES[f].maxuses === maxuses);
    if (typeof pk !== "string" || !PK.test(pk) || !family || uses == null || uses < 0) throw new Error("a key row is not a classic or block key with a whole counter");
    const id = pk.toUpperCase(); if (seen.has(id)) throw new Error("a key is listed twice"); seen.add(id);
    const address = addressOf(pk); if (!address) throw new Error("an address could not be derived");
    keys.push({ publickey: pk, size, depth, maxuses, uses, family, address });
  }
  return keys.sort((a, b) => (a.publickey.toUpperCase() < b.publickey.toUpperCase() ? -1 : 1));
}

/** AuditApi.parseUsage: /keyaudit rows → [{ publickey, address, sigs, coins }]; a row with an error or a bad count is left out. */
function parseUsage(arr) {
  const out = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    if (!o || typeof o !== "object" || typeof o.publickey !== "string" || !o.publickey || "error" in o) continue;
    const sigs = whole("spend_blocks" in o ? o.spend_blocks : o.onchain_signatures), coins = whole("spent_coins" in o ? o.spent_coins : o.spent_coins_upperbound);
    if (sigs == null || coins == null || sigs < 0 || coins < 0) continue;
    out.push({ publickey: o.publickey, address: typeof o.address === "string" ? o.address : "", sigs, coins });
  }
  return out;
}
/** AuditApi.parseReuse: /reuse rows → [{ address, reused, reuseCount }]; "not reused" with a count, or anything unreadable, is left out. */
function parseReuse(arr) {
  const out = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    if (!o || typeof o !== "object" || typeof o.address !== "string" || !o.address || "error" in o || typeof o.reused !== "boolean") continue;
    const count = whole(o.reuse_count);
    if (count == null || count < 0 || (!o.reused && count !== 0)) continue;
    out.push({ address: o.address, reused: o.reused, reuseCount: o.reused ? Math.max(1, count) : 0 });
  }
  return out;
}

/** KeyAudit.join: the node's keys against the two server answers → the verdict and one row per key. Pure. */
function join(keys, usage, reuse) {
  const up = (s) => String(s).toUpperCase();
  const byPk = new Map(usage.map(u => [up(u.publickey), u])), byAddr = new Map(reuse.map(r => [up(r.address), r]));
  let anyRisk = false, anyReuse = false, mismatch = false, exhaustion = false, recommended = 0, worstReuse = 0, classicKeys = 0, blockKeys = 0;
  const rows = keys.map((k, i) => {
    const u = byPk.get(up(k.publickey)) || null, d = k.address, r = byAddr.get(up(d.hex)) || null;
    // our derivation against the server's: a silent disagreement would mean /reuse was asked about the wrong address
    const same = !!u && up(d.hex) === up(u.address);
    if (u && !same) mismatch = true;
    if (k.uses > k.maxuses - EXHAUSTION_SLACK) exhaustion = true;
    const reused = !!(r && r.reused);
    if (reused) { anyReuse = true; worstReuse = Math.max(worstReuse, r.reuseCount); }
    // spend counts estimate a CLASSIC counter; a block key's leaf position is not comparable with them
    const risk = k.family === "classic" && !!u && u.sigs > k.uses;
    if (risk) anyRisk = true;
    if (k.family === "classic") { classicKeys++; recommended = Math.max(recommended, u ? u.sigs : 0, k.uses); } else blockKeys++;
    return { index: i + 1, publickey: k.publickey, address: d.mx, hex: d.hex, family: k.family, local: k.uses, maxuses: k.maxuses,
      sigs: u ? u.sigs : null, coins: u ? u.coins : null, risk, reused, reuseCount: r ? r.reuseCount : 0, checked: !!u && !!r && same };
  });
  const complete = rows.length > 0 && !mismatch && rows.every(r => r.checked);
  return { rows, verdict: anyReuse ? (worstReuse > REUSE_RED_ABOVE ? "REUSE_RISK" : "REUSE_WARN") : anyRisk ? "RISK_HEURISTIC" : "OK",
    worstReuse, recommendedKeyUses: classicKeys ? recommended + KEYUSES_MARGIN : 0, mismatch, exhaustion, complete, classicKeys, blockKeys };
}

/** AuditApi.audit: both endpoints, in chunks. get(url) → the parsed JSON or null. Throws on any chunk that did not answer status:true. */
async function lookup(keys, get) {
  const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };
  const ask = async (url) => { const j = await get(url); if (!j || j.status !== true) throw new Error("no answer"); return j; };
  let tip = -1; const usage = [], reuse = [];
  await Promise.all([
    ...chunks(keys.map(k => k.publickey)).map(async (c) => { const j = await ask(BASE + "/keyaudit?keys=" + encodeURIComponent(c.join(","))); const t = whole(j.archive_tip); if (t != null && t > tip) tip = t; usage.push(...parseUsage(j.keys)); }),
    ...chunks(keys.map(k => k.address.hex)).map(async (c) => { const j = await ask(BASE + "/reuse?addrs=" + encodeURIComponent(c.join(","))); reuse.push(...parseReuse(j.results)); })
  ]);
  return { usage, reuse, tip };
}

/**
 * One audit. io = { run(command) → the node's reply (through rpcCall), get(url) → parsed JSON or null (https, no
 * redirect) }. → { ok: true, tip, …join() } or { ok: false, error }. Never throws; never returns a figure it did not read.
 */
async function audit(io) {
  if (!selfTest()) return { ok: false, error: MSG.selfTest };
  let keys;
  try { keys = select(await io.run("keys action:list")); } catch (e) { return { ok: false, error: MSG.unavailable }; }
  let found;
  try { found = await lookup(keys, io.get); } catch (e) { return { ok: false, error: MSG.network }; }
  try { if (JSON.stringify(select(await io.run("keys action:list"))) !== JSON.stringify(keys)) return { ok: false, error: MSG.changed }; }
  catch (e) { return { ok: false, error: MSG.unavailable }; }
  return Object.assign({ ok: true, tip: found.tip }, join(keys, found.usage, found.reuse));
}

module.exports = { audit, select, join, lookup, parseUsage, parseReuse, addressOf, selfTest, whole, BASE, SHAPES, MSG };
