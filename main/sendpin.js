/*
 * sendpin — dodge the shared-node beacon-dust signing NPE on a MINIMA `send`.
 *
 * On a node shared with other apps the wallet can hold ANYONE-CAN-SPEND sentinel/beacon dust — e.g. PandaPools
 * 1-nano coins at 0x50414E4441504F4F4C53 ("PANDAPOOLS") — that has NO private key. The node's `send` auto-selects
 * the SMALLEST coin first, grabs that dust, then tries to sign it → `KeyRow.getPrivateKey() null` NPE, and the send
 * fails (AtomiX order publish, minimaMail message/payment, …). `send` has no coin-exclude flag, but it DOES take a
 * `fromaddress:` that restricts funding to one address. So we pin the send to the SMALLEST wallet-SIGNABLE coin
 * that still covers the amount — beacon dust can never be selected, and we disturb the smallest coin possible
 * (never the reserve/main coin). checkaddress → {simple:true} is the reliable signable test (beacon addrs → {}).
 * Best-effort: if we can't find a covering signable coin we return the command unchanged.
 */
/*
 * RESERVED COINS AND TOKENS (0.18.144, docs/COIN_RESERVATION.md). `fromaddress:` is the only way to tell `send` which
 * coins to take, and it names an ADDRESS: the node is free to pick any coin there. So an address that holds a coin
 * another part of the app holds (main/reserve.js) is left out whole, for MINIMA and for tokens. A token send is
 * pinned ONLY for that reason (beacon dust is MINIMA-only): with nothing held it goes out exactly as before.
 */
const SCALE = 44;
// Minima amounts carry up to 44 decimals, well past a double's ~15–17 significant digits, so amounts are compared and
// summed as BigInt over a fixed 44-decimal scale. Comparing as floats made a coin fractionally short read as
// covering; pinning to it then makes the send unfundable — the very failure this file exists to prevent — because
// fromaddress: restricts the input set to that one address.
const toUnits = (v) => { const [i, f = ""] = String(v == null ? "0" : v).split("."); return BigInt((i || "0") + f.padEnd(SCALE, "0").slice(0, SCALE)); };
/** Exact, never rounded: the decimal string of an amount in 44-decimal units. */
const fromUnits = (u) => { const s = u.toString().padStart(SCALE + 1, "0"), f = s.slice(-SCALE).replace(/0+$/, ""); return s.slice(0, -SCALE) + (f ? "." + f : ""); };

/**
 * runner: async (cmd, opts) => rpc response. command: a node `send`. Resolves { command, pinned, need, token,
 * blocked, heldUnits, freeUnits, held }: `command` is the send, with ` fromaddress:<addr>` appended when pinned;
 * `blocked` says coins of this token are held by another owner (then `held` lists their records, `heldUnits` what
 * sits at their addresses and `freeUnits` what is at addresses with no held coin).
 * opts: minCoinage, exclude (below), owner (who sends; none = the wallet), held(coinid) -> the record that keeps the
 * coin from this owner (default: main/reserve.js), tokens (true = pin a token send too, when something is held).
 */
async function pinSend(runner, command, opts) {
  const c = String(command), o = opts || {};
  const tok = /\btokenid:(0x[0-9A-Fa-f]+)/.exec(c), token = tok ? tok[1] : "0x00", minima = token.toLowerCase() === "0x00";
  const out = { command: c, pinned: false, token, need: "0", blocked: false, heldUnits: 0n, freeUnits: 0n, held: [] };
  if (!/^send\s/.test(c) || /\bfromaddress:/.test(c)) return out;
  if (!minima && !o.tokens) return out;   // an explicit non-MINIMA token → not beacon-polluted
  const held = o.held || ((id) => require("./reserve").foreign(o.owner || "wallet", id));
  // minCoinage: only consider coins at least N blocks deep. AtomiX's order-book publish needs this — a
  // publish's own CHANGE output is a brand-new coin that immediately becomes the smallest one, and pinning
  // to a coin the node will not spend yet makes the send unfundable, so every publish poisoned the next.
  // Other callers leave it unset; `sendable:true` alone already excludes what they care about.
  const minCoinage = Number(o.minCoinage) > 0 ? Math.floor(Number(o.minCoinage)) : 0;
  // exclude: addresses (any case) the caller has already tried and the node refused. Lets a caller rotate to
  // the next candidate instead of re-pinning the same one — the AtomiX publish retry uses this.
  const exclude = new Set([...(o.exclude || [])].map(a => String(a).toLowerCase()));
  // what the send must find: amount, or the sum of a multi:[address:amount,…]; a MINIMA send also funds its burn
  let needUnits = 0n;
  const multi = /\bmulti:\[([^\]]*)\]/.exec(c);
  if (multi) for (const m of multi[1].matchAll(/:([0-9]+(?:\.[0-9]+)?)(?=[",\s]|$)/g)) needUnits += toUnits(m[1]);
  else { const am = /\bamount:([0-9.]+)/.exec(c); needUnits = toUnits(am ? am[1] : "0"); }
  const burn = /\bburn:([0-9.]+)/.exec(c); if (burn && minima) needUnits += toUnits(burn[1]);
  out.need = fromUnits(needUnits);
  const amountOf = (x) => toUnits(!minima && x.tokenamount != null ? x.tokenamount : x.amount);   // a token coin's `amount` is raw; `send amount:` is in token units
  try {
    // Ask for exactly the coins `send` will ACCEPT, or the pin is a trap. In the node (coins.java:194)
    // checkmempool defaults to FALSE, so `coins` still lists a coin already committed to an unconfirmed
    // transaction; `send` (send.java:317-333, and again inside selectCoins) excludes those unconditionally —
    // the same two checks: being mined (TxPoWMiner.mMiningCoins) or in the RAM mempool. Without this flag the
    // pin handed `fromaddress:` a coin `send` refused, every input at that address was skipped, and the send
    // died with "Insufficient funds.. you only have 0". Proved on-chain: two coins each spent by two txpows.
    // `sendable:true` is unrelated to this — it is Wallet.isAddressSimple (my own non-contract address).
    // Both lists are RAM-only and do not self-heal promptly (checkForCoinID ignores isOnMainChain; the mining
    // list leaks on a timeout), which is why only a node restart used to clear it.
    // unfiltered: this read must SEE the held coins (main/reserve.js leaves them out of an engine's own coin reads).
    const coinsR = await runner("coins relevant:true sendable:true checkmempool:true tokenid:" + (minima ? "0x00" : token)
      + (minCoinage ? " coinage:" + minCoinage : ""), { unfiltered: true });
    const mine = ((coinsR && coinsR.response) || []).filter(x => amountOf(x) > 0n && String(x.address || "").length >= 42);
    // an address with one held coin is out, with every coin at it
    const poisoned = new Set(), seenHeld = new Set();
    for (const x of mine) { const h = held(x.coinid); if (h) { poisoned.add(String(x.address).toLowerCase()); if (!seenHeld.has(h)) { seenHeld.add(h); out.held.push(h); } } }
    out.blocked = poisoned.size > 0;
    for (const x of mine) { if (poisoned.has(String(x.address).toLowerCase())) out.heldUnits += amountOf(x); else out.freeUnits += amountOf(x); }
    if (!minima && !out.blocked) return out;   // a token send with nothing held: untouched
    const all = mine.filter(x => !exclude.has(String(x.address).toLowerCase()) && !poisoned.has(String(x.address).toLowerCase()));
    // One checkaddress per ADDRESS, not per coin: several coins share an address, and each probe is a round
    // trip with a 30s ceiling, so the old per-coin loop could re-ask the same question many times over.
    const signable = new Map();
    const isSignable = async (addr) => {
      if (signable.has(addr)) return signable.get(addr);
      let ok = false;
      try { const chk = await runner("checkaddress address:" + addr); ok = !!(chk && chk.response && chk.response.simple); } catch (e) { ok = false; }
      signable.set(addr, ok);
      return ok;
    };
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const pin = (addr) => { out.command = c + " fromaddress:" + addr; out.pinned = true; return out; };
    // (1) Prefer a SINGLE coin that covers the amount on its own — minimal disturbance, smallest first.
    const single = all.filter(x => amountOf(x) >= needUnits).sort((a, b) => cmp(amountOf(a), amountOf(b)));
    for (const x of single) {
      const addr = String(x.address);
      if (await isSignable(addr)) return pin(addr);   // short/beacon addrs → {} (no .simple)
    }
    // (2) No single coin covers → pin the SIGNABLE address whose coins TOTAL covers the amount (the node then combines
    //     the coins AT that address). This lets fragmented own-funds be spent instead of falling back to the raw send,
    //     which would auto-select beacon/covenant dust and hit the KeyRow.getPrivateKey() NPE ("Send failed").
    const byAddr = new Map();
    for (const x of all) { const a = String(x.address); byAddr.set(a, (byAddr.get(a) || 0n) + amountOf(x)); }
    const covering = [...byAddr.entries()].map(([a, total]) => ({ a, total })).filter(v => v.total >= needUnits)
      .sort((x, y) => cmp(x.total, y.total));   // smallest covering address total first
    for (const v of covering) {
      if (await isSignable(v.a)) return pin(v.a);
    }
  } catch (e) { out.failed = (e && e.message) || String(e); /* best-effort: fall through to the unmodified send */ }
  return out;
}

/** The pin as every caller has used it: resolves the command, possibly with ` fromaddress:<addr>` appended — only for a
 *  MINIMA (0x00) `send` that doesn't already pin one. A MINIMA send is either an explicit `tokenid:0x00` OR one with NO
 *  tokenid at all (the node defaults to MINIMA). A non-0x00 token send is untouched here (main/reserve.js pins those,
 *  when a coin of the token is held). opts.owner: who sends, so that owner's own held coins are not avoided. */
async function pinMinimaSend(runner, command, opts) {
  return (await pinSend(runner, command, Object.assign({}, opts, { tokens: false }))).command;
}

module.exports = { pinMinimaSend, pinSend, toUnits, fromUnits };
