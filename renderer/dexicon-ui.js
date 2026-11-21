/*
 * dexicon-ui.js: Dexicon's screens. The chrome (header, status strip, room pills, bottom tab bar) is native and is
 * the Android client's (apks/dexicon MainActivity.java buildChrome); logic without a DOM lives in dexicon-core.js.
 * Room ① MxUSD is AtomiX (renderer/dexicon-ax.js draws Swap, Market and OTC); room ② Pools is PandaPools
 * (renderer/dexicon-pp.js draws its five screens). Room ③ Exchange is drawn here over the hosted Dexicon engine (window.mcd dx* calls,
 * main/dexicon.js). Activity, Assets and Settings are one screen each, shown in rooms ① and ③.
 */
const DexUI = (() => {
  "use strict";
  const C = DexCore, api = window.mcd, $ = (id) => document.getElementById(id);
  const KEY = "dexicon";
  // Android's tab icons, path data unchanged (apks/dexicon res/drawable/ic_tab_*.xml; 24 grid, stroke 2, round)
  const ICON = {
    swap: "M7,4 L7,16 M7,16 L4,13 M7,16 L10,13 M17,20 L17,8 M17,8 L14,11 M17,8 L20,11",
    pools: "M3,9 Q6,6 9,9 T15,9 T21,9 M3,15 Q6,12 9,15 T15,15 T21,15",
    mylp: "M12,4 L20,8 L12,12 L4,8 Z M4,12 L12,16 L20,12 M4,16 L12,20 L20,16",
    wallet: "M6,6 h11 a3,3 0 0,1 3,3 v6 a3,3 0 0,1 -3,3 h-11 a3,3 0 0,1 -3,-3 v-6 a3,3 0 0,1 3,-3 z M16,12 h2.5",
    market: "M6,20 L6,10 M12,20 L12,4 M18,20 L18,14",
    otc: "M4,9 L18,9 M14,5 L18,9 L14,13 M20,15 L6,15 M10,11 L6,15 L10,19",
    trade: "M8,4 L8,20 M6,8 L10,8 L10,15 L6,15 Z M16,4 L16,18 M14,7 L18,7 L18,13 L14,13 Z",
    orders: "M9,7 L20,7 M9,12 L20,12 M9,17 L20,17 M4,7 L5,7 M4,12 L5,12 M4,17 L5,17",
    history: "M3,12 A9,9 0 1,1 21,12 A9,9 0 1,1 3,12 M12,7 L12,12 L15,14",
    activity: "M3,12 h4 l2,6 l4,-14 l2,8 h6",
    assets: "M6,6 h11 a3,3 0 0,1 3,3 v6 a3,3 0 0,1 -3,3 h-11 a3,3 0 0,1 -3,-3 v-6 a3,3 0 0,1 3,-3 z M16,12 h2.5",
    settings: "M4,7 L20,7 M4,17 L20,17 M9,4 L9,10 M15,14 L15,20"
  };
  let mem = C.load(read(), oldTheme()), opts = null, node = { state: "" }, st = null;

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function oldTheme() { try { return localStorage.getItem("ax_theme"); } catch (e) { return null; } }   // the removed AtomiX panel's own theme choice
  function write() { try { localStorage.setItem(KEY, C.save(mem)); } catch (e) {} }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function init(o) {
    opts = o;
    $("dxRail").innerHTML = C.ROOMS.map((r, i) => `<button class="dx-room" data-room="${i}" aria-pressed="false">${r.n} ${th(r.label)}</button>`).join("");
    $("dxRail").onclick = (e) => { const b = e.target.closest("[data-room]"); if (b) opts.go(C.ROOMS[Number(b.dataset.room)].view); };
    $("dxNav").onclick = (e) => { const b = e.target.closest("[data-dxtab]"); if (b) { C.pickTab(mem, b.dataset.dxtab); write(); paintNav(); render(); } };
    $("dxNav").addEventListener("keydown", (e) => {   // one tab stop, the arrow keys move along the bar
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const all = [...$("dxNav").querySelectorAll(".dx-tab")], i = all.indexOf(document.activeElement); if (i < 0) return;
      const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; e.preventDefault(); next.focus(); next.click();
    });
    $("dxTheme").onclick = () => { C.toggleTheme(mem); write(); paintTheme(); draw(); };   // draw(): an open chart takes the new theme's colours at once (the old AtomiX panel did; 0.18.141)
    $("dxClose").onclick = () => opts.leave();
    $("dxPair").onclick = () => { if (node.state === "stopped") opts.start(); };
    $("dxCcy").onclick = () => DexAx.switchCurrency();
    api.onDexicon((message) => { if (typeof message === "string") onService(message); if (Page.frame && typeof message === "string") Page.frame.contentWindow.postMessage({ dxRoom: 1, update: { dex: message } }, "*"); if (shown()) refresh(); else watch(); });
    window.addEventListener("message", onFrameMessage);
    // the FAST book moves between blocks; and on every other tab the engine is still watched, so its page exists (watch)
    setInterval(() => { if (mine()) refresh(); else watch(); DexAx.tick(); DexPools.tick(); }, 5000);
    paintTheme();
  }
  const shown = () => $("shell").dataset.mode === "dex";
  const axRoom = () => C.ROOMS[mem.room].view === "atomix", ppRoom = () => C.ROOMS[mem.room].view === "pandapools";
  /** the screen is one this file draws: any tab of room 3, and the shared tabs of room 1 (room 2's five are PandaPools' own) */
  const ours = () => C.ROOMS[mem.room].view === "dexicon" || (axRoom() && C.SHARED.includes(C.tabOf(mem)));
  const mine = () => shown() && ours();
  const host = () => $(axRoom() ? "dxAxBody" : ppRoom() ? "dxPpBody" : "dxBody");

  /** Called for every screen change (app.js selectTab). */
  function paint(view) {
    const room = C.roomOfView(view);
    if (room < 0) return;
    C.pickRoom(mem, room);
    paintTheme(); paintNav(); paintStrip();
    document.querySelectorAll(".dx-room").forEach(b => b.setAttribute("aria-pressed", Number(b.dataset.room) === mem.room ? "true" : "false"));
    refresh();
  }
  function paintTheme() {
    $("shell").dataset.dx = mem.theme;
    const dark = mem.theme === "ONYX";
    $("dxTheme").textContent = dark ? "☀" : "☾";
    $("dxTheme").setAttribute("aria-label", dark ? I18N.t("Switch Dexicon to its light theme") : I18N.t("Switch Dexicon to its dark theme"));
  }
  function paintNav() {
    const tabs = C.ROOMS[mem.room].tabs, on = C.tabOf(mem);
    $("dxNav").hidden = !tabs.length;
    $("dxNav").innerHTML = tabs.map(t => `<button class="dx-tab" role="tab" data-dxtab="${t}" aria-selected="${t === on}" tabindex="${t === on ? 0 : -1}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[t]}"/></svg><span>${I18N.th(C.TAB_LABEL[t])}</span></button>`).join("");
  }
  function paintStrip() {
    const s = C.strip(node.state, st, Page.failed), p = $("dxPair");
    p.textContent = s.text + (node.state === "stopped" ? "  ▸" : ""); p.dataset.tone = s.tone;
    p.style.cursor = node.state === "stopped" ? "pointer" : "";
    const block = (node.health && node.health.block) || (st && st.block) || 0;
    $("dxBlock").textContent = "# " + (block > 0 ? block : "…");
    $("dxVer").textContent = "v" + ((st && st.version) || "…");
    // the ⇄ currency pill belongs to AtomiX's room only (MainActivity: ccyPill, room 0)
    const pill = DexAx.pill(), c = $("dxCcy");
    c.hidden = !axRoom(); c.textContent = pill.text; c.dataset.axccy = pill.currency; c.disabled = pill.busy; c.setAttribute("aria-label", pill.label);
  }
  function node_(s) { node = s || { state: "" }; if (!opts) return; paintStrip(); if (node.state === "running") watch(); else pageEnsure(); }
  /** The engine's state, read on EVERY tab: the page frame is made as soon as the engine is ready and remade when the
   *  engine changes, without waiting for a visit to Dexicon. Nothing is drawn. */
  let watching = false;
  async function watch() {
    if (watching) return; watching = true;
    try { st = await api.dxStatus(); } catch (e) { st = null; }
    watching = false; paintStrip(); pageEnsure();
  }

  async function refresh() {
    try { st = await api.dxStatus(); } catch (e) { st = null; }
    paintStrip(); pageEnsure();
    if (mine()) { await load().catch(() => {}); draw(); }
  }

  // ---- the page: the taker's engine, verbatim, in a hidden sandboxed frame (renderer/dexicon/mds.js) ----
  const Page = { frame: null, state: {}, seq: 0, waiting: {}, epoch: null, madeAt: 0, heard: false, failed: false };
  /** The frame lives in #shell, outside every tab's own view, so changing tabs never touches it (C.pageStep). */
  function pageEnsure() {
    if (Page.stub) return;   // the dev preview has no engine and no page
    const step = C.pageStep(node.state, st, Page.frame ? Page : null, Date.now());
    if (step === "retry") Page.failed = true;   // said in the status strip and on the screens until the page speaks
    if (step === "drop" || step === "remake" || step === "retry") {
      Page.frame.remove(); Page.frame = null; Page.state = {};
      for (const k of Object.keys(Page.waiting)) { Page.waiting[k]({ error: I18N.t("Dexicon stopped before it answered. Look at Activity before trying again.") }); delete Page.waiting[k]; }
      if (step !== "retry") Page.failed = false;
    }
    if (step === "make" || step === "remake" || step === "retry") {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts"); f.hidden = true; f.title = I18N.t("Dexicon engine"); f.src = "dxroom://exchange/index.html";
      $("shell").appendChild(f); Page.frame = f; Page.epoch = st ? st.epoch : null; Page.madeAt = Date.now(); Page.heard = false;
    }
    if (step !== "keep" && step !== "none") paintStrip();
  }
  function onFrameMessage(e) {
    if (!Page.frame || e.source !== Page.frame.contentWindow) return;
    const m = e.data || {}; if (m.dxRoom !== 1) return;
    if (!Page.heard) { Page.heard = true; if (Page.failed) { Page.failed = false; paintStrip(); } }
    if (m.page && typeof m.page === "object") {
      Page.state = m.page; pageAmount(m.page);
      if (Page.heardWait) { const w = Page.heardWait; Page.heardWait = null; w(); }
      Page.frame.hidden = !m.page.dialog; Page.frame.classList.toggle("dx-frame", !!m.page.dialog);   // only the page's market maker dialogs are ever shown
      if (shown()) draw(); return;
    }
    if (m.driven != null) { const w = Page.waiting[m.driven]; if (w) { delete Page.waiting[m.driven]; w({ error: m.error || "", asked: m.asked || "" }); } return; }
    const call = C.bridgeCall(m); if (!call) return;
    const back = (value, error) => { if (Page.frame) Page.frame.contentWindow.postMessage(error == null ? { dxRoom: 1, id: m.id, value } : { dxRoom: 1, id: m.id, error }, "*"); };
    // the frame speaks for the engine it was made for (Page.epoch): a call from a frame that outlived its engine is refused in main
    if (call.kind === "noclip") { back(null, "copying is done from the app's own screens"); return; }   // 0.19.229: no clipboard for the frame
    api.dxCommand(Object.assign({}, call.args, { epoch: Page.epoch })).then(v => back(v), err => back(null, C.refusal(err && err.message)));
  }
  /** Ask the page for one of its actions. Resolves { error, asked }: error = why nothing was done; asked = the page's
   *  own review text when it wants one confirmed. */
  function drive(act, args) {
    if (Page.stub) return Page.stub(act, args);
    if (!Page.frame || !Page.state.ready) return Promise.resolve({ error: I18N.t("Dexicon is still starting. Nothing was sent.") });
    const id = ++Page.seq;
    return new Promise(resolve => { Page.waiting[id] = resolve; Page.frame.contentWindow.postMessage(C.driveCall(id, act, args), "*"); });
  }

  // ---- room 3, Exchange: the Android screens over the engine's read model ----
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const X = { kv: {}, takes: {}, mm: {}, acts: [], sub: 0, asub: 0, open: {}, book: null, mine: { orders: [], pending: [] }, orders: [], fills: [], bal: null, balErr: "", svc: {}, buy: true, group: 0, fundsBig: false, said: null, loaded: false };
  try { X.group = Math.min(3, Math.max(0, Number(localStorage.getItem("dexicon_group")) || 0)); X.fundsBig = localStorage.getItem("dexicon_funds_big") === "1"; } catch (e) {}
  const pref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  async function load() {
    DexAx.shared(false); DexPools.shared(false);   // AtomiX's and PandaPools' parts of the shared screens: their own reads, at most once a minute
    const ok = node.state === "running" && st && st.ready;
    if (!ok) { X.book = null; X.loaded = false; return; }
    const got = await Promise.allSettled([api.dxBook(), api.dxMine(), api.dxCommand({ op: "sql", query: "SELECT k, v FROM ax_kv WHERE k IN ('myorders','pending_takes','mm_config','mm_status','mm_feed','mm_pool','mm_review','activity')" }),
      api.dxCommand({ op: "sql", query: "SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'" }), api.cmd("balance")]);
    const val = (i, d) => (got[i].status === "fulfilled" && got[i].value != null ? got[i].value : d);
    X.kv = {}; for (const r of (val(2, {}).rows || [])) X.kv[r.K || r.k] = String(r.V == null ? r.v : r.V);
    const json = (k, d) => { try { const v = JSON.parse(X.kv[k]); return v == null ? d : v; } catch (e) { return d; } };
    X.book = val(0, null); X.mine = val(1, { orders: [], pending: [] }); X.orders = json("myorders", []); if (!Array.isArray(X.orders)) X.orders = [];
    X.takes = json("pending_takes", {}); X.mm = json("mm_config", {}); X.acts = json("activity", []); if (!Array.isArray(X.acts)) X.acts = [];
    X.fills = ((val(3, {}).rows) || []).map(r => { try { return JSON.parse(r.V || r.v); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const bal = val(4, null);
    if (bal && bal.status && Array.isArray(bal.response)) { const of = (id) => (bal.response.find(r => r.tokenid === id) || {}).sendable || "0"; X.bal = { minima: of("0x00"), mxusd: of(MXUSD) }; X.balErr = ""; }
    else { X.bal = null; X.balErr = C.refusal((bal && bal.error) || (got[4].reason && got[4].reason.message) || I18N.t("The balance could not be read.")); }
    X.loaded = true;
  }
  function onService(message) {   // the service's packets, in its own words (main/dexicon.js "comms")
    let p = null; try { p = JSON.parse(message); } catch (e) { return; }
    if (!p || p.origin !== "service") return;
    if (p.type === "STATE") X.svc = p.data || {};
  }
  /** H2 (0.18.118): after a FAST trade or order the amount field is the PAGE's own: only what is surely untraded
   *  after a sweep (ui/app.js finishSweep), empty after a published order. Never the full amount again. */
  function pageAmount(p) {
    if (X.sent == null) return;
    if (p.trading) { X.sentRan = true; return; }
    if (typeof p.amount === "string" && p.amount !== X.sent) { const a = $("dxAmount"); if (a) a.value = p.amount; X.sent = null; }
    else if (X.sentRan) X.sent = null;
  }
  /** One money action at a time in the whole of Dexicon (H2): a second click, a held Enter or another button, in any
   *  room, does nothing while one is being reviewed, signed or sent. */
  const money = (fn) => C.money(fn, draw);   // the gate is DexCore's: rooms 1 and 2 pass through the same one
  const book = () => C.tradeBook(X.book, Page.state.fast);   // the Trade ticket plans on the book the page will act on (H1)
  const fundsNow = () => C.funds(X.bal && X.bal.minima, X.bal && X.bal.mxusd, X.orders, X.fills);
  const lad = () => C.ladder(X.book, X.group);

  /** What stops trading right now: { text, soft } in plain words, or null when nothing does. soft: the FAST layer may be
   *  deaf but on-chain orders and pools still work, so the buttons stay live. Decided here, never from the (translated) text. */
  function blocker() {
    if (node.state !== "running") return { text: I18N.t("The node is stopped, so nothing here can trade. Start it and Dexicon comes back by itself.") };
    if (st && st.problem) return { text: st.problem };   // the engine host's own plain sentence (a store that could not be moved aside)
    if (!st || !st.started || !st.ready) return { text: I18N.t("Dexicon is still starting: it is reading this wallet's trading identity from the node. Nothing can be sent yet.") };
    if (Page.failed) return { text: C.PAGE_FAILED };
    if (Page.state.idError) return { text: I18N.t("The trading identity could not be read: {idError}", { idError: Page.state.idError }) };
    if (!Page.state.ready && !Page.stub) return { text: I18N.t("Dexicon is still starting. Nothing can be sent yet.") };
    if (!(st.relays || []).length) return { text: I18N.t("No relay is set, so there is no FAST book and a FAST order cannot be published. Add a relay in Settings.") };
    if (relayDown()) return { text: I18N.t("No relay answers right now, so the FAST book may be out of date and a FAST order may not be heard. On-chain orders and pools still work."), soft: true };
    return null;
  }
  const relayDown = () => { const r = (Page.state.relays || []).filter(x => !x.found); return r.length > 0 && !r.some(x => x.state === "ok") && r.some(x => x.state === "bad"); };

  function dialog(title, text, okLabel, input) {
    return new Promise(resolve => {
      const d = document.createElement("dialog"); d.className = "dx-dlg";
      d.innerHTML = `<h2>${esc(title)}</h2><pre>${esc(text)}</pre>${input ? `<input class="dx-in" inputmode="decimal" aria-label="${esc(input.label)}" value="${esc(input.value || "")}">` : ""}<div class="dx-dlg__b"><button class="dx-btn" data-x="0">${th("Close")}</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
      d.onclick = (e) => { const b = e.target.closest("[data-x]"); if (!b) return; const v = b.dataset.x === "1" ? (input ? d.querySelector("input").value.trim() : true) : null; d.close(); d.remove(); resolve(v); };
      d.addEventListener("cancel", () => { d.remove(); resolve(null); });
      $("shell").appendChild(d); d.showModal();
    });
  }
  const say = (text, kind) => { X.said = { text: C.refusal(text), kind: kind || C.feedbackKind(C.refusal(text)) }; draw(); };

  function render() {
    const body = host(); if (!body) return;
    const tab = C.tabOf(mem);
    if (ppRoom()) return DexPools.render(tab, body);
    if (axRoom() && !C.SHARED.includes(tab)) return DexAx.render(tab, body);
    DexAx.shared(true); DexPools.shared(true);
    if (body.dataset.tab !== tab) { body.dataset.tab = tab; body.innerHTML = tab === "trade" ? tradeSkeleton() : ""; if (tab === "trade") bindTrade(); body.onclick = tab === "trade" ? null : onTabClick; $("main").scrollTop = 0; X.said = null; }
    draw();
    load().then(draw, draw);
  }
  function draw() {
    const body = host(); if (!body || !mine()) return;
    const tab = body.dataset.tab;
    if (tab === "trade") paintTrade();
    else if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never redraw under someone typing
    else {
      // Orders (0.18.121): what the page and the service last said is shown here too. The market maker's dialogs are the
      // page's own, and what they answer (a ladder that was not saved, a refused cancel or change) was only in the Trade log.
      const says = tab === "orders" ? C.pageSays(Page.state, X.svc) : { lines: [] };
      const why = blocker(), top = (why ? `<div class="dx-state" role="status">${esc(why.text)}</div>` : "") + (X.said ? `<div class="dx-state dx-state--${X.said.kind}" role="alert">${esc(X.said.text)}</div>` : "")
        + (says.lines.length ? `<div class="dx-state${says.error ? " dx-state--error" : ""}" role="status">${says.lines.slice(-4).map(esc).join("<br>")}</div>` : "");
      body.innerHTML = top + (tab === "orders" ? ordersHtml() : tab === "history" ? historyHtml() : tab === "activity" ? activityHtml() : tab === "assets" ? assetsHtml() : settingsHtml());
    }
  }

  // ---- Trade (TradeView.java): ticker and book on the left; funds, the ticket and my orders on the right ----
  function tradeSkeleton() {
    return `<div class="dx-state" id="dxState" role="status" hidden></div>
    <div class="dx-trade">
      <div class="dx-col">
        <div class="dx-card"><div class="dx-row"><b class="dx-t13">${th("MINIMA / MxUSD")}</b><span class="dx-sync" id="dxSync"></span></div>
          <div class="dx-midrow"><span class="dx-mid" id="dxMid">…</span><span class="dx-spread" id="dxSpread"></span></div>
          <div class="dx-kind" id="dxKind"></div>
          <div class="dx-stats"><div><label>${th("Bids")}</label><span id="dxBidsN">…</span></div><div><label>${th("Asks")}</label><span id="dxAsksN">…</span></div></div>
          <div class="dx-kind" id="dxMexc"></div></div>
        <div class="dx-card"><div class="dx-row"><span class="dx-h">${th("ORDER BOOK")}</span><span class="dx-groups" id="dxGroups" role="group" aria-label="${th("Price grouping")}">${C.GROUP_LABELS.map((g, i) => `<button data-g="${i}">${g}</button>`).join("")}</span></div>
          <div class="dx-legend"><span>${th("Price (MxUSD)")}</span><span>${th("Amount (MINIMA)")}</span><span>${th("Total")}</span></div>
          <div id="dxAsks"></div><div class="dx-center" id="dxCenter">…</div><div id="dxBids"></div></div>
      </div>
      <div class="dx-col">
        <button class="dx-card dx-funds" id="dxFunds" aria-label="${th("Your funds: show more or less")}"></button>
        <div class="dx-card">
          <div class="dx-side" role="group" aria-label="${th("Side")}"><button id="dxBuy" aria-pressed="true">${th("BUY")}</button><button id="dxSell" aria-pressed="false">${th("SELL")}</button></div>
          <input class="dx-in" id="dxPrice" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="${th("Price (MxUSD per MINIMA)")}" aria-label="${th("Price, MxUSD per MINIMA")}">
          <input class="dx-in" id="dxAmount" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="${th("Amount (MINIMA)")}" aria-label="${th("Amount, MINIMA")}">
          <button class="dx-avail" id="dxAvail"></button>
          <div class="dx-pct" id="dxPct">${[25, 50, 75, 100].map(n => `<button data-pct="${n}">${n}%</button>`).join("")}</div>
          <div class="dx-total" id="dxTotal">${th("Total: …")}</div>
          <div class="dx-warn" id="dxWarn" role="alert"></div>
          <div class="dx-review" id="dxReview"></div>
          <div class="dx-ctas"><button class="dx-cta" id="dxCta"></button><button class="dx-cta" id="dxCta2" hidden></button></div>
          <div class="dx-log" id="dxLog" role="log" hidden></div>
        </div>
        <div class="dx-card"><div class="dx-h">${th("MY OPEN ORDERS")}</div><div id="dxMyOrders"></div></div>
      </div>
    </div>`;
  }
  const num = (v) => { const d = C.dec(v); return d && d.v > 0n ? d : null; };
  function bindTrade() {
    const price = $("dxPrice"), amount = $("dxAmount");
    // a comma or a second point is never "repaired" into another number (C.entryProblem): the field is left as typed and the ticket says why
    for (const i of [price, amount]) i.oninput = () => { X.sent = null; if (!C.entryProblem(i.value)) { const clean = i.value.replace(/[^0-9.]/g, ""); if (clean !== i.value) i.value = clean; } X.said = null; paintTicket(); };
    for (const i of [price, amount]) i.onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };   // Enter in a field never trades
    $("dxBuy").onclick = () => { X.buy = true; paintTicket(); };
    $("dxSell").onclick = () => { X.buy = false; paintTicket(); };
    $("dxGroups").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; X.group = Number(b.dataset.g); pref("dexicon_group", String(X.group)); paintTrade(); };
    $("dxFunds").onclick = () => { X.fundsBig = !X.fundsBig; pref("dexicon_funds_big", X.fundsBig ? "1" : "0"); paintFunds(); };
    const pct = (n) => {
      if (!num(price.value)) return say(I18N.t("Enter a price first, or click a row in the book."), "note");
      const a = C.percent(book(), X.buy, price.value, n, fundsNow());
      if (!a) return say(X.balErr || I18N.t("The balance has not been read yet."), "note");
      amount.value = a.v > 0n ? C.fmt(a) : ""; X.said = null; paintTicket();
    };
    $("dxPct").onclick = (e) => { const b = e.target.closest("[data-pct]"); if (b) pct(Number(b.dataset.pct)); };
    $("dxAvail").onclick = () => pct(100);
    const rowClick = (e) => { const r = e.target.closest("[data-price]"); if (!r) return; X.buy = r.dataset.side === "ask"; price.value = r.dataset.price; amount.value = r.dataset.cum; X.said = null; paintTicket(); };
    $("dxAsks").onclick = rowClick; $("dxBids").onclick = rowClick;
    $("dxCta").onclick = () => money(() => submit("fast"));
    $("dxCta2").onclick = () => money(() => submit("chain"));
    $("dxMyOrders").onclick = (e) => { const b = e.target.closest("[data-oact]"); if (b) money(() => orderAction(b.dataset.oact, b.dataset.kind, b.dataset.id, b.dataset.price)); };
  }
  function paintTrade() {
    if (!$("dxPrice")) return;
    const why = blocker(), L = lad(), relays = (Page.state.relays || []).filter(r => !r.found), anyOk = relays.some(r => r.state === "ok") || (Page.stub && !relayDown());
    $("dxState").hidden = !why; $("dxState").textContent = why ? why.text : "";
    const sync = $("dxSync"), nRelays = ((st && st.relays) || []).length;
    sync.textContent = !nRelays ? I18N.t("● no relays") : relayDown() ? I18N.t("● no relay answers") : anyOk ? I18N.t("● live") : I18N.t("● connecting"); sync.dataset.ok = anyOk && !relayDown() ? "1" : "0";
    $("dxMid").textContent = L.mid ? C.fmtPrice(L.mid) : "…";
    $("dxSpread").textContent = L.spread ? I18N.t("spread {spread}", { spread: C.fmt(L.spread) }) : "";
    $("dxKind").textContent = I18N.t("{bestBid} · FAST + BOOK + POOL", { bestBid: (!L.mid ? I18N.t("no live orders") : L.bestBid && L.bestAsk ? I18N.t("mid of best bid / best ask") : L.bestBid ? I18N.t("best bid only") : I18N.t("best ask only")) });
    $("dxBidsN").textContent = I18N.t("{fast} fast · {book} book order{book2}", { fast: L.count.fast, book: L.count.book, book2: I18N.s(L.count.book) });
    $("dxAsksN").textContent = I18N.t("{pools} pool{pools2}", { pools: L.count.pools, pools2: I18N.s(L.count.pools) });
    // the only outside price shown is MEXC's, with the label the engine's read model gives it
    const px = st && st.price; $("dxMexc").textContent = px && px.mid > 0 ? C.priceName(px.source) + " " + px.mid + (px.label ? " · " + px.label : "") : "";
    document.querySelectorAll("#dxGroups button").forEach(b => b.setAttribute("aria-pressed", Number(b.dataset.g) === X.group ? "true" : "false"));
    const row = (r, ask) => {
      const lv = r.lv, parts = C.amountText(lv.fast, lv.book, lv.pool), shown_ = C.fmtPrice(lv.exact), at = C.GROUPS[X.group] ? C.fmt(lv.price) : C.fmt(lv.exact);
      return `<button class="dx-lrow" data-side="${ask ? "ask" : "bid"}" data-price="${at}" data-cum="${C.fmt(r.cum)}" style="--f:${Math.min(100, r.frac * 100).toFixed(2)}%" aria-label="${tr("{ask} {shown}, {parts} MINIMA{mine}", { ask: ask ? th("Ask") : th("Bid"), shown: shown_, parts: esc(parts.join(", ")), mine: lv.mine ? th(", includes your own order") : "" })}">`
        + `<span class="dx-lp">${lv.mine ? "• " : ""}${shown_}</span><span class="dx-la${parts.length > 1 || /[A-Z]/.test(parts[0]) ? " dx-la--tag" : ""}">${parts.map(esc).join("<br>")}</span><span class="dx-lt">${C.fmt(C.levelTotal(lv))}</span></button>`;
    };
    $("dxAsks").innerHTML = C.rows(L.asks).reverse().map(r => row(r, true)).join("");   // best ask just above the centre
    $("dxBids").innerHTML = C.rows(L.bids).map(r => row(r, false)).join("");
    if (!L.asks.length && !L.bids.length) $("dxAsks").innerHTML = `<div class="dx-empty">${esc(!X.loaded ? "…" : nRelays ? I18N.t("No live orders yet.") : I18N.t("Add a relay in Settings."))}</div>`;
    $("dxCenter").textContent = L.mid ? C.fmtPrice(L.mid) : "…";
    X.lastMid = L.mid;
    paintFunds(); paintTicket(); paintMyOrders();
  }
  function paintFunds() {
    const f = fundsNow(), b = $("dxFunds"); if (!b) return;
    const value = f.known && X.lastMid ? "≈ " + C.fmt(C.down(C.add(C.add(f.mxusd, f.mxusdSettling), C.mul(C.add(f.minima, f.minimaSettling), X.lastMid)), 4)) + " MxUSD @ mid " + C.fmtPrice(X.lastMid) : "";
    const block = (name, a, o, s2) => `<div><b>${name}</b><br>${C.fmtBal(a)}  ${th("available")}<br>${C.fmtBal(o)}  ${th("in your orders")}<br>+${C.fmtBal(s2)}  ${th("settling")}<br>${C.fmtBal(C.add(a, s2))}  ${th("total")}</div>`;
    b.innerHTML = `<div class="dx-row"><span class="dx-h">${tr("YOUR FUNDS  {fundsBig}", { fundsBig: X.fundsBig ? "▾" : "▸" })}</span><span class="dx-fval">${esc(value)}</span></div>`
      + (!f.known ? `<div class="dx-fsmall">${esc(X.balErr || (node.state === "running" ? I18N.t("reading…") : I18N.t("node stopped")))}</div>`
        : X.fundsBig ? `<div class="dx-fcols">${block("MINIMA", f.minima, f.minimaOrders, f.minimaSettling)}${block("MxUSD", f.mxusd, f.mxusdOrders, f.mxusdSettling)}</div>`
        : `<div class="dx-fsmall">${tr("{minima} MINIMA  ·  {mxusd} MxUSD  available", { minima: C.fmtBal(f.minima), mxusd: C.fmtBal(f.mxusd) })}</div>`);
  }
  function paintTicket() {
    if (!$("dxPrice")) return;
    const buy = X.buy, f = fundsNow(), pl = C.plan(book(), buy, $("dxPrice").value, $("dxAmount").value, f), why = blocker(), side = buy ? "BUY " : "SELL ";
    $("dxBuy").setAttribute("aria-pressed", buy ? "true" : "false"); $("dxSell").setAttribute("aria-pressed", buy ? "false" : "true");
    $("dxAvail").textContent = !f.known ? I18N.t("Available: … ({balErr})", { balErr: (X.balErr || I18N.t("not read yet")) }) : I18N.t("Available: {buy}{buy2}  ·  tap for max\n({minima} MINIMA · {mxusd} MxUSD in wallet)", { buy: C.fmtBal(C.freeFor(f, buy)), buy2: (buy ? " MxUSD" : " MINIMA"), minima: C.fmtBal(f.minima), mxusd: C.fmtBal(f.mxusd) });
    let total = I18N.t("Total: …");
    if (pl.ok) {
      const all = C.mul(pl.amount, pl.price);
      total = (buy ? I18N.t("You pay up to {all} MxUSD\nYou receive {amount} MINIMA", { all: C.fmt(C.up(all, 8)), amount: C.fmt(pl.amount) }) : I18N.t("You pay {amount} MINIMA\nYou receive at least {all} MxUSD", { amount: C.fmt(pl.amount), all: C.fmt(C.down(all, 8)) }))
        + (pl.stuck ? ("\n" + I18N.t("Nothing can be taken in this amount")) : pl.fast ? ("\n" + I18N.t("Fills now ≈ {take} MINIMA @ avg {avg}", { take: C.fmt(pl.take), avg: C.fmtPrice(pl.avg) })) : ("\n" + I18N.t("Nothing crosses on the FAST book: all of it rests as your FAST order @ {price}", { price: C.fmtPrice(pl.price) })));
    }
    $("dxTotal").textContent = total;
    const short = pl.ok && pl.short.v > 0n;
    const typo = C.entryProblem($("dxPrice").value) || C.entryProblem($("dxAmount").value);
    $("dxWarn").textContent = typo ? typo : pl.ok === false && pl.why ? pl.why : short ? I18N.t("Exceeds your free {buy} by {short} (free {free})", { buy: (buy ? "MxUSD" : "MINIMA"), short: C.fmt(pl.short), free: C.fmtBal(pl.free) }) : "";
    $("dxReview").innerHTML = C.review(pl, ((st && st.relays) || []).length).map(l => `<p>${esc(l)}</p>`).join("")
      || `<p>${th("Crosses FAST orders → the button IS the trade: one click takes them best-first up to your amount, no dialog, progress in the log below; what they can't cover is not traded. BOOK/POOL on-chain liquidity still shows a confirm. Nothing crosses → rests on the relays as your FAST order.")}</p>`;
    const cta = $("dxCta"), cta2 = $("dxCta2"), trading = !!Page.state.trading || C.gate.on, dead = !!why && !why.soft;
    for (const b of [cta, cta2]) b.dataset.side = buy ? "buy" : "sell";
    cta.innerHTML = trading ? "TRADING…" : pl.ok && pl.fast && !pl.stuck ? esc(I18N.t("{take} NOW · FAST", { take: side + C.fmt(pl.take) })) + "<small>" + th("instant ·") + " " + esc(C.fmtPrice(pl.avg)) + "</small>" : buy ? th("BUY MINIMA") : th("SELL MINIMA");
    cta.disabled = trading || dead || short || !f.known || !!typo || (pl.ok === false && !!pl.why) || !!(pl.ok && pl.stuck);
    cta2.hidden = !(pl.ok && pl.chain) || trading;
    cta2.innerHTML = esc(I18N.t("{side} · BOOK / POOL", { side: side.trim() })) + "<small>" + th("on-chain, about 3 minutes · review first") + "</small>";
    cta2.disabled = dead || !f.known || trading || !!typo;
    // the engine's own words: the take's progress, then what the page or the service last said
    const says = C.pageSays(Page.state, X.svc), lines = says.lines;
    const log = $("dxLog"), mine = X.said;
    log.hidden = !lines.length && !mine;
    log.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("") + (mine ? `<div class="dx-log__${mine.kind}">${esc(mine.text)}</div>` : "");
    log.dataset.kind = says.error ? "error" : "";   // "Only your own orders are at this price…" is plan feedback
  }
  async function submit(layer) {
    const price = $("dxPrice").value.trim(), amount = $("dxAmount").value.trim();
    const typo = C.entryProblem(price) || C.entryProblem(amount); if (typo) return say(typo, "note");
    if (!num(price) || !num(amount)) return say(I18N.t("Enter a price and an amount."), "note");
    X.said = null;
    const args = { buy: X.buy, price, amount, layer };
    if (layer === "fast") {
      // H1: the click carries what the review on screen said; the page signs only if its own book still says so
      const pl = C.plan(book(), X.buy, price, amount, fundsNow());
      if (!pl.ok || pl.stuck) return say(pl.why || I18N.t("Nothing can be taken in this amount. Nothing was signed."), "note");
      Object.assign(args, C.expectOf(pl));
      // M4 (0.18.120): the main process signs a take from the page only inside what was reviewed here (main/dexicon-signgate.js)
      try { await api.dxCommand({ op: "reviewed", buy: X.buy, price, amount }); } catch (e) { return say(I18N.t("The review could not be recorded, so nothing was signed: {message}", { message: C.refusal(e && e.message) })); }
      X.sent = amount; X.sentRan = false;
    }
    let r = await drive("place", args);
    while (!r.error && r.asked && r.asked !== args.reviewed) {   // on-chain: the page's own review, word for word, before anything is signed
      const ok = await dialog(args.reviewed ? I18N.t("The book moved. Review again") : I18N.t("Review this on-chain trade"), I18N.t("{asked}\n\nYour node signs this transaction and posts it. It is final only when a block confirms it (about 3 minutes); until then Activity shows it as waiting.", { asked: r.asked }), I18N.t("Sign and send"));
      if (!ok) return say(I18N.t("Nothing was signed or sent."), "note");
      args.reviewed = r.asked;
      r = await drive("place", args);
    }
    if (r.error) { X.sent = null; return say(r.error); }
    // stay busy until the page has said what it is doing (its "trading" state arrives in its next report)
    if (layer === "fast" && !Page.stub) await new Promise(res => { Page.heardWait = res; setTimeout(res, 1500); });
    load().then(draw, draw);
  }
  function paintMyOrders() {
    const box = $("dxMyOrders"); if (!box) return;
    box.innerHTML = orderRows() || `<div class="dx-empty">${th("No open orders")}</div>`;
  }
  /** My open orders: FAST (signed, on the relays) and on-chain (coins in the order contract). */
  function orderRows() {
    const out = [];
    for (const o of X.orders) {
      if (o.status !== "live") continue;
      const sell = o.side === "sell", rem = C.dec(o.remaining), price = C.dec(o.price); if (!rem || !price) continue;
      out.push(orderRow(sell, (sell ? "SELL " : "BUY ") + C.fmt(rem) + " @ " + C.fmtPrice(price) + ((o.coins || []).length ? "" : "  UNBACKED"), I18N.t("FAST · order {orderId}", { orderId: o.orderId }), "fast", o.orderId, C.fmt(price)));
    }
    for (const o of (X.mine.orders || [])) {
      const m = C.dec(o.minima), price = C.dec(o.price); if (!m || !price) continue;
      out.push(orderRow(o.sell, (o.sell ? "SELL " : "BUY ") + C.fmt(m) + " @ " + C.fmtPrice(price) + (o.pending ? ("  " + I18N.t("{pending} WAITING FOR A BLOCK", { pending: String(o.pending).toUpperCase() })) : ""), I18N.t("ON-CHAIN · coin {coinid}", { coinid: o.coinid }), "chain", o.coinid, C.fmt(price), !!o.pending));
    }
    for (const o of (X.mine.pending || [])) {
      const m = C.dec(o.minima), price = C.dec(o.price); if (!m || !price) continue;
      out.push(`<div class="dx-orow"><div><span class="dx-o${o.sell ? "sell" : "buy"}">${o.sell ? (th("SELL") + " ") : (th("BUY") + " ")}${C.fmt(m)} @ ${C.fmtPrice(price)}</span><small>${th("ON-CHAIN · posted, waiting for a block: not on the book yet")}</small></div></div>`);
    }
    return out.join("");
  }
  const orderRow = (sell, text, sub, kind, id, price, busy) => `<div class="dx-orow"><div><span class="dx-o${sell ? "sell" : "buy"}">${esc(text)}</span><small data-copy="${esc(id)}" title="${th("Click to copy")}">${esc(sub)}</small></div>`
    + (busy ? "" : `<button data-oact="edit" data-kind="${kind}" data-id="${esc(id)}" data-price="${esc(price)}" aria-label="${th("Change the price of this order")}">✎</button><button class="dx-ox" data-oact="cancel" data-kind="${kind}" data-id="${esc(id)}" aria-label="${th("Cancel this order")}">✕</button>`) + `</div>`;
  async function orderAction(act, kind, id, price) {
    const fast = kind === "fast";
    if (act === "cancel") {
      const ok = await dialog(I18N.t("Cancel this order?"), fast ? I18N.t("FAST order {id}\n\nYour node signs a cancel and sends it to every relay. Nothing moves on the chain: the coins never left your wallet. A take that a maker already co-signed still settles.", { id: id })
        : I18N.t("On-chain order, coin {id}\n\nYour node signs a transaction that returns the order's locked funds to your wallet. The order can still be filled until a block confirms the cancel.", { id: id }), I18N.t("Cancel the order"));
      if (!ok) return;
      const r = await drive(fast ? "cancelFast" : "cancelChain", fast ? { orderId: id } : { coinid: id });
      if (r.error) return say(r.error);
    } else {
      const next = await dialog(I18N.t("New price"), I18N.t("{id}\n\nMxUSD per MINIMA:", { id: (fast ? I18N.t("FAST order {id}\n\nYour node signs the order again at the new price and sends it to every relay. Nothing moves on the chain.", { id: id })
        : I18N.t("On-chain order, coin {id}\n\nYour node signs a transaction that moves the order to the new price. The old price can still be filled until a block confirms it.", { id: id })) }), I18N.t("Sign the new price"), { label: I18N.t("New price, MxUSD per MINIMA"), value: price });
      if (next == null) return;
      if (C.entryProblem(next)) return say(C.entryProblem(next), "note");
      if (!num(next)) return say(I18N.t("Enter a valid new price. Nothing was changed."), "note");
      const r = await drive(fast ? "editFast" : "editChain", fast ? { orderId: id, price: next } : { coinid: id, price: next });
      if (r.error) return say(r.error);
    }
    load().then(draw, draw);
  }

  // ---- Orders (OrdersTab.java) and History (HistoryTab.java) ----
  const idLine = (label, value) => (value ? `<div class="dx-id" data-copy="${esc(value)}" title="${th("Click to copy")}">${esc(label)} ${esc(value)}</div>` : "");
  const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return I18N.t("{day} {month}", { day: p(d.getDate()), month: I18N.t(I18N.MONTHS[d.getMonth()]) }) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
  const seg = (names, on, attr) => `<div class="dx-seg" role="group">${names.map((n, i) => `<button ${attr}="${i}" aria-pressed="${i === on}">${n}</button>`).join("")}</div>`;
  function makerCard() {
    const c = X.mm || {}, mode = !c.enabled ? "OFF" : c.peg ? I18N.t("PEGGED · MEXC") : "MANUAL", status = X.kv.mm_status || "", pool = X.kv.mm_pool || "";
    let feed = ""; try { feed = (JSON.parse(X.kv.mm_feed || "{}") || {}).line || ""; } catch (e) {}
    return `<div class="dx-card dx-mm"><div class="dx-row"><span class="dx-h">${th("MARKET MAKER")}</span><span class="dx-pill${c.enabled ? " dx-pill--on" : ""}">${mode}</span></div>`
      + (c.enabled && c.peg && feed ? `<div class="dx-sub">${esc(feed)}</div>` : "")
      + `<div class="dx-mm__s">${esc(status || (c.enabled ? I18N.t("starting: the service picks it up within seconds") : I18N.t("A ladder of FAST asks and bids, pegged to MEXC or set by hand. Your node keeps it live and co-signs every fill.")))}</div>`
      + (c.enabled && pool ? `<div class="dx-sub">${th("PandaPools:")} ${esc(pool)}</div>` : "")
      + `<div class="dx-mm__b"><button class="dx-btn dx-btn--go" data-mm="makerOpen">${c.enabled ? th("EDIT LADDER ▸") : th("SET UP ▸")}</button>${c.enabled ? `<button class="dx-btn dx-btn--stop" data-mm="makerStop">${th("STOP")}</button>` : ""}${X.kv.mm_review === "1" ? `<button class="dx-btn" data-mm="makerReview">${th("REVIEW")}</button>` : ""}</div></div>`;
  }
  function ordersHtml() {
    const out = [seg(["OPEN", I18N.t("MY FILLS")], X.sub, "data-sub")];
    if (X.sub === 0) {
      out.push(makerCard());
      let any = false;
      for (const k of Object.keys(X.takes || {})) {
        const t = X.takes[k] || {}, o = t.order || {}, pl = t.plan || {}; if (t.taken) continue;
        any = true;
        out.push(`<div class="dx-card dx-ocard dx-ocard--wait"><div class="dx-oline dx-oline--take">${tr("{side}{filled} MINIMA @ {price}  ·  TAKE SENT", { side: o.side === "sell" ? (th("BUY") + " ") : (th("SELL") + " "), filled: esc(pl.filled || ""), price: esc(o.price || "") })}</div>`
          + `<div class="dx-sub">${tr("signed and sent; waiting for the maker to co-sign{sent}. Not traded yet: it is voided by itself if the maker never answers.", { sent: t.sent ? (" " + tr("· sent {sent}", { sent: C.ago(Date.now() - Number(t.sent)) })) : "" })}</div>${idLine("order", o.orderId || k)}</div>`);
      }
      for (const o of X.orders) {
        if (o.status !== "live") continue;
        const sell = o.side === "sell", rem = C.dec(o.remaining), price = C.dec(o.price), n = (o.coins || []).length; if (!rem || !price) continue;
        any = true;
        const left = Math.max(0, Math.floor(((Number(o.expiry) || 0) - Date.now() / 1000) / 3600));
        out.push(`<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline dx-o${sell ? "sell" : "buy"}">${tr("{sell}{rem} MINIMA @ {price}", { sell: sell ? (th("SELL") + " ") : (th("BUY") + " "), rem: C.fmt(rem), price: C.fmtPrice(price) })}</span><span class="dx-oacts"><button data-oact="edit" data-kind="fast" data-id="${esc(o.orderId)}" data-price="${C.fmt(price)}" aria-label="${th("Change the price of this order")}">✎</button><button class="dx-ox" data-oact="cancel" data-kind="fast" data-id="${esc(o.orderId)}" aria-label="${th("Cancel this order")}">✕</button></span></div>`
          + `<div class="dx-sub">${tr("FAST · of {rem}  ·  {n} backing coin{n2}{n3}{left}  ·  seq {seq}", { rem: esc(C.fmt(C.dec(o.amount) || rem)), n: n, n2: I18N.s(n), n3: n ? "" : (" " + th("(UNBACKED: takers skip it until your node backs it again)")), left: o.expiry ? ("  " + tr("·  expires in {left}h", { left: left })) : "", seq: esc(o.seq) })}</div>${idLine("order", o.orderId)}${idLine("pay-to", o.address)}</div>`);
      }
      for (const o of (X.mine.orders || [])) {
        const m = C.dec(o.minima), price = C.dec(o.price); if (!m || !price) continue;
        any = true;
        out.push(`<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline dx-o${o.sell ? "sell" : "buy"}">${tr("{sell}{m} MINIMA @ {price}", { sell: o.sell ? (th("SELL") + " ") : (th("BUY") + " "), m: C.fmt(m), price: C.fmtPrice(price) })}</span>${o.pending ? "" : `<span class="dx-oacts"><button data-oact="edit" data-kind="chain" data-id="${esc(o.coinid)}" data-price="${C.fmt(price)}" aria-label="${th("Change the price of this order")}">✎</button><button class="dx-ox" data-oact="cancel" data-kind="chain" data-id="${esc(o.coinid)}" aria-label="${th("Cancel this order")}">✕</button></span>`}</div>`
          + `<div class="dx-sub">${tr("ON-CHAIN · the funds are locked in the order's coin until it is filled or cancelled{pending}", { pending: o.pending ? ("  " + tr("·  {pending} posted, waiting for a block", { pending: esc(o.pending) })) : "" })}</div>${idLine("coin", o.coinid)}${idLine("order", o.orderId)}</div>`);
      }
      for (const o of (X.mine.pending || [])) {
        any = true;
        out.push(`<div class="dx-card dx-ocard dx-ocard--wait"><div class="dx-oline dx-o${o.sell ? "sell" : "buy"}">${tr("{sell}{minima} MINIMA @ {price}", { sell: o.sell ? (th("SELL") + " ") : (th("BUY") + " "), minima: esc(o.minima), price: esc(o.price) })}</div><div class="dx-sub">${th("ON-CHAIN · posted, waiting for a block: not on the book yet")}</div>${idLine("order", o.orderId)}</div>`);
      }
      if (!any) out.push(`<div class="dx-empty dx-empty--mono">${X.loaded ? th("No open orders") : "…"}</div>`);
    } else {
      const chain = (X.svc && Array.isArray(X.svc.myTrades) ? X.svc.myTrades : []).filter(t => !t.fast);
      if (!X.fills.length && !chain.length) out.push(`<div class="dx-empty dx-empty--mono">${X.loaded ? th("No fills yet") : "…"}</div>`);
      for (const f of X.fills) {
        const buy = f.side === "buy", fs = C.fillState(f);
        out.push(`<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline dx-o${buy ? "buy" : "sell"}">${tr("{buy}{filled} MINIMA @ {price}", { buy: buy ? (th("BUY") + " ") : (th("SELL") + " "), filled: esc(f.filled), price: esc(f.price) })}</span><span class="dx-chip" data-tone="${fs.tone}">${fs.chip}</span></div>`
          + `<div class="dx-sub">${stamp((Number(f.ts) || 0) * 1000)}   FAST ${esc(String(f.role || "").toUpperCase())}   ${esc(fs.text)}</div>${idLine("txpow", f.txpowid)}${idLine("order", f.orderId)}${idLine("counterparty", f.maker || f.taker || f.counterparty)}</div>`);
      }
      for (const t of chain) out.push(`<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline dx-o${t.buy ? "buy" : "sell"}">${tr("{buy}{size} MINIMA @ {price}", { buy: t.buy ? (th("BUY") + " ") : (th("SELL") + " "), size: esc(t.size), price: esc(t.price) })}</span></div>`
        + `<div class="dx-sub">${tr("{timems}   ON-CHAIN {maker}   {sourcekind}", { timems: stamp(Number(t.timems) || 0), maker: t.maker ? th("MAKER") : th("TAKER"), sourcekind: esc(t.verification_status || t.source_kind || "") })}</div>${idLine("txpow", t.txpowid)}${idLine("order", t.orderid)}</div>`);
    }
    return out.join("");
  }
  const HIST_INFO = L_("Every trade this node made on the Exchange, newest first, then every finished AtomiX swap of the market the ⇄ pill is on. One line each: click a line for the amounts, the block and the full on-chain identifiers. Net counts settled trades only. A trade that is co-signed and posted shows as waiting until a block holds it. The txpow id is the pre-mining id; settlement is proven by the output coins. Export CSV saves every fill for your accounts; AtomiX swaps have their own file in Activity.");
  function historyHtml() {
    const net = C.netSettled(X.fills), now = Date.now(), tone = (n) => (n.sign > 0 ? "in" : n.sign < 0 ? "out" : "");
    const out = [`<div class="dx-title"><h2>${th("History")}</h2><button class="dx-info" data-info="hist" aria-label="${th("About History")}">i</button></div>`,
      `<div class="dx-card"><div class="dx-row"><div><div class="dx-label">${th("NET · SETTLED TRADES")}</div><div class="dx-net" data-tone="${tone(net.minima)}">${net.minima.text} MINIMA</div><div class="dx-net" data-tone="${tone(net.mxusd)}">${net.mxusd.text} MxUSD</div>`
      + `<div class="dx-counts">${net.count ? tr("{done} settled", { done: net.count + (net.count === 1 ? (" " + th("fill ·") + " ") : (" " + th("fills ·") + " ")) + net.done }) : X.loaded ? th("No fills yet.") : "…"}</div></div><button class="dx-btn dx-btn--side" data-csv="1"${net.count ? "" : " disabled"}>${th("Export CSV")}</button></div></div>`];
    let day = "";
    X.fills.forEach((f, i) => {
      const ms = (Number(f.ts) || 0) * 1000, d = C.dayLabel(ms, now), buy = f.side === "buy", fs = C.fillState(f), t = new Date(ms);
      if (d !== day) { day = d; out.push(`<div class="dx-day">${d}</div>`); }
      out.push(`<button class="dx-card dx-led" data-fill="${i}"><span class="dx-led__ic" data-tone="${fs.tone}">⇄</span><span class="dx-led__m"><b>${f.status === "done" ? (buy ? th("Bought") : th("Sold")) : (buy ? th("Buy") : th("Sell"))}</b>`
        + `<span class="dx-led__a">${buy ? tr("{f} MxUSD → {filled} MINIMA", { f: esc(C.fmt(C.fillUsd(f))), filled: esc(f.filled) }) : tr("{filled} MINIMA → {f} MxUSD", { filled: esc(f.filled), f: esc(C.fmt(C.fillUsd(f))) })}</span>`
        + `<span class="dx-led__s">@ ${esc(C.fmtPrice(C.dec(f.price)))} · ${f.role === "maker" ? th("you were the maker") : th("fast book")} · ${esc(fs.text)}</span></span>`
        + `<span class="dx-led__r">${f.status === "done" ? "" : `<span class="dx-chip" data-tone="${fs.tone}">${th(fs.chip)}</span>`}<span class="dx-led__t">${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} ▸</span></span></button>`);
    });
    return out.join("") + DexAx.part("history") + DexPools.part("history");
  }
  function fillFacts(f) {
    const buy = f.side === "buy", fs = C.fillState(f);
    return [I18N.t("{filled} MINIMA at {price} MxUSD per MINIMA", { filled: (buy ? (I18N.t("Bought") + " ") : (I18N.t("Sold") + " ")) + f.filled, price: C.fmtPrice(C.dec(f.price)) }), (buy ? I18N.t("Paid {usd} MxUSD", { usd: C.fmt(C.fillUsd(f)) }) : I18N.t("Received {usd} MxUSD", { usd: C.fmt(C.fillUsd(f)) })), I18N.t("State: {chip}, {fs}", { chip: fs.chip, fs: fs.text }),
      I18N.t("When: {ts}", { ts: new Date((Number(f.ts) || 0) * 1000).toString() }), I18N.t("Your side: {role}", { role: (f.role === "maker" ? I18N.t("maker (your FAST order was taken)") : I18N.t("taker (you took a FAST order)")) }), "",
      "txpow id (before mining)\n" + (f.txpowid || ""), "order\n" + (f.orderId || ""), "counterparty\n" + (f.maker || f.taker || f.counterparty || ""), "output coins\n" + ((f.coins || []).join("\n") || I18N.t("not recorded"))].join("\n");
  }
  async function onTabClick(e) {
    if (await DexAx.click(e)) return;   // AtomiX's own controls on the shared screens
    const b = e.target.closest("button"); if (!b) return;
    const ds = b.dataset;
    if (ds.sub != null) { X.sub = Number(ds.sub); return draw(); }
    if (ds.oact) return money(() => orderAction(ds.oact, ds.kind, ds.id, ds.price));
    if (ds.info) return void dialog(I18N.t("History"), HIST_INFO, "");
    if (ds.fill != null) return void dialog(I18N.t("Trade"), fillFacts(X.fills[Number(ds.fill)]), "");
    if (ds.csv) { try { const saved = await api.exportCsv(C.csv(X.fills), "dexicon-trades-" + new Date().toISOString().slice(0, 10) + ".csv"); if (saved) say(I18N.t("Saved {fills} fills.", { fills: X.fills.length }), "note"); } catch (err) { say(err && err.message); } return; }
    if (ds.asub != null) { X.asub = Number(ds.asub); return draw(); }
    if (ds.act != null) return void dialog(I18N.t("Activity"), actFacts(X.acts[Number(ds.act)]), "");
    if (ds.ainfo) return void dialog(I18N.t("Activity"), ACT_INFO, "");
    if (ds.asset) { X.open[ds.asset] = !X.open[ds.asset]; return draw(); }
    if (ds.room != null) return opts.go(C.ROOMS[Number(ds.room)].view);
    if (ds.relay) {
      const url = ds.relay === "add" ? $("dxRelayIn").value.trim().replace(/\/+$/, "") : ds.url;
      const bad = ds.relay === "add" ? C.relayProblem(url) : "";
      if (bad) return say(bad, "note");
      const r = await drive(ds.relay === "add" || ds.relay === "found" ? "addRelay" : ds.relay === "remove" ? "removeRelay" : "discover", { url });
      if (r.error) return say(r.error);
      if (ds.relay === "add") $("dxRelayIn").value = "";
      X.said = null; if (document.activeElement) document.activeElement.blur(); return draw();
    }
    if (ds.mm) return money(async () => {
      if (ds.mm === "makerStop" && !(await dialog(I18N.t("Stop the market maker?"), I18N.t("Your node signs a cancel for every ladder order and sends it to the relays within seconds. Your settings are kept. A take a maker already co-signed still settles."), "Stop"))) return;
      const r = await drive(ds.mm, { light: mem.theme === "DAYLIGHT" });
      if (r.error) say(r.error); else { X.said = null; load().then(draw, draw); }
    });
  }

  // ---- Activity (ActivityTab.java), Assets (AssetsTab.java), Settings (RelaysTab.java): shared by the rooms ----
  const ACT_INFO = L_("Every BUY and SELL you make and every fill your node co-signs, newest first, with its live progress. A trade is DONE (FAST) or CONFIRMED (on-chain) only when a block holds its output coin and three more blocks are on top; until then the line says where it stands. Click a line for its facts and identifiers. Market history is every fill this node saw on the book. AtomiX swaps are listed first, each with its steps, Check now and, when one is due, Refund now; a swap is never cancelled by hand: one that stalls is refunded by itself at its deadline. Pool operations (swaps against pools, creating, adding, migrating and closing a pool) follow, each with its transaction id whole; room ② Activity has the same list and every pool's transactions.");
  const A = () => (window.AX && window.AX.activity) || null;   // the engine's own stage machine and wording (dexicon/lib/activity.js, verbatim)
  function activityHtml() {
    const out = [`<div class="dx-title"><h2>${th("Activity")}</h2><button class="dx-info" data-ainfo="1" aria-label="${th("About Activity")}">i</button></div>`,
      `<div class="dx-chips"><button data-asub="0" aria-pressed="${X.asub === 0}">${th("My activity")}</button><button data-asub="1" aria-pressed="${X.asub === 1}">${th("Market history")}</button><button data-csv="1"${X.fills.length ? "" : " disabled"}>${th("↓ Export CSV")}</button><button data-axcsv="1">${th("↓ AtomiX swaps CSV")}</button></div>`];
    const ax = DexAx.part("activity", X.asub) + (X.asub === 0 ? DexPools.part("activity") : ""); out.push(ax);
    const now = Date.now(), tip = (st && st.block) || 0, hm = (ms) => { const t = new Date(ms); return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"); };
    let day = "";
    if (X.asub === 0) {
      if (!X.acts.length && !ax) out.push(`<div class="dx-card dx-none"><b>${X.loaded || axRoom() ? th("Nothing yet") : "…"}</b><span>${th("Every BUY and SELL you make, every fill your node co-signs, every AtomiX swap and every pool operation shows its live progress here.")}</span></div>`);
      X.acts.forEach((a, i) => {
        const ms = Number(a.ts) || 0, d = C.dayLabel(ms, now), buy = a.side === "buy" || a.buy === true, m = A();
        const chip = m ? m.chip(a, tip) : String(a.stage || ""), status = m ? m.status(a, tip, now) : String(a.stage || ""), tone = /DONE|CONFIRMED/.test(chip) ? "ok" : /FAILED|REFUSED|DROPPED|LOST/.test(chip) ? "bad" : "live";
        if (d !== day) { day = d; out.push(`<div class="dx-day">${d}</div>`); }
        out.push(`<button class="dx-card dx-led" data-act="${i}"><span class="dx-led__ic" data-tone="${tone}">${tone === "ok" ? "✓" : tone === "bad" ? "!" : "…"}</span><span class="dx-led__m"><b>${tone === "ok" ? (buy ? th("Bought") : th("Sold")) : (buy ? th("Buy") : th("Sell"))} MINIMA</b>`
          + `<span class="dx-led__a">${tr("{minima} MINIMA @ {price}", { minima: esc(a.amount || a.minima || ""), price: esc(a.price || "") })}</span><span class="dx-led__s">${stamp(ms)} · ${a.route === "FAST" ? th("fast book") : th("on-chain")} · ${esc(status)}</span></span>`
          + `<span class="dx-led__r"><span class="dx-chip" data-tone="${tone}">${esc(I18N.t(chip))}</span><span class="dx-led__t">▸</span></span></button>`);
      });
    } else {
      const tape = X.svc && Array.isArray(X.svc.tape) ? X.svc.tape : [];
      if (!tape.length && !ax) out.push(`<div class="dx-card dx-none"><b>${th("No trades seen yet")}</b><span>${th("Fills this node sees on the on-chain book are listed here. There is no server and no back-fill.")}</span></div>`);
      for (const t of tape) {
        const ms = Number(t.timems) || 0, d = C.dayLabel(ms, now);
        if (d !== day) { day = d; out.push(`<div class="dx-day">${d}</div>`); }
        out.push(`<div class="dx-card dx-ocard"><div class="dx-row"><span class="dx-oline dx-o${t.buy ? "buy" : "sell"}">${tr("{buy}{size} MINIMA @ {price}", { buy: t.buy ? (th("BUY") + " ") : (th("SELL") + " "), size: esc(t.size), price: esc(t.price) })}</span><span class="dx-led__t">${hm(ms)}</span></div>${idLine("txpow", t.txpowid)}</div>`);
      }
    }
    return out.join("");
  }
  function actFacts(a) {
    const m = A(), tip = (st && st.block) || 0, L = [I18N.t("{minima} MINIMA at {price} MxUSD per MINIMA", { minima: (a.side === "buy" || a.buy === true ? (I18N.t("BUY") + " ") : (I18N.t("SELL") + " ")) + (a.amount || a.minima || ""), price: (a.price || "") }),
      I18N.t("Route: {route}{role}", { route: (a.route === "FAST" ? I18N.t("FAST book") : I18N.t("on-chain book and pools")), role: (a.role ? I18N.t(", you were the {role}", { role: a.role }) : "") }), I18N.t("State: {stage}", { stage: (m ? m.chip(a, tip) + ". " + m.status(a, tip, Date.now()) : a.stage) }), I18N.t("Started: {ts}", { ts: new Date(Number(a.ts) || 0).toString() }), ""];
    for (const [k, label] of [["txpowid", "txpow id (before mining)"], ["orderId", "order"], ["counterparty", "counterparty"], ["id", "activity id"]]) if (a[k]) L.push(label + "\n" + a[k]);
    for (const [k, label] of [["outs", "output coins"], ["ins", "input coins"]]) if (Array.isArray(a[k]) && a[k].length) L.push(label + "\n" + a[k].join("\n"));
    return L.join("\n");
  }
  function assetsHtml() {
    const f = fundsNow(), ident = (X.svc && X.svc.identity) || {}, addr = ident.miniaddress || ident.address || "", id = (st && st.publicId) || "";
    const asset = (key, name, avail, inOrders, settling) => `<button class="dx-card dx-asset" data-asset="${key}" aria-expanded="${!!X.open[key]}"><span class="dx-row"><span><b>${name}</b><span class="dx-asset__n">${f.known ? esc(C.fmt(avail)) : "…"}</span></span><span class="dx-asset__h">${tr("available to trade {key}", { key: X.open[key] ? "▾" : "▸" })}</span></span>`
      + (X.open[key] && f.known ? `<span class="dx-asset__more">${tr("{inOrders}  promised by your live FAST orders (still in your wallet)\n{inOrders2}  free for a new order\n+{settling}  settling: traded, waiting for a block", { inOrders: esc(C.fmt(inOrders)), inOrders2: esc(C.fmt(C.sub(avail, inOrders))), settling: esc(C.fmt(settling)) })}</span>` : "") + `</button>`;
    return (!f.known ? `<div class="dx-state dx-state--note">${esc(X.balErr || I18N.t("The balance has not been read yet."))}</div>` : "")
      + asset("minima", "MINIMA", f.minima, f.minimaOrders, f.minimaSettling) + asset("mxusd", "MxUSD", f.mxusd, f.mxusdOrders, f.mxusdSettling) + DexAx.part("assets")   // the phone's order: the two coins, Ethereum, then the rest
      + `<div class="dx-card"><div class="dx-row"><span class="dx-label">${th("RECEIVE MINIMA OR MxUSD")}</span>${addr ? `<button class="dx-btn dx-btn--side" data-copy="${esc(addr)}">${th("Copy")}</button>` : ""}</div><div class="dx-addr" ${addr ? `data-copy="${esc(addr)}" title="${th("Click to copy")}"` : ""}>${esc(addr || I18N.t("The address appears when Dexicon has read the chain."))}</div></div>`
      + `<div class="dx-card"><div class="dx-row"><span class="dx-label">${th("YOUR TRADING ID")}</span>${id ? `<button class="dx-btn dx-btn--side" data-copy="${esc(id)}">${th("Copy")}</button>` : ""}</div><div class="dx-addr" ${id ? `data-copy="${esc(id)}" title="${th("Click to copy")}"` : ""}>${esc(id || I18N.t("Not read yet."))}</div>`
      + `<div class="dx-sub dx-sub--sans">${th("Other traders see this ID when you trade on the fast book. It is made from your node's seed, so it stays the same if you reinstall. It is not an address: never send coins to it.")}</div></div>`;
  }
  function settingsHtml() {
    const relays = Page.state.relays || [], px = st && st.price;
    const health = (r) => (r.found ? "found through " + r.meta.replace(/^via\s*/, "") : r.state === "ok" ? (I18N.t("OK ·") + " ") + r.meta : r.state === "bad" ? I18N.t("ERROR · {meta}", { meta: r.meta }) : I18N.t("not polled yet"));
    return DexAx.part("settings") + `<div class="dx-card"><div class="dx-h">${th("WALLET")}</div><div class="dx-sub dx-sub--sans">${th("Dexicon trades with this node's own wallet: the node signs every trade with its own keys. Your node's seed phrase backs up everything here.")}</div></div>`
      + `<div class="dx-card"><div class="dx-h">${th("ADD RELAY")}</div><div class="dx-sub dx-sub--sans">${th("A Dexicon relay is the dexrelay cape of parlons-node.jar / maxima-server.jar. Orders are published to EVERY relay here; the book is the union. On the desktop a relay must be an https address.")}</div>`
      + `<input class="dx-in dx-in--s" id="dxRelayIn" placeholder="${th("https://relay.example/dex-relay")}" aria-label="${th("Relay address")}" autocomplete="off" spellcheck="false"><div class="dx-mm__b"><button class="dx-btn dx-btn--acc" data-relay="add">${th("ADD")}</button><button class="dx-btn dx-btn--acc" data-relay="discover">${th("DISCOVER")}</button></div></div>`
      + (relays.length ? relays.map(r => `<div class="dx-card dx-relay"><div><div class="dx-relay__u" data-copy="${esc(r.url)}" title="${th("Click to copy")}">${esc(r.url)}</div><div class="dx-relay__s" data-state="${r.found ? "" : esc(r.state)}">${esc(health(r))}</div></div>`
          + (r.found ? `<button class="dx-btn dx-btn--side" data-relay="found" data-url="${esc(r.url)}">${th("ADD")}</button>` : `<button class="dx-relay__x" data-relay="remove" data-url="${esc(r.url)}" aria-label="${th("Remove this relay")}">✕</button>`) + `</div>`).join("")
        : `<div class="dx-card dx-none"><b>${Page.state.ready || Page.stub ? th("No relays yet") : "…"}</b><span>${th("Add the address of any Dexicon relay, then DISCOVER to find the others.")}</span></div>`)
      + `<div class="dx-card"><div class="dx-h">${th("ENGINE")}</div><div class="dx-sub dx-sub--sans">${tr("Dexicon engine {version} · block {block} · {label}", { version: esc((st && st.version) || "…"), block: esc((st && st.block) || "…"), label: px && px.mid > 0 ? esc(C.priceName(px.source) + " " + px.mid + (px.label ? " (" + px.label + ")" : "")) : th("no MEXC price yet") })}</div></div>`;
  }

  return { init, paint, render, node: node_, dialog, paintStrip, say, redraw: () => draw(), money, where: () => ({ shown: shown(), shared: ours(), room: C.ROOMS[mem.room].id, tab: C.tabOf(mem) }), pickTab: (tab) => { C.pickTab(mem, tab); write(); paintNav(); render(); }, _service: onService, _preview: (page, stub) => { Page.state = page || {}; Page.stub = stub || (() => Promise.resolve({ error: "" })); draw(); } };
})();
