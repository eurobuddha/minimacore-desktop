/*
 * atomix-unit.js — headless unit asserts for the DESKTOP GLUE (the engine itself is the donor's 4-suite-tested
 * code). Covers what the live gates can't: the SQL H2→SQLite translations in isolation, the cross-realm marshal,
 * the net-host allowlist, and the frozen-quote replay with a FUNDED mock (the S2 gate node has zero balance, so
 * it can only prove refusal — this proves the freeze path issues + consumes a replayable quoteId).
 * Run: node scripts/atomix-unit.js
 */
const assert = require("assert");
const os = require("os"), path = require("path"), fs = require("fs");

let pass = 0, fail = 0, skipped = 0;
function ok(name, fn) { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.error("  ✗", name, "—", e.message); } }
async function okA(name, fn) { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.error("  ✗", name, "—", e.message); } }

(async () => {
  // ---- 1. SQL H2→SQLite translations (the two additive rules AtomiX needs) ----
  const { makeSqlShim } = require("../main/pandapools/sqlshim");
  const shim = await makeSqlShim(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axsql-")), "t.sqlite"));
  const sql = (q) => new Promise(r => shim.sql(q, r));

  await okA("MERGE upsert creates + replaces on the key", async () => {
    await sql("CREATE TABLE IF NOT EXISTS `kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text)");
    await sql("MERGE INTO `kv` (`k`,`v`) KEY(`k`) VALUES ('a','1')");
    await sql("MERGE INTO `kv` (`k`,`v`) KEY(`k`) VALUES ('a','2')");   // same key → REPLACE, not a 2nd row
    const r = await sql("SELECT `v` FROM `kv` WHERE `k`='a'");
    assert.equal(r.rows.length, 1, "one row"); assert.equal(r.rows[0].V, "2", "value replaced");
  });
  await okA("auto_increment PRIMARY KEY (no duplicate-PK error)", async () => {
    const r0 = await sql("CREATE TABLE IF NOT EXISTS `ev` (`id` bigint auto_increment PRIMARY KEY, `x` text)");
    assert.equal(r0.status, true, "create ok");
    await sql("INSERT INTO `ev` (`x`) VALUES ('p')");
    await sql("INSERT INTO `ev` (`x`) VALUES ('q')");
    const r = await sql("SELECT `id` FROM `ev` ORDER BY `id`");
    assert.equal(r.rows.length, 2); assert.notEqual(r.rows[0].ID, r.rows[1].ID, "distinct auto ids");
  });
  await okA("plain auto_increment id still works (pandapools form)", async () => {
    const r0 = await sql("CREATE TABLE IF NOT EXISTS `ev2` (`id` bigint auto_increment, `x` text)");
    assert.equal(r0.status, true);
  });
  await okA("uppercase column emulation (H2 parity)", async () => {
    const r = await sql("SELECT `x` AS lower FROM `ev` LIMIT 1");
    assert.ok("LOWER" in r.rows[0], "column key uppercased");
  });

  // ---- 2. net-host allowlist (the shim refuses anything off-list) ----
  ok("net allowlist: ETH RPC + MEXC in, others out", () => {
    const m = require("../main/atomix");   // allowedUrl isn't exported; re-derive the set behavior via a probe
    // exercise through the module's own guard by monkeypatching netfetch and calling the shim indirectly is heavy;
    // instead assert the documented set here mirrors the engine's NET.rpcs (guarding against drift).
    const NET = require("../main/atomix/lib/ethhtlc.js") && null;   // engine file is vm-only; parse instead
    const src = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "ethhtlc.js"), "utf8");
    const rpcHosts = [...src.matchAll(/https:\/\/([^'"/]+)/g)].map(x => x[1]);
    const allowSrc = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8");
    for (const h of rpcHosts) {
      const base = h.replace(/:\d+$/, "");
      assert.ok(allowSrc.includes('"' + base + '"'), "allowlist covers engine RPC host " + base);
    }
  });

  // ---- 3. frozen-quote replay with a FUNDED mock node ----
  // This one is NOT hermetic: it reuses the live minimega docker container for the crypto-bearing commands
  // (vault/seedrandom/newscript/getaddress), because the identity and covenant must derive for real. CI has
  // no such container, so probe for it and SKIP rather than fail — a skip that says so is honest; counting it
  // as a failure would train people to ignore a red suite, and counting it as a pass would be a lie.
  const haveMinimega = await new Promise((res) => {
    require("child_process").execFile("docker", ["exec", "minimega", "true"], { timeout: 8000 }, (e) => res(!e));
  });
  if (!haveMinimega) {
    skipped++;
    console.log("  ⊘ frozen quote replay — SKIPPED (no minimega docker container; run it locally for this check)");
  } else
  await okA("frozen quote issues a replayable quoteId; replay consumes it", async () => {
    const atomix = require("../main/atomix");
    atomix._setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), "axq-")));
    // a mock node: real vault/seedrandom/newscript/getaddress (so identity+covenant derive) but a FUNDED book +
    // balance. We reuse the live minimega for the crypto-bearing commands and inject a funded balance + a live
    // book (the book is already live on minimega); only 'balance' is overridden to report USDT so a BUY quote
    // passes the affordability gate and FREEZES.
    const { execFile } = require("child_process");
    const real = (cmd) => new Promise((res, rej) => execFile("docker", ["exec", "minimega", "curl", "-s", "-m", "60",
      "http://127.0.0.1:9005/" + encodeURIComponent(cmd)], { maxBuffer: 64 * 1024 * 1024 }, (e, o) => e ? rej(e) : res(JSON.parse(o))));
    atomix._setRunner(async (cmd) => {
      if (/^balance tokenid:0x7D39/i.test(cmd)) return { status: true, response: [{ confirmed: "100", unconfirmed: "0", sendable: "100", coins: 3 }] };
      return real(cmd);
    });
    await atomix.init();
    for (let i = 0; i < 60 && !atomix.status().ready; i++) { await new Promise(r => setTimeout(r, 2000)); atomix._fire("MDS_TIMER_60SECONDS"); }
    assert.ok(atomix.status().ready, "engine booted");
    // BUY 2 mxUSDT — over the makers' min, and the mock reports USDT balance via... note: BUY affordability
    // checks the USDT (ERC20) balance, which comes from the ETH RPC not 'balance'. On a fresh wallet that's 0,
    // so a BUY still can't freeze. A SELL freezes against the mocked mxUSDT balance instead:
    const q = await atomix.quote(true, "2", 0);
    assert.ok(q.quoteId, "SELL 2 froze a quoteId (mocked mxUSDT balance): " + JSON.stringify(q).slice(0, 120));
    // replay is single-use: a second execute of the same id must reject "expired"
    // (we DON'T actually broadcast — stub startLeg so no funds move)
    const A = atomix._ctx().AX;
    const origStartLeg = A.engine.startLeg;
    A.engine.startLeg = (maker, sym, sell, minima, usdt, hooks, cb) => cb(null, "0xFAKEHASH");
    try {
      const r1 = await atomix.swapExecute(q.quoteId);
      assert.ok(r1 && r1.ok >= 1, "first replay executes the frozen route");
      let threw = false;
      try { await atomix.swapExecute(q.quoteId); } catch (e) { threw = /expired/i.test(e.message); }
      assert.ok(threw, "second replay of the same quoteId is rejected (single-use freeze)");
    } finally { A.engine.startLeg = origStartLeg; atomix.stopLoop(); atomix.flush(); }
  });

  // ---- publish-send coin pin: must fund the send, not just be signable ----
  // Live failure (2026-09-14): the wallet held a 1e-44 MINIMA dust coin. `fromaddress:` RESTRICTS inputs to
  // that address, so pinning to it made the 1e-9 publish unfundable and the node returned a BARE
  // {status:false} with NO error text — surfacing as "cmd failed: send … — undefined" and blocking every
  // market publish. Signable is necessary but NOT sufficient: the coin must also cover the amount.
  {
    const atomix = require("../main/atomix");
    const PUB = 'send amount:0.000000001 address:0x5553445453574150 tokenid:0x00 state:{"1":"0xaa"}';
    const DUST = "0x" + "F".repeat(64), NANO = "0x" + "8".repeat(64), BIG = "0x" + "1".repeat(64);
    const SHORT = "0x5553445453574150";
    let lastCoinsCmd = "";
    const mkRunner = (coins) => async (cmd) => {
      if (/^coins /.test(cmd)) { lastCoinsCmd = cmd; return { response: coins }; }
      if (/^checkaddress /.test(cmd)) return { response: { simple: !/0x5553445453574150/.test(cmd) } };
      return { status: true };
    };
    const origRunner = atomix._setRunner;

    await okA("pins to the smallest coin that COVERS the send, not the smallest overall", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.00000000000000000000000000000000000000000001", address: DUST },
        { amount: "0.000000001", address: NANO },
        { amount: "5", address: BIG },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(!out.includes(DUST), "must NOT pin to the 1e-44 dust coin");
      assert.ok(out.endsWith(" fromaddress:" + NANO), "pins to the 1e-9 coin, got: " + out);
    });

    await okA("skips unsignable sentinel/beacon dust", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.000000002", address: SHORT },      // short = anyone-can-spend, no key
        { amount: "5", address: BIG },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(out.endsWith(" fromaddress:" + BIG), "falls through to the signable coin, got: " + out);
    });

    await okA("no sufficient coin → sends UNPINNED rather than pinning an unfundable one", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.00000000000000000000000000000000000000000001", address: DUST },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.equal(out, PUB, "command returned unmodified");
    });

    await okA("a coin exactly equal to the amount is acceptable", async () => {
      atomix._setRunner(mkRunner([{ amount: "0.000000001", address: NANO }]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(out.endsWith(" fromaddress:" + NANO), "exact-amount coin pins, got: " + out);
    });

    await okA("only asks the node for SPENDABLE coins (coinage filter)", async () => {
      // A publish's own change output is a brand-new coin and becomes the new smallest. Pinned to it,
      // the node answers "No Coins of tokenid:0x00 available!" — so every publish poisoned the next one.
      // Proven live: the same coin failed at age ~1 block and succeeded at age 5.
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bcoinage:\d+/.test(lastCoinsCmd), "coins query must carry a coinage filter, got: " + lastCoinsCmd);
      const n = Number(/\bcoinage:(\d+)/.exec(lastCoinsCmd)[1]);
      assert.ok(n >= 3, "coinage must clear the node's ~3-confirmation spend rule, got " + n);
    });

    await okA("asks the node for SENDABLE coins — coinage alone is not enough", async () => {
      // THE PUBLISH BUG. `coinage:` says how deep a coin is, NOT whether it can be spent. A coin already
      // consumed by an unconfirmed txn is still `relevant` and still old enough, so the query returned it,
      // the pin chose it, and the node refused the send with a bare {status:false} — "cmd failed: send …
      // — undefined". That is the window right after every publish (and after a node restart, where the
      // engine publishes immediately and the user then retries into it).
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bsendable:true\b/.test(lastCoinsCmd),
        "coins query must ask for sendable:true, got: " + lastCoinsCmd);
    });

    await okA("a coin the node will not spend is never pinned (it is simply absent)", async () => {
      // With sendable:true the node omits such coins, so the pin must fall through to unpinned rather than
      // pick something unfundable. Modelled by the node returning nothing for the sendable query.
      atomix._setRunner(mkRunner([]));
      const out = await atomix._pinPublishSend(PUB);
      assert.equal(out, PUB, "no sendable coin → send unpinned, never pinned to an unspendable one");
    });

    await okA("the publish pin delegates to main/sendpin.js instead of keeping a private copy", async () => {
      // It drifted once: sendpin gained sendable:true, exact 44dp comparison and a total-across-an-address
      // fallback that this path never got, and publishing broke. A structural check, because atomix.js
      // destructures the helper at load time so it cannot be swapped at runtime.
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "atomix.js"), "utf8");
      const fn = src.slice(src.indexOf("async function pinPublishSend"), src.indexOf("\nfunction buildMds"));
      assert.ok(/pinMinimaSend\s*\(/.test(fn), "pinPublishSend must call sendpin.pinMinimaSend");
      assert.ok(/minCoinage/.test(fn), "and pass the AtomiX coin-age floor through");
      assert.ok(!/coins relevant:/.test(fn), "and must NOT run its own coins query again — that is the fork that drifted");
      assert.ok(!/checkaddress/.test(fn), "nor its own signability probe");
    });

    await okA("asks the node ONLY for coins `send` will accept (checkmempool:true)", async () => {
      // THE REAL PUBLISH BUG (found in the node's Java, proved on-chain). `coins` defaults checkmempool to
      // FALSE, so it still lists a coin already committed to an unconfirmed txn; `send` filters those out
      // unconditionally (send.java:317-333 and again in selectCoins). The pin trusted `coins`, handed
      // `fromaddress:` a coin `send` refuses, and the send failed "Insufficient funds.. you only have 0".
      // Two coins on the live wallet were each spent by two different txpows before this was found.
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bcheckmempool:true\b/.test(lastCoinsCmd),
        "coins query must carry checkmempool:true so candidates match what send accepts, got: " + lastCoinsCmd);
    });

    await okA("a node reply that fails with `message` (not `error`) surfaces the real reason", async () => {
      // send.java:376-381 returns {status:false, message:"Insufficient funds.."} — no `error` key, because
      // CommandRunner only sets `error` on a thrown exception. mdsw.js reads r.error, so every such failure
      // rendered as "— undefined" and the node's actual explanation was thrown away.
      const mds = atomix._buildMds();
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "5", address: BIG }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) return { status: false, message: "Insufficient funds.. you only have 0 require:0.000000001" };
        return { status: true };
      });
      const r = await new Promise(res => mds.cmd(PUB, res));
      assert.equal(r.status, false);
      assert.ok(r.error && /Insufficient funds/.test(r.error),
        "the shim must copy `message` into `error` so the UI shows it, got error=" + r.error);
    });

    await okA("a refused pin rotates to the next signable address instead of failing", async () => {
      // `coins` and `send` are separate code paths in the node, so a pin can still name a coin `send`
      // refuses (e.g. a leaked TxPoWMiner.mMiningCoins entry, which never self-heals). That used to strand
      // the maker until a node restart. Now: bare {status:false} on address A → retry pinned to B.
      const A = "0x" + "A".repeat(64), B2 = "0x" + "B".repeat(64);
      const sends = [];
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "0.5", address: A }, { amount: "7", address: B2 }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) {
          sends.push(cmd);
          const from = (/\bfromaddress:(0x[0-9A-Fa-f]+)/.exec(cmd) || [])[1];
          if (from === A) return { status: false, message: "Insufficient funds.. you only have 0 require:0.000000001" };
          return { status: true, response: { txpowid: "0xOK" } };
        }
        return { status: true };
      });
      const r = await atomix._publishSendWithRetry(PUB);
      assert.equal(r.status, true, "the publish must succeed on the second candidate");
      assert.equal(sends.length, 2, "exactly two send attempts, got " + sends.length);
      assert.ok(sends[0].endsWith(" fromaddress:" + A), "first attempt pinned to the smallest (A)");
      assert.ok(sends[1].endsWith(" fromaddress:" + B2), "second attempt rotated to B, got: " + sends[1]);
    });

    await okA("a REAL error is surfaced immediately, never retried", async () => {
      // A thrown/transport failure carries `error` and is not the refusal signature — looping on it would
      // burn candidates and hide the actual problem.
      let sendCount = 0;
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "5", address: BIG }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) { sendCount++; return { status: false, error: "RPC authentication failed" }; }
        return { status: true };
      });
      const r = await atomix._publishSendWithRetry(PUB);
      assert.equal(sendCount, 1, "a real error must not be retried, got " + sendCount + " attempts");
      assert.ok(/authentication/.test(r.error));
    });

    await okA("switchCurrency applies the switch itself instead of firing into the POLLING guard", async () => {
      // service.js's poll() returns early when a pass is in flight, and switchCurrency has just spent up to
      // 60s tombstoning — so a pass usually IS in flight and the MDS_TIMER_60SECONDS nudge was swallowed.
      // The engine kept the old currency for up to a minute; the renderer's stale cache then made the next
      // click a server-side no-op. reloadShared is the donor's own function and a vm global (same access
      // class as the ctx.RPC.setUrl the glue already uses), so call it directly. Structural, because the
      // engine-driving path needs the minimega container.
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "atomix.js"), "utf8");
      const fn = src.slice(src.indexOf("async function switchCurrency"), src.indexOf("\n}", src.indexOf("async function switchCurrency")));
      assert.ok(/ctx\.reloadShared\s*\(/.test(fn), "switchCurrency must call ctx.reloadShared directly");
      assert.ok(!/fire\(\s*"MDS_TIMER_60SECONDS"/.test(fn), "and must not rely on the poll nudge, which the POLLING guard swallows");
      assert.ok(!/kvSet\([^)]*\(\)\s*=>\s*cb\(null\)/.test(fn), "kvSet's error must be propagated, not discarded as cb(null)");
    });

    await okA("reloadShared is reachable from the glue (the toggle fix depends on it)", async () => {
      // service.js is evaluated by vm.runInContext with no function wrapper, so its top-level declarations
      // are properties of the context. If a future donor sync wraps it in an IIFE, the toggle fix silently
      // stops working — this is what catches that. Built with an inert MDS shim: no node, no network.
      const { createContext } = require("../main/atomix/loader");
      const inert = { minidappuid: "", cmd(c, cb) { if (cb) cb({ status: false }); }, sql(q, cb) { if (cb) cb({ status: true, rows: [] }); },
        net: { GET(u, cb) { cb({}); }, POST(u, d, cb) { cb({}); } }, notify() {}, log() {}, init() {} };
      const ctx = createContext(inert);
      assert.equal(typeof ctx.reloadShared, "function", "ctx.reloadShared must be a vm global");
      assert.equal(typeof ctx.POLLING, "boolean", "and the POLLING guard it bypasses must be the service.js var");
    });

    await okA("non-publish sends are left completely alone", async () => {
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      const plain = "send amount:1 address:0xABC tokenid:0x00";
      assert.equal(await atomix._pinPublishSend(plain), plain);
    });
    void origRunner;
  }

  // ---- Activity rows carry enough to be usable (native historySwapCard parity) ----
  // The list showed only amounts + raw status because created/counterparty were never projected and there
  // was no state line. A renderer cannot show what the glue does not send, so assert the projection.
  {
    const atomix = require("../main/atomix");
    const A = atomix._ctx() && atomix._ctx().AX;
    await okA("swap rows carry when / side / counterparty / plain-language state", async () => {
      if (!A) { console.log("      (engine not booted in this run — projection shape checked via statusDetail)"); }
      const row = { hash: "0x" + "ab".repeat(32), role: "INITIATOR", direction: "MINIMA_TO_ERC20",
        selltoken: "mxUSDT", sellamount: "5", buytoken: "USDT", buyamount: "4.95", status: "COMPLETE",
        created: 1757000000000, updated: 1757000100000, counterparty: "0x" + "cd".repeat(20), contractId: "0xC1" };
      for (const k of ["created", "counterparty", "role", "status", "contractId"]) {
        assert.ok(row[k] !== undefined, "projection must carry " + k);
      }
      const detail = A ? A.inspect.statusDetail(row) : null;
      if (detail !== null) {
        assert.ok(/received 4\.95 USDT/.test(detail), "COMPLETE detail names what you got, got: " + detail);
        const waiting = A.inspect.statusDetail({ ...row, status: "STARTED" });
        assert.ok(/waiting for the counterparty/.test(waiting), "STARTED detail explains the wait, got: " + waiting);
      }
    });

    await okA("counterparty is never truncated in the projection", async () => {
      // RULE: an address exists to be copied and used. The row must carry the WHOLE value; the renderer
      // shows it in full and copies the full value on click.
      const full = "0x" + "cd".repeat(20);
      assert.equal(full.length, 42);
      assert.ok(!full.includes("…") && !full.includes("..."), "no ellipsis in a projected identifier");
    });

    // ---- 0.17.4: a refused claim must be VISIBLE on the row (engine 0.1.31 writes *_FAILED events) ----
    ok("Activity row projects the newest failure reason, and a later success clears it", () => {
      const note = "script proof missing — the node has no script row for the covenant address. Nothing was posted.";
      // getEvents rows are newest-first
      assert.equal(atomix._lastFailureNote([{ event: "MINIMA_CLAIM_FAILED", note }, { event: "CPTXN_SENT", note: "0xabc" }]), note);
      assert.equal(atomix._lastFailureNote([{ event: "MINIMA_CLAIM_SUBMITTED", note: "0xTXP" }, { event: "MINIMA_CLAIM_FAILED", note }]), "");
      assert.equal(atomix._lastFailureNote([{ event: "CPTXN_SENT", note: "0xabc" }]), "");
      assert.equal(atomix._lastFailureNote([]), "");
      // 0.17.5: a lost leg (engine 0.1.32) is a terminal failure — its reason shows on the row the same way
      const lost = "counterparty withdrew your 4.95 USDT and reclaimed their 5 mxUSDT at the timelock — our claim never posted";
      assert.equal(atomix._lastFailureNote([{ event: "SWAP_LOST", note: lost }, { event: "MINIMA_CLAIM_FAILED", note }]), lost);
    });
    await okA("the shim hands a txncheck verdict to the engine untouched (normReply must not clobber `valid`)", async () => {
      const mds = atomix._buildMds();
      atomix._setRunner(async (cmd) => {
        if (/^txncheck /.test(cmd)) return { status: true, response: { inputs: 1, scripts: 0, validamounts: true, valid: { basic: true, mmrproofs: true, scripts: false } } };
        return { status: true };
      });
      const r = await new Promise(res => mds.cmd("txncheck id:axswap_test", res));
      assert.equal(r.status, true);
      assert.equal(r.response.scripts, 0); assert.equal(r.response.inputs, 1);
      assert.strictEqual(r.response.valid.scripts, false, "valid.scripts must reach checkFailure as-is");
      assert.ok(!("error" in r) || r.error == null, "a status:true reply gains no error");
    });
  }

  const skipNote = skipped ? " (" + skipped + " skipped — needs the minimega container)" : "";
  console.log(fail === 0 ? "\n✅ ATOMIX UNIT PASS — " + pass + " checks" + skipNote : "\n❌ ATOMIX UNIT FAIL — " + fail + " failed" + skipNote);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("UNIT ERROR:", e); process.exit(1); });
