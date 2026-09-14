/*
 * pandapools-signgate.test.cjs — guards the PandaPools engine catch-up shipped in Desktop 0.16.83.
 *
 * Before 0.16.83 the Desktop engine copies of poolmgr.js/service.js pre-dated the MDS 0.6.2x fund-safety
 * hardening: no serial signing gate, no SQL CoinLock, and $OADR was NOT excluded from funding selection.
 * That is the complete native-0.9.22 defect set, on the one surface whose 12s block poller drives scan +
 * NEWBLOCK + pending-sign resume in a single vm context over a single sqlite file. Two transactions signing
 * one key both read the same counter and sign the SAME Winternitz leaf over different data, which leaks that
 * leaf's private key (CHANGELOG 0.9.22: confirmed in the wild, "7 of 64 default keys flagged RE-USED x2").
 *
 * These tests exist so that never silently regresses. Every one of them drives the REAL loader context, so
 * the vm sandbox is exercised as shipped — see the setInterval test, which is the one that would otherwise
 * turn every fund action into a ReferenceError.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const desktop = process.env.PP_DESKTOP_ROOT || path.resolve(__dirname, '..');
const loader = require(path.join(desktop, 'main/pandapools/loader.js'));
const { makeSqlShim } = require(path.join(desktop, 'main/pandapools/sqlshim.js'));

const hash = n => '0x' + n.toString(16).padStart(64, '0');
const addr = hash(100), opk = hash(101), oadr = hash(102), tok = hash(103);
const good = response => ({ status: true, response });
const invoke = (fn, ...args) => new Promise(r => fn(...args, r));

function coin(n, token = '0x00', amount = '10', at = addr) {
  return { coinid: hash(n), address: at, tokenid: token, amount, tokenamount: amount,
           spent: false, state: [], created: 1000, token: { name: 'Test', decimals: 8 } };
}

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-signgate-'));
  const sql = await makeSqlShim(path.join(dir, 'pool.sqlite'));
  const trace = [];
  let responder = () => ({ status: false });

  // The REAL shim surface, and the REAL loader context — so the sandbox itself is under test.
  const mds = {
    sql: (q, cb) => sql.sql(q, cb),
    cmd: (q, cb) => { trace.push(q); const r = responder(q, cb); if (r !== undefined && cb) cb(r); },
    log() {}, init() {}, historyPageMax: 512,
    persistRecovery: cb => cb(sql.flushChecked()),
    archiveGET: (_u, cb) => cb(null),
    net: { GET: (_u, cb) => cb && cb({ status: false }) },
  };
  const c = loader.createContext(mds);
  await invoke(c.Store.init);

  const pool = () => ({
    address: addr, opk, oadr, tok, tokDecimals: 8, kmin: '50',
    script: c.Covenant.script(opk, oadr, tok, '50'),
    minimumOwnerUses: 590, signingStateUnverified: false,
    coinidM: hash(1), coinidT: hash(2),
    reserveM: new c.Decimal(10), reserveT: new c.Decimal(10),
  });

  return {
    c, sql, trace, pool,
    set: f => { responder = f; },
    close: () => { sql.flush(); sql._db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Async responder: replies on a later tick, so two chains CAN interleave if nothing serialises them. */
function asyncStandard(h, cs, opts) {
  const o = opts || {};
  return (q, cb) => {
    // Some engine calls are fire-and-forget (e.g. MDS.cmd("txndelete id:…") with no callback).
    const reply = (r) => { if (cb) setTimeout(() => cb(r), 0); };
    if (q === 'txnlist') return reply(good([]));
    if (q === 'checkmode') return reply(good({ writemode: true }));
    if (q === 'status') return reply(good({ megammr: false }));
    if (q === 'keys' || q.startsWith('keys action:list')) return reply(good([{ publickey: opk, uses: 846, modifier: '0x40' }]));
    if (q.startsWith('scripts address:')) return reply(good({ address: q.split(':')[1], simple: true, publickey: opk }));
    if (q.startsWith('runscript ')) return reply(good({ parseok: true, script: { address: addr } }));
    if (q.startsWith('newscript ')) return reply(good({ address: addr }));
    if (q.startsWith('getaddress')) return reply(good({ address: hash(500) }));
    if (q.startsWith('balance ')) return reply(good([{ coins: cs.length }]));
    if (q.startsWith('coins coinid:')) return reply(good(cs.filter(x => q.includes(x.coinid))));
    if (q.startsWith('coins address:')) return reply(good(cs.filter(x => q.toLowerCase().includes((x.address || '').toLowerCase()))));
    if (q.startsWith('coins ')) return reply(good(o.wallet || []));   // coins relevant:true sendable:true
    if (q.startsWith('txncreate') || q.startsWith('txninput') || q.startsWith('txnoutput')
        || q.startsWith('txnstate') || q.startsWith('txnsign') || q.startsWith('txnbasics')
        || q.startsWith('txndelete')) return reply(good({}));
    if (q.startsWith('txncheck')) return reply(good({ valid: { scripts: true, mmrproofs: true }, validamounts: true }));
    if (q.startsWith('txnpost')) return reply(good({ txpowid: hash(900) }));
    return reply({ status: false });
  };
}

const txidOf = q => { const m = /id:(\S+)/.exec(q); return m ? m[1] : null; };

// ---------------------------------------------------------------------------------------------------
// 1. The regression that would break every fund action on Desktop.
// ---------------------------------------------------------------------------------------------------
test('the vm sandbox provides setInterval and clearInterval to the engine', async () => {
  const h = await harness();
  try {
    for (const g of ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) {
      assert.equal(vm.runInContext('typeof ' + g, h.c), 'function',
        g + ' missing from the loader sandbox: poolmgr.js buildAndPost calls setInterval UNCONDITIONALLY for '
        + 'the sign-lock heartbeat, so every create/deposit/close/migrate/swap would throw ReferenceError');
    }
  } finally { h.close(); }
});

test('the engine carries the serial signing gate and the SQL CoinLock', async () => {
  const src = fs.readFileSync(path.join(desktop, 'main/pandapools/poolmgr.js'), 'utf8');
  for (const token of ['submitSign', 'acquireGlobalSignLock', 'pp_signlock', 'pp_coinlocks', 'reserveLocks', 'lockedMap']) {
    assert.match(src, new RegExp(token), 'poolmgr.js is missing ' + token + ' — the Desktop engine has drifted behind the MDS');
  }
  const svc = fs.readFileSync(path.join(desktop, 'main/pandapools/service.js'), 'utf8');
  for (const token of ['submitSignSvc', 'acquireGlobalSignLockSvc', 'pp_signlock']) {
    assert.match(svc, new RegExp(token), 'service.js is missing ' + token);
  }
});

// ---------------------------------------------------------------------------------------------------
// 2. The lock primitives behave through the Desktop sqlite shim (not sql.js-in-a-browser).
// ---------------------------------------------------------------------------------------------------
test('pp_signlock primary-key contention returns status false through the Desktop sql shim', async () => {
  const h = await harness();
  try {
    await invoke(h.c.MDS.sql, 'CREATE TABLE IF NOT EXISTS `pp_signlock` (`id` int primary key, `owner` varchar(160), `ts` bigint)');
    const first = await invoke(h.c.MDS.sql, "INSERT INTO `pp_signlock` (`id`,`owner`,`ts`) VALUES (1,'a',1)");
    assert.equal(first.status, true, 'the first lock acquisition must succeed');
    const second = await invoke(h.c.MDS.sql, "INSERT INTO `pp_signlock` (`id`,`owner`,`ts`) VALUES (1,'b',2)");
    assert.notEqual(second.status, true,
      'a second INSERT on the occupied primary key MUST report failure — the whole global sign lock depends on it');
    await invoke(h.c.MDS.sql, "DELETE FROM `pp_signlock` WHERE `id`=1 AND `owner`='a'");
    const third = await invoke(h.c.MDS.sql, "INSERT INTO `pp_signlock` (`id`,`owner`,`ts`) VALUES (1,'b',3)");
    assert.equal(third.status, true, 'the lock must be acquirable again once released');
  } finally { h.close(); }
});

test('pp_coinlocks primary-key contention prevents two selections reserving one coin', async () => {
  const h = await harness();
  try {
    await invoke(h.c.MDS.sql, 'CREATE TABLE IF NOT EXISTS `pp_coinlocks` (`coinid` varchar(160) primary key, `ts` bigint)');
    const a = await invoke(h.c.MDS.sql, "INSERT INTO `pp_coinlocks` (`coinid`,`ts`) VALUES ('" + hash(7) + "',1)");
    assert.equal(a.status, true);
    const b = await invoke(h.c.MDS.sql, "INSERT INTO `pp_coinlocks` (`coinid`,`ts`) VALUES ('" + hash(7) + "',2)");
    assert.notEqual(b.status, true,
      'reserving an already-reserved coin MUST fail — otherwise two transactions fund from the same coin and '
      + 'both sign, which is the 0.9.22 defect observed in the wild');
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------------------------------
// 3. Two concurrent owner-signed chains serialise: no two txnsign chains overlap.
// ---------------------------------------------------------------------------------------------------
test('two concurrent closes serialise — the second chain never starts before the first posts', async () => {
  const h = await harness();
  try {
    h.set(asyncStandard(h, [coin(1), coin(2, tok)]));
    const results = await Promise.all([
      new Promise(r => h.c.PoolMgr.close(h.pool(), { ok: id => r({ ok: id }), fail: m => r({ fail: m }) })),
      new Promise(r => h.c.PoolMgr.close(h.pool(), { ok: id => r({ ok: id }), fail: m => r({ fail: m }) })),
    ]);
    assert.equal(results.filter(x => x.ok).length, 2, 'both closes should complete: ' + JSON.stringify(results));

    // Build the per-txid windows from the command trace and assert they do not overlap.
    const creates = h.trace.map((q, i) => ({ q, i })).filter(x => x.q.startsWith('txncreate id:ppclose_'));
    assert.equal(creates.length, 2, 'expected exactly two close transactions, saw ' + creates.length);
    const windows = creates.map(x => {
      const id = txidOf(x.q);
      const post = h.trace.findIndex(q => q.startsWith('txnpost id:' + id));
      assert.notEqual(post, -1, 'no txnpost for ' + id);
      return { id, start: x.i, end: post };
    }).sort((a, b) => a.start - b.start);
    assert(windows[0].end < windows[1].start,
      'the two signing chains overlapped (' + JSON.stringify(windows) + ') — the serial signing gate is not '
      + 'holding, so two transactions can sign the same key leaf concurrently');

    const signs = h.trace.filter(q => q.startsWith('txnsign '));
    assert.equal(signs.length, 2, 'expected one owner signature per close');
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------------------------------
// 4. The glue queue drops an abandoned slot instead of posting late.
// ---------------------------------------------------------------------------------------------------
test('a fund action abandoned while queued is dropped before the engine is entered', async () => {
  // main/pandapools.js's queuedAction stamps a deadline BEFORE enqueueing. The hazard it closes: the engine's
  // serial gate makes an action wait somewhere the caller's timeout cannot see, so a slot can come up after the
  // UI already said "timed out — retry". Running it then would double-post against the same coins with both
  // attempts signing. This drives the queue directly: the point under test is that `run` is NEVER called.
  const glue = fs.readFileSync(path.join(desktop, 'main/pandapools.js'), 'utf8');
  const start = glue.indexOf('var ACTION_QUEUE');
  const end = glue.indexOf('function execDeadline');
  assert(start !== -1 && end > start, 'the glue action queue is missing from main/pandapools.js');
  const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Error };
  vm.createContext(sandbox);
  vm.runInContext(
    'function withTimeout(p, ms, msg) { return Promise.race([p, new Promise(function (_, rej) { '
    + 'setTimeout(function () { rej(new Error(msg)); }, ms); })]); }\n'
    + glue.slice(start, end), sandbox);

  // Shrink the wait budget so the test does not take ten minutes, then enqueue behind a job that never settles.
  vm.runInContext('ACTION_QUEUE_WAIT_MS = 40; ACTION_TOTAL_MS = 80;', sandbox);
  let secondRan = false;
  sandbox.blocker = () => {};                       // first slot: never settles, holds the queue
  sandbox.secondRun = () => { secondRan = true; };
  const outcome = await vm.runInContext(
    'Promise.all([' +
    '  queuedAction("first", function () { blocker(); }).then(function(){return "ok";}, function(e){return "rej:"+e.message;}),' +
    '  queuedAction("second", function () { secondRun(); }).then(function(){return "ok";}, function(e){return "rej:"+e.message;})' +
    '])', sandbox);

  assert.match(outcome[1], /^rej:/, 'the abandoned second action should have been rejected: ' + outcome[1]);
  assert.equal(secondRan, false,
    'the second action ran after its caller had already given up — a late dequeue MUST NOT reach the engine, '
    + 'or the UI-level retry double-posts and both attempts sign');
});

// ---------------------------------------------------------------------------------------------------
// 5. $OADR is never selected as funding.
// ---------------------------------------------------------------------------------------------------
test('funding selection never picks a coin at the pool owner payout address', async () => {
  const h = await harness();
  try {
    // A large tempting coin sitting at $OADR, and a smaller ordinary wallet coin. Largest-first selection
    // would take the $OADR one; excluding $OADR must leave the wallet coin. Funding from $OADR makes
    // `txnsign auto` sign with $OPK and then ownerSignPost signs again: two leaves for one action.
    const ownerCoin = coin(20, '0x00', '999', oadr);
    const walletCoin = coin(21, '0x00', '5', hash(200));
    h.set(asyncStandard(h, [coin(1), coin(2, tok)], { wallet: [ownerCoin, walletCoin] }));

    await new Promise(r => h.c.PoolMgr.refresh(h.pool(), { ok: () => r(), fail: () => r() }));

    const inputs = h.trace.filter(q => q.startsWith('txninput '));
    assert(inputs.length > 0, 'refresh built no inputs');
    assert(!inputs.some(q => q.includes(ownerCoin.coinid)),
      'a coin at $OADR was selected as funding — excl must carry p.oadr, not just p.address');
  } finally { h.close(); }
});
