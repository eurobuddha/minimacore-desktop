/*
 * config.js — persisted app configuration + the RPC secret.
 *
 * Config (node startup params, window prefs) lives as JSON in Electron's userData dir. The RPC password is
 * NOT kept in that JSON: it goes in the macOS Keychain (via the `security` CLI) with a 0600 file fallback,
 * and is only ever read by the MAIN process (the renderer never sees it — it talks through the RPC proxy).
 */
const { app } = require("electron");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEYCHAIN_SERVICE = "com.eurobuddha.minimacore.rpc";
const KEYCHAIN_ACCOUNT = "minima";

function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function secretFilePath() { return path.join(app.getPath("userData"), "rpc.secret"); }

const DEFAULTS = {
  setupDone: false,          // node wizard completed
  walletDone: false,         // seed onboarding (new/restore) completed
  walletMode: "new",         // "new" (boot+connect) | "restore" (post-boot megammrsync). Seed is NEVER persisted.
  dataFolder: "",            // -data (empty → default under userData)
  network: "mainnet",        // mainnet | solo | custom
  customConnect: "",         // host:port for network=custom
  peersUrl: "https://spartacusrex.com/minimapeers.txt",  // -p2pnodes bootstrap (canonical mainnet peer list)
  megammrHost: "31.125.188.214:9001",  // a -megammr node for fast seed/chain resync (megammrsync host, restore only)
  basePort: 12001,           // -port (RPC = +4). 12001 avoids 9001 jar / 11001 android / 14001 classic / 16001 desktop
  megammr: false,            // -megammr full history
  theme: "current"           // current | original-light | original-dark
};

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return Object.assign({}, DEFAULTS, j);
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

function save(cfg) {
  const merged = Object.assign(load(), cfg);
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

/** Default node data folder (inside the app's own space, never the repo/cwd). */
function defaultDataFolder() { return path.join(app.getPath("userData"), "node-data"); }

// ---- RPC secret ------------------------------------------------------------

/** Fetch the RPC secret, generating + storing one on first use. Keychain first, 0600 file fallback. */
function rpcSecret() {
  const fromKeychain = keychainGet();
  if (fromKeychain) return fromKeychain;
  try {
    const s = fs.readFileSync(secretFilePath(), "utf8").trim();
    if (s) return s;
  } catch (e) { /* not there yet */ }
  const secret = crypto.randomBytes(24).toString("base64url");
  if (!keychainSet(secret)) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(secretFilePath(), secret, { mode: 0o600 });
  }
  return secret;
}

function keychainGet() {
  try {
    return execFileSync("security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (e) { return null; }
}

function keychainSet(secret) {
  try {
    execFileSync("security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", secret, "-U"],
      { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
}

module.exports = { load, save, DEFAULTS, defaultDataFolder, rpcSecret };
