/*
 * stub.js: a stand-in for window.mcd (main/preload.js) so renderer/index.html can be opened in a plain
 * browser. FIXTURE DATA ONLY: every address, id, balance, name and message below is invented. It never
 * talks to a node. Not shipped (package.json "build.files" lists main/ and renderer/ only).
 *
 * The page URL drives the state:  ?view=balances|apps|node|ethwallet|mail|...  &tray=1  &menu=1  &state=stopped  &shutdown=1
 *   Wallet: &bal=empty|fail  &expand=1  &dlg=coins[:row] | coin[:row[:coin]] | split  &coins=fail|none|nosendable  &tokens=<saved order, token ids>
 *   Send: &send=filled|review|error
 *   Any screen: &scroll=<px>
 *   Key mode: &block=1 (the node can run block keys)  &mode=block|classic  &state=refused  &pick=block|classic
 *   First run: &fr=launcher|params|seed|confirm|confirm-typing|restore|restore-any|starting
 *   Backup & Recovery: &bk=create|restore|resync|keys  &seed=1  &bkdone=1
 *   History: &hist=empty  &hmenu=1  &hdetail=<row>  &chain=checking  &hfilter=1  &hforeign=1
 *   Dexicon room 2 (view=pandapools): &pptab=swap|pools|mylp|wallet|activity  &ppf=<amount typed in Swap>  &ppdir=buy
 *     &ppdo=<selector to click>|<selector>…  &ppin=<selector>=<text>|…  (typed before the clicks)
 *     &pps=empty|notready|backup|manual|nousd|swapfail|mintfail|toobig|paused|collect|stranded|ownerkey|noacts
 */
"use strict";
(function () {
  const Q = new URLSearchParams(location.search);
  const now = Date.now();
  // the node's own format (Java Date.toString()), with a zone name JavaScript cannot parse: the shell must not need to
  const BLOCK_TIME = "Thu Jul 16 14:54:04 BST 2026";
  try { if (Q.get("order")) localStorage.setItem("shellOrder", Q.get("order")); if (Q.get("hidden")) localStorage.setItem("shellHidden", Q.get("hidden")); localStorage.removeItem("walletOrder"); localStorage.setItem("histRebuildVer", "1"); localStorage.setItem("histNormVer", "3"); localStorage.setItem("histHideForeign", Q.get("hforeign") === "1" ? "1" : "0"); if (Q.get("tokens")) localStorage.setItem("walletOrder", Q.get("tokens")); } catch (e) {}
  try { localStorage.setItem("dexicon", JSON.stringify({ tabs: { exchange: Q.get("dxtab") || "trade", pools: Q.get("pptab") || "swap" }, theme: Q.get("dx") === "light" ? "DAYLIGHT" : "ONYX" })); } catch (e) {}
  // NOT A SEED: four list words repeated, so the word boxes accept them. Nothing was ever made from these.
  const FAKE_SEED = "TEST ONLY VOID ABANDON ".repeat(6).trim();
  const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  const NFT = "0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8";
  const ADDR = "MxG085QK2T7MN4CWP9RZD3HVJ6YBA1SE0FU8G5TKX2NC7MWQ4PRD9ZH3VJ6YBA1";
  const PK = (n) => "0x" + (n + "C4E8A1F09B37D25E6A8C0F1B3D5E7A9C2E4F6081A3B5C7D9E0F2A4B6C8D0E2F4").slice(0, 64);
  // AtomiX fixtures. Every address, key and hash is whole and plainly not real (FA4E… = "fake").
  try { localStorage.setItem("dexicon_ax_market_live", Q.get("axlive") === "1" ? "1" : "0"); } catch (e) {}
  const AXS = Q.get("axs") || "", AX_MINIMA = AXS === "minima" || AXS === "idle";
  const FAKE_ETH = "0xFA4E0000FA4E0000FA4E0000FA4E0000FA4E0001", FAKE_ETH2 = "0xFA4E0000FA4E0000FA4E0000FA4E0000FA4E0002", FAKE_TX = "0x" + "FA4E00".repeat(10) + "0001";
  const FAKE_PK = (n) => "0x" + (n + "FA4E".repeat(16)).slice(0, 64);
  const AX_BOOK = { scanned: 3, makers: 2, bestBid: 0.99, bestAsk: 1.01, bidCap: 100, askCap: 100, currency: "mxusdt", label: "mxUSDT", pricingParity: true,
    bids: [{ signer: FAKE_PK("D1"), p: 0.99, cap: 100, mine: false }, { signer: FAKE_PK("A9"), p: 0.985, cap: 100, mine: true }, { signer: FAKE_PK("D2"), p: 0.98, cap: 10000, mine: false }],
    asks: [{ signer: FAKE_PK("D1"), p: 1.01, cap: 100, mine: false }, { signer: FAKE_PK("A9"), p: 1.015, cap: 100, mine: true }, { signer: FAKE_PK("D2"), p: 1.02, cap: 10000, mine: false }] };
  const AX_PLAN = (sell, amt) => { const n = Number(amt) || 0, a = Math.min(n, 100), b = Math.max(0, n - 100), p1 = sell ? 0.99 : 1.01, p2 = sell ? 0.98 : 1.02, legs = [{ maker: FAKE_PK("D1"), price: p1, minima: String(a), usdt: String(Math.floor(a * p1 * 1e6) / 1e6) }];
    if (b > 0) legs.push({ maker: FAKE_PK("D2"), price: p2, minima: String(b), usdt: String(Math.floor(b * p2 * 1e6) / 1e6) });
    const total = legs.reduce((t, l) => t + Number(l.usdt), 0); return { legs, filledMinima: n, totalUsdt: total, avgPrice: n ? total / n : 0, worstPrice: b > 0 ? p2 : p1, target: n, partial: false, stopReason: "", slippagePct: sell ? 0 : 4.2 }; };
  const axSwap = (h, role, direction, status, sa, ba, ago, vis, detail) => ({ hash: FAKE_PK(h), role, direction, status, selltoken: direction === "ERC20_TO_MINIMA" ? "USDT" : MXUSD, sellamount: sa, buytoken: direction === "ERC20_TO_MINIMA" ? MXUSD : "USDT", buyamount: ba,
    created: now - ago, updated: now - ago + 60000, counterparty: FAKE_PK("D1"), contractId: FAKE_PK("F" + h), detail, vis, lastFail: "" });
  const nowS = Math.floor(now / 1000);
  const AX_SWAPS = [
    axSwap("90", "INITIATOR", "ERC20_TO_MINIMA", "STARTED", "25", "24.752475", 240000, { blocks: false, steps: ["Locked 25 USDT on Ethereum", "Take sent to the maker"], respondBy: nowS + 900, refundAt: nowS + 6900, cur: nowS, refundOpen: false, canRefund: true, timedOut: false }, "Waiting for the maker to lock mxUSDT."),
    axSwap("92", "INITIATOR", "ERC20_TO_MINIMA", "STARTED", "40", "39.603960", 5400000, { blocks: false, steps: ["Locked 40 USDT on Ethereum", "Take sent to the maker"], respondBy: nowS - 1800, refundAt: nowS + 2280, cur: nowS, refundOpen: false, canRefund: true, timedOut: true, notice: { state: "declined", reason: "Maker wallet: too many coins, it consolidates automatically and retries." } }, "The maker did not lock. Your USDT is refunded at the deadline."),
    axSwap("93", "RESPONDER", "MINIMA_TO_ERC20", "LOCKED", "100", "99", 600000, null, "You locked 100 mxUSDT. Waiting for the taker to claim."),
    axSwap("91", "INITIATOR", "MINIMA_TO_ERC20", "COMPLETE", "50", "49.5", 86400000 + 3600000, null, "Done: received 49.5 USDT."),
    axSwap("94", "INITIATOR", "ERC20_TO_MINIMA", "REFUNDED", "10", "9.90099", 2 * 86400000, { blocks: false, steps: ["Locked 10 USDT on Ethereum"], respondBy: nowS - 170000, refundAt: nowS - 160000, cur: nowS, refundOpen: true, canRefund: false, timedOut: true, refundSent: FAKE_TX, refunded: true }, "Refunded: 10 USDT is back in your Ethereum wallet.")];
  // Dexicon fixtures: a book with FAST, BOOK and POOL rows on both sides, one level holding the user's own order
  const DXS = Q.get("dxs") || "", DX_RELAYS = ["https://relay-one.example/dex-relay", "https://relay-two.example/dex-relay"];
  const fastRow = (side, price, minima, ours) => ({ side, price, minima, ours: !!ours });
  const DX_BOOK = {
    fast: [fastRow("sell", "0.00344458", "11659"), fastRow("sell", "0.00340533", "10312"), fastRow("sell", "0.00336608", "9627"), fastRow("sell", "0.00332683", "10081"), fastRow("sell", "0.00328758", "10311"),
      fastRow("sell", "0.00324833", "9623"), fastRow("sell", "0.00323094", "1000"), fastRow("sell", "0.00320908", "9192"), fastRow("sell", "0.00316983", "6915.25"),
      fastRow("buy", "0.00313015", "7020"), fastRow("buy", "0.0031", "8800.5"), fastRow("buy", "0.00306", "9100"), fastRow("buy", "0.0029", "1250.5", true), fastRow("buy", "0.00285", "12000")],
    book: [{ side: "sell", price: "0.0039", minima: "750", ours: true }, { side: "sell", price: "0.00332683", minima: "400", ours: false }, { side: "buy", price: "0.003", minima: "1500", ours: false }],
    poolAsks: [{ price: "0.00318", minima: "812.4471" }, { price: "0.00319", minima: "1630.02" }], poolBids: [{ price: "0.00312", minima: "790.118" }, { price: "0.00311", minima: "1588.9" }],
    pools: [{ address: PK("F1"), minima: "250000", mxusd: "787.5", mine: false }, { address: PK("F2"), minima: "90000", mxusd: "283.1", mine: true }]
  };
  const DX_FILLS = [
    { role: "taker", orderId: "a81b22c9d0e47f13", side: "buy", price: "0.00316983", filled: "1200", gave: "3.803796", got: "1200", txpowid: PK("7A"), coins: [PK("C8")], maker: PK("D7"), ts: Math.floor(now / 1000) - 240, status: "settling" },
    { role: "maker", orderId: "f3a91c07d2b84e65", side: "buy", price: "0.0029", filled: "749.5", received: "749.5", paid: "2.17355", txpowid: PK("7B"), coins: [PK("C9")], taker: PK("D8"), ts: Math.floor(now / 1000) - 5400, block: 2428031, status: "done" },
    { role: "taker", orderId: "c2d4e6f8a0b1c3d5", side: "sell", price: "0.0031", filled: "300", gave: "300", got: "0.93", txpowid: PK("7C"), coins: [PK("CA")], maker: PK("D9"), ts: Math.floor(now / 1000) - 90000, status: "lost" }];
  const DX_PAGE = () => {
    const relays = DXS === "norelay" ? [] : DX_RELAYS.map((url, i) => ({ url, meta: DXS === "relaydown" ? "network" : "cursor " + (412 + i), state: DXS === "relaydown" ? "bad" : "ok", found: false }));
    if (DXS === "found") relays.push({ url: "https://relay-three.example/dex-relay", meta: "via https://relay-one.example/dex-relay", state: "unk", found: true });
    const p = { ready: true, idError: "", notice: "Live book · block 2428089", kind: "live", log: [], trading: false, relays };
    if (DXS === "taking") Object.assign(p, { trading: true, log: ["BUY 500 MINIMA @ 0.0034 (limit)", "+0.0s  Found 8 FAST orders at or better than your price", "+0.4s  Order 9c1f02ab77d3e456: built and signed, sent to the maker", "+0.4s  Waiting for the maker's co-sign…"] });
    if (DXS === "failed") Object.assign(p, { kind: "error", notice: "Take failed: the maker refused: the order's backing coin 0x6E5A7C9B1D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C is already spent",
      log: ["BUY 500 MINIMA @ 0.0034 (limit)", "+0.0s  Found 1 FAST order at or better than your price", "+6.2s  Order 9c1f02ab77d3e456: the maker refused: the order's backing coin 0x6E5A7C9B1D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C is already spent", "+6.2s  No other FAST order crosses 0.0034.", "+6.2s  Nothing was traded and no order was placed."] });
    return p;
  };
  // PandaPools fixtures (room 2). Every pool address, owner key, coin id and transaction id is whole and plainly not
  // real (FA4E… = "fake"); the amounts are invented.
  const PPS = Q.get("pps") || "";
  const ppPool = (n, m, t, fee) => ({ address: FAKE_PK("B00" + n), mxaddress: "", opk: FAKE_PK("0B" + n), oadr: FAKE_PK("0A" + n), tok: MXUSD, kmin: "1", tokName: "USDT", tokDecimals: 8, reserveM: m, reserveT: t,
    coinidM: FAKE_PK("C0" + n), coinidT: FAKE_PK("C1" + n), reserveBlock: 2428000, spot: (Number(t) / Number(m)).toFixed(8), k: "", feeGrowthPct: fee });
  const PP_POOLS = PPS === "empty" ? [] : [ppPool(1, "815250.75", "2617.77115575", "0.01960728"), ppPool(2, "42500.5", "136.89411", "0.07161174"), ppPool(3, "9000", "28.9", "0")];
  const PP_MINE = PPS === "empty" || PPS === "noacts" ? [] : [
    { address: FAKE_PK("B002"), opk: FAKE_PK("0B2"), tok: MXUSD, tokName: "USDT", tokDecimals: 8, reserveM: "42500.5", reserveT: "136.89411", value: "85001", poolPrice: "0.00322100", feesMinima: 30.4256, feesPct: 0.0716, kratio: PPS === "migrate" ? 1.91 : 1.24,
      priceMove: 2.31, il: -0.013, ageBlocks: 5120, signingStateUnverified: PPS === "paused", unresolved: false },
    { address: FAKE_PK("B009"), opk: FAKE_PK("0B9"), tok: MXUSD, signingStateUnverified: false, unresolved: true }];
  const ppAct = (type, summary, tx, mins, statusText, confirmed, failed, more) => Object.assign({ type, summary, txpowid: tx ? FAKE_PK(tx) : "", ts: now - mins * 60000, timeLabel: confirmed ? "Transaction" : "Submitted", statusText, confirmed, failed, verifiedAt: confirmed ? now - 20000 : 0 }, more || {});
  const PP_ACTS = PPS === "empty" || PPS === "noacts" ? [] : [
    ppAct("SWAP", "Sold 250 MINIMA for 0.80211 USDT", "7001", 2, "Confirming 1/3", false, false),
    ppAct("ADD", "Add to MINIMA / USDT  ·  500 MINIMA + 1.6105 USDT", "", 9, "Not sent", false, true, { failMsg: "Could not identify the input signing key." }),
    ppAct("SWAP", "Bought 3000 MINIMA for 9.66 USDT", "7002", 1500, "1686 confirmations · on-chain", true, false),
    ppAct("CREATE", "Create MINIMA / USDT pool  ·  42000 MINIMA + 135.24 USDT", "7003", 4300, "5120 confirmations · on-chain", true, false, { originalTxpowid: FAKE_PK("7009") }),
    ppAct("Pool transaction", "+12.5 MINIMA · -0.04025 USDT", "7004", 9000, "9044 confirmations · on-chain", true, false)];
  const PP_FEED = PPS === "empty" ? [] : [
    { pool: FAKE_PK("B001"), kind: "SWAP", minimaIn: true, minimaAmt: "1200", tokenAmt: "3.8402", tokenLabel: "USDT", txpowid: FAKE_PK("7101"), ts: now - 600000, statusText: "12 confirmations · on-chain", confirmed: true, verifiedAt: now - 30000 },
    { pool: FAKE_PK("B002"), kind: "ADD", minimaAmt: "500", tokenAmt: "1.6105", tokenLabel: "USDT", txpowid: FAKE_PK("7102"), ts: now - 7200000, statusText: "Confirming 2/3", confirmed: false, verifiedAt: 0 },
    { pool: FAKE_PK("B003"), kind: "CREATE", minimaAmt: "9000", tokenAmt: "28.9", tokenLabel: "USDT", txpowid: FAKE_PK("7103"), ts: now - 90000000, statusText: "1802 confirmations · on-chain", confirmed: true, verifiedAt: now - 30000 },
    { pool: FAKE_PK("B001"), kind: "SWAP", minimaAmt: "40", tokenAmt: "0.128", tokenLabel: "USDT", ts: now - 190000000, observed: true }];
  const ppQuote = (tokid, dir, amt) => { const a = Number(amt) || 0; if (PPS === "notready") return { ok: false, notReady: true }; if (PPS === "toobig" || a > 400000) return { ok: false };
    const price = 0.00321, out = dir ? a * price * 0.9948 : (a / price) * 0.9948; return { ok: true, totalIn: String(amt), totalOut: (Math.floor(out * 1e8) / 1e8).toString(), effPrice: (dir ? out / a : a / out).toFixed(10), priceImpact: "0.27", poolsUsed: 2, poolsAvailable: 3, capped: false, maxPools: 6, quoteId: 7 }; };
  const ppFail = (msg) => { throw new Error("Error invoking remote method 'mcd:pp': Error: " + msg); };
  const tok = (name, ticker) => ({ name: { name, ticker, description: "Fixture token" }, decimals: 8, scale: 0 });
  const LONG = "0x9C2B7E4D1A6F3058B2C4D6E8F0A1B3C5D7E9F1A2B4C6D8E0F2A4B6C8D0E2F4A6";
  const ZERO = "0x3E5A7C9B1D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C";
  // ?bal=empty (a wallet that holds nothing), ?bal=fail (the read failed); otherwise the full set:
  // locked amounts, an unconfirmed amount, a long token name, a zero balance, a figure past six decimals
  const balance = Q.get("bal") === "empty" ? [] : [
    { token: "Minima", tokenid: "0x00", confirmed: "1262.750000123456", unconfirmed: "0", sendable: "1250.750000123456", coins: "5", total: "1000000000" },
    { token: tok("MxUSD", "MxUSD"), tokenid: MXUSD, confirmed: "320.5", unconfirmed: "4.25", sendable: "300.5", coins: "4", total: "1000000" },
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
      if (Q.get("coins") === "nosendable" && /sendable:true/.test(c)) throw new Error("preview: the sendable read failed");
      const tid = (/tokenid:(0x[0-9A-Fa-f]+)/.exec(c) || [])[1] || "0x00", native = tid === "0x00";
      const coin = (i, amount, locked) => Object.assign({ coinid: PK("C" + i + tid.slice(2, 6)), amount: native ? amount : "0.00000000000000000000000000000000000001", tokenid: tid,
        address: locked ? PK("9F") : PK("D1"), miniaddress: locked ? "MxG08LOCKEDCONTRACTADDRESS00F1XTURE0000000000000000000000000000" : ADDR,
        storestate: true, spent: false, mmrentry: String(40 + i), created: String(2427000 + i * 97), age: String(1089 - i * 97),
        state: locked ? [{ port: 0, type: 2, data: PK("A1") }, { port: 1, type: 1, data: "2429000" }] : [], _locked: locked }, native ? {} : { tokenamount: amount });
      const set = native ? [coin(1, "600.250000123456"), coin(2, "400.5"), coin(3, "250"), coin(4, "10", true), coin(5, "2", true)]
        : tid === MXUSD ? [coin(1, "200.5"), coin(2, "100"), coin(3, "20", true), coin(4, "4.25")]
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
    restoreBackup: async () => ({ status: true, response: {} }),
    getConfig: async () => ({ setupDone: !Q.get("fr"), walletDone: !Q.get("fr"), megammrHost: "megammr.example:9001", contribute: false, network: "mainnet", basePort: 9001, nodeKind: "parlons", labels: Q.get("view") === "settings" ? { [ADDR]: "Savings (fixture)" } : {}, params: {}, heapMb: 0, openAtLogin: false, walletMode: "new" }),
    saveConfig: async (p) => Object.assign(await fixtures.getConfig(), p),
    nodeStatus: async () => status, nodeStart: async () => status, nodeStop: async () => status, nodeRestart: async () => status,
    nodeLogs: async () => ["Minima @ 19/11/2026 13:54:04 [88.7 MB] : Connected to the blockchain", "Minima @ 19/11/2026 13:54:31 [76.1 MB] : Block 2428089 received"],
    appVersion: async () => "0.0.0-preview",
    updateStatus: async () => ({ available: Q.get("update") === "1", version: "9.9.9", running: "0.0.0-preview" }),
    tokenIcon: async () => null, keyAudit: async () => null, keyReuse: async () => null,
    histGet: async () => histRows, histTokens: async () => [{ tokenid: "0x00", name: "Minima" }, { tokenid: MXUSD, name: "MxUSD" }],
    histQuery: async (f) => histRows.filter(r => (!f.search || JSON.stringify([r.counterparty, r.tokenName, r.txpowid, r.amount]).toLowerCase().includes(String(f.search).toLowerCase()))
      && (!f.direction || r.direction === f.direction || r.kind === f.direction) && (!f.token || r.tokenid === f.token)),
    histStats: async () => ({ count: histRows.length }), histAdd: async () => histRows.length, histImport: async () => ({ added: 0, refused: false }), exportCsv: async () => null, importJson: async () => null,
    mailInit: async () => ({ publicId: mailId, name: "Preview", words: "amber canal dune ember fjord grove", published: false, payaddr: ADDR }),
    mailThreads: async () => [
      mailThread(PK("11"), "Odile Varga", "Saturday market", "The stall is booked, table nine by the fountain.", 1, 12),
      mailThread(PK("22"), "Teodor Lind", "Invoice 0042", "Sent the corrected copy, same total as before.", 0, 190)],
    mailArchivedThreads: async () => [], mailOutbox: async () => [], mailSent: async () => [], mailContacts: async () => [],
    mailStatus: async () => ({ scannedTip: 2428089, lastScanMs: now - 60000, backfill: { done: true } }),
    chatInit: async () => ({ pubkey: PK("77"), name: "Preview" }),
    chatThreads: async () => [chatThread(PK("31"), "Mirela Okafor", "See you at the harbour at six.", 2, 5), chatThread(PK("32"), "Jonas Petrov", "Thanks, got it.", 0, 300)],
    chatThread: async () => [], chatStatus: async () => ({ ready: true }),
    // AtomiX, room 1 of Dexicon (main/atomix.js read models). ?axs=empty|noquote|minima|idle|halt|notready|manycoins
    axStatus: async () => ({ ready: AXS !== "notready", eth: FAKE_ETH, minimaPk: FAKE_PK("A1"), currency: AX_MINIMA ? "minima" : "mxusdt", block: 2428089, log: [],
      halt: AXS === "halt" ? { summary: "Your ETH wallet no longer matches what this node derives.", minimaMismatch: false, ethMismatch: true, orphanedPk: "", staleEth: FAKE_ETH, nodeEth: FAKE_ETH2 } : null }),
    axBook: async () => AXS === "empty" || AXS === "noquote" ? { scanned: 0, makers: 0, bestBid: 0, bestAsk: 0, bidCap: 0, askCap: 0, bids: [], asks: [], currency: "mxusdt", label: "mxUSDT", pricingParity: true } : AX_BOOK,
    axSwaps: async () => (AXS === "empty" || AXS === "idle" ? [] : AX_SWAPS),
    axWallet: async () => ({ addr: FAKE_ETH, currency: AX_MINIMA ? "minima" : "mxusdt", label: AX_MINIMA ? "Minima" : "mxUSDT",
      bals: AXS === "empty" ? { minima: "0", usdt: "0", eth: "0", ethErr: null, meta: { confirmed: "0", unconfirmed: "0", sendable: "0", coins: 0 } }
        : { minima: AX_MINIMA ? "40250.5" : "1.20135743", usdt: "217.912562", eth: "0.0425", ethErr: null, meta: { confirmed: "1.20135743", unconfirmed: "0.4", sendable: "1.20135743", coins: AXS === "manycoins" ? 61 : 7 } } }),
    axSwapPreview: async (sell, amt) => ({ mode: "sweep", sell, single: null, plan: AX_PLAN(sell, amt), label: "mxUSDT", meta: { bestPrice: sell ? 0.99 : 1.01, bestCap: 100, depth: 10100, label: "mxUSDT" } }),
    axQuote: async (sell, amt) => ({ quoteId: "q1", mode: "sweep", sell, single: null, plan: AX_PLAN(sell, amt), label: "mxUSDT", meta: {} }),
    axSwap: async () => ({ ok: 2, of: 2, hashes: [FAKE_PK("B1"), FAKE_PK("B2")] }),
    axInspect: async (h) => ["Swap " + h, "Your lock: 25 USDT on Ethereum, confirmed.", "The maker has not locked mxUSDT yet. It must answer before 14:20.", "Nothing to do: if the maker never locks, your USDT is refunded by itself after the timelock."],
    axRefundNow: async () => ({ msg: "The refund opens in 38 min. It is sent by itself then, app open or not.", opened: false }),
    axMakerCfg: async () => ({ cfg: AXS === "empty" ? {} : { pegEnable: true, step: 1, levels: 3, size: 100, bias: 0, reprice: 1, min: 5 }, manual: AXS === "empty" ? { bids: [], asks: [] } : { bids: [{ p: 0.99, a: 100 }, { p: 0.98, a: 100 }], asks: [{ p: 1.01, a: 100 }, { p: 1.02, a: 100 }] },
      state: { withdrawn: AXS === "empty" || AXS === "idle", lastMid: 1 }, lastPublishMs: AXS === "empty" ? 0 : now - 240000 }),
    axMakerPreview: async () => ({ ok: true, mid: 1, source: "Parity", fresh: true, wide: false, bids: [], asks: [] }),
    axMakerPublish: async () => ({ ok: true }), axMakerSave: async () => ({ ok: true }), axMakerWithdraw: async () => ({ ok: true }), axSwitchCurrency: async () => ({ ok: true }),
    axMarketHistory: async () => (AXS === "empty" ? { chart: [], recent: [] } : { chart: [0.992, 0.995, 1.001, 0.998, 1.004, 1.002, 1.006].map((price, i) => ({ price, createdBlock: 2427900 + i * 25 })),
      recent: [{ price: 1.006, sizeMinima: "250", status: "EXECUTED", createdBlock: 2428050 }, { price: 1.002, sizeMinima: "40", status: "OPEN", createdBlock: 2428061 }, { price: 0.998, sizeMinima: "1200", status: "REFUNDED", createdBlock: 2427990 }] }),
    axOtc: async () => (AXS === "empty" ? { board: [], deals: [], myOffer: {} } : { myOffer: { enable: true, sellSize: 500, buySize: 250 },
      board: [{ cid: FAKE_PK("C1"), mpk: FAKE_PK("C2"), eth: FAKE_ETH2, sell: 2000, buy: 750, ts: now - 90000 }, { cid: FAKE_PK("C3"), mpk: FAKE_PK("C4"), eth: FAKE_ETH2, sell: 0, buy: 5000, ts: now - 400000 }],
      deals: [{ ref: "d1", side: "SELL", amount: "300", price: "1.004", status: "PROPOSED", whoseTurn: "ME", hash: "" }, { ref: "d2", side: "BUY", amount: "120", price: "0.997", status: "COUNTERED", whoseTurn: "THEM", hash: "" },
        { ref: "d3", side: "SELL", amount: "50", price: "1.001", status: "EXECUTING", whoseTurn: "", hash: FAKE_PK("C9") }] }),
    axOtcGoLive: async () => ({ ok: true }), axOtcWithdraw: async () => ({ ok: true }), axOtcPropose: async () => ({ ok: true }), axOtcDeal: async () => ({ ok: true }),
    axCoins: async () => [{ amount: "0.8", coinid: FAKE_PK("E1") }, { amount: "0.40135743", coinid: FAKE_PK("E2") }],
    axExportSwaps: async () => AX_SWAPS.map(s => ({ hash: s.hash, role: s.role, direction: s.direction, sellToken: s.selltoken, sellAmount: s.sellamount, buyToken: s.buytoken, buyAmount: s.buyamount, counterparty: s.counterparty, status: s.status, contractId: s.contractId, created: s.created, minimaTx: "", ethTx: FAKE_TX })),
    axSendMax: async (a) => (a === "eth" ? "0.0419" : "217.912562"), axSendReview: async () => ({ fee: "0.000412" }), axSend: async () => ({ tx: FAKE_TX }), axExportKey: async () => "0x" + "FA4E".repeat(16),
    // PandaPools, room 2 of Dexicon (main/pandapools.js read models and actions)
    ppStatus: async () => ({ ready: PPS !== "notready", block: 2428089, pools: PP_POOLS.length }),
    ppPools: async () => (PPS === "notready" ? [] : PP_POOLS), ppMyPools: async () => PP_MINE, ppActivity: async () => PP_ACTS, ppFeed: async () => PP_FEED,
    ppPairInfo: async () => ({ pools: PP_POOLS.length, depth: "866751.25" }),
    ppAggregate: async () => (PP_POOLS.length ? [{ tok: MXUSD, name: "USDT", count: PP_POOLS.length, totalMinima: "866751.25", totalToken: "2783.56526575", price: "0.00321149", depth: "866751.25" }] : []),
    ppMarket: async () => ({ mid: PPS === "manual" ? 0 : 0.003178, fresh: PPS !== "manual" }), ppMarketToken: async () => ({ usdt: MXUSD }),
    ppCreateAnchor: async () => (PPS === "manual" ? null : { price: "0.003178", source: "MEXC market" }), ppCreatePreview: async (dec, x, y) => ({ ok: true, price: (Number(y) / Number(x)).toFixed(8), kmin: "5600000" }),
    ppQuote: async (t, d, a) => ppQuote(t, d, a),
    ppSwap: async () => (PPS === "swapfail" ? ppFail("Could not identify the input signing key.") : { txpowid: FAKE_PK("7001"), totalIn: "250", totalOut: "0.79833" }),
    ppWhy: async () => (PPS === "swapfail" ? { verb: "txnsign", error: "No keys found for the coin's address", at: Date.now() } : PPS === "mintfail" ? { verb: "newaddress", error: "MiniDAPP does not have WRITE permission", at: Date.now() } : null),
    ppCreate: async () => (PPS === "backup" ? ppFail("BACKUP_REQUIRED: save and verify the encrypted pool + node backup before creating another pool.") : PPS === "mintfail" ? ppFail("could not mint an owner key (grant this app write access to create pools)") : { txpowid: FAKE_PK("7005") }),
    ppDeposit: async () => ({ txpowid: FAKE_PK("7006") }), ppMigrate: async () => (PPS === "backup" ? ppFail("BACKUP_REQUIRED: save and verify the encrypted pool + node backup before migrating.") : { txpowid: FAKE_PK("7007") }), ppClose: async () => ({ txpowid: FAKE_PK("7008") }),
    ppCollect: async () => (PPS === "stranded" ? { coins: 0, foreign: 1, stranded: true } : { coins: 2, foreign: 0, cleared: true }),
    ppPendingCollect: async () => (PPS === "collect" || PPS === "stranded" ? [{ oadr: FAKE_PK("0A7"), status: PPS === "stranded" ? "STRANDED" : "PENDING", lastError: PPS === "stranded" ? "No key in this wallet signs for this address." : "" }] : []),
    ppListRetired: async () => (PPS === "empty" ? [] : [{ address: FAKE_PK("B008"), opk: FAKE_PK("0B8") }]), ppRetirePool: async () => true,
    ppRecoverSaved: async () => ({ restored: 0, total: 1, details: ["Pool " + FAKE_PK("B009") + ": the reserve coins were not found on this node or in the archive."], warn: "No transaction was signed." }),
    ppConfirmSigning: async () => true, ppCompleteBackupRequired: async () => PPS === "backup", ppArchiveSettings: async (url) => (url === undefined ? "" : true),
    ppSaveBackup: async () => ({ canceled: false, path: "/Users/preview/Documents/pandapools-full-1763560000000.ppbackup" }),
    ppLoadBackup: async (pw, node) => (node ? { canceled: false, nodePassword: "not-a-real-password", path: "/Users/preview/Documents/pandapools-node-recovery.bak" } : { canceled: false, json: JSON.stringify({ pandapools_backup: 3, pools: [{ address: FAKE_PK("B002") }, { address: FAKE_PK("B009") }] }) }),
    ppRestore: async () => ({ restored: 1, total: 2, details: ["Pool " + FAKE_PK("B002") + ": both reserves verified on this node.", "Pool " + FAKE_PK("B009") + ": the reserve coins were not found on this node or in the archive."], warn: "Owner signing stays paused until you confirm the wallet's signing state." }),
    ppStatement: async () => (PP_MINE.length ? { csv: "pool,date\n", rows: 12, pools: 1, backfilled: true } : { csv: "", rows: 0, pools: 0, backfilled: true }),
    ppConsolidationCheck: async () => (PPS === "ownerkey" ? "Nothing consolidated: your wallet holds a pool owner key that cannot sign.\n\nThe owner key " + FAKE_PK("0B2") + " has an unknown number of signatures used. Confirm the wallet's signing state in My LP first." : null),
    ewStatus: async () => ({ ready: true }),
    ewBalances: async () => ({ address: "0x4B1D9E27A6C0F3581E2D7B9A4C6E8F0A1B3D5C7E", eth: "0.0425", tokens: [
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", balance: "125.5", decimals: 6 }] }),
    ewTokens: async () => [],
    shopNewCount: async () => 0, shopMyShops: async () => [], shopOrders: async () => [], shopInit: async () => ({}),
    vestrStatus: async () => ({ ready: true }), vestrList: async () => [], vestrTokens: async () => [],
    casinoOpen: async () => ({ offers: 0, bets: 0 }),
    // Dexicon (main/dexicon.js read model). ?dxs=notready|norelay|relaydown|empty|taking|failed
    dxWork: async () => ({ ready: true, orders: [], pending: 0, takes: 0 }),
    dxStatus: async () => DXS === "notready" ? { version: "0.0.91", started: false, ready: false, restingReady: false, publicId: null, block: 0, relays: [], price: { mid: 0, ageMs: null, label: "" }, log: [] }
      : { version: "0.0.91", started: true, ready: true, restingReady: true, publicId: PK("5D"), block: 2428089, relays: DXS === "norelay" ? [] : DX_RELAYS, price: { mid: 0.00315, ageMs: 4000, label: "live", source: "MEXC" }, log: [] },
    dxBook: async () => DXS === "empty" || DXS === "norelay" ? { fast: [], book: [], poolAsks: [], poolBids: [], pools: [] } : DX_BOOK,
    dxMine: async () => ({ orders: DXS === "empty" ? [] : [{ coinid: PK("E1"), orderId: PK("E2"), sell: true, price: "0.0039", minima: "750", pending: "" }], pending: [] }),
    dxCommand: async (a) => {
      if (a.op !== "sql") return { status: true };
      if (/k IN \(/.test(a.query)) return { status: true, rows: DXS === "empty" ? [] : [
        { K: "myorders", V: JSON.stringify([{ orderId: "0xf3a91c07d2b84e65", side: "buy", price: "0.0029", amount: "2000", remaining: "1250.5", coins: [PK("C1")], address: PK("D1"), seq: 1763560000, expiry: Math.floor(now / 1000) + 79200, status: "live" }]) },
        { K: "pending_takes", V: JSON.stringify({ "0x9c1f02ab77d3e456": { order: { orderId: "0x9c1f02ab77d3e456", side: "sell", price: "0.00316983" }, plan: { filled: "500" }, sent: now - 42000 } }) },
        { K: "mm_config", V: JSON.stringify(Q.get("dxmm") === "1" ? { enabled: true, peg: true } : {}) }, { K: "mm_status", V: Q.get("dxmm") === "1" ? "6 rungs live · last reprice 14s ago" : "" },
        { K: "mm_feed", V: JSON.stringify({ line: "MEXC MINIMA/USDT mid 0.00315 · 4s old" }) },
        { K: "activity", V: JSON.stringify([
          { id: "act-0x9c1f02ab77d3e456-1", route: "FAST", role: "taker", side: "buy", amount: "500", price: "0.00316983", orderId: "0x9c1f02ab77d3e456", ts: now - 42000, stage: "SENT", sentMs: now - 42000, relays: 2 },
          { id: "act-" + PK("7A"), route: "FAST", role: "taker", side: "buy", amount: "1200", price: "0.00316983", txpowid: PK("7A"), outs: [PK("C8")], ts: now - 240000, stage: "COSIGNED", cosignMs: 2300, postBlock: 2428088, block: 2428088, tip: 2428089 },
          { id: "act-" + PK("7E"), route: "POOL", side: "sell", amount: "2442.4471", price: "0.003185", txpowid: PK("7E"), ts: now - 3600000, stage: "POSTED", postBlock: 2428060, block: 2428062, tip: 2428089 },
          { id: "act-0xc2d4e6f8a0b1c3d5-1", route: "FAST", role: "taker", side: "sell", amount: "300", price: "0.0031", orderId: "0xc2d4e6f8a0b1c3d5", ts: now - 90000000, stage: "REFUSED", reason: "the order's backing coin " + PK("6E") + " is already spent" }]) }] };
      if (/fill_/.test(a.query)) return { status: true, rows: (DXS === "empty" ? [] : DX_FILLS).map(f => ({ K: "fill_" + f.txpowid, V: JSON.stringify(f) })) };
      return { status: true, rows: [] };
    },
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
      if (view === "atomix") setTimeout(() => {   // ?axtab=market|otc|activity|assets|settings  ?axf=sell:120 (side:amount typed in "you send")  ?axdo=<selector to click>
        const tab = Q.get("axtab"); if (tab) document.querySelector('[data-dxtab="' + tab + '"]').click();
        setTimeout(() => {
          const f = (Q.get("axf") || "").split(":");
          if (f.length === 2 && el("axSend")) { el(f[0] === "sell" ? "axSellB" : "axBuyB").click(); el("axSend").value = f[1]; el("axSend").oninput(); }
          setTimeout(() => { for (const sel of (Q.get("axdo") || "").split("|").filter(Boolean)) { const n = document.querySelector(sel); if (n) n.click(); } }, 600);
        }, 400);
      }, 300);
      if (view === "pandapools") setTimeout(() => {   // ?ppf=<amount>  ?ppdir=buy  ?ppin=<selector>=<text>|…  ?ppdo=<selector>|<selector>…  (one step every 450 ms)
        if (Q.get("ppdir") === "buy" && el("ppFlip")) el("ppFlip").click();
        if (Q.get("ppf") && el("ppAmt")) { el("ppAmt").value = Q.get("ppf"); el("ppAmt").oninput(); }
        const steps = (Q.get("ppdo") || "").split("|").filter(Boolean), type = () => { for (const kv of (Q.get("ppin") || "").split("|").filter(Boolean)) { const i = kv.lastIndexOf("="), n = document.querySelector(kv.slice(0, i)); if (n) { n.value = kv.slice(i + 1); n.dispatchEvent(new Event("input", { bubbles: true })); } } };
        const step = (i) => setTimeout(() => { type(); if (i < steps.length) { const n = document.querySelector(steps[i]); if (n) n.click(); step(i + 1); } }, 450);
        step(0);
      }, 700);
      if (view === "dexicon" || view === "atomix") {
        const review = "Buying 2442.4471 MINIMA now\nEffective 0.003185 · 7.77919401 MxUSD\nBOOK 0 MINIMA / 0 MxUSD across 0 orders\nPOOL 2442.4471 MINIMA / 7.77919401 MxUSD across 2 pools\nWorst marginal 0.003190";
        DexUI._service(JSON.stringify({ origin: "service", type: "STATE", data: { ready: true, block: 2428089, identity: { address: PK("D1"), miniaddress: ADDR }, stage: "", myTrades: [],
          tape: DXS === "empty" ? [] : [{ timems: now - 600000, buy: true, size: "400", price: "0.00332683", txpowid: PK("8A") }, { timems: now - 86400000, buy: false, size: "1500", price: "0.003", txpowid: PK("8B") }] } }));
        DexUI._preview(DX_PAGE(), async (act, args) => (act === "place" && args.layer === "chain" && !args.reviewed ? { error: "", asked: review } : { error: "" }));
        setTimeout(() => {
          const f = (Q.get("dxf") || "").split(":");
          if (f.length === 3 && el("dxPrice")) { el(f[0] === "sell" ? "dxSell" : "dxBuy").click(); el("dxPrice").value = f[1]; el("dxAmount").value = f[2]; el("dxPrice").oninput(); }
          if (Q.get("dxdlg") === "1") el("dxCta2").click();
          if (Q.get("dxsub") === "1") document.querySelector('[data-sub="1"]').click();
          if (Q.get("dxfill") === "1") document.querySelector("[data-fill]").click();
          if (Q.get("dxasub") === "1") document.querySelector('[data-asub="1"]').click();
          if (Q.get("dxopen") === "1") document.querySelector('[data-asset="mxusd"]').click();
        }, 500);
      }
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
