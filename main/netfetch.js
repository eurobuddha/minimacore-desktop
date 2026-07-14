/*
 * netfetch.js — the ONLY place the app fetches remote token-icon URLs (main process; the renderer CSP blocks
 * all outbound requests). Token metadata is UNTRUSTED, so this mirrors the native ImageLoader.java guards:
 *
 *   - SSRF guard: resolve ALL A/AAAA records and refuse loopback / private / link-local / ULA / mapped-v4
 *     (and re-check on every redirect) so a hostile icon url can't point us at the node RPC or the LAN.
 *   - 8 MB streaming byte cap (abort past it) so an icon can't OOM us.
 *   - Bounded concurrency (4) so dozens of token urls don't spawn dozens of sockets.
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
function ipBlocked(addr) {
  if (!addr) return true;
  if (net.isIPv4(addr)) return v4Blocked(addr);
  const a = addr.toLowerCase();
  if (a === "::1" || a === "::") return true;            // loopback / unspecified
  if (a.startsWith("fe80")) return true;                 // link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local fc00::/7
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);    // mapped v4
  if (m) return v4Blocked(m[1]);
  return false;
}
async function isBlockedHost(host) {
  if (!host) return true;
  if (net.isIP(host)) return ipBlocked(host);            // literal IP — no DNS
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); }
  catch (e) { return true; }                             // unresolvable → blocked
  if (!addrs.length) return true;
  return addrs.some(a => ipBlocked(a.address));          // any private answer → blocked
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
function getCapped(urlStr, redirectsLeft) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve(null); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(null);
    isBlockedHost(u.hostname).then(blocked => {
      if (blocked) return resolve(null);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(u, { method: "GET", headers: { "User-Agent": "minimaCore-Desktop", Accept: "image/*" } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return resolve(null);
          const next = new URL(res.headers.location, u).toString();
          return resolve(getCapped(next, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const ctype = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const chunks = []; let total = 0;
        res.on("data", d => {
          total += d.length;
          if (total > MAX_BYTES) { req.destroy(); return resolve(null); }
          chunks.push(d);
        });
        res.on("end", () => resolve({ buf: Buffer.concat(chunks), ctype }));
        res.on("error", () => resolve(null));
      });
      req.setTimeout(READ_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    });
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

module.exports = { tokenIcon, isBlockedHost };
