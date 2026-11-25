/*
 * netfetch.js — the ONLY place the app fetches remote token-icon URLs (main process; the renderer CSP blocks
 * all outbound requests). Token metadata is UNTRUSTED, so this mirrors the native ImageLoader.java guards:
 *
 *   - SSRF guard: resolve ALL A/AAAA records and refuse loopback / private / link-local / ULA / mapped-v4
 *     (and re-check on every redirect) so a hostile icon url can't point us at the node RPC or the LAN.
 *     The vetted address is then PINNED for the connection (vetHost + connectPin). Vetting the name and
 *     letting the client re-resolve it was a DNS-rebinding hole: the attacker's resolver answers public for
 *     the check and 127.0.0.1 for the connect, and since the Parlons admin RPC takes commands with NO auth,
 *     a token's icon url could run `send`. Token metadata is attacker-supplied, and the wallet list fetches
 *     these automatically, so this path is reachable with no user action.
 *   - 8 MB streaming byte cap (abort past it) so an icon can't OOM us.
 *   - Bounded concurrency (4) so dozens of token urls don't spawn dozens of sockets. A caller that bounds itself
 *     (main/dexicon.js: its own two lanes) passes opts.ownCap and takes none of these four: its long polls and
 *     bursts can then never hold a slot the AtomiX Ethereum RPC needs for a claim or a refund.
 *   - Returns a `data:` URI (safe under `img-src data:`) or null; NEVER throws to the renderer.
 *
 * Web VALIDATION is not here — it uses the node's own `tokenvalidate` command (server-side, no CORS).
 */
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const { URL } = require("url");

const MAX_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const POOL = 4;
const POST_MAX = 64 * 1024;          // a POST body, in characters: RPC payloads are tiny
const POST_MAX_ASKED = 256 * 1024;   // the most a caller may ask for (opts.maxBody): the Dexicon protocol's own message limit

// ---- SSRF host guard -------------------------------------------------------
function v4Blocked(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;                 // this-network / loopback
  if (a === 10) return true;                             // private
  if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;               // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;      // private
  if (a === 192 && b === 168) return true;               // private
  if (a >= 224) return true;                             // multicast / reserved
  return false;
}
/** The 16 bytes of an IPv6 literal (:: compression and a dotted last part understood), or null. */
function v6Bytes(addr) {
  let a = String(addr).toLowerCase().replace(/%.*$/, "");   // a zone id is not part of the address
  const dotted = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) { const q = dotted.slice(2).map(Number); if (q.some(n => n > 255)) return null; a = dotted[1] + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16); }
  const halves = a.split("::"); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = head.concat(new Array(fill).fill("0"), tail);
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = []; for (const g of groups) { const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
  return out;
}
function ipBlocked(addr) {
  if (!addr) return true;
  if (net.isIPv4(addr)) return v4Blocked(addr);
  // Decoded, not matched as text: "::ffff:7f00:1" IS 127.0.0.1 and "::ffff:a9fe:a9fe" IS 169.254.169.254, and the
  // old text match saw only the dotted spelling of a mapped address.
  const b = v6Bytes(addr);
  if (!b) return true;                                   // not an address we can read: refused
  const zero = (from, to) => b.slice(from, to).every(x => x === 0), v4 = () => v4Blocked(b.slice(12).join("."));
  if (zero(0, 15) && b[15] <= 1) return true;            // :: unspecified, ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // link-local fe80::/10
  if ((b[0] & 0xfe) === 0xfc) return true;               // unique-local fc00::/7
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4();   // IPv4-mapped ::ffff:a.b.c.d, in any spelling
  if (zero(0, 12)) return v4();                          // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4();   // NAT64 64:ff9b::/96
  return false;
}
async function isBlockedHost(host) {
  return (await vetHost(host)) === null;
}

/**
 * Resolve a host ONCE, vet every answer, and return the address to actually dial — or null if blocked.
 *
 * DNS REBINDING (the reason this returns an address instead of a boolean): vetting a NAME and then letting
 * the HTTP client resolve it again is not a guard at all. The attacker's own resolver answers with a public
 * IP for our check and 127.0.0.1 for the client's lookup a moment later, and the request lands on the node's
 * OWN RPC — which on the Parlons node accepts commands with no authentication, so `send` is reachable from a
 * token's icon url. We therefore resolve once and PIN that address for the connection (see connectPin).
 */
async function vetHost(host) {
  if (!host) return null;
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which net.isIP does NOT recognise — so a
  // bracketed literal used to skip the literal-IP branch and reach the resolver. Strip them first.
  const bare = String(host).replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(bare)) return ipBlocked(bare) ? null : { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); }
  catch (e) { return null; }                             // unresolvable → blocked
  if (!addrs.length) return null;
  if (addrs.some(a => ipBlocked(a.address))) return null; // any private answer → blocked (unchanged policy)
  const a = addrs[0];
  return { address: a.address, family: a.family };
}

/**
 * A `lookup` override that hands the socket the ALREADY-VETTED address, so no second DNS query can occur.
 * Node calls this either as (host, {all:true}, cb) — the Happy-Eyeballs/autoSelectFamily path, default-on
 * since Node 20 and so the one Electron 33 actually takes — expecting an ARRAY, or as (host, opts, cb)
 * expecting (err, address, family). Both shapes are answered; getting this wrong would fail every fetch.
 */
function connectPin(vetted) {
  return function (hostname, opts, cb) {
    const entry = { address: vetted.address, family: vetted.family };
    // DEFER. This is not a style choice — node's net runs lookupAndConnect from INSIDE request() and only
    // wires the socket's error listener a tick later, because the real dns.lookup is always async (node's
    // own net.js says so: "There are no event listeners registered yet so defer the error event"). Calling
    // back synchronously ran internalConnect inside request(), so a connect that fails at the syscall — a
    // Mac waking with DNS still cached but no route yet, EADDRNOTAVAIL — destroyed the socket before
    // anything was listening. Over http that surfaced as an uncaught exception that killed the main
    // process; over https (the AtomiX ETH-RPC path) request() threw outright and the fetch never settled.
    setImmediate(() => {
      if (opts && opts.all) cb(null, [entry]);
      else cb(null, entry.address, entry.family);
    });
  };
}

// ---- bounded concurrency ---------------------------------------------------
let active = 0;
const queue = [];
function acquire() {
  if (active < POOL) { active++; return Promise.resolve(); }
  return new Promise(res => queue.push(res));
}
function release() { active--; const next = queue.shift(); if (next) { active++; next(); } }

// ---- capped GET (follows redirects, re-guarding each hop) -------------------
function getCapped(urlStr, redirectsLeft, accept, cap) {
  const limit = cap > 0 && cap < MAX_BYTES ? cap : MAX_BYTES;   // a caller may ask for a SMALLER limit (fetchJson opts.maxBytes), never a larger one
  return new Promise((resolveRaw) => {
    // SETTLE EXACTLY ONCE, ALWAYS. Every caller holds a pool slot across this promise and releases it in a
    // `finally`, so a promise that never settles holds that slot for the life of the process — four of those
    // and all outbound HTTP is wedged. The watchdog is the backstop for any path that forgets to resolve;
    // req.setTimeout cannot cover it, because a request that threw on creation has no timer at all.
    let done = false;
    const resolve = (v) => { if (done) return; done = true; clearTimeout(watchdog); resolveRaw(v); };
    const watchdog = setTimeout(() => resolve(null), READ_TIMEOUT_MS + 5000);
    if (watchdog.unref) watchdog.unref();
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve(null); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(null);
    vetHost(u.hostname).then(vetted => {
      if (!vetted) return resolve(null);
      const lib = u.protocol === "https:" ? https : http;
      try {
      const req = lib.request(u, { method: "GET", lookup: connectPin(vetted),
        headers: { "User-Agent": "minimaCore-Desktop", Accept: accept || "image/*" } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return resolve(null);
          const next = new URL(res.headers.location, u).toString();
          return resolve(getCapped(next, redirectsLeft - 1, accept, cap));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const ctype = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const chunks = []; let total = 0;
        res.on("data", d => {
          total += d.length;
          if (total > limit) { req.destroy(); return resolve(null); }
          chunks.push(d);
        });
        res.on("end", () => resolve({ buf: Buffer.concat(chunks), ctype }));
        res.on("error", () => resolve(null));
      });
      req.setTimeout(READ_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
      } catch (e) { resolve(null); }   // request() can throw outright (https + a socket killed mid-handshake)
    }).catch(() => resolve(null));
  });
}

// ---- mime sniff ------------------------------------------------------------
function sniffMime(buf, ctype) {
  if (ctype && ctype.startsWith("image/")) return ctype;
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x42 && buf[1] === 0x4D) return "image/bmp";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  }
  const head = buf.slice(0, 300).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || head.includes("<svg")) return "image/svg+xml";
  return null;
}

/** Fetch a token-icon URL → a `data:` URI, or null on any failure/guard. Only http(s)/ipfs reach here. */
async function tokenIcon(url) {
  if (typeof url !== "string" || !url) return null;
  let u = url.trim();
  if (u.startsWith("ipfs://")) u = "https://ipfs.io/ipfs/" + u.slice(7);
  if (!/^https?:\/\//i.test(u)) return null;
  await acquire();
  try {
    const r = await getCapped(u, MAX_REDIRECTS);
    if (!r || !r.buf || !r.buf.length) return null;
    const mime = sniffMime(r.buf, r.ctype);
    if (!mime) return null;                                 // not an image → don't serve arbitrary bytes
    return "data:" + mime + ";base64," + r.buf.toString("base64");
  } finally { release(); }
}

/** Fetch a JSON API (e.g. the MEXC MINIMA/USDT ticker) → parsed object, or null. Same SSRF guard + byte cap +
 *  bounded pool as icon fetches; read-only public market data; NEVER throws to the caller. */
async function fetchJson(url, opts) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  const shared = !(opts && opts.ownCap);   // ownCap: the caller has its own bound (header)
  if (shared) await acquire();
  try {
    // opts.noRedirect (main/dexicon.js): the caller's host allow-list must hold for the host that answers
    // opts.maxBytes (main/keyuses.js, 512 KB as the phone's AuditApi): a reply over it is dropped, not parsed
    const r = await getCapped(url.trim(), opts && opts.noRedirect ? 0 : MAX_REDIRECTS, "application/json", opts && opts.maxBytes);
    if (!r || !r.buf || !r.buf.length) return null;
    try { return JSON.parse(r.buf.toString("utf8")); } catch (e) { return null; }
  } finally { if (shared) release(); }
}

/** POST a small JSON body → raw response TEXT, or null on any failure/guard. Built for the AtomiX module's
 *  Ethereum JSON-RPC calls. The host allowlist lives in the caller's shim (main/atomix.js NET_HOSTS +
 *  ethUserHosts) — NOT in lib/ethrpc.js, which takes the configured url plus its keyless fallbacks and
 *  relies on ethSetRpc having validated the former. Same SSRF guard + byte cap + bounded pool as GETs,
 *  including the pinned-address connect. POSTs never follow redirects
 *  (a redirected RPC POST is suspect; the pinned endpoints don't redirect). NEVER throws.
 *  opts.maxBody (0.18.119): a larger body limit, at most 256K characters. Only main/dexicon.js passes it, for a
 *  message to one of its allow-listed relays: a sealed take is about eight times its transaction's size, and the
 *  protocol allows 256K (main/dexicon/lib/envelope.js MAX_MSG_BYTES). Everything else keeps 64K. */
async function postText(url, body, opts) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  if (typeof body !== "string" || body.length > Math.min(Math.max(Number(opts && opts.maxBody) || 0, POST_MAX), POST_MAX_ASKED)) return null;
  const shared = !(opts && opts.ownCap);
  if (shared) await acquire();
  try {
    return await new Promise((resolveRaw) => {
      let done = false;                                  // settle exactly once, always — see getCapped
      const resolve = (v) => { if (done) return; done = true; clearTimeout(watchdog); resolveRaw(v); };
      const watchdog = setTimeout(() => resolve(null), READ_TIMEOUT_MS + 5000);
      if (watchdog.unref) watchdog.unref();
      let u;
      try { u = new URL(url.trim()); } catch (e) { return resolve(null); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(null);
      vetHost(u.hostname).then(vetted => {
        if (!vetted) return resolve(null);
        const lib = u.protocol === "https:" ? https : http;
        try {
        const req = lib.request(u, { method: "POST", lookup: connectPin(vetted), headers: {
          "User-Agent": "minimaCore-Desktop", "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body), Accept: "application/json"
        } }, res => {
          if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
          const chunks = []; let total = 0;
          res.on("data", d => {
            total += d.length;
            if (total > MAX_BYTES) { req.destroy(); return resolve(null); }
            chunks.push(d);
          });
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("error", () => resolve(null));
        });
        req.setTimeout(READ_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
        req.end(body);
        } catch (e) { resolve(null); }
      }).catch(() => resolve(null));
    });
  } finally { if (shared) release(); }
}

module.exports = { vetHost, connectPin, tokenIcon, fetchJson, postText, isBlockedHost, READ_TIMEOUT_MS };
