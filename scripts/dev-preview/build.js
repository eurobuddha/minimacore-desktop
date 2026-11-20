#!/usr/bin/env node
/*
 * Dev preview of the shell, without Electron and without a node (never start the real app to look at a
 * layout: it runs a node on real wallet data).
 *
 *   node scripts/dev-preview/build.js          writes scripts/dev-preview/preview.html
 *   node scripts/dev-preview/build.js --shots  also captures the reference set into shots/ (headless Chrome)
 *
 * preview.html is renderer/index.html with a <base> pointing at renderer/, the CSP meta removed (a file://
 * page has no 'self') and stub.js loaded first as window.mcd. Open it in any browser:
 *   preview.html?view=apps   ?view=node&tray=1   ?menu=1   ?view=ethwallet
 * Fixture data only. Nothing here is shipped.
 */
"use strict";
const fs = require("fs"), path = require("path"), { pathToFileURL } = require("url"), { execFileSync } = require("child_process");
const here = __dirname, renderer = path.join(here, "..", "..", "renderer");
let html = fs.readFileSync(path.join(renderer, "index.html"), "utf8");
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, "")
  .replace("<head>", `<head>\n  <base href="${pathToFileURL(renderer + path.sep)}" />`)
  .replace('<script src="qrcode.js">', `<script>window.__MAIL_WORDS = ${JSON.stringify(fs.readFileSync(path.join(here, "..", "..", "main", "mail-address-words.txt"), "utf8").trim().split(/\r?\n/))};</script>\n  <script src="${pathToFileURL(path.join(here, "stub.js"))}"></script>\n  <script src="qrcode.js">`);
const out = path.join(here, "preview.html");
fs.writeFileSync(out, html);
console.log("wrote " + out);

if (process.argv.includes("--shots")) {
  const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"].find(fs.existsSync);
  if (!chrome) { console.error("no Chrome, Chromium, Edge or Brave found"); process.exit(1); }
  // the Fold is 932 x 704 dp at 2.625 px per dp; a tray app and the two window-width checks ride along
  const set = [
    ["wallet", "view=balances&tray=0"], ["wallet-expanded", "view=balances&tray=0&expand=1"],
    ["wallet-empty", "view=balances&tray=0&bal=empty&expand=1"], ["wallet-failed", "view=balances&tray=0&bal=fail"],
    ["wallet-1440x900", "view=balances&tray=0", 1440, 900, 1], ["wallet-expanded-1440x900", "view=balances&tray=0&expand=1", 1440, 900, 1],
    ["wallet-reordered", "view=balances&tray=0&tokens=0x5A1E0FD3C47B92E6A8D0347F1C29B6E5D48A7C3F0B19E2D6C5A4F3B2E1D0C9B8,0x3E5A7C9B1D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C"],
    ["send", "view=send&tray=0"], ["send-filled", "view=send&tray=0&send=filled"], ["send-review", "view=send&tray=0&send=review"], ["send-error", "view=send&tray=0&send=error"],
    ["send-1440x900", "view=send&tray=0&send=filled", 1440, 900, 1], ["send-review-1440x900", "view=send&tray=0&send=review", 1440, 900, 1],
    ["history", "view=history&tray=0"], ["history-empty", "view=history&tray=0&hist=empty"], ["history-menu", "view=history&tray=0&hmenu=1"],
    ["history-filter", "view=history&tray=0&hfilter=1&hforeign=1"], ["history-detail", "view=history&tray=0&hdetail=3"], ["history-detail-checking", "view=history&tray=0&hdetail=1&chain=checking"],
    ["history-1440x900", "view=history&tray=0", 1440, 900, 1], ["history-menu-1440x900", "view=history&tray=1&hmenu=1", 1440, 900, 1],
    ["coins", "view=balances&tray=0&dlg=coins"], ["coins-token", "view=balances&tray=0&dlg=coins:1"], ["coins-empty", "view=balances&tray=0&dlg=coins:3"],
    ["coins-failed", "view=balances&tray=0&dlg=coins&coins=fail"], ["coins-unchecked", "view=balances&tray=0&dlg=coins&coins=nosendable"], ["coin-detail-unchecked", "view=balances&tray=0&dlg=coin:0:4&coins=nosendable"], ["coins-1440x900", "view=balances&tray=0&dlg=coins", 1440, 900, 1],
    ["coin-detail", "view=balances&tray=0&dlg=coin"], ["coin-detail-locked", "view=balances&tray=0&dlg=coin:0:4"], ["coin-detail-1440x900", "view=balances&tray=0&dlg=coin:0:4", 1440, 900, 1],
    ["coins-split", "view=balances&tray=0&dlg=split"],
    ["params", "view=params&tray=0"], ["params-scroll", "view=params&tray=0&scroll=430"], ["params-1440x900", "view=params&tray=0", 1440, 900, 1],
    ["backup", "view=backup&tray=0"], ["backup-stopped", "view=backup&tray=0&state=stopped"], ["backup-1440x900", "view=backup&tray=0", 1440, 900, 1],
    ["backup-create", "view=backup&tray=0&bk=create"], ["backup-created", "view=backup&tray=0&bk=create&bkdone=1"], ["backup-create-1440x900", "view=backup&tray=0&bk=create", 1440, 900, 1],
    ["backup-restore", "view=backup&tray=0&bk=restore"], ["backup-restore-1440x900", "view=backup&tray=0&bk=restore", 1440, 900, 1], ["backup-resync", "view=backup&tray=0&bk=resync"],
    ["backup-keys", "view=backup&tray=0&bk=keys&seed=1"], ["backup-keys-1440x900", "view=backup&tray=0&bk=keys", 1440, 900, 1],
    ["first-launcher", "fr=launcher"], ["first-launcher-1440x900", "fr=launcher", 1440, 900, 1], ["first-params", "fr=params"], ["first-starting", "fr=starting"],
    ["first-seed", "fr=seed"], ["first-seed-1440x900", "fr=seed", 1440, 900, 1],
    ["first-confirm", "fr=confirm"], ["first-confirm-typing", "fr=confirm-typing"], ["first-confirm-1440x900", "fr=confirm", 1440, 900, 1],
    ["first-restore", "fr=restore"], ["first-restore-scroll", "fr=restore&scroll=400"], ["first-restore-any", "fr=restore-any"], ["first-restore-1440x900", "fr=restore", 1440, 900, 1],
    ["mode-params", "fr=params&block=1"], ["mode-restore", "fr=restore&block=1&scroll=330"], ["mode-restore-picked", "fr=restore&block=1&scroll=330&pick=classic"],
    ["mode-restore-1440x900", "fr=restore&block=1&scroll=330&pick=block", 1440, 900, 1], ["mode-rebuild", "view=backup&tray=0&bk=keys&block=1&scroll=520"],
    ["mode-tray-block", "view=node&tray=1&block=1&mode=block"], ["mode-refused", "view=node&tray=0&state=refused"],
    ["settings", "view=settings&tray=0"], ["settings-scroll", "view=settings&tray=0&scroll=640"], ["settings-scroll2", "view=settings&tray=0&scroll=1400"],
    ["settings-stopped", "view=settings&tray=0&state=stopped"], ["settings-1440x900", "view=settings&tray=0", 1440, 900, 1],
    ["apps", "view=apps&tray=0"], ["node", "view=node&tray=0"],
    ["tray", "view=node&tray=1"], ["overflow", "view=balances&tray=0&menu=1"],
    // Phase 5a: the tray apps in their originals' designs
    ["ethwallet", "view=ethwallet&tray=0"], ["ethwallet-1440x900", "view=ethwallet&tray=0", 1440, 900, 1], ["ethwallet-tray", "view=ethwallet&tray=1"], ["ethwallet-setup", "view=ethwallet&tray=0&ew=setup"], ["ethwallet-norpc", "view=ethwallet&tray=0&ew=norpc"],
    ["ethwallet-receive", "view=ethwallet&tray=0&do=%23ewReceive"], ["ethwallet-send", "view=ethwallet&tray=0&do=%23ewSend"], ["ethwallet-settings", "view=ethwallet&tray=0&do=%23ewSettings"],
    ["ethwallet-confirm", "view=ethwallet&tray=0&do=%23ewSend%7C.adlg__btn%3Alast-child&fill=%23ewTo%3D0xFA4E00000000000000000000000000000000BEEF%7C%23ewAmt%3D0.01"],
    ["ethwallet-confirm-swap", "view=ethwallet&tray=0&ewswap=1&do=%23ewSend%7C.adlg__btn%3Alast-child&fill=%23ewTo%3D0xFA4E00000000000000000000000000000000BEEF%7C%23ewAmt%3D0.0002"],
    ["vestr", "view=vestr&tray=0&vs=empty"], ["vestr-1440x900", "view=vestr&tray=0&vs=empty", 1440, 900, 1], ["vestr-contracts", "view=vestr&tray=0"], ["vestr-contracts-1440x900", "view=vestr&tray=0", 1440, 900, 1],
    ["vestr-collector", "view=vestr&tray=0&do=%5Bdata-vtab%3Dcollector%5D"], ["vestr-about", "view=vestr&tray=0&do=%5Bdata-vtab%3Dabout%5D"], ["vestr-create", "view=vestr&tray=0&do=%23vsCreate"], ["vestr-create-error", "view=vestr&tray=0&do=%23vsCreate%7C%23vcCreate"],
    ["vestr-calc", "view=vestr&tray=0&do=%23vsCalc"], ["vestr-detail", "view=vestr&tray=0&do=.vs-card"], ["vestr-stopped", "view=vestr&tray=0&state=stopped"],
    ["minimall", "view=minimall&tray=0"], ["minimall-1440x900", "view=minimall&tray=0", 1440, 900, 1], ["minimall-inbox", "view=minimall&tray=0&do=%5Bdata-mall%3Dinbox%5D"], ["minimall-inbox-order", "view=minimall&tray=0&do=%5Bdata-mall%3Dinbox%5D%7C%5Bdata-oref%3DORD-FAKE0002%5D"],
    ["minimall-inbox-card", "view=minimall&tray=0&do=%5Bdata-mall%3Dinbox%5D%7C%23mmCard"], ["minimall-shop", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D"], ["minimall-shop-empty", "view=minimall&tray=0&shop=empty&do=%5Bdata-mall%3Dshop%5D"],
    ["minimall-store", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D%7C%5Bdata-mine%5D%7C%5Bdata-inc%3Dp1%5D"], ["minimall-checkout", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D%7C%5Bdata-mine%5D%7C%5Bdata-inc%3Dp1%5D%7C%23shopCheckout"],
    ["minimall-pay", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D%7C%5Bdata-mine%5D%7C%5Bdata-inc%3Dp1%5D%7C%23shopCheckout%7C%23shopPay&fill=%23shopDelivery%3D1%20Preview%20Street"],
    ["minimall-myorder", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D%7C%23mmOrders%7C%5Bdata-oref%5D"], ["minimall-studio", "view=minimall&tray=0&do=%5Bdata-mall%3Dstudio%5D"],
    ["minimall-studio-products", "view=minimall&tray=0&do=%5Bdata-mall%3Dstudio%5D%7C%5Bdata-editshop%5D"], ["minimall-studio-product", "view=minimall&tray=0&do=%5Bdata-mall%3Dstudio%5D%7C%5Bdata-editshop%5D%7C%5Bdata-prod%5D"],
    ["minimall-studio-shop", "view=minimall&tray=0&do=%5Bdata-mall%3Dstudio%5D%7C%5Bdata-editshop%5D%7C%23sdNext"], ["minimall-store-1440x900", "view=minimall&tray=0&do=%5Bdata-mall%3Dshop%5D%7C%5Bdata-mine%5D%7C%5Bdata-inc%3Dp1%5D", 1440, 900, 1],
    ["webwallet-gate", "view=webwallet&tray=0"], ["webwallet-login", "view=webwallet&tray=0&ww=1"], ["webwallet-login-1440x900", "view=webwallet&tray=0&ww=1", 1440, 900, 1],
    ["webwallet", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn"], ["webwallet-1440x900", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn", 1440, 900, 1], ["webwallet-search", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C.nothing&fill=%23wwSeedIn%3Dfake%20preview%20phrase%7C%23wwSearch%3Dmx"],
    ["webwallet-token", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C%5Bdata-tok%5D%3Anth-child(2)"], ["webwallet-send-ack", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C%5Bdata-wwtab%3Dsend%5D"], ["webwallet-send", "view=webwallet&tray=0&ww=ack&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C%5Bdata-wwtab%3Dsend%5D"],
    ["webwallet-receive", "view=webwallet&tray=0&ww=1&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C%5Bdata-wwtab%3Dreceive%5D"], ["webwallet-logout", "view=webwallet&tray=0&ww=ack&fill=%23wwSeedIn%3Dfake%20preview%20phrase&do=%23wwUnlockBtn%7C%23wwLockBtn"],
    ["ethwallet-export", "view=ethwallet&tray=0&do=%23ewSettings%7C.adlg__item"], ["ethwallet-menu", "view=ethwallet&tray=0&do=.ew-more"],
["parlons", "view=parlons&tray=1&pl=ready"], ["parlons-starting", "view=parlons&tray=0"], ["parlons-error", "view=parlons&tray=0&pl=error"], ["parlons-1440x900", "view=parlons&tray=1&pl=ready", 1440, 900, 1],
    ["chat", "view=chat&tray=0"], ["chat-thread", "view=chat&tray=0&chat=thread"], ["chat-attach", "view=chat&tray=0&chat=attach"], ["chat-file", "view=chat&tray=0&chat=file"], ["chat-failure", "view=chat&tray=0&chat=failure"],
    ["chat-new", "view=chat&tray=0&chat=new"], ["chat-menu", "view=chat&tray=0&chat=menu"], ["chat-thread-1440x900", "view=chat&tray=0&chat=thread", 1440, 900, 1], ["chat-file-1440x900", "view=chat&tray=0&chat=file", 1440, 900, 1],
    ["mail", "view=mail&tray=0"], ["mail-tray", "view=mail&tray=1"], ["mail-empty", "view=mail&tray=0&mails=empty"], ["mail-1440x900", "view=mail&tray=0", 1440, 900, 1], ["mail-mmdark", "view=mail&tray=0&mm=dark"],
    ["mail-menu", "view=mail&tray=0&mail=menu"], ["mail-outbox", "view=mail&tray=0&mail=outbox"], ["mail-sent", "view=mail&tray=0&mail=sent"], ["mail-archive", "view=mail&tray=0&mail=archive"], ["mail-contacts", "view=mail&tray=0&mail=contacts"], ["mail-key", "view=mail&tray=0&mail=key"], ["mail-settings", "view=mail&tray=0&mail=settings"], ["mail-thread", "view=mail&tray=0&mail=thread"], ["mail-compose", "view=mail&tray=0&mail=compose"], ["mail-compose-ready", "view=mail&tray=0&mail=compose-ready"], ["mail-funds", "view=mail&tray=0&mail=funds"],
    ["mail-thread-1440x900", "view=mail&tray=0&mail=thread", 1440, 900, 1], ["mail-compose-1440x900", "view=mail&tray=0&mail=compose", 1440, 900, 1], ["mail-menu-1440x900", "view=mail&tray=0&mail=menu", 1440, 900, 1], ["mail-funds-1440x900", "view=mail&tray=0&mail=funds", 1440, 900, 1],
    ["mail-thread-mmdark", "view=mail&tray=0&mail=thread&mm=dark"], ["mail-menu-mmdark", "view=mail&tray=0&mail=menu&mm=dark"], ["mail-funds-mmdark", "view=mail&tray=0&mail=funds&mm=dark"], ["mail-settings-mmdark", "view=mail&tray=0&mail=settings&mm=dark"], ["receive", "view=receive&tray=0"], ["receive-1440x900", "view=receive&tray=0", 1440, 900, 1], ["receive-stopped", "view=receive&tray=0&state=stopped"],
    ["stopped", "view=balances&tray=0&state=stopped"], ["shutdown", "view=balances&tray=0&shutdown=1"], ["apps-hidden", "view=apps&tray=0&hidden=mail"],
    // Dexicon. The file prefix is the SYSTEM theme; "-dxlight" is Dexicon's own light theme (it does not follow the system)
    ["ax-swap", "view=atomix"], ["ax-swap-dxlight", "view=atomix&dx=light"], ["ax-swap-1440x900", "view=atomix", 1440, 900, 1], ["ax-swap-dxlight-1440x900", "view=atomix&dx=light", 1440, 900, 1],
    ["ax-swap-buy", "view=atomix&axf=buy:120"], ["ax-swap-sell", "view=atomix&axf=sell:120&scroll=260"], ["ax-swap-review", "view=atomix&axf=buy:120&axdo=%23axReview"], ["ax-swap-progress", "view=atomix&scroll=560"], ["ax-swap-progress-dxlight", "view=atomix&dx=light&scroll=560"],
    ["ax-swap-check", "view=atomix&axdo=%5Bdata-axcheck%5D"], ["ax-swap-hide", "view=atomix&axdo=%5Bdata-axhide%5D"], ["ax-swap-empty", "view=atomix&axs=empty"], ["ax-swap-noquote", "view=atomix&axs=noquote"], ["ax-swap-notready", "view=atomix&axs=notready"],
    ["ax-swap-stopped", "view=atomix&state=stopped"], ["ax-swap-minima", "view=atomix&axs=minima"], ["ax-swap-idle", "view=atomix&axs=idle"], ["ax-swap-switch", "view=atomix&axdo=%23dxCcy"], ["ax-swap-narrow", "view=atomix", 560, 915, 2],
["ax-market", "view=atomix&axtab=market"], ["ax-market-dxlight", "view=atomix&axtab=market&dx=light"], ["ax-market-1440x900", "view=atomix&axtab=market", 1440, 900, 1], ["ax-market-dxlight-1440x900", "view=atomix&axtab=market&dx=light", 1440, 900, 1],
    ["ax-market-scroll", "view=atomix&axtab=market&scroll=520"], ["ax-market-editor", "view=atomix&axtab=market&axdo=%5Bdata-axmk%3Dedit%5D"], ["ax-market-editor-dxlight", "view=atomix&axtab=market&dx=light&axdo=%5Bdata-axmk%3Dedit%5D"], ["ax-market-editor-1440x900", "view=atomix&axtab=market&axdo=%5Bdata-axmk%3Dedit%5D", 1440, 900, 1],
    ["ax-market-withdraw", "view=atomix&axtab=market&axdo=%5Bdata-axmk%3Dwithdraw%5D"], ["ax-market-published", "view=atomix&axtab=market&axdo=%5Bdata-axmk%3Dpublish%5D"], ["ax-market-empty", "view=atomix&axtab=market&axs=empty"], ["ax-market-manycoins", "view=atomix&axtab=market&axs=manycoins"],
    ["ax-market-minima", "view=atomix&axtab=market&axs=minima"], ["ax-market-why", "view=atomix&axtab=market&axdo=%5Bdata-axwhy%5D"], ["ax-market-narrow", "view=atomix&axtab=market", 560, 915, 2],
["ax-otc", "view=atomix&axtab=otc"], ["ax-otc-dxlight", "view=atomix&axtab=otc&dx=light"], ["ax-otc-1440x900", "view=atomix&axtab=otc", 1440, 900, 1], ["ax-otc-dxlight-1440x900", "view=atomix&axtab=otc&dx=light", 1440, 900, 1],
    ["ax-otc-scroll", "view=atomix&axtab=otc&scroll=420"], ["ax-otc-propose", "view=atomix&axtab=otc&axdo=%5Bdata-axlp%5D"], ["ax-otc-counter", "view=atomix&axtab=otc&axdo=%5Bdata-axdeal%3Dcounter%5D"], ["ax-otc-accepted", "view=atomix&axtab=otc&axdo=%5Bdata-axdeal%3Daccept%5D"],
    ["ax-otc-empty", "view=atomix&axtab=otc&axs=empty"], ["ax-otc-why", "view=atomix&axtab=otc&axs=empty&axdo=%5Bdata-axwhy%5D"], ["ax-otc-narrow", "view=atomix&axtab=otc", 560, 915, 2],
["ax-activity", "view=atomix&axtab=activity"], ["ax-activity-dxlight", "view=atomix&axtab=activity&dx=light"], ["ax-activity-1440x900", "view=atomix&axtab=activity", 1440, 900, 1], ["ax-activity-dxlight-1440x900", "view=atomix&axtab=activity&dx=light", 1440, 900, 1],
    ["ax-activity-scroll", "view=atomix&axtab=activity&scroll=700"], ["ax-activity-market", "view=atomix&axtab=activity&axdo=%5Bdata-asub%3D%221%22%5D"], ["ax-activity-empty", "view=atomix&axtab=activity&axs=empty"], ["ax-activity-check", "view=atomix&axtab=activity&axdo=%5Bdata-axcheck%5D"],
    ["ax-assets", "view=atomix&axtab=assets"], ["ax-assets-dxlight", "view=atomix&axtab=assets&dx=light"], ["ax-assets-1440x900", "view=atomix&axtab=assets", 1440, 900, 1], ["ax-assets-dxlight-1440x900", "view=atomix&axtab=assets&dx=light", 1440, 900, 1],
    ["ax-assets-scroll", "view=atomix&axtab=assets&scroll=420"], ["ax-assets-send", "view=atomix&axtab=assets&axdo=%5Bdata-axw%3Dsend%5D"], ["ax-assets-fund", "view=atomix&axtab=assets&axdo=%5Bdata-axw%3Dfund%5D"], ["ax-assets-key", "view=atomix&axtab=assets&axdo=%5Bdata-axw%3Dkey%5D"],
    ["ax-assets-coins", "view=atomix&axtab=assets&axdo=%5Bdata-axw%3Dcoins%5D"], ["ax-assets-manycoins", "view=atomix&axtab=assets&axs=manycoins&scroll=420"], ["ax-assets-stopped", "view=atomix&axtab=assets&state=stopped"],
    ["ax-settings", "view=atomix&axtab=settings"], ["ax-settings-dxlight", "view=atomix&axtab=settings&dx=light"], ["ax-settings-1440x900", "view=atomix&axtab=settings", 1440, 900, 1], ["ax-settings-about", "view=atomix&axtab=settings&axdo=%5Bdata-axabout%5D"],
    ["ax-history", "view=dexicon&dxtab=history&scroll=600"], ["ax-history-dxlight", "view=dexicon&dxtab=history&dx=light&scroll=600"],
["ax-halt", "view=atomix&axs=halt"], ["ax-halt-dxlight", "view=atomix&axs=halt&dx=light"], ["ax-halt-1440x900", "view=atomix&axs=halt", 1440, 900, 1], ["ax-halt-dxlight-1440x900", "view=atomix&axs=halt&dx=light", 1440, 900, 1],
    ["ax-halt-scroll", "view=atomix&axs=halt&scroll=520"], ["ax-halt-sweep", "view=atomix&axs=halt&axdo=%5Bdata-axw%3Dsweep%5D"], ["ax-halt-market", "view=atomix&axs=halt&axtab=market&scroll=700"], ["ax-halt-assets", "view=atomix&axs=halt&axtab=assets&scroll=300"],
    ["ax-offline", "view=atomix&state=stopped&axlive=1"], ["ax-offline-dxlight", "view=atomix&state=stopped&axlive=1&dx=light"], ["ax-offline-market", "view=atomix&state=stopped&axlive=1&axtab=market"],
    // room 2, Pools (PandaPools): every screen in Dexicon dark and light at the Fold's size and at 1440 x 900
    ...["swap", "pools", "mylp", "wallet", "activity"].flatMap(t => [["pp-" + t, "view=pandapools&pptab=" + t], ["pp-" + t + "-dxlight", "view=pandapools&dx=light&pptab=" + t],
      ["pp-" + t + "-1440x900", "view=pandapools&pptab=" + t, 1440, 900, 1], ["pp-" + t + "-dxlight-1440x900", "view=pandapools&dx=light&pptab=" + t, 1440, 900, 1]]),
    ["pp-swap-quote", "view=pandapools&ppf=250"], ["pp-swap-quote-dxlight", "view=pandapools&dx=light&ppf=250"], ["pp-swap-buy", "view=pandapools&ppdir=buy&ppf=1.5"], ["pp-swap-review", "view=pandapools&ppf=250&ppdo=%23ppGo"],
    ["pp-swap-done", "view=pandapools&ppf=250&ppdo=%23ppGo%7C.dx-dlg%20%5Bdata-x%3D%221%22%5D"], ["pp-swap-failed", "view=pandapools&pps=swapfail&ppf=250&ppdo=%23ppGo%7C.dx-dlg%20%5Bdata-x%3D%221%22%5D"],
    ["pp-swap-toobig", "view=pandapools&ppf=900000"], ["pp-swap-empty", "view=pandapools&pps=empty"], ["pp-swap-notready", "view=pandapools&pps=notready"], ["pp-swap-stopped", "view=pandapools&state=stopped"],
    ["pp-swap-fake", "view=pandapools&pps=fake&ppf=250"], ["pp-swap-fakeonly-review", "view=pandapools&pps=fakeonly&ppf=250&ppdo=%23ppGo"], ["pp-pools-fake", "view=pandapools&pptab=pools&pps=fake"],
    ["pp-swap-broken", "view=pandapools&pps=broken"], ["pp-swap-broken-dxlight", "view=pandapools&dx=light&pps=broken"], ["pp-swap-broken-aside", "view=pandapools&pps=broken&ppdo=%5Bdata-ppaside%5D"], ["ax-swap-broken", "view=atomix&axs=broken"],
    ["pp-swap-scroll", "view=pandapools&ppf=250&scroll=400"], ["pp-swap-narrow", "view=pandapools&ppf=250", 560, 915, 2],
    ["pp-pools-combined", "view=pandapools&pptab=pools&ppdo=%5Bdata-ppmode%3Dcombined%5D"], ["pp-pools-combined-dxlight", "view=pandapools&dx=light&pptab=pools&ppdo=%5Bdata-ppmode%3Dcombined%5D"], ["pp-pools-empty", "view=pandapools&pptab=pools&pps=empty"],
    ["pp-pools-notready", "view=pandapools&pptab=pools&pps=notready"], ["pp-pools-stopped", "view=pandapools&pptab=pools&state=stopped"], ["pp-pools-narrow", "view=pandapools&pptab=pools", 560, 915, 2],
    ["pp-mylp-scroll", "view=pandapools&pptab=mylp&scroll=520"], ["pp-mylp-scroll-dxlight", "view=pandapools&dx=light&pptab=mylp&scroll=520"], ["pp-mylp-scroll2", "view=pandapools&pptab=mylp&scroll=1100"], ["pp-mylp-add", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppadd%5D&ppin=.pp-dlg%20%5Bname%3Da%5D%3D500"], ["pp-mylp-add-review", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppadd%5D%7C.pp-dlg%20%5Bdata-x%3D%221%22%5D&ppin=.pp-dlg%20%5Bname%3Da%5D%3D500"], ["pp-mylp-add-empty", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppadd%5D%7C.pp-dlg%20%5Bdata-x%3D%221%22%5D"], ["pp-mylp-add-done", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppadd%5D%7C.pp-dlg%20%5Bdata-x%3D%221%22%5D%7C.dx-dlg%3Anot(.pp-dlg)%20%5Bdata-x%3D%221%22%5D&ppin=.pp-dlg%20%5Bname%3Da%5D%3D500"], ["pp-mylp-close", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppclose%5D"],
    ["pp-mylp-paused", "view=pandapools&pptab=mylp&pps=paused&scroll=520"], ["pp-mylp-collect", "view=pandapools&pptab=mylp&pps=collect&scroll=300"], ["pp-mylp-stranded", "view=pandapools&pptab=mylp&pps=stranded&scroll=300"], ["pp-mylp-empty", "view=pandapools&pptab=mylp&pps=empty"],
    ["pp-mylp-calc", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppcalc%5D"], ["pp-mylp-closed", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dclosed%5D"], ["pp-mylp-migrate", "view=pandapools&pptab=mylp&pps=migrate&scroll=620"], ["pp-mylp-narrow", "view=pandapools&pptab=mylp", 560, 915, 2],
    ["pp-recovery-menu", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D"], ["pp-recovery-backup", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Dbackup%5D"], ["pp-recovery-backup-short", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Dbackup%5D%7C.pp-dlg%20%5Bdata-x%3D%221%22%5D&ppin=%5Bname%3Dp1%5D%3Dshort"],
    ["pp-recovery-backup-saved", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Dbackup%5D%7C.pp-dlg%20%5Bdata-x%3D%221%22%5D&ppin=%5Bname%3Dp1%5D%3Dcorrect%20horse%20battery%20staple%7C%5Bname%3Dp2%5D%3Dcorrect%20horse%20battery%20staple"], ["pp-recovery-restore", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Drestore%5D"], ["pp-recovery-restored", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Drestore%5D%7C%5Bdata-ppr%3Dfile%5D%7C%5Bdata-ppr%3Dgo%5D"], ["pp-recovery-node", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Drestore%5D%7C%5Bdata-ppr%3Dnode%5D"],
    ["pp-recovery-archive", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Darchive%5D"], ["pp-recovery-guide", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Drecovery%5D%7C%5Bdata-pick%3Dguide%5D"], ["pp-recovery-required", "view=pandapools&pptab=mylp&pps=backup"], ["pp-recovery-required-dxlight", "view=pandapools&dx=light&pptab=mylp&pps=backup"],
    ["pp-recovery-check", "view=pandapools&pptab=mylp&scroll=1100&ppdo=%5Bdata-pprecover%5D"],
    ["pp-create-1", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D"],
    ["pp-create-1-dxlight", "view=pandapools&pptab=mylp&dx=light&ppdo=%5Bdata-pptool%3Dcreate%5D"],
    ["pp-create-1-owed", "view=pandapools&pptab=mylp&pps=backup&ppdo=%5Bdata-pptool%3Dcreate%5D"],
    ["pp-create-1-unticked", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D"],
    ["pp-create-2", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-2-dxlight", "view=pandapools&pptab=mylp&dx=light&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-3", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D%7C%5Bdata-ppcreate%3Dgo%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-4", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D%7C%5Bdata-ppcreate%3Dgo%5D%7C.dx-dlg%20%5Bdata-x%3D%221%22%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-moved", "view=pandapools&pptab=mylp&pps=moved&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D%7C%5Bdata-ppcreate%3Dgo%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-mintfail", "view=pandapools&pptab=mylp&pps=mintfail&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D%7C%5Bdata-ppcreate%3Dgo%5D%7C.dx-dlg%20%5Bdata-x%3D%221%22%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-refused", "view=pandapools&pptab=mylp&pps=backup2&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D%7C%5Bdata-ppcreate%3Dgo%5D%7C.dx-dlg%20%5Bdata-x%3D%221%22%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90"],
    ["pp-create-manual", "view=pandapools&pptab=mylp&pps=manual&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D&ppin=%23ppcAck1%3D1%7C.pp-fld%20%5Bname%3Dx%5D%3D100%7C.pp-fld%20%5Bname%3Dy%5D%3D0.56"],
    ["pp-create-nousd", "view=pandapools&pptab=mylp&bal=empty&ppdo=%5Bdata-pptool%3Dcreate%5D"],
    ["pp-create-migrate", "view=pandapools&pptab=mylp&ppdo=%5Bdata-ppmig%5D"],
    ["pp-create-2-1440x900", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90", 1440, 900, 1], ["pp-create-2-narrow", "view=pandapools&pptab=mylp&ppdo=%5Bdata-pptool%3Dcreate%5D%7C%5Bdata-ppcreate%3Dnext%5D&ppin=%23ppcAck1%3D1%7C%23ppcU%3D1.90", 560, 915, 2],
    ["pp-wallet-scroll", "view=pandapools&pptab=wallet&scroll=420"], ["pp-wallet-coins", "view=pandapools&pptab=wallet&ppdo=%5Bdata-ppbal%3D%221%22%5D"], ["pp-wallet-consolidate", "view=pandapools&pptab=wallet&ppdo=%5Bdata-ppwal%3Dmxusd%5D"], ["pp-wallet-refused", "view=pandapools&pptab=wallet&pps=ownerkey&ppdo=%5Bdata-ppwal%3Dmxusd%5D%7C%23cfOk"],
    ["pp-wallet-check", "view=pandapools&pptab=wallet&ppdo=%5Bdata-ppwal%3Dcheck%5D"], ["pp-wallet-empty", "view=pandapools&pptab=wallet&bal=empty"], ["pp-wallet-stopped", "view=pandapools&pptab=wallet&state=stopped"], ["pp-wallet-narrow", "view=pandapools&pptab=wallet", 560, 915, 2],
    ["pp-activity-scroll", "view=pandapools&pptab=activity&scroll=520"], ["pp-activity-all", "view=pandapools&pptab=activity&ppdo=%5Bdata-ppall%3D%221%22%5D"], ["pp-activity-all-dxlight", "view=pandapools&dx=light&pptab=activity&ppdo=%5Bdata-ppall%3D%221%22%5D"], ["pp-activity-all-scroll", "view=pandapools&pptab=activity&scroll=420&ppdo=%5Bdata-ppall%3D%221%22%5D"],
    ["pp-activity-empty", "view=pandapools&pptab=activity&pps=empty"], ["pp-activity-notready", "view=pandapools&pptab=activity&pps=notready"], ["pp-activity-stopped", "view=pandapools&pptab=activity&state=stopped"], ["pp-activity-narrow", "view=pandapools&pptab=activity", 560, 915, 2],
    ["pp-shared-activity", "view=dexicon&dxtab=activity&scroll=1750"], ["pp-shared-activity-dxlight", "view=dexicon&dx=light&dxtab=activity&scroll=1750"], ["pp-shared-activity-notready", "view=dexicon&dxtab=activity&pps=notready&scroll=1750"], ["pp-shared-history", "view=dexicon&dxtab=history&scroll=1500"],
    ["pp-shutdown", "view=pandapools&shutdown=1"], ["pp-shutdown-unchecked", "view=pandapools&pps=notready&shutdown=1"],
    ["dex-trade", "view=dexicon"], ["dex-trade-dxlight", "view=dexicon&dx=light"],
    ["dex-trade-1440x900", "view=dexicon", 1440, 900, 1], ["dex-trade-dxlight-1440x900", "view=dexicon&dx=light", 1440, 900, 1],
    ["dex-trade-take", "view=dexicon&dxf=buy:0.0034:25000"], ["dex-trade-take-dxlight", "view=dexicon&dx=light&dxf=buy:0.0034:25000"], ["dex-trade-rest", "view=dexicon&dxf=sell:0.0036:500"], ["dex-trade-own", "view=dexicon&dxf=sell:0.0029:100"],
    ["dex-trade-review", "view=dexicon&dxf=buy:0.0032:3000&dxdlg=1"], ["dex-trade-taking", "view=dexicon&dxs=taking&dxf=buy:0.0034:500&scroll=200"], ["dex-trade-failed", "view=dexicon&dxs=failed&dxf=buy:0.0034:500&scroll=200"],
    ["dex-trade-stopped", "view=dexicon&state=stopped"], ["dex-trade-notready", "view=dexicon&dxs=notready"], ["dex-trade-norelay", "view=dexicon&dxs=norelay"], ["dex-trade-relaydown", "view=dexicon&dxs=relaydown"],
    ["dex-trade-empty", "view=dexicon&dxs=empty"], ["dex-trade-narrow", "view=dexicon", 560, 915, 2],
    ["dex-orders", "view=dexicon&dxtab=orders"], ["dex-orders-dxlight", "view=dexicon&dxtab=orders&dx=light"], ["dex-orders-1440x900", "view=dexicon&dxtab=orders", 1440, 900, 1], ["dex-orders-dxlight-1440x900", "view=dexicon&dxtab=orders&dx=light", 1440, 900, 1],
    ["dex-orders-fills", "view=dexicon&dxtab=orders&dxsub=1"], ["dex-orders-maker", "view=dexicon&dxtab=orders&dxmm=1"], ["dex-orders-empty", "view=dexicon&dxtab=orders&dxs=empty"], ["dex-orders-stopped", "view=dexicon&dxtab=orders&state=stopped"],
    ["dex-history", "view=dexicon&dxtab=history"], ["dex-history-dxlight", "view=dexicon&dxtab=history&dx=light"], ["dex-history-1440x900", "view=dexicon&dxtab=history", 1440, 900, 1], ["dex-history-dxlight-1440x900", "view=dexicon&dxtab=history&dx=light", 1440, 900, 1],
    ["dex-history-empty", "view=dexicon&dxtab=history&dxs=empty"], ["dex-history-facts", "view=dexicon&dxtab=history&dxfill=1"],
    ["dex-activity", "view=dexicon&dxtab=activity"], ["dex-activity-dxlight", "view=dexicon&dxtab=activity&dx=light"], ["dex-activity-1440x900", "view=dexicon&dxtab=activity", 1440, 900, 1], ["dex-activity-dxlight-1440x900", "view=dexicon&dxtab=activity&dx=light", 1440, 900, 1],
    ["dex-activity-market", "view=dexicon&dxtab=activity&dxasub=1"], ["dex-activity-empty", "view=dexicon&dxtab=activity&dxs=empty"],
    ["dex-assets", "view=dexicon&dxtab=assets"], ["dex-assets-dxlight", "view=dexicon&dxtab=assets&dx=light"], ["dex-assets-1440x900", "view=dexicon&dxtab=assets", 1440, 900, 1], ["dex-assets-dxlight-1440x900", "view=dexicon&dxtab=assets&dx=light", 1440, 900, 1],
    ["dex-assets-open", "view=dexicon&dxtab=assets&dxopen=1"], ["dex-assets-nofunds", "view=dexicon&dxtab=assets&bal=fail"],
    ["dex-settings", "view=dexicon&dxtab=settings"], ["dex-settings-dxlight", "view=dexicon&dxtab=settings&dx=light"], ["dex-settings-1440x900", "view=dexicon&dxtab=settings", 1440, 900, 1], ["dex-settings-dxlight-1440x900", "view=dexicon&dxtab=settings&dx=light", 1440, 900, 1],
    ["dex-settings-found", "view=dexicon&dxtab=settings&dxs=found"], ["dex-settings-norelay", "view=dexicon&dxtab=settings&dxs=norelay"], ["dex-settings-relaydown", "view=dexicon&dxtab=settings&dxs=relaydown"], ["dex-trade-nofunds", "view=dexicon&bal=empty&dxf=buy:0.0034:500"],
    ["wide-1440x900", "view=balances&tray=1", 1440, 900, 1], ["narrow-680", "view=balances&tray=1", 680, 704, 2]
  ];
  const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);   // --only=wallet captures the names that start with it
  for (const dark of [true, false]) for (const [name, query, w = 932, h = 704, scale = 2.625] of set) {
    if (only && !name.startsWith(only)) continue;
    const file = path.join(here, "shots", (dark ? "dark-" : "light-") + name + ".png");
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--screenshot=" + file, `--window-size=${w},${h}`,
      "--force-device-scale-factor=" + scale, "--virtual-time-budget=5000", "--allow-file-access-from-files",
      ...(dark ? ["--force-dark-mode"] : []),
      pathToFileURL(out) + "?" + query], { stdio: "ignore" });
    console.log("shot " + path.relative(process.cwd(), file));
  }
}
