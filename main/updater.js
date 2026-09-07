/*
 * updater.js — minimaCore Desktop learns about its own updates from a one-app store feed.
 *
 * The feed is a single manifest-only JSON (the PandaApps convention: metadata in the feed, binaries on
 * GitHub Releases, sha256 per file), served from the eurobuddha.com store host:
 *   https://eurobuddha.com/pandaapps/minimacore-desktop.json
 *   { "app": "minimaCore Desktop", "version": "0.16.27", "date": "…", "notes": "…",
 *     "platforms": { "mac-arm64": { "file": "https://github.com/eurobuddha/minimacore-desktop/releases/download/v0.16.27/minimaCore-0.16.27-arm64.dmg", "sha256": "…", "size": 154786107 }, "win-x64": {…}, "linux-x64": {…} } }
 * check(): GET the feed (host-pinned, 20 s, never an error to the user), compare with app.getVersion().
 * download(): fetch the platform's file to ~/Downloads, verify sha256, reveal it. No silent install — the
 * user drags the signed DMG (or runs the installer) exactly as for a fresh install.
 * config.updateFeed overrides the URL for a self-hosted feed.
 */
const { app, shell } = require("electron");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const DEFAULT_FEED = "https://eurobuddha.com/pandaapps/minimacore-desktop.json";
const CHECK_EVERY_MS = 6 * 3600_000;

let status = { checkedAt: 0, available: false, version: "", notes: "", date: "", file: "", sha256: "", size: 0, error: "", downloaded: "" };
let timer = null;

function feedUrl() { const c = config.load(); return (c.updateFeed && String(c.updateFeed).trim()) || DEFAULT_FEED; }
function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return process.platform === "darwin" ? "mac-" + arch : process.platform === "win32" ? "win-" + arch : "linux-" + arch;
}
/** semver-ish compare on the numeric dotted part: 1 if a > b, -1 if a < b, 0 if equal. */
function cmpVersion(a, b) {
  const pa = String(a || "").split(/[.-]/).map(x => parseInt(x, 10)), pb = String(b || "").split(/[.-]/).map(x => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0, y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function get(url, { timeout = 20000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(u, { headers: { "User-Agent": "minimaCore-Desktop/" + app.getVersion(), Accept: "*/*" }, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume(); return get(new URL(res.headers.location, url).toString(), { timeout, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Read the feed and remember what it says. Never throws; the reason lands in status.error. */
async function check() {
  try {
    const url = feedUrl();
    const u = new URL(url);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"))) throw new Error("the update feed must be https");
    const body = JSON.parse((await get(url)).toString("utf8"));
    const p = (body.platforms || {})[platformKey()] || {};
    const newer = cmpVersion(body.version, app.getVersion()) > 0;
    status = { checkedAt: Date.now(), available: newer && !!p.file, version: String(body.version || ""), notes: String(body.notes || ""), date: String(body.date || ""),
               file: String(p.file || ""), sha256: String(p.sha256 || "").toLowerCase(), size: Number(p.size || 0), error: "", downloaded: status.downloaded && status.version === body.version ? status.downloaded : "" };
  } catch (e) {
    status = Object.assign({}, status, { checkedAt: Date.now(), error: (e && e.message) || String(e) });
  }
  return status;
}

/** Download the platform file to ~/Downloads, verify sha256, reveal it. Returns the path. */
async function download() {
  if (!status.available || !status.file) throw new Error("no update to download");
  const u = new URL(status.file);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"))) throw new Error("refusing a non-https download");
  const buf = await get(status.file, { timeout: 15 * 60_000 });
  if (status.sha256) {
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== status.sha256) throw new Error("sha256 mismatch — the download does not match the feed; not saved");
  }
  const dir = app.getPath("downloads");
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(u.pathname) || ("minimaCore-" + status.version);
  const dest = path.join(dir, name);
  fs.writeFileSync(dest + ".part", buf);
  fs.renameSync(dest + ".part", dest);
  status.downloaded = dest;
  shell.showItemInFolder(dest);   // revealed, not opened: the user installs it like a fresh download
  return dest;
}

function start() {
  if (timer) return;
  setTimeout(() => check().catch(() => {}), 8000);
  timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  if (timer.unref) timer.unref();
}
function current() { return Object.assign({ feed: feedUrl(), platform: platformKey(), running: app.getVersion() }, status); }

module.exports = { check, download, start, current, cmpVersion, DEFAULT_FEED };
