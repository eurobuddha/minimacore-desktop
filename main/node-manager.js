/*
 * node-manager.js — owns the java child process running minima.jar.
 *
 * Responsibilities: resolve the JRE (bundled first, system fallback for dev), build the arg list from the
 * saved config, spawn/stop/restart, keep a log ring buffer, health-poll the RPC (status → block/version),
 * and emit status events the window/tray subscribe to. Stop is graceful: RPC `quit` first (clean H2/db
 * shutdown), SIGTERM as the fallback.
 *
 * The jar it runs: a user-data copy (updatable by the jar updater) if present, else the bundled resource.
 */
const { app } = require("electron");
const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { rpcCall } = require("./rpc");

const LOG_MAX_LINES = 800;
const HEALTH_EVERY_MS = 10_000;

/** Split a raw-args string into argv tokens, honoring single/double quotes. */
function tokenizeArgs(s) {
  if (!s || typeof s !== "string") return [];
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class NodeManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = "stopped";       // stopped | starting | running | stopping | error
    this.lastError = null;
    this.logs = [];
    this.health = null;           // { block, version, connections } from the last good status poll
    this.healthTimer = null;
  }

  /** The jar to run: the updater-managed copy in userData wins; the bundled resource is the fallback. */
  jarPath() {
    const updated = path.join(app.getPath("userData"), "jar", "minima.jar");
    if (fs.existsSync(updated)) return updated;
    const bundled = app.isPackaged
      ? path.join(process.resourcesPath, "minima.jar")
      : path.join(__dirname, "..", "resources", "minima.jar");
    return bundled;
  }

  /** Bundled jlink JRE when packaged; system `java` in dev. */
  javaPath() {
    const bundled = app.isPackaged
      ? path.join(process.resourcesPath, "jre", "bin", "java")
      : path.join(__dirname, "..", "resources", "jre", "bin", "java");
    return fs.existsSync(bundled) ? bundled : "java";
  }

  rpcPort() {
    const c = config.load();
    return parseInt(c.rpcPortManual, 10) || (c.basePort + 4);
  }

  buildArgs() {
    const cfg = config.load();
    const dataDir = cfg.dataFolder || config.defaultDataFolder();
    fs.mkdirSync(dataDir, { recursive: true });
    // App-managed base: the app depends on these, so it sets them itself (they're excluded from params).
    const args = ["-jar", this.jarPath(),
      "-data", dataDir,
      "-basefolder", dataDir,
      "-port", String(cfg.basePort),
      "-rpcenable", "true",
      "-rpcpassword", config.rpcSecret(),
      "-daemon", "true"];
    if (cfg.rpcPortManual) args.push("-rpc", String(this.rpcPort()));   // else the node uses -port + 4

    // Every other minima.jar startup flag comes from the user-configured params (bool → `-flag`,
    // value/int/secret → `-flag <value>`). This is the single source of truth — the wizard fills it from
    // the Network/Wallet presets AND the full advanced editor.
    const params = config.effectiveParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === true) args.push("-" + k);
      else if (v === false || v === "" || v == null) continue;
      else args.push("-" + k, String(v));
    }

    // Additional raw args, appended verbatim (quote-aware split).
    for (const tok of tokenizeArgs(cfg.extraArgs)) args.push(tok);
    return args;
  }

  start() {
    if (this.proc) return;
    this.lastError = null;
    this.setState("starting");
    const args = this.buildArgs();
    this.log("[app] starting node: java " + args.map(a => (a.length > 60 ? a.slice(0, 57) + "…" : a))
      .join(" ").replace(config.rpcSecret(), "•••"));
    let p;
    try {
      p = spawn(this.javaPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.lastError = "could not launch java: " + e.message;
      this.setState("error");
      return;
    }
    this.proc = p;
    p.stdout.on("data", d => this.log(String(d)));
    p.stderr.on("data", d => this.log(String(d)));
    p.on("error", e => { this.lastError = e.message; this.setState("error"); this.proc = null; });
    p.on("exit", (code, sig) => {
      this.log("[app] node exited code=" + code + " sig=" + sig);
      this.proc = null;
      this.stopHealth();
      if (this.state !== "stopping") { this.lastError = "node exited unexpectedly (" + (code ?? sig) + ")"; this.setState("error"); }
      else this.setState("stopped");
    });
    this.startHealth();
  }

  /** Graceful stop: RPC quit (clean db close) → SIGTERM fallback. Resolves when the process is gone. */
  async stop() {
    if (!this.proc) { this.setState("stopped"); return; }
    this.setState("stopping");
    this.stopHealth();
    const gone = new Promise(res => {
      const t = setTimeout(() => { try { this.proc && this.proc.kill("SIGTERM"); } catch (e) {} }, 12_000);
      const t2 = setTimeout(() => { try { this.proc && this.proc.kill("SIGKILL"); } catch (e) {} }, 25_000);
      const iv = setInterval(() => {
        if (!this.proc) { clearTimeout(t); clearTimeout(t2); clearInterval(iv); res(); }
      }, 300);
    });
    try { await rpcCall(this.rpcPort(), config.rpcSecret(), "quit"); } catch (e) { /* fall through to signals */ }
    await gone;
  }

  async restart() { await this.stop(); this.start(); }

  // ---- health ----
  startHealth() {
    this.stopHealth();
    const poll = async () => {
      if (!this.proc) return;
      try {
        const j = await rpcCall(this.rpcPort(), config.rpcSecret(), "status");
        const r = (j && j.response) || {};
        this.health = {
          version: r.version || "",
          block: (r.chain && r.chain.block) || 0,
          connections: (r.network && r.network.connected) || 0,
          locked: !!r.locked
        };
        if (this.state !== "running") this.setState("running");
        else this.emit("status", this.snapshot());
      } catch (e) { /* still booting or busy — keep the current state */ }
    };
    poll();
    this.healthTimer = setInterval(poll, HEALTH_EVERY_MS);
  }
  stopHealth() { if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; } this.health = null; }

  // ---- state/logs ----
  setState(s) { this.state = s; this.emit("status", this.snapshot()); }
  snapshot() {
    return { state: this.state, health: this.health, lastError: this.lastError,
             jar: this.jarPath(), rpcPort: this.rpcPort() };
  }
  log(line) {
    for (const l of String(line).split("\n")) {
      if (!l.trim()) continue;
      this.logs.push(l.length > 400 ? l.slice(0, 400) + "…" : l);
    }
    if (this.logs.length > LOG_MAX_LINES) this.logs.splice(0, this.logs.length - LOG_MAX_LINES);
    this.emit("log");
  }
}

module.exports = new NodeManager();
