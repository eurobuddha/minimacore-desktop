/*
 * updater.js — keeps minima.jar current from a GitHub releases feed.
 *
 * check → find the latest release's `minima.jar` asset (+ a `minima.jar.sha256` asset or a `sha256:<hex>` line
 * in the release body) → compare tag vs the running node version → report. apply → download to a temp file →
 * sha256-verify (when a hash is published) → atomically move into userData/jar/minima.jar. main.js restarts
 * the node afterwards; the bundled 5.9 MB jar remains the fallback if userData/jar is absent.
 *
 * Repo is configurable (config.updateRepo / MCD_RELEASE_REPO), default the minima-core fork. Until the user
 * publishes a minima.jar release there, check() simply reports "up to date / none found" — never errors.
 */
const { app } = require("electron");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const node = require("./node-manager");

function repo() {
  const cfg = config.load();
  return process.env.MCD_RELEASE_REPO || cfg.updateRepo || "eurobuddha/minima-core";
}

function ghGet(urlPath, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.github.com", path: urlPath, method: "GET",
      headers: { "User-Agent": "minimaCore-Desktop", Accept: "application/vnd.github+json" }, timeout: 20000
    }, res => {
      let body = "";
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { return download(res.headers.location).then(resolve, reject); }
      res.on("data", d => body += d);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("GitHub " + res.statusCode));
        try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.end();
  });
}

/** Download a URL (following one redirect) to a Buffer. */
function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "minimaCore-Desktop" }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return download(res.headers.location).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("download HTTP " + res.statusCode)); }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function activeInfo() {
  const updated = path.join(app.getPath("userData"), "jar", "minima.jar");
  return { updatedPresent: fs.existsSync(updated), runningVersion: (node.health && node.health.version) || "" };
}

async function checkForUpdate() {
  let rel;
  try { rel = await ghGet("/repos/" + repo() + "/releases/latest"); }
  catch (e) { return { available: false, reason: "No node update available (" + e.message + ").", repo: repo(), ...activeInfo() }; }
  const assets = rel.assets || [];
  const jar = assets.find(a => a.name === "minima.jar");
  if (!jar) return { available: false, reason: "Latest release has no minima.jar asset.", repo: repo(), tag: rel.tag_name, ...activeInfo() };
  const shaAsset = assets.find(a => a.name === "minima.jar.sha256");
  let sha256 = null;
  if (shaAsset) { try { sha256 = (await download(shaAsset.browser_download_url)).toString().trim().split(/\s+/)[0]; } catch (e) {} }
  if (!sha256) { const m = /sha256[:\s]+([0-9a-f]{64})/i.exec(rel.body || ""); if (m) sha256 = m[1].toLowerCase(); }
  const info = activeInfo();
  const available = !info.runningVersion || (rel.tag_name && rel.tag_name.replace(/^v/, "") !== info.runningVersion);
  return { available, version: rel.tag_name, url: jar.browser_download_url, sha256, size: jar.size,
           notes: (rel.body || "").slice(0, 400), repo: repo(), reason: available ? "" : "You're on the latest node.", ...info };
}

// SECURITY: the download URL + hash are ALWAYS re-derived here from a fresh checkForUpdate() (the trusted GitHub
// API over TLS) — never taken from the caller. The renderer only triggers "install the latest"; it cannot point us
// at an arbitrary jar. Any renderer-supplied argument is used solely as an optional version sanity-check and is
// otherwise ignored, so a compromised renderer cannot install (and then execute, on node restart) a hostile jar.
async function applyUpdate(expect) {
  const fresh = await checkForUpdate();
  if (!fresh || !fresh.url) throw new Error("no node update available to install");
  if (expect && expect.version && fresh.version && expect.version !== fresh.version) {
    throw new Error("update changed since you checked — re-check and try again");
  }
  const buf = await download(fresh.url);
  if (fresh.sha256) {
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got.toLowerCase() !== fresh.sha256.toLowerCase()) throw new Error("sha256 mismatch — refusing to install");
  }
  const jarDir = path.join(app.getPath("userData"), "jar");
  fs.mkdirSync(jarDir, { recursive: true });
  const tmp = path.join(jarDir, "minima.jar.download");
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(jarDir, "minima.jar"));   // atomic swap
  return { installed: true, version: fresh.version, sha256verified: !!fresh.sha256 };
}

module.exports = { checkForUpdate, applyUpdate };
