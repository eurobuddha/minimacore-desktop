/*
 * atomix-ui.js — the AtomiX panel, rebuilt to the AtomiX APK's own look and feel. (Named atomix-ui because
 * main/atomix.js and main/atomix/ already exist — the engine, byte-parity with the donor, is untouched.)
 *
 * Source of truth for the visuals: apks/atomix Design.java + TradingContext.java + MainActivity.java.
 *   - Onyx ⇄ Daylight, the APK's own ☾/☀ pill, independent of the desktop shell's theme. DIM is #8B909C in
 *     BOTH looks and is deliberately not "helpfully" darkened for light.
 *   - the accent FOLLOWS THE TRADED CURRENCY: MxUSD paints the panel Tether green (#26A17B, the APK's default),
 *     MINIMA paints it orange (#F7931A). Buttons, pills, the active tab cell and the receive amount follow.
 *   - Inter + JetBrains Mono, converted locally from the APK's own variable TTFs (renderer/fonts/). Mono carries
 *     every price, size, balance and amount; Inter everything else; tabular figures throughout.
 *   - a BOTTOM tab bar — the only panel with one — in the APK's order: Swap · Wallet · Activity · Market · OTC,
 *     with its five icons ported path-for-path from ic_tab_*.xml.
 *   - the order book mirrors around a literal │ with NO depth bars, because the APK has none.
 *
 * RULE 2: the Minima dollar token is MxUSD on every surface a user reads. The engine still keys the book as
 * "mxusdt" and stamps rows "mxUSDT" — those are internal, byte-parity with the donor, and stay.
 *
 * NOTHING that moves value changed. axQuote → showConfirm → axSwap(q.quoteId) (the frozen quote), the maker
 * save/withdraw, the OTC deal actions, the ETH send review → confirm → send, the ambiguous-timeout wording and
 * every guard came across verbatim from renderer/app.js. This is a presentation rewrite.
 */
(function (g) {
  "use strict";

  // ---- injected dependencies (renderer/app.js owns these) ----
  var api, esc, el, toast, copy, TOK, showConfirm, showPrompt, relTime, idHtml;
  var running = function () { return false; };
  var activeView = function () { return ""; };

  let axView = "swap";                    // swap | market | activity | otc | wallet
  let axSell = true;                      // swap direction
  let axSlip = 4.2;                       // buy-sweep max slippage %
  let axStatusCache = { ready: false };
  let axLastBook = null;
  let axMakerCfgCache = null;             // last maker read-model {cfg,manual,state,lastPublishMs} — for editor re-render on toggle
  let axPegMode = null;                   // maker editor peg/manual toggle (null = defer to saved cfg.pegEnable)
  let axEditing = false;                  // Market tab: editing your own order? (donor S.editing) — false shows Edit/Publish buttons
  let axEnaMode = null;                   // maker editor "Enabled" switch (null = defer to saved state.withdrawn)
  let axOracleMid = 0;                    // last live oracle mid (peg) — drives the ladder generator while pegged
  let axPegPollTimer = null;              // interval polling the oracle price while the peg switch is on
  let axUpdateTimer = null;

  function resetAxState() { axView = "swap"; axSell = true; axSlip = 4.2; axStatusCache = { ready: false }; axLastBook = null; axAmt = ""; axBalsCache = null; axQuoteMeta = null; axEditing = false; axPegMode = null; axEnaMode = null; axMakerCfgCache = null; axOracleMid = 0; axStopPegPoll(); if (axUpdateTimer) { clearTimeout(axUpdateTimer); axUpdateTimer = null; } }

  /**
   * RULE 2 — the Minima dollar token is MxUSD. The engine (main/atomix, byte-parity with the donor) still keys
   * the book as "mxusdt" and stamps rows with the donor's "mxUSDT" label; both are internal and stay. Every
   * string a user can read goes through this one mapping. "USDT" alone still names the Ethereum ERC-20 leg.
   */
  function axCcyName(l) { l = String(l == null ? "" : l); return /^mxusdt?$/i.test(l) ? "MxUSD" : (l.toLowerCase() === "minima" ? "MINIMA" : l); }
  function axCcyOf(st) { return st && st.currency === "minima" ? "MINIMA" : (st && st.currency === "mxusdt" ? "MxUSD" : "…"); }

  // ---- the APK header (MainActivity.header): AtomiX 21px bold −0.01em · currency pill · ☾/☀ pill · ● Mainnet ·
  //      "v… · block N · real funds". The tab bar is at the BOTTOM (axTabBar) — the only panel with one.
  function axHeader(active) {
    const st = axStatusCache;
    const ccy = axCcyOf(st);
    return `<div class="ax-head">
        <div class="ax-brand">AtomiX</div>
        <button class="ax-pill ax-pill--ccy" id="axCcy" title="Switch the traded currency">${esc(ccy)}</button>
        <button class="ax-pill" id="axTheme" title="Onyx / Daylight">${AX_THEME === "daylight" ? "☀" : "☾"}</button>
        <span class="ax-live${st.ready ? " is-on" : ""}"><span class="ax-live-dot"></span>${st.ready ? "Mainnet" : "starting…"}</span>
        <button class="ax-pill" id="axHelp" title="About AtomiX">?</button>
      </div>
      <div class="ax-sub" id="axSub">${axSubLine()}</div>`;
  }
  function axSubLine() { return "v" + (AX_VER || "…") + (AX_BLOCK > 0 ? "  ·  block " + AX_BLOCK : "") + "  ·  real funds"; }
  // The five tab icons, ported path-for-path from ic_tab_*.xml (24-grid, stroke 2, round caps). Order is the APK's.
  const AX_TABS = [
    ["swap", "Swap", "M7,4 L7,16 M7,16 L4,13 M7,16 L10,13 M17,20 L17,8 M17,8 L14,11 M17,8 L20,11"],
    ["wallet", "Wallet", "M6,6 h11 a3,3 0 0,1 3,3 v6 a3,3 0 0,1 -3,3 h-11 a3,3 0 0,1 -3,-3 v-6 a3,3 0 0,1 3,-3 z M16,12 h2.5"],
    ["activity", "Activity", "M3,12 h4 l2,6 l4,-14 l2,8 h6"],
    ["market", "Market", "M6,20 L6,10 M12,20 L12,4 M18,20 L18,14"],
    ["otc", "OTC", "M4,9 L18,9 M14,5 L18,9 L14,13 M20,15 L6,15 M10,11 L6,15 L10,19"]
  ];
  function axTabBar(active) {
    return `<nav class="ax-tabbar" id="axTabBar">` + AX_TABS.map(([v, l, d]) =>
      `<button class="ax-tab${active === v ? " is-on" : ""}" data-axview="${v}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${l}</span></button>`
    ).join("") + `</nav>`;
  }
  // ☾ / ☀ — the APK's own Onyx ⇄ Daylight, independent of the desktop shell's theme button. DIM is #8B909C in both.
  let AX_THEME = (() => { try { return localStorage.getItem("ax_theme") === "daylight" ? "daylight" : "onyx"; } catch (e) { return "onyx"; } })();
  let AX_VER = "", AX_BLOCK = 0;
  let axLastChart = null;                 // the series the Market chart last drew — redrawn on a theme flip
  /** Stamp theme + currency on the panel body AND on every open dialog (they live on <body>, outside #axBody). */
  function axApplyLook() {
    const ccy = axStatusCache.currency === "minima" ? "minima" : "mxusdt";
    const targets = [el("axBody")].concat(Array.from(document.querySelectorAll(".overlay.axapp")));
    targets.forEach(n => { if (n) { n.setAttribute("data-axtheme", AX_THEME); n.setAttribute("data-axccy", ccy); } });
  }
  function axToggleTheme() {
    AX_THEME = AX_THEME === "daylight" ? "onyx" : "daylight";
    try { localStorage.setItem("ax_theme", AX_THEME); } catch (e) {}
    axApplyLook();
    const t = el("axTheme"); if (t) t.textContent = AX_THEME === "daylight" ? "☀" : "☾";
    if (el("axChart") && axLastChart) { try { axDrawChart(el("axChart"), axLastChart); } catch (e) {} }   // the canvas reads its colours at draw time
  }
  function wireAxHeader() {
    const host = el("axBody");
    if (host && !el("axTabBar")) host.insertAdjacentHTML("beforeend", axTabBar(axView));   // every render ends here → one place
    document.querySelectorAll("#axBody [data-axview]").forEach(b => b.onclick = () => { axView = b.dataset.axview; renderAtomix(); });
    const c = el("axCcy"); if (c) c.onclick = axSwitchCurrency;
    const h = el("axHelp"); if (h) h.onclick = axWelcome;
    const t = el("axTheme"); if (t) t.onclick = axToggleTheme;
    axApplyLook();
  }

  /**
   * Refresh the header's currency/readiness in place — status only, no innerHTML on #axBody.
   *
   * axStatusCache used to be written in exactly ONE place (renderAtomix), and the live-update path never
   * called it, so once the engine flipped currency the body showed the new one (fresh label from axBook) while
   * the header and the "Switch to …" button kept the old one indefinitely. renderAtomix() is the wrong tool for
   * the push path: it awaits a 30s-bounded book scan and ends every branch in host.innerHTML, which would
   * destroy the maker editor and OTC inputs mid-typing — exactly what refreshAxActive's focus guard prevents.
   */
  async function axRefreshStatus() {
    const fresh = await api.axStatus().catch(() => null);
    if (!fresh) return;                                             // keep the last-good cache on a transient miss
    axStatusCache = fresh;
    axApplyLook();
    const live = document.querySelector("#axBody .ax-live");
    if (live) { live.classList.toggle("is-on", !!fresh.ready); live.innerHTML = `<span class="ax-live-dot"></span>${fresh.ready ? "Mainnet" : "starting…"}`; }
    const btn = el("axCcy"); if (btn) btn.textContent = axCcyOf(fresh);
  }
  async function renderAtomix() {
    const host = el("axBody");
    if (!host) return;
    if (!running()) { host.innerHTML = `${axHeader(axView)}<div class="ax-empty">Start your node to use AtomiX.</div>`; wireAxHeader(); return; }
    axStatusCache = await api.axStatus().catch(() => ({ ready: false }));
    // currency accent: MxUSD = Tether green, MINIMA = orange (donor trading.js) — scoped to .axapp by axApplyLook.
    if (!axStatusCache.ready) {
      host.innerHTML = `${axHeader(axView)}<div class="ax-empty">AtomiX is starting on your node — deriving your swap identity and registering the covenant. This clears on its own in a few seconds.</div>`;
      wireAxHeader(); return;
    }
    if (axView === "swap") return renderAxSwap();
    if (axView === "market") return renderAxMarket();
    if (axView === "activity") return renderAxActivity();
    if (axView === "otc") return renderAxOtc();
    if (axView === "wallet") return renderAxWallet();
  }

  // ---- Swap ----
  // donor swapplan (6dp grain) reproduced client-side for the LIVE typing estimate (labelled an estimate; the
  // engine's exact BigDecimal math is used on Review/execute). computeUsdt=floor6(ccy×price); computeMinima=floor6(usdt÷price).
  function ax6(x) { return isFinite(x) && x > 0 ? String(Math.floor(x * 1e6) / 1e6) : ""; }
  function axCleanNum(v) { return String(v).replace(/[^0-9.]/g, ""); }
  let axAmt = "";              // canonical ccy (mxUSDT/MINIMA) amount — bidirectional card keeps this
  let axPreviewTimer = null, axQuoteMeta = null;
  let axBalsCache = null;      // last wallet balances — instant paint; ETH reads are slow so we refresh async

  async function renderAxSwap() {
    const host = el("axBody");
    const [b, swaps] = await Promise.all([api.axBook().catch(() => null), api.axSwaps().catch(() => [])]);
    axLastBook = b;
    const ccy = axCcyName((b && b.label) || "mxUSDT");
    const bals = axBalsCache || { minima: "0", usdt: "0", eth: "0" };
    // refresh balances in the background (slow ETH reads) → patch the chips + stages without a full re-render
    api.axWallet().then(w => {
      if (!w || activeView() !== "atomix" || axView !== "swap") return;
      axBalsCache = w.bals;
      const chips = el("axBody").querySelectorAll(".ax-chip .ax-avail");
      // send chip is index 0, receive chip index 1; send=ccy in SELL, USDT in BUY
      if (chips[0]) chips[0].textContent = "avail " + (axSell ? w.bals.minima : w.bals.usdt);
      if (chips[1]) chips[1].textContent = "avail " + (axSell ? w.bals.usdt : w.bals.minima);
      const st = el("axBody").querySelector(".ax-stages"); if (st) st.innerHTML = axStagesRows(swaps, w.bals, ccy);
    }).catch(() => {});
    const q = b || {};
    const have = axSell ? (q.bestBid > 0) : (q.bestAsk > 0);
    const price = axSell ? q.bestBid : q.bestAsk;
    const cap = axSell ? q.bidCap : q.askCap;
    axQuoteMeta = { price, cap, ccy };

    const noQuote = !have ? `<div class="ax-card">
        <div style="font-weight:600">No one is quoting a ${axSell ? "buy" : "sell"} price right now.</div>
        <div class="ax-empty" style="margin-top:6px">Check back soon, or open Market to place your own order and wait for a match.</div>
        <button class="ax-btn ax-btn--sm" id="axOpenMarket" style="margin-top:8px">Open Market</button>
      </div>` : "";

    // market-context line — the swap page's at-a-glance book summary (maker count + best bid/ask + spread)
    const mktctx = b ? `<div class="ax-mktctx"><b>${b.scanned || 0}</b> maker${(b.scanned || 0) === 1 ? "" : "s"} on the book`
      + (b.bestBid ? ` · bid <b>${fmtPx(b.bestBid)}</b>` : "")
      + (b.bestAsk ? ` · ask <b>${fmtPx(b.bestAsk)}</b>` : "")
      + (b.bestBid && b.bestAsk ? ` · spread ${fmtPx(b.bestAsk - b.bestBid)}` : "") + `</div>` : "";

    const sendCcy = axSell;   // SELL → you send ccy; BUY → you send USDT
    const usdtEst = have ? ax6(Number(axAmt) * price) : "";
    const dual = have ? `<div class="ax-card">
        <div class="ax-lbl">YOU SEND</div>
        <div class="ax-amtrow">${axChip(sendCcy, ccy, bals)}<input class="ax-amt" id="ax${sendCcy ? "InCcy" : "InUsdt"}" inputmode="decimal" placeholder="0.00" value="${esc(sendCcy ? axAmt : usdtEst)}" autocomplete="off" /></div>
        <div class="ax-flip"><button class="ax-flipbtn" id="axFlip" title="Flip direction">⇅</button></div>
        <div class="ax-lbl">YOU RECEIVE (estimate)</div>
        <div class="ax-amtrow">${axChip(!sendCcy, ccy, bals)}<input class="ax-amt ax-amt--recv" id="ax${sendCcy ? "InUsdt" : "InCcy"}" inputmode="decimal" placeholder="0.00" value="${esc(sendCcy ? usdtEst : axAmt)}" autocomplete="off" /></div>
        ${axSell ? "" : axSlipRow()}
        <div class="ax-desc" id="axBestLine">${axBestLine(price, cap, ccy)}</div>
        <button class="ax-btn ax-btn--cta" id="axReview">Review swap</button>
        <div id="axStatusLine"></div>
      </div>` : "";

    host.innerHTML = `${axHeader("swap")}
      <div class="ax-pagettl">Swap ${esc(ccy)} ⇄ USDT</div>
      <div class="ax-desc ax-desc--page">Enter an amount — see exactly what you'll get at the best price.</div>
      <div class="ax-seg ax-seg--dir"><button class="ax-segbtn${axSell ? " is-on" : ""}" id="axDirSell">Sell ${esc(ccy)}</button><button class="ax-segbtn${axSell ? "" : " is-on"}" id="axDirBuy">Buy ${esc(ccy)}</button></div>
      ${mktctx}
      ${noQuote}${dual}
      ${axStages(swaps, bals, ccy)}`;
    wireAxHeader();
    el("axDirSell").onclick = () => { axSell = true; renderAxSwap(); };
    el("axDirBuy").onclick = () => { axSell = false; renderAxSwap(); };
    const om = el("axOpenMarket"); if (om) om.onclick = () => { axView = "market"; renderAtomix(); };
    const fl = el("axFlip"); if (fl) fl.onclick = () => { axSell = !axSell; renderAxSwap(); };
    wireAxSlipRow();
    const rv = el("axReview"); if (rv) rv.onclick = axDoReview;
    wireAxSwapInputs(price, ccy);
  }

  /** Coin chip with the live available balance (donor coinChip): disc badge + label + "avail X". */
  function axChip(isCcy, ccy, bals) {
    const avail = isCcy ? bals.minima : bals.usdt;
    return `<div class="ax-chip"><span class="ax-disc${isCcy ? "" : " usdt"}">${isCcy ? "M" : "$"}</span><span class="ax-tick">${esc(isCcy ? ccy : "USDT")}</span><span class="ax-avail">avail ${esc(avail)}</span></div>`;
  }
  /** Bidirectional wiring: typing one field updates the OTHER (never the focused one) + refreshes the best-price
   *  line via a debounced exact engine preview. No re-render → the edited field keeps focus (donor rule). */
  function wireAxSwapInputs(price, ccy) {
    const ccyIn = el("axInCcy"), usdtIn = el("axInUsdt");
    if (!ccyIn || !usdtIn) return;
    // strict numeric-only: keep at most one dot; sanitize the FIELD (not just axAmt) so text can't be entered.
    const sanitize = (inp) => { const c = axCleanNum(inp.value); if (c !== inp.value) { const at = inp.selectionStart; inp.value = c; try { inp.setSelectionRange(at - 1 < 0 ? 0 : at, at - 1 < 0 ? 0 : at); } catch (e) {} } return c; };
    ccyIn.addEventListener("input", () => {
      axAmt = sanitize(ccyIn);
      if (document.activeElement !== usdtIn) usdtIn.value = price > 0 && Number(axAmt) > 0 ? ax6(Number(axAmt) * price) : "";
      axSchedulePreview();
    });
    usdtIn.addEventListener("input", () => {
      const u = sanitize(usdtIn);
      axAmt = price > 0 && Number(u) > 0 ? ax6(Number(u) / price) : "";
      if (document.activeElement !== ccyIn) ccyIn.value = axAmt;
      axSchedulePreview();
    });
  }
  /** Debounced exact preview: refines the receive estimate + best-price line with the engine's real numbers
   *  (sweep avg differs from the single best price once the amount exceeds the best level's cap). */
  function axSchedulePreview() {
    if (axPreviewTimer) clearTimeout(axPreviewTimer);
    axPreviewTimer = setTimeout(async () => {
      if (activeView() !== "atomix" || axView !== "swap" || !axAmt) return;
      const pv = await api.axSwapPreview(axSell, axAmt, axSlip).catch(() => null);
      if (!pv || activeView() !== "atomix" || axView !== "swap") return;
      const bl = el("axBestLine");
      if (pv.err) { if (bl) bl.textContent = pv.err; return; }
      const m = pv.meta || {};
      if (bl) bl.textContent = axBestLine(m.bestPrice, m.bestCap, axCcyName(m.label), m.depth);
      // refine the RECEIVE field with exact engine math (not the local float), but never the focused input
      const recv = axSell ? el("axInUsdt") : el("axInCcy");
      if (recv && document.activeElement !== recv) {
        const val = pv.single ? (axSell ? pv.single.usdt : pv.single.minima) : (axSell ? String(pv.plan.totalUsdt) : String(pv.plan.filledMinima));
        if (val != null) recv.value = val;
      }
    }, 250);
  }
  function axBestLine(price, cap, ccy, depth) {
    if (!(price > 0)) return "No live makers on the book right now.";
    let s = `Best price ${fmtPx(price)} USDT/${ccy}  ·  up to ~${fmtAbbrev(cap)} at best`;
    if (depth != null && depth > cap + 1e-9) s += `, ~${fmtAbbrev(depth)} across the book`;
    if (!axSell) s += "  ·  ETH gas per part";
    return s;
  }
  function axSlipRow() {
    return `<div class="ax-kv ax-slip"><span>Max slippage</span><span class="ax-pills">${[2, 4.2].map(s => `<button class="ax-pill${axSlip === s ? " is-on" : ""}" data-axslip="${s}">${s}%</button>`).join("")}<button class="ax-pill${axSlip !== 2 && axSlip !== 4.2 ? " is-on" : ""}" id="axSlipCustom">${axSlip !== 2 && axSlip !== 4.2 ? axSlip + "%" : "Custom"}</button></span></div>`;
  }
  function wireAxSlipRow() {
    document.querySelectorAll("#axBody [data-axslip]").forEach(x => x.onclick = () => { axSlip = Number(x.dataset.axslip); renderAxSwap(); });
    const sc = el("axSlipCustom"); if (sc) sc.onclick = async () => {
      const v = await showPrompt("Custom max slippage", "", "e.g. 1.5", { message: "Percent (0.1 – 50). A BUY sweep will not take levels priced beyond this above the best ask." });
      const n = parseFloat(v); if (isFinite(n) && n >= 0.1 && n <= 50) { axSlip = Math.round(n * 10) / 10; renderAxSwap(); } else if (v != null) toast("Enter a percent between 0.1 and 50", "warn");
    };
  }
  // Price display — donor AX.fmt.px parity: 6 significant figures, trailing zeros stripped. (The old 2dp-above-1
  // rounding collapsed a near-1.0 mxUSDT book to "1" on every row — the ladder looked empty/degenerate.)
  function fmtPx(p) { p = Number(p); if (!isFinite(p) || p <= 0) return "0"; let s = p.toPrecision(6); if (s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; }

  /** The "YOUR SWAP" stages tracker (donor stages()): node/balance readiness + the in-flight swap's 4 legs. */
  function axStages(swaps, bals, ccy) {
    return `<div class="ax-lbl" style="margin-top:16px">YOUR SWAP</div><div class="ax-stages">${axStagesRows(swaps, bals, ccy)}</div>`;
  }
  function axStagesRows(swaps, bals, ccy) {
    const gt = v => parseFloat(v) > 0;
    const rows = [];
    rows.push(axStageRow(axStatusCache.ready ? "done" : "warn", "Node ready"));
    if (axSell) rows.push(axStageRow(gt(bals.minima) ? "done" : "pending", ccy + " ready to sell"));
    else { rows.push(axStageRow(gt(bals.usdt) ? "done" : "pending", "USDT ready to spend")); rows.push(axStageRow(gt(bals.eth) ? "done" : "pending", "ETH for gas")); }
    const sw = (swaps || []).find(s => s.status !== "COMPLETE" && s.status !== "REFUNDED" && s.status !== "ERROR");
    if (sw) {
      rows.push(`<div class="ax-swapline mono">${esc(sw.sellamount)} ${esc(axTok(sw.selltoken))} → ${esc(sw.buyamount)} ${esc(axTok(sw.buytoken))} · ${esc(String(sw.role).toLowerCase())}</div>`);
      rows.push(axStageRow(axLegDone(sw, 1), "Locked your " + esc(sw.sellamount) + " " + esc(axTok(sw.selltoken))));
      rows.push(axStageRow(axLegDone(sw, 2), "Counterparty locks their side"));
      rows.push(axStageRow(axLegDone(sw, 3), "Claim your " + esc(sw.buyamount) + " " + esc(axTok(sw.buytoken))));
      rows.push(axStageRow(axLegDone(sw, 4), "Swap complete"));
    } else rows.push(axStageRow("pending", "Enter an amount and tap Review to begin"));
    return rows.join("");
  }
  function axStageRow(state, text) { return `<div class="ax-stage ${state}"><span class="sdot"></span><span>${text}</span></div>`; }
  function axLegDone(sw, n) {
    const s = sw.status;
    if (s === "COMPLETE") return "done";
    if (s === "REFUNDED") return n === 1 ? "warn" : "pending";
    if (n === 1) return "done";
    if (n === 2) return (s === "LOCKED" || s === "CLAIMING") ? "active" : "pending";
    if (n === 3) return s === "CLAIMING" ? "active" : "pending";
    return "pending";
  }

  async function axDoReview() {
    if (!axAmt) { toast("Enter how much " + (axQuoteMeta ? axQuoteMeta.ccy : "MxUSD") + " to " + (axSell ? "sell" : "buy"), "warn"); return; }
    const q = await api.axQuote(axSell, axAmt, axSlip).catch(e => ({ err: String(e.message || e) }));
    if (q.err) { toast(q.err, "warn"); return; }
    const ccy = axCcyName(q.label), sh = s => { const n = Number(s); return isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : s; };
    let title, msg;
    if (q.single) {
      title = "Review — Sell " + ccy;
      msg = `Sell  ${q.single.minima} ${ccy}\nReceive  ≈ ${q.single.usdt} USDT\n\nBest price ${fmtPx(q.single.price)} USDT/${ccy}\nCounterparty\n${q.single.maker}\nThis locks your ${ccy} on-chain.`;
    } else {
      const p = q.plan, n = p.legs.length;
      const head = `Avg ${fmtPx(p.avgPrice)}  ·  worst ${fmtPx(p.worstPrice)} USDT/${ccy}${!axSell && p.slippagePct > 0 ? "  ·  within " + sh(p.slippagePct) + "% slippage" : ""}`;
      const parts = p.legs.map((l, i) => `Part ${i + 1} · ${l.minima} ${ccy} @ ${fmtPx(l.price)} → ${l.usdt} USDT\n  ${l.maker}`).join("\n");
      const total = axSell ? `Total: sell ${sh(p.filledMinima)} ${ccy} · receive ≈ ${sh(p.totalUsdt)} USDT` : `Total: pay ≈ ${sh(p.totalUsdt)} USDT · receive ≈ ${sh(p.filledMinima)} ${ccy}`;
      const partial = p.partial ? `\n\nFills ${fmtAbbrev(p.filledMinima)} of ${fmtAbbrev(p.target)} ${ccy} — ${(!axSell && p.stopReason === "slippage") ? "the rest is priced beyond your " + sh(p.slippagePct) + "% slippage." : "the rest isn't available in the book right now."}` : "";
      const gas = !axSell ? `\n\nEach part is a separate Ethereum transaction — you pay ETH gas ${n} ${n === 1 ? "time." : "times."}` : "";
      title = axSell ? `Sell ${fmtAbbrev(p.filledMinima)} ${ccy} in ${n} ${n === 1 ? "part" : "parts"}` : `Buy ≈ ${fmtAbbrev(p.filledMinima)} ${ccy} for ≈ ${sh(p.totalUsdt)} USDT in ${n} ${n === 1 ? "part" : "parts"}`;
      msg = `${head}\n\n${parts}\n\n${total}${partial}${gas}`;
    }
    const go = await showConfirm(title, msg, q.plan && q.plan.legs.length > 1 ? "Start sweep" : "Start swap");
    if (!go) return;
    const rv = el("axReview"); if (rv) rv.disabled = true;
    const r = await api.axSwap(q.quoteId).catch(e => ({ err: String(e.message || e) }));
    if (r && r.err) { toast(r.err, "warn"); }
    else if (r) { toast(`✓ ${r.ok}/${r.of} leg${r.of === 1 ? "" : "s"} locked — watching for the counterparty.${r.stopped ? " " + r.stopped : ""}`, "ok"); axAmt = ""; }
    if (activeView() === "atomix" && axView === "swap") renderAxSwap();
  }
  function axShort(pk) { pk = String(pk || ""); return pk.length < 14 ? pk : pk.slice(0, 8) + "…" + pk.slice(-6); }

  // ---- Market (donor marketTab: order book · your market editor/actions · market history) ----
  async function renderAxMarket() {
    const host = el("axBody");
    axStopPegPoll();
    const [b, mh, mc] = await Promise.all([api.axBook().catch(() => null), api.axMarketHistory().catch(() => ({ chart: [], recent: [] })), api.axMakerCfg().catch(() => null)]);
    axLastBook = b; axMakerCfgCache = mc; axLastChart = mh.chart;
    const ccy = axCcyName(b ? b.label : "mxUSDT");
    const count = b ? (b.scanned || 0) : 0;
    const others = b && b.makers > 0 && b.makers !== count ? ` · ${b.makers} other` : "";
    // "your market" — status line (LIVE / offline) + either the [Edit my order][Publish] actions or the editor.
    const yourMkt = axEditing
      ? axMakerEditor(mc, ccy, b)
      : `${axYourMarketStatus(mc, b)}<div class="ax-mkr-actions"><button class="ax-btn" id="axEdit">Edit my order</button><button class="ax-btn ax-btn--cta" id="axPublish">Publish</button></div>`;
    host.innerHTML = `${axHeader("market")}
      <div class="ax-card"><div class="ax-cardt">Order book · ${count} live${others}</div>
        <div class="ax-desc">The live order book. Tap a price to trade, or publish your own offer.</div>
        <div class="ax-ladder">${axLadder(b, ccy)}</div>
        <button class="ax-btn ax-btn--sm" id="axBookRefresh" style="margin-top:8px">Refresh</button>
      </div>
      <div class="ax-card"><div class="ax-cardt">Your market · ${esc(ccy)} ⇄ USDT</div><div id="axMktHost">${yourMkt}</div></div>
      ${axEditing ? "" : `<div class="ax-card"><div class="ax-cardt">Market history <span class="ax-st">price only</span></div>
        <canvas id="axChart" class="ax-chart"></canvas>
        <div class="ax-desc">${axHistLine(mh)}</div>${axHistRows(mh)}
      </div>`}`;
    wireAxHeader();
    el("axBookRefresh").onclick = renderAxMarket;
    // tap-to-trade: clicking a takeable level prefills the swap on the correct side (bid → you sell, ask → you buy)
    host.querySelectorAll(".ax-depth .ax-half[data-take]").forEach(h => h.onclick = () => { axSell = h.getAttribute("data-take") === "bid"; axView = "swap"; renderAtomix(); });
    if (axEditing) {
      axWireMakerEditor(ccy);
    } else {
      el("axEdit").onclick = () => { axEditing = true; axPegMode = null; renderAxMarket(); };
      el("axPublish").onclick = async () => { const btn = el("axPublish"); btn.disabled = true; btn.textContent = "Publishing…"; const r = await api.axMakerPublish().catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "✓ Market published", r && r.err ? "warn" : "ok"); renderAxMarket(); };
      setTimeout(() => { try { axDrawChart(el("axChart"), mh.chart); } catch (e) {} }, 0);
    }
  }
  /** "Your market" status: LIVE (own levels on the book, peg mid, last publish) or offline — so you can SEE your market. */
  function axYourMarketStatus(mc, b) {
    const st = (mc && mc.state) || {};
    let mine = 0, mineRows = "";
    if (b) {
      (b.bids || []).forEach(r => { if (r.mine) { mine++; mineRows += `<div class="ax-mymkt-row"><span class="bidpx">BID ${fmtPx(r.p)}</span><span class="ax-sz">${fmtAbbrev(r.cap)}</span></div>`; } });
      (b.asks || []).forEach(r => { if (r.mine) { mine++; mineRows += `<div class="ax-mymkt-row"><span class="askpx">ASK ${fmtPx(r.p)}</span><span class="ax-sz">${fmtAbbrev(r.cap)}</span></div>`; } });
    }
    const live = mine > 0 && !st.withdrawn;
    const mid = st.lastMid || st.lastPrice;
    const txt = live
      ? `LIVE · ${mine} level${mine === 1 ? "" : "s"} on the book` + (mid ? ` · mid ${fmtPx(mid)}` : "") + (mc && mc.lastPublishMs ? ` · published ${axAgo(mc.lastPublishMs)}` : "")
      : (st.withdrawn ? "Offline · market withdrawn" : "Offline · you have no live order");
    return `<div class="ax-mkr-status ${live ? "live" : "off"}"><span class="dot"></span>${esc(txt)}</div>`
      + (live ? `<div class="ax-mymkt">${mineRows}</div>` : "");
  }
  /** The live depth ladder (donor marketTab): spread line + legend + up to 12 paired bid│ask rows. */
  function axLadder(b, ccy) {
    if (!b || (!b.bids.length && !b.asks.length)) return `<div class="ax-empty">No live orders yet. Publish one below, or wait for a counterparty.</div>`;
    let out = "";
    if (b.bestBid && b.bestAsk) out += `<div class="ax-spread">spread ${fmtPx(b.bestAsk - b.bestBid)} USDT · USDT per ${esc(ccy)}, size in ${esc(ccy)}</div>`;
    out += `<div class="ax-legend"><span class="sell">SELL ${esc(ccy)} (bid)</span><span class="buy">BUY ${esc(ccy)} (ask)</span></div>`;
    const n = Math.min(Math.max(b.bids.length, b.asks.length), 12);
    for (let i = 0; i < n; i++) out += axDepthRow(b.bids[i], b.asks[i], i === 0);
    return out;
  }
  function axDepthRow(bid, ask, best) {
    return `<div class="ax-depth${best ? " best" : ""}">${axDepthHalf(bid, true)}<span class="divider">│</span>${axDepthHalf(ask, false)}</div>`;
  }
  function axDepthHalf(row, isBid) {
    if (!row) return `<div class="ax-half${isBid ? " bid" : ""}"><span class="ax-sz">—</span></div>`;
    const take = !row.mine && row.cap > 0;
    const tag = row.mine ? `<span class="ax-tag you">you</span>` : `<span class="ax-tag">${idHtml(row.signer, axShort(row.signer))}</span>`;
    return `<div class="ax-half${isBid ? " bid" : ""}${take ? " takeable" : ""}"${take ? ` data-take="${isBid ? "bid" : "ask"}"` : ""}>`
      + `<span class="top"><span class="ax-px ${isBid ? "bidpx" : "askpx"}">${fmtPx(row.p)}</span><span class="ax-sz">${fmtAbbrev(row.cap)}</span></span>${tag}</div>`;
  }
  // Size display — donor AX.fmt.abbrev parity: "—" for ≤0; floor to 2dp (<10) or 1dp (≥10); "k" ≥ 1000.
  function fmtAbbrev(v) { v = Number(v); if (!(v > 0)) return "—"; const trim = x => { const dp = x < 10 ? 2 : 1, f = Math.pow(10, dp); return (Math.floor(x * f) / f).toString(); }; return v >= 1000 ? trim(v / 1000) + "k" : trim(v); }
  function axHistLine(mh) {
    const last = mh.chart.length ? fmtPx(mh.chart[mh.chart.length - 1].price) : "—";
    let ex = 0, op = 0; (mh.recent || []).forEach(t => { if (t.status === "EXECUTED") ex++; else if (t.status === "OPEN") op++; });
    return `last ${last} · ${ex} filled · ${op} open`;
  }
  function axHistRows(mh) {
    if (!(mh.recent || []).length) return `<div class="ax-empty">No trades observed yet — AtomiX records swaps network-wide as they happen (no backfill).</div>`;
    return mh.recent.map(t => {
      const cls = t.status === "EXECUTED" ? "var(--ax-in)" : t.status === "REFUNDED" ? "var(--ax-red)" : "var(--ax-dim)";
      const lbl = t.status === "EXECUTED" ? "filled" : t.status === "REFUNDED" ? "cancelled" : "open";
      return `<div class="ax-row" style="justify-content:space-between"><span class="mono">${fmtPx(t.price)}</span><span class="mono" style="color:var(--ax-dim)">${fmtAbbrev(Number(t.sizeMinima))} M</span><span class="ax-st" style="color:${cls}">${lbl}</span></div>`;
    }).join("");
  }
  function axDrawChart(canvas, data) {
    const cv = canvas && canvas.getContext && canvas.getContext("2d"); if (!cv) return;
    // Size the bitmap from the CSS box at device resolution, then draw in CSS pixels — a fixed 640-wide
    // bitmap stretched to the card width distorted every glyph and dot, and blurred on Retina.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 180;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    cv.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 46, padR = 8, padT = 8, padB = 16;
    const css = getComputedStyle(el("axBody") || document.documentElement);
    const ACC = (css.getPropertyValue("--ax-accent") || "#F7931A").trim(), DIM = (css.getPropertyValue("--ax-dim2") || "#6F7583").trim();
    cv.clearRect(0, 0, w, h); cv.font = "11px \"JetBrains Mono\", ui-monospace, monospace"; cv.fillStyle = DIM;
    if (!data || data.length < 2) { cv.fillText(!data || !data.length ? "Collecting market data…" : "need 2+ trades to chart", padL, h / 2); return; }
    let minP = Infinity, maxP = -Infinity, minB = Infinity, maxB = -Infinity;
    data.forEach(t => { minP = Math.min(minP, t.price); maxP = Math.max(maxP, t.price); minB = Math.min(minB, t.createdBlock); maxB = Math.max(maxB, t.createdBlock); });
    if (maxP <= minP) maxP = minP + Math.max(minP * 0.001, 1e-9); if (maxB <= minB) maxB = minB + 1;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const px = bk => padL + ((bk - minB) / (maxB - minB)) * plotW, py = v => padT + (1 - (v - minP) / (maxP - minP)) * plotH;
    cv.strokeStyle = DIM; cv.lineWidth = 1; cv.beginPath(); cv.moveTo(padL, padT); cv.lineTo(padL, h - padB); cv.lineTo(w - padR, h - padB); cv.stroke();
    cv.fillText(String(fmtPx(maxP)), 2, padT + 9); cv.fillText(String(fmtPx(minP)), 2, h - padB);
    cv.strokeStyle = ACC; cv.lineWidth = 2; cv.beginPath();
    data.forEach((t, i) => { const x = px(t.createdBlock), y = py(t.price); if (i === 0) cv.moveTo(x, y); else cv.lineTo(x, y); }); cv.stroke();
    cv.fillStyle = ACC; data.forEach(t => { cv.beginPath(); cv.arc(px(t.createdBlock), py(t.price), 2.5, 0, Math.PI * 2); cv.fill(); });
  }
  /** "12s ago" / "4m ago" / "2h ago" from an epoch-ms timestamp. */
  function axAgo(ms) {
    const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
    if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago";
  }
  // donor editRow/editInput/toggle → label-left / input-right rows, an On/Off pill, exact donor labels.
  function axEditRow(label, right) { return `<div class="ax-editrow"><span class="ax-editlabel">${label}</span>${right}</div>`; }
  function axEditInput(id, val) { return `<input class="ax-editinput mono" id="${id}" inputmode="decimal" placeholder="0" value="${esc(val)}" autocomplete="off" />`; }
  function axSwitch(id, on) { return `<button class="ax-switch${on ? " on" : ""}" id="${id}" role="switch" aria-checked="${on}"><span class="knob"></span></button>`; }
  function axGenField(id, val, ph) { return `<input class="ax-genfield mono" id="${id}" inputmode="decimal" placeholder="${esc(ph || "")}" value="${esc(val == null ? "" : val)}" autocomplete="off" />`; }
  // Generator field with a PERSISTENT "Name · unit" caption (label-left, reuses the .ax-editrow pattern) so the field
  // is identifiable even with a value typed — placeholders alone vanish on input. Same id → wiring is unchanged.
  function axGenRow(label, id, val) { return `<div class="ax-editrow"><span class="ax-editlabel">${label}</span>${axGenField(id, val, "0")}</div>`; }
  /** One editable ladder level: tag (A1/B1…) + price + size. cls = "ask" | "bid". */
  function axLevelRow(tag, idP, idA, pv, av, cls) {
    return `<div class="ax-lvl ${cls}"><span class="ax-lvl-tag">${tag}</span>`
      + `<input class="ax-lvl-p mono" id="${idP}" inputmode="decimal" placeholder="price" value="${esc(pv == null ? "" : pv)}" autocomplete="off" />`
      + `<input class="ax-lvl-a mono" id="${idA}" inputmode="decimal" placeholder="size" value="${esc(av == null ? "" : av)}" autocomplete="off" /></div>`;
  }
  /** Inline cockpit field: a small label + narrow input on one line (dense). */
  function axFld(label, id, val) { return `<span class="ax-fld"><b>${label}</b>${axGenField(id, val, "")}</span>`; }
  /** One editable ladder row, MIRRORING the read-only book (axDepthRow): bid half (amount OUTER / price INNER, via
   *  CSS row-reverse) │ ask half (price INNER / amount OUTER). Same rung IDs (axBidP/A, axAskP/A) → wiring unchanged. */
  function axMakerRow(i, best, bp, ba, ap, aa) {
    const inp = (cls, id, v, ph) => `<input class="${cls} mono" id="${id}" inputmode="decimal" placeholder="${ph}" value="${esc(v == null ? "" : v)}" autocomplete="off" />`;
    return `<div class="ax-mrow${best ? " best" : ""}" id="axRow${i}">`
      + `<div class="ax-mhalf bid"><div class="top">${inp("ax-px bidpx", "axBidP" + i, bp, "price")}${inp("ax-sz", "axBidA" + i, ba, "size")}</div></div>`
      + `<span class="divider">│</span>`
      + `<div class="ax-mhalf ask"><div class="top">${inp("ax-px askpx", "axAskP" + i, ap, "price")}${inp("ax-sz", "axAskA" + i, aa, "size")}</div></div></div>`;
  }
  function axStartPegPoll(fn) { axStopPegPoll(); fn(); axPegPollTimer = setInterval(() => { if (activeView() === "atomix" && axView === "market" && axEditing) fn(); else axStopPegPoll(); }, 2500); }
  function axStopPegPoll() { if (axPegPollTimer) { clearInterval(axPegPollTimer); axPegPollTimer = null; } }
  /** The maker editor — MIRRORS the read-only order book: a compact CONTROL COCKPIT (Enabled + Peg toggles, live
   *  oracle, and one row of fields mid·step·levels·size·skew·reprice) over a single ladder where BIDS are on the LEFT
   *  and ASKS on the RIGHT, prices meeting in the middle at the spread, amounts on the outer edges, best row on top.
   *  Auto (peg) mode by default; `size` seeds every rung and each amount stays editable; only `levels` rungs show. */
  function axMakerEditor(mc, ccy, b) {
    const c = (mc && mc.cfg) || {}, st = (mc && mc.state) || {}, man = (mc && mc.manual) || { bids: [], asks: [] };
    const parity = b ? !!b.pricingParity : (axStatusCache.currency === "mxusdt");
    const src = parity ? "Parity" : "MEXC";
    const enabled = axEnaMode != null ? axEnaMode : !st.withdrawn;
    const peg = axPegMode != null ? axPegMode : (c.step > 0 ? !!c.pegEnable : true);   // default AUTO for a fresh market
    const asks = (man.asks || []).slice().sort((x, y) => x.p - y.p);   // ascending → index 0 = best (lowest) ask
    const bids = (man.bids || []).slice().sort((x, y) => y.p - x.p);   // descending → index 0 = best (highest) bid
    let rows = "";
    for (let i = 0; i < 6; i++) { const bl = bids[i] || {}, al = asks[i] || {}; rows += axMakerRow(i, i === 0, bl.p, bl.a, al.p, al.a); }
    const oracle = peg ? "fetching " + src + " price…" : (src === "Parity" ? "Parity · mid 1.0" : "peg off");
    const sz = c.size != null ? c.size : (c.askSize != null ? c.askSize : "");
    return `<div class="ax-cockpit-top">`
        + `<span class="ax-tog"><span class="ax-tog-l">Enabled</span>${axSwitch("axEnabled", enabled)}</span>`
        + `<span class="ax-tog"><span class="ax-tog-l">Peg → ${src}</span>${axSwitch("axPegToggle", peg)}</span>`
        + `<span class="ax-oracle mono" id="axOracle">${oracle}</span></div>`
      + `<div class="ax-cockpit">`
        + axFld("mid", "axMid", "")
        + axFld("step %", "axStep", c.step != null ? c.step : "1")
        + axFld("levels", "axLevels", c.levels != null ? c.levels : "3")
        + axFld("size", "axSize", sz)
        + axFld("skew %", "axBias", c.bias != null ? c.bias : "0")
        + axFld("reprice %", "axReprice", c.reprice != null ? c.reprice : "1")
        + `</div>`
      + `<div class="ax-mkr-hint">Auto mode: prices track the ${src} mid · <b>size</b> seeds every rung — edit any amount or price · only your chosen levels show</div>`
      + `<div class="ax-legend"><span class="sell">BIDS · you buy ${esc(ccy)}</span><span class="buy">ASKS · you sell ${esc(ccy)}</span></div>`
      + `<div class="ax-mcolhdr"><span>amount&nbsp;·&nbsp;price</span><span>price&nbsp;·&nbsp;amount</span></div>`
      + `<div id="axLadder">${rows}</div>`
      + `<div class="ax-spread-mid mono" id="axSpread">—</div>`
      + `<div class="ax-mkr-foot">`
        + axEditRow("Min trade · " + esc(ccy), axEditInput("axMin", c.min != null ? c.min : ""))
        + `<div class="ax-prev" id="axMkrPreview"><div class="ax-empty">—</div></div></div>`
      + `<button class="ax-btn ax-btn--cta" id="axSave" style="margin-top:12px">Save &amp; publish</button>`
      + `<div class="ax-mkr-actions" style="margin-top:8px"><button class="ax-btn" id="axWithdraw">Withdraw market</button><button class="ax-btn" id="axCancel">Cancel</button></div>`;
  }
  function axWireMakerEditor(ccy) {
    const num = id => { const e = el(id); return e ? (Number(e.value) || 0) : 0; };
    const pegOn = () => { const e = el("axPegToggle"); return !!(e && e.classList.contains("on")); };
    const enaOn = () => { const e = el("axEnabled"); return !!(e && e.classList.contains("on")); };
    const getRows = pfx => { const out = []; for (let i = 0; i < 6; i++) out.push({ p: num(pfx + "P" + i), a: num(pfx + "A" + i) }); return out; };
    const collect = () => ({ asks: getRows("axAsk").filter(l => l.p > 0 && l.a > 0), bids: getRows("axBid").filter(l => l.p > 0 && l.a > 0) });
    let filling = false;
    // live preview summary from the rows (native updateLadderPreview): level counts, best prices, side totals, crossed
    const updPreview = () => {
      const host = el("axMkrPreview"); if (!host) return;
      const { asks, bids } = collect();
      // centered spread readout between the twin ladders
      const sp = el("axSpread");
      if (sp) {
        if (asks.length && bids.length) {
          const ba = Math.min(...asks.map(l => l.p)), bb = Math.max(...bids.map(l => l.p)), d = ba - bb;
          sp.textContent = d > 0 ? `spread ${fmtPx(d)} · ${(d / bb * 100).toFixed(1)}%` : "⚠ crossed";
          sp.classList.toggle("crossed", d <= 0);
        } else { sp.textContent = "—"; sp.classList.remove("crossed"); }
      }
      if (asks.length && bids.length) {
        const bestAsk = Math.min(...asks.map(l => l.p)), bestBid = Math.max(...bids.map(l => l.p));
        if (bestBid >= bestAsk) { host.innerHTML = `<div class="ax-prev-cross">⚠ Crossed — best bid ${fmtPx(bestBid)} ≥ best ask ${fmtPx(bestAsk)}: you'd sell cheaper than you buy</div>`; return; }
      }
      const sum = arr => arr.reduce((s, l) => s + l.a, 0);
      const bidS = bids.length ? `${bids.length} lvl · best ${fmtPx(Math.max(...bids.map(l => l.p)))} · ${fmtAbbrev(sum(bids))} ${esc(ccy)}` : "none";
      const askS = asks.length ? `${asks.length} lvl · best ${fmtPx(Math.min(...asks.map(l => l.p)))} · ${fmtAbbrev(sum(asks))} ${esc(ccy)}` : "none";
      host.innerHTML = `<div class="ax-prev-sum mono"><div><span class="bidpx">BIDS</span>&nbsp; ${bidS}</div><div><span class="askpx">ASKS</span>&nbsp; ${askS}</div></div>`;
    };
    const clampLevels = () => Math.max(1, Math.min(6, Math.floor(num("axLevels")) || 1));
    const showLevels = () => { const L = clampLevels(); for (let i = 0; i < 6; i++) { const r = el("axRow" + i); if (r) r.style.display = i < L ? "" : "none"; } };
    // PRICES from mid·step·skew for the visible rungs (prices are auto); blank hidden rungs so they aren't published;
    // seed only EMPTY sizes so a hand-edited amount survives a re-price. Called on mid/step/skew/levels + the peg tick.
    const reprice = midOverride => {
      const m = midOverride != null ? midOverride : num("axMid"), step = num("axStep"), size = num("axSize"), L = clampLevels();
      const quoted = m * (1 + Math.max(-20, Math.min(20, num("axBias"))) / 100);
      filling = true;
      try {
        for (let i = 0; i < 6; i++) {
          const on = i < L, bp = el("axBidP" + i), ap = el("axAskP" + i), ba = el("axBidA" + i), aa = el("axAskA" + i);
          if (on) {
            if (m > 0 && step > 0) { if (bp) bp.value = fmtPx(quoted * (1 - (i + 1) * step / 100)); if (ap) ap.value = fmtPx(quoted * (1 + (i + 1) * step / 100)); }
            if (size > 0) { if (ba && !ba.value) ba.value = fmtPx(size); if (aa && !aa.value) aa.value = fmtPx(size); }
          } else { if (bp) bp.value = ""; if (ap) ap.value = ""; if (ba) ba.value = ""; if (aa) aa.value = ""; }
        }
      } finally { filling = false; }
      showLevels(); updPreview();
    };
    // SIZE seeds every visible rung's amount — the ONE control that overwrites hand-edited amounts (the master size).
    const seedSizes = () => {
      const size = num("axSize"), L = clampLevels();
      filling = true;
      try { for (let i = 0; i < 6; i++) { const on = i < L, ba = el("axBidA" + i), aa = el("axAskA" + i); if (ba) ba.value = on && size > 0 ? fmtPx(size) : ""; if (aa) aa.value = on && size > 0 ? fmtPx(size) : ""; } }
      finally { filling = false; }
      updPreview();
    };
    // pegged: pull the live oracle mid from the engine, set the oracle line + mid field, regenerate the rows
    const refreshPeg = async () => {
      const pv = await api.axMakerPreview({ pegEnable: true, step: num("axStep"), askSize: num("axSize"), bidSize: num("axSize"), bias: num("axBias"), levels: num("axLevels") || 1, reprice: num("axReprice") || 1, min: num("axMin") }, {}).catch(() => null);
      if (!pv) return;
      axOracleMid = pv.mid || 0;
      const ol = el("axOracle"); if (ol) ol.textContent = pv.mid > 0 ? (esc(pv.source || ccy) + " · mid " + fmtPx(pv.mid) + (pv.fresh ? "" : " (stale)") + (pv.wide ? " · WIDE" : "")) : ("waiting for " + esc(pv.source || "market") + " price…");
      const midE = el("axMid"); if (midE && pegOn()) midE.value = pv.mid > 0 ? fmtPx(pv.mid) : "";
      if (pv.mid > 0 && pegOn()) reprice(pv.mid);
    };
    const pegModeUi = () => { const on = pegOn(), midE = el("axMid"); if (midE) { midE.disabled = on; midE.style.opacity = on ? "0.5" : "1"; } };

    const swEna = el("axEnabled"); if (swEna) swEna.onclick = () => { swEna.classList.toggle("on"); const on = swEna.classList.contains("on"); swEna.setAttribute("aria-checked", on); axEnaMode = on; };
    const swPeg = el("axPegToggle"); if (swPeg) swPeg.onclick = () => {
      swPeg.classList.toggle("on"); const on = swPeg.classList.contains("on"); swPeg.setAttribute("aria-checked", on); axPegMode = on; pegModeUi();
      if (on) axStartPegPoll(refreshPeg); else { axStopPegPoll(); const ol = el("axOracle"); if (ol) ol.textContent = "peg off"; reprice(); }
    };
    // price controls (mid/step/skew/levels) re-price the rungs (sizes preserved); `size` re-seeds every amount.
    ["axMid", "axStep", "axBias", "axLevels"].forEach(id => { const e = el(id); if (e) e.addEventListener("input", () => { if (filling) return; reprice(pegOn() && axOracleMid > 0 ? axOracleMid : undefined); }); });
    const szE = el("axSize"); if (szE) szE.addEventListener("input", () => { if (filling) return; seedSizes(); });
    for (let i = 0; i < 6; i++) ["axAskP", "axAskA", "axBidP", "axBidA"].forEach(pfx => { const e = el(pfx + i); if (e) e.addEventListener("input", () => { if (!filling) updPreview(); }); });
    const minE = el("axMin"); if (minE) minE.addEventListener("input", updPreview);

    const finish = () => { axEditing = false; axPegMode = null; axEnaMode = null; axStopPegPoll(); renderAxMarket(); };
    el("axSave").onclick = async () => {
      const btn = el("axSave"); btn.disabled = true; btn.textContent = "Saving…";
      if (!enaOn()) {   // Enabled OFF → withdraw (tombstone), like the native disable
        const r = await api.axMakerWithdraw().catch(e => ({ err: String(e.message || e) }));
        toast(r && r.err ? r.err : "Market withdrawn", r && r.err ? "warn" : "ok"); finish(); return;
      }
      const step = num("axStep"), size = num("axSize");
      const cfg = { pegEnable: pegOn() && step > 0 && size > 0, step, size, askSize: size, bidSize: size, bias: num("axBias"), reprice: num("axReprice") || 1, levels: clampLevels(), min: num("axMin") };
      const r = await api.axMakerSave(cfg, collect()).catch(e => ({ err: String(e.message || e) }));
      toast(r && r.err ? r.err : "✓ Market saved + published", r && r.err ? "warn" : "ok"); finish();
    };
    el("axWithdraw").onclick = async () => { if (!await showConfirm("Withdraw your market?", "Your order is tombstoned so peers stop trading against it.", "Withdraw", true)) return; const r = await api.axMakerWithdraw().catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "Market withdrawn", r && r.err ? "warn" : "ok"); finish(); };
    el("axCancel").onclick = finish;

    pegModeUi(); showLevels();
    if (num("axSize") > 0) reprice();   // on open: seed prices (if mid set) + fill empty amounts for the visible rungs
    updPreview();
    if (pegOn()) axStartPegPoll(refreshPeg);
  }

  // ---- Activity ----
  async function renderAxActivity() {
    const host = el("axBody");
    const swaps = await api.axSwaps().catch(() => []);
    host.innerHTML = `${axHeader("activity")}<div class="ax-card">
      <div class="ax-cardt" style="display:flex;justify-content:space-between;align-items:center">
        <span>Your swaps</span>
        ${swaps.length ? '<button class="ax-btn ax-btn--ghost" id="axExportBtn" title="Export all your swaps (maker + taker) as CSV">⬇ Export CSV</button>' : ""}
      </div>
      ${swaps.length ? "" : '<div class="ax-empty">No swaps yet — your completed and refunded swaps appear here.</div>'}
      <div id="axSwapList">${axSwapRows(swaps)}</div></div>`;
    wireAxHeader();
    wireAxSwapRows();
    const eb = el("axExportBtn"); if (eb) eb.onclick = () => axExportCsv();
  }
  // Export the user's full swap history to CSV — one file, each row tagged Maker (RESPONDER) or Taker (INITIATOR),
  // with the on-chain leg tx ids. Reuses the History tab's formula-injection sanitizer + the generic save-dialog IPC.
  async function axExportCsv() {
    const rows = await api.axExportSwaps().catch(() => []);
    if (!rows.length) { toast("No swaps to export", ""); return; }
    const q = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const cols = ["Date", "Role", "Direction", "Sold Amount", "Sold Token", "Bought Amount", "Bought Token", "Price (USDT/MINIMA)", "Counterparty", "Status", "Contract Id", "Minima Tx", "Eth Tx"];
    // One role mapping for the whole app (axRoleLabel), capitalised for the file so the CSV's existing
    // "Maker"/"Taker" column is byte-identical to before — the ledger in tools/dexHistory reads these columns.
    const roleLabel = (r) => { const x = axRoleLabel(r); return x ? x[0].toUpperCase() + x.slice(1) : ""; };
    const dirLabel = (d) => d === "MINIMA_TO_ERC20" ? "Sell MINIMA" : (d === "ERC20_TO_MINIMA" ? "Buy MINIMA" : (d || ""));
    const iso = (ms) => { const n = Number(ms); return (n > 0 && isFinite(n)) ? new Date(n).toISOString() : ""; };
    const price = (s) => {   // USDT per MINIMA, comparable across both directions
      const sell = parseFloat(s.sellAmount), buy = parseFloat(s.buyAmount);
      if (!(sell > 0) || !(buy > 0)) return "";
      const p = s.direction === "MINIMA_TO_ERC20" ? buy / sell : (s.direction === "ERC20_TO_MINIMA" ? sell / buy : 0);
      return p > 0 ? String(Number(p.toPrecision(8))) : "";
    };
    const lines = rows.map(s => [iso(s.created), roleLabel(s.role), dirLabel(s.direction),
      s.sellAmount, axTok(s.sellToken), s.buyAmount, axTok(s.buyToken), price(s),
      s.counterparty, String(s.status == null ? "" : s.status).toLowerCase(), s.contractId, s.minimaTx, s.ethTx].map(q).join(","));
    const csv = [cols.join(","), ...lines].join("\r\n");
    const path = await api.exportCsv(csv, "atomix-trades.csv").catch(() => null);
    toast(path ? `Saved ${rows.length} trades ✓` : "Export cancelled", path ? "ok" : "");
  }
  // Native parity (MainActivity.historySwapCard): three lines, not one. The old single line showed only
  // amounts + raw status, which told you nothing about WHEN, WHICH SIDE you were, or WHO with.
  //   1. amounts + the status pill
  //   2. how long ago · your side · the counterparty
  //   3. the engine's plain-language state line ("Done — received 4.95 USDT.")
  // The counterparty is rendered IN FULL, never shortened: an address exists to be copied and used, and
  // .row__l2 already word-breaks so a 64-char key wraps instead of overflowing. Click it to copy.
  function axSwapRows(swaps) {
    return swaps.map(s => {
      const meta = [relTime(s.created), axRoleLabel(s.role)].filter(Boolean).map(esc).join(" · ");
      const cp = s.counterparty
        ? ` · <span class="mono" data-axcopy="${esc(s.counterparty)}" style="cursor:copy" title="Click to copy">${esc(s.counterparty)}</span>`
        : "";
      return `<div class="ax-row" style="cursor:pointer" data-axhash="${esc(s.hash)}">
        <div class="ax-rowmid">
          <div class="ax-l1 mono">${esc(s.sellamount)} ${esc(axTok(s.selltoken))} → ${esc(s.buyamount)} ${esc(axTok(s.buytoken))}</div>
          <div class="ax-l2">${meta}${cp}</div>
          ${s.detail ? `<div class="ax-l2">${esc(s.detail)}</div>` : ""}
        </div>
        <span class="ax-st">${esc(axStatusLabel(s.status))}</span></div>`;
    }).join("");
  }
  // RESPONDER makes the market, INITIATOR takes it. Same mapping the CSV export uses, so the tab and the
  // exported file never disagree about which side you were.
  function axRoleLabel(r) { return r === "RESPONDER" ? "maker" : (r === "INITIATOR" ? "taker" : String(r || "").toLowerCase()); }
  // Raw DB states are internal; these are the words the APK and the MiniDapp show. STARTED especially: your
  // leg is locked and nothing is wrong, so it reads "waiting", not "started".
  function axStatusLabel(st) {
    return { STARTED: "waiting", LOCKED: "locked", CLAIMING: "claiming", COMPLETE: "complete",
      REFUNDED: "refunded", ERROR: "failed" }[st] || String(st == null ? "" : st).toLowerCase();   // ERROR = a leg lost/unrecoverable; the row's detail says why
  }
  function axTok(t) { if (typeof t === "string" && t.indexOf("0x") === 0) { const l = String(t).toLowerCase(); if (l === "0x00") return "MINIMA"; if (l.indexOf("7d39745") >= 0) return "MxUSD"; } return t; }
  function wireAxSwapRows() {
    // Copy the FULL counterparty without also opening the inspect modal the row click triggers.
    document.querySelectorAll("#axBody [data-axcopy]").forEach(n => n.onclick = (e) => {
      e.stopPropagation(); copy(n.dataset.axcopy); });
    document.querySelectorAll("#axBody [data-axhash]").forEach(r => r.onclick = async () => {
      toast("Checking…");
      const lines = await api.axInspect(r.dataset.axhash).catch(e => ["Check failed: " + (e.message || e)]);
      showAxReport(r.dataset.axhash, lines);
    });
  }
  function showAxReport(hash, lines) {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay axapp" id="axRepOv"><div class="ax-modal">
      <div class="ax-modt">Swap status</div><div class="ax-desc" style="white-space:pre-wrap">${esc(lines.join("\n"))}</div>
      <div class="ax-seg" style="margin-top:12px"><button class="ax-btn" id="axRepClose">Close</button><button class="ax-btn ax-btn--cta" id="axRepAgain">Check again</button></div></div></div>`); axApplyLook();
    const ov = el("axRepOv"); const close = () => ov && ov.remove();
    el("axRepClose").onclick = close;
    el("axRepAgain").onclick = async () => { close(); const l = await api.axInspect(hash).catch(e => ["Check failed"]); showAxReport(hash, l); };
    ov.onclick = e => { if (e.target.id === "axRepOv") close(); };
  }

  // ---- OTC ----
  async function renderAxOtc() {
    const host = el("axBody");
    const o = await api.axOtc().catch(() => ({ board: [], deals: [], myOffer: {} }));
    const ccy = axCcyOf(axStatusCache);
    host.innerHTML = `${axHeader("otc")}
      <div class="ax-card"><div class="ax-cardt">Your availability (${esc(ccy)})</div>
        <div class="ax-row"><div class="ax-field" style="flex:1"><div class="ax-lbl">Max to SELL</div><input class="ax-input" id="axOtcSell" value="${o.myOffer && o.myOffer.sellSize || ""}" /></div>
          <div class="ax-field" style="flex:1"><div class="ax-lbl">Max to BUY</div><input class="ax-input" id="axOtcBuy" value="${o.myOffer && o.myOffer.buySize || ""}" /></div></div>
        <div class="ax-seg"><button class="ax-btn ax-btn--cta" id="axOtcLive">Go live</button><button class="ax-btn" id="axOtcWithdraw">Withdraw</button></div></div>
      <div class="ax-card"><div class="ax-cardt">LP board</div>${o.board.length ? o.board.map((lp, i) => `<div class="ax-row" style="justify-content:space-between"><span class="mono" style="font-size:12px">${idHtml(lp.cid, TOK.shortId(lp.cid))}</span><span>sell ${esc(lp.sell)} · buy ${esc(lp.buy)}</span><button class="ax-btn ax-btn--sm" data-axlp="${i}">Propose</button></div>`).join("") : '<div class="ax-empty">No LPs live right now.</div>'}</div>
      <div class="ax-card"><div class="ax-cardt">Your deals</div>${o.deals.length ? o.deals.map(d => axDealRow(d)).join("") : '<div class="ax-empty">No active deals.</div>'}</div>`;
    wireAxHeader();
    el("axOtcLive").onclick = async () => { const r = await api.axOtcGoLive(el("axOtcSell").value, el("axOtcBuy").value).catch(e => ({ err: String(e.message || e) })); toast(r && r.err ? r.err : "✓ Availability published", r && r.err ? "warn" : "ok"); };
    el("axOtcWithdraw").onclick = async () => { await api.axOtcWithdraw().catch(() => {}); toast("Availability withdrawn"); };
    document.querySelectorAll("#axBody [data-axlp]").forEach(btn => btn.onclick = () => axOtcPropose(o.board[Number(btn.dataset.axlp)]));
    document.querySelectorAll("#axBody [data-axaccept]").forEach(btn => btn.onclick = async () => { await api.axOtcDeal(btn.dataset.axaccept, "accept").catch(e => toast(e.message || e, "warn")); renderAxOtc(); });
    document.querySelectorAll("#axBody [data-axreject]").forEach(btn => btn.onclick = async () => { await api.axOtcDeal(btn.dataset.axreject, "reject").catch(() => {}); renderAxOtc(); });
  }
  function axDealRow(d) {
    const canAct = d.whoseTurn === "ME" && (d.status === "PROPOSED" || d.status === "COUNTERED");
    return `<div class="ax-row" style="justify-content:space-between"><span class="mono" style="font-size:12px">${esc(d.side)} ${esc(d.amount)} @ ${esc(d.price)}</span><span class="ax-st">${esc(String(d.status).toLowerCase())}</span>${canAct ? `<span><button class="ax-btn ax-btn--sm ax-btn--fill" data-axaccept="${esc(d.ref)}">Accept</button> <button class="ax-btn ax-btn--sm ax-btn--danger" data-axreject="${esc(d.ref)}">Reject</button></span>` : ""}</div>`;
  }
  async function axOtcPropose(lp) {
    if (!lp) return;
    const sideRaw = await showPrompt("Deal side", "SELL", "SELL or BUY", { message: "SELL = you buy their " + axCcyOf(axStatusCache) + "; BUY = you sell yours." });
    if (!sideRaw) return;
    const side = String(sideRaw).trim().toUpperCase();
    if (side !== "SELL" && side !== "BUY") { toast("Side must be SELL or BUY", "warn"); return; }
    const amount = await showPrompt("Amount", "", "0.0"); if (!amount) return;
    const price = await showPrompt("Price (USDT each)", "", "1.0"); if (!price) return;
    const r = await api.axOtcPropose({ cid: lp.cid, mpk: lp.mpk, eth: lp.eth }, side, amount, price).catch(e => ({ err: String(e.message || e) }));
    toast(r && r.err ? r.err : "✓ Proposed — waiting on the LP", r && r.err ? "warn" : "ok"); renderAxOtc();
  }

  // ---- Wallet (ETH) ----
  async function renderAxWallet() {
    const host = el("axBody");
    const w = await api.axWallet().catch(() => null);
    if (!w) { host.innerHTML = `${axHeader("wallet")}<div class="ax-empty">Wallet not ready.</div>`; wireAxHeader(); return; }
    const b = w.bals, m = b.meta;
    const locked = m ? Math.max(0, (Number(m.confirmed) || 0) - (Number(m.sendable) || 0)) : 0;
    host.innerHTML = `${axHeader("wallet")}
      <div class="ax-card ax-card--tap" id="axMinCard"><div class="ax-cardt">${esc(axCcyName(w.label))} · available to swap</div>
        <div class="ax-big ax-big--accent">${esc(b.minima)} ${esc(axCcyName(w.label))}</div>
        <div class="ax-desc">${m ? `confirmed ${m.confirmed} · locked ≈ ${Math.round(locked * 1e6) / 1e6} · unconfirmed ${m.unconfirmed} · ${m.coins} coins · tap for coins` : ""}</div></div>
      <div class="ax-card ax-card--tap" id="axEthCard"><div class="ax-cardt">Ethereum</div>
        <div class="ax-big">${esc(b.eth)} ETH</div><div class="ax-desc mono">${idHtml(w.addr)}</div></div>
      <div class="ax-card"><div class="ax-cardt">USDT · Ethereum</div><div class="ax-big">${esc(b.usdt)} USDT</div></div>
      <div class="ax-seg" style="flex-wrap:wrap"><button class="ax-btn ax-btn--sm" id="axRefreshBal">Refresh</button><button class="ax-btn ax-btn--sm" id="axFund">Fund / QR</button><button class="ax-btn ax-btn--sm" id="axSend">Send</button><button class="ax-btn ax-btn--sm" id="axExport">Export key</button></div>
      ${b.ethErr ? `<div style="color:var(--ax-red);font-size:12px;padding:8px 2px 0">⚠ ${esc(b.ethErr)}</div>` : ""}`;
    wireAxHeader();
    el("axMinCard").onclick = axCoinDump;
    el("axEthCard").onclick = () => axReceive(w.addr);
    el("axRefreshBal").onclick = renderAxWallet;
    el("axFund").onclick = () => axReceive(w.addr);
    el("axSend").onclick = () => axSendDialog(w);
    el("axExport").onclick = axExportKey;
  }
  function axReceive(addr) {
    let qrHtml = "";
    if (typeof qrcode !== "undefined") { const qr = qrcode(0, "M"); qr.addData(addr); qr.make(); qrHtml = `<div style="background:#fff;padding:8px;border-radius:8px;width:fit-content;margin:10px auto">${qr.createImgTag(5, 6)}</div>`; }
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay axapp" id="axRxOv"><div class="ax-modal">
      <div class="ax-modt">Receive / Fund · Ethereum</div>
      <div class="mono" style="user-select:all;word-break:break-all;text-align:center;font-size:13px">${esc(addr)}</div>${qrHtml}
      <div class="ax-desc">Same address on all EVM networks — fund it with Ethereum ETH and tokens.</div>
      <div class="ax-seg" style="margin-top:12px"><button class="ax-btn" id="axRxClose">Close</button><button class="ax-btn ax-btn--cta" id="axRxCopy">Copy address</button></div></div></div>`); axApplyLook();
    const ov = el("axRxOv"); const close = () => ov && ov.remove();
    el("axRxClose").onclick = close; el("axRxCopy").onclick = () => { copy(addr); };
    ov.onclick = e => { if (e.target.id === "axRxOv") close(); };
  }
  async function axExportKey() {
    if (!await showConfirm("Export ETH private key", "This key controls your ETH funds. Anyone who sees it can take them. It is derived from your Minima node seed. Never share it or type it into a website.", "Reveal key", true)) return;
    const pk = await api.axExportKey().catch(() => null);
    if (!pk) { toast("Wallet not ready", "warn"); return; }
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay axapp" id="axPkOv"><div class="ax-modal">
      <div class="ax-modt">ETH private key</div><div class="ax-desc" style="color:var(--ax-red)">⚠ Keep this secret.</div>
      <div class="mono" style="user-select:all;word-break:break-all;font-size:12px">${esc(pk)}</div>
      <div class="ax-seg" style="margin-top:12px"><button class="ax-btn" id="axPkClose">Close</button><button class="ax-btn ax-btn--cta" id="axPkCopy">Copy key</button></div></div></div>`); axApplyLook();
    const ov = el("axPkOv"); const close = () => ov && ov.remove();
    el("axPkClose").onclick = close; el("axPkCopy").onclick = () => copy(pk);
    ov.onclick = e => { if (e.target.id === "axPkOv") close(); };
  }
  async function axCoinDump() {
    const rows = await api.axCoins().catch(() => []);
    const body = rows.length ? rows.map(c => `<div class="ax-row mono" style="font-size:12px"><span>${esc(c.amount)}</span><span style="color:var(--ax-dim)">${idHtml(c.coinid, TOK.shortId(c.coinid))}</span></div>`).join("") : '<div class="ax-empty">No sendable coins right now.</div>';
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay axapp" id="axCoinOv"><div class="ax-modal"><div class="ax-modt">Your coins</div>${body}<div class="ax-seg" style="margin-top:12px"><button class="ax-btn" id="axCoinClose">Close</button></div></div></div>`); axApplyLook();
    const ov = el("axCoinOv"); el("axCoinClose").onclick = () => ov.remove(); ov.onclick = e => { if (e.target.id === "axCoinOv") ov.remove(); };
  }
  async function axSendDialog(w) {
    document.body.insertAdjacentHTML("beforeend", `<div class="overlay axapp" id="axSendOv"><div class="ax-modal">
      <div class="ax-modt">Send from this wallet</div>
      <div class="ax-seg"><button class="ax-segbtn is-on" id="axSendEth" data-asset="eth">ETH</button><button class="ax-segbtn" id="axSendUsdt" data-asset="usdt">USDT</button></div>
      <div class="ax-field"><div class="ax-lbl">To</div><input class="ax-input mono" id="axSendTo" placeholder="0x… recipient" autocomplete="off" /></div>
      <div class="ax-field"><div class="ax-lbl">Amount <button class="ax-btn ax-btn--sm" id="axSendMax" style="float:right">Max</button></div><input class="ax-input mono" id="axSendAmt" placeholder="0.00" autocomplete="off" /></div>
      <div class="ax-desc">Sends are irreversible. Double-check the address.</div>
      <div class="ax-seg" style="margin-top:12px"><button class="ax-btn" id="axSendCancel">Cancel</button><button class="ax-btn ax-btn--cta" id="axSendReview">Review</button></div></div></div>`); axApplyLook();
    const ov = el("axSendOv"); let asset = "eth"; const close = () => ov && ov.remove();
    const setAsset = a => { asset = a; el("axSendEth").className = "ax-segbtn" + (a === "eth" ? " is-on" : ""); el("axSendUsdt").className = "ax-segbtn" + (a === "usdt" ? " is-on" : ""); };
    el("axSendEth").onclick = () => setAsset("eth"); el("axSendUsdt").onclick = () => setAsset("usdt");
    el("axSendMax").onclick = async () => { const m = await api.axSendMax(asset).catch(() => null); if (m != null) el("axSendAmt").value = m; };
    el("axSendCancel").onclick = close;
    ov.onclick = e => { if (e.target.id === "axSendOv") close(); };
    el("axSendReview").onclick = async () => {
      const to = el("axSendTo").value.trim(), amt = el("axSendAmt").value.trim();
      const r = await api.axSendReview(asset, to, amt).catch(e => ({ err: String(e.message || e) }));
      if (r.err) { toast(r.err, "warn"); return; }
      close();
      if (!await showConfirm("Review — Send " + (asset === "eth" ? "ETH" : "USDT"), `Send  ${amt} ${asset === "eth" ? "ETH" : "USDT"}\nTo  ${to}\n\nNetwork fee ≈ ${r.fee} ETH\nThis cannot be undone.`, "Send now", true)) return;
      const s = await api.axSend(asset, to, amt).catch(e => ({ err: String(e.message || e) }));
      toast(s && s.err ? s.err : "✓ Sent — tx " + TOK.shortId(s.tx), s && s.err ? "warn" : "ok", (s && !s.err && s.tx) || null);
      if (activeView() === "atomix" && axView === "wallet") renderAxWallet();
    };
  }

  async function axSwitchCurrency() {
    // Derive the target ONCE. Reading axStatusCache.currency twice (label, then call) was a latent
    // inconsistency if a push refreshed the cache between the reads; and with the engine now switching
    // synchronously, re-reading status afterwards means the next click starts from server truth rather than a
    // stale cache that asks for the key the engine already holds (which the glue early-returns as a no-op).
    const cur = axStatusCache.currency;
    const key = cur === "minima" ? "mxusdt" : "minima";
    const to = key === "mxusdt" ? "MxUSD" : "MINIMA";
    if (!await showConfirm("Switch to " + to + "?", "Your live market on the current book is withdrawn first, then AtomiX moves to the " + to + " book. Any in-flight swap still settles.", "Switch")) return;
    const btn = el("axCcy"); if (btn) { btn.disabled = true; btn.textContent = "Switching…"; }   // no double-entry while the tombstone posts
    const r = await api.axSwitchCurrency(key).catch(e => ({ err: String(e.message || e) }));
    if (r && r.err) toast(r.err, "warn");
    await axRefreshStatus();
    renderAtomix();
  }
  function axWelcome() {
    showConfirm("Welcome to AtomiX", "Swap MINIMA or MxUSD ⇄ Ethereum USDT trustlessly across chains — no middleman ever holds your funds.\n\nYour keys are derived from this node's seed, so it's the same wallet and identity on any device running AtomiX.\n\nTabs: Swap (quick trade) · Market (full order book + your maker order) · Activity (your swaps) · OTC (private negotiated deals) · Wallet (your ETH).\n\nInteroperates on the SAME on-chain books as the AtomiX phone app and MiniDapp.", "Get started");
  }

  // live push: patch passive regions only; never rebuild a form the user is typing into
  function onAtomixUpdate() {
    if (axUpdateTimer) return;
    axUpdateTimer = setTimeout(() => { axUpdateTimer = null; refreshAxActive().catch(() => {}); }, 400);
  }
  async function refreshAxActive() {
    if (activeView() !== "atomix" || !el("axBody")) return;
    await axRefreshStatus();   // header + accent from server truth, on EVERY tab — before the focus guard below
    // NEVER rebuild a view while the user is typing in one of its inputs (the Mail frozen-tab rule). The Market
    // maker editor + OTC availability + Swap amount all hold live inputs.
    const focusInBody = document.activeElement && el("axBody").contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (axView === "activity") return renderAxActivity();
    if (axView === "market") { if (!focusInBody) return renderAxMarket(); return; }   // skip while configuring the market
    if (axView === "swap") {
      // if the user isn't typing an amount, a full re-render refreshes the book/best-price/stages; otherwise
      // only refresh the stages tracker in place (never touch the amount inputs).
      if (!focusInBody) return renderAxSwap();
      const swaps = await api.axSwaps().catch(() => []); const w = await api.axWallet().catch(() => null);
      const bals = (w && w.bals) || { minima: "0", usdt: "0", eth: "0" };
      const stagesEl = el("axBody").querySelector(".ax-stages");
      if (stagesEl) stagesEl.innerHTML = axStagesRows(swaps, bals, axQuoteMeta ? axQuoteMeta.ccy : "MxUSD");
    }
    // OTC/Wallet: leave the form alone; the user re-enters or taps Refresh (an OS notification flags OTC activity).
  }


  // ---- public surface (renderer/app.js talks to the panel only through this) ----
  g.AtomixPanel = {
    init: function (d) {
      api = d.api; esc = d.esc; el = d.el; toast = d.toast; copy = d.copy; TOK = d.TOK;
      showConfirm = d.showConfirm; showPrompt = d.showPrompt; relTime = d.relTime; idHtml = d.idHtml;
      running = d.running; activeView = d.activeView;
    },
    render: renderAtomix,
    onUpdate: onAtomixUpdate,
    reset: resetAxState,
    setVersion: function (v) { AX_VER = v || ""; },
    setBlock: function (n) { n = parseInt(n, 10) || 0; if (n > AX_BLOCK) { AX_BLOCK = n; var e = el && el("axSub"); if (e) e.textContent = axSubLine(); } },
    /** Template-only exports for scripts/panels-test.cjs — no node or chain contact. */
    _ccyName: axCcyName,
    _header: axHeader,
    _tabBar: axTabBar,
    _ladder: axLadder,
    _stagesRows: axStagesRows,
    _swapRows: axSwapRows,
    _setView: function (v) { axView = v; },
    _setStatus: function (s) { axStatusCache = s; }
  };
})(window);
