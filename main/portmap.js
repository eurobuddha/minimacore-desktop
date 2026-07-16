/*
 * portmap.js — asks the home router to forward the Minima P2P port (TCP) to this machine, so a
 * "Contribute to the network" node can accept inbound connections without manual port-forwarding.
 *
 * Uses @silentbot1/nat-api, which tries NAT-PMP first then UPnP-IGD, and — critically — speaks IGD
 * **v1** (`WANIPConnection:1` + `AddPortMapping`) as well as v2. That matters: the common MiniUPnPd
 * stack on consumer routers (TP-Link et al) only offers IGD v1, and an IGD-v2-only client fails on it
 * with "Service not found" (verified against a real TP-Link here — the reason this isn't
 * @achingbrain/nat-port-mapper).
 *
 * `AddPortMapping` maps the requested external port exactly or fails, so external always == internal —
 * which is what the jar requires, since it advertises its own listen port (P2PGreeting.myMinimaPort).
 * Lease renewal is the library's autoUpdate; a watchdog re-checks the external IP so laptop sleep/wake
 * and router reboots recover on their own. All of this lives in the main process — the renderer CSP
 * allows no network access.
 */
const EventEmitter = require("events");
const os = require("os");
const dgram = require("dgram");
const { execFile } = require("child_process");

const MAP_TTL_S = 3600;                          // 1h lease; the lib re-maps 10 min before expiry
const IP_TIMEOUT_MS = 12_000;
const MAP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 3_000;
const WATCHDOG_MS = 15 * 60_000;
const RETRY_MS = [60_000, 300_000, 1_800_000];   // 1m, 5m, then every 30m — networks change on wake

/** RFC1918 + CGNAT (100.64/10) + link-local: an "external" IP in these ranges means double NAT. */
function isPrivateIp(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(String(ip || ""));
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
         (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

/** macOS default route → { gateway, iface }. */
function defaultRoute() {
  return new Promise(resolve => {
    execFile("route", ["-n", "get", "default"], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const gw = /gateway:\s*([0-9.]+)/.exec(out);
      const ifc = /interface:\s*(\S+)/.exec(out);
      resolve(gw ? { gateway: gw[1], iface: ifc ? ifc[1] : null } : null);
    });
  });
}

/** This machine's IPv4 on the default-route interface (fallback: first external IPv4). */
function lanIp(iface) {
  const nets = os.networkInterfaces();
  const pick = list => (list || []).find(n => n.family === "IPv4" && !n.internal);
  const hit = iface && pick(nets[iface]);
  if (hit) return hit.address;
  for (const list of Object.values(nets)) { const n = pick(list); if (n) return n.address; }
  return null;
}

/**
 * The router's friendly name via SSDP + its description XML (e.g. "Plusnet Hub Two"). Only used to make
 * the manual port-forward help concrete — knowing the model is what lets someone look up their own router.
 * Best-effort: null if the router doesn't answer.
 */
function routerModel() {
  return new Promise(resolve => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = v => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    sock.on("error", () => finish(null));
    sock.on("message", async msg => {
      const loc = /LOCATION:\s*(\S+)/i.exec(String(msg));
      if (!loc || done) return;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const xml = await (await fetch(loc[1], { signal: ctl.signal })).text();
        clearTimeout(timer);
        const n = /<friendlyName>([^<]+)<\/friendlyName>/.exec(xml);
        finish(n ? n[1].trim() : null);
      } catch (e) { finish(null); }
    });
    for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                      "urn:schemas-upnp-org:device:InternetGatewayDevice:2"]) {
      const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      try { sock.send(m, 1900, "239.255.255.250"); } catch (e) {}
    }
    setTimeout(() => finish(null), 5000);
  });
}

class PortMapper extends EventEmitter {
  constructor() {
    super();
    this.enabled = false;
    this.port = 0;
    this.client = null;
    this.gen = 0;                  // guards stale async completions after stop()/restart
    this.retryCount = 0;
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.state = "off";            // off | searching | mapped | no_gateway | mapping_refused | double_nat | error
    this.externalIp = null;
    this.detail = "";
    this.since = 0;
    this.logger = null;
    this.lanIp = null;             // for the manual-forward help — this Mac, the router, and its model
    this.gatewayIp = null;
    this.routerName = null;
  }

  setLogger(fn) { this.logger = fn; }
  log(msg) { try { if (this.logger) this.logger("[portmap] " + msg); } catch (e) {} }

  status() {
    const mapped = this.state === "mapped" || this.state === "double_nat";
    return { state: this.state, externalIp: this.externalIp, externalPort: mapped ? this.port : null,
             detail: this.detail, since: this.since, port: this.port,
             // Everything needed to forward the port BY HAND, discovered rather than guessed — on plenty
             // of routers (BT/Plusnet Hub 2 and friends) manual is the only thing that actually works.
             lanIp: this.lanIp, gatewayIp: this.gatewayIp, routerName: this.routerName };
  }

  /** Discover this Mac's LAN IP, the router's address and model, for the manual-forward instructions. */
  async discoverHostInfo() {
    try {
      const route = await defaultRoute();
      this.gatewayIp = (route && route.gateway) || null;
      this.lanIp = lanIp(route && route.iface);
      if (!this.routerName) this.routerName = await routerModel();
      this.emit("status", this.status());
    } catch (e) { /* help text degrades to generic wording */ }
  }

  setStatus(state, detail) {
    if (state !== this.state) this.since = Date.now();
    this.state = state;
    this.detail = detail || "";
    this.log("state=" + state + (detail ? " — " + detail : "") + (this.externalIp ? " ext=" + this.externalIp : ""));
    this.emit("status", this.status());
  }

  /** Begin (or re-begin) mapping `port`. Idempotent; safe to fire-and-forget. */
  start(port) {
    if (this.enabled && this.port === port &&
        (this.state === "mapped" || this.state === "double_nat" || this.state === "searching")) return;
    this.port = port;
    this.enabled = true;
    this.retryCount = 0;
    this.cycle();
  }

  async cycle() {
    const gen = ++this.gen;
    this.clearTimers();
    await this.teardown();                                   // drop any prior client/mapping first
    if (!this.enabled || gen !== this.gen) return;
    this.setStatus("searching");
    this.discoverHostInfo();          // parallel, best-effort: powers the manual-forward instructions
    try {
      const { default: NatAPI } = await import("@silentbot1/nat-api");
      if (!this.enabled || gen !== this.gen) return;

      const client = new NatAPI({ ttl: MAP_TTL_S, description: "minimaCore Minima node", autoUpdate: true });
      this.client = client;

      // External IP first: no answer at all → the router speaks neither NAT-PMP nor UPnP. A private/
      // CGNAT-range answer means double NAT (map anyway — harmless — but the UI must stay honest).
      let ip = "";
      try { ip = await withTimeout(client.externalIp(), IP_TIMEOUT_MS, "externalIp timeout"); }
      catch (e) { ip = ""; }
      if (!this.enabled || gen !== this.gen) return;
      this.externalIp = ip || null;
      if (!ip) {
        this.setStatus("no_gateway", "no UPnP or NAT-PMP response from the router");
        this.scheduleRetry();
        return;
      }

      // AddPortMapping maps the requested external port exactly or fails — so external always ==
      // internal (what the jar needs); a clash with another device surfaces here as a refusal.
      let ok = false;
      try {
        ok = await withTimeout(
          client.map({ publicPort: this.port, privatePort: this.port, protocol: "TCP" }),
          MAP_TIMEOUT_MS, "map timeout");
      } catch (e) {
        if (!this.enabled || gen !== this.gen) return;
        this.setStatus("mapping_refused", String(e.message || e));
        this.scheduleRetry();
        return;
      }
      if (!this.enabled || gen !== this.gen) return;
      if (!ok) {
        this.setStatus("mapping_refused", "the router refused the mapping (UPnP/NAT-PMP disabled, or port " + this.port + " is already forwarded to another device)");
        this.scheduleRetry();
        return;
      }

      this.retryCount = 0;
      if (isPrivateIp(ip)) {
        this.setStatus("double_nat", "the router's own external IP " + ip + " is private (CGNAT or a second router upstream)");
      } else {
        this.log("mapped " + this.port + " → " + ip + ":" + this.port);
        this.setStatus("mapped");
      }
      this.startWatchdog(gen);
    } catch (e) {
      if (!this.enabled || gen !== this.gen) return;
      this.setStatus("error", String(e.message || e));
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (!this.enabled) return;
    const wait = RETRY_MS[Math.min(this.retryCount++, RETRY_MS.length - 1)];
    this.log("retry in " + Math.round(wait / 60000) + "m");
    this.retryTimer = setTimeout(() => this.cycle(), wait);
  }

  /** Liveness: re-ask for the external IP; on failure or change, rediscover and remap from scratch. */
  startWatchdog(gen) {
    this.watchdogTimer = setInterval(async () => {
      if (!this.enabled || gen !== this.gen || !this.client) return;
      let ip = "";
      try { ip = await withTimeout(this.client.externalIp(), IP_TIMEOUT_MS, "externalIp timeout"); }
      catch (e) { ip = ""; }
      if (!this.enabled || gen !== this.gen) return;
      if (!ip) { this.log("gateway lost — rediscovering"); this.cycle(); return; }
      if (ip !== this.externalIp) {
        this.log("external IP changed " + this.externalIp + " → " + ip + " — remapping");
        this.cycle();                                        // the mapping is tied to the old WAN address
      }
    }, WATCHDOG_MS);
  }

  clearTimers() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  /** Release the mapping and close the client, bounded so it can run inside app quit. */
  async teardown() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await withTimeout(client.destroy(), STOP_TIMEOUT_MS, "teardown timeout");   // destroy() unmaps all
    } catch (e) { this.log("teardown: " + (e.message || e)); }
  }

  /** Turn contribution mapping off: unmap and go quiet. Bounded (<~3s) — safe on before-quit. */
  async stop() {
    this.enabled = false;
    this.gen++;
    this.clearTimers();
    await this.teardown();
    this.externalIp = null;
    if (this.state !== "off") this.setStatus("off");
  }
}

module.exports = new PortMapper();
