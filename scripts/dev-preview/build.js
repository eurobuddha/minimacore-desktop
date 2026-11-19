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
    ["wallet", "view=balances&tray=0"], ["apps", "view=apps&tray=0"], ["node", "view=node&tray=0"],
    ["tray", "view=node&tray=1"], ["overflow", "view=balances&tray=0&menu=1"], ["ethwallet", "view=ethwallet&tray=0"],
    ["mail", "view=mail&tray=1"], ["receive", "view=receive&tray=0"],
    ["stopped", "view=balances&tray=0&state=stopped"], ["shutdown", "view=balances&tray=0&shutdown=1"],
    ["wide-1440x900", "view=balances&tray=1", 1440, 900, 1], ["narrow-680", "view=balances&tray=1", 680, 704, 2]
  ];
  for (const dark of [true, false]) for (const [name, query, w = 932, h = 704, scale = 2.625] of set) {
    const file = path.join(here, "shots", (dark ? "dark-" : "light-") + name + ".png");
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--screenshot=" + file, `--window-size=${w},${h}`,
      "--force-device-scale-factor=" + scale, "--virtual-time-budget=5000", "--allow-file-access-from-files",
      ...(dark ? ["--force-dark-mode"] : []),
      pathToFileURL(out) + "?" + query], { stdio: "ignore" });
    console.log("shot " + path.relative(process.cwd(), file));
  }
}
