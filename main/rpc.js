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

const V = require("./cmdverb");
function timeoutFor(command) {   // the verb read as the node reads it, in every piece of a chain (main/cmdverb.js, 0.18.175)
  return V.parts(command).some(part => WRITE_PREFIXES.some(p => V.beginsAs(part, p))) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
}

/** Run one node command. Resolves with the parsed JSON reply (status may be false — caller inspects). */
function rpcCall(port, secret, command) {
  return new Promise((resolve, reject) => {
    const auth = "Basic " + Buffer.from("minima:" + secret).toString("base64");
    const usePost = command.length > GET_MAX;
    // The node's RPC handler reads a POST body ONLY via the Content-Length header (CMDHandler.java). Node's
    // http client would otherwise use chunked transfer-encoding — which the node ignores, reading an EMPTY body
    // and returning "[]" (zero commands run). So we MUST set Content-Length explicitly on POST, or every command
    // over GET_MAX (mail images, large txnimport/state blobs) silently no-ops.
    const headers = usePost
      // ... and it reads that many CHARACTERS, not bytes (CMDHandler: a char[] of Content-Length from a UTF-8 reader; 0.18.239, as
      // Pandamonium Desktop 0.19.304): a byte count over a non-ASCII command made it wait for characters that never came, until our
      // timeout cut the socket, and then run what it had. A JS string's length counts UTF-16 units exactly as a Java char[] does.
      ? { Authorization: auth, "Content-Type": "text/plain", "Content-Length": command.length }
      : { Authorization: auth };
    const options = {
      host: "127.0.0.1",
      port,
      method: usePost ? "POST" : "GET",
      path: usePost ? "/" : "/" + encodeURIComponent(command),
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
        catch (e) { reject(new Error("bad RPC reply (HTTP " + res.statusCode + ", " + body.length + " characters, not JSON)")); }   // never the body (0.18.211): a reply can carry a seed or a key
      });
    });
    req.on("timeout", () => { req.destroy(new Error("RPC timeout")); });
    req.on("error", reject);
    if (usePost) req.write(command);
    req.end();
  });
}

/**
 * oneCommand(text) (0.18.177): a command the APP builds is one command. The node splits a text on EVERY ";", even inside
 * quotes and JSON, so a ";" carried in by a pasted seed, a peer's media ref, a password or a coin's state on the chain
 * started a second command of the sender's choosing. Every builder outside the Terminal and the vendored engines (Mail,
 * miniMall, Chat, Vestr, Web Wallet) sends through this; it throws, and nothing is sent. The Terminal's own chains go
 * through mcd:cmd; the AtomiX, PandaPools and casino engines chain txnbasics;txnpost of their own making.
 */
function oneCommand(command) {
  if (String(command).includes(";")) throw new Error("This command holds \";\", which would start a second command. Nothing was sent.");
  const esc = V.smuggled(command); if (esc) throw new Error(esc);   // an escaped one too (0.18.221): the node decodes \u003b in a JSON value
  return command;
}

/** Does this text sign or change something (send, txn…, vault…): the commands that wait the long write timeout. */
function isWrite(command) { return timeoutFor(command) === WRITE_TIMEOUT_MS; }

module.exports = { rpcCall, oneCommand, isWrite, _timeoutFor: timeoutFor };
