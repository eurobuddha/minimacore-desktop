/*
 * stub.js: a stand-in for window.mcd (main/preload.js) so renderer/index.html can be opened in a plain
 * browser. FIXTURE DATA ONLY: every address, id, balance, name and message below is invented. It never
 * talks to a node. Not shipped (package.json "build.files" lists main/ and renderer/ only).
 *
 * The page URL drives the state:  ?view=balances|apps|node|ethwallet|mail|...  &tray=1  &menu=1  &state=stopped  &shutdown=1
 *   Wallet: &bal=empty|fail  &expand=1  &dlg=coins[:row] | coin[:row[:coin]] | split  &coins=fail|none  &tokens=<saved order, token ids>
 *   Send: &send=filled|review|error
 *   Any screen: &scroll=<px>
 *   Key mode: &block=1 (the node can run block keys)  &mode=block|classic  &state=refused  &pick=block|classic
 *   First run: &fr=launcher|params|seed|confirm|confirm-typing|restore|restore-any|starting
 *   Backup & Recovery: &bk=create|restore|resync|keys  &seed=1  &bkdone=1
 *   History: &hist=empty  &hmenu=1  &hdetail=<row>  &chain=checking  &hfilter=1  &hforeign=1
 */
"use strict";
(function () {
  const Q = new URLSearchParams(location.search);
  const now = Date.now();
  // the node's own format (Java Date.toString()), with a zone name JavaScript cannot parse: the shell must not need to
  const BLOCK_TIME = "Thu Jul 16 14:54:04 BST 2026";
  try { if (Q.get("order")) localStorage.setItem("shellOrder", Q.get("order")); if (Q.get("hidden")) localStorage.setItem("shellHidden", Q.get("hidden")); localStorage.removeItem("walletOrder"); localStorage.setItem("histRebuildVer", "1"); localStorage.setItem("histNormVer", "3"); localStorage.setItem("histHideForeign", Q.get("hforeign") === "1" ? "1" : "0"); if (Q.get("tokens")) localStorage.setItem("walletOrder", Q.get("tokens")); } catch (e) {}
  // NOT A SEED: four list words repeated, so the word boxes accept them. Nothing was ever made from these.
  const FAKE_SEED = "TEST ONLY VOID ABANDON ".repeat(6).trim();
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const NFT = "0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8";
  const ADDR = "MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1";
  const PK = (n) => "0x" + (n + "C4E8A1F09B37D25E6A8C0F1B3D5E7A9C2E4F6081A3B5C7D9E0F2A4B6C8D0E2F4").slice(0, 64);
  const tok = (name, ticker) => ({ name: { name, ticker, description: "Fixture token" }, decimals: 8, scale: 0 });
  const LONG = "0x9C2B7E4D1A6F3058B2C4D6E8F0A1B3C5D7E9F1A2B4C6D8E0F2A4B6C8D0E2F4A6";
  const ZERO = "0x3E5A7C9B1D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C";
  // ?bal=empty (a wallet that holds nothing), ?bal=fail (the read failed); otherwise the full set:
  // locked amounts, an unconfirmed amount, a long token name, a zero balance, a figure past six decimals
  const balance = Q.get("bal") === "empty" ? [] : [
    { token: "Minima", tokenid: "0x00", confirmed: "1262.750000123456", unconfirmed: "0", sendable: "1250.750000123456", coins: "5", total: "1000000000" },
    { token: tok("MxUSD", "MxUSD"), tokenid: MXUSD, confirmed: "320.5", unconfirmed: "4.25", sendable: "300.5", coins: "3", total: "1000000" },
    { token: tok("The Meridian Harbour Lighthouse Preservation Society Commemorative Membership Token, Second Series", "MHLPS"), tokenid: LONG, confirmed: "20", unconfirmed: "0", sendable: "0", coins: "20", total: "5000" },
    { token: tok("Quiet Ledger", "QL"), tokenid: ZERO, confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0", total: "100" },
    { token: { name: { name: "Harbour Print 7" }, decimals: 0 }, tokenid: NFT, confirmed: "1", unconfirmed: "0", sendable: "1", coins: "1", total: "1" }
  ];
  const keys = { keys: [{ publickey: PK("A1"), uses: 37, maxuses: 262144 }, { publickey: PK("B2"), uses: 12, maxuses: 262144 }], total: 2, maxuses: 37 };
  const cmds = {
    balance: () => { if (Q.get("bal") === "fail") throw new Error("preview: the balance read failed"); return balance; },
    // every relevant coin of the asked token; `sendable:true` leaves out the ones locked in a contract. ?coins=fail|none
    coins: (c) => {
      if (Q.get("coins") === "fail") throw new Error("preview: the coins read failed");
      if (Q.get("coins") === "none") return [];
      const tid = (/tokenid:(0x[0-9A-Fa-f]+)/.exec(c) || [])[1] || "0x00", native = tid === "0x00";
      const coin = (i, amount, locked) => Object.assign({ coinid: PK("C" + i + tid.slice(2, 6)), amount: native ? amount : "0.00000000000000000000000000000000000001", tokenid: tid,
        address: locked ? PK("9F") : PK("D1"), miniaddress: locked ? "MxG08LOCKEDCONTRACTADDRESS00F1XTURE0000000000000000000000000000" : ADDR,
        storestate: true, spent: false, mmrentry: String(40 + i), created: String(2427000 + i * 97), age: String(1089 - i * 97),
        state: locked ? [{ port: 0, type: 2, data: PK("A1") }, { port: 1, type: 1, data: "2429000" }] : [], _locked: locked }, native ? {} : { tokenamount: amount });
      const set = native ? [coin(1, "600.250000123456"), coin(2, "400.5"), coin(3, "250"), coin(4, "10", true), coin(5, "2", true)]
        : tid === MXUSD ? [coin(1, "200.5"), coin(2, "100"), coin(3, "20", true)]
        : tid === LONG ? Array.from({ length: 20 }, (_, i) => coin(i + 1, "1", true)) : tid === NFT ? [coin(1, "1")] : [];
      return set.filter(x => !/sendable:true/.test(c) || !x._locked).map(x => { const o = Object.assign({}, x); delete o._locked; return o; });
    },
    // Backup & Recovery. The "seed" is 24 words that are plainly not one; the backup path is invented.
    vault: () => ({ phrase: FAKE_SEED, locked: false }),
    backup: () => ({ backup: { file: "/Users/preview/Library/Application Support/minimaCore/node-data/minima-backup-20261119-135600.bak" } }),
    megammrsync: () => ({ message: "preview" }),
    checkaddress: () => ({ simple: true }),
    getaddress: () => ({ address: PK("D1"), miniaddress: ADDR }),
    keys: () => keys,
    scripts: () => [{ simple: true, address: PK("D1"), miniaddress: ADDR }, { simple: false, address: PK("9F"), miniaddress: "MxG08LOCKEDCONTRACTADDRESS00F1XTURE0000000000000000000000000000" }],
    history: () => ({ txpows: [], details: [] }),
    block: () => ({ block: "2428089" }),
    txpow: () => ({ found: true, blockid: PK("AA"), block: "2428076", tip: "2428089", confirmations: "13" }),
    peers: () => ({ peerslist: "203.0.113.24:9001,198.51.100.77:9001" }),
    network: () => ({ details: { connected: 8, p2p: { address: "192.0.2.10:9001" } }, connections: [1, 2, 3, 4, 5, 6].map(i => ({ incoming: true, host: "203.0.113." + i })).concat([{ incoming: false, host: "198.51.100.77" }, { incoming: false, host: "198.51.100.78" }]) }),
    status: () => ({ version: "1.0.45.14", chain: { block: 2428089, time: BLOCK_TIME } })
  };
  // History: ?hist=empty, else rows of every kind: received, sent, a contract counterparty, a swap, a split,
  // a consolidation, an internal transfer, a long token name, a tiny amount, a row older than a week
  const EXT = "MxG083EXTERNALCOUNTERPARTY0F1XTURE00000000000000000000000000001", CON = "MxG08LOCKEDCONTRACTADDRESS00F1XTURE0000000000000000000000000000";
  const c = (address, amount, tokenid, name) => ({ address, amount, tokenid: tokenid || "0x00", token: name ? tok(name, name) : "Minima", coinid: PK("C7"), state: [] });
  const tx = (i, mins, direction, kind, amount, tokenid, tokenName, counterparty, inputs, outputs, difference) => ({ txpowid: PK("B" + i), block: 2428089 - i * 13, time: now - mins * 60000,
    istransaction: true, isblock: false, size: 1480, burn: "0", direction, kind, tokenid, tokenName, amount, counterparty, inCount: inputs.length, outCount: outputs.length, difference, inputs, outputs, state: [] });
  const histRows = Q.get("hist") === "empty" ? [] : [
    tx(1, 31, "out", "normal", "0.000000001", "0x00", "Minima", EXT, [c(ADDR, "10")], [c(EXT, "0.000000001"), c(ADDR, "9.999999999")], { "0x00": "-0.000000001" }),
    tx(2, 64, "out", "normal", "1", MXUSD, "MxUSD", EXT, [c(ADDR, "3", MXUSD, "MxUSD")], [c(EXT, "1", MXUSD, "MxUSD"), c(ADDR, "2", MXUSD, "MxUSD")], { [MXUSD]: "-1" }),
    tx(3, 71, "in", "normal", "2.1999", MXUSD, "MxUSD", CON, [c(CON, "2.1999", MXUSD, "MxUSD")], [c(ADDR, "2.1999", MXUSD, "MxUSD")], { [MXUSD]: "2.1999" }),
    tx(4, 190, "in", "buy", "120", "0x00", "Minima", CON, [c(CON, "120"), c(ADDR, "4.8", MXUSD, "MxUSD")], [c(ADDR, "120"), c(CON, "4.8", MXUSD, "MxUSD")], { "0x00": "120", [MXUSD]: "-4.8" }),
    tx(5, 400, "self", "split", "100", "0x00", "Minima", ADDR, [c(ADDR, "100")], Array.from({ length: 10 }, () => c(ADDR, "10")), { "0x00": "0" }),
    tx(6, 1500, "self", "consolidation", "42.5", "0x00", "Minima", ADDR, Array.from({ length: 6 }, () => c(ADDR, "7.0833")), [c(ADDR, "42.5")], { "0x00": "0" }),
    tx(7, 3000, "self", "normal", "0", "0x00", "Minima", ADDR, [c(ADDR, "5")], [c(ADDR, "5")], { "0x00": "0" }),
    tx(8, 5000, "in", "normal", "3", LONG, "The Meridian Harbour Lighthouse Preservation Society Commemorative Membership Token, Second Series", EXT, [c(EXT, "3", LONG, "MHLPS")], [c(ADDR, "3", LONG, "MHLPS")], { [LONG]: "3" }),
    tx(9, 9000, "out", "normal", "0.00000000000000000000000000000000000000000001", "0x00", "Minima", CON, [c(ADDR, "1")], [c(CON, "0.00000000000000000000000000000000000000000001")], { "0x00": "-0.00000000000000000000000000000000000000000001" }),
    tx(10, 60 * 24 * 40, "in", "normal", "1000", "0x00", "Minima", EXT, [c(EXT, "1000")], [c(ADDR, "1000")], { "0x00": "1000" }),
    tx(11, 60 * 24 * 41, "in", "normal", "7", "0x00", "Minima", CON, [c(CON, "7")], [c(CON, "7")], { "0x00": "7" })   // touches no wallet address: "foreign"
  ];
  const mailId = PK("E5");
  const mailThread = (who, name, subject, message, unread, mins) => ({ other: who, hashref: PK("F" + mins), unread,
    last: { incoming: true, frompublickey: who, topublickey: mailId, fromname: name, subject, message, type: "text", timemilli: now - mins * 60000, date: now - mins * 60000 } });
  const chatThread = (pk, name, body, unread, mins) => ({ pubkey: pk, name, unread, last: { ts: now - mins * 60000, body, out: false, state: "delivered" } });
  const status = {
    state: "running", rpcPort: 9005, contribute: false, portmap: {}, parlons: { ready: false, error: "" },
    health: { version: "1.0.45.14", block: 2428089, time: BLOCK_TIME, connections: 8, incoming: 6, locked: false, megammr: false, acceptingInLinks: null, p2pAddress: "" }
  };
  const fixtures = {
    cmd: async (c) => {
      if (Q.get("chain") === "checking" && /^txpow onchain:/.test(c)) return new Promise(() => {});   // the node has not answered yet
      const f = cmds[String(c).split(" ")[0]];
      try { return f ? { status: true, response: f(String(c)) } : { status: false, error: "preview: no fixture for " + c }; }
      catch (e) { return { status: false, error: e.message }; }
    },
    clip: async () => true,
    // key mode: ?block=1 = a node that can run block keys; &mode=block|classic = the wallet's recorded mode
    keyMode: async () => ({ mode: Q.get("mode") || (Q.get("fr") ? "" : "classic"), supported: Q.get("block") === "1" }),
    recordKeyMode: async (m) => m,
    getConfig: async () => ({ setupDone: !Q.get("fr"), walletDone: !Q.get("fr"), megammrHost: "megammr.example:9001", contribute: false, network: "mainnet", basePort: 9001, nodeKind: "parlons", labels: {}, params: {}, heapMb: 0, openAtLogin: false, walletMode: "new" }),
    saveConfig: async (p) => Object.assign(await fixtures.getConfig(), p),
    nodeStatus: async () => status, nodeStart: async () => status, nodeStop: async () => status, nodeRestart: async () => status,
    nodeLogs: async () => ["Minima @ 19/11/2026 13:54:04 [88.7 MB] : Connected to the blockchain", "Minima @ 19/11/2026 13:54:31 [76.1 MB] : Block 2428089 received"],
    appVersion: async () => "0.0.0-preview",
    updateStatus: async () => ({ available: Q.get("update") === "1", version: "9.9.9", running: "0.0.0-preview" }),
    tokenIcon: async () => null, keyAudit: async () => null, keyReuse: async () => null,
    histGet: async () => histRows, histTokens: async () => [{ tokenid: "0x00", name: "Minima" }, { tokenid: MXUSD, name: "MxUSD" }],
    histQuery: async (f) => histRows.filter(r => (!f.search || JSON.stringify([r.counterparty, r.tokenName, r.txpowid, r.amount]).toLowerCase().includes(String(f.search).toLowerCase()))
      && (!f.direction || r.direction === f.direction || r.kind === f.direction) && (!f.token || r.tokenid === f.token)),
    histStats: async () => ({ count: histRows.length }), histAdd: async () => histRows.length, exportCsv: async () => null, importJson: async () => null,
    mailInit: async () => ({ publicId: mailId, name: "Preview", words: "amber canal dune ember fjord grove", published: false, payaddr: ADDR }),
    mailThreads: async () => [
      mailThread(PK("11"), "Odile Varga", "Saturday market", "The stall is booked, table nine by the fountain.", 1, 12),
      mailThread(PK("22"), "Teodor Lind", "Invoice 0042", "Sent the corrected copy, same total as before.", 0, 190)],
    mailArchivedThreads: async () => [], mailOutbox: async () => [], mailSent: async () => [], mailContacts: async () => [],
    mailStatus: async () => ({ scannedTip: 2428089, lastScanMs: now - 60000, backfill: { done: true } }),
    chatInit: async () => ({ pubkey: PK("77"), name: "Preview" }),
    chatThreads: async () => [chatThread(PK("31"), "Mirela Okafor", "See you at the harbour at six.", 2, 5), chatThread(PK("32"), "Jonas Petrov", "Thanks, got it.", 0, 300)],
    chatThread: async () => [], chatStatus: async () => ({ ready: true }),
    axSwaps: async () => [{ hash: PK("90"), status: "STARTED" }, { hash: PK("91"), status: "COMPLETE" }],
    axMakerCfg: async () => ({ cfg: { pegEnable: true }, state: { withdrawn: false } }),
    ppActivity: async () => [{ type: "Pool transaction", confirmed: false, failed: false, ts: now - 120000 }],
    ewStatus: async () => ({ ready: true }),
    ewBalances: async () => ({ address: "0x4B1D9E27A6C0F3581E2D7B9A4C6E8F0A1B3D5C7E", eth: "0.0425", tokens: [
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", balance: "125.5", decimals: 6 }] }),
    ewTokens: async () => [], ppPools: async () => [],
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
      // First run: ?fr=launcher|params|seed|confirm|confirm-typing|restore|restore-any|starting
      const fr = Q.get("fr");
      if (fr) {
        const type = (i, v) => { const b = document.querySelectorAll(".we-box")[i]; b.value = v; b.dispatchEvent(new Event("input")); };
        if (fr === "params") el("frParams").click();
        if (fr === "starting") { CFG.walletMode = "new"; showStarting(); }
        if (fr === "seed" || fr.startsWith("confirm")) postBootNewSeed().then(() => { if (fr !== "seed") el("frSaved").click();
          if (fr === "confirm-typing") { "test only void abandon test only void".split(" ").forEach((w, i) => type(i, w)); type(8, "zzq"); type(9, "ab"); } });
        if (fr.startsWith("restore")) { el("frRestore").click(); if (fr === "restore-any") document.querySelector('[data-we="any"]').click();
          if (Q.get("pick")) document.querySelector('.modeq [data-mode="' + Q.get("pick") + '"]').click(); }
        if (Q.get("scroll")) setTimeout(() => { el("setupBody").scrollTop = parseInt(Q.get("scroll"), 10); }, 500);
        return;
      }
      const view = Q.get("view");
      if (view && view !== "balances") selectTab(view);
      if (Q.get("tray") === "1") setTray(true, true);
      if (Q.get("tray") === "0") setTray(false, true);
      if (Q.get("mode")) onStatus(Object.assign({}, status, { keyMode: Q.get("mode") }));
      if (Q.get("state") === "stopped") onStatus(Object.assign({}, status, { state: "stopped", health: null }));
      if (Q.get("state") === "refused") onStatus(Object.assign({}, status, { state: "error", health: null, keyMode: "block", lastError: "This wallet uses block key uses, and the node in this version of the app cannot run it. The node was not started, because starting it here would add classic keys to the wallet for good. Install the newer version of the app this wallet was made with." }));
      if (Q.get("shutdown") === "1") menuAction("shutdown");
      if (Q.get("expand") === "1") el("walHead").click();
      // History: ?hmenu=1 opens its options, ?hdetail=<n> the n-th row's detail (&chain=checking: no answer yet), ?hfilter=1 the filter, ?hforeign=1 hides foreign rows
      if (view === "history") setTimeout(() => {
        if (Q.get("hfilter") === "1") histMenuAction("filter");
        if (Q.get("hmenu") === "1") { el("histMenuBtn").click(); document.activeElement.blur(); }
        if (Q.get("hdetail")) document.querySelectorAll(".hrow")[parseInt(Q.get("hdetail"), 10) - 1].click();
      }, 600);
      // ?send=filled|review|error fills the Send form, opens its review, or shows what a pasted address with extra parameters gets
      if (Q.get("send")) setTimeout(() => {
        el("sTok").value = MXUSD; el("sTok").onchange(); el("sAmt").value = "25.5";
        el("sTo").value = ADDR + (Q.get("send") === "error" ? " burn:100" : ""); el("sTo").oninput();
        if (Q.get("send") === "review") el("sGo").click();
        if (Q.get("send") === "error") setTimeout(() => el("sGo").click(), 2400);   // late, so the message is still up when the capture is taken
      }, 250);
      // ?dlg=coins[:n] opens the coins dialog of the n-th token row; ?dlg=coin[:n] goes on to its first coin; ?dlg=split
      const dlg = (Q.get("dlg") || "").split(":");
      if (dlg[0]) setTimeout(() => {
        document.querySelectorAll(".balrow")[parseInt(dlg[1], 10) || 0].click();
        setTimeout(() => { if (dlg[0] === "coin") document.querySelector(".coin-row" + (dlg[2] ? ":nth-child(" + dlg[2] + ")" : "")).click(); if (dlg[0] === "split") el("coinsSplit").click(); }, 250);
      }, 250);
      // Backup & Recovery: ?view=backup&bk=create|restore|resync|keys, &seed=1 shows the (fake) seed, &bkdone=1 a finished backup
      if (view === "backup" && Q.get("bk")) { bkOpen(Q.get("bk")); if (Q.get("seed") === "1") el("bkShow").click();
        if (Q.get("bkdone") === "1") { el("bkPw").value = el("bkPw2").value = "preview1"; el("bkGo").click(); } }
      if (Q.get("scroll")) setTimeout(() => { el("main").scrollTop = parseInt(Q.get("scroll"), 10); }, 500);
      if (Q.get("menu") === "1") { openMenu(); document.activeElement.blur(); }
    } catch (e) { document.title = "PREVIEW ERROR " + e.message; console.error(e); }
  }, 300));
  window.addEventListener("error", (e) => console.error("PREVIEW", e.message, e.filename, e.lineno));
})();
