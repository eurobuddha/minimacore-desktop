/*
 * no-reach.cjs — makes "this suite touches nothing outside the process" a fact instead of a promise (0.18.140).
 * install(): from then on a child process (docker, curl, security, java …) or a socket (a node's RPC, the network)
 * THROWS and is recorded in `reached`. main/rpc.js and main/netfetch.js are replaced by stand-ins that answer
 * "nothing" and record what was asked in `net`, so an engine under test can ask for a price or an Ethereum balance
 * and simply not get one. Load it BEFORE anything under main/ is required.
 */
const path = require("node:path");
function install() {
  const reached = [], net = [];
  const refuse = (what) => (...a) => { const line = what + " " + String(a[0] && a[0].host ? a[0].host + ":" + a[0].port : a[0]).slice(0, 200); reached.push(line); throw new Error("TEST LEAK: " + line); };
  const cp = require("node:child_process");
  for (const f of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[f] = refuse("child_process." + f);
  require("node:net").Socket.prototype.connect = refuse("net.connect");
  const dns = require("node:dns"); dns.lookup = refuse("dns.lookup"); dns.promises.lookup = refuse("dns.lookup");
  for (const m of ["node:http", "node:https"]) { const h = require(m); h.request = refuse(m.slice(5) + ".request"); h.get = refuse(m.slice(5) + ".get"); }
  if (typeof globalThis.fetch === "function") globalThis.fetch = refuse("fetch");
  const root = path.resolve(__dirname, "..");
  const standIn = (rel, name) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [],
    exports: new Proxy({}, { get: (_t, k) => async (...a) => { net.push(name + "." + String(k) + " " + String(a[name === "rpc" ? 2 : 0]).slice(0, 200)); if (name === "rpc") { reached.push("rpcCall " + a[2]); throw new Error("TEST LEAK: the real rpcCall was reached"); } return null; } }) }; };
  standIn("main/rpc.js", "rpc"); standIn("main/netfetch.js", "netfetch");
  return { reached, net };
}
module.exports = { install };
