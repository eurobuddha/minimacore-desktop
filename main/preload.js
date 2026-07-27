/*
 * preload.js — the ONLY bridge between the sandboxed renderer and the main process.
 *
 * Exposes a minimal, explicit API on window.mcd. The renderer can run node commands (routed through the
 * main-process RPC proxy — it never learns the RPC password or the port), read/save config, drive the node
 * lifecycle, and subscribe to status/log pushes. contextIsolation is on; no Node globals leak.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mcd", {
  // node command over RPC → { status, response } (same shape the Android NodeApi consumes)
  cmd: (command) => ipcRenderer.invoke("mcd:cmd", command),

  // reliable clipboard write via the MAIN process (the renderer's navigator.clipboard silently rejects when the
  // window isn't focused, leaving stale data on the clipboard while the UI still says "Copied"). Returns true on ok.
  clip: (text) => ipcRenderer.invoke("mcd:clip", text),

  // config
  getConfig: () => ipcRenderer.invoke("mcd:getConfig"),
  saveConfig: (patch) => ipcRenderer.invoke("mcd:saveConfig", patch),
  defaultDataFolder: () => ipcRenderer.invoke("mcd:defaultDataFolder"),
  pickFolder: () => ipcRenderer.invoke("mcd:pickFolder"),

  // node lifecycle
  nodeStatus: () => ipcRenderer.invoke("mcd:nodeStatus"),
  nodeStart: () => ipcRenderer.invoke("mcd:nodeStart"),
  nodeStop: () => ipcRenderer.invoke("mcd:nodeStop"),
  nodeRestart: () => ipcRenderer.invoke("mcd:nodeRestart"),
  nodeLogs: () => ipcRenderer.invoke("mcd:nodeLogs"),
  portmapStatus: () => ipcRenderer.invoke("mcd:portmapStatus"),

  // jar updater
  checkJarUpdate: () => ipcRenderer.invoke("mcd:checkJarUpdate"),
  applyJarUpdate: (rel) => ipcRenderer.invoke("mcd:applyJarUpdate", rel),

  // token icons (SSRF-guarded main-process fetch → data: URI) — CSP blocks remote fetch in the renderer
  tokenIcon: (url) => ipcRenderer.invoke("mcd:tokenIcon", url),

  // KeyUses reuse audit (host-pinned eurobuddha.com main-process fetch; null if unreachable)
  keyAudit: (pubkeys) => ipcRenderer.invoke("mcd:keyAudit", pubkeys),
  keyReuse: (addrs) => ipcRenderer.invoke("mcd:keyReuse", addrs),

  // local transaction-history DB (SQLite; our own source of truth — survives node pruning + restarts)
  histGet: (limit) => ipcRenderer.invoke("mcd:histGet", limit),
  histAdd: (rows) => ipcRenderer.invoke("mcd:histAdd", rows),
  histClear: () => ipcRenderer.invoke("mcd:histClear"),
  histQuery: (filters) => ipcRenderer.invoke("mcd:histQuery", filters),
  histTokens: () => ipcRenderer.invoke("mcd:histTokens"),
  histStats: () => ipcRenderer.invoke("mcd:histStats"),

  // save a CSV via a native save dialog → written path or null
  exportCsv: (text, name) => ipcRenderer.invoke("mcd:exportCsv", text, name),

  appVersion: () => ipcRenderer.invoke("mcd:appVersion"),

  // faucet requester (main-process HTTPS GET → { status, message })
  faucet: (address) => ipcRenderer.invoke("mcd:faucet", address),

  // minimaMail (on-chain encrypted messaging; keys stay in main)
  mailInit: () => ipcRenderer.invoke("mcd:mailInit"),
  mailIdentity: () => ipcRenderer.invoke("mcd:mailIdentity"),
  mailSetName: (n) => ipcRenderer.invoke("mcd:mailSetName", n),
  mailShare: () => ipcRenderer.invoke("mcd:mailShare"),
  mailThreads: () => ipcRenderer.invoke("mcd:mailThreads"),
  mailThread: (h) => ipcRenderer.invoke("mcd:mailThread", h),
  mailThreadWith: (peer) => ipcRenderer.invoke("mcd:mailThreadWith", peer),
  mailSend: (to, base) => ipcRenderer.invoke("mcd:mailSend", to, base),
  mailPay: (to, payaddr, amount, tokenid, tokenname, memo) => ipcRenderer.invoke("mcd:mailPay", to, payaddr, amount, tokenid, tokenname, memo),
  mailRequestPayaddr: (peer) => ipcRenderer.invoke("mcd:mailRequestPayaddr", peer),
  mailResolvePayaddr: (peer) => ipcRenderer.invoke("mcd:mailResolvePayaddr", peer),
  mailReceivingAddr: () => ipcRenderer.invoke("mcd:mailReceivingAddr"),
  mailContacts: () => ipcRenderer.invoke("mcd:mailContacts"),
  mailAddContact: (share, name) => ipcRenderer.invoke("mcd:mailAddContact", share, name),
  mailRenameContact: (peer, name) => ipcRenderer.invoke("mcd:mailRenameContact", peer, name),
  mailRemoveContact: (peer) => ipcRenderer.invoke("mcd:mailRemoveContact", peer),
  mailDeleteThread: (hashref) => ipcRenderer.invoke("mcd:mailDeleteThread", hashref),
  mailArchivedThreads: () => ipcRenderer.invoke("mcd:mailArchivedThreads"),
  mailSetArchived: (hashref, on) => ipcRenderer.invoke("mcd:mailSetArchived", hashref, on),
  mailExportBackup: (passphrase) => ipcRenderer.invoke("mcd:mailExportBackup", passphrase),
  mailImportBackup: (passphrase) => ipcRenderer.invoke("mcd:mailImportBackup", passphrase),
  mailScan: () => ipcRenderer.invoke("mcd:mailScan"),
  mailInvalidate: () => ipcRenderer.invoke("mcd:mailInvalidate"),
  onMail: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:mail", h); return () => ipcRenderer.removeListener("mcd:mail", h); },

  // miniMall (shop / studio / orders)
  shopInit: () => ipcRenderer.invoke("mcd:shopInit"),
  shopVendorCard: () => ipcRenderer.invoke("mcd:shopVendorCard"),
  shopMyShops: () => ipcRenderer.invoke("mcd:shopMyShops"),
  shopSave: (cfg) => ipcRenderer.invoke("mcd:shopSave", cfg),
  shopDelete: (shopId) => ipcRenderer.invoke("mcd:shopDelete", shopId),
  shopOrders: () => ipcRenderer.invoke("mcd:shopOrders"),
  shopOrder: (ref) => ipcRenderer.invoke("mcd:shopOrder", ref),
  shopNewCount: () => ipcRenderer.invoke("mcd:shopNewCount"),
  shopPlaceOrder: (shopCfg, items, total, shipping, delivery, note) => ipcRenderer.invoke("mcd:shopPlaceOrder", shopCfg, items, total, shipping, delivery, note),
  shopRetryPay: (ref) => ipcRenderer.invoke("mcd:shopRetryPay", ref),
  shopAdvance: (ref, status) => ipcRenderer.invoke("mcd:shopAdvance", ref, status),
  shopReply: (ref, text) => ipcRenderer.invoke("mcd:shopReply", ref, text),
  shopScan: () => ipcRenderer.invoke("mcd:shopScan"),
  shopInvalidate: () => ipcRenderer.invoke("mcd:shopInvalidate"),
  shopExport: (json, name) => ipcRenderer.invoke("mcd:shopExport", json, name),
  shopImport: () => ipcRenderer.invoke("mcd:shopImport"),
  onShop: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:shop", h); return () => ipcRenderer.removeListener("mcd:shop", h); },

  // PandaPools (AMM)
  ppPools: () => ipcRenderer.invoke("mcd:ppPools"),
  ppMyPools: () => ipcRenderer.invoke("mcd:ppMyPools"),
  ppActivity: () => ipcRenderer.invoke("mcd:ppActivity"),
  ppFeed: () => ipcRenderer.invoke("mcd:ppFeed"),
  ppScan: () => ipcRenderer.invoke("mcd:ppScan"),
  ppQuote: (tok, minimaToToken, amount) => ipcRenderer.invoke("mcd:ppQuote", tok, minimaToToken, amount),
  ppPairInfo: (tok) => ipcRenderer.invoke("mcd:ppPairInfo", tok),
  ppAggregate: () => ipcRenderer.invoke("mcd:ppAggregate"),
  ppSwap: (quoteId) => ipcRenderer.invoke("mcd:ppSwap", quoteId),
  ppCreate: (tok, dec, x0, y0) => ipcRenderer.invoke("mcd:ppCreate", tok, dec, x0, y0),
  ppCreatePreview: (dec, x0, y0) => ipcRenderer.invoke("mcd:ppCreatePreview", dec, x0, y0),
  ppMarket: () => ipcRenderer.invoke("mcd:ppMarket"),
  ppCreateAnchor: () => ipcRenderer.invoke("mcd:ppCreateAnchor"),
  ppMarketToken: () => ipcRenderer.invoke("mcd:ppMarketToken"),
  ppDeposit: (addr, addM, addT) => ipcRenderer.invoke("mcd:ppDeposit", addr, addM, addT),
  ppClose: (addr) => ipcRenderer.invoke("mcd:ppClose", addr),
  ppMigrate: (addr, x0, y0) => ipcRenderer.invoke("mcd:ppMigrate", addr, x0, y0),
  ppCollect: () => ipcRenderer.invoke("mcd:ppCollect"),
  ppInvalidate: () => ipcRenderer.invoke("mcd:ppInvalidate"),
  ppBackup: () => ipcRenderer.invoke("mcd:ppBackup"),
  ppRestore: (json) => ipcRenderer.invoke("mcd:ppRestore", json),
  ppSaveBackup: (json) => ipcRenderer.invoke("mcd:ppSaveBackup", json),
  ppLoadBackup: () => ipcRenderer.invoke("mcd:ppLoadBackup"),
  onPandapools: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:pandapools", h); return () => ipcRenderer.removeListener("mcd:pandapools", h); },

  // AtomiX (atomic swaps)
  axStatus: () => ipcRenderer.invoke("mcd:axStatus"),
  axBook: () => ipcRenderer.invoke("mcd:axBook"),
  axQuote: (sell, amount, slip) => ipcRenderer.invoke("mcd:axQuote", sell, amount, slip),
  axSwapPreview: (sell, amount, slip) => ipcRenderer.invoke("mcd:axSwapPreview", sell, amount, slip),
  axSwap: (quoteId) => ipcRenderer.invoke("mcd:axSwap", quoteId),
  axSwaps: () => ipcRenderer.invoke("mcd:axSwaps"),
  axExportSwaps: () => ipcRenderer.invoke("mcd:axExportSwaps"),
  axInspect: (hash) => ipcRenderer.invoke("mcd:axInspect", hash),
  axMarketHistory: () => ipcRenderer.invoke("mcd:axMarketHistory"),
  axWallet: () => ipcRenderer.invoke("mcd:axWallet"),
  axExportKey: () => ipcRenderer.invoke("mcd:axExportKey"),
  axCoins: () => ipcRenderer.invoke("mcd:axCoins"),
  axSendMax: (asset) => ipcRenderer.invoke("mcd:axSendMax", asset),
  axSendReview: (asset, to, amt) => ipcRenderer.invoke("mcd:axSendReview", asset, to, amt),
  axSend: (asset, to, amt) => ipcRenderer.invoke("mcd:axSend", asset, to, amt),
  axMakerCfg: () => ipcRenderer.invoke("mcd:axMakerCfg"),
  axMakerPreview: (cfg, manual) => ipcRenderer.invoke("mcd:axMakerPreview", cfg, manual),
  axMakerSave: (cfg, manual) => ipcRenderer.invoke("mcd:axMakerSave", cfg, manual),
  axMakerPublish: () => ipcRenderer.invoke("mcd:axMakerPublish"),
  axMakerWithdraw: () => ipcRenderer.invoke("mcd:axMakerWithdraw"),
  axSwitchCurrency: (key) => ipcRenderer.invoke("mcd:axSwitchCurrency", key),
  axOtc: () => ipcRenderer.invoke("mcd:axOtc"),
  axOtcGoLive: (sell, buy) => ipcRenderer.invoke("mcd:axOtcGoLive", sell, buy),
  axOtcWithdraw: () => ipcRenderer.invoke("mcd:axOtcWithdraw"),
  axOtcPropose: (lp, side, amount, price) => ipcRenderer.invoke("mcd:axOtcPropose", lp, side, amount, price),
  axOtcDeal: (ref, action, amount, price) => ipcRenderer.invoke("mcd:axOtcDeal", ref, action, amount, price),
  axInvalidate: () => ipcRenderer.invoke("mcd:axInvalidate"),
  onAtomix: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:atomix", h); return () => ipcRenderer.removeListener("mcd:atomix", h); },

  // ETH Wallet (standalone ERC20 wallet on the seed-derived address)
  ewStatus: () => ipcRenderer.invoke("mcd:ewStatus"),
  ewBalances: () => ipcRenderer.invoke("mcd:ewBalances"),
  ewTokens: () => ipcRenderer.invoke("mcd:ewTokens"),
  ewAddToken: (addr) => ipcRenderer.invoke("mcd:ewAddToken", addr),
  ewRemoveToken: (addr) => ipcRenderer.invoke("mcd:ewRemoveToken", addr),
  ewSendMax: (asset) => ipcRenderer.invoke("mcd:ewSendMax", asset),
  ewSendReview: (asset, to, amt) => ipcRenderer.invoke("mcd:ewSendReview", asset, to, amt),
  ewSend: (asset, to, amt, tier) => ipcRenderer.invoke("mcd:ewSend", asset, to, amt, tier),
  ewExportKey: () => ipcRenderer.invoke("mcd:ewExportKey"),
  ewSetRpc: (url) => ipcRenderer.invoke("mcd:ewSetRpc", url),
  onEthWallet: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:ethwallet", h); return () => ipcRenderer.removeListener("mcd:ethwallet", h); },

  // Casino (Zero Edge Casino — on-chain commit-reveal)
  casinoStatus: () => ipcRenderer.invoke("mcd:casinoStatus"),
  casinoOpenBets: () => ipcRenderer.invoke("mcd:casinoOpenBets"),
  casinoMyBets: () => ipcRenderer.invoke("mcd:casinoMyBets"),
  casinoHistory: () => ipcRenderer.invoke("mcd:casinoHistory"),
  casinoBalance: () => ipcRenderer.invoke("mcd:casinoBalance"),
  casinoRawBets: () => ipcRenderer.invoke("mcd:casinoRawBets"),
  casinoWalletCoins: () => ipcRenderer.invoke("mcd:casinoWalletCoins"),
  casinoStakeable: () => ipcRenderer.invoke("mcd:casinoStakeable"),
  casinoResolveOutcome: (commit, role) => ipcRenderer.invoke("mcd:casinoResolveOutcome", commit, role),
  casinoCreate: (preset, bet) => ipcRenderer.invoke("mcd:casinoCreate", preset, bet),
  casinoTake: (coinid, pick) => ipcRenderer.invoke("mcd:casinoTake", coinid, pick),
  casinoCancel: (coinid) => ipcRenderer.invoke("mcd:casinoCancel", coinid),
  casinoResolve: (coinid) => ipcRenderer.invoke("mcd:casinoResolve", coinid),
  casinoReveal: (coinid) => ipcRenderer.invoke("mcd:casinoReveal", coinid),
  casinoClaimTimeout: (coinid) => ipcRenderer.invoke("mcd:casinoClaimTimeout", coinid),
  casinoNewCount: () => ipcRenderer.invoke("mcd:casinoNewCount"),
  casinoSeen: () => ipcRenderer.invoke("mcd:casinoSeen"),
  casinoInvalidate: () => ipcRenderer.invoke("mcd:casinoInvalidate"),
  onCasino: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:casino", h); return () => ipcRenderer.removeListener("mcd:casino", h); },
  onCasinoLog: (fn) => { const h = (_e, l) => fn(l); ipcRenderer.on("mcd:casinolog", h); return () => ipcRenderer.removeListener("mcd:casinolog", h); },

  // Vestr (token vesting)
  vestrStatus: () => ipcRenderer.invoke("mcd:vestrStatus"),
  vestrList: () => ipcRenderer.invoke("mcd:vestrList"),
  vestrTokens: () => ipcRenderer.invoke("mcd:vestrTokens"),
  vestrMyAddress: () => ipcRenderer.invoke("mcd:vestrMyAddress"),
  vestrCreate: (opts) => ipcRenderer.invoke("mcd:vestrCreate", opts),
  vestrCollect: (coinid, burn) => ipcRenderer.invoke("mcd:vestrCollect", coinid, burn),
  vestrCalculate: (amount, startMs, endMs, graceHours) => ipcRenderer.invoke("mcd:vestrCalculate", amount, startMs, endMs, graceHours),
  onVestr: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:vestr", h); return () => ipcRenderer.removeListener("mcd:vestr", h); },

  // Web Wallet (local, megammr-gated). Seed is passed to main for loopback signing only; never persisted.
  wwMegammr: () => ipcRenderer.invoke("mcd:wwMegammr"),
  wwDerive: (seed) => ipcRenderer.invoke("mcd:wwDerive", seed),
  wwRead: (address, nodeSeed) => ipcRenderer.invoke("mcd:wwRead", address, nodeSeed),
  wwKeyuses: (address) => ipcRenderer.invoke("mcd:wwKeyuses", address),
  wwAckKeyuses: (address, count) => ipcRenderer.invoke("mcd:wwAckKeyuses", address, count),
  wwSend: (opts) => ipcRenderer.invoke("mcd:wwSend", opts),
  wwEnableMegammr: () => ipcRenderer.invoke("mcd:wwEnableMegammr"),
  onWebWallet: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:webwallet", h); return () => ipcRenderer.removeListener("mcd:webwallet", h); },

  // pushes
  onStatus: (fn) => { const h = (_e, s) => fn(s); ipcRenderer.on("mcd:status", h); return () => ipcRenderer.removeListener("mcd:status", h); },
  onLog: (fn) => { const h = (_e, l) => fn(l); ipcRenderer.on("mcd:log", h); return () => ipcRenderer.removeListener("mcd:log", h); }
});
