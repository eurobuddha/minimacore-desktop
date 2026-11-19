/*
 * stub.js: a stand-in for window.mcd (main/preload.js) so renderer/index.html can be opened in a plain
 * browser. FIXTURE DATA ONLY: every address, id, balance, name and message below is invented. It never
 * talks to a node. Not shipped (package.json "build.files" lists main/ and renderer/ only).
 *
 * The page URL drives the state:  ?view=balances|apps|node|ethwallet|mail|...  &tray=1  &menu=1
 */
"use strict";
(function () {
  const Q = new URLSearchParams(location.search);
  const now = Date.now();
  try { if (Q.get("order")) localStorage.setItem("shellOrder", Q.get("order")); if (Q.get("hidden")) localStorage.setItem("shellHidden", Q.get("hidden")); } catch (e) {}
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const NFT = "0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8";
  const ADDR = "MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1";
  const PK = (n) => "0x" + (n + "C4E8A1F09B37D25E6A8C0F1B3D5E7A9C2E4F6081A3B5C7D9E0F2A4B6C8D0E2F4").slice(0, 64);
  const tok = (name, ticker) => ({ name: { name, ticker, description: "Fixture token" }, decimals: 8, scale: 0 });
  const balance = [
    { token: "Minima", tokenid: "0x00", confirmed: "1250.75", unconfirmed: "0", sendable: "1250.75", coins: "4", total: "1000000000" },
    { token: tok("MxUSD", "MxUSD"), tokenid: MXUSD, confirmed: "320.5", unconfirmed: "0", sendable: "300.5", coins: "3", total: "1000000" },
    { token: { name: { name: "Harbour Print 7" }, decimals: 0 }, tokenid: NFT, confirmed: "1", unconfirmed: "0", sendable: "1", coins: "1", total: "1" }
  ];
  const keys = { keys: [{ publickey: PK("A1"), uses: 37, maxuses: 262144 }, { publickey: PK("B2"), uses: 12, maxuses: 262144 }], total: 2, maxuses: 37 };
  const cmds = {
    balance: () => balance,
    coins: () => [1, 2, 3, 4].map(i => ({ coinid: PK("C" + i), amount: "312.6875", tokenid: "0x00", address: PK("D1"), miniaddress: ADDR })),
    getaddress: () => ({ address: PK("D1"), miniaddress: ADDR }),
    newaddress: () => ({ address: PK("D2"), miniaddress: ADDR }),
    keys: () => keys,
    scripts: () => [],
    peers: () => ({ peerslist: "203.0.113.24:9001,198.51.100.77:9001" }),
    status: () => ({ version: "1.0.45.14", chain: { block: 2428089, time: new Date(now - 41000).toString() } })
  };
  const mailId = PK("E5");
  const mailThread = (who, name, subject, message, unread, mins) => ({ other: who, hashref: PK("F" + mins), unread,
    last: { incoming: true, frompublickey: who, topublickey: mailId, fromname: name, subject, message, type: "text", timemilli: now - mins * 60000, date: now - mins * 60000 } });
  const chatThread = (pk, name, body, unread, mins) => ({ pubkey: pk, name, unread, last: { ts: now - mins * 60000, body, out: false, state: "delivered" } });
  const status = {
    state: "running", rpcPort: 9005, contribute: false, portmap: {}, parlons: { ready: false, error: "" },
    health: { version: "1.0.45.14", block: 2428089, time: new Date(now - 41000).toString(), connections: 8, incoming: 6, locked: false, megammr: false, acceptingInLinks: null, p2pAddress: "" }
  };
  const fixtures = {
    cmd: async (c) => { const f = cmds[String(c).split(" ")[0]]; return f ? { status: true, response: f() } : { status: false, error: "preview: no fixture for " + c }; },
    clip: async () => true,
    getConfig: async () => ({ setupDone: true, walletDone: true, network: "mainnet", basePort: 9001, nodeKind: "parlons", labels: {}, params: {}, megammrHost: "megammr.example:9001", heapMb: 0, openAtLogin: false, walletMode: "new" }),
    saveConfig: async (p) => Object.assign(await fixtures.getConfig(), p),
    nodeStatus: async () => status, nodeStart: async () => status, nodeStop: async () => status, nodeRestart: async () => status,
    nodeLogs: async () => ["Minima @ 19/11/2026 13:54:04 [88.7 MB] : Connected to the blockchain", "Minima @ 19/11/2026 13:54:31 [76.1 MB] : Block 2428089 received"],
    appVersion: async () => "0.0.0-preview",
    updateStatus: async () => ({ available: Q.get("update") === "1", version: "9.9.9", running: "0.0.0-preview" }),
    tokenIcon: async () => null, keyAudit: async () => null, keyReuse: async () => null,
    histGet: async () => [], histQuery: async () => ({ rows: [], total: 0 }), histTokens: async () => [], histStats: async () => ({ count: 0 }),
    mailInit: async () => ({ publicId: mailId, name: "Preview", words: "amber canal dune ember fjord grove", published: false, payaddr: ADDR }),
    mailThreads: async () => [
      mailThread(PK("11"), "Odile Varga", "Saturday market", "The stall is booked, table nine by the fountain.", 1, 12),
      mailThread(PK("22"), "Teodor Lind", "Invoice 0042", "Sent the corrected copy, same total as before.", 0, 190)],
    mailArchivedThreads: async () => [], mailOutbox: async () => [], mailSent: async () => [], mailContacts: async () => [],
    mailStatus: async () => ({ scannedTip: 2428089, lastScanMs: now - 60000, backfill: { done: true } }),
    chatInit: async () => ({ pubkey: PK("77"), name: "Preview" }),
    chatThreads: async () => [chatThread(PK("31"), "Mirela Okafor", "See you at the harbour at six.", 2, 5), chatThread(PK("32"), "Jonas Petrov", "Thanks, got it.", 0, 300)],
    chatThread: async () => [], chatStatus: async () => ({ ready: true }),
    ewStatus: async () => ({ ready: true }),
    ewBalances: async () => ({ address: "0x4B1D9E27A6C0F3581E2D7B9A4C6E8F0A1B3D5C7E", eth: "0.0425", tokens: [
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", balance: "125.5", decimals: 6 }] }),
    ewTokens: async () => [],
    shopNewCount: async () => 0, shopMyShops: async () => [], shopOrders: async () => [], shopInit: async () => ({}),
    vestrStatus: async () => ({ ready: true }), vestrList: async () => [], vestrTokens: async () => [],
    casinoOpen: async () => ({ offers: 0, bets: 0 }),
    parlonsStatus: async () => ({ ready: false }), portmapStatus: async () => ({})
  };
  // Anything not listed: an "on…" subscription is a no-op that returns its unsubscribe; any other call
  // resolves to null, and the view shows whatever it shows for "nothing came back".
  window.mcd = new Proxy(fixtures, { get: (t, k) => t[k] || (String(k).startsWith("on") ? () => () => {} : async () => null) });

  // Drive the shell to the requested state once app.js has booted.
  window.addEventListener("load", () => setTimeout(() => {
    try {
      const view = Q.get("view");
      if (view && view !== "balances") selectTab(view);
      if (Q.get("tray") === "1") setTray(true, true);
      if (Q.get("tray") === "0") setTray(false, true);
      if (Q.get("menu") === "1") { openMenu(); document.activeElement.blur(); }
    } catch (e) { document.title = "PREVIEW ERROR " + e.message; console.error(e); }
  }, 300));
  window.addEventListener("error", (e) => console.error("PREVIEW", e.message, e.filename, e.lineno));
})();
