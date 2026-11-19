/*
 * dexicon-core.js: the Dexicon screens' logic with no DOM in it, so scripts/dexicon-ui.test.cjs can run it in node.
 * In the page it is window.DexCore (renderer/dexicon-ui.js draws with it).
 *
 * The reference is the Android client (apks/dexicon MainActivity.java): three rooms, a bottom tab bar per room,
 * each room remembering its last tab, Dexicon's own light / dark theme (Design.java ONYX / DAYLIGHT).
 */
(function (root, factory) { const m = factory(); if (typeof module === "object" && module.exports) module.exports = m; else root.DexCore = m; })(this, function () {
  "use strict";

  // Rooms 1 and 2 are the existing desktop AtomiX and Pools panels until phases 3c / 3d: those panels bring their
  // own tab bars, so the Dexicon bottom bar has no tabs for them yet (never a tab that does nothing).
  const ROOMS = [
    { id: "mxusd", n: "①", label: "MxUSD", view: "atomix", tabs: [] },
    { id: "pools", n: "②", label: "Pools", view: "pandapools", tabs: [] },
    { id: "exchange", n: "③", label: "Exchange", view: "dexicon", tabs: ["trade", "orders", "history", "activity", "assets", "settings"] }
  ];
  const TAB_LABEL = { trade: "Trade", orders: "Orders", history: "History", activity: "Activity", assets: "Assets", settings: "Settings" };
  const roomOfView = (view) => ROOMS.findIndex(r => r.view === view);

  /** The saved choices: the last tab of each room and the theme. The room itself is not saved: Dexicon opens on ①. */
  function load(raw) {
    let o = {}; try { o = JSON.parse(raw || "{}") || {}; } catch (e) { o = {}; }
    const mem = { room: 0, tabs: {}, theme: o.theme === "DAYLIGHT" ? "DAYLIGHT" : "ONYX" };
    for (const r of ROOMS) mem.tabs[r.id] = r.tabs.includes(o.tabs && o.tabs[r.id]) ? o.tabs[r.id] : (r.tabs[0] || "");
    return mem;
  }
  const save = (mem) => JSON.stringify({ tabs: mem.tabs, theme: mem.theme });
  function pickRoom(mem, i) { if (ROOMS[i]) mem.room = i; return mem; }
  /** A tab of the CURRENT room; a tab the room does not have changes nothing. */
  function pickTab(mem, tab) { const r = ROOMS[mem.room]; if (r.tabs.includes(tab)) mem.tabs[r.id] = tab; return mem; }
  const tabOf = (mem) => mem.tabs[ROOMS[mem.room].id];
  const toggleTheme = (mem) => { mem.theme = mem.theme === "ONYX" ? "DAYLIGHT" : "ONYX"; return mem; };

  /** The status strip (MainActivity pairPill): the node, then the engine. tone: "ok" | "dim". */
  function strip(nodeState, st) {
    if (nodeState !== "running") return { text: nodeState === "stopped" ? "NODE STOPPED" : "NODE STARTING…", tone: "dim" };
    if (!st || !st.started || !st.ready) return { text: "PAIRED · starting Dexicon", tone: "dim" };
    if (!st.restingReady) return { text: "PAIRED · reading the chain", tone: "ok" };
    return { text: "PAIRED", tone: "ok" };
  }

  return { ROOMS, TAB_LABEL, roomOfView, load, save, pickRoom, pickTab, tabOf, toggleTheme, strip };
});
