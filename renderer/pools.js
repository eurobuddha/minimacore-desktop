/*
 * pools.js — the PandaPools panel, rebuilt to the PandaPools APK's own look and feel.
 *
 * Source of truth for the visuals: apks/pandapools Design.java (CURRENT column) + Ui.java + the view_*.xml roots.
 * Two traps from the teardown are honoured deliberately: Ui.radiusPx FLOORS the radius at 10dp (Design.radiusDp()'s
 * 6 is a decoy only WalletView uses), and Design.labelTracking()/upperLabels() are never called — spacing and
 * casing are hard-coded per view, so they are NOT variables here either.
 *
 * NOTHING that moves value changed in this rewrite. Every engine call (api.ppQuote / ppSwap / ppCreate / ppDeposit /
 * ppMigrate / ppClose / ppCollect / ppRecoverSaved / ppConfirmSigning / ppRestore …), every validation, every
 * confirm-before-send dialog and every busy guard is carried over verbatim from renderer/app.js. This is a
 * presentation rewrite; the swap still posts the EXACT frozen quote it showed you.
 *
 * Same shape as renderer/mail.js: one global, dependency-injected, no reach-out into app.js.
 */
(function (g) {
  "use strict";

  // ---- injected dependencies (renderer/app.js owns these) ----
  var api, esc, el, toast, copy, short, TOK, showConfirm, showProgress, tryCmd, PoolCalc;
  var MINIMA = "0x00";
  var running = function () { return false; };
  var activeView = function () { return ""; };

  let ppView = "swap";            // swap | pools | mylp | activity
  let ppPoolsMode = "indiv";      // Pools tab: "indiv" = per-pool list | "combined" = one collective card per token
  let ppPoolsRenderSeq = 0;       // guards against a fast toggle: a stale in-flight render is dropped, not painted
  let PP_POOLS = [];
  let PP_MINE = [];               // my owned pools (for the LP-management sheets)
  let PP_SWAP_TOKS = [];          // [{tok,name}] pairs available to trade
  let ppSwapMinToTok = true;      // true = pay MINIMA get token; false = pay token get MINIMA

  // The APK's header row (PoolsActivity.header): 17sp bold accent wordmark, a 9sp tracked sub-line, the ◐ STYLE
  // pill and the live block number — then the tab strip, whose colours are HARD-CODED in the APK and deliberately
  // do NOT follow the style toggle. Parity means reproducing that.
  function ppHeader(active) {
    const tab = (id, label) => `<button class="pp-tab${active === id ? " is-on" : ""}" data-ppview="${id}">${label}</button>`;
    return `<div class="pp-head">
        <div class="pp-brand"><div class="pp-name">PandaPools</div><div class="pp-sub">LIQUIDITY POOLS${PP_VER ? " · v" + esc(PP_VER) : ""}</div></div>
        <button class="pp-stylebtn" id="ppStyleBtn" title="Switch between the Current and Original look">◐ STYLE</button>
        <div class="pp-blk" id="ppBlk">${PP_BLOCK ? "#" + PP_BLOCK : ""}</div>
      </div>
      <div class="pp-tabs">${tab("swap", "SWAP")}${tab("pools", "POOLS")}${tab("mylp", "MY LP")}${tab("activity", "ACTIVITY")}</div>`;
  }
  function wirePpHeader() {
    document.querySelectorAll("#ppBody [data-ppview]").forEach(b => b.onclick = () => { ppView = b.dataset.ppview; renderPandapools(); });
    const s = el("ppStyleBtn"); if (s) s.onclick = ppToggleStyle;
    ppApplyStyle();
    ppRefreshBlock();
  }
  // ◐ STYLE — the APK's own two looks (dark "Current" ⇄ white, hard-edged, monospace "Original"). Independent of
  // the desktop shell's light/dark button, exactly as on the phone.
  let PP_STYLE = (() => { try { return localStorage.getItem("pp_style") === "original" ? "original" : "current"; } catch (e) { return "current"; } })();
  function ppApplyStyle() { const w = el("ppBody"); if (w) w.setAttribute("data-ppstyle", PP_STYLE); }
  function ppToggleStyle() {
    PP_STYLE = PP_STYLE === "original" ? "current" : "original";
    try { localStorage.setItem("pp_style", PP_STYLE); } catch (e) {}
    ppApplyStyle();
  }
  let PP_VER = "", PP_BLOCK = 0;
  async function ppRefreshBlock() {
    try { const b = await tryCmd("block"); PP_BLOCK = parseInt((b && (b.block != null ? b.block : b)), 10) || PP_BLOCK; } catch (e) {}
    const e2 = el("ppBlk"); if (e2 && PP_BLOCK) e2.textContent = "#" + PP_BLOCK;
  }
  async function renderPandapools() {
    const host = el("ppBody");
    if (!running()) { host.innerHTML = `${ppHeader(ppView)}<div class="pp-empty">Waiting for the node…</div>`; wirePpHeader(); return; }
    if (ppView === "pools") return renderPpPools();
    if (ppView === "mylp") return renderPpMyLP();
    if (ppView === "activity") return renderPpActivity();
    return renderPpSwap();
  }
  function ppPairRows(pools) {
    // group discovered pools by token (each group = one MINIMA/token pair)
    const groups = {};
    pools.forEach(p => { (groups[p.tok] = groups[p.tok] || []).push(p); });
    const keys = Object.keys(groups);
    if (!keys.length) return `<div class="pp-empty">No pools discovered yet. They appear as the node scans the shared registry — give it a moment after the node reaches the tip.</div>`;
    return keys.map(tok => {
      const g = groups[tok];
      const name = esc(g[0].tokName || TOK.shortId(tok));
      const rows = g.map(p => `<div class="pp-row pp-row--tap" data-pool="${esc(p.address)}" title="Right-click to copy the pool address">
          <div class="pp-rowmid"><div class="pp-l1">${esc(TOK.tidyAmount(p.reserveM))} MINIMA · ${esc(TOK.tidyAmount(p.reserveT))} ${name}</div>
            <div class="pp-l2">price ${esc(TOK.tidyAmount(p.spot))} ${name}/MINIMA · fees ${esc(TOK.tidyAmount(p.feeGrowthPct))}% · ${esc(short(p.address, 18))}</div></div>
          <div class="pp-rowr">›</div></div>`).join("");
      return `<div class="pp-card"><div class="pp-cardt">MINIMA / ${name} <span class="pp-chip">${g.length} pool${g.length > 1 ? "s" : ""}</span></div>${rows}</div>`;
    }).join("");
  }
  let PP_BAL_MIN = "0", PP_BAL_TOK = "0";
  let PP_USDT_ID = null;          // cached market-fed token id (mxUSDT) for the swap-page MEXC line
  async function renderPpSwap() {
    const host = el("ppBody");
    const pools = await api.ppPools().catch(() => []);
    PP_POOLS = pools;
    const seen = {}; PP_SWAP_TOKS = [];
    pools.forEach(p => { if (p.tok && !seen[p.tok]) { seen[p.tok] = true; PP_SWAP_TOKS.push({ tok: p.tok, name: p.tokName || TOK.shortId(p.tok) }); } });
    if (!PP_SWAP_TOKS.length) {
      host.innerHTML = `${ppHeader("swap")}<div class="pp-empty">No live pools yet — create one in the My LP tab to seed liquidity.</div>`;
      wirePpHeader(); return;
    }
    const opts = PP_SWAP_TOKS.map((t, i) => `<option value="${i}">MINIMA / ${esc(t.name)}</option>`).join("");
    host.innerHTML = `${ppHeader("swap")}
      <div class="pp-card">
        <div class="pp-field"><div class="pp-lbl">POOL</div><select class="pp-input" id="ppSwapTok">${opts}</select></div>
        <div class="pp-desc" id="ppPoolLine">—</div>
        <div class="pp-desc pp-mkt" id="ppSwapMarket" style="display:none"></div>
        <div class="pp-kv"><span class="pp-k">You hold</span><span class="pp-v" id="ppHoldings">—</span></div>
      </div>
      <div class="pp-card">
        <div class="pp-panel">
          <div class="pp-leglbl" id="ppSwapInLbl">YOU PAY</div>
          <input class="pp-amt" id="ppSwapAmt" placeholder="0.0" inputmode="decimal" autocomplete="off" />
          <div class="pp-legbal" id="ppFromBal"></div>
        </div>
        <div class="pp-fliprow"><button class="pp-flip" id="ppFlip" title="Flip the direction">⇅</button></div>
        <div class="pp-panel">
          <div class="pp-leglbl" id="ppSwapOutLbl">YOU RECEIVE</div>
          <div class="pp-amt pp-amt--out" id="ppSwapOut">0.0</div>
          <div class="pp-legbal" id="ppToBal"></div>
        </div>
        <div id="ppQuote"></div>
        <button class="pp-btn pp-btn--fill pp-cta" id="ppSwapGo">REVIEW SWAP</button>
      </div>`;
    wirePpHeader();
    ppSwapMinToTok = true;
    await refreshPpSwapMeta();
    applyPpDir();
    el("ppFlip").onclick = () => { ppSwapMinToTok = !ppSwapMinToTok; applyPpDir(); };
    el("ppSwapTok").onchange = () => { refreshPpSwapMeta().then(applyPpDir); };
    el("ppSwapAmt").oninput = () => ppUpdateQuote();
    el("ppSwapGo").onclick = () => doPpSwap();
  }
  // Pool line (count + aggregate depth) + your holdings for both legs — the liquidity/price context the donor shows.
  async function refreshPpSwapMeta() {
    const sel = el("ppSwapTok"); if (!sel) return;
    const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) return;
    const info = await api.ppPairInfo(t.tok).catch(() => ({ pools: 0, depth: "0" }));
    if (el("ppPoolLine")) el("ppPoolLine").textContent = "MINIMA / " + t.name + " · " + info.pools + (Number(info.pools) === 1 ? " pool" : " pools") + " · depth " + TOK.tidyAmount(info.depth) + " MINIMA";
    const bal = await tryCmd("balance") || [];
    // SENDABLE, not confirmed — confirmed counts coins locked in pools/scripts, so it overstated what you can
    // actually trade (same bug fixed in the wallet). The CREATE flow already uses sendable.
    const bm = bal.find(b => b.tokenid === MINIMA); PP_BAL_MIN = bm ? (bm.sendable || "0") : "0";
    const bt = bal.find(b => b.tokenid && b.tokenid.toLowerCase() === t.tok.toLowerCase()); PP_BAL_TOK = bt ? (bt.sendable || "0") : "0";
    if (el("ppHoldings")) el("ppHoldings").textContent = TOK.tidyAmount(PP_BAL_MIN) + " MINIMA · " + TOK.tidyAmount(PP_BAL_TOK) + " " + t.name;
    if (el("ppFromBal")) { const payTok = ppSwapMinToTok ? "MINIMA" : t.name; el("ppFromBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_MIN : PP_BAL_TOK) + " " + payTok; }
    if (el("ppToBal")) { const getTok = ppSwapMinToTok ? t.name : "MINIMA"; el("ppToBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_TOK : PP_BAL_MIN) + " " + getTok; }
    ppRenderSwapMarket(t);   // MEXC market-comparison line (USDT pairs only) — passive, safe on a block tick
  }
  // The donor's renderSwapMarket: for a MINIMA/USDT pool, show the live MEXC mid + how the blended pool spot compares.
  async function ppRenderSwapMarket(t) {
    const host = el("ppSwapMarket"); if (!host || !t) return;
    if (PP_USDT_ID === null) { try { const mt = await api.ppMarketToken(); PP_USDT_ID = ((mt && mt.usdt) || "").toLowerCase(); } catch (e) { PP_USDT_ID = ""; } }
    const isUsdt = PP_USDT_ID && t.tok && t.tok.toLowerCase() === PP_USDT_ID;
    if (!isUsdt) { host.style.display = "none"; host.textContent = ""; return; }
    host.style.display = "";
    let m = null; try { m = await api.ppMarket(); } catch (e) {}
    if (!el("ppSwapMarket")) return;                                  // view changed during the await
    if (!m || !m.fresh || !m.mid) { host.textContent = "Market price unavailable (MEXC)"; return; }
    let line = "Market ≈ " + TOK.tidyAmount(m.mid) + " USDT/MINIMA (MEXC)";
    let sm = 0, st = 0;
    (PP_POOLS || []).forEach(p => { if (p.tok && p.tok.toLowerCase() === t.tok.toLowerCase()) { sm += parseFloat(p.reserveM) || 0; st += parseFloat(p.reserveT) || 0; } });
    const mid = parseFloat(m.mid);
    if (sm > 0 && mid > 0) {
      const spot = st / sm, pct = (spot - mid) / mid * 100;
      const word = Math.abs(pct) < 0.1 ? "at market" : (Math.abs(pct).toFixed(1) + "% " + (pct > 0 ? "above market" : "below market"));
      line += "  ·  Pool " + spot.toFixed(6) + "  ·  " + word;
    }
    host.textContent = line;
  }
  function applyPpDir() {
    if (!el("ppFlip")) return;
    const t = PP_SWAP_TOKS[(el("ppSwapTok") && el("ppSwapTok").value | 0) || 0];
    const payTok = ppSwapMinToTok ? "MINIMA" : (t ? t.name : "token");
    const getTok = ppSwapMinToTok ? (t ? t.name : "token") : "MINIMA";
    if (el("ppSwapInLbl")) el("ppSwapInLbl").textContent = "YOU PAY · " + payTok;
    if (el("ppSwapOutLbl")) el("ppSwapOutLbl").textContent = "YOU RECEIVE · " + getTok;
    if (el("ppFromBal")) el("ppFromBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_MIN : PP_BAL_TOK) + " " + payTok;
    if (el("ppToBal")) el("ppToBal").textContent = "Balance " + TOK.tidyAmount(ppSwapMinToTok ? PP_BAL_TOK : PP_BAL_MIN) + " " + getTok;
    ppUpdateQuote();
  }
  function ppKv(k, vHtml, green) { return `<div class="pp-kv"><span class="pp-k">${esc(k)}</span><span class="pp-v${green ? " pp-v--ok" : ""}">${vHtml}</span></div>`; }
  let ppQuoteSeq = 0;
  async function ppUpdateQuote() {
    const disp = el("ppQuote"); if (!disp) return;
    const sel = el("ppSwapTok"), amtEl = el("ppSwapAmt"); if (!sel || !amtEl) return;
    const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) return;
    const amt = amtEl.value.trim();
    const outEl = () => el("ppSwapOut");
    if (!/^[0-9]*\.?[0-9]+$/.test(amt) || parseFloat(amt) <= 0) { disp.innerHTML = `<div class="pp-desc">Enter an amount for a live quote.</div>`; if (outEl()) outEl().textContent = "0.0"; return; }
    const seq = ++ppQuoteSeq;                                       // last-write-wins: a newer quote supersedes this one
    const q = await api.ppQuote(t.tok, ppSwapMinToTok, amt).catch(() => ({ ok: false }));
    if (seq !== ppQuoteSeq) return;                                 // a later keystroke already fired a fresher quote
    const d = el("ppQuote"); if (!d) return;                        // view may have changed during the await
    if (!q || !q.ok) { d.innerHTML = `<div class="pp-desc${q && q.notReady ? "" : " pp-desc--warn"}">${q && q.notReady ? "Starting up — one moment…" : "This trade is too large for the pools' depth — try a smaller amount."}</div>`; if (outEl()) outEl().textContent = "0.0"; return; }
    const recvTok = ppSwapMinToTok ? esc(t.name) : "MINIMA";
    let html = "";
    html += ppKv("Rate", "≈ " + esc(TOK.tidyAmount(q.effPrice)) + " " + esc(t.name) + " / MINIMA");
    html += ppKv("Price impact", esc(q.priceImpact) + " %");
    if (Number(q.poolsAvailable) > 1) html += ppKv("Routed across", (Number(q.poolsUsed) || 0) + " of " + (Number(q.poolsAvailable) || 0) + " pools" + (q.capped ? " (top " + (Number(q.maxPools) || 6) + ")" : ""));
    html += ppKv("Pool fee (0.50%)", "kept by LPs");
    html += ppKv("You receive", "≈ " + esc(TOK.tidyAmount(q.totalOut)) + " " + recvTok, true);
    d.innerHTML = html;
    if (outEl()) outEl().textContent = TOK.tidyAmount(q.totalOut);
  }
  let ppSwapBusy = false;
  async function doPpSwap() {
    if (ppSwapBusy) return;                                         // block a double-submit during the pre-confirm quote await
    const sel = el("ppSwapTok"); if (!sel) return;
    const t = PP_SWAP_TOKS[sel.value | 0]; if (!t) { toast("Pick a pool first.", "err"); return; }
    const amt = (el("ppSwapAmt") && el("ppSwapAmt").value || "").trim();
    if (!/^[0-9]*\.?[0-9]+$/.test(amt) || parseFloat(amt) <= 0) { toast("Enter an amount.", "err"); return; }
    ppSwapBusy = true;
    try {
      // A FRESH quote at confirm time = the exact route we'll post (frozen-quote, like the donor's confirmSwap→doSwap).
      const q = await api.ppQuote(t.tok, ppSwapMinToTok, amt).catch(() => ({ ok: false }));
      if (!q || !q.ok || !q.quoteId) { toast(q && q.notReady ? "Starting up — try again in a moment." : "That trade is too large for these pools.", "err"); return; }
      const payLbl = ppSwapMinToTok ? "MINIMA" : t.name, getLbl = ppSwapMinToTok ? t.name : "MINIMA";
      const routed = Number(q.poolsUsed) > 1 ? "\nRouted across " + q.poolsUsed + " pools in one transaction." : "";
      const okc = await showConfirm("Confirm swap",
        "Pay  " + amt + " " + payLbl + "\nReceive  ≈ " + TOK.tidyAmount(q.totalOut) + " " + getLbl +
        "\nRate  ≈ " + TOK.tidyAmount(q.effPrice) + " " + t.name + " / MINIMA\n\nPrice impact " + q.priceImpact + "%." + routed +
        "\n\nThis posts a real on-chain transaction — if a pool moves before it confirms, the swap is rejected and you keep your funds.", "Swap");
      if (!okc) return;
      const prog = showProgress("Swapping " + amt + " " + payLbl, "Posting to the chain — this can take a few seconds…");
      try {
        const r = await api.ppSwap(q.quoteId);                       // posts the EXACT confirmed route (frozen)
        prog.close();
        toast("Swapped ✓ — received " + TOK.tidyAmount(r.totalOut) + " " + getLbl, "ok");
        if (el("ppSwapAmt")) el("ppSwapAmt").value = "";
        if (el("ppSwapOut")) el("ppSwapOut").textContent = "0.0";
        ppUpdateQuote(); refreshPpSwapMeta();
      } catch (e) { prog.close(); toast("Swap failed: " + e.message, "err"); }
    } finally { ppSwapBusy = false; }
  }

  // HTML builders (reused by the initial render AND the live-update patch) + wiring helpers.
  function ppNum(n) { n = Number(n); if (!isFinite(n)) return "0"; return (n.toFixed(4).replace(/\.?0+$/, "")) || "0"; }   // display-only float format
  /** MyLpView.kvColored — same row geometry as ppKv, proportional (not monospace) value, optional tint. */
  function ppKvC(k, vHtml, tone) { return `<div class="pp-kv"><span class="pp-k">${esc(k)}</span><span class="pp-vc${tone ? " pp-vc--" + tone : ""}">${vHtml}</span></div>`; }
  /** K/KMIN is the pool's headroom over its product floor; past 1.85 the APK flips the bar amber and makes
   *  Migrate the filled action. Display only — the threshold changes nothing the engine does. */
  const PP_MIGRATE_AT = 1.85;
  function ppNeedsMigrate(p) { const r = Number(p && p.kratio); return isFinite(r) && r >= PP_MIGRATE_AT; }
  function ppHealthHtml(p) {
    const r = Number(p && p.kratio);
    if (!isFinite(r) || r <= 0) return "";
    const warn = r >= PP_MIGRATE_AT;
    const pct = Math.max(4, Math.min(100, r / 2 * 100));
    return `<div class="pp-health"><div class="pp-health-bar"><div class="pp-health-fill${warn ? " is-warn" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="pp-health-lbl${warn ? " is-warn" : ""}">K/KMIN ${r.toFixed(2)} · ${warn ? "migrate soon" : "healthy"}</div></div>`;
  }
  /** The three equal My-LP actions. Migrate becomes the filled one once the pool is past the floor threshold. */
  function ppActBtn(label, attr, addr, filled, danger) {
    return `<button class="pp-btn pp-btn--sm${filled ? " pp-btn--fill" : ""}${danger ? " pp-btn--danger" : ""}" data-${attr}="${esc(addr)}">${label}</button>`;
  }
  let PP_RETIRED = [];
  let PP_COLLECT = [];
  /** Withdrawn funds still sitting at a payout address. STRANDED means this wallet cannot sign for it at all —
   *  previously that state was entirely silent, which is how 2934.95626348 MxUSD sat unnoticed. */
  function ppCollectHtml() {
    if (!PP_COLLECT.length) return "";
    return PP_COLLECT.map(c => {
      const stranded = c.status === "STRANDED";
      return `<div class="pp-card"><div class="pp-cardt">${stranded ? "Withdrawn funds cannot be moved from this address" : "Withdrawn funds still being moved to your wallet"}</div>`
        + `<div class="pp-desc">${stranded
            ? "This is the address your pool was closed to. PandaPools cannot move the funds because this wallet cannot sign for it &mdash; that address is not one of the 64 addresses a seed phrase rebuilds. Restore the matching complete MinimaCore wallet backup, then use Collect. A seed on its own will not do it."
            : "Your pool's withdrawal landed at its owner payout address and PandaPools is moving it into your wallet. It keeps trying in the background and stops only once the address is empty."}</div>`
        + `<div class="pp-desc" style="overflow-wrap:anywhere;user-select:text">${esc(c.oadr)}</div>`
        + (c.lastError ? `<div class="pp-desc">${esc(c.lastError)}</div>` : "")
        + `<button class="pp-btn" data-ppcollect="1">${stranded ? "Try again" : "Collect now"}</button></div>`;
    }).join("");
  }
  function ppRetiredHtml() {
    if (!PP_RETIRED.length) return "";
    return `<div class="pp-card"><div class="pp-cardt">${PP_RETIRED.length} closed pool(s) kept for recovery</div>`
      + `<div class="pp-desc">Their recipes are still saved and still go into your backups &mdash; they are just out of the way. If a close never actually landed, the pool reappears here on its own.</div>`
      + PP_RETIRED.map(r => `<div class="pp-desc" style="overflow-wrap:anywhere;user-select:text">Pool: ${esc(r.address)}${r.opk ? `<br>Owner key: ${esc(r.opk)}` : ""}</div>`).join("")
      + `<button class="pp-btn" data-ppunretire="all">Bring back</button></div>`;
  }

  function ppMineHtml(mine) {
    if (!mine.length) return ppCollectHtml() + `<div class="pp-empty">You don't own any pools yet. Create one with the button above.</div>` + ppRetiredHtml();
    return ppCollectHtml() + mine.map(p => {
      const nm = esc(p.tokName || TOK.shortId(p.tok));
      const hold=p.signingStateUnverified?`<div class="pp-desc">Owner signing paused. Confirm the latest complete wallet signing state and stop other signing copies.</div><button class="pp-btn" data-ppconfirm="${esc(p.opk)}">Confirm wallet state</button>`:"";
      // Both identifiers, always LABELLED. An address and an owner key are indistinguishable as raw hex,
      // which is how one pool read as two problems on the other surfaces.
      const ids=`<div class="pp-desc" style="overflow-wrap:anywhere;user-select:text">Pool: ${esc(p.address)}${p.opk?`<br>Owner key: ${esc(p.opk)}`:""}</div>`;
      if(p.unresolved)return `<div class="pp-card"><div class="pp-cardt">Saved pool · reserves not found</div>${ids}<div class="pp-desc">This node cannot currently see both of this pool's reserve coins. That is what a pool that has been closed looks like, and also what one looks like on a node that is still catching up.</div>${hold}<button class="pp-btn" data-pprecover="${esc(p.address)}">Check for reserves</button><button class="pp-btn" data-ppretire="${esc(p.address)}">It&rsquo;s closed &mdash; put it away</button></div>`;
      // MyLpView.kvColored is the same geometry as the kv atom but deliberately NOT monospace — that
      // inconsistency is in the APK, so it is reproduced here rather than "tidied".
      let rows = ppKvC("Your liquidity", `${esc(TOK.tidyAmount(p.reserveM))} MINIMA + ${esc(TOK.tidyAmount(p.reserveT))} ${nm}`)
        + ppKvC("Value now", `≈ ${esc(TOK.tidyAmount(p.value))} MINIMA`)
        + ppKvC("Pool price", `${esc(TOK.tidyAmount(p.poolPrice))} ${nm} / MINIMA`)
        + ppKvC("Fees earned", `≈ ${esc(ppNum(p.feesMinima))} MINIMA (+${esc(ppNum(p.feesPct))}%)`, "ok");
      if (p.priceMove != null) {
        rows += ppKvC("Price since open", `${p.priceMove >= 0 ? "+" : ""}${esc(ppNum(p.priceMove))}%`)
          + ppKvC("Impermanent loss", `${esc(ppNum(p.il))}% vs holding`, p.il < -0.01 ? "bad" : "");
        if (p.ageBlocks > 0) rows += ppKvC("Age", `${Number(p.ageBlocks) || 0} blocks (~${esc(ppNum(p.ageBlocks * 50 / 3600))} h)`);
      }
      return `<div class="pp-card"><div class="pp-cardt">MINIMA / ${nm}</div>${hold}
        <div class="pp-sum"><div class="pp-sum-k">YOUR LIQUIDITY</div><div class="pp-sum-v">${esc(TOK.tidyAmount(p.value))}<span class="pp-sum-u"> MINIMA</span></div></div>
        ${ppHealthHtml(p)}${rows}
        <div class="pp-kv"><span class="pp-k">Address</span><span class="pp-v pp-addr" data-copy="${esc(p.address)}" title="${esc(p.address)}">${esc(short(p.address, 22))}</span></div>
        <div class="pp-acts">${ppActBtn("Add", "ppadd", p.address, false)}${ppActBtn("Migrate", "ppmig", p.address, ppNeedsMigrate(p))}${ppActBtn("Withdraw", "ppwd", p.address, false, true)}</div>
        <span class="pp-calclink" data-ppcalc="${esc(p.address)}">What if the price moves?  Pool calculator ›</span></div>`;
    }).join("") + ppRetiredHtml();
  }
  function wirePpMineActions(root) {
    root.querySelectorAll("[data-pprecover]").forEach(b => b.onclick = () => recoverPpSaved(b.dataset.pprecover));
    root.querySelectorAll("[data-ppretire]").forEach(b => b.onclick = () => retirePpPool(b.dataset.ppretire));
    root.querySelectorAll("[data-ppunretire]").forEach(b => b.onclick = () => unretirePpPools());
    root.querySelectorAll("[data-ppcollect]").forEach(b => b.onclick = () => collectPpFunds());
    root.querySelectorAll("[data-ppconfirm]").forEach(b => b.onclick = () => confirmPpSigning(b.dataset.ppconfirm));
    root.querySelectorAll("[data-ppadd]").forEach(b => b.onclick = () => showPpDeposit(b.dataset.ppadd));
    root.querySelectorAll("[data-ppmig]").forEach(b => b.onclick = () => showPpMigrate(b.dataset.ppmig));
    root.querySelectorAll("[data-ppwd]").forEach(b => b.onclick = () => confirmPpWithdraw(b.dataset.ppwd));
    root.querySelectorAll("[data-ppcalc]").forEach(b => b.onclick = () => showPpCalc(b.dataset.ppcalc));
  }
  /**
   * The what-if pool calculator (parity with native PoolCalcDialog / MDS openCalc): a starting pool — seeded from one
   * of this device's pools when an address is given — then move the price and see the reserves, ratio, value vs
   * holding and fees on the curve. Maths + form live in renderer/poolcalc.js (byte-identical to the MDS calc.js).
   * Display only: nothing here touches the node or the chain.
   */
  function showPpCalc(addr) {
    const seed = addr ? (PP_MINE || []).find(p => p.address === addr) : null;
    const host = el("ppBody");
    const cs = getComputedStyle(host || document.documentElement);
    const cv = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const f = PoolCalc.form({
      x0: seed && seed.reserveM ? String(seed.reserveM) : "100000",
      y0: seed && seed.reserveT ? String(seed.reserveT) : "500",
      tok: seed ? (seed.tokName || TOK.shortId(seed.tok)) : "mxUSDT",
      colors: { accent: cv("--pp-accent", "#F7931A"), ink: cv("--pp-text", "#fff"), dim: cv("--pp-dim", "#9A9AA8"), grid: cv("--pp-border2", "#2A2A38"), surface: cv("--pp-surface2", "#1F1F2B"), font: cv("--pp-sans", "sans-serif") }
    });
    const ov = document.createElement("div"); ov.className = "overlay ppapp"; ov.id = "ppCalcOv";
    const m = document.createElement("div"); m.className = "pp-modal pp-modal--wide";
    const t = document.createElement("div"); t.className = "pp-modt"; t.innerText = "Pool calculator";
    const done = document.createElement("button"); done.className = "pp-btn pp-btn--fill"; done.innerText = "Done"; done.style.marginTop = "10px";
    m.appendChild(t); m.appendChild(f.el); m.appendChild(done); ov.appendChild(m); document.body.appendChild(ov);
    const close = () => { if (ov.parentNode) ov.remove(); };
    done.onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
    f.render();
  }
  // Normalize a SWAP summary to the consistent "Bought/Sold N MINIMA for M <token>" framing. New swaps are already
  // recorded this way; older rows were stored from the token's side ("Bought <token> for <minima>") — reframe those.
  function ppSwapSummary(a) {
    const s = a.summary || "";
    if (a.type !== "SWAP" || /MINIMA/.test(s)) return s;          // non-swap, or already new-format
    let m = /^Bought (\S+) for (\S+)$/.exec(s);                   // old: bought <token> for <minima> ⇒ sold MINIMA
    if (m) return "Sold " + m[2] + " MINIMA for " + m[1];
    m = /^Sold (\S+) for (\S+)$/.exec(s);                         // old: sold <minima> for <token> ⇒ bought MINIMA
    if (m) return "Bought " + m[1] + " MINIMA for " + m[2];
    return s;
  }
  let ppActivityShown = 60, ppFeedShown = 60;
  function ppTxDate(ms) { return ms > 0 ? new Date(Number(ms)).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "Time unknown"; }
  function ppTxId(id) { return id ? `<span class="mono" data-copy="${esc(id)}" title="${esc(id)}">${esc(TOK.shortId(id))}</span>` : ""; }
  function ppActsHtml(acts) {
    let html = acts.slice(0, ppActivityShown).map(a => {
      if (a.type === "STATUS") return `<div class="pp-desc">${esc(a.summary)}</div>`;
      const tone = a.failed ? "bad" : a.confirmed ? "ok" : "wait";
      return `<div class="pp-row"><div class="pp-glyph pp-glyph--${tone}">${a.failed ? "✕" : a.confirmed ? "✓" : "⟲"}</div><div class="pp-rowmid">
        <div class="pp-l1">${esc(a.type)} · <span class="pp-st pp-st--${tone}">${esc(a.statusText || "Waiting for node check")}</span></div>
        <div class="pp-l2">${esc(ppSwapSummary(a))}</div>
        <div class="pp-l2">${ppTxId(a.txpowid)} · ${esc(a.timeLabel || "Submitted")} ${esc(ppTxDate(a.ts))}</div>
        ${a.originalTxpowid && a.originalTxpowid.toLowerCase() !== String(a.txpowid).toLowerCase() ? `<div class="pp-l2">Original submission ${ppTxId(a.originalTxpowid)}</div>` : ""}
        ${a.verifiedAt ? `<div class="pp-l2">Checked ${esc(ppTxDate(a.verifiedAt))}</div>` : ""}
        ${a.failed && a.failMsg ? `<div class="pp-l2">${esc(a.failMsg)}</div>` : ""}</div></div>`;
    }).join("");
    if (acts.length > ppActivityShown) html += `<button class="pp-btn pp-more" data-ppmore="activity">Show more (${acts.length - ppActivityShown} remaining) ▾</button>`;
    return html || `<div class="pp-empty">No activity yet.</div>`;
  }
  function ppFeedHtml(feed) {
    const transactions = feed.filter(f => !f.observed), observations = feed.filter(f => f.observed);
    let html = transactions.slice(0, ppFeedShown).map(f => {
      const action = f.kind === "CREATE" ? "Pool creation" : f.kind === "ADD" ? "Liquidity addition" : f.kind === "WITHDRAW" ? "Liquidity withdrawal" : f.kind === "SWAP" ? (f.minimaIn ? "MINIMA sale" : "MINIMA purchase") : "Pool reserves changed";
      return `<div class="pp-row"><div class="pp-glyph pp-glyph--${f.confirmed ? "ok" : "wait"}">${f.confirmed ? "✓" : "⟲"}</div><div class="pp-rowmid"><div class="pp-l1">${esc(action)} · ${esc(TOK.tidyAmount(f.minimaAmt))} MINIMA / ${esc(TOK.tidyAmount(f.tokenAmt))} ${esc(f.tokenLabel)}</div>
        <div class="pp-l2">${ppTxId(f.txpowid)} · Transaction ${esc(ppTxDate(f.ts))}</div>
        <div class="pp-l2 pp-st--${f.confirmed ? "ok" : "wait"}">${esc(f.statusText)}${f.verifiedAt ? " · Checked " + esc(ppTxDate(f.verifiedAt)) : ""}</div></div></div>`;
    }).join("");
    if (!transactions.length) html = `<div class="pp-empty">No pool transactions found in this node’s retained history.</div>`;
    if (transactions.length > ppFeedShown) html += `<button class="pp-btn pp-more" data-ppmore="feed">Show more (${transactions.length - ppFeedShown} remaining) ▾</button>`;
    if (observations.length) html += `<div class="pp-desc">Previous local observations — inferred from scans, not verified transactions</div>`;
    observations.forEach(f => { html += `<div class="pp-row"><div class="pp-glyph">›</div><div class="pp-rowmid"><div class="pp-l1">${esc(f.kind)} observation · ${esc(f.minimaAmt)} MINIMA / ${esc(f.tokenAmt)} ${esc(f.tokenLabel)}</div><div class="pp-l2">Observed on this device ${esc(ppTxDate(f.ts))} · Transaction time unknown</div></div></div>`; });
    return html;
  }
  function wirePpActivity(root) {
    root.querySelectorAll("[data-ppmore]").forEach(b => b.onclick = () => { if (b.dataset.ppmore === "activity") ppActivityShown += 60; else ppFeedShown += 60; refreshPpActive(); });
  }
  function wirePpPoolRows(root) {
    root.querySelectorAll(".row[data-pool]").forEach(n => n.oncontextmenu = (e) => { e.preventDefault(); copy(n.dataset.pool); toast("Pool address copied", "ok"); });
  }

  async function renderPpPools() {
    const host = el("ppBody");
    const seq = ++ppPoolsRenderSeq;
    PP_POOLS = await api.ppPools().catch(() => []);
    const depth = PP_POOLS.reduce((sum, p) => sum + (parseFloat(p.reserveM) || 0), 0);
    const summary = PP_POOLS.length ? `${PP_POOLS.length} pool${PP_POOLS.length === 1 ? "" : "s"} · ~${ppNum(depth)} MINIMA aggregate depth` : "";
    const seg = `<div class="pp-seg" style="margin-bottom:10px">
      <button class="pp-btn pp-btn--sm${ppPoolsMode === "indiv" ? " pp-btn--fill" : ""}" data-ppmode="indiv">Individual</button>
      <button class="pp-btn pp-btn--sm${ppPoolsMode === "combined" ? " pp-btn--fill" : ""}" data-ppmode="combined">Combined</button></div>`;
    const body = ppPoolsMode === "combined" ? ppCombinedCards(await api.ppAggregate().catch(() => [])) : ppPairRows(PP_POOLS);
    if (seq !== ppPoolsRenderSeq) return;   // a newer render started while we awaited — drop this stale paint
    host.innerHTML = `${ppHeader("pools")}
      <div class="pp-desc">Live constant-product pools on the shared mainnet registry — the same pools the phone app and the MDS MiniDapp trade.${summary ? " " + esc(summary) + "." : ""}</div>
      ${seg}
      <div id="ppList">${body}</div>`;
    wirePpHeader();
    host.querySelectorAll("[data-ppmode]").forEach(b => b.onclick = () => { ppPoolsMode = b.dataset.ppmode; renderPpPools(); });
    if (ppPoolsMode !== "combined") wirePpPoolRows(el("ppList"));
  }
  // Combined = one collective-pool card per token (summed reserves + aggregate price + count + depth), from the
  // Decimal-exact engine aggregates (api.ppAggregate → main/pandapools.js aggregateInfo → Curve/Router). Display only.
  function ppCombinedCards(agg) {
    if (!agg || !agg.length) return `<div class="pp-empty">No funded pools to combine yet.</div>`;
    return agg.map(a => {
      const name = esc(a.name || TOK.shortId(a.tok));
      return `<div class="pp-card"><div class="pp-cardt">MINIMA / ${name} · combined <span class="pp-chip">${a.count} pool${a.count > 1 ? "s" : ""}</span></div>
        <div class="pp-kv"><span class="pp-k">total reserves</span><span class="pp-v">${esc(TOK.tidyAmount(a.totalMinima))} MINIMA · ${esc(TOK.tidyAmount(a.totalToken))} ${name}</span></div>
        <div class="pp-kv"><span class="pp-k">aggregate spot price</span><span class="pp-v">${esc(TOK.tidyAmount(a.price))} ${name}/MINIMA</span></div>
        <div class="pp-kv"><span class="pp-k">tradeable depth</span><span class="pp-v">${esc(TOK.tidyAmount(a.depth))} MINIMA</span></div></div>`;
    }).join("");
  }
  async function renderPpMyLP() {
    const host = el("ppBody");
    try { PP_MINE=await api.ppMyPools(); PP_RETIRED=await api.ppListRetired().catch(()=>[]); PP_COLLECT=await api.ppPendingCollect().catch(()=>[]); } catch(e) {host.innerHTML=`${ppHeader("mylp")}<div class="pp-empty">${esc(e.message)}</div>`;wirePpHeader();return;}
    host.innerHTML = `${ppHeader("mylp")}
      <div class="pp-desc">Pools you created on this device. Keep-fresh maintains their reserves automatically — <b>leave this app running</b> so your pools stay live for everyone.</div>
      <div class="pp-note">Anyone on the network can trade against your pools; you earn the 0.50% fee on every swap that routes through them.</div>
      <div class="pp-seg"><button class="pp-btn pp-btn--fill" id="ppCreateBtn">＋ Create a pool</button><button class="pp-btn" id="ppCollectBtn">Collect to wallet</button></div>
      <div id="ppMine" style="margin-top:12px">${ppMineHtml(PP_MINE)}</div>
      <div class="pp-card" style="margin-top:12px"><div class="pp-cardt">Recovery</div>
        <div class="pp-desc">Keep the latest complete MinimaCore wallet backup and this public pool recipe. Proofs expire; recovery needs current signing state and available chain proofs.</div>
        <div class="pp-seg"><button class="pp-btn" id="ppBackupBtn">Back up</button><button class="pp-btn" id="ppRestoreBtn">Restore</button><button class="pp-btn" id="ppArchiveBtn">Recovery archive</button><button class="pp-btn" id="ppGuideBtn">How it works</button></div></div>
      <div class="pp-card" style="margin-top:12px"><div class="pp-cardt">Statement</div>
        <div class="pp-desc">A per-pool statement for accounting: what you put in, your own trades against it, what is in the pool now, and the profit. Your transactions only — the profit figures read the pool's reserves live, so everyone else's trading is already in them.</div>
        <div class="pp-seg"><button class="pp-btn" id="ppStatementBtn">Export statement (.csv)</button></div></div>
      <div class="pp-card" style="margin-top:12px"><div class="pp-cardt">Pool calculator</div>
        <div class="pp-desc">What happens to a pool when the price moves: enter a starting pool (or open it from one of your pool cards, seeded with its live reserves), move the MINIMA price and see the reserves, their ratio, the value versus holding and the effect of fees on the constant-product curve. Display only.</div>
        <div class="pp-seg"><button class="pp-btn" id="ppCalcBtn">Open the calculator</button></div></div>`;
    wirePpHeader(); wirePpMineActions(el("ppMine"));
    el("ppCalcBtn").onclick = () => showPpCalc(null);
    el("ppCreateBtn").onclick = showPpCreate;
    el("ppCollectBtn").onclick = doPpCollect;
    el("ppBackupBtn").onclick = showPpBackup;
    el("ppRestoreBtn").onclick = showPpRestore;
    el("ppGuideBtn").onclick = showPpGuide;
    el("ppArchiveBtn").onclick = showPpArchive;
    el("ppStatementBtn").onclick = doPpStatement;
  }

  let ppStatementBusy = false;
  /**
   * Build and save the per-pool statement. Tops up the permanent history mirror first — a statement built on a
   * half-filled history would be quietly incomplete, which is the worst way for an accounting file to be wrong.
   * If the backfill still hasn't finished, the file says so and so does the toast.
   */
  async function doPpStatement() {
    if (ppStatementBusy) return;                                     // the sync can take a while — no stacking
    ppStatementBusy = true;
    const prog = showProgress("Building statement…", "Catching the transaction history up with the node…");
    let r;
    try { r = await api.ppStatement(); }
    catch (e) { prog.close(); ppStatementBusy = false; toast("Statement failed: " + e.message, "err"); return; }
    prog.close();
    ppStatementBusy = false;
    if (!r || !r.pools) { toast("No pools to report on yet — create one first.", "err"); return; }
    const p = await api.exportCsv(r.csv, "pandapools-statement.csv");
    if (!p) { toast("Export cancelled", ""); return; }
    toast(r.backfilled
      ? `Saved ✓ — ${r.pools} pool${r.pools === 1 ? "" : "s"}, ${r.rows} transactions`
      : `Saved ✓ — history still syncing (${r.rows} so far); the file says so`, "ok");
  }
  let ppBackupBusy = false;
  async function showPpBackup() {
    if (ppBackupBusy) return;                                        // async fetch → guard against a double-click stacking modals
    ppBackupBusy = true;
    const prog = showProgress("Preparing backup…", "Snapshotting your pools' current reserve coins…");
    let r; try { r = await api.ppBackup(); } catch (e) { prog.close(); ppBackupBusy = false; toast("Backup failed: " + e.message, "err"); return; }
    prog.close();
    ppBackupBusy = false;
    if (r && r.empty) { toast("No pools to back up yet — create one first.", "err"); return; }
    if(!r||r.error||!r.json){toast(r&&r.error||"Backup could not be created.","err");return;}
    const json = r.json;
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="ppbOv"><div class="pp-modal">
      <div class="pp-modt">Your pool backup</div>
      <div class="pp-desc">Save this public recipe alongside your latest complete MinimaCore wallet backup. Proof snapshots expire; later recovery may need a synced MegaMMR archive.</div>
      <textarea class="pp-input" id="ppbTa" readonly style="min-height:150px;font-family:monospace;font-size:11px">${esc(json)}</textarea>
      <div class="pp-seg" style="margin-top:10px"><button class="pp-btn" id="ppbCopy">Copy</button><button class="pp-btn pp-btn--fill" id="ppbSave">Save file</button></div>
      <button class="pp-btn" id="ppbClose" style="margin-top:8px">Done</button></div></div>`);
    const ov = el("ppbOv"); const close = () => { if (ov) ov.remove(); };
    el("ppbClose").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppbOv") close(); };
    el("ppbCopy").onclick = () => { copy(json); toast("Copied ✓", "ok"); };
    el("ppbSave").onclick = async () => { try { const s = await api.ppSaveBackup(json); if (s && !s.canceled) toast("Saved ✓", "ok"); } catch (e) { toast("Save failed: " + e.message, "err"); } };
  }
  async function showPpRestore() {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="pprOv"><div class="pp-modal">
      <div class="pp-modt">Restore pools</div>
      <div class="pp-desc">Restore public pool recipes and verify reserves on this node. Expired proofs need a synced MegaMMR archive. Owner signing stays paused until you confirm current wallet signing state.</div>
      <textarea class="pp-input" id="pprTa" placeholder="…paste backup JSON here" style="min-height:130px;font-family:monospace;font-size:11px"></textarea>
      <div class="pp-desc" id="pprStatus" style="margin-top:6px"></div>
      <div class="pp-seg" style="margin-top:8px"><button class="pp-btn" id="pprFile">Load file</button><button class="pp-btn pp-btn--fill" id="pprGo">Restore</button></div>
      <button class="pp-btn" id="pprCancel" style="margin-top:8px">Cancel</button></div></div>`);
    const ov = el("pprOv"); const close = () => { if (ov) ov.remove(); };
    el("pprCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "pprOv") close(); };
    el("pprFile").onclick = async () => { try { const f = await api.ppLoadBackup(); if (f && f.error) { toast(f.error, "err"); return; } if (f && !f.canceled && el("pprTa")) el("pprTa").value = f.json || ""; } catch (e) {} };
    let busy = false;
    el("pprGo").onclick = async () => {
      if (busy) return;
      const json = (el("pprTa") && el("pprTa").value || "").trim();
      if (!json) { toast("Paste a backup, or load a file.", "err"); return; }
      busy = true;
      if (el("pprStatus")) el("pprStatus").textContent = "Restoring…";
      try {
        const r = await api.ppRestore(json);
        if(el("pprStatus"))el("pprStatus").textContent=ppRecoveryResult(r);
        toast(`Verified reserves for ${r.restored} of ${r.total} pools.`,r.restored===r.total&&r.total?"ok":"err");
        renderPandapools();
      } catch (e) { if (el("pprStatus")) el("pprStatus").textContent = e.message; toast("Restore failed: " + e.message, "err"); }
      finally { busy = false; }
    };
  }
  function showPpGuide() {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="ppgOv"><div class="pp-modal">
      <div class="pp-modt">How pool recovery works</div>
      <div class="pp-desc" style="white-space:pre-wrap">Keep the latest complete MinimaCore wallet backup and this pool recipe. Proofs expire. A seed or recipe alone is insufficient.

  Saved recipes identify pools even when a light node no longer sees their coins. Restore verifies local reserves, then backup proofs, then current proofs from a synced MegaMMR archive. Missing reserves remain visible and are never reported as recovered.

  Restore does not regenerate keys or estimate past signature use. Confirm signing only with current complete wallet state and no other signing copies. Keep-fresh requires the app and node to remain running; it cannot guarantee availability while offline.</div>
      <button class="pp-btn" id="ppgClose" style="margin-top:10px">Close</button></div></div>`);
    const ov = el("ppgOv"); const close = () => { if (ov) ov.remove(); };
    el("ppgClose").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppgOv") close(); };
  }
  function ppRecoveryResult(r){return `Verified reserves for ${r.restored} of ${r.total} pools.\n${(r.details||[]).join("\n\n")}\n${r.warn||""}`;}
  async function collectPpFunds(){
    const prog=showProgress("Moving withdrawn funds…","Forwarding from the pool's owner payout address into your wallet. It keeps trying in the background until the address is empty.");
    try {
      const r=await api.ppCollect();
      prog.close();
      toast(r.cleared?`Withdrawn funds moved to your wallet ✓`:(r.stranded?"Cannot sign for that payout address — see the card.":"Still waiting for the withdrawn coins to become spendable."), r.stranded?"err":"ok");
      renderPandapools();
    } catch(e){prog.close();toast(e.message,"err");}
  }
  async function unretirePpPools(){
    try {for(const r of PP_RETIRED)await api.ppRetirePool(r.address,false);toast("Brought back.","ok");renderPandapools();}
    catch(e){toast(e.message,"err");}
  }
  async function retirePpPool(address){
    // Hidden, never deleted: the recipe stays in every backup and comes back on its own if the close
    // turns out never to have landed.
    try {await api.ppRetirePool(address,true);toast("Put away. The recipe is still saved and still goes into your backups.","ok");renderPandapools();}
    catch(e){toast(e.message,"err");}
  }
  async function recoverPpSaved(address){
    const prog=showProgress("Recovering reserves…","Checking local reserves and current archive proofs. No transaction is signed.");
    try {const r=await api.ppRecoverSaved(address);prog.close();await showConfirm("Recovery result",ppRecoveryResult(r),"Done");renderPandapools();}
    catch(e){prog.close();toast(e.message,"err");}
  }
  async function confirmPpSigning(opk){
    const accepted=await showConfirm("Confirm current wallet signing state","Confirm only if this node has the latest complete MinimaCore wallet backup, including signing counters, and every other copy has stopped signing. A seed or old backup is insufficient. This enables owner spending and automatic refresh for key: "+opk,"I confirm current wallet state");
    if(!accepted)return;
    try {const ok=await api.ppConfirmSigning(opk,true);toast(ok?"Confirmation saved. Owner signing enabled.":"Could not confirm. Signing remains paused.",ok?"ok":"err");renderPandapools();}catch(e){toast(e.message,"err");}
  }
  async function showPpArchive(){
    let current;try{current=await api.ppArchiveSettings();}catch(e){toast(e.message,"err");return;}
    document.body.insertAdjacentHTML("beforeend",`<div class="overlay ppapp" id="ppaOv"><div class="pp-modal"><div class="pp-modt">Recovery archive</div><div class="pp-desc">Optional public HTTPS MegaMMR RPC endpoint for current proofs. Your node verifies every proof. Leave empty for local MegaMMR or backup proofs.</div><input class="pp-input" id="ppaUrl" type="url" value="${esc(current)}" placeholder="https://archive.example.com"><div class="pp-desc" id="ppaStatus"></div><div class="pp-seg"><button class="pp-btn" id="ppaCancel">Cancel</button><button class="pp-btn pp-btn--fill" id="ppaSave">Save</button></div></div></div>`);
    const ov=el("ppaOv");el("ppaCancel").onclick=()=>ov.remove();
    el("ppaSave").onclick=async()=>{try{const ok=await api.ppArchiveSettings(el("ppaUrl").value);if(ok){ov.remove();toast("Recovery archive saved.","ok");}else el("ppaStatus").textContent="Could not save. Use a public HTTPS hostname without credentials, query or fragment.";}catch(e){el("ppaStatus").textContent=e.message;}};
  }
  let ppCollectBusy = false;
  async function doPpCollect() {
    if (ppCollectBusy) return;                                     // block a double-click (two concurrent sweeps + stacked overlays)
    ppCollectBusy = true;
    const okc = await showConfirm("Collect to wallet?", "Move any withdrawn/migrated reserves from your pool owner addresses into your default wallet.", "Collect");
    if (!okc) { ppCollectBusy = false; return; }
    const prog = showProgress("Collecting…", "Moving any withdrawn reserves from your owner addresses into your default wallet…");
    try {
      const r = await api.ppCollect();
      prog.close();
      const skippedNote = r && r.foreign ? " (" + r.foreign + " owner key" + (r.foreign === 1 ? "" : "s") + " paused or unavailable — confirm current wallet state in Recovery)" : "";
      toast((r && r.coins ? "Collected " + r.coins + " coin(s) to your wallet ✓" : "Nothing to collect right now.") + skippedNote, r && r.foreign ? "err" : "ok");
      renderPandapools();
    } catch (e) { prog.close(); toast("Collect failed: " + e.message, "err"); }
    finally { ppCollectBusy = false; }
  }
  // ---- LP management sheets (create / add / migrate / withdraw) ----
  // Token-leg decimals, defensively parsed + clamped (a wrong value → token-grain rejection at createPool).
  function ppSafeDec(token) { const d = parseInt(token && token.decimals, 10); return Number.isFinite(d) && d >= 0 && d <= 18 ? d : 8; }
  // Create is USDT-only + price-anchored, mirroring the MDS dapp (0.6.6): a pool always opens at the true
  // MINIMA/USDT rate (MEXC market → live-pool spot). Free-ratio manual create is the tier-3 fallback for the
  // very first pool only. openCreate → dispatchCreate → createFormPriced (enter USDT) | createFormManual.
  async function showPpCreate() {
    const bal = await tryCmd("balance") || [];
    let usdtId = "";
    try { const mt = await api.ppMarketToken(); usdtId = (mt && mt.usdt) || ""; } catch (e) {}
    const isFed = (tid) => !!tid && !!usdtId && tid.toLowerCase() === usdtId.toLowerCase();
    let minimaAvail = 0;
    const toks = [];
    bal.forEach(b => {
      const tid = b.tokenid || "";
      if (tid === MINIMA || tid === "0x00") { minimaAvail = parseFloat(b.sendable) || 0; return; }   // MINIMA is the other leg
      const sendable = parseFloat(b.sendable) || 0;
      if (!tid || sendable <= 0 || !isFed(tid)) return;   // ONLY market-fed pairs (mxUSDT) — no mispriceable pools
      toks.push({ tokenid: tid, name: TOK.tokenName(b.token, tid), dec: ppSafeDec(b.token), avail: sendable });
    });
    if (!toks.length) {
      await showConfirm("Get mxUSDT first",
        "PandaPools creates MINIMA / USDT pools — the pair with a live market price, so a pool always opens at the true rate. Your wallet holds no mxUSDT; receive some first, then create a pool.", "OK");
      return;
    }
    if (toks.length === 1) { ppDispatchCreate(toks[0], minimaAvail); return; }
    const opts = toks.map((t, i) => `<option value="${i}">${esc(t.name)} — ${esc(String(t.avail))} avail</option>`).join("");
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="ppcPickOv"><div class="pp-modal">
      <div class="pp-modt">Pool MINIMA with…</div>
      <div class="pp-field"><select class="pp-input" id="ppcPick">${opts}</select></div>
      <div class="pp-seg" style="margin-top:6px"><button class="pp-btn" id="ppcPickCancel">Cancel</button><button class="pp-btn pp-btn--fill" id="ppcPickGo">Next</button></div></div></div>`);
    const ov = el("ppcPickOv"); const close = () => { if (ov) ov.remove(); };
    el("ppcPickCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcPickOv") close(); };
    el("ppcPickGo").onclick = () => { const t = toks[el("ppcPick").value | 0]; close(); if (t) ppDispatchCreate(t, minimaAvail); };
  }

  async function ppDispatchCreate(t, minimaAvail) {
    let a = null;
    try { a = await api.ppCreateAnchor(); } catch (e) {}
    if (a && a.price) ppCreateFormPriced(t, minimaAvail, a.price, a.source || "market");
    else ppCreateFormManual(t);   // tier-3: no MEXC AND no live pool — user sets the first price
  }

  // Tier 1/2 ANCHORED priced form: enter USDT only; MINIMA is DERIVED from the anchor (no free ratio).
  function ppCreateFormPriced(t, minimaAvail, initPrice, initSource) {
    let price = initPrice, source = initSource;
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="ppcOv"><div class="pp-modal">
      <div class="pp-modt">Create MINIMA / ${esc(t.name)} pool</div>
      <div class="pp-field"><div class="pp-lbl">${esc(t.name)} to provide</div><input class="pp-input" id="ppcU" placeholder="e.g. 1.90" autocomplete="off" /></div>
      <div class="pp-desc" id="ppcInfo" style="white-space:pre-wrap"></div>
      <div class="pp-seg" style="margin-top:6px"><button class="pp-btn" id="ppcCancel">Cancel</button><button class="pp-btn" id="ppcRefresh">↻ Price</button><button class="pp-btn pp-btn--fill" id="ppcGo">Create</button></div></div></div>`);
    const ov = el("ppcOv"); const close = () => { if (ov) ov.remove(); };
    el("ppcCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcOv") close(); };
    const info = () => el("ppcInfo");
    const derive = (u, p) => Math.ceil((u / p) * 1e6) / 1e6;   // MINIMA = USDT ÷ price, rounded UP to the 6dp grain
    const numOk = (v) => /^[0-9]*\.?[0-9]+$/.test(v) && parseFloat(v) > 0;   // strict — reject "1.5abc" before it reaches createPool
    function update() {
      if (!info()) return;
      const p = parseFloat(price);
      if (!(p > 0)) { info().textContent = "Fetching MINIMA/USDT market price…"; return; }
      let cap = minimaAvail * p; if (t.avail < cap) cap = t.avail;
      let str = "Price: " + TOK.tidyAmount(price) + " USDT/MINIMA (" + source + ")\n";
      str += "You have: " + TOK.tidyAmount(String(minimaAvail)) + " MINIMA · " + TOK.tidyAmount(String(t.avail)) + " " + t.name + "\n";
      const uRaw = (el("ppcU") && el("ppcU").value || "").trim();
      if (!numOk(uRaw)) { str += "Enter the " + t.name + " amount to provide (max ≈ " + TOK.tidyAmount(String(cap)) + ")."; }
      else {
        const u = parseFloat(uRaw);
        const minima = derive(u, p);
        str += "MINIMA required:  " + TOK.tidyAmount(String(minima)) + "\nTotal pool value:  ≈ US$ " + TOK.tidyAmount(String(u * 2));
        if (minima > minimaAvail) str += "\n⚠ Not enough MINIMA — reduce " + t.name + " to ≤ " + TOK.tidyAmount(String(cap)) + ".";
        if (u > t.avail) str += "\n⚠ You only have " + TOK.tidyAmount(String(t.avail)) + " " + t.name + ".";
      }
      info().textContent = str;
    }
    el("ppcU").oninput = update;
    el("ppcRefresh").onclick = async () => {
      if (info()) info().textContent = "Refreshing price…";
      try { const m = await api.ppMarket(); if (m && m.mid) { price = m.mid; source = "MEXC market"; } } catch (e) {}
      update();
    };
    let busy = false;
    el("ppcGo").onclick = async () => {
      if (busy) return;
      const p = parseFloat(price);
      if (!(p > 0)) { if (info()) info().textContent = "No price yet — tap ↻ Price and retry."; return; }
      const uStr = (el("ppcU").value || "").trim();
      if (!numOk(uStr)) { if (info()) info().textContent = "Enter the " + t.name + " amount (a positive number)."; return; }
      const u = parseFloat(uStr);
      const minima = derive(u, p);
      if (minima > minimaAvail || u > t.avail) { if (info()) info().textContent = "Not enough balance for that amount."; return; }
      busy = true;
      const okc = await showConfirm("Create this pool?",
        "MINIMA / " + t.name + " pool\n\n" + TOK.tidyAmount(String(minima)) + " MINIMA  +  " + uStr + " " + t.name + "\nOpens at " + TOK.tidyAmount(price) + " USDT/MINIMA  (matches " + source + " ✓)\n\nThe 0.5% swap fee goes to liquidity providers.", "Create");
      if (!okc) { busy = false; return; }
      close();
      const prog = showProgress("Creating pool…", "Posting to the chain — this can take a few seconds…");
      try { await api.ppCreate(t.tokenid, t.dec, String(minima), uStr); prog.close(); toast("Pool created ✓", "ok"); renderPandapools(); }
      catch (e) { prog.close(); toast("Create failed: " + e.message, "err"); }
      finally { busy = false; }
    };
    update();
  }

  // Tier 3 BOOTSTRAP: reached ONLY when no MEXC price AND no live MINIMA/USDT pool (the first pool). Creator sets
  // the opening price; gated behind an explicit acknowledgement + the confirm step.
  function ppCreateFormManual(t) {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="ppcOv"><div class="pp-modal">
      <div class="pp-modt">Create MINIMA / ${esc(t.name)} pool</div>
      <div class="pp-desc" style="color:var(--pp-red)">No market price is available (MEXC is unreachable and there are no live MINIMA / ${esc(t.name)} pools to match). You are setting the OPENING PRICE yourself — set it to the true market rate, or arbitrageurs will correct it at your expense.</div>
      <div class="pp-field"><div class="pp-lbl">MINIMA to deposit</div><input class="pp-input" id="ppcX" placeholder="e.g. 100" autocomplete="off" /></div>
      <div class="pp-field"><div class="pp-lbl">${esc(t.name)} to deposit</div><input class="pp-input" id="ppcY" placeholder="e.g. 0.56" autocomplete="off" /></div>
      <div class="pp-desc" id="ppcPreview" style="white-space:pre-wrap">Enter both amounts to see the opening price.</div>
      <label style="display:block;margin:6px 0;font-size:12px"><input type="checkbox" id="ppcAck" style="margin-right:6px" />I understand I'm setting the opening price with no market to check it against.</label>
      <div class="pp-seg" style="margin-top:6px"><button class="pp-btn" id="ppcCancel">Cancel</button><button class="pp-btn pp-btn--fill" id="ppcGo">Create</button></div></div></div>`);
    const ov = el("ppcOv"); const close = () => { if (ov) ov.remove(); };
    el("ppcCancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "ppcOv") close(); };
    const numOk = (v) => /^[0-9]*\.?[0-9]+$/.test(v) && parseFloat(v) > 0;
    const updatePreview = async () => {
      const x = (el("ppcX") && el("ppcX").value || "").trim(), y = (el("ppcY") && el("ppcY").value || "").trim();
      if (!numOk(x) || !numOk(y)) { if (el("ppcPreview")) el("ppcPreview").textContent = "Enter both amounts to see the opening price."; return; }
      const pv = await api.ppCreatePreview(t.dec, x, y).catch(() => ({ ok: false }));
      if (el("ppcPreview")) el("ppcPreview").textContent = pv && pv.ok
        ? "Opening price:  " + TOK.tidyAmount(pv.price) + " " + t.name + " / MINIMA\nProduct floor (KMIN):  " + pv.kmin
        : ((pv && pv.msg) || "Enter both amounts.");
    };
    el("ppcX").oninput = updatePreview; el("ppcY").oninput = updatePreview;
    let busy = false;
    el("ppcGo").onclick = async () => {
      if (busy) return;
      const x0 = el("ppcX").value.trim(), y0 = el("ppcY").value.trim();
      if (!numOk(x0) || !numOk(y0)) { toast("Enter both reserves (positive).", "err"); return; }
      if (!el("ppcAck").checked) { toast("Tick the box to confirm you're setting the opening price.", "err"); return; }
      busy = true;
      const pv = await api.ppCreatePreview(t.dec, x0, y0).catch(() => ({ ok: false }));
      const priceLine = pv && pv.ok ? "⚠ No market price available — YOU are setting the opening price at " + TOK.tidyAmount(pv.price) + " " + t.name + " / MINIMA.\n" : "";
      const okc = await showConfirm("Create MINIMA / " + t.name + " pool?",
        x0 + " MINIMA  +  " + y0 + " " + t.name + "\n" + priceLine + "\nThe 0.5% swap fee goes to liquidity providers. On-chain; withdrawable later as the owner.", "Create");
      if (!okc) { busy = false; return; }
      close();
      const prog = showProgress("Creating pool…", "Posting to the chain — this can take a few seconds…");
      try { await api.ppCreate(t.tokenid, t.dec, x0, y0); prog.close(); toast("Pool created ✓", "ok"); renderPandapools(); }
      catch (e) { prog.close(); toast("Create failed: " + e.message, "err"); }
      finally { busy = false; }
    };
    updatePreview();
  }
  function ppTwoAmountSheet(title, desc, lblA, lblB, okLabel, onGo) {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay ppapp" id="pp2Ov"><div class="pp-modal">
      <div class="pp-modt">${esc(title)}</div><div class="pp-desc">${esc(desc)}</div>
      <div class="pp-field"><div class="pp-lbl">${esc(lblA)}</div><input class="pp-input" id="pp2A" placeholder="0.0" autocomplete="off" /></div>
      <div class="pp-field"><div class="pp-lbl">${esc(lblB)}</div><input class="pp-input" id="pp2B" placeholder="0.0" autocomplete="off" /></div>
      <div class="pp-seg" style="margin-top:10px"><button class="pp-btn" id="pp2Cancel">Cancel</button><button class="pp-btn pp-btn--fill" id="pp2Go">${esc(okLabel)}</button></div></div></div>`);
    const ov = el("pp2Ov"); const close = () => { if (ov) ov.remove(); };
    el("pp2Cancel").onclick = close; ov.onclick = (e) => { if (e.target.id === "pp2Ov") close(); };
    let busy = false;
    el("pp2Go").onclick = async () => { if (busy) return; busy = true; try { await onGo(el("pp2A").value.trim(), el("pp2B").value.trim(), close); } finally { busy = false; } };
  }
  async function showPpDeposit(addr) {
    const p = PP_MINE.find(x => x.address === addr); if (!p) { toast("Pool not found.", "err"); return; }
    ppTwoAmountSheet("Add liquidity", "Grow MINIMA / " + (p.tokName || "token") + " in place (capped at 2× the floor — beyond that, use Migrate).",
      "Add MINIMA", "Add " + (p.tokName || "token"), "Add", async (a, b, close) => {
        const numOk = (v) => v === "" || /^[0-9]*\.?[0-9]+$/.test(v);
        if (!numOk(a) || !numOk(b) || ((parseFloat(a) || 0) <= 0 && (parseFloat(b) || 0) <= 0)) { toast("Enter an amount to add.", "err"); return; }
        const okc = await showConfirm("Add liquidity?", "Add " + (a || "0") + " MINIMA and " + (b || "0") + " " + (p.tokName || "token") + " to the pool. On-chain and irreversible.", "Add");
        if (!okc) return;
        close();
        const prog = showProgress("Adding liquidity…", "Posting to the chain…");
        try { await api.ppDeposit(addr, a || "0", b || "0"); prog.close(); toast("Liquidity added ✓", "ok"); renderPandapools(); }
        catch (e) { prog.close(); toast("Add failed: " + e.message, "err"); }
      });
  }
  async function showPpMigrate(addr) {
    const p = PP_MINE.find(x => x.address === addr); if (!p) { toast("Pool not found.", "err"); return; }
    ppTwoAmountSheet("Migrate pool", "Reset the pool to new reserves at a fresh address (resets the KMIN floor). The old reserves go to your owner address — use “Collect to wallet” to move them into your default wallet.",
      "New MINIMA reserve", "New " + (p.tokName || "token") + " reserve", "Migrate", async (a, b, close) => {
        if (!/^[0-9]*\.?[0-9]+$/.test(a) || parseFloat(a) <= 0 || !/^[0-9]*\.?[0-9]+$/.test(b) || parseFloat(b) <= 0) { toast("Enter both new reserves.", "err"); return; }
        const okc = await showConfirm("Migrate this pool?", "Old reserves go to your owner address (collect them with “Collect to wallet”); a new pool opens with " + a + " MINIMA / " + b + " " + (p.tokName || "token") + ".", "Migrate");
        if (!okc) return;
        close();
        const prog = showProgress("Migrating…", "Posting to the chain…");
        try { await api.ppMigrate(addr, a, b); prog.close(); toast("Migrated ✓", "ok"); renderPandapools(); }
        catch (e) { prog.close(); toast("Migrate failed: " + e.message, "err"); }
      });
  }
  let ppWithdrawBusy = false;
  async function confirmPpWithdraw(addr) {
    if (ppWithdrawBusy) return;
    ppWithdrawBusy = true;
    try {
      const p = PP_MINE.find(x => x.address === addr);
      const ok = await showConfirm("Withdraw this pool?",
        "Sweep the reserves" + (p ? " (" + TOK.tidyAmount(p.reserveM) + " MINIMA · " + TOK.tidyAmount(p.reserveT) + " " + (p.tokName || "") + ")" : "") + " to your owner address (spendable on this node). The pool closes. Then use “Collect to wallet” to move them into your default wallet — do that before restoring your seed on another node.", "Withdraw", true);
      if (!ok) return;
      const prog = showProgress("Withdrawing…", "Posting to the chain…");
      try { await api.ppClose(addr); prog.close(); toast("Withdrawn ✓ — at your owner address; use “Collect to wallet” to move it to your wallet", "ok"); renderPandapools(); }
      catch (e) { prog.close(); toast("Withdraw failed: " + e.message, "err"); }
    } finally { ppWithdrawBusy = false; }
  }
  async function renderPpActivity() {
    const host = el("ppBody");
    const [acts, feed] = await Promise.all([api.ppActivity().catch(() => []), api.ppFeed().catch(() => [])]);
    host.innerHTML = `${ppHeader("activity")}
      <div class="pp-card" id="ppActs"><div class="pp-cardt">Your activity</div>${ppActsHtml(acts)}</div>
      <div class="pp-card" id="ppFeed"><div class="pp-cardt">Market feed <span class="pp-chip">all pools</span></div>${ppFeedHtml(feed)}</div>`;
    wirePpHeader(); wirePpActivity(host);
  }
  // Live scan updates: patch ONLY the passive list container of the active sub-view IN PLACE (preserve scroll); never
  // rebuild the header or any form (the "frozen tab" rule — matters once swap/create inputs land in later steps).
  let ppUpdateTimer = null;
  function onPandapoolsUpdate() {
    if (ppUpdateTimer) return;
    ppUpdateTimer = setTimeout(() => { ppUpdateTimer = null; refreshPpActive().catch(() => {}); }, 400);
  }
  async function refreshPpActive() {
    const body = el("ppBody");
    if (!body || activeView() !== "pandapools") return;
    const sy = body.scrollTop;
    if (ppView === "swap") {
      ppUpdateQuote(); refreshPpSwapMeta();   // refresh quote + pool line + balances (passive regions only; never the input/form)
      return;
    }
    if (ppView === "pools") {
      if (!el("ppList")) return;
      PP_POOLS = await api.ppPools().catch(() => []);
      const c = el("ppList"); if (c) { c.innerHTML = ppPairRows(PP_POOLS); wirePpPoolRows(c); }
    } else if (ppView === "mylp") {
      if (!el("ppMine")) return;
      PP_MINE = await api.ppMyPools().catch(() => []);
      PP_RETIRED = await api.ppListRetired().catch(() => []);
      PP_COLLECT = await api.ppPendingCollect().catch(() => []);
      const c = el("ppMine"); if (c) { c.innerHTML = ppMineHtml(PP_MINE); wirePpMineActions(c); }
    } else if (ppView === "activity") {
      if (!el("ppActs")) return;
      const [acts, feed] = await Promise.all([api.ppActivity().catch(() => []), api.ppFeed().catch(() => [])]);
      if (el("ppActs")) el("ppActs").innerHTML = `<div class="pp-cardt">Your activity</div>${ppActsHtml(acts)}`;
      if (el("ppFeed")) el("ppFeed").innerHTML = `<div class="pp-cardt">Market feed <span class="pp-chip">all pools</span></div>${ppFeedHtml(feed)}`;
    }
    if (ppView === "activity" && el("ppBody")) wirePpActivity(el("ppBody"));
    if (el("ppBody")) el("ppBody").scrollTop = sy;
  }

  // ---- public surface (renderer/app.js talks to the panel only through this) ----
  g.PoolsPanel = {
    init: function (d) {
      api = d.api; esc = d.esc; el = d.el; toast = d.toast; copy = d.copy; short = d.short; TOK = d.TOK;
      showConfirm = d.showConfirm; showProgress = d.showProgress; tryCmd = d.tryCmd;
      PoolCalc = d.PoolCalc || g.PoolCalc;
      MINIMA = d.MINIMA || "0x00";
      running = d.running; activeView = d.activeView;
    },
    render: renderPandapools,
    onUpdate: onPandapoolsUpdate,
    /** Seed/wallet changed — forget everything derived from the old wallet before the next paint. */
    reset: function () {
      ppView = "swap"; ppPoolsMode = "indiv"; ppPoolsRenderSeq++;
      PP_POOLS = []; PP_MINE = []; PP_SWAP_TOKS = []; PP_RETIRED = []; PP_COLLECT = [];
      PP_BAL_MIN = "0"; PP_BAL_TOK = "0"; PP_USDT_ID = null;
      ppSwapMinToTok = true; ppActivityShown = 60; ppFeedShown = 60; ppQuoteSeq++;
      if (ppUpdateTimer) { clearTimeout(ppUpdateTimer); ppUpdateTimer = null; }
    },
    setVersion: function (v) { PP_VER = v || ""; },
    /** Template-only exports for scripts/panels-test.cjs — no node or chain contact. */
    _mineHtml: ppMineHtml,
    _actsHtml: ppActsHtml,
    _feedHtml: ppFeedHtml,
    _header: ppHeader,
    _setView: function (v) { ppView = v; },
    setBlock: function (n) { n = parseInt(n, 10) || 0; if (n > PP_BLOCK) { PP_BLOCK = n; var e = el && el("ppBlk"); if (e) e.textContent = "#" + PP_BLOCK; } }
  };
})(window);
