/*
 * preflight-portmap.mjs — standalone router diagnostic. Run OUTSIDE the app to answer, on any given
 * network: does the router open a port for us, and is that port actually reachable from the internet?
 *
 *   node preflight-portmap.mjs [port]
 *
 * The "is it reachable" question is the important one: some routers (verified: Plusnet Hub Two / BT
 * Smart Hub 2, MiniUPnPd 1.9) accept a UPnP mapping and report success — the entry even shows up in their
 * mapping table with Enabled=1 — while the port stays firmly shut from outside. So a successful map() is
 * NOT evidence of reachability, and neither the app nor this script should claim it is.
 */
import NatAPI from "@silentbot1/nat-api";

const PORT = parseInt(process.argv[2], 10) || 12001;
const t = (p, ms, m) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(m)), ms))]);
const priv = ip => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(ip);

const client = new NatAPI({ ttl: 3600, description: "minimaCore Minima node", autoUpdate: true });

let ip = "";
try {
  ip = await t(client.externalIp(), 12_000, "externalIp timeout");
  console.log("router external IP :", ip, priv(ip) ? "→ PRIVATE = double NAT / CGNAT (unreachable no matter what)" : "→ public");
} catch (e) {
  console.log("router external IP : FAILED (" + e.message + ") → no UPnP/NAT-PMP; app state would be no_gateway");
  process.exit(1);
}

let mapped = false;
try {
  mapped = await t(client.map({ publicPort: PORT, privatePort: PORT, protocol: "TCP" }), 20_000, "map timeout");
  console.log("map(" + PORT + "/TCP)     :", mapped ? "accepted by the router" : "REFUSED → app state would be mapping_refused");
} catch (e) {
  console.log("map(" + PORT + "/TCP)     : ERROR " + e.message);
}

if (mapped && !priv(ip)) {
  // The only claim worth trusting: ask something on the public internet to dial us back.
  process.stdout.write("reachable from net : checking… ");
  try {
    const r = await t(fetch("https://ports.yougetsignal.com/check-port.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0",
                 Referer: "https://www.yougetsignal.com/tools/open-ports/" },
      body: "remoteAddress=" + encodeURIComponent(ip) + "&portNumber=" + PORT
    }), 25_000, "probe timeout");
    const body = await r.text();
    const open = /is open/i.test(body);
    console.log(open ? "YES — genuinely reachable ✓" : "NO — the router accepted the mapping but the port is SHUT from outside");
    if (!open) console.log("                     (needs a manual static forward, or this router lies about UPnP — listen for a real inbound peer to confirm)");
  } catch (e) {
    console.log("probe failed (" + e.message + ") — verify manually from off-network, e.g. `nc -vz " + ip + " " + PORT + "` on a phone hotspot");
  }
}

try { await client.destroy(); } catch (e) {}
console.log("(mapping released)");
process.exit(0);
