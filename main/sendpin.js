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
  const need = am ? (Number(am[1]) || 0) : 0;
  try {
    const coinsR = await runner("coins relevant:true sendable:true tokenid:0x00");   // SENDABLE only — pending/locked/covenant coins can't fund a send
    const all = ((coinsR && coinsR.response) || []).filter(x => Number(x.amount) > 0 && String(x.address || "").length >= 42);
    // (1) Prefer a SINGLE coin that covers the amount on its own — minimal disturbance, smallest first.
    const single = all.filter(x => Number(x.amount) >= need).sort((a, b) => Number(a.amount) - Number(b.amount));
    for (const x of single) {
      const addr = String(x.address);
      const chk = await runner("checkaddress address:" + addr);
      if (chk && chk.response && chk.response.simple) return c + " fromaddress:" + addr;   // short/beacon addrs → {} (no .simple)
    }
    // (2) No single coin covers → pin the SIGNABLE address whose coins TOTAL covers the amount (the node then combines
    //     the coins AT that address). This lets fragmented own-funds be spent instead of falling back to the raw send,
    //     which would auto-select beacon/covenant dust and hit the KeyRow.getPrivateKey() NPE ("Send failed").
    const byAddr = {};
    for (const x of all) { const a = String(x.address); (byAddr[a] = byAddr[a] || 0); byAddr[a] += Number(x.amount); }
    const covering = Object.keys(byAddr).map(a => ({ a, total: byAddr[a] })).filter(o => o.total >= need)
      .sort((x, y) => x.total - y.total);   // smallest covering address total first
    for (const o of covering) {
      const chk = await runner("checkaddress address:" + o.a);
      if (chk && chk.response && chk.response.simple) return c + " fromaddress:" + o.a;
    }
  } catch (e) { /* best-effort: fall through to the unmodified send */ }
  return c;
}

module.exports = { pinMinimaSend };
