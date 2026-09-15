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
/** runner: async (cmd) => rpc response. command: a node command string. Returns the command, possibly with
 *  ` fromaddress:<addr>` appended — only for a MINIMA (0x00) `send` that doesn't already pin one. A MINIMA send is
 *  either an explicit `tokenid:0x00` OR one with NO tokenid at all (the node defaults to MINIMA). A non-0x00 token
 *  send is untouched (beacon dust is MINIMA-only). */
async function pinMinimaSend(runner, command) {
  const c = String(command);
  if (!/^send\s/.test(c) || /\bfromaddress:/.test(c)) return c;
  const tok = /\btokenid:(0x[0-9A-Fa-f]+)/.exec(c);
  if (tok && tok[1].toLowerCase() !== "0x00") return c;   // an explicit non-MINIMA token → not beacon-polluted
  const am = /\bamount:([0-9.]+)/.exec(c);
  const need = am ? am[1] : "0";
  // Minima amounts carry up to 44 decimals, well past a double's ~15–17 significant digits, so "does this
  // coin cover the amount" is decided on the DECIMAL STRINGS. Comparing as floats made a coin fractionally
  // short read as covering; pinning to it then makes the send unfundable — the very failure this file exists
  // to prevent — because fromaddress: restricts the input set to that one address.
  const cmpDec = (a, b) => {
    const norm = (v) => { const [i, f = ""] = String(v).split("."); return [i.replace(/^0+(?=\d)/, ""), f.replace(/0+$/, "")]; };
    const [ai, af] = norm(a), [bi, bf] = norm(b);
    if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
    if (ai !== bi) return ai < bi ? -1 : 1;
    const n = Math.max(af.length, bf.length), ap = af.padEnd(n, "0"), bp = bf.padEnd(n, "0");
    return ap === bp ? 0 : (ap < bp ? -1 : 1);
  };
  try {
    const coinsR = await runner("coins relevant:true sendable:true tokenid:0x00");   // SENDABLE only — pending/locked/covenant coins can't fund a send
    const all = ((coinsR && coinsR.response) || []).filter(x => cmpDec(x.amount, "0") > 0 && String(x.address || "").length >= 42);
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
    // (1) Prefer a SINGLE coin that covers the amount on its own — minimal disturbance, smallest first.
    const single = all.filter(x => cmpDec(x.amount, need) >= 0).sort((a, b) => cmpDec(a.amount, b.amount));
    for (const x of single) {
      const addr = String(x.address);
      if (await isSignable(addr)) return c + " fromaddress:" + addr;   // short/beacon addrs → {} (no .simple)
    }
    // (2) No single coin covers → pin the SIGNABLE address whose coins TOTAL covers the amount (the node then combines
    //     the coins AT that address). This lets fragmented own-funds be spent instead of falling back to the raw send,
    //     which would auto-select beacon/covenant dust and hit the KeyRow.getPrivateKey() NPE ("Send failed").
    // Summing across coins at one address: BigInt over a fixed 44-decimal scale, so no float rounding creeps
    // into the "does this address cover it" decision either.
    const SCALE = 44;
    const toUnits = (v) => { const [i, f = ""] = String(v).split("."); return BigInt((i || "0") + f.padEnd(SCALE, "0").slice(0, SCALE)); };
    const byAddr = new Map();
    for (const x of all) { const a = String(x.address); byAddr.set(a, (byAddr.get(a) || 0n) + toUnits(x.amount)); }
    const needUnits = toUnits(need);
    const covering = [...byAddr.entries()].map(([a, total]) => ({ a, total })).filter(o => o.total >= needUnits)
      .sort((x, y) => (x.total < y.total ? -1 : x.total > y.total ? 1 : 0));   // smallest covering address total first
    for (const o of covering) {
      if (await isSignable(o.a)) return c + " fromaddress:" + o.a;
    }
  } catch (e) { /* best-effort: fall through to the unmodified send */ }
  return c;
}

module.exports = { pinMinimaSend };
