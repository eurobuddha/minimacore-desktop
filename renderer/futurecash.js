/*
 * futurecash.js: the screens of Future Cash Next as Pandamonium's NATIVE app draws them (apks/base integrated/futurecash-next
 * MainActivity: the four tabs Guardian, Stakes, Activity, Help, and its dialogs; Design.java's Onyx / Daylight palette
 * behind its own ☀ / ☾ button), expanded to the window, over main/futurecash.js (window.mcd.fc, one named action each).
 * Loaded before app.js: only functions, which use app.js's helpers (el, esc, api, toast, running, since, appDlg,
 * showConfirm) when called. Every amount is the node's own string (trailing zeros trimmed, never rounded); every address
 * and coin id is whole and copies whole on a click. Peer, node and engine text reaches the page through esc() only.
 *
 * Different from the phone, on purpose: no minimaWallet (the desktop has none); Start guardian asks the ONE native
 * question about signing unattended (main.js), and a "Background signing" line takes it back; every action that moves
 * coins by hand is asked first (Lock it, Collect, Collect all, Sweep, Recover, Retire).
 */
"use strict";

let FCN = { tab: "guardian", st: null, stakes: null, stakesError: "", log: [], harden: null, loading: false, audited: false, busy: false };
const FCN_THEME_KEY = "fcnTheme";
const FCN_MXUSD = "0X7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";   // the Minima dollar token: named MxUSD, its id still shown whole
const fcnTheme = () => { try { return localStorage.getItem(FCN_THEME_KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; } };   // Onyx (dark) is the original's default
const fcnAmt = (a) => { const s = String(a == null ? "" : a); return /^\d+\.\d+$/.test(s) ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };   // trailing zeros only: never rounded
const fcnCopy = (v, cls) => `<button class="fcn-copy ${cls || ""}" data-copy="${esc(v)}" title="${th("Click to copy")}">${esc(v)}</button>`;
const fcnSay = (m) => MainSaid.say(String(m || ""));
/** Ui.maturesIn: about how long until a block, at 50 s a block. */
function fcnIn(block, tip) {
  const mins = Math.round(Math.max(0, block - tip) * 50 / 60);
  return mins < 90 ? t("in ~{n} min", { n: mins }) : mins < 1440 ? t("in ~{n} h", { n: Math.round(mins / 60) }) : t("in ~{n} days", { n: Math.round(mins / 1440) });
}
const FCN_PRESETS = [[N_("1 hour"), 72], [N_("1 day"), 1728], [N_("1 week"), 12096], [N_("1 month"), 51840]];
let FCN_LOCK = { amount: "", recipient: "", preset: 1 };

function futureCashReset() { FCN = Object.assign({}, FCN, { st: null, stakes: null, stakesError: "", log: [], harden: null, audited: false }); }
/** Everything the screen draws, read on the main process side; then drawn. The audit runs once on opening (if due). */
async function futureCashLoad(audit) {
  if (!running || FCN.loading) return;
  FCN.loading = true;
  try {
    if (audit && !FCN.audited) { FCN.audited = true; api.fc("audit", false).then(() => futureCashLoad(false), () => {}); }
    const [st, stakes, log] = await Promise.all([api.fc("status").catch(() => null), api.fc("stakes").then(r => ({ r }), (e) => ({ e })), api.fc("activity").catch(() => [])]);
    FCN.st = st; FCN.log = Array.isArray(log) ? log : [];
    if (stakes.r) { FCN.stakes = stakes.r; FCN.stakesError = ""; } else { FCN.stakes = null; FCN.stakesError = ipcError(stakes.e); }
    if (FCN.tab === "guardian" && st && st.started) FCN.harden = await api.fc("harden").catch(() => null);
  } finally { FCN.loading = false; }
  if (activeView === "futurecash") paintFutureCash();
}
function renderFutureCash() { paintFutureCash(); futureCashLoad(true); }

// ---- the Guardian tab ----
function fcnHero(st) {
  const on = st.running, ready = !!(st.safe && st.rescueOn), bad = st.safeReused, risk = st.atRiskKnown || 0;
  let head, body, tone;
  if (!running) { head = t("Not connected"); body = t("Start the embedded node in Minima Core. Nothing can be collected or rescued until you do."); tone = "red"; }
  else if (bad) { head = t("Your safe address is reused"); body = t("Rescued money would land on another exposed key. Set a fresh destination."); tone = "red"; }
  else if (!on) { head = ready ? t("Guardian is off") : t("Guardian needs a destination"); body = ready ? t("Your stakes are only watched while this app is open.") : t("Pick where rescued funds should go, then it can run."); tone = "warn"; }
  else if (risk > 0) { head = t("Watching · at-risk addresses: {n}", { n: risk }); body = t("Anything maturing onto a reused key is collected and swept to safety."); tone = "warn"; }
  else if (!st.autoCollect && st.readySafe.n > 0) { head = t("Auto-collect is OFF · waiting stakes: {n}", { n: st.readySafe.n }); body = t("Matured stakes on clean addresses are NOT collected while auto-collect is off. Turn it on below, or tap Collect all now. At-risk rescue still runs."); tone = "warn"; }
  else { head = t("Protected"); body = t("The guardian is watching your stakes while this app runs.") + (st.autoCollect ? "" : t(" Auto-collect is off, so clean matured stakes will wait for you; at-risk ones are still rescued.")); tone = "safe"; }
  return `<div class="fcn-card fcn-card--${tone}"><div class="fcn-hero"><i class="fcn-dot fcn-bg--${tone}"></i><span class="fcn-hero__t fcn-ink--${tone}">${esc(head)}</span></div>
    <p class="fcn-body">${esc(body)}</p>${st.tip ? `<div class="fcn-div"></div><div class="fcn-foot"><span>${th("chain ")}</span><span class="fcn-mono">${esc(String(st.tip))}</span></div>` : ""}</div>`;
}
function fcnAudit(st) {
  const a = st.audit || {}, v = a.verdict, last = a.last, bad = st.safeReused;
  let msg, tone;
  if (a.running) { msg = t("Auditing your keys…"); tone = "dim"; }
  else if (bad) { msg = t("⚠ Your safe destination is a REUSED address (signed ×{n}). Rescuing there would move your money onto another exposed key: set a fresh destination below.\n\n{address}", { n: bad.count, address: bad.addr }); tone = "red"; }
  else if (last && last.worstReuse > 0) { msg = t("⚠ Key-reuse risk detected (reused ×{n}). At-risk stakes are collected and swept to your safe address.", { n: last.worstReuse }); tone = last.worstReuse > 3 ? "red" : "warn"; }
  else if ((last && last.verdict === "RISK_HEURISTIC") || (st.atRiskList || []).length) { msg = t("Key-reuse risk is recorded for this wallet. Review the key details and your rescue destination."); tone = "warn"; }
  else if (a.error) { msg = fcnSay(a.error) + " " + (v && v.ok ? t("Using your last good audit ({when}): collecting continues.", { when: since(v.at) }) : t("Auto-collect of safe stakes is paused until an audit succeeds; your funds are untouched and stay locked in the contract.")); tone = v && v.ok ? "warn" : "red"; }
  else if (!a.at) { msg = t("No audit yet. Tap Re-audit to check your keys."); tone = "dim"; }
  else if (!v || !v.ok || (last && !last.complete)) { msg = t("The audit is incomplete or out of date. Re-audit before trusting the result."); tone = "warn"; }
  else { msg = t("No known key reuse was found in the checked keys."); tone = "safe"; }
  const meta = !v ? "" : v.mode === "RECONFIRMED" ? t(" · re-checked against your node") : !v.ok ? t(" · needs a fresh audit before safe stakes auto-collect") : "";
  return `<div class="fcn-card"><h3 class="fcn-h">${th("Key audit")}</h3><p class="fcn-ink--${tone} fcn-pre">${esc(msg)}</p>
    ${a.at ? `<p class="fcn-small">${esc(t("audited {when}{meta}", { when: since(a.at), meta }))}</p>` : ""}
    <div class="fcn-row"><button class="fcn-btn fcn-btn--ghost" id="fcnAudit"${a.running ? " disabled" : ""}>${th("Re-audit")}</button></div></div>`;
}
function fcnDaemon(st) {
  const on = st.running, ready = !!(st.safe && st.rescueOn);
  const pill = on ? `<span class="fcn-pill fcn-pill--safe">${th("running")}</span>` : `<span class="fcn-pill fcn-pill--warn">${ready ? th("off") : th("needs setup")}</span>`;
  const body = on ? t("Watching your stakes while this app runs, even with its window closed. Anything maturing onto a reused key is collected and swept to safety within about a block.")
    : !ready ? t("It needs somewhere to move rescued funds before it can run. Start guardian will ask: a fresh address on this node takes one click.")
    : t("Off. After a stake matures, anyone can collect it (that needs no signature), which lands the money on its payout address. If that address's key was reused, it sits there exposed until you act. With the guardian on, it is moved to safety within about a block of landing.");
  return `<div class="fcn-card"><div class="fcn-row fcn-row--split"><span class="fcn-label">${th("Guardian daemon")}</span>${pill}</div><p class="fcn-body">${esc(body)}</p>
    ${on && st.safe ? `<div class="fcn-div"></div><div class="fcn-foot"><span>${th("sweeps to")}</span><span>${esc(st.sameNode ? t("this node") : t("external"))}</span></div>${fcnCopy(st.safe, "fcn-copy--dim")}` : ""}
    <div class="fcn-div"></div><div class="fcn-foot"><span>${th("Unattended minimum")}</span><span class="fcn-mono">${esc(fcnAmt(st.minAuto || "1"))} MINIMA</span><button class="fcn-link" id="fcnMinAuto">${th("Change")}</button></div>
    <p class="fcn-small">${th("The guardian collects and sweeps by itself only MINIMA coins of at least this amount. Smaller ones, and tokens, wait for you: Collect on the Stakes tab, Sweep or Recover on this tab.")}</p>
    ${st.classic ? `<div class="fcn-foot"><span>${th("Daily signature limit per address")}</span><span class="fcn-mono">${esc(String(st.signCap))}</span><button class="fcn-link" id="fcnSignCap">${th("Change")}</button></div>
    <p class="fcn-small">${th("Each unattended sweep signs with that address's one-time key. Past this many in a day the guardian waits until the next day; a Sweep by hand still works.")}</p>` : ""}
    <div class="fcn-div"></div><div class="fcn-foot"><span>${th("Background signing")}</span><span class="fcn-ink--${st.granted ? "safe" : "dim"}">${esc(st.granted ? t("allowed for this wallet") : t("not allowed"))}</span></div>
    <div class="fcn-row">${on ? `<button class="fcn-btn fcn-btn--ghost" id="fcnStop">${th("Stop guardian")}</button>` : `<button class="fcn-btn fcn-btn--cta" id="fcnStart"${running ? "" : " disabled"}>${th("Start guardian")}</button>`}
      ${st.granted ? `<button class="fcn-btn fcn-btn--ghost" id="fcnRevoke">${th("Take back background signing")}</button>` : ""}</div></div>`;
}
function fcnSafe(st) {
  const r = st.readySafe || { n: 0, total: "0" };
  return `<div class="fcn-card"><h3 class="fcn-h">${th("Ready to collect: SAFE")}</h3>
    <p class="fcn-dim">${esc(r.n > 0 ? t("{amount} MINIMA · matured stakes on clean addresses: {n}", { amount: fcnAmt(r.total), n: r.n }) : t("No safe matured stakes right now."))}</p>
    <p class="fcn-ink--${st.autoCollect ? "safe" : "warn"} fcn-small2">${esc(st.autoCollect ? t("Auto-collect is ON: matured stakes are collected to your own address. There's no rush: until then they stay safely locked away.") : t("Auto-collect is OFF: the guardian will not collect these. They stay safely locked in the contract until you act."))}</p>
    <div class="fcn-col">${st.autoCollect ? `<button class="fcn-btn fcn-btn--ghost" id="fcnAutoOff">${th("Turn off")}</button>` : `<button class="fcn-btn fcn-btn--tint fcn-tint--safe" id="fcnAutoOn">${th("Turn on auto-collect")}</button>`}
      ${r.n > 0 ? `<button class="fcn-btn fcn-btn--ghost" id="fcnCollectAll">${th("Collect all now")}</button>` : ""}</div></div>`;
}
function fcnRisk(st) {
  const r = st.readyRisk || { n: 0 }, p = st.pendRisk || { n: 0 }, any = st.atRiskKnown > 0 || r.n > 0 || p.n > 0;
  const detail = r.n > 0 ? t("{amount} MINIMA · matured stakes paying reused addresses: {n}. Rescuing to safety now.", { amount: fcnAmt(r.total), n: r.n })
    : p.n > 0 ? t("{amount} MINIMA · at-risk stakes: {n} (soonest {when}). The guardian collects and sweeps each the moment it matures.", { amount: fcnAmt(p.total), n: p.n, when: fcnIn(p.soonest, st.tip) })
    : any ? t("No at-risk stakes right now: the guardian is watching and acts the moment one matures.") : t("No at-risk stakes detected.");
  const where = st.sameNode ? t("this node") : t("external");
  return `<div class="fcn-card${r.n > 0 ? " fcn-card--warn" : ""}"><h3 class="fcn-h">${th("At-risk stakes")}</h3><p class="fcn-dim">${esc(detail)}</p>
    ${st.safe ? `<p class="fcn-ink--${st.rescueOn ? "safe" : "dim"} fcn-small2">${esc(st.rescueOn ? t("rescue ON → {where}", { where }) : t("destination: {where}", { where }))}</p>${fcnCopy(st.safe, st.rescueOn ? "fcn-copy--safe" : "fcn-copy--dim")}` : ""}
    ${st.vaultLocked ? `<p class="fcn-ink--warn fcn-small2">${th("🔒 vault locked: unlock your node to sweep")}</p>` : ""}
    <div class="fcn-col"><button class="fcn-btn fcn-btn--tint fcn-tint--accent" id="fcnRescue"${running ? "" : " disabled"}>${st.safe ? th("Change destination") : th("Set up rescue…")}</button>
      ${st.rescueOn ? `<button class="fcn-btn fcn-btn--ghost" id="fcnStopRescue">${th("Stop rescue")}</button>` : ""}</div></div>`;
}
function fcnRecover(h) {
  const n = (h && h.stuck || []).reduce((a, s) => a + s.coins, 0);
  if (!n) return "";
  return `<div class="fcn-card fcn-card--warn"><h3 class="fcn-h fcn-ink--warn">${esc(t("⚠ Coins stuck on retired addresses: {n}", { n }))}</h3>
    <p class="fcn-dim fcn-small2">${th("Retiring nulled those addresses' keys, so ordinary sends can't spend them. Recover moves them to your clean address using each address's real key.")}</p>
    <button class="fcn-btn fcn-btn--tint fcn-tint--warn" id="fcnRecover">${esc(t("Recover coins: {n}", { n }))}</button></div>`;
}
function fcnHarden(h) {
  if (!h || !h.list || !h.list.length) return "";
  const rows = h.list.filter(r => r.isDefault).map(r => `<div class="fcn-inset"><div class="fcn-grow">${fcnCopy(r.mx || r.hex)}
      <div class="fcn-small fcn-ink--${r.coins ? "warn" : "dim"}">${esc(r.coins ? t("Coins held: {n}. Sweep them off first.", { n: r.coins }) : t("empty · ready to retire"))}</div></div>
      ${r.coins ? `<button class="fcn-btn fcn-btn--tint fcn-tint--safe" data-fcn-sweep="${esc(r.hex)}">${th("Sweep")}</button>` : `<button class="fcn-btn fcn-btn--ghost" data-fcn-retire="${esc(r.hex)}">${th("Retire")}</button>`}</div>`).join("");
  return `<div class="fcn-card fcn-card--warn"><h3 class="fcn-h">${th("Harden: retire reused addresses")}</h3>
    <p class="fcn-dim fcn-small2">${th("Your node routes change to a random pick of its default addresses, so a reused one keeps receiving fresh money. Retiring drops it from that rotation for good: kept watch-only, moves no funds.")}</p>
    ${rows || `<p class="fcn-ink--safe fcn-small2">${th("✓ All your reused addresses are already out of the change rotation.")}</p>`}
    <p class="fcn-small">${th("Retiring survives restarts but NOT a reinstall-from-seed: re-run it after any reseed. Restart your node afterwards to top the change pool back up.")}</p>
    ${(h.retired || []).length ? `<div class="fcn-div"></div><div class="fcn-label">${th("Retired here")}</div>${h.retired.map(r => fcnCopy(r.address, "fcn-copy--dim")).join("")}` : ""}</div>`;
}
function fcnKeys(st) {
  const a = st.audit && st.audit.last;
  if (!a) return `<div class="fcn-card"><h3 class="fcn-h">${th("Key detail")}</h3><p class="fcn-dim fcn-small2">${th("Run an audit to see every key's on-chain usage.")}</p></div>`;
  const unknown = (a.rows || []).filter(r => r.family !== "classic" && r.family !== "block").length;
  const rows = (a.rows || []).map(r => {
    const tone = r.reused ? "red" : r.risk || !r.checked ? "warn" : "text";
    const verdict = r.reused ? t("  RE-USED ×{n}", { n: r.reuseCount }) : r.risk ? t("  AT RISK") : r.checked ? t("  No known reuse") : t("  Not fully checked");
    return `<div class="fcn-keyrow"><div class="fcn-small">${esc(r.family === "classic" ? t("Classic · counter {n}", { n: r.local }) : r.family === "block" ? t("Block · leaf position {n}", { n: r.local }) : t("Unknown key type · {n}", { n: r.local }))}</div>
      <div class="fcn-row"><b>#${esc(String(r.index))}</b><b class="fcn-ink--${tone}">${esc(verdict)}</b></div>${fcnCopy(r.address, "fcn-copy--dim")}</div>`;
  }).join("");
  return `<div class="fcn-card"><h3 class="fcn-h">${th("Key detail")}</h3>
    <p class="fcn-dim fcn-small2">${esc(t("Classic keys: {classic} · Block keys: {block}", { classic: a.classicKeys, block: a.blockKeys }) + (unknown ? t(" · Unknown: {n}", { n: unknown }) : ""))}</p>
    <p class="fcn-dim fcn-small2">${th("Both key sets are checked for known signature reuse. The spend-count estimate applies to classic keys only; block keys use leaf positions.")}</p>
    ${rows}<p class="fcn-small">${th("Only your PUBLIC keys are ever sent to the audit service: they can't be used to take your money.")}</p></div>`;
}

// ---- the Stakes tab ----
function fcnStakes() {
  const s = FCN.stakes, list = (s && s.stakes) || [], tip = (s && s.tip) || 0, ready = list.filter(x => x.ready).length;
  const rows = list.map(x => `<div class="fcn-inset"><div class="fcn-grow">
      <div class="fcn-row"><span class="fcn-amt">${esc(fcnAmt(x.amount))}</span><span class="fcn-unit">${x.tokenid === "0x00" ? " MINIMA" : x.tokenid.toUpperCase() === FCN_MXUSD ? " MxUSD" : esc(t(" token"))}</span>${x.atRisk ? `<span class="fcn-pill fcn-pill--warn">${th("reused payout")}</span>` : ""}</div>
      ${x.tokenid === "0x00" ? "" : fcnCopy(x.tokenid, "fcn-copy--dim")}
      <div class="fcn-small2 fcn-ink--${x.ready ? "safe" : "dim"}">${esc(x.ready ? t("ready to collect") : t("unlocks {when}", { when: fcnIn(x.matureBlock, tip) }))}</div>
      <div class="fcn-small fcn-mono">${esc(t("block {block} →", { block: x.matureBlock }))}</div>${fcnCopy(x.payout, "fcn-copy--dim")}
      <div class="fcn-small">${th("coin")}</div>${fcnCopy(x.coinid, "fcn-copy--dim")}</div>
      ${x.ready && !x.atRisk ? `<button class="fcn-btn fcn-btn--ghost" data-fcn-collect="${esc(x.coinid)}">${th("Collect")}</button>` : ""}</div>`).join("");
  const p = FCN_PRESETS[FCN_LOCK.preset];
  return `<div class="fcn-card"><div class="fcn-row fcn-row--split"><span class="fcn-label">${th("Your stakes")}</span>${list.length ? `<span class="fcn-pill fcn-pill--${ready ? "safe" : "dim"}">${esc(ready ? t("Ready: {n}", { n: ready }) : t("Pending: {n}", { n: list.length }))}</span>` : ""}</div>
      <p class="fcn-body">${th("Scans this node. Collections return to the original payout address.")}</p>
      ${FCN.stakesError ? `<p class="fcn-ink--red fcn-small2" role="alert">${esc(FCN.stakesError)}</p><button class="fcn-btn fcn-btn--ghost" id="fcnRetry">${th("Retry")}</button>` : list.length ? rows : s ? `<p class="fcn-body">${th("No stakes yet. Lock one below and it appears here, soonest to unlock first.")}</p>` : `<p class="fcn-body">${th("Reading your stakes and keys from Minima Core.")}</p>`}</div>
    <div class="fcn-card"><h3 class="fcn-h">${th("Lock a new payment")}</h3>
      <input class="fcn-field fcn-mono" id="fcnAmount" inputmode="decimal" autocomplete="off" placeholder="${th("Amount (MINIMA)")}" aria-label="${th("Amount (MINIMA)")}" value="${esc(FCN_LOCK.amount)}">
      <div class="fcn-row fcn-presets" role="group">${FCN_PRESETS.map((q, i) => `<button class="fcn-btn fcn-btn--ghost${i === FCN_LOCK.preset ? " fcn-btn--on" : ""}" data-fcn-preset="${i}" aria-pressed="${i === FCN_LOCK.preset}">+${esc(t(q[0]))}</button>`).join("")}</div>
      <p class="fcn-dim fcn-small2" id="fcnPreview">${esc(t("Unlocks in ~{when} · {blocks} blocks", { when: t(p[0]), blocks: p[1] }))}</p>
      <input class="fcn-field" id="fcnRecipient" autocomplete="off" spellcheck="false" placeholder="${th("Recipient Mx… (leave blank to pay yourself)")}" aria-label="${th("Recipient Mx… (leave blank to pay yourself)")}" value="${esc(FCN_LOCK.recipient)}">
      <button class="fcn-btn fcn-btn--cta" id="fcnLock"${running ? "" : " disabled"}>${th("Lock it")}</button>
      <p class="fcn-small">${th("Once locked, nobody (not even you) can unlock it early. Collected coins can ONLY go to the payout address; that is enforced on-chain.")}</p></div>`;
}

// ---- Activity and Help ----
function fcnActivity() {
  const rows = FCN.log.map(e => { const [head, rest] = String(e.msg || "").split(/ \| ([\s\S]*)/); const tone = e.level === "error" ? "red" : e.level === "warn" ? "warn" : "text";
    return `<div class="fcn-logrow"><div class="fcn-ink--${tone}">${esc(head)}</div>${rest ? `<div class="fcn-small fcn-sel">${esc(rest)}</div>` : ""}<div class="fcn-small">${esc(since(e.ts))}</div></div>`; }).join("");
  return `<div class="fcn-card"><h3 class="fcn-h">${th("Activity")}</h3>${rows || `<p class="fcn-dim fcn-small2">${th("Nothing yet. Every collect, sweep and recovery shows here with full coin ids and addresses.")}</p>`}
    <button class="fcn-btn fcn-btn--ghost" id="fcnReset">${th("Reset history")}</button></div>`;
}
const FCN_HELP = [[N_("The 30-second version"), N_("1. Start the node.\n2. Start the guardian on the Guardian tab and choose a rescue destination.\n3. Stakes tab: enter an amount, pick when it unlocks, press Lock it.\n4. Enable auto-collect for safe matured stakes, or collect them yourself when ready.\n\nThe guardian rescues at-risk stakes to the configured destination.")],
  [N_("Why there's a guardian: it's a race"), N_("Minima signs with one-time keys. Signing twice with the same one leaks it, and that address is then exposed forever.\n\nYour money can never be stolen AT collection: the chain only lets a collected coin go to the payout address you chose when locking. The risk is what happens after it lands.\n\nAnd you don't control when it lands. Collecting a matured stake needs NO signature, so anyone can do it, including someone holding a leaked key, who has every reason to collect your stake onto the address they can forge for, then take it.\n\nSo the guardian's job is to be the one who collects, with the sweep already moving:\n\n• Clean payout → collected normally, straight to your node.\n• Reused payout → collected AND swept onward in the same pass, no waiting for a confirmation, then checked that it arrived.\n\nThat is why it needs a destination before it will run at all: a guardian with nowhere to sweep to can't win the race, it can only watch.")],
  [N_("If the audit service is down"), N_("Safe collection requires a complete audit. A result stays fresh for 30 minutes. After that, the app re-checks this node's key set and counters; an unchanged result can be used for up to 24 hours. Changed or unavailable keys pause safe collection. Local checks cannot detect new reuse by another copy of your seed; fresh online audits are still needed.")],
  [N_("My stake matured but nothing happened"), N_("In order of likelihood:\n① The node is not running.\n② The guardian isn't started.\n③ At-risk stake: rescue isn't set up, or your vault is locked.\n④ Your safe destination was flagged REUSED: set a fresh one.\n⑤ Auto-collect is off: use Collect on the stake itself.\n\nNothing is lost by waiting: matured coins stay locked to your payout address until collected.")],
  [N_("The Harden panel"), N_("Your node routes change to a random pick of its default addresses. If a reused one is still in that rotation, fresh money keeps landing on it. Sweep the coins off, then Retire the address, then restart your node. Two minutes.")]];

// ---- the screen ----
function paintFutureCash() {
  const host = el("futurecashBody"); if (!host) return;
  const st = FCN.st, dark = fcnTheme() === "dark", focus = document.activeElement && document.activeElement.id;
  const tabs = [["guardian", t("Guardian")], ["stakes", t("Stakes")], ["activity", t("Activity")], ["help", t("Help")]];
  let body;
  if (!running) body = `<div class="fcn-banner" role="status">${th("The node is not running. Start it on the Node tab. Until then nothing can be collected or rescued.")}</div>`;
  else if (st && !st.started) body = `<div class="fcn-banner" role="alert">${esc(st.error ? fcnSay(st.error) : t("Checking…"))}</div>`;
  else body = "";
  if (st && st.started && st.tooMany) body += `<div class="fcn-banner" role="status">${th("More than 5,000 stakes are at the contract address for this node, so new stakes are not detected. Stakes found before are still followed and swept.")}</div>`;
  if (FCN.tab === "help") body += FCN_HELP.map(([h, b]) => `<div class="fcn-card"><h3 class="fcn-h">${esc(t(h))}</h3><p class="fcn-dim fcn-pre fcn-small2">${esc(t(b))}</p></div>`).join("");
  else if (st && st.started) body += FCN.tab === "stakes" ? fcnStakes() : FCN.tab === "activity" ? fcnActivity()
    : fcnHero(st) + fcnAudit(st) + fcnDaemon(st) + fcnSafe(st) + fcnRisk(st) + fcnRecover(FCN.harden) + fcnHarden(FCN.harden) + fcnKeys(st);
  host.innerHTML = `<div class="fcn" data-theme="${dark ? "dark" : "light"}"><div class="fcn-wrap">
    <header class="fcn-head"><div class="fcn-grow"><h1 class="fcn-title">Future Cash</h1><div class="fcn-sub">${th("time-locked payments, key-reuse safe")}</div></div>
      <button class="fcn-theme" id="fcnTheme" aria-label="${dark ? th("Use light theme") : th("Use dark theme")}">${dark ? "☀" : "☾"}</button></header>
    <div class="fcn-tabs" role="tablist">${tabs.map(([id, label]) => `<button class="fcn-tab${FCN.tab === id ? " fcn-tab--on" : ""}" role="tab" aria-selected="${FCN.tab === id}" data-fcn-tab="${id}">${esc(label)}</button>`).join("")}</div>
    <div class="fcn-content">${body}</div></div></div>`;
  fcnWire(host);
  if (focus && el(focus)) el(focus).focus();
}
function fcnWire(host) {
  const on = (id, fn) => { const b = el(id); if (b) b.onclick = fn; };
  on("fcnTheme", () => { try { localStorage.setItem(FCN_THEME_KEY, fcnTheme() === "dark" ? "light" : "dark"); } catch (e) {} paintFutureCash(); });
  host.querySelectorAll("[data-fcn-tab]").forEach(b => b.onclick = () => { FCN.tab = b.dataset.fcnTab; paintFutureCash(); futureCashLoad(false); });
  on("fcnAudit", () => fcnAct(() => api.fc("audit", true), null));
  on("fcnStart", fcnStart);
  on("fcnSignCap", () => { const d = appDlg({ title: t("Daily signature limit per address"), cls: "adlg--fcn", body: `<input class="fcn-field fcn-mono" id="fcnCapIn" inputmode="numeric" autocomplete="off" aria-label="${th("Daily signature limit per address")}" value="${esc(String((FCN.st && FCN.st.signCap) || 50))}">`,
    buttons: [{ label: t("Save"), on: (root, close) => close(root.querySelector("#fcnCapIn").value.trim()) }, { label: t("Cancel"), v: null, neutral: true }] });
    d.done.then((v) => { if (v != null) fcnAct(() => api.fc("signCap", v), null); }); });
  on("fcnMinAuto", () => { const d = appDlg({ title: t("Unattended minimum"), cls: "adlg--fcn", body: `<p class="adlg__text">${th("The guardian collects and sweeps by itself only MINIMA coins of at least this amount.")}</p><input class="fcn-field fcn-mono" id="fcnMinIn" inputmode="decimal" autocomplete="off" aria-label="${th("Amount (MINIMA)")}" value="${esc((FCN.st && FCN.st.minAuto) || "1")}">`,
    buttons: [{ label: t("Save"), on: (root, close) => close(root.querySelector("#fcnMinIn").value.trim()) }, { label: t("Cancel"), v: null, neutral: true }] });
    d.done.then((v) => { if (v != null) fcnAct(() => api.fc("minAuto", v), null); }); });
  on("fcnStop", async () => { if (await fcnRetiredOk()) fcnAct(() => api.fc("guardian", false), null); });
  on("fcnRevoke", async () => { if (await showConfirm(t("Take back background signing?"), t("Future Cash Next then signs nothing by itself, and the guardian stops. You can still collect and sweep by hand.") + fcnRetiredNote(), t("Take back"), true)) fcnAct(() => api.fc("revoke"), null); });
  on("fcnAutoOn", () => fcnAct(() => api.fc("autoCollect", true), null));
  on("fcnAutoOff", () => fcnAct(() => api.fc("autoCollect", false), null));
  on("fcnCollectAll", async () => { if (await showConfirm(t("Collect all now"), t("Every matured stake on a clean address is collected to its own payout address."), t("Collect"))) fcnAct(() => api.fc("collectAll"), (r) => (r.done ? t("Collection requests posted: {n}. They confirm in about a block.", { n: r.done }) : fcnSay(r.error || t("Nothing to collect.")))); });
  on("fcnRescue", () => fcnRescueDialog(false));
  on("fcnStopRescue", () => fcnAct(() => api.fc("stopRescue"), null));
  on("fcnRecover", async () => { if (await showConfirm(t("Recover coins"), t("The coins on retired addresses are moved to your rescue destination, one signature each, with each address's own key."), t("Recover"))) fcnAct(() => api.fc("recover"), (r) => (r.swept ? t("Recovered {n} coin(s) to {address}", { n: r.swept, address: r.dest }) : fcnSay(r.error || t("Nothing to recover.")))); });
  host.querySelectorAll("[data-fcn-sweep]").forEach(b => b.onclick = async () => { const a = b.dataset.fcnSweep; if (await showConfirm(t("Sweep"), t("Every coin on this address is moved to your rescue destination, one signature each:\n{address}", { address: a }), t("Sweep"))) fcnAct(() => api.fc("sweep", a), (r) => (r.swept ? t("Swept {n} coin(s) → {address}", { n: r.swept, address: r.dest }) : fcnSay(r.error || t("Nothing swept.")))); });
  host.querySelectorAll("[data-fcn-retire]").forEach(b => b.onclick = async () => { const a = b.dataset.fcnRetire, apps = await api.fc("handedOut", a).catch(() => []);
    const warn = (apps && apps.length ? "\n\n" + t("This address was handed out as their own by: {apps}. A payment sent to it after it is retired lands on a key ordinary sends cannot use; the running guardian moves it to your safe address.", { apps: apps.join(", ") }) : "")
      + "\n\n" + t("Chat gives each contact whichever address the node offers at that moment, so this one may have been shared there too.");
    if (await showConfirm(t("Retire"), t("This address is taken out of the node's change rotation for good and kept watch-only. It moves no funds:\n{address}", { address: a }) + warn, t("Retire"), true)) fcnAct(() => api.fc("retire", a), () => t("Retired: change will never land there again.")); });
  host.querySelectorAll("[data-fcn-collect]").forEach(b => b.onclick = async () => { const id = b.dataset.fcnCollect, x = ((FCN.stakes && FCN.stakes.stakes) || []).find(s => s.coinid === id); if (!x) return;
    if (await showConfirm(t("Collect"), t("{amount} MINIMA is collected to its payout address:\n{address}\n\ncoin {coin}", { amount: fcnAmt(x.amount), address: x.payout, coin: x.coinid }), t("Collect"))) fcnAct(() => api.fc("collect", id), () => t("Collect posted: confirms in about a block.")); });
  host.querySelectorAll("[data-fcn-preset]").forEach(b => b.onclick = () => { fcnKeep(); FCN_LOCK.preset = +b.dataset.fcnPreset; paintFutureCash(); });
  for (const id of ["fcnAmount", "fcnRecipient"]) { const f = el(id); if (f) f.oninput = fcnKeep; }
  on("fcnLock", fcnLock);
  on("fcnRetry", () => futureCashLoad(false));
  on("fcnReset", async () => { if (await showConfirm(t("Reset history?"), t("Clears the log and completed records. Keeps in-flight rescues and your safe address. Moves no funds: your coins and locks live on the chain."), t("Reset"), true)) fcnAct(() => api.fc("resetHistory"), null); });
}
/** Retired addresses exist: stopping the guardian means a payment to one is no longer swept by itself (review L3). */
function fcnRetiredNote(st) { const n = ((st || FCN.st) || {}).retired || 0; return n ? "\n\n" + t("Retired addresses: {n}. With the guardian stopped, a payment to one of them is no longer moved to your safe address by itself; it waits for Recover by hand.", { n }) : ""; }
async function fcnRetiredOk(st) { const note = fcnRetiredNote(st); return !note || showConfirm(t("Stop guardian"), note.trim(), t("Stop guardian"), true); }
function fcnKeep() { const a = el("fcnAmount"), r = el("fcnRecipient"); if (a) FCN_LOCK.amount = a.value; if (r) FCN_LOCK.recipient = r.value; }
/** One action at a time: asked of the main process, the answer said, the screen read again. */
async function fcnAct(call, okText) {
  if (FCN.busy) return;
  FCN.busy = true;
  try {
    const r = await call();
    if (r && r.ok === false && !r.declined) toast(fcnSay(r.error || ""), "err");
    else if (r && r.declined) toast(t("Nothing is signed by itself. The guardian stays off."));
    else if (okText) toast(okText(r || {}));
    return r;
  } catch (e) { toast(ipcError(e), "err"); }
  finally { FCN.busy = false; futureCashLoad(false); }
}
async function fcnStart() {
  const st = FCN.st || {};
  if (!(st.safe && st.rescueOn)) { toast(t("Pick where rescued funds should go: the guardian needs a destination.")); return fcnRescueDialog(true); }
  const r = await fcnAct(() => api.fc("guardian", true), () => t("Guardian started: watching your stakes."));
  return r;
}
/** The rescue setup: a fresh clean address on this node, or an external wallet's Mx (checked for reuse first). */
function fcnRescueDialog(thenStart) {
  const d = appDlg({ title: t("Rescue at-risk stakes"), cls: "adlg--fcn", body: `<p class="adlg__text"><b>${th("Where should rescued funds land?")}</b></p><p class="adlg__text">${th("Best if you only have one device: funds stay on this node at a brand-new unused address.")}</p>
      <input class="fcn-field" id="fcnExt" autocomplete="off" spellcheck="false" placeholder="${th("…or an Mx address from a DIFFERENT wallet")}" aria-label="${th("…or an Mx address from a DIFFERENT wallet")}">`,
    buttons: [{ label: t("Fresh address on THIS node"), v: "local" }, { label: t("Use external"), on: (root, close) => close("ext:" + root.querySelector("#fcnExt").value.trim()) }, { label: t("Cancel"), v: null, neutral: true }] });
  d.done.then(async (v) => {
    if (!v) return;
    let r;
    if (v === "local") r = await fcnAct(() => api.fc("safeSameNode"), (x) => t("Rescue ON → {address}", { address: x.value }));
    else { toast(t("Checking that address is clean…")); r = await fcnAct(() => api.fc("safeExternal", v.slice(4)), (x) => t("Rescue ON → external {address}{check}", { address: x.value, check: x.verified ? t(" (verified clean)") : t(" (reuse check unverified, will re-check)") })); }
    if (r && r.ok && thenStart) fcnStart();
  });
}
async function fcnLock() {
  fcnKeep();
  const p = FCN_PRESETS[FCN_LOCK.preset], amount = FCN_LOCK.amount.trim(), recipient = FCN_LOCK.recipient.trim();
  if (!(await showConfirm(t("Lock it"), t("Lock {amount} MINIMA for {blocks} blocks (about {when}), payable only to:\n{to}\n\nNobody, not even you, can unlock it early.", { amount, blocks: p[1], when: t(p[0]), to: recipient || t("a fresh address of this node") }), t("Lock it")))) return;
  const r = await fcnAct(() => api.fc("lock", amount, p[1], recipient), (x) => t("✓ Locked {amount} MINIMA · matures block {block}", { amount: x.amount, block: x.matBlock }));
  if (r && r.ok) { FCN_LOCK.amount = ""; FCN_LOCK.recipient = ""; if (activeView === "futurecash") paintFutureCash(); }
}
