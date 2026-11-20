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
  keyMode: () => ipcRenderer.invoke("mcd:keyMode"),
  recordKeyMode: (mode) => ipcRenderer.invoke("mcd:recordKeyMode", mode),
  restoreBackup: (o) => ipcRenderer.invoke("mcd:restoreBackup", o),
  copyRpcPassword: () => ipcRenderer.invoke("mcd:copyRpcPassword"),

  // config
  getConfig: () => ipcRenderer.invoke("mcd:getConfig"),
  saveConfig: (patch) => ipcRenderer.invoke("mcd:saveConfig", patch),
  defaultDataFolder: () => ipcRenderer.invoke("mcd:defaultDataFolder"),
  pickFolder: () => ipcRenderer.invoke("mcd:pickFolder"),

  // node lifecycle
  nodeStatus: () => ipcRenderer.invoke("mcd:nodeStatus"),
  nodeStart: () => ipcRenderer.invoke("mcd:nodeStart"),
  nodeStop: () => ipcRenderer.invoke("mcd:nodeStop"),
  inFlight: (how) => ipcRenderer.invoke("mcd:inFlight", how),   // what a Shutdown ("shutdown") or a Quit ("quit") would interrupt: { title, message, any }
  nodeRestart: () => ipcRenderer.invoke("mcd:nodeRestart"),
  nodeReclaim: () => ipcRenderer.invoke("mcd:nodeReclaim"),
  nodeLogs: () => ipcRenderer.invoke("mcd:nodeLogs"),
  portmapStatus: () => ipcRenderer.invoke("mcd:portmapStatus"),

  // Parlons account (the Parlons Node hosts it under this node's seed)
  parlonsStatus: () => ipcRenderer.invoke("mcd:parlonsStatus"),
  parlonsOpenExternal: () => ipcRenderer.invoke("mcd:parlonsOpenExternal"),
  setNodeKind: (kind) => ipcRenderer.invoke("mcd:setNodeKind", kind),

  // app updates from the minimaCore store feed
  updateStatus: () => ipcRenderer.invoke("mcd:updateStatus"),
  updateCheck: () => ipcRenderer.invoke("mcd:updateCheck"),
  updateDownload: () => ipcRenderer.invoke("mcd:updateDownload"),
  onOpenUpdate: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:openUpdate", h); return () => ipcRenderer.removeListener("mcd:openUpdate", h); },
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
  histImport: (rows) => ipcRenderer.invoke("mcd:histImport", rows),
  histClear: () => ipcRenderer.invoke("mcd:histClear"),
  histQuery: (filters) => ipcRenderer.invoke("mcd:histQuery", filters),
  histTokens: () => ipcRenderer.invoke("mcd:histTokens"),
  histStats: () => ipcRenderer.invoke("mcd:histStats"),

  // save a CSV via a native save dialog → written path or null
  exportCsv: (text, name) => ipcRenderer.invoke("mcd:exportCsv", text, name),
  // pick a JSON file via a native open dialog → its text, or null (History import)
  importJson: () => ipcRenderer.invoke("mcd:importJson"),

  appVersion: () => ipcRenderer.invoke("mcd:appVersion"),

  // faucet requester (main-process HTTPS GET → { status, message })
  faucet: (address) => ipcRenderer.invoke("mcd:faucet", address),

  // minimaMail (on-chain encrypted messaging; keys stay in main)
  mailInit: () => ipcRenderer.invoke("mcd:mailInit"),
  mailSetName: (n) => ipcRenderer.invoke("mcd:mailSetName", n),
  mailAddressWords: () => ipcRenderer.invoke("mcd:mailAddressWords"),
  mailResolveAddress: value => ipcRenderer.invoke("mcd:mailResolveAddress", value),
  mailCheckOwnBeacon: () => ipcRenderer.invoke("mcd:mailCheckOwnBeacon"),
  mailPublishAddress: (key, enabled) => ipcRenderer.invoke("mcd:mailPublishAddress", key, enabled),
  mailSetTheme: theme => ipcRenderer.invoke("mcd:mailSetTheme", theme),
  mailPayOptions: () => ipcRenderer.invoke("mcd:mailPayOptions"),
  mailShare: () => ipcRenderer.invoke("mcd:mailShare"),
  mailThreads: () => ipcRenderer.invoke("mcd:mailThreads"),
  mailReadMessage: (hash, id) => ipcRenderer.invoke("mcd:mailReadMessage", hash, id),
  mailThread: (h) => ipcRenderer.invoke("mcd:mailThread", h),
  mailThreadWith: (peer, subject) => ipcRenderer.invoke("mcd:mailThreadWith", peer, subject),
  mailSend: (to, base) => ipcRenderer.invoke("mcd:mailSend", to, base),
  mailRetry: (hashref, randomid) => ipcRenderer.invoke("mcd:mailRetry", hashref, randomid),
  mailOutbox: () => ipcRenderer.invoke("mcd:mailOutbox"),
  mailSent: () => ipcRenderer.invoke("mcd:mailSent"),
  mailStatus: () => ipcRenderer.invoke("mcd:mailStatus"),
  mailBackfill: () => ipcRenderer.invoke("mcd:mailBackfill"),
  mailPay: (to, payaddr, amount, tokenid, tokenname, memo, subject) => ipcRenderer.invoke("mcd:mailPay", to, payaddr, amount, tokenid, tokenname, memo, subject),
  mailRequestPayaddr: (peer) => ipcRenderer.invoke("mcd:mailRequestPayaddr", peer),
  mailResolvePayaddr: (peer) => ipcRenderer.invoke("mcd:mailResolvePayaddr", peer),
  chatInit: () => ipcRenderer.invoke("mcd:chatInit"),
  chatContacts: () => ipcRenderer.invoke("mcd:chatContacts"),
  chatClearThread: (pk) => ipcRenderer.invoke("mcd:chatClearThread", pk),
  chatDeleteMessage: (id) => ipcRenderer.invoke("mcd:chatDeleteMessage", id),
  chatSendVoice: (to, bytes, mime, secs, wave) => ipcRenderer.invoke("mcd:chatSendVoice", to, bytes, mime, secs, wave),
  chatFileSend: (to) => ipcRenderer.invoke("mcd:chatFileSend", to),
  chatFileOffer: (peer, ref) => ipcRenderer.invoke("mcd:chatFileOffer", peer, ref),
  chatFileRun: (peer, ref, id) => ipcRenderer.invoke("mcd:chatFileRun", peer, ref, id),
  chatFilePause: (id) => ipcRenderer.invoke("mcd:chatFilePause", id),
  chatFileStatus: (id) => ipcRenderer.invoke("mcd:chatFileStatus", id),
  chatFileTransfers: (peer) => ipcRenderer.invoke("mcd:chatFileTransfers", peer),
  chatFileRemove: (id) => ipcRenderer.invoke("mcd:chatFileRemove", id),
  chatFileKeep: (id, on) => ipcRenderer.invoke("mcd:chatFileKeep", id, on),
  chatFileShareAgain: (id) => ipcRenderer.invoke("mcd:chatFileShareAgain", id),
  chatFileSave: (id) => ipcRenderer.invoke("mcd:chatFileSave", id),
  chatIdentity: () => ipcRenderer.invoke("mcd:chatIdentity"),
  chatSetName: (n) => ipcRenderer.invoke("mcd:chatSetName", n),
  chatThreads: () => ipcRenderer.invoke("mcd:chatThreads"),
  chatThread: (pk) => ipcRenderer.invoke("mcd:chatThread", pk),
  chatSend: (to, text) => ipcRenderer.invoke("mcd:chatSend", to, text),
  chatAddContact: (pk, name) => ipcRenderer.invoke("mcd:chatAddContact", pk, name),
  chatRenameContact: (pk, name) => ipcRenderer.invoke("mcd:chatRenameContact", pk, name),
  chatRemoveContact: (pk) => ipcRenderer.invoke("mcd:chatRemoveContact", pk),
  chatStatus: () => ipcRenderer.invoke("mcd:chatStatus"),
  chatMedia: (ref) => ipcRenderer.invoke("mcd:chatMedia", ref),
  chatSendPayment: (to, amount, token) => ipcRenderer.invoke("mcd:chatSendPayment", to, amount, token),
  chatRequestPayAddr: (to) => ipcRenderer.invoke("mcd:chatRequestPayAddr", to),
  chatPayAddr: (to) => ipcRenderer.invoke("mcd:chatPayAddr", to),
  chatSendImage: (to) => ipcRenderer.invoke("mcd:chatSendImage", to),
  chatExportBackup: (pass) => ipcRenderer.invoke("mcd:chatExportBackup", pass),
  chatOpenBackup: (pass) => ipcRenderer.invoke("mcd:chatOpenBackup", pass),
  chatApplyBackup: () => ipcRenderer.invoke("mcd:chatApplyBackup"),
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
  onChat: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:chat", h); return () => ipcRenderer.removeListener("mcd:chat", h); },
  onChatFocus: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:chat-focus", h); return () => ipcRenderer.removeListener("mcd:chat-focus", h); },

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
  ppStatement: () => ipcRenderer.invoke("mcd:ppStatement"),
  ppConsolidationCheck: () => ipcRenderer.invoke("mcd:ppConsolidationCheck"),
  reserved: () => ipcRenderer.invoke("mcd:reserved"),   // coins held by AtomiX, PandaPools, Dexicon: { coins:[{coinid, owner, why, state…}], funds:[{tokenid, held, free, why}] }
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
  ppRecoverSaved: (addr) => ipcRenderer.invoke("mcd:ppRecoverSaved", addr),
  ppRetirePool: (addr, retired) => ipcRenderer.invoke("mcd:ppRetirePool", addr, retired),
  ppListRetired: () => ipcRenderer.invoke("mcd:ppListRetired"),
  ppPendingCollect: () => ipcRenderer.invoke("mcd:ppPendingCollect"),
  ppArchiveSettings: (url) => ipcRenderer.invoke("mcd:ppArchiveSettings", url),
  ppConfirmSigning: (opk, attested) => ipcRenderer.invoke("mcd:ppConfirmSigning", opk, attested),
  ppSaveBackup: (json) => ipcRenderer.invoke("mcd:ppSaveBackup", json),
  ppCompleteBackupRequired: () => ipcRenderer.invoke("mcd:ppCompleteBackupRequired"),
  ppStatus: () => ipcRenderer.invoke("mcd:ppStatus"),
  ppWhy: () => ipcRenderer.invoke("mcd:ppWhy"),
  ppLoadBackup: (password, extractNode) => ipcRenderer.invoke("mcd:ppLoadBackup", password, extractNode),
  onPandapools: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:pandapools", h); return () => ipcRenderer.removeListener("mcd:pandapools", h); },

  // AtomiX (atomic swaps)
  axStatus: () => ipcRenderer.invoke("mcd:axStatus"),
  axBook: () => ipcRenderer.invoke("mcd:axBook"),
  axQuote: (sell, amount, slip) => ipcRenderer.invoke("mcd:axQuote", sell, amount, slip),
  axSwapPreview: (sell, amount, slip) => ipcRenderer.invoke("mcd:axSwapPreview", sell, amount, slip),
  axSwap: (quoteId) => ipcRenderer.invoke("mcd:axSwap", quoteId),
  axSwaps: () => ipcRenderer.invoke("mcd:axSwaps"),
  axRefundNow: (hash) => ipcRenderer.invoke("mcd:axRefundNow", hash),
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

  // Dexicon (room 3, Exchange): read model + the command bridge ({ op: "cmd" | "sql" | "comms", … }, main/dexicon.js)
  dxStatus: () => ipcRenderer.invoke("mcd:dxStatus"),
  dxBook: () => ipcRenderer.invoke("mcd:dxBook"),
  dxMine: () => ipcRenderer.invoke("mcd:dxMine"),
  dxCommand: (a) => ipcRenderer.invoke("mcd:dxCommand", a),
  dxSkipWarning: () => ipcRenderer.invoke("mcd:dxSkipWarning"),
  dxSkipCheck: () => ipcRenderer.invoke("mcd:dxSkipCheck"),
  engineSetAside: (which) => ipcRenderer.invoke("mcd:engineSetAside", which),
  onDexicon: (fn) => { const h = (_e, message) => fn(message); ipcRenderer.on("mcd:dexicon", h); return () => ipcRenderer.removeListener("mcd:dexicon", h); },

  // P2P Chance was removed in 0.18.68; only the settle-only status of bets already on the chain is left.
  casinoOpen: () => ipcRenderer.invoke("mcd:casinoOpen"),
  casinoInvalidate: () => ipcRenderer.invoke("mcd:casinoInvalidate"),
  onCasino: (fn) => { const h = () => fn(); ipcRenderer.on("mcd:casino", h); return () => ipcRenderer.removeListener("mcd:casino", h); },

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
