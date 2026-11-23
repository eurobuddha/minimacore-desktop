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
const { createNodeRunner } = require("./noderun");
const reserve = require("./reserve");

const GET_MAX = 6000;          // command length above which we switch to POST (URL-length safety)
// A POST body is sent only when it is pure ASCII (0.19.305): the shipped node reads Content-Length as CHARACTERS
// (CMDHandler: char[] from a UTF-8 reader), a fixed node reads it as BYTES; only for ASCII are the two the same. A command with
// any other character goes by the GET path (percent-encoded UTF-8, which both nodes URL-decode: "+", "%", "/" and spaces are
// encoded, so they come back exactly), up to GET_NONASCII_MAX characters of encoded path; longer, it is refused before sending.
const GET_NONASCII_MAX = 65536;
const ASCII = /^[\x00-\x7f]*$/;
const TOO_LONG = "This command holds characters outside plain ASCII and is too long for the node's command line (over 65,536 characters once encoded). Shorten it, or write those characters in plain ASCII. Nothing was sent."
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;   // txnpost/send can mine — mirror the Android NodeApi's write timeout

const WRITE_PREFIXES = ["send", "txn", "tokencreate", "consolidate", "burn", "vault", "restore", "backup",
  "archive", "megammr", "mysql", "reset", "seedrandom", "quit", "newaddress", "newscript", "coinimport",
  "cointrack", "removescript", "sign", "multisig"];

const V = require("./cmdverb");
// megammrsync action:resync runs for as long as the chain takes to load (tens of minutes on a slow link): its own bound
// (0.19.219). Cut at 180 s it looked "unanswered" while the node went on and could still swap the wallet.
const RESYNC_TIMEOUT_MS = 60 * 60 * 1000;
function timeoutFor(command) {   // the verb read as the node reads it, in every piece of a chain (main/cmdverb.js, 0.19.190, as released 0.18.175)
  const ps = V.parts(command);
  if (ps.some(part => V.is(part, "megammrsync") && V.fold(V.paramValue(part, "action") || "") === "resync")) return RESYNC_TIMEOUT_MS;
  // megammr action:import reads a whole MegaMMR file (1.6 GB for the mainnet one) in batches of 256 blocks, each allowed 10 minutes (megammr.java)
  // and action:integrity reads the same whole file at once and checks every coin's proof in it (megammr.java)
  if (ps.some(part => V.is(part, "megammr") && ["import", "integrity"].includes(V.fold(V.paramValue(part, "action") || "")))) return RESYNC_TIMEOUT_MS;
  return ps.some(part => WRITE_PREFIXES.some(p => V.beginsAs(part, p))) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
}

/** One HTTP round trip to the node, ungated. Only rpcCall below may call this. */
function rawCall(port, secret, command) {
  return new Promise((resolve, reject) => {
    if (/[;\r\n\u0000]/.test(String(command))) { reject(new Error(V.UNSAFE)); return; }   // the backstop under rpcRead too (0.19.418)
    const auth = "Basic " + Buffer.from("minima:" + secret).toString("base64");
    const ascii = ASCII.test(command), path = "/" + encodeURIComponent(command);
    const usePost = ascii && command.length > GET_MAX;
    if (!ascii && path.length > GET_NONASCII_MAX) { reject(new Error(TOO_LONG)); return; }   // no body whose length a node could misread (0.19.305)
    // The node's RPC handler reads a POST body ONLY via the Content-Length header (CMDHandler.java). Node's
    // http client would otherwise use chunked transfer-encoding — which the node ignores, reading an EMPTY body
    // and returning "[]" (zero commands run). So we MUST set Content-Length explicitly on POST, or every command
    // over GET_MAX (mail images, large txnimport/state blobs) silently no-ops.
    const headers = usePost
      // ... pure ASCII only (0.19.305): bytes and characters are the same, so the shipped node (characters) and a fixed one (bytes) agree
      ? { Authorization: auth, "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(command) }
      : { Authorization: auth };
    const options = {
      host: "127.0.0.1",
      port,
      method: usePost ? "POST" : "GET",
      path: usePost ? "/" : path,
      headers,
      timeout: timeoutFor(command),
      // Minima's lightweight Java RPC server emits response headers that Node's strict llhttp parser rejects
      // ("Invalid header value char"), so every call would fail to parse. Parse leniently, like curl. Safe:
      // localhost-only loopback to our own child process.
      insecureHTTPParser: true,
      // The node closes each connection, so a pooled keep-alive socket gives intermittent ECONNRESET on reuse
      // (seen under rapid calls e.g. the mail scan loop). A fresh socket per request avoids it.
      agent: false
    };
    const req = http.request(options, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => { body += d; });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode === 401) { reject(new Error("RPC authentication failed")); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("bad RPC reply (HTTP " + res.statusCode + ", " + body.length + " characters, not JSON)")); }   // never the body (0.19.260, as released 0.18.211): a reply can carry a seed or a key
      });
    });
    req.on("timeout", () => { req.destroy(new Error("RPC timeout")); });
    req.on("error", reject);
    if (usePost) req.write(command);
    req.end();
  });
}

// ONE signing queue per node (keyed by RPC port), under every caller. Minima signs with one-time Winternitz leaves:
// two signing commands in flight at once can be handed the SAME leaf, which leaks that key. Each engine serialised
// its own signing, but nothing serialised them against each other or against the wallet's own Send. Reads are not
// queued. A queued command carries the secret its caller passed when it was enqueued (every caller passes
// config.rpcSecret(), which does not change while a node runs).
const runners = new Map();

// After which failures the node may still be signing (noderun then holds the queue until `block` answers). Everything
// except the two that prove it is not: nothing listening on the port, and a request the node turned away at the door.
const lost = (e) => !(e && (e.code === "ECONNREFUSED" || /RPC authentication failed/.test(e.message)));

/** Run one node command. Resolves with the parsed JSON reply (status may be false — caller inspects).
 *  opts.signal (AbortSignal): a SIGNING command still queued when it aborts is rejected and never reaches the node.
 *  opts.owner: who asks ("atomix", "pandapools", "dexicon"; none = the wallet), for the shared coin
 *  reservation (main/reserve.js, docs/COIN_RESERVATION.md). Its guard runs here because this is the one function every
 *  node command of every caller passes, and INSIDE the signing queue: a command is checked against the reservations
 *  when it is really sent, not when it was queued. A coin another owner holds is refused there, before the node. */
function rpcCall(port, secret, command, opts) {
  const unsafe = V.refuse(opts && opts.owner, command);   // 0.19.418: one command, from every caller (main/cmdverb.js refuse)
  if (unsafe) return Promise.reject(new Error(unsafe));
  let r = runners.get(port);
  if (!r) { r = createNodeRunner(null, { lost, minHoldMs }); runners.set(port, r); }
  const raw = (c) => rawCall(port, secret, c);
  return r.run(command, (c) => reserve.guard(opts && opts.owner, c, raw, opts), opts);
}
// oneCommand: main/cmdverb.js (0.19.194), re-exported here where the released desktop has it
const { oneCommand } = V;
/** One read for the reservation's own upkeep (its sweep, its wallet id): never queued, never guarded. */
const rpcRead = (port, secret, command) => rawCall(port, secret, command);

let minHoldMs = 60 * 1000;   // a lost signer's minimum hold (main/noderun.js, 0.19.225); tests shorten it before their first call
module.exports = { rpcCall, rpcRead, oneCommand, _timeoutFor: timeoutFor, _setMinHold: (ms) => { minHoldMs = ms; } };
