/*
 * dexicon-ui.js: Dexicon's screens. The chrome (header, status strip, room pills, bottom tab bar) is native and is
 * the Android client's (apks/dexicon MainActivity.java buildChrome); logic without a DOM lives in dexicon-core.js.
 * Rooms ① MxUSD and ② Pools show the existing desktop AtomiX and Pools panels, as they are, until phases 3c / 3d.
 * Room ③ Exchange is drawn here over the hosted Dexicon engine (window.mcd dx* calls, main/dexicon.js).
 */
const DexUI = (() => {
  "use strict";
  const C = DexCore, api = window.mcd, $ = (id) => document.getElementById(id);
  const KEY = "dexicon";
  // Android's tab icons, path data unchanged (apks/dexicon res/drawable/ic_tab_*.xml; 24 grid, stroke 2, round)
  const ICON = {
    trade: "M8,4 L8,20 M6,8 L10,8 L10,15 L6,15 Z M16,4 L16,18 M14,7 L18,7 L18,13 L14,13 Z",
    orders: "M9,7 L20,7 M9,12 L20,12 M9,17 L20,17 M4,7 L5,7 M4,12 L5,12 M4,17 L5,17",
    history: "M3,12 A9,9 0 1,1 21,12 A9,9 0 1,1 3,12 M12,7 L12,12 L15,14",
    activity: "M3,12 h4 l2,6 l4,-14 l2,8 h6",
    assets: "M6,6 h11 a3,3 0 0,1 3,3 v6 a3,3 0 0,1 -3,3 h-11 a3,3 0 0,1 -3,-3 v-6 a3,3 0 0,1 3,-3 z M16,12 h2.5",
    settings: "M4,7 L20,7 M4,17 L20,17 M9,4 L9,10 M15,14 L15,20"
  };
  let mem = C.load(read()), opts = null, node = { state: "" }, st = null;

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write() { try { localStorage.setItem(KEY, C.save(mem)); } catch (e) {} }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function init(o) {
    opts = o;
    $("dxRail").innerHTML = C.ROOMS.map((r, i) => `<button class="dx-room" data-room="${i}" aria-pressed="false">${r.n} ${r.label}</button>`).join("");
    $("dxRail").onclick = (e) => { const b = e.target.closest("[data-room]"); if (b) opts.go(C.ROOMS[Number(b.dataset.room)].view); };
    $("dxNav").onclick = (e) => { const b = e.target.closest("[data-dxtab]"); if (b) { C.pickTab(mem, b.dataset.dxtab); write(); paintNav(); render(); } };
    $("dxNav").addEventListener("keydown", (e) => {   // one tab stop, the arrow keys move along the bar
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const all = [...$("dxNav").querySelectorAll(".dx-tab")], i = all.indexOf(document.activeElement); if (i < 0) return;
      const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; e.preventDefault(); next.focus(); next.click();
    });
    $("dxTheme").onclick = () => { C.toggleTheme(mem); write(); paintTheme(); };
    $("dxClose").onclick = () => opts.leave();
    $("dxPair").onclick = () => { if (node.state === "stopped") opts.start(); };
    api.onDexicon((message) => { if (typeof message === "string") onService(message); if (Page.frame && typeof message === "string") Page.frame.contentWindow.postMessage({ dxRoom: 1, update: { dex: message } }, "*"); if (shown()) refresh(); });
    window.addEventListener("message", onFrameMessage);
    setInterval(() => { if (shown() && C.ROOMS[mem.room].view === "dexicon") refresh(); }, 5000);   // the FAST book moves between blocks
    paintTheme();
  }
  const shown = () => $("shell").dataset.mode === "dex";

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
    $("dxTheme").setAttribute("aria-label", dark ? "Switch Dexicon to its light theme" : "Switch Dexicon to its dark theme");
  }
  function paintNav() {
    const tabs = C.ROOMS[mem.room].tabs, on = C.tabOf(mem);
    $("dxNav").hidden = !tabs.length;
    $("dxNav").innerHTML = tabs.map(t => `<button class="dx-tab" role="tab" data-dxtab="${t}" aria-selected="${t === on}" tabindex="${t === on ? 0 : -1}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[t]}"/></svg><span>${C.TAB_LABEL[t]}</span></button>`).join("");
  }
  function paintStrip() {
    const s = C.strip(node.state, st), p = $("dxPair");
    p.textContent = s.text + (node.state === "stopped" ? "  ▸" : ""); p.dataset.tone = s.tone;
    p.style.cursor = node.state === "stopped" ? "pointer" : "";
    const block = (node.health && node.health.block) || (st && st.block) || 0;
    $("dxBlock").textContent = "# " + (block > 0 ? block : "…");
    $("dxVer").textContent = "v" + ((st && st.version) || "…");
  }
  function node_(s) { node = s || { state: "" }; if (opts) { paintStrip(); pageEnsure(); } }

  async function refresh() {
    try { st = await api.dxStatus(); } catch (e) { st = null; }
    paintStrip(); pageEnsure();
    if (shown() && C.ROOMS[mem.room].view === "dexicon") { await load().catch(() => {}); draw(); }
  }

  // ---- the page: the taker's engine, verbatim, in a hidden sandboxed frame (renderer/dexicon/mds.js) ----
  const Page = { frame: null, state: {}, seq: 0, waiting: {} };
  function pageEnsure() {
    const want = node.state === "running" && (st ? !!st.ready : !!Page.frame);   // a status read that failed tears nothing down (a take may be in flight)
    if (want && !Page.frame) {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts"); f.hidden = true; f.title = "Dexicon engine"; f.src = "dxroom://exchange/index.html";
      $("shell").appendChild(f); Page.frame = f;
    } else if (!want && Page.frame) { Page.frame.remove(); Page.frame = null; Page.state = {}; for (const k of Object.keys(Page.waiting)) { Page.waiting[k]({ error: "Dexicon stopped before it answered. Look at Activity before trying again." }); delete Page.waiting[k]; } }
  }
  function onFrameMessage(e) {
    if (!Page.frame || e.source !== Page.frame.contentWindow) return;
    const m = e.data || {}; if (m.dxRoom !== 1) return;
    if (m.page && typeof m.page === "object") { Page.state = m.page; if (shown()) draw(); return; }
    if (m.driven != null) { const w = Page.waiting[m.driven]; if (w) { delete Page.waiting[m.driven]; w({ error: m.error || "", asked: m.asked || "" }); } return; }
    const call = C.bridgeCall(m); if (!call) return;
    const back = (value, error) => { if (Page.frame) Page.frame.contentWindow.postMessage(error == null ? { dxRoom: 1, id: m.id, value } : { dxRoom: 1, id: m.id, error }, "*"); };
    (call.kind === "clip" ? api.clip(call.text) : api.dxCommand(call.args)).then(v => back(v), err => back(null, C.refusal(err && err.message)));
  }
  /** Ask the page for one of its actions. Resolves { error, asked }: error = why nothing was done; asked = the page's
   *  own review text when it wants one confirmed. */
  function drive(act, args) {
    if (Page.stub) return Page.stub(act, args);
    if (!Page.frame || !Page.state.ready) return Promise.resolve({ error: "Dexicon is still starting. Nothing was sent." });
    const id = ++Page.seq;
    return new Promise(resolve => { Page.waiting[id] = resolve; Page.frame.contentWindow.postMessage(C.driveCall(id, act, args), "*"); });
  }

  // ---- room 3, Exchange: the Android screens over the engine's read model ----
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const X = { book: null, mine: { orders: [], pending: [] }, orders: [], fills: [], bal: null, balErr: "", svc: {}, buy: true, group: 0, fundsBig: false, said: null, loaded: false };
  try { X.group = Math.min(3, Math.max(0, Number(localStorage.getItem("dexicon_group")) || 0)); X.fundsBig = localStorage.getItem("dexicon_funds_big") === "1"; } catch (e) {}
  const pref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const kv = async (k, dflt) => { const r = await api.dxCommand({ op: "sql", query: "SELECT v FROM ax_kv WHERE k='" + k + "'" }); const row = r && r.rows && r.rows[0]; try { return row ? JSON.parse(row.V || row.v) : dflt; } catch (e) { return dflt; } };

  async function load() {
    const ok = node.state === "running" && st && st.ready;
    if (!ok) { X.book = null; X.loaded = false; return; }
    const got = await Promise.allSettled([api.dxBook(), api.dxMine(), kv("myorders", []), api.dxCommand({ op: "sql", query: "SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'" }), api.cmd("balance")]);
    const val = (i, d) => (got[i].status === "fulfilled" && got[i].value != null ? got[i].value : d);
    X.book = val(0, null); X.mine = val(1, { orders: [], pending: [] }); X.orders = Array.isArray(val(2, [])) ? val(2, []) : [];
    X.fills = ((val(3, {}).rows) || []).map(r => { try { return JSON.parse(r.V || r.v); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const bal = val(4, null);
    if (bal && bal.status && Array.isArray(bal.response)) { const of = (id) => (bal.response.find(r => r.tokenid === id) || {}).sendable || "0"; X.bal = { minima: of("0x00"), mxusd: of(MXUSD) }; X.balErr = ""; }
    else { X.bal = null; X.balErr = C.refusal((bal && bal.error) || (got[4].reason && got[4].reason.message) || "The balance could not be read."); }
    X.loaded = true;
  }
  function onService(message) {   // the service's packets, in its own words (main/dexicon.js "comms")
    let p = null; try { p = JSON.parse(message); } catch (e) { return; }
    if (!p || p.origin !== "service") return;
    if (p.type === "STATE") X.svc = p.data || {};
  }
  const fundsNow = () => C.funds(X.bal && X.bal.minima, X.bal && X.bal.mxusd, X.orders, X.fills);
  const lad = () => C.ladder(X.book, X.group);

  /** What stops trading right now, in plain words (empty: nothing does). */
  function blocker() {
    if (node.state !== "running") return "The node is stopped, so nothing here can trade. Start it and Dexicon comes back by itself.";
    if (!st || !st.started || !st.ready) return "Dexicon is still starting: it is reading this wallet's trading identity from the node. Nothing can be sent yet.";
    if (Page.state.idError) return "The trading identity could not be read: " + Page.state.idError;
    if (!Page.state.ready && !Page.stub) return "Dexicon is still starting. Nothing can be sent yet.";
    if (!(st.relays || []).length) return "No relay is set, so there is no FAST book and a FAST order cannot be published. Add a relay in Settings.";
    if (relayDown()) return "No relay answers right now, so the FAST book may be out of date and a FAST order may not be heard. On-chain orders and pools still work.";
    return "";
  }
  const relayDown = () => { const r = (Page.state.relays || []).filter(x => !x.found); return r.length > 0 && !r.some(x => x.state === "ok") && r.some(x => x.state === "bad"); };

  function dialog(title, text, okLabel, input) {
    return new Promise(resolve => {
      const d = document.createElement("dialog"); d.className = "dx-dlg";
      d.innerHTML = `<h2>${esc(title)}</h2><pre>${esc(text)}</pre>${input ? `<input class="dx-in" inputmode="decimal" aria-label="${esc(input.label)}" value="${esc(input.value || "")}">` : ""}<div class="dx-dlg__b"><button class="dx-btn" data-x="0">Close</button>${okLabel ? `<button class="dx-btn dx-btn--go" data-x="1">${esc(okLabel)}</button>` : ""}</div>`;
      d.onclick = (e) => { const b = e.target.closest("[data-x]"); if (!b) return; const v = b.dataset.x === "1" ? (input ? d.querySelector("input").value.trim() : true) : null; d.close(); d.remove(); resolve(v); };
      d.addEventListener("cancel", () => { d.remove(); resolve(null); });
      $("shell").appendChild(d); d.showModal();
    });
  }
  const say = (text, kind) => { X.said = { text: C.refusal(text), kind: kind || "error" }; draw(); };

  function render() {
    const body = $("dxBody"); if (!body) return;
    const tab = C.tabOf(mem);
    if (body.dataset.tab !== tab) { body.dataset.tab = tab; body.innerHTML = tab === "trade" ? tradeSkeleton() : ""; if (tab === "trade") bindTrade(); }
    draw();
    load().then(draw, draw);
  }
  function draw() {
    const body = $("dxBody"); if (!body || !shown() || C.ROOMS[mem.room].view !== "dexicon") return;
    const tab = body.dataset.tab;
    if (tab === "trade") paintTrade();
    else body.innerHTML = `<div class="dx-card"><div class="dx-note"><b>${esc(C.TAB_LABEL[tab])}</b><br>${esc(blocker() || C.strip(node.state, st).text)}</div></div>`;
  }

  // ---- Trade (TradeView.java): ticker and book on the left; funds, the ticket and my orders on the right ----
  function tradeSkeleton() {
    return `<div class="dx-state" id="dxState" role="status" hidden></div>
    <div class="dx-trade">
      <div class="dx-col">
        <div class="dx-card"><div class="dx-row"><b class="dx-t13">MINIMA / MxUSD</b><span class="dx-sync" id="dxSync"></span></div>
          <div class="dx-midrow"><span class="dx-mid" id="dxMid">…</span><span class="dx-spread" id="dxSpread"></span></div>
          <div class="dx-kind" id="dxKind"></div>
          <div class="dx-stats"><div><label>Bids</label><span id="dxBidsN">…</span></div><div><label>Asks</label><span id="dxAsksN">…</span></div></div>
          <div class="dx-kind" id="dxMexc"></div></div>
        <div class="dx-card"><div class="dx-row"><span class="dx-h">ORDER BOOK</span><span class="dx-groups" id="dxGroups" role="group" aria-label="Price grouping">${C.GROUP_LABELS.map((g, i) => `<button data-g="${i}">${g}</button>`).join("")}</span></div>
          <div class="dx-legend"><span>Price (MxUSD)</span><span>Amount (MINIMA)</span><span>Total</span></div>
          <div id="dxAsks"></div><div class="dx-center" id="dxCenter">…</div><div id="dxBids"></div></div>
      </div>
      <div class="dx-col">
        <button class="dx-card dx-funds" id="dxFunds" aria-label="Your funds: show more or less"></button>
        <div class="dx-card">
          <div class="dx-side" role="group" aria-label="Side"><button id="dxBuy" aria-pressed="true">BUY</button><button id="dxSell" aria-pressed="false">SELL</button></div>
          <input class="dx-in" id="dxPrice" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="Price (MxUSD per MINIMA)" aria-label="Price, MxUSD per MINIMA">
          <input class="dx-in" id="dxAmount" inputmode="decimal" autocomplete="off" maxlength="44" placeholder="Amount (MINIMA)" aria-label="Amount, MINIMA">
          <button class="dx-avail" id="dxAvail"></button>
          <div class="dx-pct" id="dxPct">${[25, 50, 75, 100].map(n => `<button data-pct="${n}">${n}%</button>`).join("")}</div>
          <div class="dx-total" id="dxTotal">Total: …</div>
          <div class="dx-warn" id="dxWarn" role="alert"></div>
          <div class="dx-review" id="dxReview"></div>
          <div class="dx-ctas"><button class="dx-cta" id="dxCta"></button><button class="dx-cta" id="dxCta2" hidden></button></div>
          <div class="dx-log" id="dxLog" role="log" hidden></div>
        </div>
        <div class="dx-card"><div class="dx-h">MY OPEN ORDERS</div><div id="dxMyOrders"></div></div>
      </div>
    </div>`;
  }
  const num = (v) => { const d = C.dec(v); return d && d.v > 0n ? d : null; };
  function bindTrade() {
    const price = $("dxPrice"), amount = $("dxAmount");
    for (const i of [price, amount]) i.oninput = () => { const clean = i.value.replace(",", ".").replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"); if (clean !== i.value) i.value = clean; X.said = null; paintTicket(); };
    $("dxBuy").onclick = () => { X.buy = true; paintTicket(); };
    $("dxSell").onclick = () => { X.buy = false; paintTicket(); };
    $("dxGroups").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; X.group = Number(b.dataset.g); pref("dexicon_group", String(X.group)); paintTrade(); };
    $("dxFunds").onclick = () => { X.fundsBig = !X.fundsBig; pref("dexicon_funds_big", X.fundsBig ? "1" : "0"); paintFunds(); };
    const pct = (n) => {
      if (!num(price.value)) return say("Enter a price first, or click a row in the book.", "note");
      const a = C.percent(X.book, X.buy, price.value, n, fundsNow());
      if (!a) return say(X.balErr || "The balance has not been read yet.", "note");
      amount.value = a.v > 0n ? C.fmt(a) : ""; X.said = null; paintTicket();
    };
    $("dxPct").onclick = (e) => { const b = e.target.closest("[data-pct]"); if (b) pct(Number(b.dataset.pct)); };
    $("dxAvail").onclick = () => pct(100);
    const rowClick = (e) => { const r = e.target.closest("[data-price]"); if (!r) return; X.buy = r.dataset.side === "ask"; price.value = r.dataset.price; amount.value = r.dataset.cum; X.said = null; paintTicket(); };
    $("dxAsks").onclick = rowClick; $("dxBids").onclick = rowClick;
    $("dxCta").onclick = () => submit("fast");
    $("dxCta2").onclick = () => submit("chain");
    $("dxMyOrders").onclick = (e) => { const b = e.target.closest("[data-oact]"); if (b) orderAction(b.dataset.oact, b.dataset.kind, b.dataset.id, b.dataset.price); };
  }
  function paintTrade() {
    if (!$("dxPrice")) return;
    const why = blocker(), L = lad(), relays = (Page.state.relays || []).filter(r => !r.found), anyOk = relays.some(r => r.state === "ok") || (Page.stub && !relayDown());
    $("dxState").hidden = !why; $("dxState").textContent = why;
    const sync = $("dxSync"), nRelays = ((st && st.relays) || []).length;
    sync.textContent = !nRelays ? "● no relays" : relayDown() ? "● no relay answers" : anyOk ? "● live" : "● connecting"; sync.dataset.ok = anyOk && !relayDown() ? "1" : "0";
    $("dxMid").textContent = L.mid ? C.fmtPrice(L.mid) : "…";
    $("dxSpread").textContent = L.spread ? "spread " + C.fmt(L.spread) : "";
    $("dxKind").textContent = (!L.mid ? "no live orders" : L.bestBid && L.bestAsk ? "mid of best bid / best ask" : L.bestBid ? "best bid only" : "best ask only") + " · FAST + BOOK + POOL";
    $("dxBidsN").textContent = L.count.fast + " fast · " + L.count.book + " book order" + (L.count.book === 1 ? "" : "s");
    $("dxAsksN").textContent = L.count.pools + " pool" + (L.count.pools === 1 ? "" : "s");
    // the only outside price shown is MEXC's, with the label the engine's read model gives it
    const px = st && st.price; $("dxMexc").textContent = px && px.mid > 0 ? (px.source || "MEXC price") + " " + px.mid + (px.label ? " · " + px.label : "") : "";
    document.querySelectorAll("#dxGroups button").forEach(b => b.setAttribute("aria-pressed", Number(b.dataset.g) === X.group ? "true" : "false"));
    const row = (r, ask) => {
      const lv = r.lv, parts = C.amountText(lv.fast, lv.book, lv.pool), shown_ = C.fmtPrice(lv.exact), at = C.GROUPS[X.group] ? C.fmt(lv.price) : C.fmt(lv.exact);
      return `<button class="dx-lrow" data-side="${ask ? "ask" : "bid"}" data-price="${at}" data-cum="${C.fmt(r.cum)}" style="--f:${Math.min(100, r.frac * 100).toFixed(2)}%" aria-label="${ask ? "Ask" : "Bid"} ${shown_}, ${esc(parts.join(", "))} MINIMA${lv.mine ? ", includes your own order" : ""}">`
        + `<span class="dx-lp">${lv.mine ? "• " : ""}${shown_}</span><span class="dx-la${parts.length > 1 || /[A-Z]/.test(parts[0]) ? " dx-la--tag" : ""}">${parts.map(esc).join("<br>")}</span><span class="dx-lt">${C.fmt(C.up(C.mul(lv.price, lv.total), 4))}</span></button>`;
    };
    $("dxAsks").innerHTML = C.rows(L.asks).reverse().map(r => row(r, true)).join("");   // best ask just above the centre
    $("dxBids").innerHTML = C.rows(L.bids).map(r => row(r, false)).join("");
    if (!L.asks.length && !L.bids.length) $("dxAsks").innerHTML = `<div class="dx-empty">${esc(!X.loaded ? "…" : nRelays ? "No live orders yet." : "Add a relay in Settings.")}</div>`;
    $("dxCenter").textContent = L.mid ? C.fmtPrice(L.mid) : "…";
    X.lastMid = L.mid;
    paintFunds(); paintTicket(); paintMyOrders();
  }
  function paintFunds() {
    const f = fundsNow(), b = $("dxFunds"); if (!b) return;
    const value = f.known && X.lastMid ? "≈ " + C.fmt(C.down(C.add(C.add(f.mxusd, f.mxusdSettling), C.mul(C.add(f.minima, f.minimaSettling), X.lastMid)), 4)) + " MxUSD @ mid " + C.fmtPrice(X.lastMid) : "";
    const block = (name, a, o, s2) => `<div><b>${name}</b><br>${C.fmtBal(a)}  available<br>${C.fmtBal(o)}  in your orders<br>+${C.fmtBal(s2)}  settling<br>${C.fmtBal(C.add(a, s2))}  total</div>`;
    b.innerHTML = `<div class="dx-row"><span class="dx-h">YOUR FUNDS  ${X.fundsBig ? "▾" : "▸"}</span><span class="dx-fval">${esc(value)}</span></div>`
      + (!f.known ? `<div class="dx-fsmall">${esc(X.balErr || (node.state === "running" ? "reading…" : "node stopped"))}</div>`
        : X.fundsBig ? `<div class="dx-fcols">${block("MINIMA", f.minima, f.minimaOrders, f.minimaSettling)}${block("MxUSD", f.mxusd, f.mxusdOrders, f.mxusdSettling)}</div>`
        : `<div class="dx-fsmall">${C.fmtBal(f.minima)} MINIMA  ·  ${C.fmtBal(f.mxusd)} MxUSD  available</div>`);
  }
  function paintTicket() {
    if (!$("dxPrice")) return;
    const buy = X.buy, f = fundsNow(), pl = C.plan(X.book, buy, $("dxPrice").value, $("dxAmount").value, f), why = blocker(), side = buy ? "BUY " : "SELL ";
    $("dxBuy").setAttribute("aria-pressed", buy ? "true" : "false"); $("dxSell").setAttribute("aria-pressed", buy ? "false" : "true");
    $("dxAvail").textContent = !f.known ? "Available: … (" + (X.balErr || "not read yet") + ")" : "Available: " + C.fmtBal(C.freeFor(f, buy)) + (buy ? " MxUSD" : " MINIMA") + "  ·  tap for max\n(" + C.fmtBal(f.minima) + " MINIMA · " + C.fmtBal(f.mxusd) + " MxUSD in wallet)";
    let total = "Total: …";
    if (pl.ok) {
      const all = C.mul(pl.amount, pl.price);
      total = (buy ? "You pay up to " + C.fmt(C.up(all, 8)) + " MxUSD\nYou receive " + C.fmt(pl.amount) + " MINIMA" : "You pay " + C.fmt(pl.amount) + " MINIMA\nYou receive at least " + C.fmt(C.down(all, 8)) + " MxUSD")
        + (pl.fast ? "\nFills now ≈ " + C.fmt(pl.take) + " MINIMA @ avg " + C.fmtPrice(pl.avg) : "\nNothing crosses on the FAST book: all of it rests as your FAST order @ " + C.fmtPrice(pl.price));
    }
    $("dxTotal").textContent = total;
    const short = pl.ok && pl.short.v > 0n;
    $("dxWarn").textContent = pl.ok === false && pl.why ? pl.why : short ? "Exceeds your free " + (buy ? "MxUSD" : "MINIMA") + " by " + C.fmt(pl.short) + " (free " + C.fmtBal(pl.free) + ")" : "";
    $("dxReview").innerHTML = C.review(pl, ((st && st.relays) || []).length).map(l => `<p>${esc(l)}</p>`).join("")
      || `<p>Crosses FAST orders → the button IS the trade: one click takes them best-first up to your amount, no dialog, progress in the log below; what they can't cover is not traded. BOOK/POOL on-chain liquidity still shows a confirm. Nothing crosses → rests on the relays as your FAST order.</p>`;
    const cta = $("dxCta"), cta2 = $("dxCta2"), trading = !!Page.state.trading, dead = !!why && !/No relay answers/.test(why);
    for (const b of [cta, cta2]) b.dataset.side = buy ? "buy" : "sell";
    cta.innerHTML = trading ? "TRADING…" : pl.ok && pl.fast ? esc(side + C.fmt(pl.take) + " NOW · FAST") + "<small>instant · " + esc(C.fmtPrice(pl.avg)) + "</small>" : buy ? "BUY MINIMA" : "SELL MINIMA";
    cta.disabled = trading || dead || short || !f.known || (pl.ok === false && !!pl.why);
    cta2.hidden = !(pl.ok && pl.chain) || trading;
    cta2.innerHTML = esc(side.trim() + " · BOOK / POOL") + "<small>on-chain, about 3 minutes · review first</small>";
    cta2.disabled = dead || !f.known;
    // the engine's own words: the take's progress, then what the page or the service last said
    const lines = (Page.state.log || []).slice(), n = Page.state.notice, k = Page.state.kind || "";
    const stage = X.svc && X.svc.stage; if (stage) lines.push(stage);
    if (n && /error|posted|pending/.test(k) && lines[lines.length - 1] !== n) lines.push(n);
    const log = $("dxLog"), mine = X.said;
    log.hidden = !lines.length && !mine;
    log.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("") + (mine ? `<div class="dx-log__${mine.kind}">${esc(mine.text)}</div>` : "");
    log.dataset.kind = /error/.test(k) ? "error" : "";
  }
  async function submit(layer) {
    const price = $("dxPrice").value.trim(), amount = $("dxAmount").value.trim();
    if (!num(price) || !num(amount)) return say("Enter a price and an amount.", "note");
    X.said = null;
    const args = { buy: X.buy, price, amount, layer };
    let r = await drive("place", args);
    while (!r.error && r.asked && r.asked !== args.reviewed) {   // on-chain: the page's own review, word for word, before anything is signed
      const ok = await dialog(args.reviewed ? "The book moved. Review again" : "Review this on-chain trade", r.asked + "\n\nYour node signs this transaction and posts it. It is final only when a block confirms it (about 3 minutes); until then Activity shows it as waiting.", "Sign and send");
      if (!ok) return say("Nothing was signed or sent.", "note");
      args.reviewed = r.asked;
      r = await drive("place", args);
    }
    if (r.error) return say(r.error);
    load().then(draw, draw);
  }
  function paintMyOrders() {
    const box = $("dxMyOrders"); if (!box) return;
    box.innerHTML = orderRows() || `<div class="dx-empty">No open orders</div>`;
  }
  /** My open orders: FAST (signed, on the relays) and on-chain (coins in the order contract). */
  function orderRows() {
    const out = [];
    for (const o of X.orders) {
      if (o.status !== "live") continue;
      const sell = o.side === "sell", rem = C.dec(o.remaining), price = C.dec(o.price); if (!rem || !price) continue;
      out.push(orderRow(sell, (sell ? "SELL " : "BUY ") + C.fmt(rem) + " @ " + C.fmtPrice(price) + ((o.coins || []).length ? "" : "  UNBACKED"), "FAST · order " + o.orderId, "fast", o.orderId, C.fmt(price)));
    }
    for (const o of (X.mine.orders || [])) {
      const m = C.dec(o.minima), price = C.dec(o.price); if (!m || !price) continue;
      out.push(orderRow(o.sell, (o.sell ? "SELL " : "BUY ") + C.fmt(m) + " @ " + C.fmtPrice(price) + (o.pending ? "  " + String(o.pending).toUpperCase() + " WAITING FOR A BLOCK" : ""), "ON-CHAIN · coin " + o.coinid, "chain", o.coinid, C.fmt(price), !!o.pending));
    }
    for (const o of (X.mine.pending || [])) {
      const m = C.dec(o.minima), price = C.dec(o.price); if (!m || !price) continue;
      out.push(`<div class="dx-orow"><div><span class="dx-o${o.sell ? "sell" : "buy"}">${o.sell ? "SELL " : "BUY "}${C.fmt(m)} @ ${C.fmtPrice(price)}</span><small>ON-CHAIN · posted, waiting for a block: not on the book yet</small></div></div>`);
    }
    return out.join("");
  }
  const orderRow = (sell, text, sub, kind, id, price, busy) => `<div class="dx-orow"><div><span class="dx-o${sell ? "sell" : "buy"}">${esc(text)}</span><small data-copy="${esc(id)}" title="Click to copy">${esc(sub)}</small></div>`
    + (busy ? "" : `<button data-oact="edit" data-kind="${kind}" data-id="${esc(id)}" data-price="${esc(price)}" aria-label="Change the price of this order">✎</button><button class="dx-ox" data-oact="cancel" data-kind="${kind}" data-id="${esc(id)}" aria-label="Cancel this order">✕</button>`) + `</div>`;
  async function orderAction(act, kind, id, price) {
    const fast = kind === "fast";
    if (act === "cancel") {
      const ok = await dialog("Cancel this order?", fast ? "FAST order " + id + "\n\nYour node signs a cancel and sends it to every relay. Nothing moves on the chain: the coins never left your wallet. A take that a maker already co-signed still settles."
        : "On-chain order, coin " + id + "\n\nYour node signs a transaction that returns the order's locked funds to your wallet. The order can still be filled until a block confirms the cancel.", "Cancel the order");
      if (!ok) return;
      const r = await drive(fast ? "cancelFast" : "cancelChain", fast ? { orderId: id } : { coinid: id });
      if (r.error) return say(r.error);
    } else {
      const next = await dialog("New price", (fast ? "FAST order " + id + "\n\nYour node signs the order again at the new price and sends it to every relay. Nothing moves on the chain."
        : "On-chain order, coin " + id + "\n\nYour node signs a transaction that moves the order to the new price. The old price can still be filled until a block confirms it.") + "\n\nMxUSD per MINIMA:", "Sign the new price", { label: "New price, MxUSD per MINIMA", value: price });
      if (next == null) return;
      if (!num(next)) return say("Enter a valid new price. Nothing was changed.", "note");
      const r = await drive(fast ? "editFast" : "editChain", fast ? { orderId: id, price: next } : { coinid: id, price: next });
      if (r.error) return say(r.error);
    }
    load().then(draw, draw);
  }

  return { init, paint, render, node: node_, _preview: (page, stub) => { Page.state = page || {}; Page.stub = stub || (() => Promise.resolve({ error: "" })); draw(); } };
})();
