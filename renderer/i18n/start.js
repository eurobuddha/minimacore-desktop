// The language to start in: the one saved by the main process (window.mcd.lang, read by the preload), else the
// system's when it is one of the four, else English. Runs after the catalogs and before every screen script, so a
// table built while a script loads is already in that language; then the page's own fixed text is set.
(function () {
  "use strict";
  // The fixed text of index.html: [selector, attribute ("" = the element's text), the English as it stands in the page].
  // scripts/i18n-test.cjs checks each English against the page, so the two cannot drift apart.
  I18N.PAGE.push(
    ["#tray", "aria-label", N_("Apps")], ["#trayBtn", "aria-label", N_("Apps")], ["#backBtn", "aria-label", N_("Back")], ["#setupBack", "aria-label", N_("Back")],
    ["#moreBtn", "aria-label", N_("More")], ["#moreMenu", "aria-label", N_("More")],
    ['#moreMenu [data-act="logs"]', "", N_("Logs")], ['#moreMenu [data-act="terminal"]', "", N_("Terminal")], ['#moreMenu [data-act="backup"]', "", N_("Backup & Recovery")],
    ['#moreMenu [data-act="params"]', "", N_("Startup Params")], ['#moreMenu [data-act="shutdown"]', "", N_("Shutdown")], ['#moreMenu [data-act="settings"]', "", N_("Settings")],
    ['.tab[data-tab="wallet"] .tab__l', "", N_("Wallet")], ['.tab[data-tab="history"] .tab__l', "", N_("History")], ['.tab[data-tab="apps"] .tab__l', "", N_("Apps")],
    ['.tab[data-tab="chat"] .tab__l', "", N_("Chat")], ['.tab[data-tab="node"] .tab__l', "", N_("Node")],
    ["#stopBar > span", "", N_("The node is stopped. Balances, swaps, pools, mail and chat are offline until it starts.")], ["#stopStart", "", N_("Start node")],
    ["#walHead > span", "", N_("Total balance")], ["#walSend", "", N_("Send")], ["#walReceive", "", N_("Receive")], [".wal-eyebrow", "", N_("Tokens")],
    [".recv > .eyebrow", "", N_("Scan to receive")], ["#recvCopy", "", N_("Copy")], ["#recvGet", "", N_("Get Address")],
    [".hist-title", "", N_("Minima History")], ["#histSync", "", N_("⟳ Sync")], ["#histMenuBtn", "aria-label", N_("History options")], ["#histMenu", "aria-label", N_("History options")],
    ['[data-hact="json"]', "", N_("Export as JSON (backup)")], ['[data-hact="csv"]', "", N_("Export as CSV (spreadsheet)")], ['[data-hact="import"]', "", N_("Import history (restore / merge)")],
    ['[data-hact="foreign"]', "", N_("Hide foreign contract activity")], ['[data-hact="filter"]', "", N_("Filter by direction and token")], ['[data-hact="copy"]', "", N_("Copy the listed rows")],
    ["#histSearch", "placeholder", N_("Search address, id, token, amount…")], ["#histSearch", "aria-label", N_("Search history")],
    ["#termCopy", "", N_("Copy output")], ["#termClear", "", N_("Clear")], [".term-warn", "", N_("Commands run against your live node immediately. There is no confirmation step.")],
    ["#termIn", "placeholder", N_("Enter command")], ["#termIn", "aria-label", N_("Node command")], ["#termRun", "", N_("Run")],
    ["#logsPause", "", N_("Pause")], ["#logsClear", "", N_("Clear")], ["#logsSave", "", N_("Save to file")], ["#logsFilter", "placeholder", N_("Filter")], ["#logsFilter", "aria-label", N_("Filter the log")],
    ["#logsChips", "aria-label", N_("What the node logs")], [".apps-help", "", N_("Hide takes an app out of the app drawer. Freeze also stops its background work until you turn it back on; nothing it holds is lost.")],
    ["#view-node > .home-eyebrow", "", N_("Log")]
  );
  const saved = window.mcd && window.mcd.lang;
  I18N.set(typeof saved === "string" && I18N.supported(saved) ? saved : I18N.pick(typeof navigator !== "undefined" && navigator.language));
  I18N.apply(document);
})();
