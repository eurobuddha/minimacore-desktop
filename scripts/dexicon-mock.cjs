/*
 * dexicon-mock.cjs — a stand-in node and stand-in network for the Dexicon host tests. NOTHING here opens a socket.
 * Loading it replaces main/rpc.js and main/netfetch.js in the require cache with versions that THROW and count, so a
 * host that ever falls back to the real rpcCall (a real node on localhost) or the real network fails its test.
 */
const path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const leaks = [];
function poison(rel, exportsObj) { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj, children: [], paths: [] }; }
poison("main/rpc.js", { rpcCall() { leaks.push("rpcCall"); throw new Error("TEST LEAK: the real rpcCall was reached"); } });
poison("main/netfetch.js", { fetchJson() { leaks.push("fetchJson"); throw new Error("TEST LEAK: the real network was reached"); },
  postText() { leaks.push("postText"); throw new Error("TEST LEAK: the real network was reached"); } });

const hex = (s, n) => "0x" + crypto.createHash("sha256").update(String(s)).digest("hex").repeat(Math.ceil(n / 64)).slice(0, n).toUpperCase();
const KEY = hex("mock key", 64), ADDRESS = hex("mock address", 64);

/** A node that owns one key and no coins at block 1000. host: asked for the covenant address the engine expects.
 *  seen: every command, in order. o.on(command) may return a reply to override the default. */
function mockNode(o = {}) {
  const seen = [];
  let host = null;
  const ok = (response) => ({ status: true, pending: false, response });
  async function run(c) {
    c = String(c); seen.push(c);
    const over = o.on && (await o.on(c));
    if (over) return over;
    const verb = c.split(/\s+/)[0];
    if (verb === "seedrandom") return ok({ seedrandom: "0x" + crypto.createHash("sha256").update("seed:" + (o.seed || "one") + ":" + c).digest("hex") });
    if (verb === "random") return ok({ random: hex("random" + seen.length, 128) });
    if (verb === "block") return ok({ block: String(o.block || 1000) });
    if (verb === "getaddress") return ok({ address: ADDRESS, publickey: KEY, miniaddress: "MxMOCK" });
    if (verb === "keys") return ok({ keys: [{ publickey: KEY }] });
    if (verb === "scripts") return ok([{ address: ADDRESS, script: "RETURN SIGNEDBY(" + KEY + ")", publickey: KEY, simple: true }]);
    if (verb === "coins" || verb === "balance" || verb === "history") return ok([]);
    if (verb === "newscript") return ok({});
    if (verb === "runscript") {
      const P = host && host._ctx() && host._ctx().PandaDEX;
      const m = /script:(.*)$/.exec(c), script = m ? m[1] : "";
      let address = hex("script:" + script, 64);
      if (P) { if (script === '"' + P.script.replace(/"/g, '\\"') + '"') address = P.ADDR; else if (P.SCRIPT_V5 && script === '"' + P.SCRIPT_V5.replace(/"/g, '\\"') + '"' && P.ADDRS) address = P.ADDRS.find(a => a !== P.ADDR) || address; }
      if (/^"RETURN SIGNEDBY\(/.test(script) && script.includes(KEY)) address = ADDRESS;
      return ok({ parseok: true, script: { address, mxaddress: "MxSCRIPT" } });
    }
    if (/^txn(create|input|output|state|sign|basics|delete|import)$/.test(verb) || verb === "consolidate" || verb === "send") return ok({ txpowid: hex("tx" + seen.length, 64) });
    if (verb === "txnpost") return ok({ txpowid: hex("post" + seen.length, 64), txpow: { txpowid: hex("post" + seen.length, 64) } });
    if (verb === "txncheck") return ok({ valid: { basic: true, mmrproofs: true, scripts: true, signatures: [] }, validamounts: true });
    return { status: false, error: "mock node: no answer for " + verb };
  }
  return { run, seen, attach(h) { host = h; }, KEY, ADDRESS };
}

/** A network of relays with empty books and inboxes, and a MEXC book. calls: every URL asked for. */
function mockNet() {
  const calls = [];
  return { calls,
    async fetchJson(url) {
      calls.push("GET " + url);
      if (/api\.mexc\.com\/api\/v3\/depth/.test(url)) return { bids: [["0.0100", "50000"]], asks: [["0.0102", "50000"]] };
      if (/\/dex\/inbox\?/.test(url)) return { cursor: 0, messages: [] };
      if (/\/dex\/book\?/.test(url)) return { cursor: 0, orders: [] };
      return null;
    },
    async postText(url) { calls.push("POST " + url); return '{"ok":true}'; } };
}

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error("timed out waiting for: " + fn); await new Promise(r => setTimeout(r, 15)); } };

module.exports = { mockNode, mockNet, until, leaks, hex, root, KEY, ADDRESS };
