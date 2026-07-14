/*
 * rpc.js — the HTTP client for the local node's RPC (main process only).
 *
 * minimaCore RPC accepts `GET /<url-encoded command>` and `POST /` with the command in the body, replying
 * `{"command":…, "status":bool, "response":…}` — the same JSON contract the Android apps' NodeApi consumes,
 * so command strings port 1:1. URL-encoding the WHOLE command (encodeURIComponent) round-trips quoted KISS
 * scripts safely (verified live: runscript with a quoted script → parseok true) and structurally avoids the
 * JSONObject.quote `\/`-escaping class of bug. Long commands (txnimport blobs) go over POST.
 *
 * Auth is HTTP Basic (user "minima" + the app-generated secret); the node binds 0.0.0.0 so the password is
 * not optional. The renderer NEVER sees this module — it calls through the IPC proxy in main.js.
 */
const http = require("http");

const GET_MAX = 6000;          // command length above which we switch to POST (URL-length safety)
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;   // txnpost/send can mine — mirror the Android NodeApi's write timeout

const WRITE_PREFIXES = ["send", "txn", "tokencreate", "consolidate", "burn", "vault", "restore", "backup",
  "archive", "megammr", "mysql", "reset", "seedrandom", "quit", "newaddress", "newscript", "coinimport",
  "cointrack", "removescript", "sign", "multisig"];

function timeoutFor(command) {
  const c = command.trim().toLowerCase();
  return WRITE_PREFIXES.some(p => c.startsWith(p)) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
}

/** Run one node command. Resolves with the parsed JSON reply (status may be false — caller inspects). */
function rpcCall(port, secret, command) {
  return new Promise((resolve, reject) => {
    const auth = "Basic " + Buffer.from("minima:" + secret).toString("base64");
    const usePost = command.length > GET_MAX;
    const options = {
      host: "127.0.0.1",
      port,
      method: usePost ? "POST" : "GET",
      path: usePost ? "/" : "/" + encodeURIComponent(command),
      headers: { Authorization: auth },
      timeout: timeoutFor(command),
      // Minima's lightweight Java RPC server emits response headers that Node's strict llhttp parser rejects
      // ("Invalid header value char"), so every call would fail to parse. Parse leniently, like curl. Safe:
      // localhost-only loopback to our own child process.
      insecureHTTPParser: true
    };
    const req = http.request(options, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => { body += d; });
      res.on("end", () => {
        if (res.statusCode === 401) { reject(new Error("RPC authentication failed")); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("bad RPC reply (" + res.statusCode + "): " + body.slice(0, 120))); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("RPC timeout")); });
    req.on("error", reject);
    if (usePost) req.write(command);
    req.end();
  });
}

module.exports = { rpcCall };
