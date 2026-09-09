/*
 * node-manager.js — owns the java child process running minima.jar.
 *
 * Responsibilities: resolve the JRE (bundled first, system fallback for dev), build the arg list from the
 * saved config, spawn/stop/restart, keep a log ring buffer, health-poll the RPC (status → block/version),
 * and emit status events the window/tray subscribe to. Stop is graceful: RPC `quit` first (clean H2/db
 * shutdown), SIGTERM as the fallback.
 *
 * The jar it runs: always the one shipped with the app (see jarPath — the in-app updater is disabled).
 */
const { app } = require("electron");
const { spawn, execFileSync } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const portmap = require("./portmap");
const { rpcCall } = require("./rpc");

const LOG_MAX_LINES = 800;
// Minima flags the Parlons Node refuses at boot (MinimaFlags.EXCLUDED): the app never passes them.
// The stock RPC ones are replaced by the node's loopback admin RPC (-Dparlons.node.rpc=true), which the
// app's RPC client reaches unchanged on basePort+4 (it ignores the Basic auth header).
const PARLONS_REFUSED = new Set(["rpc", "rpcenable", "rpcpassword", "rpccrlf", "seed", "anyseed", "dbpassword",
  "clean", "genesis", "test", "solo", "testchainlength", "daemon", "noshutdownhook", "jnlp", "help"]);
const PARLONS_DEFAULT_ROOTNODE = "31.125.188.214:9001";   // the fork ships an empty node list: give it one peer
const HEALTH_EVERY_MS = 10_000;
const NET_RESTART_COOLDOWN_MS = 10 * 60_000;   // a network restart drops every peer — never do it in a loop

/** Split a raw-args string into argv tokens, honoring single/double quotes. */
function tokenizeArgs(s) {
  if (!s || typeof s !== "string") return [];
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Bounded sleep. */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Is a pid alive (signal 0)? */
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } }

/** Pids LISTENING on a TCP port. mac/linux: lsof; win32: netstat -ano. Empty on any failure. */
function listeners(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && parseInt(m[1], 10) === port) pids.add(parseInt(m[2], 10));
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-nP", "-t", "-iTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(x => parseInt(x, 10)).filter(n => n > 0))];
  } catch (e) { return []; }
}

/** A process's command line ("" if unknown). */
function commandOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("wmic", ["process", "where", "processid=" + pid, "get", "commandline", "/value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/CommandLine=(.*)/); return m ? m[1].trim() : "";
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) { return ""; }
}

function killPid(pid, signal) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", signal === "SIGKILL" ? "/F" : "/T"], { stdio: "ignore" });
    else process.kill(pid, signal);
  } catch (e) {}
}

class NodeManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = "stopped";       // stopped | starting | running | stopping | error
    this.lastError = null;
    this.logs = [];
    this.health = null;           // { block, version, connections, incoming, acceptingInLinks, p2pAddress }
    this.healthTimer = null;
    this.healthTick = 0;
    this.startedTs = 0;
    this.wasMapped = false;
    this.lastNetRestart = 0;
    // Parlons Node (nodeKind "parlons"): the account's readiness comes from the jar's own log lines,
    // not from `status` (the chain is up well before the account has attached to the relays).
    this.parlons = { ready: false, error: "", version: "", cape: false };
    portmap.setLogger(line => this.log(line));
    portmap.on("status", st => {
      // Late mapping recovery: after ~1h with no in-links the jar flips isAcceptingInLinks=false and
      // leaves it off until its network layer restarts. If the mapping only comes good after that, restart
      // just the network layer so the node starts advertising itself again.
      //
      // Fire on the TRANSITION into mapped, not on any event that happens to carry state==="mapped":
      // portmap emits on every setStatus AND from discoverHostInfo, so a single cycle can emit "mapped"
      // more than once. `acceptingInLinks` also only refreshes every ~30s, so it stays stale-false right
      // after a restart — without the cooldown we'd tear the peer connections down repeatedly.
      const nowMapped = st.state === "mapped";
      const becameMapped = nowMapped && !this.wasMapped;
      this.wasMapped = nowMapped;
      if (becameMapped && this.proc && this.startedTs && Date.now() - this.startedTs > 70 * 60_000 &&
          this.health && this.health.acceptingInLinks === false &&
          Date.now() - this.lastNetRestart > NET_RESTART_COOLDOWN_MS) {
        this.lastNetRestart = Date.now();
        this.log("[app] port mapped late — restarting the node's network layer to re-enable inbound");
        rpcCall(this.rpcPort(), config.rpcSecret(), "network action:restart").catch(e => {});
      }
      this.emit("status", this.snapshot());
    });
  }

  /**
   * The jar to run: always the one shipped with the app.
   *
   * This used to prefer an updater-managed copy in userData. With the updater disabled that
   * precedence became a trap: anyone who had ever run it would keep booting their downloaded jar
   * forever, so a shipped fix — the Wallet.signData one-time-signature fix among them — would never
   * reach them. Any stale userData jar is now ignored rather than deleted; nothing reads it.
   */
  jarPath() {
    const name = this.kind() === "parlons" ? "parlons-node.jar" : "minima.jar";
    return app.isPackaged
      ? path.join(process.resourcesPath, name)
      : path.join(__dirname, "..", "resources", name);
  }

  /** "parlons" (parlons-node.jar: node + Parlons account + relay when contributing) or "minima". */
  kind() { return config.load().nodeKind === "minima" ? "minima" : "parlons"; }

  /** The node's data folder (also where the Parlons account keeps its files: account.txt, invite.txt,
   *  panel-ticket.txt, panel.txt). */
  dataDir() { const cfg = config.load(); return cfg.dataFolder || config.defaultDataFolder(); }

  /** The account's local web panel port (loopback), Parlons kind only. */
  panelPort() { return config.load().basePort + 586; }
  /** The Maxima relay (cape) port when contributing: the P2P port itself (one public port). */
  capePort() { return config.load().basePort; }

  /** Bundled jlink JRE when packaged; system `java` in dev. Windows launches java.exe. */
  javaPath() {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const bundled = app.isPackaged
      ? path.join(process.resourcesPath, "jre", "bin", exe)
      : path.join(__dirname, "..", "resources", "jre", "bin", exe);
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
    if (this.kind() === "parlons") return this.buildParlonsArgs(cfg, dataDir);
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

  /**
   * The Parlons Node takes NO command-line flags: every knob is a -D property before -jar, and Minima's
   * own flags travel inside ONE quoted -Dparlons.node.args string (the jar's tokeniser honours quotes,
   * so a data folder with spaces is fine). Same data folder layout as minima.jar (<data>/1.1/…), proven
   * on a copy of a real node folder, so switching kinds keeps the wallet.
   */
  buildParlonsArgs(cfg, dataDir) {
    const params = config.effectiveParams();
    const megammr = !!params.megammr;
    const heap = parseInt(cfg.heapMb, 10) > 0 ? parseInt(cfg.heapMb, 10) : (megammr ? 3072 : 1536);
    const q = (v) => '"' + String(v).replace(/(["\\])/g, "\\$1") + '"';
    const flags = ["-basefolder", q(dataDir)];
    for (const [k, v] of Object.entries(params)) {
      if (PARLONS_REFUSED.has(k) || k === "megammr") continue;   // megammr goes through its own -D below
      if (v === true) flags.push("-" + k);
      else if (v === false || v === "" || v == null) continue;
      else flags.push("-" + k, q(v));
    }
    for (const tok of tokenizeArgs(cfg.extraArgs)) {
      const key = tok.replace(/^-+/, "").toLowerCase();
      if (tok.startsWith("-") && PARLONS_REFUSED.has(key)) continue;
      flags.push(/\s/.test(tok) ? q(tok) : tok);
    }
    const args = [
      "-Xmx" + heap + "m",
      "-Dparlons.node.data=" + dataDir,
      "-Dparlons.node.port=" + cfg.basePort,
      "-Dparlons.node.rpc=true",
      "-Dparlons.node.megammr=" + megammr,
      // One public port: when contributing, the Maxima relay rides the Minima P2P port (the fork hands
      // Parlons clients over by their greeting), so the mapping the app already holds is the only one.
      "-Dparlons.relay.port=" + (cfg.contribute ? "shared" : "0"),
      "-Dparlons.panel.port=" + this.panelPort(),
      "-Dparlons.gateway.port=" + (cfg.basePort + 584)
    ];
    if (cfg.network === "custom" && cfg.customConnect) args.push("-Dparlons.node.connect=" + cfg.customConnect);
    else if (!params.p2prootnode && !params.connect) args.push("-Dparlons.node.rootnode=" + (cfg.peers || PARLONS_DEFAULT_ROOTNODE));
    args.push("-Dparlons.node.args=" + flags.join(" "), "-jar", this.jarPath());
    return args;
  }

  /** Why the Parlons Node cannot run with the current settings ("" = it can). Checked before a switch. */
  parlonsBlocker() {
    const cfg = config.load();
    if (cfg.network === "solo") return "The Parlons Node is a mainnet node: a solo/private network needs the plain Minima node.";
    if (cfg.params && cfg.params.dbpassword === true) return "The Parlons Node cannot take -dbpassword (a wallet DB password): keep the plain Minima node, or set up again without one.";
    if (!fs.existsSync(this.parlonsJarPath())) return "parlons-node.jar is not bundled in this build.";
    return "";
  }
  parlonsJarPath() {
    return app.isPackaged ? path.join(process.resourcesPath, "parlons-node.jar")
                          : path.join(__dirname, "..", "resources", "parlons-node.jar");
  }

  pidfilePath() { return path.join(app.getPath("userData"), "node.pid"); }

  /**
   * A node this app started earlier and never stopped (the app crashed, was force-quit, or its stop
   * threw) keeps the port and the H2 databases, and the next start died with "already in use" /
   * "Database may be already in use" — seen live 2026-09-07 with a java left behind since the day
   * before. Before spawning: find such a node — by our pidfile, and by whoever LISTENS on our
   * port — and if its command line says it is a minima/parlons node on our port or data folder,
   * stop it (RPC quit, SIGTERM, SIGKILL; bounded) and wait for the port. A port held by anything
   * else is reported, never fought. Returns "" (go ahead) or the reason not to start.
   */
  async reclaimStaleNode() {
    const cfg = config.load();
    const port = cfg.basePort, dataDir = cfg.dataFolder || config.defaultDataFolder();
    const candidates = new Map();   // pid → command
    try {
      const pf = JSON.parse(fs.readFileSync(this.pidfilePath(), "utf8"));
      if (pf && pf.pid && alive(pf.pid)) candidates.set(pf.pid, commandOf(pf.pid));
      else try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
    } catch (e) { /* no pidfile */ }
    for (const pid of listeners(port)) if (!candidates.has(pid)) candidates.set(pid, commandOf(pid));
    if (candidates.has(process.pid)) candidates.delete(process.pid);
    const isOurs = (cmd) => /(minima|parlons-node)\.jar/.test(cmd)
      && (cmd.includes(dataDir) || cmd.includes("-port " + port) || cmd.includes("-Dparlons.node.port=" + port));
    for (const [pid, cmd] of candidates) {
      if (!isOurs(cmd)) {
        this.portOwner = { pid, command: cmd || "(unknown)" };
        return "port " + port + " is in use by " + (cmd ? cmd.slice(0, 120) : "another program") + " (pid " + pid + ") — choose another base port in Settings, or stop that program";
      }
      this.log("[app] a node from an earlier launch is still running (pid " + pid + ") — stopping it before starting");
      try { await Promise.race([rpcCall(this.rpcPort(), config.rpcSecret(), "quit"), sleep(8000)]); } catch (e) {}
      for (let i = 0; i < 16 && alive(pid); i++) await sleep(500);
      if (alive(pid)) { killPid(pid, "SIGTERM"); for (let i = 0; i < 10 && alive(pid); i++) await sleep(500); }
      if (alive(pid)) { killPid(pid, "SIGKILL"); for (let i = 0; i < 6 && alive(pid); i++) await sleep(500); }
      if (alive(pid)) return "could not stop the node left running by an earlier launch (pid " + pid + ")";
      this.log("[app] reclaimed a node left running by an earlier launch (pid " + pid + ")");
    }
    for (let i = 0; i < 10 && listeners(port).length; i++) await sleep(500);   // the kernel releases the socket
    try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
    this.portOwner = null;
    return "";
  }

  /** Last resort on the way out of the process: no waiting, no RPC — the node must not outlive us. */
  killNow() {
    const p = this.proc;
    if (p) { try { p.kill("SIGKILL"); } catch (e) {} this.proc = null; }
    try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
  }

  async start() {
    if (this.proc || this.starting) return;
    this.starting = true;
    try { await this.startInner(); } finally { this.starting = false; }
  }

  async startInner() {
    this.lastError = null;
    this.fatalHint = "";
    this.parlons = { ready: false, error: "", version: "", cape: false };
    this.setState("starting");
    const blocked = await this.reclaimStaleNode();
    if (blocked) { this.lastError = blocked; this.setState("error"); return; }
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
    this.startedTs = Date.now();
    const cfg = config.load();
    try {
      fs.writeFileSync(this.pidfilePath(), JSON.stringify({ pid: p.pid, port: cfg.basePort, jar: this.jarPath(),
        dataDir: cfg.dataFolder || config.defaultDataFolder(), startedAt: this.startedTs }));
    } catch (e) {}
    if (cfg.contribute) portmap.start(cfg.basePort);   // fire-and-forget; portmap self-retries (the relay shares this port)
    p.stdout.on("data", d => this.log(String(d)));
    p.stderr.on("data", d => this.log(String(d)));
    p.on("error", e => { this.lastError = e.message; this.setState("error"); this.proc = null; });
    p.on("exit", (code, sig) => {
      this.log("[app] node exited code=" + code + " sig=" + sig);
      this.proc = null;
      try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
      this.stopHealth();
      if (this.state !== "stopping") {
        this.lastError = this.fatalHint || ("node exited unexpectedly (" + (code ?? sig) + ")");
        this.setState("error");
        // The node died on its own — release the router port rather than leave it forwarding to nothing,
        // and stop the retry/watchdog timers. Only on UNEXPECTED exit: a planned stop() already released
        // it, and doing it here too would race the remap that restart()'s start() kicks off.
        portmap.stop().catch(e => {});
      } else this.setState("stopped");
    });
    this.startHealth();
  }

  /** Graceful stop: RPC quit (clean db close) → SIGTERM fallback. Resolves when the process is gone. */
  async stop() {
    await portmap.stop();                               // bounded (<~3s); re-mapped on the next start()
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

  async restart() { await this.stop(); await this.start(); }

  // ---- health ----
  startHealth() {
    this.stopHealth();
    const poll = async () => {
      if (!this.proc) return;
      try {
        const j = await rpcCall(this.rpcPort(), config.rpcSecret(), "status");
        const r = (j && j.response) || {};
        const prev = this.health || {};
        this.health = {
          version: r.version || "",
          block: (r.chain && r.chain.block) || 0,
          connections: (r.network && r.network.connected) || 0,
          locked: !!r.locked,
          megammr: !!r.megammr,   // GeneralParams.IS_MEGAMMR — gates the Web Wallet tab

          // direction-aware fields come from the `network` poll below — carry the last known values
          incoming: prev.incoming ?? 0,
          acceptingInLinks: prev.acceptingInLinks ?? null,
          p2pAddress: prev.p2pAddress || ""
        };
        // `status` reports no connection DIRECTIONS, so when contributing also poll `network` (every 3rd
        // tick) for the incoming count and the node's own reachability verdict — the only honest signal
        // that inbound actually works, since routers can accept a port mapping and still not open it.
        if (config.load().contribute && this.healthTick++ % 3 === 0) {
          try {
            const n = await rpcCall(this.rpcPort(), config.rpcSecret(), "network");
            const nr = (n && n.response) || {};
            const p2p = (nr.details && nr.details.p2p) || {};
            const conns = Array.isArray(nr.connections) ? nr.connections : [];
            // Count only INCOMING connections from OTHER hosts. Once the node knows its own public address
            // it feeds it to the peers-checker like any other peer, and with -allowallip it isn't filtered
            // out — so the node dials itself, hairpins back through the router, and that shows up as an
            // inbound peer. Counting it would let us claim "reachable" on the strength of talking to
            // ourselves. Verified live: nio_inbound 3 was really 2 external + 1 self.
            const selfIp = String(p2p.address || "").split(":")[0];
            const inbound = conns.filter(c => c && c.incoming);
            this.health.incoming = conns.length
              ? (selfIp ? inbound.filter(c => String(c.host || "") !== selfIp).length : inbound.length)
              : (typeof p2p.nio_inbound === "number" ? p2p.nio_inbound : 0);
            this.health.acceptingInLinks = typeof p2p.isAcceptingInLinks === "boolean" ? p2p.isAcceptingInLinks : null;
            this.health.p2pAddress = p2p.address || "";
          } catch (e) { /* keep the carried values */ }
        }
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
    const kind = this.kind();
    return { state: this.state, health: this.health, lastError: this.lastError, portOwner: this.portOwner || null,
             jar: this.jarPath(), rpcPort: this.rpcPort(), kind,
             parlons: Object.assign({ panelPort: this.panelPort(), capePort: this.capePort() }, this.parlons),
             contribute: !!config.load().contribute, portmap: portmap.status(),

             startedTs: this.proc ? this.startedTs : 0,
             uptimeMs: this.proc && this.startedTs ? Date.now() - this.startedTs : 0 };
  }
  /** The Parlons Node narrates its account in its log; that is the honest readiness signal. */
  watchParlonsLine(l) {
    if (!l.startsWith("[parlons-node]")) return;
    let changed = false;
    const m = l.match(/Parlons Node (\d+\.\d+\.\d+)/);
    if (m && !this.parlons.version) { this.parlons.version = m[1]; changed = true; }
    if (l.includes("account up:")) { this.parlons.ready = true; this.parlons.error = ""; changed = true; }
    if (l.includes("Maxima cape up on port")) { this.parlons.cape = true; changed = true; }
    if (l.includes("account layer FAILED") || l.includes("Maxima cape FAILED")) {
      this.parlons.error = l.replace(/^\[parlons-node\]\s*/, "").slice(0, 300); changed = true;
    }
    if (l.includes("REFUSING to start")) { this.parlons.error = l.replace(/^\[parlons-node\]\s*/, "").slice(0, 300); changed = true; }
    if (changed) this.emit("status", this.snapshot());
  }
  log(line) {
    for (let l of String(line).split("\n")) {
      if (!l.trim()) continue;
      try { this.watchParlonsLine(l); } catch (e) {}
      // The two boot-time deaths a person cannot read out of a stack trace: another node still holds
      // the H2 databases, or the port. Say so in the Node tab, in words, with the way out.
      if (/Database may be already in use|locked by another process|Address already in use|BindException/i.test(l)) {
        this.fatalHint = /Address already in use|BindException/i.test(l)
          ? "another node is still listening on port " + config.load().basePort + " — Restart node stops it and starts again"
          : "another node still holds this data folder's databases — Restart node stops it and starts again";
      }
      // Redact a seed phrase / private key if the node ever echoes one into an error line (the Web Wallet derives
      // & signs over loopback via `keys genkey phrase:"…"` / `sendfrom … privatekey:0x…`), so they can NEVER end
      // up in the Logs view.
      l = l.replace(/phrase:"[^"]*"/g, 'phrase:"•••"').replace(/privatekey:0x[0-9A-Fa-f]+/g, "privatekey:•••");
      this.logs.push(l.length > 400 ? l.slice(0, 400) + "…" : l);
    }
    if (this.logs.length > LOG_MAX_LINES) this.logs.splice(0, this.logs.length - LOG_MAX_LINES);
    this.emit("log");
  }
}

module.exports = new NodeManager();
