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
    api.onDexicon(() => { if (shown()) refresh(); });
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
  function node_(s) { node = s || { state: "" }; if (opts) paintStrip(); }

  async function refresh() {
    try { st = await api.dxStatus(); } catch (e) { st = null; }
    paintStrip();
    if ($("shell").dataset.tab === "dexicon" && C.ROOMS[mem.room].view === "dexicon") render();
  }

  // ---- room 3, Exchange ----
  function render() {
    const body = $("dxBody"); if (!body) return;
    const s = C.strip(node.state, st);
    body.innerHTML = `<div class="dx-card"><div class="dx-note"><b>${esc(C.TAB_LABEL[C.tabOf(mem)])}</b><br>${esc(s.text)}</div></div>`;
  }

  return { init, paint, render, node: node_ };
})();
