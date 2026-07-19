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
    const coinsR = await runner("coins relevant:true tokenid:0x00");
    const coins = ((coinsR && coinsR.response) || [])
      .filter(x => Number(x.amount) > 0 && Number(x.amount) >= need)   // must cover the send amount on its own
      .sort((a, b) => Number(a.amount) - Number(b.amount));            // smallest covering coin → minimal disturbance
    for (const x of coins) {
      const addr = String(x.address || "");
      if (addr.length < 42) continue;                                  // short = sentinel/beacon (anyone-can-spend, no key)
      const chk = await runner("checkaddress address:" + addr);
      if (chk && chk.response && chk.response.simple) return c + " fromaddress:" + addr;
    }
  } catch (e) { /* best-effort: fall through to the unmodified send */ }
  return c;
}

module.exports = { pinMinimaSend };
