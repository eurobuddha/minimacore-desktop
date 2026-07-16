/*
 * config.js — persisted app configuration + the RPC secret.
 *
 * Config (node startup params, window prefs) lives as JSON in Electron's userData dir. The RPC password is
 * NOT kept in that JSON: it goes in the macOS Keychain (via the `security` CLI) with a 0600 file fallback,
 * and is only ever read by the MAIN process (the renderer never sees it — it talks through the RPC proxy).
 */
const { app, safeStorage } = require("electron");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const PARAMS = require("../renderer/params.js");   // shared minima.jar param manifest (dual CJS/global)

const KEYCHAIN_SERVICE = "com.eurobuddha.minimacore.rpc";
const KEYCHAIN_ACCOUNT = "minima";

// which manifest flags are secret (stored in the Keychain, never in config.json)
const SECRET_FLAGS = new Set();
for (const g of PARAMS.GROUPS) for (const it of g.items) if (it.type === "secret") SECRET_FLAGS.add(it.flag);
const MANAGED = new Set(PARAMS.MANAGED);

function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function secretFilePath() { return path.join(app.getPath("userData"), "rpc.secret"); }

// --- on-disk secret fallback (only used when the Keychain is unavailable) ---
// Never write secrets as plaintext: encrypt with Electron safeStorage (OS-key backed) when available. Reads accept a
// legacy plaintext file for backward compatibility so existing installs aren't stranded.
function encAvailable() { try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } }
function writeSecretFile(p, value) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const data = encAvailable() ? safeStorage.encryptString(String(value)) : Buffer.from(String(value), "utf8");
  fs.writeFileSync(p, data, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (e) {}   // enforce 0600 even if the file pre-existed looser
}
function readSecretFile(p) {
  let buf; try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (encAvailable()) { try { const s = safeStorage.decryptString(buf); if (s) return s.trim(); } catch (e) { /* legacy plaintext → fall through */ } }
  const s = buf.toString("utf8").trim(); return s || null;
}

const DEFAULTS = {
  setupDone: false,          // node wizard completed
  walletDone: false,         // seed onboarding (new/restore) completed
  walletMode: "new",         // "new" (boot+connect) | "restore" (post-boot megammrsync). Seed is NEVER persisted.
  dataFolder: "",            // -data (empty → default under userData)
  network: "mainnet",        // mainnet | solo | custom  (a preset that fills the params below)
  customConnect: "",         // host:port for network=custom (folds into params.connect)
  peersUrl: "https://spartacusrex.com/minimapeers.txt",  // default -p2pnodes bootstrap list
  megammrHost: "31.125.188.214:9001",  // megammrsync host for a seed RESTORE (app concept, not a jar param)
  basePort: 12001,           // -port. 12001 avoids 9001 jar / 11001 android / 14001 classic / 16001 desktop
  contribute: false,         // "Contribute to the network": -server role + UPnP/NAT-PMP port mapping
  rpcPortManual: "",         // -rpc override; blank → basePort + 4
  params: PARAMS.defaultParams(),   // EVERY other minima.jar startup flag, user-editable at first run
  extraArgs: "",             // any additional raw args, appended verbatim
  labels: {},                // address → friendly name (shown in Receive / History / CSV)
  theme: "current"           // current | original-light | original-dark
};

function load() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (e) { /* first run */ }
  const merged = Object.assign({}, DEFAULTS, j);
  // params: keep ONLY flags in the current manifest — a saved value wins, otherwise the default. This adds
  // any newly-supported flag and DROPS ones we've removed (e.g. the MDS flags minimaCore has no layer for),
  // so a stale config can never resurrect a flag we no longer expose.
  const defs = PARAMS.defaultParams(), sp = j.params || {}, params = {};
  for (const k of Object.keys(defs)) params[k] = (k in sp) ? sp[k] : defs[k];
  merged.params = params;
  return merged;
}

function save(cfg) {
  const cur = load();
  // Route secret params (passwords / DSNs) to the Keychain; store only a boolean "set" marker in config.
  if (cfg.params) {
    for (const flag of SECRET_FLAGS) {
      if (!(flag in cfg.params)) continue;
      const v = cfg.params[flag];
      if (typeof v === "string" && v.trim()) { keychainSet(v.trim(), "param-" + flag); cfg.params[flag] = true; }
      else if (v === false || v === "" || v == null) { keychainDelete("param-" + flag); cfg.params[flag] = false; }
      // v === true → unchanged marker, keep the existing keychain value
    }
    cfg.params = Object.assign({}, cur.params, cfg.params);
  }
  const merged = Object.assign(cur, cfg);
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * The params to actually pass to the jar: manifest params minus the app-managed ones, with secret markers
 * (true) resolved to their real Keychain value. Managed flags (rpcenable/daemon/ports/seed) are added by
 * node-manager itself, so they are excluded here to avoid duplicates.
 */
function effectiveParams() {
  const p = load().params || {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (MANAGED.has(k)) continue;
    if (SECRET_FLAGS.has(k)) {
      if (v === true) { const s = keychainGet("param-" + k); if (s) out[k] = s; }   // resolve secret
      else if (typeof v === "string" && v.trim()) out[k] = v.trim();
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Default node data folder (inside the app's own space, never the repo/cwd). */
function defaultDataFolder() { return path.join(app.getPath("userData"), "node-data"); }

// ---- RPC secret ------------------------------------------------------------

/** Fetch the RPC secret, generating + storing one on first use. Keychain first, 0600 file fallback. */
function rpcSecret() {
  const fromKeychain = keychainGet();
  if (fromKeychain) return fromKeychain;
  const existing = readSecretFile(secretFilePath());
  if (existing) return existing;
  const secret = crypto.randomBytes(24).toString("base64url");
  if (!keychainSet(secret)) writeSecretFile(secretFilePath(), secret);
  return secret;
}

function keychainGet(account = KEYCHAIN_ACCOUNT) {
  try {
    return execFileSync("security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (e) { return null; }
}

function keychainSet(secret, account = KEYCHAIN_ACCOUNT) {
  try {
    execFileSync("security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", secret, "-U"],
      { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
}

function keychainDelete(account = KEYCHAIN_ACCOUNT) {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
      { stdio: "ignore" });
  } catch (e) { /* not present */ }
}

// ---- generic named secret store (Keychain first, 0600-file fallback) -------
function secretFileFor(account) { return path.join(app.getPath("userData"), "sec-" + String(account).replace(/[^a-z0-9-]/gi, "_") + ".dat"); }
/** Read a named secret (e.g. the derived mail identity). */
function getSecret(account) {
  const k = keychainGet(account);
  if (k) return k;
  return readSecretFile(secretFileFor(account));
}
/** Store a named secret. */
function setSecret(value, account) {
  if (!keychainSet(value, account)) writeSecretFile(secretFileFor(account), value);
}
/** Remove a named secret (both Keychain + file fallback). */
function deleteSecret(account) { keychainDelete(account); try { fs.unlinkSync(secretFileFor(account)); } catch (e) { /* absent */ } }

module.exports = { load, save, DEFAULTS, defaultDataFolder, rpcSecret, effectiveParams, getSecret, setSecret, deleteSecret };
