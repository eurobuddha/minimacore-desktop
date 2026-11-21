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
const parlonsNotify = require("./parlons-notify");
const { rpcCall } = require("./rpc");
const { createNodeLog, scrub } = require("./nodelog");
const keymode = require("./keymode");
const PARAMS = require("../renderer/params.js");
const flavor = require("./flavor");

const LOG_MAX_LINES = 800;
// Minima flags the Parlons Node refuses at boot (MinimaFlags.EXCLUDED): the app never passes them.
// The stock RPC ones are replaced by the node's loopback admin RPC (-Dparlons.node.rpc=true), which the
// app's RPC client reaches unchanged on basePort+4 (it ignores the Basic auth header).
const PARLONS_REFUSED = new Set(["rpc", "rpcenable", "rpcpassword", "rpccrlf", "seed", "anyseed", "dbpassword",
  "clean", "genesis", "test", "solo", "testchainlength", "daemon", "noshutdownhook", "jnlp", "help",
  // keetssidecar/keetsnode stay app-managed (buildParlonsArgs appends the bundled paths);
  // -keets itself now flows through: the pinned jar (0.2.124+) embeds the keets Minima
  // line. Pre-keets jars died on the flag, so the parlonsNode pin and this set move together.
  "keetssidecar", "keetsnode"]);
// A NAME, never a bare IP - see main/config.js megammrHost. The fork ships an empty node list, so this
// is the one peer a fresh install has; if it moves, that install has no way onto the network at all.
const PARLONS_DEFAULT_ROOTNODE = "eurobuddha.com:9001";
const HEALTH_EVERY_MS = 10_000;
// WHAT THE NODE PRINTS IS NOT ALL THE NODE'S OWN WORDS (0.19.104). Text from a remote party reaches its stdout: core
// logs a P2P peer's greeting version as it came, and the Parlons account logs fields of a contact's message. A line is
// therefore believed only when the WHOLE physical line is one the jar prints about itself:
//  - the block-mode boot line, exactly as core prints it (MinimaDB.loadAllDB: MinimaLogger.log("Using NEW Block number
//    as key uses keys!"), and MinimaLogger's prefix "Minima @ dd/MM/yyyy HH:mm:ss [<memory>] : "), anchored at both ends;
//  - the Parlons Node's status lines by the exact prefix it prints them with (ParlonsNodeMain, MinimaFlags), from the
//    first character of the line.
const BLOCK_BOOT_LINE = /^Minima @ \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} \[[0-9.,]{1,8} (?:bytes|[ KMGTPE]B)\] : Using NEW Block number as key uses keys!$/;
const PARLONS = { version: /^\[parlons-node\] Parlons Node (\d+\.\d+\.\d+) /, up: "[parlons-node] account up: ", cape: "[parlons-node] Maxima cape up on port ",
  failed: ["[parlons-node] account layer FAILED to start: ", "[parlons-node] Maxima cape FAILED to start: "], refusing: "[parlons-node] REFUSING to start: " };
const CONT_MAX = 64;           // the most lines read as the continuation of one cut line (nodeLine)
const LINE_MAX = 64 * 1024;   // a "line" the node never ends is cut here (it is then judged as the pieces it arrives in)
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

/**
 * Render an argv for the log with every secret value replaced, never merely shortened.
 *
 * Any flag the params manifest marks `type:"secret"` (-rpcpassword, -dbpassword, the -mysql DSN …) has its
 * VALUE dropped, whether it arrives as `-flag value` or as a single `-Dkey=value`. The rpcSecret is also
 * substring-replaced because the Parlons kind folds the whole Minima flag string into one -D argument.
 */
function redactArgs(args, rpcSecret) {
  const PARAMS = require("../renderer/params.js");
  const secretFlags = new Set();
  for (const g of PARAMS.GROUPS) for (const it of g.items) if (it.type === "secret") secretFlags.add(it.flag);
  secretFlags.add("rpcpassword");
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const flag = a.replace(/^-+/, "").split("=")[0].toLowerCase();
    if (a.startsWith("-") && secretFlags.has(flag)) {
      if (a.includes("=")) { out.push(a.slice(0, a.indexOf("=") + 1) + "•••"); continue; }
      out.push(a); if (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) { out.push("•••"); i++; }
      continue;
    }
    out.push(a.length > 60 ? a.slice(0, 57) + "…" : a);
  }
  let line = out.join(" ");
  if (rpcSecret) line = line.split(rpcSecret).join("•••");
  for (const f of secretFlags) {                       // inside the one quoted -Dparlons.node.args= blob
    line = line.replace(new RegExp("(-" + f + "\\s+)(\"[^\"]*\"|\\S+)", "gi"), "$1•••");
  }
  return line;
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
    this.health = null;           // { block, time, version, connections, incoming, acceptingInLinks, p2pAddress }
    this.healthTimer = null;
    this.healthTick = 0;
    this.startedTs = 0;
    this.wasMapped = false;
    this.lastNetRestart = 0;
    this.spawnFn = spawn;         // the one place java is launched from (scripts/keymode-test.cjs puts a stand-in here)
    this.sys = { listeners, commandOf, alive, killPid, sleep };   // what is asked of the OS about other processes (scripts/flavor-test.cjs puts stand-ins here)
    this.rpc = (cmd) => rpcCall(this.rpcPort(), config.rpcSecret(), cmd);   // this node's RPC (the tests put a stand-in here too)
    this.keyModeChecked = false;  // the running node's keys were read and are of the recorded mode (once per start)
    this.polled = false;          // this node start has answered a health poll: its boot is over (the boot line is believed only before)
    this.carry = { out: "", err: "" };   // the unfinished last line of each of the node's streams
    this.cont = { out: null, err: null };   // per stream: what follows is the CONTINUATION of a cut line, read by nothing (nodeLine)
    this.secret = "";             // the RPC secret of this node start, for log() to take out of every line
    this.replacingWallet = false; // a wallet-replacing megammrsync is running (runResync): it holds the trading engines
    this.walletCheck = null;      // owed after a wallet-replacing megammrsync: { before, held, final, tries } (runResync, walletSettle)
    this.keyModeAlert = "";       // the running node was found in the OTHER mode and stopped: no start until the app is reopened
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

  /**
   * THE one answer to "can the bundled node run a block-as-key-uses wallet?", for whichever jar this node
   * kind runs. Read from the jar itself, once (main/keymode.js). False for both jars shipped today.
   */
  blockKeysSupported() { return keymode.jarSupportsBlock(this.jarPath()); }

  /** Why the node must not start with the wallet's recorded key mode ("" = it may). See keymode.startProblem. */
  keyModeProblem() {
    const cfg = config.load();
    return keymode.startProblem({ mode: cfg.keyMode, supported: this.blockKeysSupported(),
      folderMode: keymode.folderKeyMode(cfg.dataFolder || config.defaultDataFolder()), extraArgs: cfg.extraArgs,
      params: cfg.params, confFile: cfg.params && cfg.params.conf });
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

    // keets transport: app-managed sidecar path + runtime. The jar's KeetsManager sets
    // ELECTRON_RUN_AS_NODE=1 on the child, so our own Electron binary IS the node runtime —
    // no system node needed.
    if (params.keets) {
      const sidecar = app.isPackaged
        ? path.join(process.resourcesPath, "keets-sidecar", "index.js")
        : path.join(__dirname, "..", "resources", "keets-sidecar", "index.js");
      args.push("-keetssidecar", sidecar, "-keetsnode", process.execPath);
    }

    // The wallet's key mode: -blockaskeyuses -lowram for a block wallet, neither for a classic one.
    args.push(...keymode.startFlags(cfg.keyMode));

    // Additional raw args, appended verbatim (quote-aware split). Never a key-mode flag (start() refuses those first).
    for (const tok of tokenizeArgs(cfg.extraArgs)) if (!PARAMS.keyModeArg(tok)) args.push(tok);
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
    flags.push(...keymode.startFlags(cfg.keyMode));   // the wallet's key mode (see buildArgs)
    for (const tok of tokenizeArgs(cfg.extraArgs)) {
      const key = tok.replace(/^-+/, "").toLowerCase();
      if (PARAMS.keyModeArg(tok)) continue;
      if (tok.startsWith("-") && PARLONS_REFUSED.has(key)) continue;
      flags.push(/\s/.test(tok) ? q(tok) : tok);
    }
    // keets transport, same as the minima kind: app-managed sidecar path + runtime.
    // The jar's KeetsManager sets ELECTRON_RUN_AS_NODE=1 on the child, so our own
    // Electron binary IS the node runtime. `-keets` itself came through the params
    // loop above (def true), so only add the pair when it did.
    if (params.keets) {
      const sidecar = app.isPackaged
        ? path.join(process.resourcesPath, "keets-sidecar", "index.js")
        : path.join(__dirname, "..", "resources", "keets-sidecar", "index.js");
      flags.push("-keetssidecar", q(sidecar), "-keetsnode", q(process.execPath));
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
      "-Dparlons.gateway.port=" + (cfg.basePort + 584),
      // KeetChat lives in THIS app's Chat tab on both kinds (0.18.17+): the jar's own keets
      // bridge must stand down or two drainers would steal the inbox from each other.
      // Parlons keeps Parlons (Maxima) chats; keets chats come into KeetChat.
      "-Dparlons.node.keetschat=off"
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
  /** <userData>/node.log, opened lazily (userData is not resolvable at require time). */
  diskLog() {
    if (!this._diskLog) {
      try { this._diskLog = createNodeLog(app.getPath("userData")); }
      catch (e) { this._diskLog = { append() {} }; }   // no userData yet (headless/test) → RAM ring only
    }
    return this._diskLog;
  }

  /**
   * EVERY TCP port this app's node listens on, each derived from the base port (or, for the RPC, set by hand):
   *   base        the node's P2P port; when contributing, the Maxima relay shares it
   *   base + 4    the node's RPC (rpcPortManual overrides)
   *   base + 5    the keets sidecar's loopback API (the sidecar's own default: its --port + 5), when keets is on
   *   base + 584  the Parlons wallet gateway, and base + 586 the Parlons panel (Parlons Node kind)
   * base + 1 to base + 3 are Minima's by convention (its MiniDapp System); this node line has none and binds none.
   */
  ports() {
    const cfg = config.load(), b = cfg.basePort, out = [{ port: b, what: "the node's P2P port" }, { port: this.rpcPort(), what: "the node's RPC" }];
    let keets = false; try { keets = !!config.effectiveParams().keets; } catch (e) {}
    if (keets) out.push({ port: b + 5, what: "the keets sidecar" });
    if (this.kind() === "parlons") out.push({ port: b + 584, what: "the Parlons wallet gateway" }, { port: this.panelPort(), what: "the Parlons panel" });
    return out;
  }

  /** Is this command line a node of THIS profile? A minima / parlons-node jar AND this profile's own data folder,
   *  whole (followed by a space, a quote or the end: /x/node-data is not /x/node-data-2). */
  ownNode(cmd) {
    const dir = this.dataDir(); cmd = String(cmd || "");
    if (!dir || !/(minima|parlons-node)\.jar/.test(cmd)) return false;
    return cmd.endsWith(dir) || [" ", '"', "'"].some(end => cmd.includes(dir + end));
  }

  /**
   * Before spawning. Two separate things (0.19.105; before this, anything LISTENING on our port whose command line
   * named a node jar and "-port <ours>" was stopped: a node of ANOTHER app or profile on that port would have been
   * sent `quit`, SIGTERM and SIGKILL):
   *
   * 1. OUR OWN node from an earlier launch (the app crashed, was force-quit, or its stop threw) still holds the port
   *    and the H2 databases. It is found ONLY through this profile's own pidfile, and is ours ONLY while that pid
   *    still runs a node jar on THIS profile's data folder (pids are reused: on 17 Nov 2026 a pidfile's pid had become
   *    a macOS XPC service). That one process is stopped: RPC `quit` when it is the one listening on our RPC port,
   *    then SIGTERM, then SIGKILL, each bounded.
   * 2. Every port the node needs (ports()) must then be free. A port held by ANYTHING ELSE is reported, with the
   *    port and what holds it, and the node is not started. That process is never sent a command or a signal.
   *
   * Returns "" (go ahead) or the reason not to start.
   */
  async reclaimStaleNode() {
    const S = this.sys;
    this.portOwner = null;
    let mine = 0;
    try {
      const pf = JSON.parse(fs.readFileSync(this.pidfilePath(), "utf8")), pid = pf && Number(pf.pid);
      if (pid > 0 && pid !== process.pid && S.alive(pid) && this.ownNode(S.commandOf(pid))) mine = pid;
      else try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
    } catch (e) { /* no pidfile */ }
    if (mine) {
      this.log("[app] this app's node from an earlier launch is still running (pid " + mine + ") — stopping it before starting");
      // `quit` goes to whoever answers on the RPC port: sent only when that IS the process just identified
      if (S.listeners(this.rpcPort()).includes(mine)) { try { await Promise.race([this.rpc("quit"), S.sleep(8000)]); } catch (e) {} }
      for (let i = 0; i < 16 && S.alive(mine); i++) await S.sleep(500);
      if (S.alive(mine)) { S.killPid(mine, "SIGTERM"); for (let i = 0; i < 10 && S.alive(mine); i++) await S.sleep(500); }
      if (S.alive(mine)) { S.killPid(mine, "SIGKILL"); for (let i = 0; i < 6 && S.alive(mine); i++) await S.sleep(500); }
      if (S.alive(mine)) return "could not stop this app's node left running by an earlier launch (pid " + mine + ")";
      this.log("[app] stopped this app's node left running by an earlier launch (pid " + mine + ")");
    }
    for (const { port, what } of this.ports()) {
      let held = S.listeners(port).filter(pid => pid !== process.pid);
      for (let i = 0; mine && i < 10 && held.length; i++) { await S.sleep(500); held = S.listeners(port).filter(pid => pid !== process.pid); }   // the kernel releases our old node's socket
      if (!held.length) continue;
      const pid = held[0], cmd = S.commandOf(pid);
      this.portOwner = { pid, port, command: cmd || "(unknown)" };
      const why = "Port " + port + " (" + what + ") is in use by " + (cmd ? cmd.slice(0, 160) : "another program") + " (pid " + pid + "). " + flavor.productName
        + " did not start its node and did not touch that program. Stop that program, or choose another base port in Startup Params.";
      this.log("[app] node NOT started: " + why);
      return why;
    }
    try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
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
    this.keyModeChecked = false; this.polled = false; this.carry = { out: "", err: "" }; this.cont = { out: null, err: null };
    if (this.keyModeAlert) { this.lastError = this.keyModeAlert; this.log("[app] node NOT started: " + this.keyModeAlert); this.setState("error"); return; }
    // Before anything else: a wallet is only ever started in the key mode it was made in. A block wallet on a
    // jar that cannot run it is REFUSED, never started classic (that would add classic keys to it for good).
    const keyWhy = this.keyModeProblem();
    if (keyWhy) { this.lastError = keyWhy; this.log("[app] node NOT started: " + keyWhy); this.setState("error"); return; }
    // THE gate, on the argv as it will really be run (either node kind): the key-mode tokens in it must be
    // exactly the recorded mode's, whatever field they came from. See keymode.argvProblem.
    const args = this.buildArgs();
    const argvWhy = keymode.argvProblem(args, config.load().keyMode, this.dataDir());
    if (argvWhy) { this.lastError = argvWhy; this.log("[app] node NOT started: " + argvWhy); this.setState("error"); return; }
    // A fact of THIS launch, for the first-run seed step (main.js mcd:firstRunSeed, 0.19.220): did the data folder hold no
    // node data (nothing but a key-mode marker) when this launch first started the node? Read once, before java touches it.
    if (this.freshAtFirstStart == null) { const d = this.dataDir(); let names = []; try { names = fs.readdirSync(d); } catch (e) { names = []; } this.freshAtFirstStart = !names.some(n => !n.startsWith(".") && n !== keymode.MARKER); }
    // A block wallet's folder always says so before the node touches it: a folder changed to an empty one had no
    // marker, was read as classic on the next start (locked out), and a lost config would have started it classic.
    if (config.load().keyMode === "block") {
      try { keymode.markBlockFolder(this.dataDir()); }
      catch (e) { this.lastError = "The data folder could not be marked as a block key wallet (" + e.message + "). The node was not started."; this.log("[app] node NOT started: " + this.lastError); this.setState("error"); return; }
    }
    this.setState("starting");
    const blocked = await this.reclaimStaleNode();
    if (blocked) { this.lastError = blocked; this.setState("error"); return; }
    // Redact EVERY secret, not just the RPC password. effectiveParams() resolves the Keychain markers back to
    // their real values before they become argv, so a -mysql DSN (password and all) was going into the Logs
    // view; truncating each arg at 57 chars only clipped the tail, it still showed the head of the credential.
    this.secret = config.rpcSecret();   // kept for log(): the node prints its own start parameters, and no line may carry this
    this.log("[app] starting node: java " + redactArgs(args, this.secret));
    let p;
    try {
      p = this.spawnFn(this.javaPath(), args, { stdio: ["ignore", "pipe", "pipe"], env: keymode.childEnv(process.env) });
    } catch (e) {
      this.lastError = "could not launch java: " + e.message;
      this.setState("error");
      return;
    }
    this.proc = p;
    if (this.walletCheck) this.walletCheck.final = true;   // megammrsync has ended with the old process: what this node holds is the result
    this.startedTs = Date.now();
    const cfg = config.load();
    try {
      fs.writeFileSync(this.pidfilePath(), JSON.stringify({ pid: p.pid, port: cfg.basePort, jar: this.jarPath(),
        dataDir: cfg.dataFolder || config.defaultDataFolder(), startedAt: this.startedTs }));
    } catch (e) {}
    if (cfg.contribute) portmap.start(cfg.basePort);   // fire-and-forget; portmap self-retries (the relay shares this port)
    // Output still arriving from a process a NEW start has replaced is not mixed into the new one's lines (0.19.173).
    p.stdout.on("data", d => { if (!this.proc || this.proc === p) this.nodeSaid("out", d); });
    p.stderr.on("data", d => { if (!this.proc || this.proc === p) this.nodeSaid("err", d); });
    // The unfinished last line of each stream is written out on "close", once both streams have ended (0.19.173). On
    // "exit" the pipes may still hold output: what came after it was kept back for a line end that never comes.
    p.on("close", () => {
      if (this.proc && this.proc !== p) return;   // a new start has its own buffers now
      for (const k of ["out", "err"]) { const rest = this.carry[k]; this.carry[k] = ""; if (rest) this.nodeLine(rest, k); }   // a last line with no line end
    });
    p.on("error", e => { this.lastError = e.message; this.setState("error"); this.proc = null; });
    p.on("exit", (code, sig) => {
      this.log("[app] node exited code=" + code + " sig=" + sig);
      this.proc = null;
      try { fs.unlinkSync(this.pidfilePath()); } catch (e) {}
      this.stopHealth();
      if (this.resyncing && !this.fatalHint) this.setState("stopped");   // megammrsync ends by shutting the node down: expected, and runResync starts it again
      else if (this.state !== "stopping") {
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
    // The engines finish what they have at the node BEFORE it is told to quit (main.js onStopping; each wait is bounded
    // by its owner, and 30 s here in any case): a transaction posted in the node's last second is then recorded.
    if (typeof this.onStopping === "function") { try { await Promise.race([this.onStopping(), sleep(30_000)]); } catch (e) {} }
    // Bounded, always. The interval used to clear ONLY when this.proc went null, so if neither signal reaped
    // the child (an unkillable/zombie process, or kill() throwing EPERM) this promise never settled — and
    // before-quit awaits it after preventDefault(), so the app hung on quit with no window to close.
    const gone = new Promise(res => {
      const t = setTimeout(() => { try { this.proc && this.proc.kill("SIGTERM"); } catch (e) {} }, 12_000);
      const t2 = setTimeout(() => { try { this.proc && this.proc.kill("SIGKILL"); } catch (e) {} }, 25_000);
      const deadline = setTimeout(() => { finish(); }, 35_000);
      const iv = setInterval(() => { if (!this.proc) finish(); }, 300);
      const finish = () => { clearTimeout(t); clearTimeout(t2); clearTimeout(deadline); clearInterval(iv); res(); };
    });
    try { await this.rpc("quit"); } catch (e) { /* fall through to signals */ }
    await gone;
  }

  /**
   * Is the RUNNING node in the wallet's recorded key mode? A flag name inside the jar does not prove the node
   * (the Parlons wrapper above all) acted on it, so its own keys are read once it answers: `keys` lists them
   * with their shape and neither signs nor creates one. Keys of the other kind: the node is stopped at once and
   * is not started again in this run. No keys yet, or no answer: asked again on the next health tick.
   * Returns false when the node was stopped.
   */
  async verifyKeyMode() {
    if (this.keyModeChecked || this.keyModeAlert) return !this.keyModeAlert;
    const mode = config.load().keyMode;
    let seen = "";
    try { seen = keymode.keysMode(await this.rpc("keys")); } catch (e) { return true; }
    if (!seen) return true;
    if (seen === mode) { this.keyModeChecked = true; this.log("[app] key mode verified on the running node: " + mode); return true; }
    await this.keyModeMismatch(seen === "mixed" ? "The wallet in this node holds keys of both kinds, classic and block" : "The node is running with " + seen + " keys", mode, false);
    return false;
  }
  async keyModeMismatch(what, mode, now) {
    this.keyModeAlert = what + ", but this wallet is recorded as a " + mode + " key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. "
      + "Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on.";
    this.log("[app] KEY MODE MISMATCH, stopping the node: " + this.keyModeAlert);
    this.fatalHint = this.keyModeAlert;
    if (now) { try { this.proc && this.proc.kill("SIGKILL"); } catch (e) {} return; }   // before the wallet is open: nothing to close cleanly
    await this.stop();
    this.lastError = this.keyModeAlert; this.setState("error");
  }

  async restart() { await this.stop(); await this.start(); }

  /**
   * megammrsync action:resync. When it succeeds the node saves everything and shuts its own insides down ("please
   * restart"), and its process may exit by itself: that exit is expected here, not an error. The node is then
   * started again through the ordinary start(), so every key-mode check runs on it (the gate on the start command
   * before java, the node's real mode once it answers). A refused command leaves the node as it was.
   *
   * A command that replaces the wallet (phrase: or file:), since 0.18.116:
   *  1. the trading engines are stopped BEFORE it is sent and stay stopped (onEnginesHold: AtomiX, PandaPools,
   *     Dexicon), so none signs between the node's wallet swap and its shutdown;
   *  2. the wallet is identified before (walletMark) and after, and the engines' stores are set aside
   *     (onWalletReplaced) only when the wallet IS another one. A failed or unanswered command on an unchanged wallet
   *     moves nothing: atomix.sqlite holds the claim secrets of swaps in flight. The same wallet restored again
   *     keeps every store;
   *  3. the engines are released (onEnginesRelease) once that is settled, on their own stores or on new ones.
   * When the wallet could not be identified beforehand (a locked node), there is nothing to compare: the stores are
   * set aside as before 0.18.116 (after a success, and when the result is not known). Never deleted either way.
   */
  async runResync(cmd) {
    const restore = require("./restore"), replaces = restore.replacesWalletFromPhrase(cmd) || restore.loadsBackupFile(cmd);
    this.resyncing = true; this.emit("status", this.snapshot());
    try {
      let w = null;
      if (replaces) {
        this.replacingWallet = true;   // from before the engines are held until this command has ended: the hold is the replacement's (main/freeze.js does not release it)
        try { if (typeof this.onEnginesHold === "function") await this.onEnginesHold(); }
        catch (e) { await this.releaseEngines(); throw new Error("The trading engines could not be stopped (" + ((e && e.message) || e) + "), so the wallet was not replaced. Nothing was changed."); }
        w = this.walletCheck = { before: await this.walletMark(), held: true, final: false, tries: 0 };
        this.log("[app] wallet replacement: AtomiX, PandaPools and Dexicon are stopped until it is settled" + (w.before ? "" : "; this wallet could not be identified beforehand (is the node locked?), so the old stores will be set aside without a comparison"));
      }
      // nothing to compare with: as before 0.18.116
      const legacy = async () => { await this.walletReplaced(true); this.walletCheck = null; await this.releaseEngines(); };
      let j;
      try { j = await this.rpc(cmd); }
      catch (e) {
        if (this.proc) {
          // No answer, and the node is still there: it may still be resyncing, and may still swap the wallet. What
          // can be read is read now; the check stays owed (the health poll asks again, and at the next start).
          // No answer is not an end (0.19.219): the engines stay held until the mark is conclusive (another wallet, or the
          // node started again), never released on "the same wallet" while the node may still swap it.
          if (w) { w.unsure = true; if (w.before) await this.walletSettle(); else await legacy(); }
          throw new Error(e.message + ". The node did not answer, and it may still be resyncing: watch the Logs, and restart the node when it says it has finished.");
        }
        if (w && !w.before) await legacy();   // node stopped: set aside before it is started again
        await this.start();                   // w.before known: settled by the health poll before the node is called "running"
        throw new Error("The node stopped before it answered, so the result is not known. It was started again: check the wallet and the chain before going on.");
      }
      if (j && j.status === true) {
        await this.stop();
        if (w && !w.before) await legacy();   // node stopped, the old identity's stores set aside, only then started again
        await this.start();                   // w.before known: compared before the node is called "running" (walletSettle)
      } else if (w) {
        // Refused. The command has ended, so what the wallet is now is final.
        if (w.before) { w.final = true; await this.walletSettle(); }
        else { this.walletCheck = null; await this.releaseEngines(); }
      }
      return j;
    } finally { this.resyncing = false; this.replacingWallet = false; this.emit("status", this.snapshot()); }
  }
  /** A megammrsync that puts another wallet under the app (phrase: or file:) has run, or may have. main.js sets
   *  onWalletReplaced: every identity-bound store is invalidated there, in the main process. Never throws: a store
   *  that could not be set aside is said in the log, and its engine refuses to start on it by itself. */
  async walletReplaced(replaces) {
    if (!replaces || typeof this.onWalletReplaced !== "function") return;
    try { await this.onWalletReplaced(); } catch (e) { this.log("[app] WALLET REPLACED, but not every old store could be set aside: " + ((e && e.message) || e)); }
  }
  async releaseEngines() {
    try { if (typeof this.onEnginesRelease === "function") await this.onEnginesRelease(); } catch (e) { this.log("[app] the trading engines could not be started again: " + ((e && e.message) || e)); }
  }
  /** Which wallet is under the node: a digest of the node's own one-way derivation from its seed (`seedrandom`, as
   *  AtomiX and Dexicon derive their identities). Equal = the same seed, different = another one. null = it could
   *  not be read (no answer, a locked node): then nothing is concluded. The value itself is never kept or logged. */
  async walletMark() {
    try {
      const r = await this.rpc("seedrandom modifier:minimacore-desktop-wallet-mark-v1");
      const v = r && r.status === true && r.pending !== true && r.response ? String(r.response.seedrandom || "") : "";
      return /^0x[0-9A-Fa-f]{64}$/.test(v) ? require("crypto").createHash("sha256").update(v.toLowerCase()).digest("hex") : null;
    } catch (e) { return null; }
  }
  /**
   * Settle an owed wallet check (runResync) from what the node says NOW. Called by runResync, and by the health
   * poll before the node is called "running" and on every tick while a check is owed.
   *  - the same wallet: the engines are released on their stores, untouched. The check ends once it is final (the
   *    command was refused, or the node has been started again since); until then the node may still swap.
   *  - another wallet: the engines are held, the stores set aside, the engines released on new ones.
   *  - not readable: nothing is concluded and the engines stay as they are; asked again on the next tick.
   * Returns false while a restarted node must not be called "running" yet (not readable; given up after 6 tries,
   * the engines then stay stopped until it can be read).
   */
  async walletSettle() {
    const w = this.walletCheck; if (!w) return true;
    const now = await this.walletMark();
    if (this.walletCheck !== w) return true;
    if (!now) {
      if (w.final && ++w.tries === 7) this.log("[app] the wallet cannot be identified after the restore (is the node locked?): AtomiX, PandaPools and Dexicon stay stopped, and their stores untouched, until it can be read");
      return !w.final || !w.held || w.tries > 6;
    }
    if (now === w.before) {
      // The same wallet is not conclusive while the megammrsync is still at the node, or after it went unanswered and the
      // node has not been started again since (0.19.219: the health poll released the held engines mid-replacement)
      if (!w.final && (this.resyncing || w.unsure)) return true;
      if (w.final) { this.walletCheck = null; this.log("[app] the wallet is the same one as before: every store stays in place"); }
      if (w.held) { w.held = false; await this.releaseEngines(); }
      return true;
    }
    this.log("[app] the node now holds ANOTHER wallet: the old wallet's stores are set aside (never deleted)");
    const was = this.replacingWallet; this.replacingWallet = true;   // the stores are being set aside: nothing else may release the engines meanwhile (main/freeze.js)
    try {
      if (!w.held && typeof this.onEnginesHold === "function") { try { await this.onEnginesHold(); } catch (e) {} }
      this.walletCheck = null;
      await this.walletReplaced(true);
    } finally { this.replacingWallet = was; }
    await this.releaseEngines();
    return true;
  }

  // ---- health ----
  startHealth() {
    this.stopHealth();
    const poll = async () => {
      if (!this.proc) return;
      try {
        const j = await this.rpc("status");
        this.polled = true;   // the node answers: its boot is over, and with it the time in which its boot line is believed
        const r = (j && j.response) || {};
        const prev = this.health || {};
        this.health = {
          version: r.version || "",
          block: (r.chain && r.chain.block) || 0,
          time: (r.chain && r.chain.time) || "",   // the tip block's time, for the footer's "block @ time"
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
            const n = await this.rpc("network");
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
        // Before the app calls the node "running" (which starts every module on it): are its keys of the recorded mode?
        if (!this.keyModeChecked && !(await this.verifyKeyMode())) return;
        // ...and, after a wallet-replacing megammrsync, is the wallet another one? (the old stores are set aside first)
        if (this.walletCheck && !(await this.walletSettle())) return;
        if (!this.proc || this.state === "stopping") return;
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
             jar: this.jarPath(), rpcPort: this.rpcPort(), kind, keyMode: config.load().keyMode, keyModeAlert: this.keyModeAlert, resyncing: !!this.resyncing,
             parlons: Object.assign({ panelPort: this.panelPort(), capePort: this.capePort() }, this.parlons),
             contribute: !!config.load().contribute, portmap: portmap.status(),

             startedTs: this.proc ? this.startedTs : 0,
             uptimeMs: this.proc && this.startedTs ? Date.now() - this.startedTs : 0 };
  }
  /**
   * The node's own output, one stream's chunk. Split into PHYSICAL lines, on \n and on \r, an unfinished last line
   * kept for the next chunk; each line is judged alone (nodeLine), so text carrying a line end cannot bring a prefix
   * of its own into the middle of a believed line, and a line is never judged by half.
   */
  nodeSaid(stream, chunk) {
    const parts = (this.carry[stream] + String(chunk)).split(/[\r\n]/);
    let rest = parts.pop();
    const ended = parts.length;   // these were ended by a line end; one more is a line cut at LINE_MAX
    if (rest.length > LINE_MAX) { parts.push(rest); rest = ""; }
    this.carry[stream] = rest;
    parts.forEach((l, i) => {
      this.nodeLine(l, stream);
      // What follows a line cut at LINE_MAX, up to that line's own end, is the rest of the SAME line: whoever filled
      // it chose where the cut falls, so the rest could begin exactly as one of the node's own lines does.
      if (i >= ended) this.cont[stream] = { until: null, left: 1 };
    });
  }
  /** One physical line of the node's output: control characters out, then what it may tell the app, then the log. */
  nodeLine(raw, stream = "out") {
    const l = String(raw).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, "");   // control characters and the bidirectional controls
    // A CONTINUATION is never a fresh line (0.19.4's guard, back in 0.19.106): the rest of a line cut at LINE_MAX, and
    // what follows a call-signal or greeting line that a peer's own line end cut short, up to the line carrying the
    // node's ending (parlonsNotify.unfinished). It is logged, marked, and read by nothing: no flag, no boot line, no
    // notification. (A peer who also imitates the node's ending is not caught here: plan section 11.)
    const c = this.cont[stream];
    if (c) {
      if ((c.until && c.until.test(l)) || --c.left <= 0) this.cont[stream] = null;
      if (l.trim()) this.log("(continued) " + parlonsNotify.redact(l));
      return;
    }
    if (!l.trim()) return;
    // ponytail: a run ends after CONT_MAX lines even without its ending, so a call line this table does not know
    // cannot silence the rest of the node's output for good.
    const until = parlonsNotify.unfinished(l);
    if (until) this.cont[stream] = { until, left: CONT_MAX };
    // This branch only (0.19.3): a Parlons message or call line carries text a REMOTE party chose. It is read by the
    // notifier's anchored parser and by nothing below, and a message's own words stay out of the Logs view and node.log.
    if (parlonsNotify.isChatter(l)) {
      try { const ev = parlonsNotify.parse(l); if (ev && this.proc) this.emit("parlons-event", ev); } catch (e) {}
      this.log(parlonsNotify.redact(l));
      return;
    }
    try { this.watchParlonsLine(l); } catch (e) {}
    // The node says so itself, as it opens its databases and before it loads the wallet: block mode is ON. For a
    // classic wallet that is the forbidden start, caught earlier than any RPC could answer. Believed ONLY as the whole
    // line core prints, and ONLY before this start's first answered health poll: a running node no longer prints it,
    // and from then on the `keys` shape check (verifyKeyMode) is the authority.
    if (!this.polled && this.proc && !this.keyModeAlert && BLOCK_BOOT_LINE.test(l) && config.load().keyMode !== "block")
      this.keyModeMismatch("The node started in block key mode", config.load().keyMode, true);
    // The two boot-time deaths a person cannot read out of a stack trace: another node still holds
    // the H2 databases, or the port. Say so in the Node tab, in words, with the way out. (A hint only: it is shown
    // when the node has died by itself, and changes nothing else.)
    if (/Database may be already in use|locked by another process|Address already in use|BindException/i.test(l)) {
      this.fatalHint = /Address already in use|BindException/i.test(l)
        ? "a port this node needs is already in use (base port " + config.load().basePort + "). Start again: this app's own earlier node is stopped first; any other program is named and left alone"
        : "another node still holds this data folder's databases. Start again: if it is this app's own earlier node it is stopped first";
    }
    this.log(l);
  }
  /** The Parlons Node narrates its account in its log; that is the honest readiness signal. Only ITS OWN status lines:
   *  each by the exact prefix the jar prints it with, from the first character of a physical line (nodeLine). */
  watchParlonsLine(l) {
    // ...and only UNTIL THE ACCOUNT IS UP for this node start: every one of these is a boot line (ParlonsNodeMain prints
    // the version, the cape and a start failure before "account up"), and nothing a peer sends through the account
    // exists before it. After it, a forged line, even a whole one, changes no flag.
    if (this.parlons.ready || !l.startsWith("[parlons-node] ")) return;
    let changed = false;
    const m = PARLONS.version.exec(l);
    if (m && !this.parlons.version) { this.parlons.version = m[1]; changed = true; }
    if (l.startsWith(PARLONS.up)) { this.parlons.ready = true; this.parlons.error = ""; changed = true; }
    if (l.startsWith(PARLONS.cape)) { this.parlons.cape = true; changed = true; }
    if (PARLONS.failed.some(p => l.startsWith(p)) || l.startsWith(PARLONS.refusing)) { this.parlons.error = l.slice("[parlons-node] ".length).slice(0, 300); changed = true; }
    if (changed) this.emit("status", this.snapshot());
  }
  log(line) {
    for (let l of String(line).split(/[\r\n]/)) {
      if (!l.trim()) continue;
      // What the node's output may TELL the app is decided in nodeLine (the node's streams only), never here: this
      // function also takes the app's own lines and, through them, text that came from elsewhere.
      // Redact a seed phrase / private key if the node ever echoes one into an error line (the Web Wallet derives
      // & signs over loopback via `keys genkey phrase:"…"` / `sendfrom … privatekey:0x…`), so they can NEVER end
      // up in the Logs view; and the RPC secret, which the node prints with its start parameters; and the
      // bidirectional controls (main/nodelog.js scrub). Before the 400-character cut, so no part of one is left.
      l = scrub(l, this.secret);
      this.logs.push(l.length > 400 ? l.slice(0, 400) + "…" : l);
      // The same redacted line, on disk and untruncated (main/nodelog.js): the RAM ring holds ~800 lines,
      // and the one line that explained a lost swap had rolled out of it long before anyone looked.
      this.diskLog().append(l);
    }
    if (this.logs.length > LOG_MAX_LINES) this.logs.splice(0, this.logs.length - LOG_MAX_LINES);
    this.emit("log");
  }
}

module.exports = new NodeManager();
module.exports.BLOCK_BOOT_LINE = BLOCK_BOOT_LINE;
