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
  .replace('<script src="qrcode.js">', `<script src="${pathToFileURL(path.join(here, "stub.js"))}"></script>\n  <script src="qrcode.js">`);
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
    ["coins-failed", "view=balances&tray=0&dlg=coins&coins=fail"], ["coins-1440x900", "view=balances&tray=0&dlg=coins", 1440, 900, 1],
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
    ["tray", "view=node&tray=1"], ["overflow", "view=balances&tray=0&menu=1"], ["ethwallet", "view=ethwallet&tray=0"],
    ["mail", "view=mail&tray=1"], ["receive", "view=receive&tray=0"], ["receive-1440x900", "view=receive&tray=0", 1440, 900, 1], ["receive-stopped", "view=receive&tray=0&state=stopped"],
    ["stopped", "view=balances&tray=0&state=stopped"], ["shutdown", "view=balances&tray=0&shutdown=1"], ["apps-hidden", "view=apps&tray=0&hidden=mail"],
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
