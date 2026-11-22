/*
 * dexicon-pp.js: Dexicon room ② Pools. The REAL PandaPools (constant-product pools MINIMA ⇄ MxUSD on Minima), drawn as
 * the Android client draws it inside Dexicon (apks/dexicon com.eurobuddha.pandapools SwapView / PoolsView / MyLpView /
 * WalletView / ActivityView) over the engine the desktop already runs: the SAME window.mcd pp* calls with the SAME
 * arguments and the SAME guards, in the same order, as the panel it replaces (renderer/pools.js, removed in 0.18.141; was kept in the
 * tree until the 3e parity audit). This file changes screens, never behaviour: scripts/dexicon-pp.test.cjs runs both
 * and compares every call.
 *
 * Three parts, as dexicon-ax.js: text and numbers with no DOM (Core), the money actions over (api, ui) with no DOM
 * (Act), the screens. RULE 2: the dollar token is MxUSD wherever the desktop writes it. The engine names it "USDT"
 * in the records it keeps; "USDT/MINIMA (MEXC)" is the MEXC market's own unit and stays.
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");   // loaded by a test or the main process: the same t(), th(), tr() the window has
(function (root, factory) { const node = typeof module === "object" && module.exports, m = factory(node ? require("./dexicon-core.js") : root.DexCore); if (node) module.exports = m; else root.DexPools = m; })(this, function (C) {
  "use strict";

  // ======================================================================== Core: no DOM
  const MINIMA = "0x00", MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const isMxusd = (tok) => String(tok || "").toLowerCase() === MXUSD.toLowerCase();
  /**
   * A token's own name as it may be shown (0.19.102). Removed: control and format characters (zero-width, direction
   * marks and overrides), every code point that draws nothing (Unicode's default-ignorables: the Hangul fillers U+3164,
   * U+115F, U+1160, U+FFA0, variation selectors, the grapheme joiner) and the blank Braille cell U+2800. Any run of
   * space characters becomes one space. A name of only such characters is no name.
   */
  const clean = (name) => String(name == null ? "" : name).replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "").replace(/[\p{Z}\s]+/gu, " ").trim();
  const NAME_MAX = 32;   // code points of a token's name on a screen; the token id beside it is always whole
  /** The cleaned name, capped, inside a direction ISOLATE (U+2068 … U+2069): right-to-left letters in a name cannot reorder the mark before it or the token id after it. */
  const shown = (name) => { const a = Array.from(name); return "\u2068" + (a.length > NAME_MAX ? a.slice(0, NAME_MAX).join("") + "…" : name) + "\u2069"; };
  /**
   * A token's identity is its ID, never its name (0.18.135). The one MxUSD is MXUSD above and is the only token written
   * "MxUSD". EVERY other token is written by its own name marked "(not MxUSD)", and wherever a pair is named or a trade is
   * reviewed its whole token id stands beside it (pairName). A name can be anything its maker typed: "MxUSD " with a
   * space, a zero-width character, Cyrillic letters.
   */
  // THE MARK GOES FIRST (0.19.102): a label cut short by a narrow column or a closed picker then reads "(not MxUSD) …",
  // never a bare name. A long name can no longer push the mark out of sight.
  const tokLabel = (tok, name) => { if (isMxusd(tok)) return "MxUSD"; const n = clean(name); return I18N.t("(not MxUSD) {n}", { n: shown(n && n.toLowerCase() !== String(tok || "").toLowerCase() ? n : "unnamed token") }); };
  /** "MINIMA / MxUSD", or for any other token "MINIMA / (not MxUSD) <name>  ·  token <its whole id>". t = { tok, name: tokLabel }. */
  const pairName = (t) => I18N.t("MINIMA / {name}{tok}", { name: t.name, tok: (isMxusd(t.tok) ? "" : ("  " + I18N.t("·  token {tok}", { tok: t.tok }))) });
  // Letters of other alphabets (and two signs) that read as the Latin letters of "MxUSD" and "USDT", after lower-casing.
  // ponytail: Cyrillic and Greek only; a look-alike from another script still gets "(not MxUSD)" and its id, only not the extra warning line.
  const LOOK = { "м": "m", "μ": "m", "х": "x", "χ": "x", "ц": "u", "џ": "u", "υ": "u", "ս": "u", "ѕ": "s", "$": "s", "5": "s", "ԁ": "d", "д": "d", "δ": "d", "т": "t", "τ": "t", "а": "a", "α": "a", "е": "e", "ε": "e", "о": "o", "ο": "o", "0": "o", "р": "p", "ρ": "p", "с": "c", "і": "i", "ι": "i", "к": "k", "κ": "k" };
  /** a name reduced to what the eye reads: compatibility forms unfolded, accents, spaces, control and zero-width characters dropped, look-alike letters mapped, lower case */
  const skeleton = (name) => Array.from(clean(name).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()).map((c) => LOOK[c] || c).join("").replace(/[^a-z]/g, "");
  /** Does another token's name imitate the dollar token (MxUSD, mxUSDT, USDT, USD…)? Then the review says so in its own line. */
  const imitates = (tok, name) => !isMxusd(tok) && /usd/.test(skeleton(name));
  const IMITATES = L_("This token is not MxUSD. Its name imitates it.");
  /** The engine's fixed sentences and the node's errors say USDT for the dollar token. For those sentences ONLY: a record
   *  (a swap's summary, a token's label) is labelled by token id in the glue (main/pandapools.js labelById), never by rewriting words. */
  const mx = (s) => whereConfirm(String(s == null ? "" : s).replace(/\bm?x?USDT\b/gi, "MxUSD"));
  /** The engine's fixed sentences send the reader to "Pool recovery" to confirm a signing state (reserve-recovery.js,
   *  vendored). No such entry exists here: the button is Confirm wallet signing state, on the pool's card in My LP. */
  const whereConfirm = (s) => String(s).replace(/confirm it (again )?in Pool recovery/g, "confirm it $1with Confirm wallet signing state on the pool's card in My LP").replace(/Open Pool recovery and confirm/g, "In My LP, on the pool's card, press Confirm wallet signing state to confirm");
  /** a decimal string CUT to dp decimals, never rounded (SwapView.trim8 / fmt6: RoundingMode.DOWN); other text as it is */
  const cut = (x, dp) => { const d = C.dec(x); return d ? C.str(C.down(d, dp)) : String(x == null || x === "" ? "0" : x); };
  /** every digit, no trailing zeros (SwapView.trim) */
  const whole = (x) => { const d = C.dec(x); return d ? C.str(d) : String(x == null ? "—" : x); };
  /** the old panel's amount check (pools.js doPpSwap): digits with at most one point, above zero */
  const amountOk = (v) => /^[0-9]*\.?[0-9]+$/.test(String(v)) && parseFloat(v) > 0;
  const plural = (n, one) => (I18N.lang() === "en" ? n + " " + one + I18N.s(Number(n)) : I18N.t(one) + ": " + n);   // English: "3 pools"; elsewhere the noun then the count, which needs no ending

  /** The pairs there are pools for: [{ tok, name, fake? }]. MxUSD (by its id) is always FIRST, so it is the default; the
   *  others follow as the scan gives them (deepest first). fake: the name imitates the dollar token. */
  function pairs(pools) {
    const seen = {}, out = [];
    for (const p of pools || []) if (p.tok && !seen[p.tok.toLowerCase()]) { seen[p.tok.toLowerCase()] = 1; out.push(Object.assign({ tok: p.tok, name: tokLabel(p.tok, p.tokName) }, imitates(p.tok, p.tokName) ? { fake: true } : {})); }
    return out.sort((a, b) => isMxusd(b.tok) - isMxusd(a.tok));
  }
  /** The selected pair, held by TOKEN ID. sel "" = nothing chosen yet: the first pair (MxUSD when it has a pool). A chosen
   *  id that is no longer in the list selects NOTHING (lost), never another token: a rescan cannot change what is traded. */
  const NONE = "none";
  function chosen(list, sel) { if (!sel) return { t: list[0] || null, lost: false }; const t = list.find((x) => x.tok.toLowerCase() === String(sel).toLowerCase()) || null; return { t, lost: !t && sel !== NONE }; }
  const lostLine = (tok) => I18N.t("The pair you had selected is no longer in the pool registry (token {tok}). Nothing was sent and no other pair was selected for you. Pick a pair.", { tok: tok });
  const poolLine = (t, info) => I18N.t("{pairName}   ·   {pools}   ·   depth {depth} MINIMA", { pairName: pairName(t), pools: plural(info.pools, "pool"), depth: whole(info.depth) });
  /** sendable, not confirmed: confirmed counts coins locked in pools (the old panel's rule) */
  function sendable(bal, tok) { const r = (bal || []).find((b) => b.tokenid && b.tokenid.toLowerCase() === String(tok).toLowerCase()); return r ? r.sendable || "0" : "0"; }
  const balanceLine = (bal, t) => I18N.t("Your balance: {minima} MINIMA  ·  {tok} {name}", { minima: cut(sendable(bal, MINIMA), 6), tok: cut(sendable(bal, t.tok), 6), name: t.name });
  /** The MEXC line (SwapView.renderMarket), for the MxUSD pair only: the market mid, the blended pool price (Σ token /
   *  Σ MINIMA, cut to 6 decimals) and how far apart they are. "" = no line. */
  function marketLine(t, market, pools) {
    if (!isMxusd(t.tok)) return "";
    let m = C.zero, u = C.zero;
    for (const p of pools || []) if (p.tok && p.tok.toLowerCase() === t.tok.toLowerCase()) { m = C.add(m, C.dec(p.reserveM) || C.zero); u = C.add(u, C.dec(p.reserveT) || C.zero); }
    if (m.v === 0n) return "";
    const mid = market && market.fresh && Number(market.mid) > 0 ? C.dec(Number(market.mid).toFixed(12)) : null;
    if (!mid || mid.v === 0n) return I18N.t("Market price unavailable (MEXC)");
    const spot = C.div(u, m, 12), above = C.cmp(spot, mid) > 0, pct = C.div(C.mul(above ? C.sub(spot, mid) : C.sub(mid, spot), C.dec("100")), mid, 8);
    const word = C.cmp(pct, C.dec("0.1")) < 0 ? "at market" : C.str(C.down(pct, 1)) + "% " + (above ? "above market" : "below market");
    return I18N.t("Market ≈ {mid} USDT/MINIMA (MEXC)  ·  Pool {spot}  ·  {word}", { mid: C.str(C.down(mid, 6)), spot: C.str(C.down(spot, 6)), word: word });
  }
  /** The live quote's rows (SwapView.requote), or why there is none. q = ppQuote(). */
  function quoteRows(q, t, dir) {
    if (!q || !q.ok) return { ok: false, out: q && q.notReady ? "0.0" : "—", note: q && q.notReady ? I18N.t("PandaPools is still starting. One moment.") : I18N.t("This trade is too large for the pools' depth. Try a smaller amount.") };
    const rows = [["Rate", "≈ " + cut(q.effPrice, 8) + " " + t.name + " / MINIMA"], [I18N.t("Price impact"), q.priceImpact + " %"]];
    if (Number(q.poolsAvailable) > 1) rows.push([I18N.t("Routed across"), I18N.t("{poolsUsed} of {poolsAvailable} pools{maxPools}", { poolsUsed: (Number(q.poolsUsed) || 0), poolsAvailable: (Number(q.poolsAvailable) || 0), maxPools: (q.capped ? (" " + I18N.t("(top {maxPools})", { maxPools: (Number(q.maxPools) || 6) })) : "") })]);
    rows.push([I18N.t("Pool fee (0.50%)"), "kept by LPs"], [I18N.t("You receive"), whole(q.totalOut) + " " + (dir ? t.name : "MINIMA")]);
    return { ok: true, out: cut(q.totalOut, 8), rows };
  }
  /** What the Swap click asks to be confirmed (SwapView.confirmAndSwap; the old panel's "Confirm swap"). */
  function swapReview(q, amt, t, dir) {
    const pay = dir ? "MINIMA" : t.name, get = dir ? t.name : "MINIMA";
    // what is PAID is the amount the engine routed (q.totalIn), which is what will be posted; a typed amount it did not take whole is said beside it
    const routed = q.totalIn != null && q.totalIn !== "" ? whole(q.totalIn) : String(amt), typed = C.dec(amt), same = !typed || routed === C.str(typed);
    return { title: I18N.t("Confirm swap"), ok: I18N.t("Swap"), text: I18N.t("Pay  {routed} {pay}{amt}\nReceive  {totalOut} {get}\nRate  ≈ {effPrice} {name} / MINIMA\nPool pair  {pairName}{imitates}\n\nPrice impact {priceImpact}%.{poolsUsed}\n\nThis posts a real on-chain transaction for exactly these amounts. There is no slippage setting: if a pool moves before it confirms, the swap is rejected and you keep your funds.", { routed: routed, pay: pay, amt: (same ? "" : ("  " + I18N.t("(you typed {amt}; this is the amount the pools take)", { amt: amt }))), totalOut: whole(q.totalOut), get: get, effPrice: cut(q.effPrice, 8), name: t.name, pairName: pairName(t), imitates: (t.fake ? "\n\n" + IMITATES : ""), priceImpact: q.priceImpact, poolsUsed: (Number(q.poolsUsed) > 1 ? ("\n" + I18N.t("Routed across {poolsUsed} pools in one transaction.", { poolsUsed: q.poolsUsed })) : "") }) };
  }

  // ---- Pools (PoolsView.java) ----
  /** "3 pools · 866751.25 MINIMA aggregate depth": the MINIMA reserves added exactly (VirtualCurve.totalMinima). */
  function poolsSummary(pools) {
    if (!pools || !pools.length) return "no active pools";
    return I18N.t("{pools} · {zero} MINIMA aggregate depth", { pools: plural(pools.length, "pool"), zero: C.str(pools.reduce((t, p) => C.add(t, C.dec(p.reserveM) || C.zero), C.zero)) });
  }
  /** One pool's card: its rows as [label, value, copy value]. The pool address is whole. */
  function poolCard(p) {
    const name = tokLabel(p.tok, p.tokName), rows = [["reserves", I18N.t("{reserveM} MINIMA  ·  {reserveT} {name}", { reserveM: whole(p.reserveM), reserveT: whole(p.reserveT), name: name })], ["spot price", I18N.t("{spot} {name} / MINIMA", { spot: cut(p.spot, 8), name: name })], ["fees accrued (K/KMIN−1)", cut(p.feeGrowthPct, 8) + " %"]];
    if (!isMxusd(p.tok)) rows.push(["token", String(p.tok), p.tok]);
    rows.push(["pool", I18N.t("{address}  (click to copy)", { address: p.address }), p.address]);
    return { title: pairName({ tok: p.tok, name }), rows };
  }
  /** One collective card per token (PoolsView.combinedCard), from the engine's own aggregates (ppAggregate). */
  function combinedCard(a) {
    const name = tokLabel(a.tok, a.name);
    return { title: I18N.t("{name}  ·  combined", { name: pairName({ tok: a.tok, name }) }), rows: [["pools combined", String(a.count)], ["total reserves", I18N.t("{totalMinima} MINIMA  ·  {totalToken} {name}", { totalMinima: whole(a.totalMinima), totalToken: whole(a.totalToken), name: name })], ["aggregate spot price", I18N.t("{price} {name} / MINIMA", { price: cut(a.price, 8), name: name })], ["tradeable depth", whole(a.depth) + " MINIMA"]] };
  }

  // ---- My LP (MyLpView.java) ----
  /** a figure the glue computes as a number (fees, percentages), CUT to 4 decimals toward zero, never rounded */
  const cutNum = (n) => { n = Number(n); if (!isFinite(n)) return "0"; const t = Math.trunc(n * 1e4) / 1e4; return String(Object.is(t, -0) ? 0 : t); };
  /** K/KMIN is the pool's headroom over its product floor; past 1.85 the phone turns the bar amber and offers Migrate first */
  const MIGRATE_AT = 1.85;
  const needsMigrate = (p) => { const r = Number(p && p.kratio); return isFinite(r) && r >= MIGRATE_AT; };
  /** The summary card (MyLpView.renderSummary): total MINIMA reserves of the pools this node can see. */
  function lpSummary(mine) {
    if (!mine) return { value: "…", sub: "" };
    const live = mine.filter((p) => !p.unresolved), gone = mine.length - live.length;
    if (!live.length) return gone ? { value: I18N.t("Reserves unavailable"), sub: I18N.t("{gone} a live reserve check.", { gone: plural(gone, "saved pool") + (" " + I18N.t(gone === 1 ? "needs" : "need")) }) } : { value: I18N.t("No pools yet"), sub: I18N.t("Create a pool to start earning the swap fee.") };
    return { value: I18N.t("{zero} MINIMA reserves", { zero: C.str(live.reduce((t, p) => C.add(t, C.dec(p.reserveM) || C.zero), C.zero)) }), sub: I18N.t("{live} · token reserves shown below{gone}", { live: plural(live.length, "visible pool"), gone: (gone ? (" " + I18N.t("· {gone} unavailable", { gone: gone })) : "") }) };
  }
  /** One of my pools as rows [label, value, tone] (MyLpView.poolCard). */
  function lpRows(p) {
    const name = tokLabel(p.tok, p.tokName), rows = [[I18N.t("Your liquidity"), I18N.t("{reserveM} MINIMA  +  {reserveT} {name}", { reserveM: whole(p.reserveM), reserveT: whole(p.reserveT), name: name })], [I18N.t("Value now"), "≈ " + whole(p.value) + " MINIMA"], [I18N.t("Pool price"), I18N.t("{poolPrice} {name} / MINIMA", { poolPrice: cut(p.poolPrice, 8), name: name })],
      [I18N.t("Fees earned"), "≈ " + cutNum(p.feesMinima) + (" " + I18N.t("MINIMA  (+")) + cutNum(p.feesPct) + "%)", "ok"]];
    if (p.priceMove != null) {
      rows.push([I18N.t("Price since open"), (p.priceMove >= 0 ? "+" : "") + cutNum(p.priceMove) + "%"], [I18N.t("Impermanent loss"), I18N.t("{il}%  vs holding", { il: cutNum(p.il) }), p.il < -0.01 ? "warn" : ""]);
      if (p.ageBlocks > 0) rows.push(["Age", I18N.t("{ageBlocks} blocks  (~{ageBlocks2} h)", { ageBlocks: (Number(p.ageBlocks) || 0), ageBlocks2: cutNum(p.ageBlocks * 50 / 3600) })]);
    }
    return rows;
  }
  /** The token side of an Add, as the engine works it out (main/pandapools/poolmgr.js deposit): MINIMA × token reserve ÷ MINIMA
   *  reserve, CUT to the token's decimals. An estimate: the engine uses the reserves it reads when it posts. null = not known. */
  function depositToken(p, a) {
    const m = C.dec(a), rm = C.dec(p && p.reserveM), rt = C.dec(p && p.reserveT); if (!m || !rm || !rt || rm.v === 0n) return null;
    return C.str(C.down(C.div(C.mul(m, rt), rm, 30), safeDec({ decimals: p.tokDecimals })));
  }
  const poolIds = (p) => I18N.t("Pool: {address}{opk}", { address: p.address, opk: (p.opk ? ("\n" + I18N.t("Owner key: {opk}", { opk: p.opk })) : "") });
  const recoveryResult = (r) => I18N.t("Verified reserves for {restored} of {total} pools.\n{details}\n{warn}", { restored: r.restored, total: r.total, details: (r.details || []).join("\n\n"), warn: (r.warn || "") });
  const CLOSE_TO_OWNER = L_("to the pool's owner address on this node. PandaPools then moves them into your wallet by itself; if they have not arrived after a few blocks, use Collect withdrawn funds. Do that before you restore your seed on another node.");

  // ---- Activity (ActivityView.java) ----
  const ACT_NAME = { SWAP: N_("Swap"), CREATE: N_("Create pool"), ADD: N_("Add liquidity"), DEPOSIT: N_("Add liquidity"), WITHDRAW: N_("Withdraw"), CLOSE: N_("Withdraw"), MIGRATE: N_("Migrate"), COLLECT: N_("Collect") };
  /** "18 Nov 2026 14:13:36 GMT" (ActivityView.absolute), or that the time is not known */
  const when = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toUTCString().replace(/^\w+, /, "") : I18N.t("Time unknown"));
  /** how long ago a check was made (ActivityView.relative) */
  const since = (ms, now) => { const d = now - Number(ms); return d < 60000 ? "just now" : d < 3600000 ? I18N.t("{d}m ago", { d: Math.floor(d / 60000) }) : d < 86400000 ? I18N.t("{d}h ago", { d: Math.floor(d / 3600000) }) : I18N.t("{d}d ago", { d: Math.floor(d / 86400000) }); };
  /** Older swap rows were kept from the token's side ("Bought <token> for <minima>"): said from MINIMA's side, as new ones are (the old panel's ppSwapSummary). */
  function swapSummary(a) {
    const s = a.summary || "";
    if (a.type !== "SWAP" || /MINIMA/.test(s)) return s;
    let m = /^Bought (\S+) for (\S+)$/.exec(s); if (m) return I18N.t("Sold {m} MINIMA for {m2}", { m: m[2], m2: m[1] });
    m = /^Sold (\S+) for (\S+)$/.exec(s); return m ? I18N.t("Bought {m} MINIMA for {m2}", { m: m[1], m2: m[2] }) : s;
  }
  /** One of my pool operations as a card: { title, chip, tone, summary, lines, ids: [[label, whole id]] }. */
  function actItem(a, now) {
    const tone = a.failed ? "bad" : a.confirmed ? "ok" : "live", lines = [(a.timeLabel || "Submitted") + " " + when(a.ts)], ids = [];
    if (a.txpowid) ids.push(["transaction", a.txpowid]);
    if (a.originalTxpowid && String(a.originalTxpowid).toLowerCase() !== String(a.txpowid).toLowerCase()) ids.push(["original submission", a.originalTxpowid]);
    if (a.verifiedAt) lines.push(I18N.t("Checked {verifiedAt}", { verifiedAt: since(a.verifiedAt, now) }));
    if (a.failed) lines.push(a.failMsg ? failText(I18N.t("This"), a.failMsg, null, 0, true) : I18N.t("It was not sent. No funds moved."));   // a row the engine marked failed: nothing was sent
    return { title: (ACT_NAME[a.type] && I18N.t(ACT_NAME[a.type])) || String(a.type || I18N.t("Pool transaction")), chip: a.failed ? I18N.t("FAILED") : a.statusText || I18N.t("Waiting for node check"), tone, summary: swapSummary(a), lines, ids, done: !!(a.failed || a.confirmed) };
  }
  /** One transaction of any pool (ActivityView.globalRow). */
  function feedItem(f, now) {
    const label = String(f.tokenLabel || "token"), action = f.kind === "CREATE" ? I18N.t("Pool creation") : f.kind === "ADD" ? I18N.t("Liquidity addition") : f.kind === "WITHDRAW" ? I18N.t("Liquidity withdrawal") : f.kind === "SWAP" ? (f.minimaIn ? I18N.t("MINIMA sale") : I18N.t("MINIMA purchase")) : I18N.t("Pool reserves changed");
    if (f.observed) return { observed: true, title: I18N.t("{kind} observation (unverified) · {minimaAmt} MINIMA / {tokenAmt} {label}", { kind: String(f.kind || I18N.t("Pool")), minimaAmt: whole(f.minimaAmt), tokenAmt: whole(f.tokenAmt), label: label }), lines: [I18N.t("Observed on this device {ts} · Transaction time unknown", { ts: when(f.ts) })], ids: f.pool ? [["pool", f.pool]] : [] };
    return { title: I18N.t("{action} · {minimaAmt} MINIMA / {tokenAmt} {label}", { action: action, minimaAmt: whole(f.minimaAmt), tokenAmt: whole(f.tokenAmt), label: label }), chip: f.statusText || "", tone: f.confirmed ? "ok" : "live", lines: [I18N.t("Transaction {ts}", { ts: when(f.ts) })].concat(f.verifiedAt ? [I18N.t("Checked {verifiedAt}", { verifiedAt: since(f.verifiedAt, now) })] : []),
      ids: [].concat(f.pool ? [["pool", f.pool]] : [], f.txpowid ? [["transaction", f.txpowid]] : []) };
  }

  // ---- Wallet (WalletView.java): what can be pooled ----
  /** One balance as the phone's card: the sendable amount (whole), the coin count, and the line beneath. */
  function walletCard(b, name, agoText) {
    const conf = C.dec(b.confirmed), send = C.dec(b.sendable), n = Number(b.coins) || 0;
    return { name, amount: whole(b.sendable), coins: (n + (" " + I18N.t(n === 1 ? "coin" : "coins"))).toUpperCase(),
      line: "confirmed " + whole(b.confirmed) + "  ·  locked ≈ " + (conf && send ? C.str(C.sub(conf, send)) : "?") + "  ·  unconfirmed " + whole(b.unconfirmed) + "  ·  " + plural(n, "coin") + "  ·  updated " + agoText + "  ·  click for coins" };
  }
  /** What the node check found, in one sentence. */
  const nodeCheck = (running, block, st) => (!running ? I18N.t("The node is not running, so nothing here can be read or sent. Start the node.")
    : !(Number(block) > 0) ? I18N.t("The node did not answer just now. Nothing was changed. Try again in a moment.")
    : I18N.t("The node answers: block {block}. {ready}", { block: block, ready: (st && st.ready ? I18N.t("PandaPools is running and reading the pool registry.") : I18N.t("PandaPools has not finished starting yet.")) }));

  // ---- create a pool, in PandaPools' four steps (MyLpView.openCreate → createFormPriced | createFormManual → confirmCreate → forceBackupAfterCreate) ----
  const STEPS = [N_("Before you start"), N_("Amounts"), N_("Review"), N_("Back up")];   // translated where drawn
  /** Token decimals, read defensively (the old panel's ppSafeDec): a wrong value is refused by the engine at create. */
  const safeDec = (token) => { const d = parseInt(token && token.decimals, 10); return Number.isFinite(d) && d >= 0 && d <= 18 ? d : 8; };
  /** What a pool can be made with (the old panel's showPpCreate): sendable MINIMA, and the market-fed token (MxUSD) when some is sendable. */
  function createTokens(bal, usdtId) {
    let minimaAvail = 0; const toks = [], fed = (tid) => !!tid && !!usdtId && tid.toLowerCase() === String(usdtId).toLowerCase();
    for (const b of bal || []) {
      const tid = b.tokenid || "", avail = parseFloat(b.sendable) || 0;
      if (tid === MINIMA) { minimaAvail = avail; continue; }
      if (tid && avail > 0 && fed(tid)) toks.push({ tokenid: tid, name: tokLabel(tid, b.token && b.token.name && (b.token.name.name || b.token.name)), dec: safeDec(b.token), avail });
    }
    return { minimaAvail, toks };
  }
  /** MINIMA = token ÷ price, rounded UP to the 6-decimal grain: the engine's own create rule, and the argument it is given (the old panel's derive) */
  const derive = (u, p) => Math.ceil((u / p) * 1e6) / 1e6;
  /** The priced form's lines (the old panel's update): the price, what you have, what the amount needs, and why it cannot go. */
  function createInfo(t, minimaAvail, price, source, uRaw) {
    const p = parseFloat(price); if (!(p > 0)) return { lines: [I18N.t("Fetching the MINIMA price…")], ok: false };
    const cap = Math.min(minimaAvail * p, t.avail), L = [I18N.t("Price: {price} {name} per MINIMA ({source})", { price: cut(price, 8), name: t.name, source: source }), I18N.t("You have: {minimaAvail} MINIMA · {avail} {name}", { minimaAvail: cut(String(minimaAvail), 6), avail: cut(String(t.avail), 6), name: t.name })];
    if (!amountOk(uRaw)) { L.push(I18N.t("Enter the {name} amount to provide (max ≈ {cap}).", { name: t.name, cap: cut(cap.toFixed(9), 6) })); return { lines: L, ok: false }; }
    const u = parseFloat(uRaw), minima = derive(u, p);
    L.push(I18N.t("MINIMA required:  {minima}", { minima: minima }), I18N.t("Total pool value:  ≈ US$ {u}", { u: cut((u * 2).toFixed(9), 2) }));
    if (minima > minimaAvail) L.push(I18N.t("⚠ Not enough MINIMA: reduce {name} to {cap} or less.", { name: t.name, cap: cut(cap.toFixed(9), 6) }));
    if (u > t.avail) L.push(I18N.t("⚠ You only have {avail} {name}.", { avail: cut(String(t.avail), 6), name: t.name }));
    return { lines: L, ok: minima <= minimaAvail && u <= t.avail, minima };
  }
  const BEFORE_CREATE = [L_("This app and its node must run regularly.\n\nYour pool's reserve coins have to be recreated about every 900 blocks, roughly twice a day. PandaPools does that by itself while the app and the node run. If it cannot, other wallets stop finding your pool, and after about 1700 blocks its coins drop out of the chain's recent window and can only be recovered through a MegaMMR archive."),
    L_("Save the backup and keep your wallet seed safe.\n\nRight after the pool is created you are asked to save one encrypted file with your pools and this node's backup. Until it is saved and checked, another pool cannot be created or migrated. Keep it off this device.")];
  const CREATE_ACK = L_("I understand: I must keep this app running, save the backup and keep my wallet seed safe.");
  const MANUAL_WARN = (name) => I18N.t("No market price is available (MEXC is unreachable and there are no live MINIMA / {name} pools to match). You are setting the OPENING PRICE yourself: set it to the true market rate, or arbitrageurs will correct it at your expense.", { name: name });
  const MANUAL_ACK = L_("I understand I'm setting the opening price with no market to check it against.");

  // ---- backup, restore, recovery (CombinedBackupUi.java, MyLpView.showRecoveryMenu; the old panel's dialogs) ----
  /** Why a backup password is not taken ("" = it is): the old panel's rule, at least 12 characters, at most 1024 bytes, typed twice. */
  const backupProblem = (pass, again) => (Array.from(String(pass)).length < 12 || new TextEncoder().encode(String(pass)).length > 1024 || pass !== again ? I18N.t("Use at least 12 characters and enter the same password twice. Nothing was saved.") : "");
  /** A backup or restore refusal without its internal code: the sentence after the code, or plain words for a bare code. */
  function plainCode(raw) {
    raw = bare(raw);
    if (/BACKUP_NOT_VERIFIED/.test(raw)) return I18N.t("The file that was written is not the same as the backup that was made, so it does not count as saved. Save it again in another place.");
    if (/BACKUP_TOO_LARGE/.test(raw)) return I18N.t("That file is too large to be a PandaPools backup. Nothing was read from it.");
    if (/NODE_EXPORT_NOT_VERIFIED/.test(raw)) return I18N.t("The node backup that was written is not the same as the one in the file, so do not use it. Extract it again to another place.");
    const m = /^[A-Z][A-Z0-9_]{3,}:\s*(.+)$/.exec(raw);
    return mx(m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : raw) || I18N.t("No reason was given.");
  }
  const BACKUP_INTRO = L_("Save one file containing your pools and the native node backup, including wallet keys. Use at least 12 characters, ideally random words. Keep the password safe; there is no password reset. The saved file is checked before another pool can be created.");
  const RESTORE_INTRO = L_("Restore public pool recipes and verify reserves on this node. Expired proofs need a synced MegaMMR archive. Owner signing stays paused until you confirm current wallet signing state.");
  const NODE_EXTRACTED = L_("Node backup saved. Restore this .bak through MinimaCore's node restore flow, using the password below. Then reopen the combined file to recover the pool recipes. An old backup still requires verification of current signing state.");
  const ARCHIVE_INTRO = L_("Optional public HTTPS MegaMMR RPC endpoint for current proofs. Your node verifies every proof. Leave empty for local MegaMMR or backup proofs.");
  const GUIDE = L_("Keep the latest complete MinimaCore wallet backup and this pool recipe. Proofs expire. A seed or recipe alone is insufficient.\n\nSaved recipes identify pools even when a light node no longer sees their coins. Restore verifies local reserves, then backup proofs, then current proofs from a synced MegaMMR archive. Missing reserves remain visible and are never reported as recovered.\n\nRestore does not regenerate keys or estimate past signature use. Confirm signing only with current complete wallet state and no other signing copies. Keep-fresh requires the app and node to remain running; it cannot guarantee availability while offline.");

  /** What is said when the backup dialog ends. got: the save's result { path }, null (closed before anything was started),
   *  or { pending: true } (closed with Esc or Close WHILE "Create and save" was still working: the save may still
   *  complete, so "not saved" would not be true; 0.18.139). */
  function backupEnd(got, forced) {
    if (got && got.pending) return { kind: "note", text: I18N.t("The backup dialog was closed while the backup was still being made, so it is not known yet whether it was saved. If a file was written and checked, the \"backup required\" notice in My LP goes away by itself. If the notice is still there in a minute, use Back up now.") };
    if (!got) return forced ? { kind: "note", text: I18N.t("The backup was not saved. Your pool is not affected, but another pool cannot be created or migrated until the backup is saved: use Back up now.") } : null;
    return { kind: "note", text: I18N.t("Encrypted pool and node backup saved and checked. Keep the file off this device, with its password.{path}", { path: (got.path ? (" " + I18N.t("Saved as {path}", { path: got.path })) : "") }) };
  }
  /** An error as the bridge gives it, without the bridge's own wrapping. */
  const bare = (e) => String((e && e.message) || e || "").replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
  /** The glue's own words when a call got no answer in time (main/pandapools.js NO_ANSWER and its kin): said as they are.
   *  Whether the thing was done is then NOT KNOWN, so it is never reworded as "failed", "was not" or "could not". "" = another error. */
  const noAnswer = (e) => (/gave no answer in time/.test(bare(e)) ? bare(e) : "");
  /**
   * A failed action in the alert's three parts: what happened, whether funds moved, what to do. The engine reports
   * fixed sentences; the ones a reader cannot act on are said in plain words, with the node's own answer beside them
   * (node = ppWhy(): the node's last refusal of a pool command, used only when it came after `since`).
   */
  /** sentNothing: the engine already knows nothing was sent (a failed Activity row): the last sentence says so instead of
   *  pointing at Activity. Chosen here, never by cutting words out of a (translated) sentence. */
  /** The engine's write guard (main/pandapools/runtime-guard.js) refused before anything reached the node (its code at the
   *  start of the error; main/pandapools.js keeps it as ppWhy() with guard: true): said in plain words. "" = not the guard. 0.19.377 */
  function guardText(s) {
    s = String(s || "");
    if (/WALLET_LOCKED/.test(s)) return I18N.t("This node's wallet is locked: unlock it and try again. Nothing was sent.");
    if (/MODE_UNAVAILABLE/.test(s)) return I18N.t("PandaPools could not check the node's write permission, so nothing was sent.");
    if (/WRITE_REQUIRED/.test(s)) return I18N.t("PandaPools may not write on this node, so nothing was sent.");
    return "";
  }
  function failText(what, raw, node, since, sentNothing) {
    raw = bare(raw);
    const fresh = node && node.error && Number(node.at) >= Number(since || 0);
    const guard = guardText(raw) || (fresh && node.guard ? guardText(node.error) : "");
    if (guard) return guard;   // the engine's own sentence ("could not get a payout address") is about a command that was never sent
    const said = fresh && !node.guard ? (" " + I18N.t("The node's last answer while this ran (its \"")) + node.verb + "\" command): " + mx(node.error).replace(/[.\s]+$/, "") + "." : "";
    if (/BACKUP_REQUIRED/.test(raw)) return I18N.t("{what} was not done and no funds moved. Before another pool can be created or migrated, the encrypted backup of your pools and this node must be saved and checked. Open My LP, choose Back up / restore pools, save the backup, then try again.", { what: what });
    if (/could not mint an owner key/i.test(raw)) return I18N.t("{what} was not done and no funds moved: the node did not make the new key that would own the pool.{said} Check that the node is running and in sync, then try again.", { what: what, said: said });
    if (/Could not identify the input signing key/i.test(raw)) return I18N.t("{what} was not done and nothing was signed: the node could not say which key signs one of the coins it would spend.{said} Wait until the node has caught up with the chain, then try again.", { what: what, said: said });
    if (/quote expired/i.test(raw)) return I18N.t("{what} was not sent and no funds moved: the quote was too old. Enter the amount again for a fresh one.", { what: what });
    if (/timed out/i.test(raw)) return I18N.t("It is not known whether this was sent: no answer came in time.{said} Look at Activity and at your balance before trying again, and do not repeat it until you have.", { said: said });
    const v = mx(raw).replace(/[.\s]+$/, "") || I18N.t("no reason was given");
    return sentNothing ? I18N.t("{what} did not go through: {v}.{said} Nothing was sent and no funds moved.", { what: what, v: v, said: said })
      : I18N.t("{what} did not go through: {v}.{said} Look at Activity: if no new line is there, nothing was sent and no funds moved.", { what: what, v: v, said: said });
  }

  // ======================================================================== Act: the money actions, no DOM
  async function create(api, ui, t, x, y) {
    const since = Date.now();
    try { const r = await api.ppCreate(t.tokenid, t.dec, x, y); ui.say(I18N.t("Pool submitted: {x} MINIMA + {y} {name}. It is confirming on-chain (usually 1 to 3 blocks) and appears in My LP by itself: do not submit it again. Now save the backup.", { x: x, y: y, name: t.name }), "note"); return r || {}; }
    catch (e) { ui.say(await why(api, I18N.t("Creating the pool"), e, since), "error"); return { err: bare(e) }; }
  }
  // ui = { confirm(title, text, okLabel) → Promise<bool>, say(text, kind) }. Every function here makes the SAME
  // window.mcd calls, with the same arguments, behind the same guards, in the same order, as renderer/pools.js.
  /** why a call failed, with the node's own last answer when it came during the call */
  async function why(api, what, e, since) { const node = await Promise.resolve().then(() => api.ppWhy()).catch(() => null); return failText(what, e, node, since); }
  const Act = {
    /** ppQuote at the click (the exact route that will be posted, frozen) → confirm → ppSwap(that quote's id). */
    async swap(api, ui, t, dir, amt) {
      if (!t) { ui.say(I18N.t("Pick a pool first. Nothing was sent."), "note"); return null; }
      if (!amountOk(amt)) { ui.say(I18N.t("Enter an amount. Nothing was sent."), "note"); return null; }
      const q = await api.ppQuote(t.tok, dir, amt).catch(() => ({ ok: false }));
      if (!q || !q.ok || !q.quoteId) { ui.say(q && q.notReady ? I18N.t("PandaPools is still starting. Nothing was sent: try again in a moment.") : I18N.t("That trade is too large for these pools. Nothing was sent: try a smaller amount."), "note"); return null; }
      const rv = swapReview(q, amt, t, dir);
      if (!await ui.confirm(rv.title, rv.text, rv.ok)) return null;
      const since = Date.now();
      try {
        const r = await api.ppSwap(q.quoteId);
        ui.say(I18N.t("Swap submitted: you pay {amt} {name} and receive {totalOut} {name2} when a block confirms it. It is not final yet: follow it in Activity. Transaction {txpowid}", { amt: whole((r && r.totalIn) || q.totalIn || amt), name: (dir ? "MINIMA" : t.name), totalOut: whole(r && r.totalOut), name2: (dir ? t.name : "MINIMA"), txpowid: ((r && r.txpowid) || "not reported") }), "note");
        return r || {};
      } catch (e) { ui.say(await why(api, I18N.t("The swap"), e, since), "error"); return { err: bare(e) }; }
    },
    /**
     * Add liquidity. The engine takes ONE figure, the MINIMA to add, and works the token side out itself from the pool's
     * live ratio when it posts (poolmgr.js deposit); a typed token amount was never used. So: one MINIMA amount, above
     * zero (refused here, before the question); the review states both sides, the token side as the estimate it is;
     * ppDeposit(address, MINIMA, that estimate), the engine's own call; and the result says what the engine took
     * (r.minima, r.token from the glue), never what was typed.
     */
    async deposit(api, ui, p, a) {
      const name = tokLabel(p.tok, p.tokName), est = amountOk(a) ? depositToken(p, a) : null;
      if (!amountOk(a)) { ui.say(I18N.t("Enter the MINIMA amount to add, above zero. Nothing was sent."), "note"); return null; }
      if (est == null) { ui.say(I18N.t("The pool's reserves are not known just now, so the {name} that goes with {a} MINIMA cannot be shown. Nothing was sent: try again in a moment.", { name: name, a: a }), "note"); return null; }
      if (!await ui.confirm(I18N.t("Add liquidity?"), I18N.t("Add {a} MINIMA and about {est} {name} to the pool.\n\n{name2} is taken at the pool's ratio when the transaction is posted, so this figure can change slightly.\n\nPool pair: {name3}\nPool: {address}\n\nThis posts an on-chain transaction and cannot be undone. The amounts stay yours inside the pool.", { a: a, est: est, name: name, name2: name, name3: pairName({ tok: p.tok, name }), address: p.address }), "Add")) return null;
      const since = Date.now();
      try {
        const r = await api.ppDeposit(p.address, a, est);
        ui.say(I18N.t("Liquidity sent to the pool: {name}. It counts once a block confirms it: follow it in Activity.", { name: (r && r.minima && r.token ? I18N.t("{minima} MINIMA and {token} {name}, the amounts the pool took at its ratio", { minima: whole(r.minima), token: whole(r.token), name: name }) : I18N.t("{a} MINIMA and the {name} that goes with it at the pool's ratio (the exact figure is in Activity)", { a: a, name: name })) }), "note"); return r || {};
      } catch (e) { ui.say(await why(api, I18N.t("Adding liquidity"), e, since), "error"); return { err: bare(e) }; }
    },
    /** Close a pool and take all its liquidity out: confirm → ppClose(address). */
    async withdraw(api, ui, p) {
      const name = tokLabel(p.tok, p.tokName);
      if (!await ui.confirm(I18N.t("Withdraw all liquidity?"), I18N.t("This closes the {name} pool and sweeps its reserves ({reserveM} MINIMA + {reserveT} {name2}, earned fees included) {closetoowner}\n\nPool: {address}", { name: pairName({ tok: p.tok, name }), reserveM: whole(p.reserveM), reserveT: whole(p.reserveT), name2: name, closetoowner: CLOSE_TO_OWNER, address: p.address }), "Withdraw")) return null;
      const since = Date.now();
      try { const r = await api.ppClose(p.address); ui.say(I18N.t("The pool is closing. Its reserves go {closetoowner}", { closetoowner: CLOSE_TO_OWNER }), "note"); return r || {}; }
      catch (e) { ui.say(await why(api, I18N.t("Closing the pool"), e, since), "error"); return { err: bare(e) }; }
    },
    /** Collect to wallet: confirm → ppCollect(). */
    async collect(api, ui) {
      if (!await ui.confirm(I18N.t("Collect to wallet?"), I18N.t("Move any withdrawn or migrated reserves from your pool owner addresses into this node's wallet."), "Collect")) return null;
      const since = Date.now();
      try {
        const r = await api.ppCollect(), skipped = r && r.foreign ? (" " + I18N.t("{foreign}{foreign2} paused or not in this wallet, so {foreign3} funds were left where they are: confirm the wallet signing state on the pool's card.", { foreign: plural(r.foreign, "owner key"), foreign2: (" " + I18N.t(r.foreign === 1 ? "is" : "are")), foreign3: I18N.t(r.foreign === 1 ? "its" : "their") })) : "";
        ui.say((r && r.coins ? I18N.t("Collection sent: {coins} on the way to your wallet. It is final when a block confirms it.", { coins: plural(r.coins, "coin") }) : I18N.t("There was nothing to collect right now. No funds moved.")) + skipped, r && r.foreign ? "error" : "note"); return r || {};
      } catch (e) { ui.say(await why(api, I18N.t("The collection"), e, since), "error"); return { err: bare(e) }; }
    },
    /** "Collect now" on a withdrawn-funds card: ppCollect() at once, as the old card's button. */
    async collectNow(api, ui) {
      const since = Date.now();
      try {
        const r = await api.ppCollect();
        ui.say(r.cleared ? I18N.t("The withdrawn funds were moved to your wallet.") : r.stranded ? I18N.t("The funds were not moved: this wallet cannot sign for that payout address. See the card for what is needed.") : I18N.t("Not moved yet: the withdrawn coins are not spendable yet. PandaPools keeps trying by itself."), r.stranded ? "error" : "note"); return r;
      } catch (e) { ui.say(await why(api, I18N.t("The collection"), e, since), "error"); return { err: bare(e) }; }
    },
    /** Check for reserves: ppRecoverSaved(address), then its result. Nothing is signed. */
    async recover(api, ui, address) {
      try { const r = await api.ppRecoverSaved(address); await ui.show(I18N.t("Recovery result"), mx(recoveryResult(r))); return r; }
      catch (e) { ui.say(noAnswer(e) || I18N.t("The reserves could not be checked: {e}. Nothing was signed and nothing was changed.", { e: mx(bare(e)) }), "error"); return null; }
    },
    /** Put a closed pool away: ppRetirePool(address, true). Hidden, never deleted. */
    async retire(api, ui, address) {
      try { await api.ppRetirePool(address, true); ui.say(I18N.t("Put away. The recipe is still saved and still goes into your backups."), "note"); return true; }
      catch (e) { ui.say(noAnswer(e) || I18N.t("The pool was not put away: {e}.", { e: mx(bare(e)) }), "error"); return false; }
    },
    /** Bring back: ppRetirePool(address, false) for each closed pool. */
    async unretire(api, ui, retired) {
      try { for (const r of retired) await api.ppRetirePool(r.address, false); ui.say(I18N.t("Closed pools are showing again."), "note"); return true; }
      catch (e) { ui.say(noAnswer(e) || I18N.t("Not every closed pool was brought back: {e}.", { e: mx(bare(e)) }), "error"); return false; }
    },
    /** Confirm wallet signing state: the warning, then ppConfirmSigning(owner key, true). */
    async confirmSigning(api, ui, opk) {
      if (!await ui.confirm(I18N.t("Confirm current wallet signing state"), I18N.t("Confirm only if this node has the latest complete MinimaCore wallet backup, including signing counters, and every other copy has stopped signing. A seed or old backup is insufficient. This enables owner spending and automatic refresh for key:\n{opk}", { opk: opk }), I18N.t("I confirm current wallet state"))) return null;
      try { const ok = await api.ppConfirmSigning(opk, true); ui.say(ok ? I18N.t("Confirmation saved. Owner signing is enabled for this pool.") : I18N.t("Not confirmed: signing stays paused. The owner key is missing, used up or below a recorded count."), ok ? "note" : "error"); return ok; }
      catch (e) { ui.say(noAnswer(e) || I18N.t("Not confirmed: {e}. Signing stays paused.", { e: mx(bare(e)) }), "error"); return null; }
    },
    // ---- create and migrate ----
    /** Step 1 of create reads what the old panel read, in its order: balance, the market-fed token, then the price anchor.
     *  { none: true } = no MxUSD to pool; else { t, minimaAvail, anchor } (anchor null = no market price: the manual form). */
    async createOpen(api, tryCmd) {
      const bal = (await tryCmd("balance")) || []; let usdt = "";
      try { const mt = await api.ppMarketToken(); usdt = (mt && mt.usdt) || ""; } catch (e) {}
      const c = createTokens(bal, usdt); if (!c.toks.length) return { none: true };
      let a = null; try { a = await api.ppCreateAnchor(); } catch (e) {}
      return { t: c.toks[0], minimaAvail: c.minimaAvail, anchor: a && a.price ? { price: a.price, source: a.source || "market", at: Number(a.at) || Date.now() } : null };
    },
    /**
     * At Review (0.18.138): the price and the balances the form was opened with are READ AGAIN, by the same reads
     * (createOpen). The form used to keep them for as long as it stayed open, across tabs and rooms, and hours later
     * the review still said "matches MEXC market": the pool then opened off the market and was arbitraged at its
     * owner's cost. had = the form's { anchor } (anchor null = the manual form). Returns { bad } (nothing may be
     * sent), or { fresh, moved, text }: moved = the price differs, or a market price has appeared or gone; then the
     * old and the new are said and the user must review again. Never a review from the old read.
     */
    async createRefresh(api, tryCmd, had, now) {
      const o = await Act.createOpen(api, tryCmd), was = had && had.anchor, is = o.anchor;
      if (o.none) return { bad: I18N.t("Your wallet no longer holds sendable MxUSD, so the pool cannot be created. Nothing was sent.") };
      const per = (a) => I18N.t("{price} {name} per MINIMA ({source})", { price: cut(a.price, 8), name: o.t.name, source: a.source }), age = was ? since(was.at, now || Date.now()) : "";
      if (was && !is) return { bad: I18N.t("The market price could not be read again just now, so the opening price of {was}, read {age}, cannot be checked. Nothing was sent: press Review again in a moment.", { was: per(was), age: age }) };
      if (!was && !is) return { fresh: o, moved: false, text: "" };
      if (!was) return { fresh: o, moved: true, text: I18N.t("A market price can be read now: {is}. The pool opens at that price, so you no longer set it yourself. Enter the amount and review again. Nothing was sent.", { is: per(is) }) };
      const a = C.dec(was.price), b = C.dec(is.price), moved = !a || !b || C.cmp(a, b) !== 0 || was.source !== is.source;
      return { fresh: o, moved, text: moved ? I18N.t("The price changed since it was read {age}: it was {was}, it is now {is}. The MINIMA needed was worked out again at the new price. Check the figures and press Review again. Nothing was sent.", { age: age, was: per(was), is: per(is) }) : "" };
    },
    /** The priced form's Create: the same checks, the same question, then ppCreate(token id, decimals, String(MINIMA derived), the amount as typed). */
    async createPriced(api, ui, t, minimaAvail, price, source, uStr) {
      const p = parseFloat(price);
      if (!(p > 0)) { ui.say(I18N.t("There is no price yet. Refresh the price and try again. Nothing was sent."), "note"); return null; }
      source = String(source || "market");
      if (!amountOk(uStr)) { ui.say(I18N.t("Enter the {name} amount (a positive number). Nothing was sent.", { name: t.name }), "note"); return null; }
      const u = parseFloat(uStr), minima = derive(u, p);
      if (minima > minimaAvail || u > t.avail) { ui.say(I18N.t("Not enough balance for that amount. Nothing was sent."), "note"); return null; }
      if (!await ui.confirm(I18N.t("Create this pool?"), I18N.t("MINIMA / {name} pool\n\n{minima} MINIMA  +  {uStr} {name2}\nOpens at {price} {name3} per MINIMA  (matches {source})\n\nThe 0.5% swap fee goes to liquidity providers. This posts an on-chain transaction; you can withdraw the liquidity later as the pool's owner.", { name: t.name, minima: minima, uStr: uStr, name2: t.name, price: cut(price, 8), name3: t.name, source: source }), "Create")) return null;
      return create(api, ui, t, String(minima), uStr);
    },
    /** The manual form (no market price): both amounts, the acknowledgement, ppCreatePreview, the question, then ppCreate(token id, decimals, x, y). */
    async createManual(api, ui, t, x0, y0, ack) {
      if (!amountOk(x0) || !amountOk(y0)) { ui.say(I18N.t("Enter both reserves (positive numbers). Nothing was sent."), "note"); return null; }
      if (!ack) { ui.say(I18N.t("Tick the box to confirm you are setting the opening price. Nothing was sent."), "note"); return null; }
      const pv = await api.ppCreatePreview(t.dec, x0, y0).catch(() => ({ ok: false }));
      const line = pv && pv.ok ? (I18N.t("⚠ No market price available: YOU are setting the opening price at {price} {name} per MINIMA.", { price: cut(pv.price, 8), name: t.name }) + "\n") : "";
      if (!await ui.confirm(I18N.t("Create MINIMA / {name} pool?", { name: t.name }), I18N.t("{x0} MINIMA  +  {y0} {name}\n{line}\nThe 0.5% swap fee goes to liquidity providers. This posts an on-chain transaction; you can withdraw the liquidity later as the pool's owner.", { x0: x0, y0: y0, name: t.name, line: line }), "Create")) return null;
      return create(api, ui, t, x0, y0);
    },
    /** Migrate (the old panel's sheet): both new reserves, the question, then ppMigrate(address, a, b). */
    async migrate(api, ui, p, a, b) {
      const name = tokLabel(p.tok, p.tokName);
      if (!amountOk(a) || !amountOk(b)) { ui.say(I18N.t("Enter both new reserves. Nothing was sent."), "note"); return null; }
      if (!await ui.confirm(I18N.t("Migrate this pool?"), I18N.t("A new pool opens at a fresh address with {a} MINIMA / {b} {name}, taken from your wallet. The old pool's reserves go to its owner address on this node; PandaPools then moves them into your wallet by itself, or use Collect withdrawn funds.\n\nOld pool: {address}", { a: a, b: b, name: name, address: p.address }), "Migrate")) return null;
      const since = Date.now();
      try { const r = await api.ppMigrate(p.address, a, b); ui.say(I18N.t("Migration sent: the new pool is confirming on-chain and the old reserves are on their way back. Follow it in Activity. Now save the backup: it must cover the new pool."), "note"); return r || {}; }
      catch (e) { ui.say(await why(api, I18N.t("Migrating the pool"), e, since), "error"); return { err: bare(e) }; }
    },
    // ---- backup, restore, recovery: each returns { bad } (why nothing was done, for the dialog) or its result ----
    /** Create and save: the password rule, then ppSaveBackup(password). */
    async backup(api, pass, again) {
      const bad = backupProblem(pass, again); if (bad) return { bad };
      try { const r = await api.ppSaveBackup(pass); return r && r.canceled ? { bad: I18N.t("Save cancelled. No file was written, and the backup is still required.") } : { path: (r && r.path) || "" }; }
      catch (e) { return { bad: I18N.t("The backup was not saved: {e} Try again.", { e: plainCode(e) }) }; }
    },
    /** Load file: ppLoadBackup(password) → the pool recipes as text. null = the file picker was closed. */
    async loadFile(api, pass) {
      try { const f = await api.ppLoadBackup(pass); return f && f.error ? { bad: plainCode(f.error) } : !f || f.canceled ? null : { json: f.json || "" }; }
      catch (e) { return { bad: I18N.t("The backup could not be read: {e} Nothing was restored.", { e: plainCode(e) }) }; }
    },
    /** Extract node backup: ppLoadBackup(password, true) → where the .bak was written and its password. */
    async extractNode(api, pass) {
      try { const r = await api.ppLoadBackup(pass, true); return !r || r.canceled ? null : { nodePassword: r.nodePassword, path: r.path || "" }; }
      catch (e) { return { bad: I18N.t("The node backup was not extracted: {e}", { e: plainCode(e) }) }; }
    },
    /** Restore: ppRestore(the recipes text). A reserve check only: nothing is signed. */
    async restore(api, json) {
      json = String(json || "").trim(); if (!json) return { bad: I18N.t("Paste a backup, or load a file. Nothing was restored.") };
      try { const r = await api.ppRestore(json); return { text: mx(recoveryResult(r)), all: r.restored === r.total && !!r.total }; }
      catch (e) { return { bad: I18N.t("The restore did not finish: {e} Nothing was signed.", { e: plainCode(e) }) }; }
    },
    async archiveGet(api) { return api.ppArchiveSettings(); },
    async archiveSave(api, url) {
      try { return (await api.ppArchiveSettings(url)) ? {} : { bad: I18N.t("Not saved. Use a public HTTPS hostname without credentials, query or fragment.") }; }
      catch (e) { return { bad: I18N.t("Not saved: {e}", { e: plainCode(e) }) }; }
    },
    /** Export statement: ppStatement() (it tops up the history first) → exportCsv(csv, "pandapools-statement.csv"). */
    async statement(api, ui) {
      let r; try { r = await api.ppStatement(); } catch (e) { ui.say(noAnswer(e) || I18N.t("The statement was not built: {e}. No file was written.", { e: mx(bare(e)) }), "error"); return null; }
      if (!r || !r.pools) { ui.say(I18N.t("There are no pools to report on yet. No file was written."), "note"); return null; }
      const path = await api.exportCsv(r.csv, "pandapools-statement.csv");
      ui.say(!path ? I18N.t("Export cancelled. No file was written.") : r.backfilled ? I18N.t("Statement saved: {pools}, {rows}.", { pools: plural(r.pools, "pool"), rows: plural(r.rows, "transaction") }) : I18N.t("Statement saved, but the history is still being read from the node ({rows} transactions so far): the file says so. Export again later for the full statement.", { rows: r.rows }), "note");
      return path;
    }
  };

  const core = { ACT_NAME, when, since, swapSummary, actItem, feedItem, walletCard, nodeCheck, STEPS, safeDec, createTokens, derive, createInfo, backupProblem, plainCode, cutNum, MIGRATE_AT, needsMigrate, lpSummary, lpRows, depositToken, poolIds, recoveryResult, MINIMA, MXUSD, isMxusd, tokLabel, pairName, skeleton, imitates, IMITATES, chosen, NONE, lostLine, mx, cut, whole, amountOk, plural, pairs, poolLine, sendable, balanceLine, marketLine, quoteRows, swapReview, poolsSummary, poolCard, combinedCard, bare, noAnswer, guardText, failText, whereConfirm, backupEnd };
  if (typeof document === "undefined") return Object.assign({ Act }, core);

  // ======================================================================== the screens
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let D = null;   // deps from app.js: api, tryCmd, running(), dialog, money, go(tab), start(), where()
  const S = { tab: "", at: 0, st: null, said: null, pools: null, sel: "", dir: true, bal: null, info: null, market: null, acts: null, qseq: 0, combined: false, agg: null, mine: null, mineErr: "", retired: [], collect: [], backupDue: false, create: null, addr: "", balAt: 0, feed: null, all: false, shownA: 60, shownF: 60, sharedAt: 0 };
  const api = () => D.api;
  const body = () => $("dxPpBody");
  const visible = (tab) => { const b = body(), w = D.where(); return !!b && w.shown && w.room === "pools" && b.dataset.tab === (tab || S.tab); };
  const typing = () => { const a = document.activeElement, b = body(); return !!(a && b && b.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  const say = (text, kind) => { S.said = text ? { text, kind: kind || "error" } : null; paint(); };
  const ui = { confirm: (title, text, ok) => D.dialog(title, text, ok), show: (title, text) => D.dialog(title, text, ""), say };
  const up = () => D.running() && !!(S.st && S.st.ready);
  const toks = () => pairs(S.pools), pair = () => chosen(toks(), S.sel).t;

  // ---- reads: each screen asks for what it shows ----
  async function load(tab) {
    S.at = Date.now();
    S.st = await api().ppStatus().catch(() => null);
    if (!up()) return;
    const want = { pools: () => api().ppPools(), acts: () => api().ppActivity() };
    if (tab === "swap") { want.bal = () => D.tryCmd("balance"); want.market = () => api().ppMarket(); }
    if (tab === "wallet") { want.bal = () => D.tryCmd("balance").then((b) => { if (b) S.balAt = Date.now(); return b; }); if (!S.addr) want.addr = () => D.tryCmd("getaddress").then((r) => (r && (r.miniaddress || r.address)) || ""); }
    if (tab === "activity") want.feed = () => api().ppFeed();
    if (tab === "pools" && S.combined) want.agg = () => api().ppAggregate();
    if (tab === "mylp") { want.retired = () => api().ppListRetired(); want.collect = () => api().ppPendingCollect(); want.backupDue = () => api().ppCompleteBackupRequired().catch(() => true); }   // unknown counts as due, as in the old panel
    const keys = Object.keys(want), got = await Promise.allSettled(keys.map((k) => want[k]()));
    keys.forEach((k, i) => { if (got[i].status === "fulfilled" && got[i].value != null) S[k] = got[i].value; });
    if (S.pools && chosen(toks(), S.sel).lost) { S.lost = S.sel; S.sel = NONE; S.info = null; S.q = null; S.qseq++; }   // the selected token left the registry: nothing is selected, and it is said
    if (tab === "mylp") await api().ppMyPools().then((m) => { S.mine = m || []; S.mineErr = ""; }, (e) => { S.mineErr = bare(e); });   // a read that fails is said, never shown as "no pools"
    if (tab === "swap" && pair()) S.info = await api().ppPairInfo(pair().tok).catch(() => S.info);
  }
  /** the engine's scans say "update": passive parts only, never under someone typing (the old panel's "frozen tab" rule) */
  function onUpdate() { if (S.upd || !D) return; S.upd = setTimeout(() => { S.upd = null; const w = D.where(); if (visible()) load(S.tab).then(() => { paint(); if (S.tab === "swap" && $("ppAmt") && !C.gate.on) requote(); }, paint); else if (w.shown && w.shared && (w.tab === "activity" || w.tab === "history")) shared(true); }, 400); }
  function tick() { if (D && visible() && !typing() && !C.gate.on && Date.now() - S.at > 60000) load(S.tab).then(paint, paint); }
  function reset() { Object.assign(S, { at: 0, st: null, said: null, pools: null, sel: "", lost: "", dir: true, bal: null, info: null, market: null, acts: null, mine: null, mineErr: "", retired: [], collect: [], agg: null, create: null, addr: "", balAt: 0, feed: null, shownA: 60, shownF: 60, sharedAt: 0 }); S.qseq++; const b = body(); if (b) { b.innerHTML = ""; delete b.dataset.tab; } }

  /** what stands above every screen of the room: the node, the engine, the last thing said */
  function banners() {
    const out = [];
    if (!D.running()) out.push(`<div class="dx-state" role="status">${th("The node is stopped, so nothing here can trade and your pools are not being kept fresh. Start it and PandaPools comes back by itself.")} <button class="dx-btn pp-inline" data-ppstart="1">${th("Start the node")}</button></div>`);
    else if (!S.st) out.push(`<div class="dx-state dx-state--note" role="status">${th("PandaPools could not be read just now. Nothing is lost: this screen tries again by itself.")}</div>`);
    else if (!S.st.ready && S.st.error) out.push(`<div class="dx-state dx-state--error" role="alert">${esc(C.storeError("PandaPools", "pool store", S.st.error, PP_AFTER))} <button class="dx-btn pp-inline" data-ppaside="1"${C.gate.on ? " disabled" : ""}>${th("Set the store aside and start empty")}</button></div>`);
    else if (!S.st.ready) out.push(`<div class="dx-state dx-state--note" role="status">${th("PandaPools is starting: it opens its saved pools and reads the pool registry from the node. Nothing can be sent yet.")}</div>`);
    else if (S.st.paused) out.push(`<div class="dx-state dx-state--error" role="alert">${/WALLET_LOCKED/.test(S.st.paused) ? th("PandaPools is paused: this node's wallet is locked, so your pools are not being kept fresh. Unlock the wallet and it goes on by itself.") : th("PandaPools is paused ({why}), so your pools are not being kept fresh. It tries again at every block.", { why: S.st.paused })}</div>`);   // the engine's guard stopped its background service (main/pandapools.js setPaused)
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  const PP_AFTER = L_("Then restore your pools from your backup file: My LP, Back up / restore pools, Restore pools from a file. Your pools on the chain are not touched meanwhile, but they are not kept fresh until PandaPools knows them again.");
  /** The store that cannot be opened is moved aside (main: mcd:engineSetAside, refused unless the engine's last start failed). */
  async function setAside() {
    if (!await D.dialog(I18N.t("Set the pool store aside?"), C.SET_ASIDE("PandaPools", PP_AFTER, S.st.store), I18N.t("Set it aside"))) return;
    try { const kept = await api().engineSetAside("pandapools"); say(I18N.t("The pool store was set aside{kept}. PandaPools is starting with an empty store: restore your pools from your backup file (My LP, Back up / restore pools).{kept2}", { kept: (kept ? (" " + I18N.t("and is kept as {kept}", { kept: kept })) : ""), kept2: (kept ? " " + C.PUT_BACK(S.st.store, kept) : "") }), "note"); }
    catch (e) { say(I18N.t("The pool store was not set aside: {e}. Nothing was changed.", { e: bare(e) }), "error"); }
  }
  const kv = (k, v, cls) => `<div class="pp-kv"><span>${esc(k)}</span><span class="${cls || ""}">${v}</span></div>`;
  /** A pool operation as one line of the strip under Swap (SwapView.activityRow). */
  const tone = (a) => (a.failed ? "bad" : a.confirmed ? "ok" : "live");
  const recentRow = (a) => `<div class="pp-rrow"><span>${esc(a.type)} · ${esc(swapSummary(a))}</span><b data-tone="${tone(a)}">${esc(a.statusText || I18N.t("Waiting for node check"))}</b></div>`;

  // ---- Swap (SwapView.java) ----
  function swapSkeleton() {
    return `<div id="ppTop"></div>
      <div class="pp-line" id="ppPoolLine">${th("Finding pools…")}</div><div class="pp-line" id="ppBalLine"></div><div class="pp-line pp-line--gap" id="ppMktLine"></div>
      <label class="pp-pair" id="ppPairRow" hidden><span>${th("POOL")}</span><select class="dx-in" id="ppPair" aria-label="${th("Pool pair")}"></select></label>
      <div class="pp-panel"><label class="pp-panel__m"><span class="pp-fl">${th("YOU PAY")}</span><input class="pp-amt" id="ppAmt" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.0"></label><b class="pp-tok" id="ppFrom">MINIMA</b></div>
      <div class="pp-fliprow"><button class="pp-flip" id="ppFlip" aria-label="${th("Flip: swap the other way")}">⇅</button></div>
      <div class="pp-panel"><div class="pp-panel__m"><span class="pp-fl">${th("YOU RECEIVE (EST.)")}</span><div class="pp-amt" id="ppOut" aria-live="polite">0.0</div></div><b class="pp-tok" id="ppTo">MxUSD</b></div>
      <div class="pp-quote" id="ppQuote"></div>
      <button class="pp-cta" id="ppGo" disabled>${th("SWAP")}</button>
      <div class="pp-recent" id="ppRecent"></div>`;
  }
  const amt = () => ($("ppAmt") ? $("ppAmt").value.trim() : "");
  /** the live quote: last one asked wins (the old panel's ppQuoteSeq); the bump retires any quote still in flight */
  async function requote() {
    const t = pair(), a = amt(), q = $("ppQuote"), out = $("ppOut"); if (!q || !t) return;
    if (!amountOk(a)) { S.qseq++; S.q = null; q.innerHTML = ""; out.textContent = "0.0"; return paintGo(); }
    const seq = ++S.qseq, dir = S.dir, r = await api().ppQuote(t.tok, dir, a).catch(() => ({ ok: false }));
    if (seq !== S.qseq || !$("ppQuote")) return;   // a later keystroke already asked for a fresher quote, or the screen changed
    const rows = quoteRows(r, t, dir); S.q = rows.ok;
    $("ppOut").textContent = rows.out;
    $("ppQuote").innerHTML = rows.ok ? rows.rows.map((x) => kv(x[0], esc(x[1]))).join("") : `<div class="pp-warn">${esc(rows.note)}</div>`;
    paintGo();
  }
  const paintGo = () => { const b = $("ppGo"); if (b) { b.disabled = C.gate.on || !up() || !S.q; b.textContent = S.swapping ? "SWAPPING…" : I18N.t("SWAP"); } };
  function bindSwap() {
    $("ppAmt").oninput = () => { S.said = null; $("ppTop").innerHTML = banners(); requote(); };
    $("ppFlip").onclick = () => { S.dir = !S.dir; paintSwap(); requote(); };
    $("ppPair").onchange = () => { S.sel = $("ppPair").value || NONE; if (S.sel !== NONE) S.lost = ""; S.info = null; paintSwap(); requote(); load("swap").then(paint, paint); };
    $("ppGo").onclick = () => D.money(async () => {
      const t = pair(), dir = S.dir;   // the pair and the direction being confirmed, read once
      S.swapping = true; paintGo();
      const r = await Act.swap(api(), ui, t, dir, amt()).catch((e) => { say(failText(I18N.t("The swap"), e), "error"); return null; });
      S.swapping = false;
      if (r && !r.err && $("ppAmt")) { $("ppAmt").value = ""; S.q = null; S.qseq++; $("ppOut").textContent = "0.0"; $("ppQuote").innerHTML = ""; }
      paintGo(); load("swap").then(paint, paint);
    });
  }
  function paintSwap() {
    const t = pair(), list = toks();
    $("ppTop").innerHTML = banners();
    $("ppPairRow").hidden = list.length < 2 && S.sel !== NONE;
    if (!typing()) $("ppPair").innerHTML = (S.sel === NONE ? `<option value="" selected>${th("Pick a pair")}</option>` : "") + list.map((x) => `<option value="${esc(x.tok)}"${t && x.tok === t.tok ? " selected" : ""}>${esc(pairName(x))}</option>`).join("");
    $("ppPoolLine").textContent = !up() ? "" : !S.pools ? I18N.t("Finding pools…") : S.sel === NONE ? (S.lost ? lostLine(S.lost) : I18N.t("Pick a pair.")) : !t ? I18N.t("No live pools yet. Create one in My LP to seed liquidity.") : S.info ? poolLine(t, S.info) : pairName(t);
    $("ppBalLine").textContent = t && S.bal ? balanceLine(S.bal, t) : "";
    $("ppMktLine").textContent = t ? marketLine(t, S.market, S.pools) : "";
    $("ppFrom").textContent = S.dir ? "MINIMA" : t ? t.name : "token"; $("ppTo").textContent = S.dir ? (t ? t.name : "token") : "MINIMA";
    paintGo();
    const recent = (S.acts || []).filter((a) => a.type !== "STATUS").slice(0, 3);
    $("ppRecent").innerHTML = recent.length ? `<div class="dx-label">${th("RECENT ACTIVITY")}</div>${recent.map(recentRow).join("")}<button class="pp-link" data-ppgo="activity">${th("See all  →  Activity")}</button>` : "";
  }

  // ---- Pools (PoolsView.java): every pool of the shared registry, one by one or combined per token ----
  const noop = () => {};
  const poolsSkeleton = () => `<div id="ppTop"></div><div class="pp-sumrow"><span class="pp-line" id="ppSum"></span><button class="pp-scan" data-ppscan="1">${th("↻  SCAN")}</button></div>
      <div class="pp-chips" role="group" aria-label="${th("View")}"><button data-ppmode="indiv">${th("INDIVIDUAL")}</button><button data-ppmode="combined">${th("COMBINED")}</button></div><div id="ppList"></div>`;
  const cardHtml = (c) => `<div class="dx-card pp-card"><b class="pp-ct">${esc(c.title)}</b>${c.rows.map((r) => `<div class="pp-kv pp-kv--mono"${r[2] ? ` data-copy="${esc(r[2])}" title="Click to copy"` : ""}><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("")}</div>`;
  function paintPools() {
    $("ppTop").innerHTML = banners();
    $("ppSum").textContent = !up() ? "" : S.scanning ? I18N.t("Scanning the pool registry…") : S.pools ? poolsSummary(S.pools) : I18N.t("Scanning the pool registry…");
    body().querySelectorAll("[data-ppmode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ppmode === "combined") === S.combined)));
    const list = S.combined ? (S.agg || []).map(combinedCard) : (S.pools || []).map(poolCard);
    $("ppList").innerHTML = !up() || !S.pools || (S.combined && !S.agg) ? "" : list.length ? list.map(cardHtml).join("")
      : `<div class="pp-line">${S.combined ? th("No funded pools to combine yet.") : th("No live pools found in the registry yet. Create one in My LP to seed liquidity.")}</div>`;
  }
  async function scan() { if (S.scanning || !up()) return; S.scanning = true; paint(); await api().ppScan().catch(() => null); S.scanning = false; load(S.tab).then(paint, paint); }

  // ---- My LP (MyLpView.java): my pools, what they earned, and what I can do with them ----
  /** A dialog with its own fields. onOk(dialog) returns a string to refuse (shown, the dialog stays) or a value. */
  function form(title, html, okLabel, onOk, wire) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"); d.className = "dx-dlg pp-dlg";
      d.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="pp-bad" role="alert"></div><div class="dx-dlg__b"><button class="dx-btn" data-x="0">${th("Close")}</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
      let working = false, gone = false;   // closed while its action is still working: { pending: true }, never "nothing was done"
      const end = (v) => { if (gone) return; gone = true; d.close(); d.remove(); resolve(v); };
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-x]"); if (!b || b.disabled) return;
        if (b.dataset.x === "0") return end(working ? { pending: true } : null);
        b.disabled = true; working = true; const bad = await onOk(d); working = false; b.disabled = false;
        if (gone) return;
        if (typeof bad === "string" && bad) d.querySelector(".pp-bad").textContent = bad; else end(bad === undefined ? true : bad);
      });
      d.addEventListener("cancel", () => { if (gone) return; gone = true; d.remove(); resolve(working ? { pending: true } : null); });
      $("shell").appendChild(d); if (wire) wire(d); d.showModal();
    });
  }
  const fld = (label, name, ph, val) => `<label class="pp-fld"><b>${esc(label)}</b><input class="dx-in" name="${name}" inputmode="decimal" autocomplete="off" placeholder="${esc(ph || "0.0")}" value="${esc(val || "")}"></label>`;
  const val = (d, name) => d.querySelector(`[name=${name}]`).value.trim();
  const mylpSkeleton = () => `<div id="ppTop"></div><div id="ppLp"></div>`;
  const lpBtn = (label, attr, value, cls) => `<button class="dx-btn ${cls || ""}" data-${attr}="${esc(value)}"${C.gate.on ? " disabled" : ""}>${label}</button>`;
  function collectHtml() {
    return (S.collect || []).map((c) => { const stranded = c.status === "STRANDED"; return `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">${stranded ? th("Withdrawn funds cannot be moved from this address") : th("Withdrawn funds still being moved to your wallet")}</b>
      <div class="pp-note">${stranded ? th("This is the address your pool was closed to. PandaPools cannot move the funds because this wallet cannot sign for it: that address is not one of the 64 addresses a seed phrase rebuilds. Restore the matching complete MinimaCore wallet backup, then use Collect. A seed on its own will not do it.")
        : th("Your pool's withdrawal landed at its owner payout address and PandaPools is moving it into your wallet. It keeps trying in the background and stops only once the address is empty.")}</div>
      <div class="pp-ids" data-copy="${esc(c.oadr)}" title="${th("Click to copy")}">${th("Payout address:")} ${esc(c.oadr)}</div>${c.lastError ? `<div class="pp-note">${esc(mx(c.lastError))}</div>` : ""}
      <div class="pp-acts">${lpBtn(stranded ? I18N.t("Try again") : I18N.t("Collect now"), "ppcollectnow", "1")}</div></div>`; }).join("");
  }
  function mineHtml() {
    return (S.mine || []).map((p) => {
      const name = tokLabel(p.tok, p.tokName), ids = `<div class="pp-ids" data-copy="${esc(p.address)}" title="${th("Click to copy the pool address")}">${esc(poolIds(p))}</div>`;
      const hold = p.signingStateUnverified ? `<div class="pp-hold"><b>${th("Owner signing paused")}</b><div class="pp-note">${th("PandaPools cannot tell how many of this owner key's one-time signatures have already been used, so it has stopped signing for this pool. Automatic refresh is paused too. Stop every other copy of this wallet that signs, then confirm the latest complete wallet signing state.")}</div><div class="pp-acts">${lpBtn(I18N.t("Confirm wallet signing state"), "ppconfirm", p.opk)}</div></div>` : "";
      if (p.unresolved) return `<div class="dx-card pp-card"><b class="pp-ct">${th("Saved pool · reserves not found")}</b>${ids}<div class="pp-note">${th("This node cannot currently see both reserve coins. It may still be syncing, or the pool may have closed.")}</div>${hold}
        <div class="pp-acts">${lpBtn(I18N.t("Check for reserves"), "pprecover", p.address)}${lpBtn(I18N.t("It's closed: put it away"), "ppretire", p.address)}</div></div>`;
      const r = Number(p.kratio), warn = needsMigrate(p), pct = isFinite(r) && r > 0 ? Math.max(4, Math.min(100, r / 2 * 100)) : 0;
      return `<div class="dx-card pp-card"><b class="pp-ct">${esc(pairName({ tok: p.tok, name }))}</b>${ids}${hold}${lpRows(p).map((x) => kv(x[0], esc(x[1]), x[2] ? "pp-" + x[2] : "")).join("")}
        ${pct ? `<div class="pp-health"><div class="pp-kv"><span>${th("Floor headroom")}</span><span class="${warn ? "pp-warn" : "pp-dimv"}">${tr("K/KMIN {r} · {warn}", { r: cutNum(Math.trunc(r * 100) / 100), warn: warn ? th("migrate soon") : th("healthy") })}</span></div><div class="pp-bar"><i style="width:${pct.toFixed(1)}%"${warn ? ' data-warn="1"' : ""}></i></div></div>` : ""}
        <div class="pp-acts">${lpBtn(warn ? I18N.t("Add (full)") : I18N.t("Add"), "ppadd", p.address)}${lpBtn(I18N.t("Migrate"), "ppmig", p.address, warn ? "dx-btn--go" : "")}${lpBtn(I18N.t("Close"), "ppclose", p.address)}</div>
        <button class="pp-link" data-ppcalc="${esc(p.address)}">${th("What if the price moves?  Pool calculator ›")}</button></div>`;
    }).join("");
  }
  function paintMylp() {
    $("ppTop").innerHTML = banners();
    if (!up()) { $("ppLp").innerHTML = ""; return; }
    if (S.create) return paintCreate();
    if (S.mineErr) { $("ppLp").innerHTML = `<div class="dx-state dx-state--error" role="alert">${tr("Your saved pools could not be read: {mineErr}. They are not lost: nothing was changed. This screen tries again by itself.", { mineErr: esc(mx(S.mineErr)) })}</div>`; return; }
    const sum = lpSummary(S.mine), n = (S.retired || []).length;
    $("ppLp").innerHTML = `<div class="dx-card pp-card pp-sum"><div class="pp-fl">${th("YOUR LIQUIDITY")}</div><div class="pp-sum__v">${esc(sum.value)}</div><div class="pp-sum__s">${esc(sum.sub)}</div></div>
      ${S.backupDue ? `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">${th("Complete encrypted backup required")}</b><div class="pp-note">${th("Before another pool can be created or migrated, save one encrypted file with your pools and this node's backup. Your pools are not at risk meanwhile; this is the engine's rule so that a new pool can always be recovered.")}</div><div class="pp-acts">${lpBtn(I18N.t("Back up now"), "pptool", "backup", "pp-fill")}</div></div>` : ""}
      <div class="pp-tools" id="ppTools">${lpBtn(I18N.t("+  CREATE A POOL"), "pptool", "create", "pp-fill")}${lpBtn(I18N.t("BACK UP / RESTORE POOLS"), "pptool", "recovery", "pp-out")}${lpBtn(I18N.t("EXPORT STATEMENT"), "pptool", "statement", "pp-out")}${lpBtn(I18N.t("POOL CALCULATOR"), "pptool", "calc", "pp-out")}</div>
      ${collectHtml()}${mineHtml()}
      ${n ? `<div class="dx-card pp-card"><div class="pp-sum__s">${tr("{n} closed pool(s) kept for recovery", { n: n })}</div><div class="pp-note">${th("Their recipes are still saved and still go into your backups: they are just out of the way. If a close never actually landed, the pool reappears here on its own.")}</div><div class="pp-acts">${lpBtn(I18N.t("Show closed pools"), "pptool", "closed")}</div></div>` : ""}
      <div class="pp-note pp-note--foot">${th("Pools you created on this node. PandaPools keeps their reserves fresh by itself: leave this app and the node running so your pools stay live for everyone. Anyone on the network can trade against them; you earn the 0.50% fee on every swap that routes through them.")}</div>`;
  }
  const pool = (address) => (S.mine || []).find((p) => p.address === address);
  /** every money action of the screen: Dexicon's one gate, the buttons off while it runs, then a fresh read */
  /** a READ (the statement, a reserve check): nothing is signed, so it does not hold the money gate; one at a time of its own */
  const reading = (fn) => { if (S.reading) return; S.reading = true; (async () => { try { await fn(); } catch (e) { say(failText(I18N.t("That"), e), "error"); } })().then(() => { S.reading = false; load(S.tab).then(paint, paint); }); };
  const act = (fn) => D.money(async () => { paint(); try { await fn(); } catch (e) { say(failText(I18N.t("That"), e), "error"); } load(S.tab).then(paint, paint); }).then(paint, paint);
  async function addSheet(p) {
    const name = tokLabel(p.tok, p.tokName);
    // ONE field: the engine takes the MINIMA amount and works the token side out itself (Act.deposit)
    const hint = (v) => { const est = amountOk(v) ? depositToken(p, v) : null; return !v ? "" : est == null ? I18N.t("Enter the MINIMA amount to add, above zero.") : I18N.t("With {v} MINIMA the pool takes about {est} {name} from your wallet. {name2} is taken at the pool's ratio when the transaction is posted, so this figure can change slightly.", { v: v, est: est, name: name, name2: name }); };
    const got = await form(I18N.t("Add liquidity"), `<div class="pp-note">${tr("Grow {name} in place (capped at 2× the floor: beyond that, use Migrate). You enter the MINIMA; the pool takes the {name2} that goes with it at its own ratio, so the price does not move.", { name: esc(pairName({ tok: p.tok, name })), name2: esc(name) })}</div>${fld(I18N.t("Add MINIMA"), "a")}<div class="pp-note" data-hint role="status"></div>`, "Review",
      (d) => (amountOk(val(d, "a")) ? { a: val(d, "a") } : I18N.t("Enter the MINIMA amount to add, above zero. Nothing was sent.")), (d) => { d.oninput = () => { d.querySelector("[data-hint]").textContent = hint(val(d, "a")); d.querySelector(".pp-bad").textContent = ""; }; });
    if (got) await Act.deposit(api(), ui, p, got.a);
  }
  function calc(address) {
    const seed = address ? pool(address) : null, cs = getComputedStyle($("shell")), cv = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    const f = D.PoolCalc.form({ x0: seed && seed.reserveM ? String(seed.reserveM) : "100000", y0: seed && seed.reserveT ? String(seed.reserveT) : "500", tok: seed ? tokLabel(seed.tok, seed.tokName) : "MxUSD",
      colors: { accent: cv("--dx-accent", "#F7931A"), ink: cv("--dx-text", "#fff"), dim: cv("--dx-dim", "#8B909C"), grid: cv("--dx-dim2", "#6F7583"), surface: cv("--dx-surface2", "#1B1F28"), font: "Inter, sans-serif" } });
    form(I18N.t("Pool calculator"), `<div class="pp-calc" data-calc></div>`, "", () => true, (d) => { d.classList.add("pp-dlg--wide"); d.querySelector("[data-calc]").appendChild(f.el); setTimeout(() => f.render(), 0); });
  }
  async function closedPools() {
    const list = S.retired || [];
    if (await D.dialog(I18N.t("Closed pools"), list.map(poolIds).join("\n\n"), I18N.t("Bring back"))) await Act.unretire(api(), ui, list);
  }

  // ---- Activity (ActivityView.java): my pool operations, and every pool's transactions ----
  const activitySkeleton = () => `<div id="ppTop"></div><div class="pp-sumrow pp-sumrow--tight"><div class="pp-chips" role="group" aria-label="${th("Which activity")}"><button data-ppall="0">${th("MY ACTIVITY")}</button><button data-ppall="1">${th("ALL POOLS")}</button></div><button class="pp-scan" data-ppreload="1" aria-label="${th("Read the activity again")}">↻</button></div><div id="ppActs"></div>`;
  const idRow = (x) => `<div class="pp-ids" data-copy="${esc(x[1])}" title="${th("Click to copy")}">${esc(x[0])}: ${esc(x[1])}</div>`;
  const itemHtml = (it) => `<div class="dx-card pp-card pp-act"><div class="dx-row"><b class="pp-ct">${esc(it.title)}</b>${it.chip ? `<span class="dx-chip" data-tone="${it.tone}">${esc(it.chip)}</span>` : ""}</div>${it.summary ? `<div class="pp-act__s">${esc(it.summary)}</div>` : ""}${it.ids.map(idRow).join("")}${it.lines.map((l) => `<div class="pp-act__l">${esc(l)}</div>`).join("")}</div>`;
  const more = (n, shown, which) => (n > shown ? `<button class="pp-link" data-ppmore="${which}">${tr("Show more ({shown} remaining) ▾", { shown: n - shown })}</button>` : "");
  function paintActivity() {
    $("ppTop").innerHTML = banners();
    body().querySelectorAll("[data-ppall]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ppall === "1") === S.all)));
    const now = Date.now(), host = $("ppActs"); if (!up()) { host.innerHTML = ""; return; }
    if (!S.all) {
      const notes = (S.acts || []).filter((a) => a.type === "STATUS"), rows = (S.acts || []).filter((a) => a.type !== "STATUS");
      host.innerHTML = notes.map((a) => `<div class="dx-state dx-state--note" role="status">${esc(mx(a.summary))}</div>`).join("") + (!S.acts ? `<div class="pp-line">${th("Loading your history…")}</div>` : !rows.length ? `<div class="pp-line">${th("No transactions recorded yet.")}</div>`
        : `<div class="dx-label pp-hdr">${th("TRANSACTIONS · NEWEST FIRST")}</div>` + rows.slice(0, S.shownA).map((a) => itemHtml(actItem(a, now))).join("") + more(rows.length, S.shownA, "a"));
    } else {
      const tx = (S.feed || []).filter((f) => !f.observed), obs = (S.feed || []).filter((f) => f.observed);
      host.innerHTML = `<div class="dx-label pp-hdr">${th("POOL TRANSACTIONS · NEWEST FIRST")}</div>` + (!S.feed ? `<div class="pp-line">${th("Loading transactions from the node…")}</div>` : !tx.length ? `<div class="pp-line">${th("No pool transactions found in this node's stored history.")}</div>` : tx.slice(0, S.shownF).map((f) => itemHtml(feedItem(f, now))).join("") + more(tx.length, S.shownF, "f"))
        + (obs.length ? `<div class="dx-label pp-hdr">${th("PREVIOUS LOCAL OBSERVATIONS")}</div><div class="pp-note">${th("These were inferred from pool scans. They are not verified transaction records.")}</div>` + obs.map((f) => itemHtml(feedItem(f, now))).join("") : "");
    }
  }
  /** PandaPools' part of the shared Activity and History screens of rooms ① and ③ (dexicon-ui.js places them). */
  function part(tab) {
    if (!D || !D.running()) return "";
    if (!S.st || !S.st.ready) return tab === "activity" ? `<div class="dx-day">${th("POOL OPERATIONS · ② POOLS")}</div><div class="dx-state dx-state--note" role="status">${th("PandaPools has not started yet, so your pool operations could not be checked. They are listed here when it has.")}</div>` : "";
    if (tab === "activity") return "";   // the rows are in Activity's one mixed list (activityItems)
    const now = Date.now(), list = (S.acts || []).filter((a) => a.type !== "STATUS").map((a) => actItem(a, now)).filter((x) => x.done);
    return list.length ? `<div class="dx-day">${th("POOL OPERATIONS · ② POOLS")}</div>` + list.slice(0, 60).map(itemHtml).join("") : "";
  }
  /** PandaPools' rows of the shared Activity's ONE list (0.19.384; dexicon-ui.js mixes them by time with DexCore.activityMix):
   *  the 60 newest and every one not finished, each with its whole card. block: the block the node's own check found the
   *  transaction in (pp_txproof inclusionblock), when it found it. pending (0.19.385): not failed, not confirmed, not found
   *  in a block and not checked yet; a row only the history holds (a consolidation, a row from another device or a restore)
   *  has a depth but no inclusion block, and is not pending. A row the node checked and did not find, or one with no
   *  transaction id, says so instead of PENDING; one not found is still unfinished (it may yet be mined, or was dropped). */
  function activityItems() {
    if (!up()) return [];
    const now = Date.now();
    return (S.acts || []).filter((a) => a.type !== "STATUS").map((a, i) => {
      const it = actItem(a, now), block = Number(a.verifiedDepth) >= 0 && Number(a.inclusionBlock) > 0 ? Number(a.inclusionBlock) : 0;
      const open = !a.failed && !a.confirmed && !(Number(a.verifiedDepth) >= 0), noId = open && !a.txpowid, notFound = open && !noId && !!a.verifiedAt;
      return { kind: "pool", key: "pp:" + (a.txpowid ? String(a.txpowid).toLowerCase() : "#" + i), ts: Number(a.ts) || 0, block, pending: open && !noId && !notFound, unfinished: notFound,
        tag: th("POOL") + (noId ? " · " + th("No transaction ID saved") : notFound ? " · " + th("Not found on this node") : ""), html: itemHtml(it), keep: i < 60 || !it.done };
    }).filter((x) => x.keep);
  }
  /** the shared screens ask for PandaPools' part of their data: at once when one opens, then once a minute */
  function shared(force) { if (!D || (!force && Date.now() - S.sharedAt < 60000)) return; S.sharedAt = Date.now(); (async () => { S.st = await api().ppStatus().catch(() => null); if (up()) S.acts = await api().ppActivity().catch(() => S.acts); })().then(D.redraw, D.redraw); }

  // ---- Wallet (WalletView.java): the receive address, the tools, one card per balance ----
  const GATE_BUSY = L_("A money action is still running. The coins (with Split and Consolidate) open when it has finished. Nothing was sent.");
  const walletSkeleton = () => `<div id="ppTop"></div><div id="ppWal"></div>`;
  const balName = (b) => (b.tokenid === MINIMA ? "MINIMA" : tokLabel(b.tokenid, D.TOK.tokenName(b.token, b.tokenid)));
  function paintWallet() {
    $("ppTop").innerHTML = banners();
    if (!D.running()) { $("ppWal").innerHTML = ""; return; }
    const ago = S.balAt ? C.ago(Date.now() - S.balAt) : "…", list = S.bal || [];
    $("ppWal").innerHTML = `<div class="dx-card pp-card pp-wal"><div class="pp-fl"><b>${th("AVAILABLE TO POOL")}</b></div><div class="pp-note">${th("Sendable balances below. Funds locked in your pools show as LOCKED.")}</div>
        <div class="pp-recv"${S.addr ? ` data-copy="${esc(S.addr)}" title="Click to copy"` : ""}>${S.addr ? tr("Receive:  {addr}", { addr: esc(S.addr) }) : "…"}</div><div class="pp-hint">${th("click to copy your receive address")}</div>
        <button class="pp-link pp-link--row" data-ppwal="minima"${C.gate.on ? " disabled" : ""}>${th("Consolidate MINIMA coins")}</button><button class="pp-link pp-link--row" data-ppwal="mxusd"${C.gate.on ? " disabled" : ""}>${th("Consolidate MxUSD coins")}</button><button class="pp-link pp-link--row" data-ppwal="check">${th("Check node connection")}</button></div>`
      + (!S.bal ? `<div class="pp-line">${th("Loading balances…")}</div>` : !list.length ? `<div class="pp-line">${th("No balances yet.")}</div>` : list.map((b, i) => { const c = walletCard(b, balName(b), ago); return `<button class="dx-card pp-card pp-bal" data-ppbal="${i}"${C.gate.on ? " disabled" : ""}><span class="dx-row"><span class="pp-bal__h">${D.tokIconHtml(b.tokenid || MINIMA, b.token)}<b class="pp-bal__n">${esc(c.name)}</b></span><span class="pp-bal__r"><b>${esc(c.amount)}</b><small>${esc(c.coins)}</small></span></span>${b.tokenid === MINIMA || isMxusd(b.tokenid) ? "" : `<span class="pp-ids">${th("Token:")} ${esc(b.tokenid)}</span>`}<span class="pp-bal__l">${esc(c.line)}</span></button>`; }).join(""));
    D.enhanceTokenIcons($("ppWal"));   // the Wallet's own icons and web-validation tick, from its cache (0.19.380): the same requests the Wallet makes for the same tokens, never more
  }
  async function walletAct(what) {
    if (what === "check") { const b = await D.tryCmd("block"); return say(nodeCheck(D.running(), b && (b.block != null ? b.block : b), await api().ppStatus().catch(() => null)), "note"); }
    // Consolidate is the wallet's own (app.js consolidateToken): its question, then PandaPools' owner-key check (ppConsolidationCheck), then the node's command
    return act(async () => { await D.consolidateToken(what === "minima" ? MINIMA : MXUSD, what === "minima" ? "MINIMA" : "MxUSD"); });
  }

  // ---- create a pool: four steps on the screen (1 before you start, 2 amounts, 3 review, 4 back up) ----
  const stepBar = (n) => `<ol class="pp-steps" aria-label="${tr("Step {n} of 4", { n: n })}">${STEPS.map((t, i) => `<li${i + 1 === n ? ' aria-current="step"' : ""} data-done="${i + 1 < n}"><b>${i + 1}</b><span>${I18N.th(t)}</span></li>`).join("")}</ol>`;
  const check = (id, text, on) => `<label class="pp-check"><input type="checkbox" id="${id}"${on ? " checked" : ""}><span>${esc(text)}</span></label>`;
  function paintCreate() {
    const c = S.create, host = $("ppLp"), busy = C.gate.on ? " disabled" : "";
    const key = c.step + ":" + S.backupDue;
    if (host.dataset.step === key) { if (c.step === 2) paintCreateInfo(); return; }   // a step is drawn once: never redrawn under someone typing or ticking
    host.dataset.step = key;
    const head = `<div class="dx-title"><h2>${th("Create a pool")}</h2><button class="dx-btn dx-btn--side" data-ppcreate="cancel"${c.step > 2 ? " disabled" : ""}>${th("Cancel")}</button></div>${stepBar(c.step)}`;
    if (c.step === 1) host.innerHTML = head + (S.backupDue
      ? `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">${th("First, the backup of the pools you already have")}</b><div class="pp-note">${th("The last step of creating a pool is saving the encrypted backup, and that step is still owed. Another pool cannot be created until it is saved and checked. Nothing is wrong with your pools.")}</div><div class="pp-acts"><button class="dx-btn pp-fill" data-pptool="backup"${busy}>${th("Back up now")}</button></div></div>`
      : `<div class="dx-card pp-card"><b class="pp-ct">${th("Two things this pool will need from you")}</b>${BEFORE_CREATE.map((t, i) => `<div class="pp-note"><b>${i + 1}.  </b>${esc(t)}</div>`).join("")}${check("ppcAck1", CREATE_ACK, c.ack1)}<div class="pp-acts"><button class="dx-btn pp-fill" data-ppcreate="next"${busy}>${th("Continue")}</button></div></div>`);
    else if (c.step === 2 && c.anchor) host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">${tr("MINIMA / {name} pool", { name: esc(c.t.name) })}</b><label class="pp-fld"><b>${tr("{name} to provide  (≈ US$)", { name: esc(c.t.name) })}</b><input class="dx-in" id="ppcU" inputmode="decimal" autocomplete="off" placeholder="e.g. 1.90" value="${esc(c.u || "")}"></label>
        <pre class="pp-info" id="ppcInfo" role="status"></pre><div class="pp-acts"><button class="dx-btn" data-ppcreate="price"${busy}>${th("↻  Price")}</button><button class="dx-btn pp-fill" data-ppcreate="go"${busy}>${th("Review")}</button></div></div>`;
    else if (c.step === 2) host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">${tr("MINIMA / {name} pool", { name: esc(c.t.name) })}</b><div class="pp-bad">${esc(MANUAL_WARN(c.t.name))}</div>${fld(I18N.t("MINIMA to deposit"), "x", "e.g. 100", c.x)}${fld(I18N.t("{name} to deposit", { name: c.t.name }), "y", "e.g. 0.56", c.y)}
        <pre class="pp-info" id="ppcInfo" role="status"></pre>${check("ppcAck", MANUAL_ACK, false)}<div class="pp-acts"><button class="dx-btn pp-fill" data-ppcreate="go"${busy}>${th("Review")}</button></div></div>`;
    else host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">${c.step === 3 ? th("Review, then the pool is posted") : th("Save the backup")}</b><div class="pp-note">${c.step === 3 ? th("Read the question and choose Create. Nothing is sent before that.") : th("The pool is on its way to the chain. Save the encrypted backup now: it is the last step, and another pool cannot be created before it.")}</div></div>`;
    if (c.step === 2) { host.oninput = (e) => { if (e.target.id === "ppcU") c.u = e.target.value.trim(); if (e.target.name === "x") c.x = e.target.value.trim(); if (e.target.name === "y") c.y = e.target.value.trim(); S.said = null; $("ppTop").innerHTML = banners(); paintCreateInfo(); }; paintCreateInfo(); }
    else host.oninput = null;
  }
  async function paintCreateInfo() {
    const c = S.create, info = $("ppcInfo"); if (!c || !info) return;
    if (c.anchor) { info.textContent = createInfo(c.t, c.minimaAvail, c.anchor.price, c.anchor.source, c.u || "").lines.join("\n"); return; }
    if (!amountOk(c.x || "") || !amountOk(c.y || "")) { info.textContent = I18N.t("Enter both amounts to see the opening price."); return; }
    const x = c.x, y = c.y, pv = await api().ppCreatePreview(c.t.dec, x, y).catch(() => ({ ok: false }));
    if (S.create === c && c.x === x && c.y === y && $("ppcInfo")) $("ppcInfo").textContent = pv && pv.ok ? I18N.t("Opening price:  {price} {name} per MINIMA\nProduct floor (KMIN):  {kmin}", { price: cut(pv.price, 8), name: c.t.name, kmin: pv.kmin }) : mx((pv && pv.msg) || I18N.t("Enter both amounts."));
  }
  const leaveCreate = () => { S.create = null; const h = $("ppLp"); if (h) { delete h.dataset.step; h.oninput = null; } };
  async function createAct(what) {
    const c = S.create;
    if (what === "open") {
      const o = await Act.createOpen(api(), D.tryCmd);
      if (o.none) return void D.dialog(I18N.t("Get MxUSD first"), I18N.t("PandaPools creates MINIMA / MxUSD pools: the pair with a live market price, so a pool always opens at the true rate. Your wallet holds no sendable MxUSD; receive some first, then create a pool."), "");
      S.create = Object.assign({ step: 1, ack1: false }, o); S.said = null; return;
    }
    if (!c) return;
    if (what === "cancel") return leaveCreate();
    if (what === "next") { if (!$("ppcAck1") || !$("ppcAck1").checked) return say(I18N.t("Tick the box to confirm you understand. Nothing was sent."), "note"); c.ack1 = true; c.step = 2; S.said = null; return; }
    if (what === "price") { $("ppcInfo").textContent = I18N.t("Refreshing the price…"); try { const m = await api().ppMarket(); if (m && m.mid) c.anchor = { price: m.mid, source: I18N.t("MEXC market"), at: Number(m.at) || Date.now() }; } catch (e) {} return paintCreateInfo(); }
    if (what === "go") {
      const ack = !!($("ppcAck") && $("ppcAck").checked);
      // the price and the balances are read again before anything is reviewed (Act.createRefresh): never a review from an old read
      const f = await Act.createRefresh(api(), D.tryCmd, c).catch((e) => ({ bad: I18N.t("The price and your balances could not be read again: {e}. Nothing was sent.", { e: bare(e) }) }));
      if (f.bad) return say(f.bad, "note");
      const manual = !c.anchor; Object.assign(c, f.fresh);
      if (f.moved) { if (manual) { const h = $("ppLp"); if (h) delete h.dataset.step; paint(); } else paintCreateInfo(); return say(f.text, "note"); }
      c.step = 3; paint();
      const r = c.anchor ? await Act.createPriced(api(), ui, c.t, c.minimaAvail, c.anchor.price, c.anchor.source, c.u || "") : await Act.createManual(api(), ui, c.t, c.x || "", c.y || "", ack);
      if (!r || r.err) { c.step = /BACKUP_REQUIRED/.test((r && r.err) || "") ? 1 : 2; if (c.step === 1) S.backupDue = true; return; }
      c.step = 4; paint();
      await backupDialog(true); leaveCreate();
    }
  }
  async function migrateSheet(p) {
    const name = tokLabel(p.tok, p.tokName);
    const got = await form(I18N.t("Migrate pool"), `<div class="pp-note">${th("Migrate resets the pool at a fresh address with the KMIN floor recomputed for the new size. Your current reserves return to you and the new reserves are taken from your wallet. The amounts below keep the same size.")}</div>${fld(I18N.t("New MINIMA reserve"), "a", "", whole(p.reserveM))}${fld(I18N.t("New {name} reserve", { name: name }), "b", "", whole(p.reserveT))}`, "Migrate", (d) => ({ a: val(d, "a"), b: val(d, "b") }));
    if (!got) return;
    const r = await Act.migrate(api(), ui, p, got.a, got.b);
    if (r && !r.err) await backupDialog(true);
  }

  // ---- backup, restore and the recovery tools ----
  const pwd = (name, ph) => `<input class="dx-in" type="password" autocomplete="off" name="${name}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">`;
  /** The encrypted pool + node backup. forced: said after a create or a migrate, when the engine now requires it. true = saved. */
  async function backupDialog(forced) {
    const got = await form(forced ? I18N.t("Back up now: required") : I18N.t("Required encrypted backup"), `<div class="pp-note">${forced ? (th("Your new pool is on its way to the chain.") + " ") : ""}${esc(BACKUP_INTRO)}</div>${pwd("p1", I18N.t("Backup password"))}${pwd("p2", I18N.t("Repeat password"))}<div class="pp-note" data-st></div>`, I18N.t("Create and save"),
      async (d) => {
        const p1 = d.querySelector("[name=p1]"), p2 = d.querySelector("[name=p2]"), pass = p1.value, again = p2.value;
        if (!backupProblem(pass, again)) { p1.value = p2.value = ""; d.querySelector("[data-st]").textContent = I18N.t("Creating, encrypting and checking the complete backup…"); }
        const r = await Act.backup(api(), pass, again); d.querySelector("[data-st]").textContent = "";
        return r.bad || r;
      });
    const said = backupEnd(got, forced); if (said) say(said.text, said.kind);
    return !!got && !got.pending;
  }
  function restoreDialog() {
    return form(I18N.t("Restore pools"), `<div class="pp-note">${esc(RESTORE_INTRO)}</div>${pwd("pw", I18N.t("Combined backup password (blank for an old JSON file)"))}
      <textarea class="dx-in pp-ta" name="json" placeholder="${th("…or paste the backup JSON here")}" aria-label="${th("Backup JSON")}" spellcheck="false"></textarea><div class="pp-note" data-st role="status"></div>
      <div class="pp-acts"><button class="dx-btn" data-ppr="file">${th("Load file")}</button><button class="dx-btn" data-ppr="node">${th("Extract node backup")}</button><button class="dx-btn dx-btn--go" data-ppr="go">${th("Restore")}</button></div>`, "", () => true, (d) => {
      const st = d.querySelector("[data-st]"), pw = d.querySelector("[name=pw]"), ta = d.querySelector("[name=json]"); let busy = false;
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-ppr]"); if (!b || busy) return;
        busy = true;
        try {
          if (b.dataset.ppr === "file") { const f = await Act.loadFile(api(), pw.value); if (f && f.bad) st.textContent = f.bad; else if (f) { ta.value = f.json; st.textContent = I18N.t("File read. Nothing is restored yet: press Restore."); } }
          else if (b.dataset.ppr === "node") {
            const r = await Act.extractNode(api(), pw.value); pw.value = "";
            if (r && r.bad) st.textContent = r.bad;
            else if (r) { st.textContent = NODE_EXTRACTED + (r.path ? "\n\n" + r.path : ""); const row = document.createElement("div"); row.className = "pp-acts"; row.innerHTML = `<input class="dx-in" type="password" readonly autocomplete="off" aria-label="${th("Node restore password")}"><button class="dx-btn">${th("Show restore password")}</button>`;
              row.firstChild.value = r.nodePassword; row.lastChild.onclick = () => { row.firstChild.type = row.firstChild.type === "password" ? "text" : "password"; }; st.appendChild(row); }
          } else { st.textContent = I18N.t("Restoring: checking each pool's reserves on this node…"); const r = await Act.restore(api(), ta.value); st.textContent = r.bad || r.text; if (!r.bad) load(S.tab).then(paint, paint); }
        } finally { busy = false; }
      });
    });
  }
  async function archiveDialog() {
    let current; try { current = await Act.archiveGet(api()); } catch (e) { return say(I18N.t("The archive setting could not be read: {e}", { e: plainCode(e) }), "error"); }
    const ok = await form(I18N.t("Recovery archive"), `<div class="pp-note">${esc(ARCHIVE_INTRO)}</div><input class="dx-in" type="url" name="url" value="${esc(current || "")}" placeholder="${th("https://archive.example.com")}" aria-label="${th("Archive address")}" autocomplete="off" spellcheck="false">`, "Save",
      async (d) => { const r = await Act.archiveSave(api(), d.querySelector("[name=url]").value); return r.bad || true; });
    if (ok === true) say(I18N.t("Recovery archive saved."), "note"); else if (ok && ok.pending) say(I18N.t("The dialog was closed before the archive setting had answered, so it is not known yet whether it was saved. Open Archive connection again to see."), "note");
  }
  /** BACK UP / RESTORE POOLS (MyLpView.showRecoveryMenu): the tools, one per line; the one chosen opens when the list closes */
  function recoveryMenu() {
    const items = [["collect", I18N.t("Collect withdrawn funds to my wallet")], ["backup", I18N.t("Back up my pools to a file")], ["restore", I18N.t("Restore pools from a file")], ["archive", I18N.t("Archive connection")], ["guide", I18N.t("How recovery works")]]; let choice = "";
    return form(I18N.t("Pool recovery"), `<div class="pp-menu">${items.map((x) => `<button class="dx-btn" data-pick="${x[0]}">${x[1]}</button>`).join("")}</div>`, "", () => true,
      (d) => d.addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (b) { choice = b.dataset.pick; d.querySelector('[data-x="0"]').click(); } })).then(() => choice);
  }
  async function recoveryTools() {
    const choice = await recoveryMenu();
    if (choice === "collect") return Act.collect(api(), ui);
    if (choice === "backup") return backupDialog(false);
    if (choice === "restore") return restoreDialog();
    if (choice === "archive") return archiveDialog();
    if (choice === "guide") return D.dialog(I18N.t("How pool recovery works"), GUIDE, "");
  }

  // ---- the room ----
  const SCREENS = { activity: { skeleton: activitySkeleton, bind: noop, paint: paintActivity }, wallet: { skeleton: walletSkeleton, bind: noop, paint: paintWallet }, mylp: { skeleton: mylpSkeleton, bind: noop, paint: paintMylp }, swap: { skeleton: swapSkeleton, bind: bindSwap, paint: paintSwap, after: requote }, pools: { skeleton: poolsSkeleton, bind: noop, paint: paintPools } };
  function render(tab, host) {
    if (!D) return;
    const scr = SCREENS[tab];
    if (host.dataset.tab !== tab || !host.firstChild) {
      host.dataset.tab = tab; S.said = null; host.onclick = click; $("main").scrollTop = 0;
      host.innerHTML = scr ? scr.skeleton() : `<div class="dx-state dx-state--note" role="status">${th("This screen of the room is not built in this version yet.")}</div>`;
      if (scr) scr.bind();
    }
    S.tab = tab; paint();
    load(tab).then(() => { paint(); if (scr && scr.after) scr.after(); }, paint);
  }
  function paint() { const b = body(), scr = SCREENS[S.tab]; if (b && scr && b.dataset.tab === S.tab && b.firstChild) scr.paint(); }
  function click(e) {
    const b = e.target.closest("button"); if (!b) return;
    const ds = b.dataset;
    if (ds.ppgo) return D.go(ds.ppgo);
    if (ds.ppstart) return D.start();
    if (ds.ppaside) return act(setAside);
    if (ds.ppmode) { S.combined = ds.ppmode === "combined"; paint(); return load(S.tab).then(paint, paint); }   // the cached pools are drawn at once; a stale answer is simply painted over
    if (ds.ppscan) return scan();
    if (ds.ppall != null) { S.all = ds.ppall === "1"; return paint(); }
    if (ds.ppmore) { if (ds.ppmore === "a") S.shownA += 60; else S.shownF += 60; return paint(); }
    if (ds.ppreload) return load(S.tab).then(paint, paint);
    if (ds.ppwal) return walletAct(ds.ppwal);
    if (ds.ppbal != null) { if (C.gate.on) return say(GATE_BUSY, "note"); const row = (S.bal || [])[Number(ds.ppbal)]; return row ? D.showCoins(row) : null; }   // not while a money action runs: Split and Consolidate are in this dialog   // the wallet's own coins dialog: every coin whole, with Split, Consolidate and the token's details and Send
    if (ds.ppcalc != null) return calc(ds.ppcalc);
    if (ds.pptool === "calc") return calc("");
    if (ds.pptool === "statement") return reading(() => { say(I18N.t("Building the statement: the transaction history is being caught up with the node. This can take a while."), "note"); return Act.statement(api(), ui); });
    if (ds.pptool === "closed") return act(closedPools);
    if (ds.pptool === "create") return act(() => createAct("open"));
    if (ds.ppcreate) return act(() => createAct(ds.ppcreate));
    if (ds.ppmig) { const p = pool(ds.ppmig); return p ? act(() => migrateSheet(p)) : say(I18N.t("That pool is no longer in the list. Nothing was sent."), "note"); }
    if (ds.pptool === "recovery") return act(recoveryTools);
    if (ds.pptool === "backup") return act(() => backupDialog(false));
    if (ds.ppcollectnow) return act(() => Act.collectNow(api(), ui));
    if (ds.ppconfirm) return act(() => Act.confirmSigning(api(), ui, ds.ppconfirm));
    if (ds.pprecover) return reading(async () => { say(I18N.t("Checking local reserves and current archive proofs. No transaction is signed."), "note"); if (await Act.recover(api(), ui, ds.pprecover)) S.said = null; });   // a failure's message stays (0.18.141: it was erased at once)
    if (ds.ppretire) return act(() => Act.retire(api(), ui, ds.ppretire));
    if (ds.ppadd) { const p = pool(ds.ppadd); return p ? act(() => addSheet(p)) : say(I18N.t("That pool is no longer in the list. Nothing was sent."), "note"); }
    if (ds.ppclose) { const p = pool(ds.ppclose); return p ? act(() => Act.withdraw(api(), ui, p)) : say(I18N.t("That pool is no longer in the list. Nothing was sent."), "note"); }
  }

  return Object.assign({ Act, init: (deps) => { D = deps; }, render, onUpdate, reset, tick, part, activityItems, shared }, core);
});
