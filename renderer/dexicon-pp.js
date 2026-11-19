/*
 * dexicon-pp.js: Dexicon room ② Pools. The REAL PandaPools (constant-product pools MINIMA ⇄ MxUSD on Minima), drawn as
 * the Android client draws it inside Dexicon (apks/dexicon com.eurobuddha.pandapools SwapView / PoolsView / MyLpView /
 * WalletView / ActivityView) over the engine the desktop already runs: the SAME window.mcd pp* calls with the SAME
 * arguments and the SAME guards, in the same order, as the panel it replaces (renderer/pools.js, which stays in the
 * tree until the 3e parity audit). This file changes screens, never behaviour: scripts/dexicon-pp.test.cjs runs both
 * and compares every call.
 *
 * Three parts, as dexicon-ax.js: text and numbers with no DOM (Core), the money actions over (api, ui) with no DOM
 * (Act), the screens. RULE 2: the dollar token is MxUSD wherever the desktop writes it. The engine names it "USDT"
 * in the records it keeps; "USDT/MINIMA (MEXC)" is the MEXC market's own unit and stays.
 */
(function (root, factory) { const node = typeof module === "object" && module.exports, m = factory(node ? require("./dexicon-core.js") : root.DexCore); if (node) module.exports = m; else root.DexPools = m; })(this, function (C) {
  "use strict";

  // ======================================================================== Core: no DOM
  const MINIMA = "0x00", MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const isMxusd = (tok) => String(tok || "").toLowerCase() === MXUSD.toLowerCase();
  /** A pool token's name. The dollar token is named by its ID, never by what a token calls itself: another token that
   *  calls itself USDT or MxUSD is said to be another token. An unnamed token is its whole id. */
  const tokLabel = (tok, name) => (isMxusd(tok) ? "MxUSD" : !name || name === tok ? String(tok || "token") : /^m?x?usdt?$/i.test(name) ? name + " (another token, not MxUSD)" : String(name));
  /** the engine's own records say USDT for the dollar token */
  const mx = (s) => String(s == null ? "" : s).replace(/\bm?x?USDT\b/gi, "MxUSD");
  /** a decimal string CUT to dp decimals, never rounded (SwapView.trim8 / fmt6: RoundingMode.DOWN); other text as it is */
  const cut = (x, dp) => { const d = C.dec(x); return d ? C.str(C.down(d, dp)) : String(x == null || x === "" ? "0" : x); };
  /** every digit, no trailing zeros (SwapView.trim) */
  const whole = (x) => { const d = C.dec(x); return d ? C.str(d) : String(x == null ? "—" : x); };
  /** the old panel's amount check (pools.js doPpSwap): digits with at most one point, above zero */
  const amountOk = (v) => /^[0-9]*\.?[0-9]+$/.test(String(v)) && parseFloat(v) > 0;
  const plural = (n, one) => n + " " + one + (Number(n) === 1 ? "" : "s");

  /** The pairs there are pools for, deepest first as the scan gives them: [{ tok, name }]. */
  function pairs(pools) { const seen = {}, out = []; for (const p of pools || []) if (p.tok && !seen[p.tok.toLowerCase()]) { seen[p.tok.toLowerCase()] = 1; out.push({ tok: p.tok, name: tokLabel(p.tok, p.tokName) }); } return out; }
  const poolLine = (t, info) => "MINIMA / " + t.name + "   ·   " + plural(info.pools, "pool") + "   ·   depth " + whole(info.depth) + " MINIMA";
  /** sendable, not confirmed: confirmed counts coins locked in pools (the old panel's rule) */
  function sendable(bal, tok) { const r = (bal || []).find((b) => b.tokenid && b.tokenid.toLowerCase() === String(tok).toLowerCase()); return r ? r.sendable || "0" : "0"; }
  const balanceLine = (bal, t) => "Your balance: " + cut(sendable(bal, MINIMA), 6) + " MINIMA  ·  " + cut(sendable(bal, t.tok), 6) + " " + t.name;
  /** The MEXC line (SwapView.renderMarket), for the MxUSD pair only: the market mid, the blended pool price (Σ token /
   *  Σ MINIMA, cut to 6 decimals) and how far apart they are. "" = no line. */
  function marketLine(t, market, pools) {
    if (!isMxusd(t.tok)) return "";
    let m = C.zero, u = C.zero;
    for (const p of pools || []) if (p.tok && p.tok.toLowerCase() === t.tok.toLowerCase()) { m = C.add(m, C.dec(p.reserveM) || C.zero); u = C.add(u, C.dec(p.reserveT) || C.zero); }
    if (m.v === 0n) return "";
    const mid = market && market.fresh && Number(market.mid) > 0 ? C.dec(Number(market.mid).toFixed(12)) : null;
    if (!mid || mid.v === 0n) return "Market price unavailable (MEXC)";
    const spot = C.div(u, m, 12), above = C.cmp(spot, mid) > 0, pct = C.div(C.mul(above ? C.sub(spot, mid) : C.sub(mid, spot), C.dec("100")), mid, 8);
    const word = C.cmp(pct, C.dec("0.1")) < 0 ? "at market" : C.str(C.down(pct, 1)) + "% " + (above ? "above market" : "below market");
    return "Market ≈ " + C.str(C.down(mid, 6)) + " USDT/MINIMA (MEXC)  ·  Pool " + C.str(C.down(spot, 6)) + "  ·  " + word;
  }
  /** The live quote's rows (SwapView.requote), or why there is none. q = ppQuote(). */
  function quoteRows(q, t, dir) {
    if (!q || !q.ok) return { ok: false, out: q && q.notReady ? "0.0" : "—", note: q && q.notReady ? "PandaPools is still starting. One moment." : "This trade is too large for the pools' depth. Try a smaller amount." };
    const rows = [["Rate", "≈ " + cut(q.effPrice, 8) + " " + t.name + " / MINIMA"], ["Price impact", q.priceImpact + " %"]];
    if (Number(q.poolsAvailable) > 1) rows.push(["Routed across", (Number(q.poolsUsed) || 0) + " of " + (Number(q.poolsAvailable) || 0) + " pools" + (q.capped ? " (top " + (Number(q.maxPools) || 6) + ")" : "")]);
    rows.push(["Pool fee (0.50%)", "kept by LPs"], ["You receive", whole(q.totalOut) + " " + (dir ? t.name : "MINIMA")]);
    return { ok: true, out: cut(q.totalOut, 8), rows };
  }
  /** What the Swap click asks to be confirmed (SwapView.confirmAndSwap; the old panel's "Confirm swap"). */
  function swapReview(q, amt, t, dir) {
    const pay = dir ? "MINIMA" : t.name, get = dir ? t.name : "MINIMA";
    return { title: "Confirm swap", ok: "Swap", text: "Pay  " + amt + " " + pay + "\nReceive  " + whole(q.totalOut) + " " + get + "\nRate  ≈ " + cut(q.effPrice, 8) + " " + t.name + " / MINIMA\n\nPrice impact " + q.priceImpact + "%."
      + (Number(q.poolsUsed) > 1 ? "\nRouted across " + q.poolsUsed + " pools in one transaction." : "")
      + "\n\nThis posts a real on-chain transaction for exactly these amounts. There is no slippage setting: if a pool moves before it confirms, the swap is rejected and you keep your funds." };
  }

  // ---- Pools (PoolsView.java) ----
  /** "3 pools · 866751.25 MINIMA aggregate depth": the MINIMA reserves added exactly (VirtualCurve.totalMinima). */
  function poolsSummary(pools) {
    if (!pools || !pools.length) return "no active pools";
    return plural(pools.length, "pool") + " · " + C.str(pools.reduce((t, p) => C.add(t, C.dec(p.reserveM) || C.zero), C.zero)) + " MINIMA aggregate depth";
  }
  /** One pool's card: its rows as [label, value, copy value]. The pool address is whole. */
  function poolCard(p) {
    const name = tokLabel(p.tok, p.tokName), rows = [["reserves", whole(p.reserveM) + " MINIMA  ·  " + whole(p.reserveT) + " " + name], ["spot price", cut(p.spot, 8) + " " + name + " / MINIMA"], ["fees accrued (K/KMIN−1)", cut(p.feeGrowthPct, 8) + " %"]];
    if (!isMxusd(p.tok)) rows.push(["token", String(p.tok), p.tok]);
    rows.push(["pool", p.address + "  (click to copy)", p.address]);
    return { title: "MINIMA / " + name, rows };
  }
  /** One collective card per token (PoolsView.combinedCard), from the engine's own aggregates (ppAggregate). */
  function combinedCard(a) {
    const name = tokLabel(a.tok, a.name);
    return { title: "MINIMA / " + name + "  ·  combined", rows: [["pools combined", String(a.count)], ["total reserves", whole(a.totalMinima) + " MINIMA  ·  " + whole(a.totalToken) + " " + name], ["aggregate spot price", cut(a.price, 8) + " " + name + " / MINIMA"], ["tradeable depth", whole(a.depth) + " MINIMA"]] };
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
    if (!live.length) return gone ? { value: "Reserves unavailable", sub: plural(gone, "saved pool") + (gone === 1 ? " needs" : " need") + " a live reserve check." } : { value: "No pools yet", sub: "Create a pool to start earning the swap fee." };
    return { value: C.str(live.reduce((t, p) => C.add(t, C.dec(p.reserveM) || C.zero), C.zero)) + " MINIMA reserves", sub: plural(live.length, "visible pool") + " · token reserves shown below" + (gone ? " · " + gone + " unavailable" : "") };
  }
  /** One of my pools as rows [label, value, tone] (MyLpView.poolCard). */
  function lpRows(p) {
    const name = tokLabel(p.tok, p.tokName), rows = [["Your liquidity", whole(p.reserveM) + " MINIMA  +  " + whole(p.reserveT) + " " + name], ["Value now", "≈ " + whole(p.value) + " MINIMA"], ["Pool price", cut(p.poolPrice, 8) + " " + name + " / MINIMA"],
      ["Fees earned", "≈ " + cutNum(p.feesMinima) + " MINIMA  (+" + cutNum(p.feesPct) + "%)", "ok"]];
    if (p.priceMove != null) {
      rows.push(["Price since open", (p.priceMove >= 0 ? "+" : "") + cutNum(p.priceMove) + "%"], ["Impermanent loss", cutNum(p.il) + "%  vs holding", p.il < -0.01 ? "warn" : ""]);
      if (p.ageBlocks > 0) rows.push(["Age", (Number(p.ageBlocks) || 0) + " blocks  (~" + cutNum(p.ageBlocks * 50 / 3600) + " h)"]);
    }
    return rows;
  }
  const poolIds = (p) => "Pool: " + p.address + (p.opk ? "\nOwner key: " + p.opk : "");
  const recoveryResult = (r) => "Verified reserves for " + r.restored + " of " + r.total + " pools.\n" + (r.details || []).join("\n\n") + "\n" + (r.warn || "");
  const CLOSE_TO_OWNER = "to the pool's owner address on this node. PandaPools then moves them into your wallet by itself; if they have not arrived after a few blocks, use Collect withdrawn funds. Do that before you restore your seed on another node.";

  // ---- Activity (ActivityView.java) ----
  const ACT_NAME = { SWAP: "Swap", CREATE: "Create pool", ADD: "Add liquidity", DEPOSIT: "Add liquidity", WITHDRAW: "Withdraw", CLOSE: "Withdraw", MIGRATE: "Migrate", COLLECT: "Collect" };
  /** "18 Nov 2026 14:13:36 GMT" (ActivityView.absolute), or that the time is not known */
  const when = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toUTCString().replace(/^\w+, /, "") : "Time unknown");
  /** how long ago a check was made (ActivityView.relative) */
  const since = (ms, now) => { const d = now - Number(ms); return d < 60000 ? "just now" : d < 3600000 ? Math.floor(d / 60000) + "m ago" : d < 86400000 ? Math.floor(d / 3600000) + "h ago" : Math.floor(d / 86400000) + "d ago"; };
  /** Older swap rows were kept from the token's side ("Bought <token> for <minima>"): said from MINIMA's side, as new ones are (the old panel's ppSwapSummary). */
  function swapSummary(a) {
    const s = a.summary || "";
    if (a.type !== "SWAP" || /MINIMA/.test(s)) return s;
    let m = /^Bought (\S+) for (\S+)$/.exec(s); if (m) return "Sold " + m[2] + " MINIMA for " + m[1];
    m = /^Sold (\S+) for (\S+)$/.exec(s); return m ? "Bought " + m[1] + " MINIMA for " + m[2] : s;
  }
  /** One of my pool operations as a card: { title, chip, tone, summary, lines, ids: [[label, whole id]] }. */
  function actItem(a, now) {
    const tone = a.failed ? "bad" : a.confirmed ? "ok" : "live", lines = [(a.timeLabel || "Submitted") + " " + when(a.ts)], ids = [];
    if (a.txpowid) ids.push(["transaction", a.txpowid]);
    if (a.originalTxpowid && String(a.originalTxpowid).toLowerCase() !== String(a.txpowid).toLowerCase()) ids.push(["original submission", a.originalTxpowid]);
    if (a.verifiedAt) lines.push("Checked " + since(a.verifiedAt, now));
    if (a.failed) lines.push(a.failMsg ? failText("This", a.failMsg).replace(/ Look at Activity: if no new line is there, nothing was sent and no funds moved\.$/, " Nothing was sent and no funds moved.") : "It was not sent. No funds moved.");
    return { title: ACT_NAME[a.type] || String(a.type || "Pool transaction"), chip: a.failed ? "FAILED" : a.statusText || "Waiting for node check", tone, summary: mx(swapSummary(a)), lines, ids, done: !!(a.failed || a.confirmed) };
  }
  /** One transaction of any pool (ActivityView.globalRow). */
  function feedItem(f, now) {
    const label = mx(f.tokenLabel), action = f.kind === "CREATE" ? "Pool creation" : f.kind === "ADD" ? "Liquidity addition" : f.kind === "WITHDRAW" ? "Liquidity withdrawal" : f.kind === "SWAP" ? (f.minimaIn ? "MINIMA sale" : "MINIMA purchase") : "Pool reserves changed";
    if (f.observed) return { observed: true, title: String(f.kind || "Pool") + " observation (unverified) · " + whole(f.minimaAmt) + " MINIMA / " + whole(f.tokenAmt) + " " + label, lines: ["Observed on this device " + when(f.ts) + " · Transaction time unknown"], ids: f.pool ? [["pool", f.pool]] : [] };
    return { title: action + " · " + whole(f.minimaAmt) + " MINIMA / " + whole(f.tokenAmt) + " " + label, chip: f.statusText || "", tone: f.confirmed ? "ok" : "live", lines: ["Transaction " + when(f.ts)].concat(f.verifiedAt ? ["Checked " + since(f.verifiedAt, now)] : []),
      ids: [].concat(f.pool ? [["pool", f.pool]] : [], f.txpowid ? [["transaction", f.txpowid]] : []) };
  }

  // ---- Wallet (WalletView.java): what can be pooled ----
  /** One balance as the phone's card: the sendable amount (whole), the coin count, and the line beneath. */
  function walletCard(b, name, agoText) {
    const conf = C.dec(b.confirmed), send = C.dec(b.sendable), n = Number(b.coins) || 0;
    return { name, amount: whole(b.sendable), coins: (n + (n === 1 ? " coin" : " coins")).toUpperCase(),
      line: "confirmed " + whole(b.confirmed) + "  ·  locked ≈ " + (conf && send ? C.str(C.sub(conf, send)) : "?") + "  ·  unconfirmed " + whole(b.unconfirmed) + "  ·  " + plural(n, "coin") + "  ·  updated " + agoText + "  ·  click for coins" };
  }
  /** What the node check found, in one sentence. */
  const nodeCheck = (running, block, st) => (!running ? "The node is not running, so nothing here can be read or sent. Start the node."
    : !(Number(block) > 0) ? "The node did not answer just now. Nothing was changed. Try again in a moment."
    : "The node answers: block " + block + ". " + (st && st.ready ? "PandaPools is running and reading the pool registry." : "PandaPools has not finished starting yet."));

  // ---- create a pool, in PandaPools' four steps (MyLpView.openCreate → createFormPriced | createFormManual → confirmCreate → forceBackupAfterCreate) ----
  const STEPS = ["Before you start", "Amounts", "Review", "Back up"];
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
    const p = parseFloat(price); if (!(p > 0)) return { lines: ["Fetching the MINIMA price…"], ok: false };
    const cap = Math.min(minimaAvail * p, t.avail), L = ["Price: " + cut(price, 8) + " " + t.name + " per MINIMA (" + source + ")", "You have: " + cut(String(minimaAvail), 6) + " MINIMA · " + cut(String(t.avail), 6) + " " + t.name];
    if (!amountOk(uRaw)) { L.push("Enter the " + t.name + " amount to provide (max ≈ " + cut(cap.toFixed(9), 6) + ")."); return { lines: L, ok: false }; }
    const u = parseFloat(uRaw), minima = derive(u, p);
    L.push("MINIMA required:  " + minima, "Total pool value:  ≈ US$ " + cut((u * 2).toFixed(9), 2));
    if (minima > minimaAvail) L.push("⚠ Not enough MINIMA: reduce " + t.name + " to " + cut(cap.toFixed(9), 6) + " or less.");
    if (u > t.avail) L.push("⚠ You only have " + cut(String(t.avail), 6) + " " + t.name + ".");
    return { lines: L, ok: minima <= minimaAvail && u <= t.avail, minima };
  }
  const BEFORE_CREATE = ["This app and its node must run regularly.\n\nYour pool's reserve coins have to be recreated about every 900 blocks, roughly twice a day. PandaPools does that by itself while the app and the node run. If it cannot, other wallets stop finding your pool, and after about 1700 blocks its coins drop out of the chain's recent window and can only be recovered through a MegaMMR archive.",
    "Save the backup and keep your wallet seed safe.\n\nRight after the pool is created you are asked to save one encrypted file with your pools and this node's backup. Until it is saved and checked, another pool cannot be created or migrated. Keep it off this device."];
  const CREATE_ACK = "I understand: I must keep this app running, save the backup and keep my wallet seed safe.";
  const MANUAL_WARN = (name) => "No market price is available (MEXC is unreachable and there are no live MINIMA / " + name + " pools to match). You are setting the OPENING PRICE yourself: set it to the true market rate, or arbitrageurs will correct it at your expense.";
  const MANUAL_ACK = "I understand I'm setting the opening price with no market to check it against.";

  // ---- backup, restore, recovery (CombinedBackupUi.java, MyLpView.showRecoveryMenu; the old panel's dialogs) ----
  /** Why a backup password is not taken ("" = it is): the old panel's rule, at least 12 characters, at most 1024 bytes, typed twice. */
  const backupProblem = (pass, again) => (Array.from(String(pass)).length < 12 || new TextEncoder().encode(String(pass)).length > 1024 || pass !== again ? "Use at least 12 characters and enter the same password twice. Nothing was saved." : "");
  /** A backup or restore refusal without its internal code: the sentence after the code, or plain words for a bare code. */
  function plainCode(raw) {
    raw = bare(raw);
    if (/BACKUP_NOT_VERIFIED/.test(raw)) return "The file that was written is not the same as the backup that was made, so it does not count as saved. Save it again in another place.";
    if (/BACKUP_TOO_LARGE/.test(raw)) return "That file is too large to be a PandaPools backup. Nothing was read from it.";
    if (/NODE_EXPORT_NOT_VERIFIED/.test(raw)) return "The node backup that was written is not the same as the one in the file, so do not use it. Extract it again to another place.";
    const m = /^[A-Z][A-Z0-9_]{3,}:\s*(.+)$/.exec(raw);
    return mx(m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : raw) || "No reason was given.";
  }
  const BACKUP_INTRO = "Save one file containing your pools and the native node backup, including wallet keys. Use at least 12 characters, ideally random words. Keep the password safe; there is no password reset. The saved file is checked before another pool can be created.";
  const RESTORE_INTRO = "Restore public pool recipes and verify reserves on this node. Expired proofs need a synced MegaMMR archive. Owner signing stays paused until you confirm current wallet signing state.";
  const NODE_EXTRACTED = "Node backup saved. Restore this .bak through MinimaCore's node restore flow, using the password below. Then reopen the combined file to recover the pool recipes. An old backup still requires verification of current signing state.";
  const ARCHIVE_INTRO = "Optional public HTTPS MegaMMR RPC endpoint for current proofs. Your node verifies every proof. Leave empty for local MegaMMR or backup proofs.";
  const GUIDE = "Keep the latest complete MinimaCore wallet backup and this pool recipe. Proofs expire. A seed or recipe alone is insufficient.\n\nSaved recipes identify pools even when a light node no longer sees their coins. Restore verifies local reserves, then backup proofs, then current proofs from a synced MegaMMR archive. Missing reserves remain visible and are never reported as recovered.\n\nRestore does not regenerate keys or estimate past signature use. Confirm signing only with current complete wallet state and no other signing copies. Keep-fresh requires the app and node to remain running; it cannot guarantee availability while offline.";

  /** An error as the bridge gives it, without the bridge's own wrapping. */
  const bare = (e) => String((e && e.message) || e || "").replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
  /**
   * A failed action in the alert's three parts: what happened, whether funds moved, what to do. The engine reports
   * fixed sentences; the ones a reader cannot act on are said in plain words, with the node's own answer beside them
   * (node = ppWhy(): the node's last refusal of a pool command, used only when it came after `since`).
   */
  function failText(what, raw, node, since) {
    raw = bare(raw);
    const said = node && node.error && Number(node.at) >= Number(since || 0) ? " The node's last answer while this ran (its \"" + node.verb + "\" command): " + mx(node.error).replace(/[.\s]+$/, "") + "." : "";
    if (/BACKUP_REQUIRED/.test(raw)) return what + " was not done and no funds moved. Before another pool can be created or migrated, the encrypted backup of your pools and this node must be saved and checked. Open My LP, choose Back up / restore pools, save the backup, then try again.";
    if (/could not mint an owner key/i.test(raw)) return what + " was not done and no funds moved: the node did not make the new key that would own the pool." + said + " Check that the node is running and in sync, then try again.";
    if (/Could not identify the input signing key/i.test(raw)) return what + " was not done and nothing was signed: the node could not say which key signs one of the coins it would spend." + said + " Wait until the node has caught up with the chain, then try again.";
    if (/quote expired/i.test(raw)) return what + " was not sent and no funds moved: the quote was too old. Enter the amount again for a fresh one.";
    if (/timed out/i.test(raw)) return "It is not known whether this was sent: no answer came in time." + said + " Look at Activity and at your balance before trying again, and do not repeat it until you have.";
    return what + " did not go through: " + (mx(raw).replace(/[.\s]+$/, "") || "no reason was given") + "." + said + " Look at Activity: if no new line is there, nothing was sent and no funds moved.";
  }

  // ======================================================================== Act: the money actions, no DOM
  async function create(api, ui, t, x, y) {
    const since = Date.now();
    try { const r = await api.ppCreate(t.tokenid, t.dec, x, y); ui.say("Pool submitted: " + x + " MINIMA + " + y + " " + t.name + ". It is confirming on-chain (usually 1 to 3 blocks) and appears in My LP by itself: do not submit it again. Now save the backup.", "note"); return r || {}; }
    catch (e) { ui.say(await why(api, "Creating the pool", e, since), "error"); return { err: bare(e) }; }
  }
  // ui = { confirm(title, text, okLabel) → Promise<bool>, say(text, kind) }. Every function here makes the SAME
  // window.mcd calls, with the same arguments, behind the same guards, in the same order, as renderer/pools.js.
  /** why a call failed, with the node's own last answer when it came during the call */
  async function why(api, what, e, since) { const node = await Promise.resolve().then(() => api.ppWhy()).catch(() => null); return failText(what, e, node, since); }
  const Act = {
    /** ppQuote at the click (the exact route that will be posted, frozen) → confirm → ppSwap(that quote's id). */
    async swap(api, ui, t, dir, amt) {
      if (!t) { ui.say("Pick a pool first. Nothing was sent.", "note"); return null; }
      if (!amountOk(amt)) { ui.say("Enter an amount. Nothing was sent.", "note"); return null; }
      const q = await api.ppQuote(t.tok, dir, amt).catch(() => ({ ok: false }));
      if (!q || !q.ok || !q.quoteId) { ui.say(q && q.notReady ? "PandaPools is still starting. Nothing was sent: try again in a moment." : "That trade is too large for these pools. Nothing was sent: try a smaller amount.", "note"); return null; }
      const rv = swapReview(q, amt, t, dir);
      if (!await ui.confirm(rv.title, rv.text, rv.ok)) return null;
      const since = Date.now();
      try {
        const r = await api.ppSwap(q.quoteId);
        ui.say("Swap submitted: you pay " + amt + " " + (dir ? "MINIMA" : t.name) + " and receive " + whole(r && r.totalOut) + " " + (dir ? t.name : "MINIMA") + " when a block confirms it. It is not final yet: follow it in Activity. Transaction " + ((r && r.txpowid) || "not reported"), "note");
        return r || {};
      } catch (e) { ui.say(await why(api, "The swap", e, since), "error"); return { err: bare(e) }; }
    },
    /** Add liquidity (the old panel's sheet): either amount may be left empty, not both; confirm → ppDeposit(address, a || "0", b || "0"). */
    async deposit(api, ui, p, a, b) {
      const name = tokLabel(p.tok, p.tokName), ok = (v) => v === "" || /^[0-9]*\.?[0-9]+$/.test(v);
      if (!ok(a) || !ok(b) || ((parseFloat(a) || 0) <= 0 && (parseFloat(b) || 0) <= 0)) { ui.say("Enter an amount to add. Nothing was sent.", "note"); return null; }
      if (!await ui.confirm("Add liquidity?", "Add " + (a || "0") + " MINIMA and " + (b || "0") + " " + name + " to the pool.\n\nPool: " + p.address + "\n\nThis posts an on-chain transaction and cannot be undone. The amounts stay yours inside the pool.", "Add")) return null;
      const since = Date.now();
      try { const r = await api.ppDeposit(p.address, a || "0", b || "0"); ui.say("Liquidity sent to the pool: " + (a || "0") + " MINIMA and " + (b || "0") + " " + name + ". It counts once a block confirms it: follow it in Activity.", "note"); return r || {}; }
      catch (e) { ui.say(await why(api, "Adding liquidity", e, since), "error"); return { err: bare(e) }; }
    },
    /** Close a pool and take all its liquidity out: confirm → ppClose(address). */
    async withdraw(api, ui, p) {
      const name = tokLabel(p.tok, p.tokName);
      if (!await ui.confirm("Withdraw all liquidity?", "This closes the MINIMA / " + name + " pool and sweeps its reserves (" + whole(p.reserveM) + " MINIMA + " + whole(p.reserveT) + " " + name + ", earned fees included) " + CLOSE_TO_OWNER + "\n\nPool: " + p.address, "Withdraw")) return null;
      const since = Date.now();
      try { const r = await api.ppClose(p.address); ui.say("The pool is closing. Its reserves go " + CLOSE_TO_OWNER, "note"); return r || {}; }
      catch (e) { ui.say(await why(api, "Closing the pool", e, since), "error"); return { err: bare(e) }; }
    },
    /** Collect to wallet: confirm → ppCollect(). */
    async collect(api, ui) {
      if (!await ui.confirm("Collect to wallet?", "Move any withdrawn or migrated reserves from your pool owner addresses into this node's wallet.", "Collect")) return null;
      const since = Date.now();
      try {
        const r = await api.ppCollect(), skipped = r && r.foreign ? " " + plural(r.foreign, "owner key") + (r.foreign === 1 ? " is" : " are") + " paused or not in this wallet, so " + (r.foreign === 1 ? "its" : "their") + " funds were left where they are: confirm the wallet signing state on the pool's card." : "";
        ui.say((r && r.coins ? "Collection sent: " + plural(r.coins, "coin") + " on the way to your wallet. It is final when a block confirms it." : "There was nothing to collect right now. No funds moved.") + skipped, r && r.foreign ? "error" : "note"); return r || {};
      } catch (e) { ui.say(await why(api, "The collection", e, since), "error"); return { err: bare(e) }; }
    },
    /** "Collect now" on a withdrawn-funds card: ppCollect() at once, as the old card's button. */
    async collectNow(api, ui) {
      const since = Date.now();
      try {
        const r = await api.ppCollect();
        ui.say(r.cleared ? "The withdrawn funds were moved to your wallet." : r.stranded ? "The funds were not moved: this wallet cannot sign for that payout address. See the card for what is needed." : "Not moved yet: the withdrawn coins are not spendable yet. PandaPools keeps trying by itself.", r.stranded ? "error" : "note"); return r;
      } catch (e) { ui.say(await why(api, "The collection", e, since), "error"); return { err: bare(e) }; }
    },
    /** Check for reserves: ppRecoverSaved(address), then its result. Nothing is signed. */
    async recover(api, ui, address) {
      try { const r = await api.ppRecoverSaved(address); await ui.show("Recovery result", mx(recoveryResult(r))); return r; }
      catch (e) { ui.say("The reserves could not be checked: " + mx(bare(e)) + ". Nothing was signed and nothing was changed.", "error"); return null; }
    },
    /** Put a closed pool away: ppRetirePool(address, true). Hidden, never deleted. */
    async retire(api, ui, address) {
      try { await api.ppRetirePool(address, true); ui.say("Put away. The recipe is still saved and still goes into your backups.", "note"); return true; }
      catch (e) { ui.say("The pool was not put away: " + mx(bare(e)) + ".", "error"); return false; }
    },
    /** Bring back: ppRetirePool(address, false) for each closed pool. */
    async unretire(api, ui, retired) {
      try { for (const r of retired) await api.ppRetirePool(r.address, false); ui.say("Closed pools are showing again.", "note"); return true; }
      catch (e) { ui.say("Not every closed pool was brought back: " + mx(bare(e)) + ".", "error"); return false; }
    },
    /** Confirm wallet signing state: the warning, then ppConfirmSigning(owner key, true). */
    async confirmSigning(api, ui, opk) {
      if (!await ui.confirm("Confirm current wallet signing state", "Confirm only if this node has the latest complete MinimaCore wallet backup, including signing counters, and every other copy has stopped signing. A seed or old backup is insufficient. This enables owner spending and automatic refresh for key:\n" + opk, "I confirm current wallet state")) return null;
      try { const ok = await api.ppConfirmSigning(opk, true); ui.say(ok ? "Confirmation saved. Owner signing is enabled for this pool." : "Not confirmed: signing stays paused. The owner key is missing, used up or below a recorded count.", ok ? "note" : "error"); return ok; }
      catch (e) { ui.say("Not confirmed: " + mx(bare(e)) + ". Signing stays paused.", "error"); return null; }
    },
    // ---- create and migrate ----
    /** Step 1 of create reads what the old panel read, in its order: balance, the market-fed token, then the price anchor.
     *  { none: true } = no MxUSD to pool; else { t, minimaAvail, anchor } (anchor null = no market price: the manual form). */
    async createOpen(api, tryCmd) {
      const bal = (await tryCmd("balance")) || []; let usdt = "";
      try { const mt = await api.ppMarketToken(); usdt = (mt && mt.usdt) || ""; } catch (e) {}
      const c = createTokens(bal, usdt); if (!c.toks.length) return { none: true };
      let a = null; try { a = await api.ppCreateAnchor(); } catch (e) {}
      return { t: c.toks[0], minimaAvail: c.minimaAvail, anchor: a && a.price ? { price: a.price, source: a.source || "market" } : null };
    },
    /** The priced form's Create: the same checks, the same question, then ppCreate(token id, decimals, String(MINIMA derived), the amount as typed). */
    async createPriced(api, ui, t, minimaAvail, price, source, uStr) {
      const p = parseFloat(price);
      if (!(p > 0)) { ui.say("There is no price yet. Refresh the price and try again. Nothing was sent.", "note"); return null; }
      if (!amountOk(uStr)) { ui.say("Enter the " + t.name + " amount (a positive number). Nothing was sent.", "note"); return null; }
      const u = parseFloat(uStr), minima = derive(u, p);
      if (minima > minimaAvail || u > t.avail) { ui.say("Not enough balance for that amount. Nothing was sent.", "note"); return null; }
      if (!await ui.confirm("Create this pool?", "MINIMA / " + t.name + " pool\n\n" + minima + " MINIMA  +  " + uStr + " " + t.name + "\nOpens at " + cut(price, 8) + " " + t.name + " per MINIMA  (matches " + source + ")\n\nThe 0.5% swap fee goes to liquidity providers. This posts an on-chain transaction; you can withdraw the liquidity later as the pool's owner.", "Create")) return null;
      return create(api, ui, t, String(minima), uStr);
    },
    /** The manual form (no market price): both amounts, the acknowledgement, ppCreatePreview, the question, then ppCreate(token id, decimals, x, y). */
    async createManual(api, ui, t, x0, y0, ack) {
      if (!amountOk(x0) || !amountOk(y0)) { ui.say("Enter both reserves (positive numbers). Nothing was sent.", "note"); return null; }
      if (!ack) { ui.say("Tick the box to confirm you are setting the opening price. Nothing was sent.", "note"); return null; }
      const pv = await api.ppCreatePreview(t.dec, x0, y0).catch(() => ({ ok: false }));
      const line = pv && pv.ok ? "⚠ No market price available: YOU are setting the opening price at " + cut(pv.price, 8) + " " + t.name + " per MINIMA.\n" : "";
      if (!await ui.confirm("Create MINIMA / " + t.name + " pool?", x0 + " MINIMA  +  " + y0 + " " + t.name + "\n" + line + "\nThe 0.5% swap fee goes to liquidity providers. This posts an on-chain transaction; you can withdraw the liquidity later as the pool's owner.", "Create")) return null;
      return create(api, ui, t, x0, y0);
    },
    /** Migrate (the old panel's sheet): both new reserves, the question, then ppMigrate(address, a, b). */
    async migrate(api, ui, p, a, b) {
      const name = tokLabel(p.tok, p.tokName);
      if (!amountOk(a) || !amountOk(b)) { ui.say("Enter both new reserves. Nothing was sent.", "note"); return null; }
      if (!await ui.confirm("Migrate this pool?", "A new pool opens at a fresh address with " + a + " MINIMA / " + b + " " + name + ", taken from your wallet. The old pool's reserves go to its owner address on this node; PandaPools then moves them into your wallet by itself, or use Collect withdrawn funds.\n\nOld pool: " + p.address, "Migrate")) return null;
      const since = Date.now();
      try { const r = await api.ppMigrate(p.address, a, b); ui.say("Migration sent: the new pool is confirming on-chain and the old reserves are on their way back. Follow it in Activity. Now save the backup: it must cover the new pool.", "note"); return r || {}; }
      catch (e) { ui.say(await why(api, "Migrating the pool", e, since), "error"); return { err: bare(e) }; }
    },
    // ---- backup, restore, recovery: each returns { bad } (why nothing was done, for the dialog) or its result ----
    /** Create and save: the password rule, then ppSaveBackup(password). */
    async backup(api, pass, again) {
      const bad = backupProblem(pass, again); if (bad) return { bad };
      try { const r = await api.ppSaveBackup(pass); return r && r.canceled ? { bad: "Save cancelled. No file was written, and the backup is still required." } : { path: (r && r.path) || "" }; }
      catch (e) { return { bad: "The backup was not saved: " + plainCode(e) + " Try again." }; }
    },
    /** Load file: ppLoadBackup(password) → the pool recipes as text. null = the file picker was closed. */
    async loadFile(api, pass) {
      try { const f = await api.ppLoadBackup(pass); return f && f.error ? { bad: plainCode(f.error) } : !f || f.canceled ? null : { json: f.json || "" }; }
      catch (e) { return { bad: "The backup could not be read: " + plainCode(e) + " Nothing was restored." }; }
    },
    /** Extract node backup: ppLoadBackup(password, true) → where the .bak was written and its password. */
    async extractNode(api, pass) {
      try { const r = await api.ppLoadBackup(pass, true); return !r || r.canceled ? null : { nodePassword: r.nodePassword, path: r.path || "" }; }
      catch (e) { return { bad: "The node backup was not extracted: " + plainCode(e) }; }
    },
    /** Restore: ppRestore(the recipes text). A reserve check only: nothing is signed. */
    async restore(api, json) {
      json = String(json || "").trim(); if (!json) return { bad: "Paste a backup, or load a file. Nothing was restored." };
      try { const r = await api.ppRestore(json); return { text: mx(recoveryResult(r)), all: r.restored === r.total && !!r.total }; }
      catch (e) { return { bad: "The restore did not finish: " + plainCode(e) + " Nothing was signed." }; }
    },
    async archiveGet(api) { return api.ppArchiveSettings(); },
    async archiveSave(api, url) {
      try { return (await api.ppArchiveSettings(url)) ? {} : { bad: "Not saved. Use a public HTTPS hostname without credentials, query or fragment." }; }
      catch (e) { return { bad: "Not saved: " + plainCode(e) }; }
    },
    /** Export statement: ppStatement() (it tops up the history first) → exportCsv(csv, "pandapools-statement.csv"). */
    async statement(api, ui) {
      let r; try { r = await api.ppStatement(); } catch (e) { ui.say("The statement was not built: " + mx(bare(e)) + ". No file was written.", "error"); return null; }
      if (!r || !r.pools) { ui.say("There are no pools to report on yet. No file was written.", "note"); return null; }
      const path = await api.exportCsv(r.csv, "pandapools-statement.csv");
      ui.say(!path ? "Export cancelled. No file was written." : r.backfilled ? "Statement saved: " + plural(r.pools, "pool") + ", " + plural(r.rows, "transaction") + "." : "Statement saved, but the history is still being read from the node (" + r.rows + " transactions so far): the file says so. Export again later for the full statement.", "note");
      return path;
    }
  };

  const core = { ACT_NAME, when, since, swapSummary, actItem, feedItem, walletCard, nodeCheck, STEPS, safeDec, createTokens, derive, createInfo, backupProblem, plainCode, cutNum, MIGRATE_AT, needsMigrate, lpSummary, lpRows, poolIds, recoveryResult, MINIMA, MXUSD, isMxusd, tokLabel, mx, cut, whole, amountOk, plural, pairs, poolLine, sendable, balanceLine, marketLine, quoteRows, swapReview, poolsSummary, poolCard, combinedCard, bare, failText };
  if (typeof document === "undefined") return Object.assign({ Act }, core);

  // ======================================================================== the screens
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let D = null;   // deps from app.js: api, tryCmd, running(), dialog, money, go(tab), start(), where()
  const S = { tab: "", at: 0, st: null, said: null, pools: null, sel: 0, dir: true, bal: null, info: null, market: null, acts: null, qseq: 0, combined: false, agg: null, mine: null, mineErr: "", retired: [], collect: [], backupDue: false, create: null, addr: "", balAt: 0, feed: null, all: false, shownA: 60, shownF: 60, sharedAt: 0 };
  const api = () => D.api;
  const body = () => $("dxPpBody");
  const visible = (tab) => { const b = body(), w = D.where(); return !!b && w.shown && w.room === "pools" && b.dataset.tab === (tab || S.tab); };
  const typing = () => { const a = document.activeElement, b = body(); return !!(a && b && b.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  const say = (text, kind) => { S.said = text ? { text, kind: kind || "error" } : null; paint(); };
  const ui = { confirm: (title, text, ok) => D.dialog(title, text, ok), show: (title, text) => D.dialog(title, text, ""), say };
  const up = () => D.running() && !!(S.st && S.st.ready);
  const toks = () => pairs(S.pools), pair = () => toks()[S.sel] || toks()[0] || null;

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
    if (tab === "mylp") await api().ppMyPools().then((m) => { S.mine = m || []; S.mineErr = ""; }, (e) => { S.mineErr = bare(e); });   // a read that fails is said, never shown as "no pools"
    if (tab === "swap" && pair()) S.info = await api().ppPairInfo(pair().tok).catch(() => S.info);
  }
  /** the engine's scans say "update": passive parts only, never under someone typing (the old panel's "frozen tab" rule) */
  function onUpdate() { if (S.upd || !D) return; S.upd = setTimeout(() => { S.upd = null; const w = D.where(); if (visible()) load(S.tab).then(paint, paint); else if (w.shown && w.shared && (w.tab === "activity" || w.tab === "history")) shared(true); }, 400); }
  function tick() { if (D && visible() && !typing() && !C.gate.on && Date.now() - S.at > 60000) load(S.tab).then(paint, paint); }
  function reset() { Object.assign(S, { at: 0, st: null, said: null, pools: null, sel: 0, dir: true, bal: null, info: null, market: null, acts: null, mine: null, mineErr: "", retired: [], collect: [], agg: null, create: null, addr: "", balAt: 0, feed: null, shownA: 60, shownF: 60, sharedAt: 0 }); S.qseq++; const b = body(); if (b) { b.innerHTML = ""; delete b.dataset.tab; } }

  /** what stands above every screen of the room: the node, the engine, the last thing said */
  function banners() {
    const out = [];
    if (!D.running()) out.push(`<div class="dx-state" role="status">The node is stopped, so nothing here can trade and your pools are not being kept fresh. Start it and PandaPools comes back by itself. <button class="dx-btn pp-inline" data-ppstart="1">Start the node</button></div>`);
    else if (!S.st) out.push(`<div class="dx-state dx-state--note" role="status">PandaPools could not be read just now. Nothing is lost: this screen tries again by itself.</div>`);
    else if (!S.st.ready) out.push(`<div class="dx-state dx-state--note" role="status">PandaPools is starting: it opens its saved pools and reads the pool registry from the node. Nothing can be sent yet.</div>`);
    if (S.said) out.push(`<div class="dx-state dx-state--${S.said.kind}" role="alert">${esc(S.said.text)}</div>`);
    return out.join("");
  }
  const kv = (k, v, cls) => `<div class="pp-kv"><span>${esc(k)}</span><span class="${cls || ""}">${v}</span></div>`;
  /** A pool operation as one line of the strip under Swap (SwapView.activityRow). */
  const tone = (a) => (a.failed ? "bad" : a.confirmed ? "ok" : "live");
  const recentRow = (a) => `<div class="pp-rrow"><span>${esc(a.type)} · ${esc(mx(a.summary))}</span><b data-tone="${tone(a)}">${esc(a.statusText || "Waiting for node check")}</b></div>`;

  // ---- Swap (SwapView.java) ----
  function swapSkeleton() {
    return `<div id="ppTop"></div>
      <div class="pp-line" id="ppPoolLine">Finding pools…</div><div class="pp-line" id="ppBalLine"></div><div class="pp-line pp-line--gap" id="ppMktLine"></div>
      <label class="pp-pair" id="ppPairRow" hidden><span>POOL</span><select class="dx-in" id="ppPair" aria-label="Pool pair"></select></label>
      <div class="pp-panel"><label class="pp-panel__m"><span class="pp-fl">YOU PAY</span><input class="pp-amt" id="ppAmt" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="0.0"></label><b class="pp-tok" id="ppFrom">MINIMA</b></div>
      <div class="pp-fliprow"><button class="pp-flip" id="ppFlip" aria-label="Flip: swap the other way">⇅</button></div>
      <div class="pp-panel"><div class="pp-panel__m"><span class="pp-fl">YOU RECEIVE (EST.)</span><div class="pp-amt" id="ppOut" aria-live="polite">0.0</div></div><b class="pp-tok" id="ppTo">MxUSD</b></div>
      <div class="pp-quote" id="ppQuote"></div>
      <button class="pp-cta" id="ppGo" disabled>SWAP</button>
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
  const paintGo = () => { const b = $("ppGo"); if (b) { b.disabled = C.gate.on || !up() || !S.q; b.textContent = S.swapping ? "SWAPPING…" : "SWAP"; } };
  function bindSwap() {
    $("ppAmt").oninput = () => { S.said = null; $("ppTop").innerHTML = banners(); requote(); };
    $("ppFlip").onclick = () => { S.dir = !S.dir; paintSwap(); requote(); };
    $("ppPair").onchange = () => { S.sel = Number($("ppPair").value) || 0; S.info = null; paintSwap(); requote(); load("swap").then(paint, paint); };
    $("ppGo").onclick = () => D.money(async () => {
      const t = pair(), dir = S.dir;   // the pair and the direction being confirmed, read once
      S.swapping = true; paintGo();
      const r = await Act.swap(api(), ui, t, dir, amt()).catch((e) => { say(failText("The swap", e), "error"); return null; });
      S.swapping = false;
      if (r && !r.err && $("ppAmt")) { $("ppAmt").value = ""; S.q = null; S.qseq++; $("ppOut").textContent = "0.0"; $("ppQuote").innerHTML = ""; }
      paintGo(); load("swap").then(paint, paint);
    });
  }
  function paintSwap() {
    const t = pair(), list = toks();
    $("ppTop").innerHTML = banners();
    $("ppPairRow").hidden = list.length < 2;
    if (!typing()) $("ppPair").innerHTML = list.map((x, i) => `<option value="${i}"${i === S.sel ? " selected" : ""}>MINIMA / ${esc(x.name)}</option>`).join("");
    $("ppPoolLine").textContent = !up() ? "" : !S.pools ? "Finding pools…" : !t ? "No live pools yet. Create one in My LP to seed liquidity." : S.info ? poolLine(t, S.info) : "MINIMA / " + t.name;
    $("ppBalLine").textContent = t && S.bal ? balanceLine(S.bal, t) : "";
    $("ppMktLine").textContent = t ? marketLine(t, S.market, S.pools) : "";
    $("ppFrom").textContent = S.dir ? "MINIMA" : t ? t.name : "token"; $("ppTo").textContent = S.dir ? (t ? t.name : "token") : "MINIMA";
    paintGo();
    const recent = (S.acts || []).filter((a) => a.type !== "STATUS").slice(0, 3);
    $("ppRecent").innerHTML = recent.length ? `<div class="dx-label">RECENT ACTIVITY</div>${recent.map(recentRow).join("")}<button class="pp-link" data-ppgo="activity">See all  →  Activity</button>` : "";
  }

  // ---- Pools (PoolsView.java): every pool of the shared registry, one by one or combined per token ----
  const noop = () => {};
  const poolsSkeleton = () => `<div id="ppTop"></div><div class="pp-sumrow"><span class="pp-line" id="ppSum"></span><button class="pp-scan" data-ppscan="1">↻  SCAN</button></div>
      <div class="pp-chips" role="group" aria-label="View"><button data-ppmode="indiv">INDIVIDUAL</button><button data-ppmode="combined">COMBINED</button></div><div id="ppList"></div>`;
  const cardHtml = (c) => `<div class="dx-card pp-card"><b class="pp-ct">${esc(c.title)}</b>${c.rows.map((r) => `<div class="pp-kv pp-kv--mono"${r[2] ? ` data-copy="${esc(r[2])}" title="Click to copy"` : ""}><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("")}</div>`;
  function paintPools() {
    $("ppTop").innerHTML = banners();
    $("ppSum").textContent = !up() ? "" : S.scanning ? "Scanning the pool registry…" : S.pools ? poolsSummary(S.pools) : "Scanning the pool registry…";
    body().querySelectorAll("[data-ppmode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ppmode === "combined") === S.combined)));
    const list = S.combined ? (S.agg || []).map(combinedCard) : (S.pools || []).map(poolCard);
    $("ppList").innerHTML = !up() || !S.pools || (S.combined && !S.agg) ? "" : list.length ? list.map(cardHtml).join("")
      : `<div class="pp-line">${S.combined ? "No funded pools to combine yet." : "No live pools found in the registry yet. Create one in My LP to seed liquidity."}</div>`;
  }
  async function scan() { if (S.scanning || !up()) return; S.scanning = true; paint(); await api().ppScan().catch(() => null); S.scanning = false; load(S.tab).then(paint, paint); }

  // ---- My LP (MyLpView.java): my pools, what they earned, and what I can do with them ----
  /** A dialog with its own fields. onOk(dialog) returns a string to refuse (shown, the dialog stays) or a value. */
  function form(title, html, okLabel, onOk, wire) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"); d.className = "dx-dlg pp-dlg";
      d.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="pp-bad" role="alert"></div><div class="dx-dlg__b"><button class="dx-btn" data-x="0">Close</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
      const end = (v) => { d.close(); d.remove(); resolve(v); };
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-x]"); if (!b || b.disabled) return;
        if (b.dataset.x === "0") return end(null);
        b.disabled = true; const bad = await onOk(d); b.disabled = false;
        if (typeof bad === "string" && bad) d.querySelector(".pp-bad").textContent = bad; else end(bad === undefined ? true : bad);
      });
      d.addEventListener("cancel", () => { d.remove(); resolve(null); });
      $("shell").appendChild(d); if (wire) wire(d); d.showModal();
    });
  }
  const fld = (label, name, ph, val) => `<label class="pp-fld"><b>${esc(label)}</b><input class="dx-in" name="${name}" inputmode="decimal" autocomplete="off" placeholder="${esc(ph || "0.0")}" value="${esc(val || "")}"></label>`;
  const val = (d, name) => d.querySelector(`[name=${name}]`).value.trim();
  const mylpSkeleton = () => `<div id="ppTop"></div><div id="ppLp"></div>`;
  const lpBtn = (label, attr, value, cls) => `<button class="dx-btn ${cls || ""}" data-${attr}="${esc(value)}"${C.gate.on ? " disabled" : ""}>${label}</button>`;
  function collectHtml() {
    return (S.collect || []).map((c) => { const stranded = c.status === "STRANDED"; return `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">${stranded ? "Withdrawn funds cannot be moved from this address" : "Withdrawn funds still being moved to your wallet"}</b>
      <div class="pp-note">${stranded ? "This is the address your pool was closed to. PandaPools cannot move the funds because this wallet cannot sign for it: that address is not one of the 64 addresses a seed phrase rebuilds. Restore the matching complete MinimaCore wallet backup, then use Collect. A seed on its own will not do it."
        : "Your pool's withdrawal landed at its owner payout address and PandaPools is moving it into your wallet. It keeps trying in the background and stops only once the address is empty."}</div>
      <div class="pp-ids" data-copy="${esc(c.oadr)}" title="Click to copy">Payout address: ${esc(c.oadr)}</div>${c.lastError ? `<div class="pp-note">${esc(mx(c.lastError))}</div>` : ""}
      <div class="pp-acts">${lpBtn(stranded ? "Try again" : "Collect now", "ppcollectnow", "1")}</div></div>`; }).join("");
  }
  function mineHtml() {
    return (S.mine || []).map((p) => {
      const name = tokLabel(p.tok, p.tokName), ids = `<div class="pp-ids" data-copy="${esc(p.address)}" title="Click to copy the pool address">${esc(poolIds(p))}</div>`;
      const hold = p.signingStateUnverified ? `<div class="pp-hold"><b>Owner signing paused</b><div class="pp-note">PandaPools cannot tell how many of this owner key's one-time signatures have already been used, so it has stopped signing for this pool. Automatic refresh is paused too.</div><div class="pp-acts">${lpBtn("Confirm wallet signing state", "ppconfirm", p.opk)}</div></div>` : "";
      if (p.unresolved) return `<div class="dx-card pp-card"><b class="pp-ct">Saved pool · reserves not found</b>${ids}<div class="pp-note">This node cannot currently see both reserve coins. It may still be syncing, or the pool may have closed.</div>${hold}
        <div class="pp-acts">${lpBtn("Check for reserves", "pprecover", p.address)}${lpBtn("It's closed: put it away", "ppretire", p.address)}</div></div>`;
      const r = Number(p.kratio), warn = needsMigrate(p), pct = isFinite(r) && r > 0 ? Math.max(4, Math.min(100, r / 2 * 100)) : 0;
      return `<div class="dx-card pp-card"><b class="pp-ct">MINIMA / ${esc(name)}</b>${ids}${hold}${lpRows(p).map((x) => kv(x[0], esc(x[1]), x[2] ? "pp-" + x[2] : "")).join("")}
        ${pct ? `<div class="pp-health"><div class="pp-kv"><span>Floor headroom</span><span class="${warn ? "pp-warn" : "pp-dimv"}">${warn ? "migrate soon" : "healthy"}</span></div><div class="pp-bar"><i style="width:${pct.toFixed(1)}%"${warn ? ' data-warn="1"' : ""}></i></div></div>` : ""}
        <div class="pp-acts">${lpBtn(warn ? "Add (full)" : "Add", "ppadd", p.address)}${lpBtn("Migrate", "ppmig", p.address, warn ? "dx-btn--go" : "")}${lpBtn("Close", "ppclose", p.address)}</div>
        <button class="pp-link" data-ppcalc="${esc(p.address)}">What if the price moves?  Pool calculator ›</button></div>`;
    }).join("");
  }
  function paintMylp() {
    $("ppTop").innerHTML = banners();
    if (!up()) { $("ppLp").innerHTML = ""; return; }
    if (S.create) return paintCreate();
    if (S.mineErr) { $("ppLp").innerHTML = `<div class="dx-state dx-state--error" role="alert">Your saved pools could not be read: ${esc(mx(S.mineErr))}. They are not lost: nothing was changed. This screen tries again by itself.</div>`; return; }
    const sum = lpSummary(S.mine), n = (S.retired || []).length;
    $("ppLp").innerHTML = `<div class="dx-card pp-card pp-sum"><div class="pp-fl">YOUR LIQUIDITY</div><div class="pp-sum__v">${esc(sum.value)}</div><div class="pp-sum__s">${esc(sum.sub)}</div></div>
      ${S.backupDue ? `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">Complete encrypted backup required</b><div class="pp-note">Before another pool can be created or migrated, save one encrypted file with your pools and this node's backup. Your pools are not at risk meanwhile; this is the engine's rule so that a new pool can always be recovered.</div><div class="pp-acts">${lpBtn("Back up now", "pptool", "backup", "pp-fill")}</div></div>` : ""}
      <div class="pp-tools" id="ppTools">${lpBtn("+  CREATE A POOL", "pptool", "create", "pp-fill")}${lpBtn("BACK UP / RESTORE POOLS", "pptool", "recovery", "pp-out")}${lpBtn("EXPORT STATEMENT", "pptool", "statement", "pp-out")}${lpBtn("POOL CALCULATOR", "pptool", "calc", "pp-out")}</div>
      ${collectHtml()}${mineHtml()}
      ${n ? `<div class="dx-card pp-card"><div class="pp-sum__s">${n} closed pool(s) kept for recovery</div><div class="pp-note">Their recipes are still saved and still go into your backups: they are just out of the way. If a close never actually landed, the pool reappears here on its own.</div><div class="pp-acts">${lpBtn("Show closed pools", "pptool", "closed")}</div></div>` : ""}
      <div class="pp-note pp-note--foot">Pools you created on this node. PandaPools keeps their reserves fresh by itself: leave this app and the node running so your pools stay live for everyone. Anyone on the network can trade against them; you earn the 0.50% fee on every swap that routes through them.</div>`;
  }
  const pool = (address) => (S.mine || []).find((p) => p.address === address);
  /** every money action of the screen: Dexicon's one gate, the buttons off while it runs, then a fresh read */
  const act = (fn) => D.money(async () => { paint(); try { await fn(); } catch (e) { say(failText("That", e), "error"); } load(S.tab).then(paint, paint); }).then(paint, paint);
  async function addSheet(p) {
    const name = tokLabel(p.tok, p.tokName), price = C.dec(p.poolPrice);
    const got = await form("Add liquidity", `<div class="pp-note">Grow MINIMA / ${esc(name)} in place (capped at 2× the floor: beyond that, use Migrate). Add both sides in the pool's ratio so the price does not move.</div>${fld("Add MINIMA", "a")}${fld("Add " + name, "b")}<div class="pp-note" data-hint></div>`, "Add",
      (d) => ({ a: val(d, "a"), b: val(d, "b") }), (d) => { d.oninput = () => { const m = C.dec(val(d, "a")); d.querySelector("[data-hint]").textContent = m && price && m.v > 0n ? "At the pool price, " + C.str(m) + " MINIMA goes with ≈ " + C.str(C.down(C.mul(m, price), 8)) + " " + name + "." : ""; }; });
    if (got) await Act.deposit(api(), ui, p, got.a, got.b);
  }
  function calc(address) {
    const seed = address ? pool(address) : null, cs = getComputedStyle($("shell")), cv = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    const f = D.PoolCalc.form({ x0: seed && seed.reserveM ? String(seed.reserveM) : "100000", y0: seed && seed.reserveT ? String(seed.reserveT) : "500", tok: seed ? tokLabel(seed.tok, seed.tokName) : "MxUSD",
      colors: { accent: cv("--dx-accent", "#F7931A"), ink: cv("--dx-text", "#fff"), dim: cv("--dx-dim", "#8B909C"), grid: cv("--dx-dim2", "#6F7583"), surface: cv("--dx-surface2", "#1B1F28"), font: "Inter, sans-serif" } });
    form("Pool calculator", `<div class="pp-calc" data-calc></div>`, "", () => true, (d) => { d.classList.add("pp-dlg--wide"); d.querySelector("[data-calc]").appendChild(f.el); setTimeout(() => f.render(), 0); });
  }
  async function closedPools() {
    const list = S.retired || [];
    if (await D.dialog("Closed pools", list.map(poolIds).join("\n\n"), "Bring back")) await Act.unretire(api(), ui, list);
  }

  // ---- Activity (ActivityView.java): my pool operations, and every pool's transactions ----
  const activitySkeleton = () => `<div id="ppTop"></div><div class="pp-sumrow pp-sumrow--tight"><div class="pp-chips" role="group" aria-label="Which activity"><button data-ppall="0">MY ACTIVITY</button><button data-ppall="1">ALL POOLS</button></div><button class="pp-scan" data-ppreload="1" aria-label="Read the activity again">↻</button></div><div id="ppActs"></div>`;
  const idRow = (x) => `<div class="pp-ids" data-copy="${esc(x[1])}" title="Click to copy">${esc(x[0])}: ${esc(x[1])}</div>`;
  const itemHtml = (it) => `<div class="dx-card pp-card pp-act"><div class="dx-row"><b class="pp-ct">${esc(it.title)}</b>${it.chip ? `<span class="dx-chip" data-tone="${it.tone}">${esc(it.chip)}</span>` : ""}</div>${it.summary ? `<div class="pp-act__s">${esc(it.summary)}</div>` : ""}${it.ids.map(idRow).join("")}${it.lines.map((l) => `<div class="pp-act__l">${esc(l)}</div>`).join("")}</div>`;
  const more = (n, shown, which) => (n > shown ? `<button class="pp-link" data-ppmore="${which}">Show more (${n - shown} remaining) ▾</button>` : "");
  function paintActivity() {
    $("ppTop").innerHTML = banners();
    body().querySelectorAll("[data-ppall]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ppall === "1") === S.all)));
    const now = Date.now(), host = $("ppActs"); if (!up()) { host.innerHTML = ""; return; }
    if (!S.all) {
      const notes = (S.acts || []).filter((a) => a.type === "STATUS"), rows = (S.acts || []).filter((a) => a.type !== "STATUS");
      host.innerHTML = notes.map((a) => `<div class="dx-state dx-state--note" role="status">${esc(mx(a.summary))}</div>`).join("") + (!S.acts ? `<div class="pp-line">Loading your history…</div>` : !rows.length ? `<div class="pp-line">No transactions recorded yet.</div>`
        : `<div class="dx-label pp-hdr">TRANSACTIONS · NEWEST FIRST</div>` + rows.slice(0, S.shownA).map((a) => itemHtml(actItem(a, now))).join("") + more(rows.length, S.shownA, "a"));
    } else {
      const tx = (S.feed || []).filter((f) => !f.observed), obs = (S.feed || []).filter((f) => f.observed);
      host.innerHTML = `<div class="dx-label pp-hdr">POOL TRANSACTIONS · NEWEST FIRST</div>` + (!S.feed ? `<div class="pp-line">Loading transactions from the node…</div>` : !tx.length ? `<div class="pp-line">No pool transactions found in this node's stored history.</div>` : tx.slice(0, S.shownF).map((f) => itemHtml(feedItem(f, now))).join("") + more(tx.length, S.shownF, "f"))
        + (obs.length ? `<div class="dx-label pp-hdr">PREVIOUS LOCAL OBSERVATIONS</div><div class="pp-note">These were inferred from pool scans. They are not verified transaction records.</div>` + obs.map((f) => itemHtml(feedItem(f, now))).join("") : "");
    }
  }
  /** PandaPools' part of the shared Activity and History screens of rooms ① and ③ (dexicon-ui.js places them). */
  function part(tab) {
    if (!D || !D.running()) return "";
    if (!S.st || !S.st.ready) return tab === "activity" ? `<div class="dx-day">POOL OPERATIONS · ② POOLS</div><div class="dx-state dx-state--note" role="status">PandaPools has not started yet, so your pool operations could not be checked. They are listed here when it has.</div>` : "";
    const now = Date.now(), rows = (S.acts || []).filter((a) => a.type !== "STATUS").map((a) => actItem(a, now)), list = tab === "history" ? rows.filter((x) => x.done) : rows.slice().sort((a, b) => a.done - b.done);
    return list.length ? `<div class="dx-day">POOL OPERATIONS · ② POOLS</div>` + list.slice(0, 60).map(itemHtml).join("") : "";
  }
  /** the shared screens ask for PandaPools' part of their data: at once when one opens, then once a minute */
  function shared(force) { if (!D || (!force && Date.now() - S.sharedAt < 60000)) return; S.sharedAt = Date.now(); (async () => { S.st = await api().ppStatus().catch(() => null); if (up()) S.acts = await api().ppActivity().catch(() => S.acts); })().then(D.redraw, D.redraw); }

  // ---- Wallet (WalletView.java): the receive address, the tools, one card per balance ----
  const walletSkeleton = () => `<div id="ppTop"></div><div id="ppWal"></div>`;
  const balName = (b) => (b.tokenid === MINIMA ? "MINIMA" : tokLabel(b.tokenid, D.TOK.tokenName(b.token, b.tokenid)));
  function paintWallet() {
    $("ppTop").innerHTML = banners();
    if (!D.running()) { $("ppWal").innerHTML = ""; return; }
    const ago = S.balAt ? C.ago(Date.now() - S.balAt) : "…", list = S.bal || [];
    $("ppWal").innerHTML = `<div class="dx-card pp-card pp-wal"><div class="pp-fl"><b>AVAILABLE TO POOL</b></div><div class="pp-note">Sendable balances below. Funds locked in your pools show as LOCKED.</div>
        <div class="pp-recv"${S.addr ? ` data-copy="${esc(S.addr)}" title="Click to copy"` : ""}>${S.addr ? "Receive:  " + esc(S.addr) : "…"}</div><div class="pp-hint">click to copy your receive address</div>
        <button class="pp-link pp-link--row" data-ppwal="minima"${C.gate.on ? " disabled" : ""}>Consolidate MINIMA coins</button><button class="pp-link pp-link--row" data-ppwal="mxusd"${C.gate.on ? " disabled" : ""}>Consolidate MxUSD coins</button><button class="pp-link pp-link--row" data-ppwal="check">Check node connection</button></div>`
      + (!S.bal ? `<div class="pp-line">Loading balances…</div>` : !list.length ? `<div class="pp-line">No balances yet.</div>` : list.map((b, i) => { const c = walletCard(b, balName(b), ago); return `<button class="dx-card pp-card pp-bal" data-ppbal="${i}"><span class="dx-row"><span class="pp-bal__h"><img class="pp-bal__ic" alt="" src="${b.tokenid === MINIMA ? "minima-mark.svg" : esc(D.TOK.identiconDataUri(b.tokenid))}"><b class="pp-bal__n">${esc(c.name)}</b></span><span class="pp-bal__r"><b>${esc(c.amount)}</b><small>${esc(c.coins)}</small></span></span>${b.tokenid === MINIMA || isMxusd(b.tokenid) ? "" : `<span class="pp-ids">Token: ${esc(b.tokenid)}</span>`}<span class="pp-bal__l">${esc(c.line)}</span></button>`; }).join(""));
  }
  async function walletAct(what) {
    if (what === "check") { const b = await D.tryCmd("block"); return say(nodeCheck(D.running(), b && (b.block != null ? b.block : b), await api().ppStatus().catch(() => null)), "note"); }
    // Consolidate is the wallet's own (app.js consolidateToken): its question, then PandaPools' owner-key check (ppConsolidationCheck), then the node's command
    return act(async () => { await D.consolidateToken(what === "minima" ? MINIMA : MXUSD, what === "minima" ? "MINIMA" : "MxUSD"); });
  }

  // ---- create a pool: four steps on the screen (1 before you start, 2 amounts, 3 review, 4 back up) ----
  const stepBar = (n) => `<ol class="pp-steps" aria-label="Step ${n} of 4">${STEPS.map((t, i) => `<li${i + 1 === n ? ' aria-current="step"' : ""} data-done="${i + 1 < n}"><b>${i + 1}</b><span>${t}</span></li>`).join("")}</ol>`;
  const check = (id, text, on) => `<label class="pp-check"><input type="checkbox" id="${id}"${on ? " checked" : ""}><span>${esc(text)}</span></label>`;
  function paintCreate() {
    const c = S.create, host = $("ppLp"), busy = C.gate.on ? " disabled" : "";
    const key = c.step + ":" + S.backupDue;
    if (host.dataset.step === key) { if (c.step === 2) paintCreateInfo(); return; }   // a step is drawn once: never redrawn under someone typing or ticking
    host.dataset.step = key;
    const head = `<div class="dx-title"><h2>Create a pool</h2><button class="dx-btn dx-btn--side" data-ppcreate="cancel"${c.step > 2 ? " disabled" : ""}>Cancel</button></div>${stepBar(c.step)}`;
    if (c.step === 1) host.innerHTML = head + (S.backupDue
      ? `<div class="dx-card pp-card pp-card--warn"><b class="pp-ct">First, the backup of the pools you already have</b><div class="pp-note">The last step of creating a pool is saving the encrypted backup, and that step is still owed. Another pool cannot be created until it is saved and checked. Nothing is wrong with your pools.</div><div class="pp-acts"><button class="dx-btn pp-fill" data-pptool="backup"${busy}>Back up now</button></div></div>`
      : `<div class="dx-card pp-card"><b class="pp-ct">Two things this pool will need from you</b>${BEFORE_CREATE.map((t, i) => `<div class="pp-note"><b>${i + 1}.  </b>${esc(t)}</div>`).join("")}${check("ppcAck1", CREATE_ACK, c.ack1)}<div class="pp-acts"><button class="dx-btn pp-fill" data-ppcreate="next"${busy}>Continue</button></div></div>`);
    else if (c.step === 2 && c.anchor) host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">MINIMA / ${esc(c.t.name)} pool</b><label class="pp-fld"><b>${esc(c.t.name)} to provide  (≈ US$)</b><input class="dx-in" id="ppcU" inputmode="decimal" autocomplete="off" placeholder="e.g. 1.90" value="${esc(c.u || "")}"></label>
        <pre class="pp-info" id="ppcInfo" role="status"></pre><div class="pp-acts"><button class="dx-btn" data-ppcreate="price"${busy}>↻  Price</button><button class="dx-btn pp-fill" data-ppcreate="go"${busy}>Review</button></div></div>`;
    else if (c.step === 2) host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">MINIMA / ${esc(c.t.name)} pool</b><div class="pp-bad">${esc(MANUAL_WARN(c.t.name))}</div>${fld("MINIMA to deposit", "x", "e.g. 100", c.x)}${fld(c.t.name + " to deposit", "y", "e.g. 0.56", c.y)}
        <pre class="pp-info" id="ppcInfo" role="status"></pre>${check("ppcAck", MANUAL_ACK, false)}<div class="pp-acts"><button class="dx-btn pp-fill" data-ppcreate="go"${busy}>Review</button></div></div>`;
    else host.innerHTML = head + `<div class="dx-card pp-card"><b class="pp-ct">${c.step === 3 ? "Review, then the pool is posted" : "Save the backup"}</b><div class="pp-note">${c.step === 3 ? "Read the question and choose Create. Nothing is sent before that." : "The pool is on its way to the chain. Save the encrypted backup now: it is the last step, and another pool cannot be created before it."}</div></div>`;
    if (c.step === 2) { host.oninput = (e) => { if (e.target.id === "ppcU") c.u = e.target.value.trim(); if (e.target.name === "x") c.x = e.target.value.trim(); if (e.target.name === "y") c.y = e.target.value.trim(); S.said = null; $("ppTop").innerHTML = banners(); paintCreateInfo(); }; paintCreateInfo(); }
    else host.oninput = null;
  }
  async function paintCreateInfo() {
    const c = S.create, info = $("ppcInfo"); if (!c || !info) return;
    if (c.anchor) { info.textContent = createInfo(c.t, c.minimaAvail, c.anchor.price, c.anchor.source, c.u || "").lines.join("\n"); return; }
    if (!amountOk(c.x || "") || !amountOk(c.y || "")) { info.textContent = "Enter both amounts to see the opening price."; return; }
    const x = c.x, y = c.y, pv = await api().ppCreatePreview(c.t.dec, x, y).catch(() => ({ ok: false }));
    if (S.create === c && c.x === x && c.y === y && $("ppcInfo")) $("ppcInfo").textContent = pv && pv.ok ? "Opening price:  " + cut(pv.price, 8) + " " + c.t.name + " per MINIMA\nProduct floor (KMIN):  " + pv.kmin : mx((pv && pv.msg) || "Enter both amounts.");
  }
  const leaveCreate = () => { S.create = null; const h = $("ppLp"); if (h) { delete h.dataset.step; h.oninput = null; } };
  async function createAct(what) {
    const c = S.create;
    if (what === "open") {
      const o = await Act.createOpen(api(), D.tryCmd);
      if (o.none) return void D.dialog("Get MxUSD first", "PandaPools creates MINIMA / MxUSD pools: the pair with a live market price, so a pool always opens at the true rate. Your wallet holds no sendable MxUSD; receive some first, then create a pool.", "");
      S.create = Object.assign({ step: 1, ack1: false }, o); S.said = null; return;
    }
    if (!c) return;
    if (what === "cancel") return leaveCreate();
    if (what === "next") { if (!$("ppcAck1") || !$("ppcAck1").checked) return say("Tick the box to confirm you understand. Nothing was sent.", "note"); c.ack1 = true; c.step = 2; S.said = null; return; }
    if (what === "price") { $("ppcInfo").textContent = "Refreshing the price…"; try { const m = await api().ppMarket(); if (m && m.mid) c.anchor = { price: m.mid, source: "MEXC market" }; } catch (e) {} return paintCreateInfo(); }
    if (what === "go") {
      const ack = !!($("ppcAck") && $("ppcAck").checked);
      c.step = 3; paint();
      const r = c.anchor ? await Act.createPriced(api(), ui, c.t, c.minimaAvail, c.anchor.price, c.anchor.source, c.u || "") : await Act.createManual(api(), ui, c.t, c.x || "", c.y || "", ack);
      if (!r || r.err) { c.step = /BACKUP_REQUIRED/.test((r && r.err) || "") ? 1 : 2; if (c.step === 1) S.backupDue = true; return; }
      c.step = 4; paint();
      await backupDialog(true); leaveCreate();
    }
  }
  async function migrateSheet(p) {
    const name = tokLabel(p.tok, p.tokName);
    const got = await form("Migrate pool", `<div class="pp-note">Migrate resets the pool at a fresh address with the KMIN floor recomputed for the new size. Your current reserves return to you and the new reserves are taken from your wallet. The amounts below keep the same size.</div>${fld("New MINIMA reserve", "a", "", whole(p.reserveM))}${fld("New " + name + " reserve", "b", "", whole(p.reserveT))}`, "Migrate", (d) => ({ a: val(d, "a"), b: val(d, "b") }));
    if (!got) return;
    const r = await Act.migrate(api(), ui, p, got.a, got.b);
    if (r && !r.err) await backupDialog(true);
  }

  // ---- backup, restore and the recovery tools ----
  const pwd = (name, ph) => `<input class="dx-in" type="password" autocomplete="off" name="${name}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">`;
  /** The encrypted pool + node backup. forced: said after a create or a migrate, when the engine now requires it. true = saved. */
  async function backupDialog(forced) {
    const got = await form(forced ? "Back up now: required" : "Required encrypted backup", `<div class="pp-note">${forced ? "Your new pool is on its way to the chain. " : ""}${esc(BACKUP_INTRO)}</div>${pwd("p1", "Backup password")}${pwd("p2", "Repeat password")}<div class="pp-note" data-st></div>`, "Create and save",
      async (d) => {
        const p1 = d.querySelector("[name=p1]"), p2 = d.querySelector("[name=p2]"), pass = p1.value, again = p2.value;
        if (!backupProblem(pass, again)) { p1.value = p2.value = ""; d.querySelector("[data-st]").textContent = "Creating, encrypting and checking the complete backup…"; }
        const r = await Act.backup(api(), pass, again); d.querySelector("[data-st]").textContent = "";
        return r.bad || r;
      });
    if (!got) { if (forced) say("The backup was not saved. Your pool is not affected, but another pool cannot be created or migrated until the backup is saved: use Back up now.", "note"); return false; }
    say("Encrypted pool and node backup saved and checked. Keep the file off this device, with its password." + (got.path ? " Saved as " + got.path : ""), "note");
    return true;
  }
  function restoreDialog() {
    return form("Restore pools", `<div class="pp-note">${esc(RESTORE_INTRO)}</div>${pwd("pw", "Combined backup password (blank for an old JSON file)")}
      <textarea class="dx-in pp-ta" name="json" placeholder="…or paste the backup JSON here" aria-label="Backup JSON" spellcheck="false"></textarea><div class="pp-note" data-st role="status"></div>
      <div class="pp-acts"><button class="dx-btn" data-ppr="file">Load file</button><button class="dx-btn" data-ppr="node">Extract node backup</button><button class="dx-btn dx-btn--go" data-ppr="go">Restore</button></div>`, "", () => true, (d) => {
      const st = d.querySelector("[data-st]"), pw = d.querySelector("[name=pw]"), ta = d.querySelector("[name=json]"); let busy = false;
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-ppr]"); if (!b || busy) return;
        busy = true;
        try {
          if (b.dataset.ppr === "file") { const f = await Act.loadFile(api(), pw.value); if (f && f.bad) st.textContent = f.bad; else if (f) { ta.value = f.json; st.textContent = "File read. Nothing is restored yet: press Restore."; } }
          else if (b.dataset.ppr === "node") {
            const r = await Act.extractNode(api(), pw.value); pw.value = "";
            if (r && r.bad) st.textContent = r.bad;
            else if (r) { st.textContent = NODE_EXTRACTED + (r.path ? "\n\n" + r.path : ""); const row = document.createElement("div"); row.className = "pp-acts"; row.innerHTML = `<input class="dx-in" type="password" readonly autocomplete="off" aria-label="Node restore password"><button class="dx-btn">Show restore password</button>`;
              row.firstChild.value = r.nodePassword; row.lastChild.onclick = () => { row.firstChild.type = row.firstChild.type === "password" ? "text" : "password"; }; st.appendChild(row); }
          } else { st.textContent = "Restoring: checking each pool's reserves on this node…"; const r = await Act.restore(api(), ta.value); st.textContent = r.bad || r.text; if (!r.bad) load(S.tab).then(paint, paint); }
        } finally { busy = false; }
      });
    });
  }
  async function archiveDialog() {
    let current; try { current = await Act.archiveGet(api()); } catch (e) { return say("The archive setting could not be read: " + plainCode(e), "error"); }
    const ok = await form("Recovery archive", `<div class="pp-note">${esc(ARCHIVE_INTRO)}</div><input class="dx-in" type="url" name="url" value="${esc(current || "")}" placeholder="https://archive.example.com" aria-label="Archive address" autocomplete="off" spellcheck="false">`, "Save",
      async (d) => { const r = await Act.archiveSave(api(), d.querySelector("[name=url]").value); return r.bad || true; });
    if (ok) say("Recovery archive saved.", "note");
  }
  /** BACK UP / RESTORE POOLS (MyLpView.showRecoveryMenu): the tools, one per line; the one chosen opens when the list closes */
  function recoveryMenu() {
    const items = [["collect", "Collect withdrawn funds to my wallet"], ["backup", "Back up my pools to a file"], ["restore", "Restore pools from a file"], ["archive", "Archive connection"], ["guide", "How recovery works"]]; let choice = "";
    return form("Pool recovery", `<div class="pp-menu">${items.map((x) => `<button class="dx-btn" data-pick="${x[0]}">${x[1]}</button>`).join("")}</div>`, "", () => true,
      (d) => d.addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (b) { choice = b.dataset.pick; d.querySelector('[data-x="0"]').click(); } })).then(() => choice);
  }
  async function recoveryTools() {
    const choice = await recoveryMenu();
    if (choice === "collect") return Act.collect(api(), ui);
    if (choice === "backup") return backupDialog(false);
    if (choice === "restore") return restoreDialog();
    if (choice === "archive") return archiveDialog();
    if (choice === "guide") return D.dialog("How pool recovery works", GUIDE, "");
  }

  // ---- the room ----
  const SCREENS = { activity: { skeleton: activitySkeleton, bind: noop, paint: paintActivity }, wallet: { skeleton: walletSkeleton, bind: noop, paint: paintWallet }, mylp: { skeleton: mylpSkeleton, bind: noop, paint: paintMylp }, swap: { skeleton: swapSkeleton, bind: bindSwap, paint: paintSwap, after: requote }, pools: { skeleton: poolsSkeleton, bind: noop, paint: paintPools } };
  function render(tab, host) {
    if (!D) return;
    const scr = SCREENS[tab];
    if (host.dataset.tab !== tab || !host.firstChild) {
      host.dataset.tab = tab; S.said = null; host.onclick = click; $("main").scrollTop = 0;
      host.innerHTML = scr ? scr.skeleton() : `<div class="dx-state dx-state--note" role="status">This screen of the room is not built in this version yet.</div>`;
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
    if (ds.ppmode) { S.combined = ds.ppmode === "combined"; paint(); return load(S.tab).then(paint, paint); }   // the cached pools are drawn at once; a stale answer is simply painted over
    if (ds.ppscan) return scan();
    if (ds.ppall != null) { S.all = ds.ppall === "1"; return paint(); }
    if (ds.ppmore) { if (ds.ppmore === "a") S.shownA += 60; else S.shownF += 60; return paint(); }
    if (ds.ppreload) return load(S.tab).then(paint, paint);
    if (ds.ppwal) return walletAct(ds.ppwal);
    if (ds.ppbal != null) { const row = (S.bal || [])[Number(ds.ppbal)]; return row ? D.showCoins(row) : null; }   // the wallet's own coins dialog: every coin whole, with Split, Consolidate and the token's details and Send
    if (ds.ppcalc != null) return calc(ds.ppcalc);
    if (ds.pptool === "calc") return calc("");
    if (ds.pptool === "statement") return act(() => Act.statement(api(), ui));
    if (ds.pptool === "closed") return act(closedPools);
    if (ds.pptool === "create") return act(() => createAct("open"));
    if (ds.ppcreate) return act(() => createAct(ds.ppcreate));
    if (ds.ppmig) { const p = pool(ds.ppmig); return p ? act(() => migrateSheet(p)) : say("That pool is no longer in the list. Nothing was sent.", "note"); }
    if (ds.pptool === "recovery") return act(recoveryTools);
    if (ds.pptool === "backup") return act(() => backupDialog(false));
    if (ds.ppcollectnow) return act(() => Act.collectNow(api(), ui));
    if (ds.ppconfirm) return act(() => Act.confirmSigning(api(), ui, ds.ppconfirm));
    if (ds.pprecover) return act(async () => { say("Checking local reserves and current archive proofs. No transaction is signed.", "note"); await Act.recover(api(), ui, ds.pprecover); S.said = null; });
    if (ds.ppretire) return act(() => Act.retire(api(), ui, ds.ppretire));
    if (ds.ppadd) { const p = pool(ds.ppadd); return p ? act(() => addSheet(p)) : say("That pool is no longer in the list. Nothing was sent.", "note"); }
    if (ds.ppclose) { const p = pool(ds.ppclose); return p ? act(() => Act.withdraw(api(), ui, p)) : say("That pool is no longer in the list. Nothing was sent.", "note"); }
  }

  return Object.assign({ Act, init: (deps) => { D = deps; }, render, onUpdate, reset, tick, part, shared }, core);
});
