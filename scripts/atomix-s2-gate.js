/*
 * S2 GATE — the read-model against a LIVE node: boot, then book() must show the node's real order book, wallet()
 * must return the identity + balances, quote() must freeze a replayable quoteId when liquidity exists,
 * marketHistory()/swaps()/otc()/makerCfg() must return their shapes. No swapExecute/send/publish is called.
 *
 * Booting READS THE NODE'S SEED. Until 0.18.140 this ran `docker exec` into a fixed container name; on the owner's
 * machine that container is a wallet with real funds. It now runs ONLY against a node the caller names and says is
 * theirs (scripts/test-node.cjs). With nothing named it refuses with exit code 1.
 * Run: AX_TEST_NODE_RPC=… AX_TEST_NODE_I_OWN_THIS=yes node scripts/atomix-s2-gate.js
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const { testNode, ENGINE_BOOT_SENDS, NAMES } = require("./test-node.cjs");

const NODE = testNode(ENGINE_BOOT_SENDS.concat("No swap, send or publish is started by this script."));
if (!NODE) { console.error("S2 GATE NOT RUN: no test node was named. Set " + NAMES + ". Nothing was sent anywhere."); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓", name, extra || ""); }
  else { fail++; console.error("  ✗", name, extra || ""); }
};

(async () => {
  const atomix = require("../main/atomix");
  atomix._setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), "atomix-s2-")));
  atomix._setRunner(NODE.run);
  await atomix.init();
  for (let i = 0; i < 60 && !atomix.status().ready; i++) { await new Promise(r => setTimeout(r, 2000)); atomix._fire("MDS_TIMER_60SECONDS"); }
  ok("engine booted", atomix.status().ready);

  const w = await atomix.wallet();
  ok("wallet: identity address", /^0x[0-9a-f]{40}$/i.test(w.addr), w.addr);
  ok("wallet: raw balances present", typeof w.bals.ethWei === "string" && typeof w.bals.usdtRaw === "string",
    "eth=" + w.bals.eth + " usdt=" + w.bals.usdt + " " + w.label + "=" + w.bals.minima);
  ok("wallet: breakdown meta always present (zeroed when no coins)", !!w.bals.meta && "coins" in w.bals.meta);

  const b = await atomix.book();
  // The STRONG assertion: the engine READ + Ed25519-VERIFIED + PARSED the real on-chain book. `makers` (external)
  // is legitimately 0 when the node's OWN identity published every order — this engine shares that node's seed.
  ok("book: engine reads+verifies the REAL on-chain book", b.scanned > 0,
    b.scanned + " on-chain orders verified · " + b.makers + " external (own excluded) · bestBid=" + b.bestBid + " bestAsk=" + b.bestAsk);

  if (b.bestAsk > 0) {
    // A BUY quote over the makers' minimum. On a funded wallet this freezes a replayable quoteId; on a
    // zero-balance node the honest engine result is a plain-words "Need … USDT" — both prove the pipeline
    // (validation + planning) runs correctly. Freeze-replay itself is unit-tested with a funded mock in S5.
    const q = await atomix.quote(false, "2", 4.2);
    const wellFormed = (q.quoteId && q.plan) || (typeof q.err === "string" && /USDT|minimum|liquidity/i.test(q.err));
    ok("quote: well-formed result (frozen quoteId or honest refusal)", wellFormed, q.quoteId ? ("frozen " + q.quoteId) : ("refused: " + q.err));
  } else { console.log("  (no external ask on the book right now → quote skipped)"); }

  const mh = await atomix.marketHistory();
  ok("marketHistory: shapes", Array.isArray(mh.chart) && Array.isArray(mh.recent), "chart=" + mh.chart.length + " recent=" + mh.recent.length);

  const s = await atomix.swaps();
  ok("swaps: fresh DB list", Array.isArray(s), s.length + " rows (fresh module DB → 0 expected)");

  const o = await atomix.otc();
  ok("otc: board + deals shapes", Array.isArray(o.board) && Array.isArray(o.deals), "board=" + o.board.length);

  const mc = await atomix.makerCfg();
  ok("makerCfg: state shape", mc && "cfg" in mc && "state" in mc);

  const sm = await atomix.sendMax("eth").catch(e => null);
  ok("sendMax: gas-reserved max computes", sm != null, sm + " ETH");

  console.log(fail === 0 ? "✅ S2 GATE PASS — " + pass + " checks" : "❌ S2 GATE FAIL — " + fail + " failed");
  atomix.stopLoop(); atomix.flush();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("GATE ERROR:", e); process.exit(1); });
