/*
 * test-node.cjs — THE one way a script in this repo may reach a live Minima node.
 *
 * Why this exists (0.18.161, from the dev branch 0.18.140): three scripts used to run `docker exec <a fixed container name> curl …` against
 * whatever container carried that name on the machine. On the owner's Mac that container is a wallet holding real
 * funds, and the "unit" suite booted the whole AtomiX engine on it (reading its seed) whenever docker was reachable.
 * No name, address or port of any node is written in this repo any more. A script gets a node ONLY when the caller
 * names one, and says it is theirs:
 *
 *   AX_TEST_NODE_RPC=http://127.0.0.1:<port>   the node's RPC address (no default; credentials may be in the URL)
 *   AX_TEST_NODE_CONTAINER=<name>              optional: the RPC address is reached from INSIDE this docker container
 *   AX_TEST_NODE_I_OWN_THIS=yes                required: "this is a test node of mine, with nothing to lose on it"
 *   AX_TEST_NODE_ADDRESS=<0x… or Mx…>          required ONLY for a node that holds funds: one of THAT node's own addresses
 *
 * THE BALANCE CHECK (from the dev branch 0.19.103). Before the first command a script sends, the node is asked `balance`. A node with
 * nothing on it passes. A node with ANY non-zero balance is REFUSED, unless AX_TEST_NODE_ADDRESS carries an address
 * and the node itself confirms (`checkaddress`) that it is one of its own simple addresses. A wrong container name
 * or port can then never pass: the wrong node is either empty, or it does not own the address written for the right
 * one. Nothing else has been sent when it refuses.
 *
 * With nothing set, testNode() returns null: the caller skips (unit suites) or refuses (live gates). With the node
 * named but not owned, or half named, the script stops with exit code 2 after printing what it WOULD have sent.
 */
const NAMES = "AX_TEST_NODE_RPC (and optionally AX_TEST_NODE_CONTAINER) with AX_TEST_NODE_I_OWN_THIS=yes (and AX_TEST_NODE_ADDRESS for a node that holds funds)";
const CHECK_SENDS = ["balance (a read, sent FIRST: a node that holds funds is refused unless AX_TEST_NODE_ADDRESS names one of its own addresses)",
  "checkaddress address:<AX_TEST_NODE_ADDRESS> (a read, only when the node holds funds)"];
const nonZero = (v) => /[1-9]/.test(String(v == null ? "" : v));

/**
 * Why this node must not be used ("" = it may). send(cmd) -> the node's reply. Sends `balance`, and `checkaddress`
 * only when something is held. Anything unreadable is a refusal: it is never assumed empty.
 */
async function balanceProblem(send, address) {
  let b; try { b = await send("balance"); } catch (e) { return "the node did not answer `balance` (" + ((e && e.message) || e) + "), so it cannot be told whether it holds funds. Nothing else was sent."; }
  if (!b || b.status !== true || !Array.isArray(b.response)) return "the node's answer to `balance` could not be read, so it cannot be told whether it holds funds. Nothing else was sent.";
  const held = b.response.filter(r => r && (nonZero(r.confirmed) || nonZero(r.unconfirmed) || nonZero(r.sendable)));
  if (!held.length) return "";
  const what = held.map(r => (r.tokenid === "0x00" ? "MINIMA" : "token " + r.tokenid) + " (confirmed " + r.confirmed + ", unconfirmed " + r.unconfirmed + ")").join("; ");
  const addr = String(address || "").trim();
  if (!addr) return "this node HOLDS FUNDS: " + what + ". A node with a balance is used only when AX_TEST_NODE_ADDRESS carries one of that node's own addresses (so that a wrong container name or port can never pass). Nothing else was sent.";
  if (!/^(0x[0-9A-Fa-f]{64}|Mx[0-9A-Z]{40,80})$/.test(addr)) return "AX_TEST_NODE_ADDRESS is not a Minima address: " + addr + ". Nothing else was sent.";
  let c; try { c = await send("checkaddress address:" + addr); } catch (e) { return "the node did not answer `checkaddress` (" + ((e && e.message) || e) + "). Nothing else was sent."; }
  if (!c || c.status !== true || !c.response || c.response.simple !== true) return "this node holds funds (" + what + ") and the address in AX_TEST_NODE_ADDRESS (" + addr + ") is NOT one of its own. This is not the node you named the address of. Nothing else was sent.";
  return "";
}

function stop(msg) { console.error("REFUSED: " + msg); process.exit(2); }

/** sends: plain-words lines of everything the caller is about to send to the node. → { run(cmd), where } or null. */
function testNode(sends, env = process.env, transport) {   // transport: tests only, in place of http / docker
  const rpc = String(env.AX_TEST_NODE_RPC || "").trim(), container = String(env.AX_TEST_NODE_CONTAINER || "").trim();
  if (!rpc && !container) return null;
  if (!rpc) stop("AX_TEST_NODE_CONTAINER is set but AX_TEST_NODE_RPC is not. Name the node's RPC address; there is no default.");
  let url; try { url = new URL(rpc); } catch (e) { stop("AX_TEST_NODE_RPC is not an address: " + rpc); }
  if (!/^https?:$/.test(url.protocol) || !url.port) stop("AX_TEST_NODE_RPC must be http://host:port with the port written out: " + rpc);
  if (container && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) stop("AX_TEST_NODE_CONTAINER is not a container name: " + container);
  const base = rpc.replace(/\/+$/, ""), where = container ? base + " inside the docker container " + container : base;
  console.log("About to use the node at " + where + ". It will be sent:");
  for (const line of CHECK_SENDS.concat(sends)) console.log("  - " + line);
  if (env.AX_TEST_NODE_I_OWN_THIS !== "yes") stop("AX_TEST_NODE_I_OWN_THIS=yes is not set. Nothing was sent. Set it only for a test node of your own that holds nothing you can lose.");
  const parse = (text) => { try { return JSON.parse(text); } catch (e) { throw new Error("bad RPC JSON: " + String(text).slice(0, 120)); } };
  const raw = transport || (container
    ? (cmd) => new Promise((resolve, reject) => require("child_process").execFile("docker", ["exec", container, "curl", "-s", "-m", "60", base + "/" + encodeURIComponent(cmd)],
        { maxBuffer: 64 * 1024 * 1024 }, (err, out) => { if (err) return reject(err); try { resolve(parse(out)); } catch (e) { reject(e); } }))
    : (cmd) => new Promise((resolve, reject) => {
        const req = require(url.protocol === "https:" ? "https" : "http").get(base + "/" + encodeURIComponent(cmd), { timeout: 60000 }, (res) => {
          let body = ""; res.on("data", d => body += d); res.on("end", () => { try { resolve(parse(body)); } catch (e) { reject(e); } });
        });
        req.on("timeout", () => req.destroy(new Error("RPC timed out"))); req.on("error", reject);
      }));
  // The balance check runs ONCE, before the first command of the caller, and every command waits for it.
  let checked = null;
  const run = (cmd) => {
    if (!checked) checked = balanceProblem(raw, env.AX_TEST_NODE_ADDRESS).then(why => { if (why) stop(why); });
    return checked.then(() => raw(cmd));
  };
  return { run, where };
}

/** What booting the AtomiX engine sends to a node. Said before the first command, in every script that boots it. */
const ENGINE_BOOT_SENDS = [
  "vault action:seed (READS THE NODE'S SEED PHRASE; it is used in memory to derive the AtomiX identity)",
  "seedrandom modifier:ethbridge (derives the node's AtomiX Ethereum private key)",
  "newscript (registers the two AtomiX swap contracts on the node, if they are not there)",
  "txnlist and txndelete (deletes leftover AtomiX transactions named axswap_…)",
  "getaddress, keys, scripts, checkmode, block, balance, coins, coinnotify action:add (reads; coinnotify adds a watched address)",
  "and, once booted, the engine's own pass: it settles any AtomiX swap it finds in its store (a new, empty store here)",
  "The engine also calls public Ethereum RPC endpoints and MEXC over the network with that node's Ethereum address."
];

module.exports = { testNode, balanceProblem, ENGINE_BOOT_SENDS, CHECK_SENDS, NAMES };
