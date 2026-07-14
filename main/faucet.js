/*
 * faucet.js — the Minima Faucet REQUESTER (main process; the renderer CSP blocks outbound HTTP).
 *
 * Ports the native minima-core-android-faucet: the node side is just `getaddress` (done in the renderer); the
 * "give me coins" step is a plain HTTPS GET to a remote backend that decides/dispenses/rate-limits and returns
 * `{status, message}`. We validate the address, GET the hardcoded endpoint, and hand back the reply. Never throws.
 */
const https = require("https");
const { URL } = require("url");

const FAUCET_API = "https://eurobuddha.com/faucet/api/request";
const TIMEOUT_MS = 20000;
const MAX_BYTES = 65536;

function getJson(urlStr, redirectsLeft, resolve) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return resolve({ status: false, message: "Bad faucet URL." }); }
  const req = https.get(u, { headers: { "User-Agent": "minimaCore-Desktop", Accept: "application/json" }, timeout: TIMEOUT_MS }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) return resolve({ status: false, message: "Too many redirects." });
      return getJson(new URL(res.headers.location, u).toString(), redirectsLeft - 1, resolve);
    }
    let body = "", total = 0;
    res.setEncoding("utf8");
    res.on("data", d => { total += d.length; if (total > MAX_BYTES) { req.destroy(); return; } body += d; });
    res.on("end", () => {
      try {
        const j = JSON.parse(body);
        resolve({ status: !!j.status, message: String(j.message || (j.status ? "Requested ✓" : "Faucet declined.")) });
      } catch (e) {
        resolve({ status: false, message: body ? body.slice(0, 200) : "Faucet returned no data." });
      }
    });
    res.on("error", () => resolve({ status: false, message: "Faucet read error." }));
  });
  req.on("timeout", () => { req.destroy(); resolve({ status: false, message: "Faucet request timed out." }); });
  req.on("error", () => resolve({ status: false, message: "Couldn't reach the faucet." }));
}

/** Request a faucet drip to `address`. Resolves `{status, message}`; never rejects. */
function requestFaucet(address) {
  return new Promise((resolve) => {
    if (typeof address !== "string" || !/^(0x|Mx)[0-9A-Za-z]+$/.test(address)) {
      return resolve({ status: false, message: "Enter a valid Mx… / 0x… address." });
    }
    const u = new URL(FAUCET_API);
    u.searchParams.set("address", address);
    getJson(u.toString(), 2, resolve);
  });
}

module.exports = { requestFaucet, FAUCET_API };
