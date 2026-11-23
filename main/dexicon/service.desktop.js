/*
 * service.desktop.js — the Dexicon background engine as this desktop runs it (DESKTOP-OWNED; the lib/ crypto/ vendor/
 * resting/ files beside it are BYTE-IDENTICAL copies of mds/dexicon, enforced by scripts/dexicon-parity-manifest.cjs).
 *
 * A hand mirror of mds/dexicon/service.js at cefb6caf9fc6ac15e87ef39bb8597096d39d556f (0.0.153; was 0.0.91 at
 * 9a95eb114ad35d3e18692a60c248529762fd72d5; its sha256 is in the parity manifest, so a donor change is noticed). Ported from
 * 0.0.92-0.0.153 (0.19.406): lib/proofs.js and the coin proof requests answered after the takes (answerProofs), ONE maker
 * refresh at a time (runRefresh, its relock errors logged and said), the NEWBLOCK re-back of an order waiting coinless
 * for its relock (rebackOnBlock), the resting engine's coin reservations mirrored to kv (mirrorCoinLock), afterFill with
 * the fill's txpowid and the remaining the take was checked against, and that remaining kept on the fill_ record
 * (`verified`). Everything not listed here is the donor's text:
 *
 *   NOT LOADED  doors/ and lib/door.js (the AtomiX taker engine) and no axEvent: room 1 of this app is the real AtomiX
 *               engine on the same ETH key, and a second settlement engine on that key would collide.
 *   AUTO-CROSS  lib/autocross.js is loaded and run as in the MiniDapp (the user's own saved setting switches it on;
 *               it is off until then). It plans over pools only, never over an order, so it cannot fill the user's own
 *               order; that it may trade with the user's own pool is the owner's decision (19 Nov 2026), see
 *               docs/DEXICON_ENGINE_NOTES.md (a).
 *   ASYNC NET   MDS.net is SYNCHRONOUS in the node's Rhino and ASYNC here, so (as in DexiconPro's host) tick(done) has
 *               an overlap guard and a 120 s watchdog: a 10 s timer can no longer start a second tick while one is still
 *               co-signing (that would process one take twice).
 *   NO VAULT    retireOldIdentity never reads `vault action:seed` (the donor does, once, to cancel orders signed by a
 *               pre-0.0.4x seed-phrase identity). This store never held such an identity; orders of an identity that is
 *               no longer this node's expire on their own.
 *   FOREIGN     (0.18.106) retireOldIdentity REFUSES to go READY on a store whose recorded public identity is not the
 *   STORE       one this wallet derives: here the identity is always the node's own derivation, so a different one
 *               means the wallet under the app was replaced (a restore, a resync, another data folder) and the store's
 *               orders belong to the old wallet. Going on would re-back them with the NEW wallet's coins while they
 *               still pay the OLD wallet's address. The host moves the store aside (MDS.foreignStore) and starts
 *               clean. Until the check has passed the RESTING engine is not booted either (STORE_MINE).
 *   RETRY       PDService.boot() is tried again (once a minute) while the resting engine is not ready: the MiniDapp
 *               gets one `inited` per node start, this host gets one per app start. (0.19.373) An ERROR that ends a
 *               boot is logged with its message and kept as the reason the resting engine is not ready (DX.restingWhy,
 *               restingWhy on every STATE packet), so the screens can say why and refuse an on-chain action at once.
 *   BOOT FIRST  (0.19.382) NEWBLOCK is not delivered to the resting engine (PDService.refresh) until its boot has ended
 *               READY. A refresh during the boot's own key load (retryKeysIfStale: keys not ready yet, block > 0) started a
 *               second loadKeys, which replaced PDService.keyLoad: the boot's load then returned silently (its current()
 *               check) and the boot never reached READY ("its start did not finish within 5 minutes"), every retry alike.
 *               The boot reads the tip and refreshes by itself when it ends; a failed boot is retried as before (RETRY).
 *   READ MODEL  DX (bottom of the file): ready / publicId / book / mine for the screens, and a relay book poll to feed
 *               it (in the MiniDapp the page polls the book itself). Read-only: it places, changes and cancels nothing.
 *   REFUSALS    (0.18.108) reply() sends a `refused` at LOW priority (the host's MDS.net.POST, 4th argument): it waits
 *               behind every take, "taken" reply, order and read in the host's bounded lane, and the oldest are
 *               dropped when more than 32 wait. A refusal carries no signature; a taker voids an unanswered take by
 *               itself. In the node MDS.net is synchronous, so the donor's replies cannot pile up; here 16 refused
 *               takes were 16 concurrent POST chains. Every other reply goes out as in the donor, never dropped.
 *   POST        (0.18.117) A maker's co-signed take whose txnpost the node never answered (it was stopping) may be
 *   UNANSWERED  on the chain or not. The donor treats it as a failure: the taker is told "refused" and the order stays
 *               at full size, so a fill that did go out was unrecorded and the order was backed again in full. Here
 *               (handleTake unanswered, settleFills settleUnknown): the outcome is recorded at once as a fill with
 *               status 'unknown' (written to disk before anything else), the order is reduced as if it was posted, and
 *               the taker is told nothing (a taker voids an unanswered take by itself, and "taken" needs a txpowid
 *               this node never got). (0.19.406) afterFill counts a fill once by its txpowid (0.0.146 refuses one without),
 *               and this one has none: it is applied under its own id (unansweredId: 0x + 48 zeros + 16 hex of the record's
 *               time and sequence, never a real txpowid), kept on the record as `applied`; the record's txpowid stays '' so
 *               reconcileFills never deducts it a second time. The chain decides later: one of the take's output coins exists = done; this
 *               node's own input coin is unspent and out of the mempool ten minutes on, or nothing after two hours =
 *               lost, and the amount is put back on the order.
 *   ATTEST      (0.19.406) the coin-key attestation the donor signs while answering proof requests (0.0.128/0.0.152) is
 *   OFF         OFF here: answerProofs passes no signing key and kv attest_sign is '0' at every boot (this wallet signs
 *               no statement for a stranger yet; the owner's call). Coin proofs are answered as in the donor.
 *   NEWBLOCK    (0.19.406) the donor's NEWBLOCK re-back runs under the tick's guard: while a tick runs it is only marked
 *   RE-BACK     due (rebackDue) and the next tick's refresh does it, so it never overlaps a co-sign or a ladder pass.
 *   FILL        (0.19.406, from DexiconPro 0.2.150/0.2.158/0.2.159) a co-signed fill whose afterFill did not save keeps
 *   PENDING     its order's coins locked and every further take of that order refused (FILL_PENDING) until a retry (every
 *               tick, before the takes) or the refresh's reconcileFills has applied it; and every take is checked against
 *               the TRUE remaining (the stored one less every maker fill_ record not applied yet): a take of an order with
 *               an unapplied record is refused as busy until the refresh applies it. The records unreadable: refused.
 *   SAID        (0.19.406) a save that did not land (the engine's store lock, a fill not applied, a relock that failed), a
 *               take refused for one of the reasons above: a packet to the screens ({type: save_failed | take_refused |
 *               relock_failed, message}), never only a log line (renderer/dexicon-ui.js shows it).
 *   OWN ORDERS  as the donor since 0.0.91: lib/ownskip.js wraps the two planners so an order routes PAST this node's own
 *               on-chain orders, and a LIMIT with nothing but own orders inside its limit is answered with the engine's
 *               sentence and sends nothing (onlyOwnOrders). The desktop's own refusal rule (selfTrade, 0.18.99) is gone.
 */
MDS.load('lib/rhino_shim.js');   // MUST be first — Uint8Array.slice/.fill polyfills Rhino lacks
MDS.load('vendor/nacl.js');
MDS.load('vendor/blake.js');
MDS.load('vendor/sha256.js');
MDS.load('vendor/sha512.js');
MDS.load('vendor/decimal.js');   // exact decimal math (PandaDEX's vendored decimal.js; Rhino-safe)
MDS.load('lib/hex.js');
MDS.load('lib/flow.js');
MDS.load('crypto/ax_sodium.js');
MDS.load('lib/identity.js');
MDS.load('lib/mdsw.js');
MDS.load('lib/prng.js');       // seal() needs entropy; the vm has no crypto.getRandomValues either (node-seeded CSPRNG)
MDS.load('lib/envelope.js');
MDS.load('lib/relay.js');
MDS.load('lib/fill.js');
MDS.load('lib/maker.js');
MDS.load('lib/proofs.js');   // the coin proof hand-over: a taker whose node cannot see one of my backing coins asks for its proof
MDS.load('lib/ladder.js');   // the FAST market maker (ORDERS › MARKET MAKER), reconciled every tick below
// RESTING layer: the PandaDEX engine, service.js's own load order. decimal.js is already loaded above.
MDS.load('resting/safety.js'); MDS.load('resting/covenant.js'); MDS.load('resting/input-claims.js'); MDS.load('resting/funding.js'); MDS.load('resting/signlock.js');
MDS.load('resting/book.js'); MDS.load('resting/pool.js'); MDS.load('resting/composite.js'); MDS.load('resting/txn.js');
MDS.load('resting/tape.js'); MDS.load('resting/maker.js'); MDS.load('resting/price.js'); MDS.load('resting/verifier.js');
MDS.load('resting/pending.js'); MDS.load('resting/stats.js'); MDS.load('resting/split.js'); MDS.load('resting/chain.js');
MDS.load('resting/history.js'); MDS.load('resting/pd_service.js');
mirrorCoinLock(PandaCoinLock);   // the page's coin choosers see the resting engine's reservations (lib/maker.js holds)
MDS.load('lib/autocross.js');   // trades PandaPools back to the ladder's rungs (needs the resting/ engine above)
MDS.load('lib/ownskip.js');     // an order never fills against my own on-chain order: the planners route past them
AX.ownskip.install(PandaComposite, PandaBook, PDService.isMine, PDService.keysUsable);
AX.ladder.feed(PandaPrice);     // MEXC unreachable → MEXC's own ticker via CoinGecko (lib/ladder.js); never another exchange

var ME = null, RELAY = null, READY = false, BOOTING = false, lastBootTryMs = 0, lastBootLog = '';
var BOOT_RETRY_PACE_MS = 55000, HOLD_SECONDS = 8, REFRESH_EVERY_TICKS = 6;
var IDENTITY_CONTEXT = 'decks';   // protocol constant from the working title; renaming it would re-derive every identity (SPEC §2)
var ticks = 0, myAddresses = {}, coinLocks = {};   // coinid -> unix ms the lock expires (3 min)
var LOCK_MS = 180000;
var TICKING = false, tickStartedMs = 0, TICK_WATCHDOG_MS = 120000, tickSeq = 0;
var lastPdBootMs = 0;
var STORE_MINE = false;   // FOREIGN STORE (header): true once the store is known to be this wallet's
var ATTEST_OFF = '0';     // ATTEST OFF (header): kv attest_sign at every boot
var rebackDue = false;    // NEWBLOCK RE-BACK (header): a re-back asked for while a tick ran

function log(s) { MDS.log('[dexicon] ' + s); }
function logOnce(s) { if (s !== lastBootLog) { lastBootLog = s; log(s); } }
function nowS() { return Math.floor(Date.now() / 1000); }
function notify(obj) { try { MDS.comms.solo(JSON.stringify(obj)); } catch (e) { } }
/** service.js, verbatim (review 23 Nov, MINOR): PandaCoinLock (resting/funding.js, vendored: never edited) lives in this service's memory; the
 *  page's create/edit (lib/maker.js holds) cannot see it. Every reserve / claim / finish / release is mirrored to kv
 *  'coinlock_held' = {lc coin id: until ms} (a reservation lasts 3 min; a claimed input until it is finished, 10 min). */
function mirrorCoinLock(L) {
    var held = {}, TTL = 180000;
    function lk(x) { return String(x && x.coinid ? x.coinid : x).toLowerCase(); }
    function save() { var now = Date.now(), k; for (k in held) if (held[k] <= now) delete held[k]; AX.mds.kvSet('coinlock_held', JSON.stringify(held), function () { }); }
    function wrap(name, f) { var orig = L[name]; if (typeof orig !== 'function') return; L[name] = function (x) { var r = orig.apply(L, arguments); if (r !== false) { try { (x || []).forEach(f); save(); } catch (e) { } } return r; }; }
    wrap('reserve', function (c) { held[lk(c)] = Date.now() + TTL; });
    wrap('claimInputs', function (id) { held[lk(id)] = Date.now() + 10 * 60000; });
    wrap('finishInputs', function (id) { held[lk(id)] = Date.now() + TTL; });
    wrap('release', function (c) { delete held[lk(c)]; });
}
/** SAID (header): the engine's words for a save of my orders that did not land (lib/maker.js withLock / fencedWrite /
 *  afterFill), said to the screens as well as logged. Nothing was placed, cancelled or published by such a save. */
var SAVE_FAILED = /store is held by another writer|store lock could not be used|stored orders could not be read|stored orders are unreadable|the save of your orders|not saved, nothing published|cancel failed, retried next pass|ladder cancel \S+ (\(\S+\) )?failed|was NOT applied/;
function saveFailed(where, e) {
    var m = String((e && e.message) || e || '');
    if (SAVE_FAILED.test(m)) notify({ type: 'save_failed', where: where, message: m });
}

function tryBoot() {
    if (READY || BOOTING) return;
    var now = Date.now();
    if (lastBootTryMs > 0 && now - lastBootTryMs < BOOT_RETRY_PACE_MS) return;
    lastBootTryMs = now; BOOTING = true;
    AX.mds.kvInit(function (kvErr) {
        if (kvErr) { BOOTING = false; logOnce('kv init failed: ' + kvErr.message); return; }
        writeTrust(function (why) {
          if (why) { BOOTING = false; logOnce('NOT RUNNING: ' + why); return; }
          identitySeed(function (err, seed) {
            BOOTING = false;
            if (err || !seed) { logOnce('boot waiting: ' + (err ? err.message : 'no derived seed (pending/locked?)') + '; retrying'); return; }
            var me = AX.identity.fromSeed(seed, IDENTITY_CONTEXT);
            retireOldIdentity(me, function (mine) {
                if (!mine) return;   // another wallet's store, or one that could not be read: never READY on it
                ME = me; STORE_MINE = true;
                RELAY = new AX.relay.Client(AX.relay.mdsTransport(AX.mds));
                AX.prng.init(function (pe) { if (pe) log('PRNG init failed: ' + pe.message + ' — sealed replies will fail until it succeeds'); });
                loadRelays(function () {
                    AX.mds.kvSet('publicId', ME.publicId(), function () {});
                    AX.mds.kvSet('attest_sign', ATTEST_OFF, function () {});   // ATTEST OFF (header)
                    READY = true;
                    log('booted — publicId ' + ME.publicId() + '; relays: ' + RELAY.relays.length);
                    pdBoot();
                    refreshAddresses(function () { tick(function () {}); });
                });
            });
          });
        });
    });
}

/** The donor's preflight. The host answers `checkmode` itself (the node's own RPC is its admin interface: there is no
 *  READ trust to be parked in); a password-locked node then shows as failed signatures, which every chain reports. */
function writeTrust(cb) {
    AX.mds.cmd('checkmode', function (r) {
        var m = r && r.response;
        if (m && m.writemode === false) return cb('the node refuses write commands');
        if (m && m.dblocked === true) return cb('the node is password-locked — unlock it (vault action:passwordunlock).');
        cb(null);
    });
}

/** Security review 30 Oct (mirror of the APK 0.1.50 SeedSource): the identity input is a one-way node derivation —
 *  the node's phrase and master seed never enter this engine. cb(err, '0x' + 64 hex). */
function identitySeed(cb) {
    AX.mds.cmdR('seedrandom modifier:dexicon-identity-v1', function (err, r, full) {
        var v = r && String(r.seedrandom || '');
        if (err) return cb(err);
        if (full && full.pending === true) return cb(new Error('the node parked it as pending'));
        if (!/^0x[0-9A-Fa-f]{64}$/.test(v)) return cb(new Error('no derived seed (pending/locked?)'));
        cb(null, v);
    });
}

/** NO VAULT, FOREIGN STORE (header). done(true) only when the store is this wallet's: it records no public identity
 *  yet (a new store), or the one `me` is. A store of another identity: the host is told (it moves the store aside and
 *  starts an empty engine) and done(false). A store that cannot be READ is not taken for a new one: done(false), and
 *  the boot is tried again. Read with sql, not kvGet: kvGet answers a failed read with its default. */
function retireOldIdentity(me, done) {
    AX.mds.sql("SELECT v FROM ax_kv WHERE k='publicId'", function (r) {
        var row = r && r.status && r.rows && r.rows.length ? r.rows[0] : null, old = row ? String(row.V || row.v || '') : '';
        if (!r || !r.status) { logOnce('boot waiting: the store could not be read (' + ((r && r.error) || 'no reply') + '), so it is not known whose it is; retrying'); return done(false); }
        if (!old || old.toLowerCase() === me.publicId().toLowerCase()) return done(true);
        log('NOT STARTING on this store: it was written by trading identity ' + old + ' and this wallet derives ' + me.publicId() + '. Its orders belong to the old wallet and are left to expire on their own.');
        MDS.foreignStore(old, me.publicId());
        done(false);
    });
}

var devTokenLogged = '';
function loadRelays(cb) {
    AX.mds.kvGet('relays', 'unset', function (val) {
        var list = AX.relay.fromKv(val);
        RELAY.setRelays(list);
        // Re-read every tick: the page may set the dev-chain dollar token after the service booted.
        AX.mds.kvGet('mxusd_tokenid', '', function (t) {
            if (!t) return cb();
            AX.fill.overrideOnTestChain(AX.mds, t, function (ok) {   // never on mainnet (security review 30 Oct)
                if (ok && t !== devTokenLogged) { devTokenLogged = t; log('DEV: dollar leg token overridden to ' + t); }
                if (!ok && devTokenLogged !== 'refused') { devTokenLogged = 'refused'; log('dollar-token override IGNORED: not a test chain'); }
                cb();
            });
        });
    });
}

/** Every address that holds one of my coins + the default address: "is this input mine?" for the verifier. */
function refreshAddresses(cb) {
    AX.mds.cmdR('coins relevant:true', function (err, rows) {
        if (!err && Object.prototype.toString.call(rows) === '[object Array]') for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].address) myAddresses[String(rows[i].address).toLowerCase()] = true;
        AX.mds.cmdR('getaddress', function (e2, a) { if (!e2 && a && a.address) myAddresses[String(a.address).toLowerCase()] = true; cb(); });
    });
}
function addressList() { var out = []; for (var k in myAddresses) out.push(k); return out; }

function lockCoins(ids) { var t = Date.now(); for (var i = 0; i < ids.length; i++) if (coinLocks[ids[i]] && coinLocks[ids[i]] > t) return false; for (i = 0; i < ids.length; i++) coinLocks[ids[i]] = t + LOCK_MS; return true; }
function unlockCoins(ids) { for (var i = 0; i < ids.length; i++) delete coinLocks[ids[i]]; }

/** One service cycle (the donor's tick). done() is called exactly once on every path: the overlap guard depends on it. */
function tick(done) {
    if (!READY) return done();
    if (TICKING) {
        if (Date.now() - tickStartedMs < TICK_WATCHDOG_MS) return done();
        log('tick watchdog: the previous cycle never finished after ' + (TICK_WATCHDOG_MS / 1000) + ' s — starting a new one');
    }
    TICKING = true; tickStartedMs = Date.now();
    // Each cycle has its own number (0.19.242): a cycle the watchdog gave up on that finishes late must not clear the guard
    // of the cycle running now (two cycles would then overlap on the same takes and coins).
    var finished = false, mySeq = ++tickSeq;
    function end() { if (finished) return; finished = true; if (mySeq === tickSeq) TICKING = false; done(); }
    ticks++;
    // review 7 Nov (C-1): about once a minute, free resting input claims whose post provably never happened
    // (two-phase in PoolInputClaims: held >= 10 min, the coin unspent and NOT in the mempool)
    if (ticks % 6 === 0 && typeof PoolInputClaims !== 'undefined' && typeof PDService !== 'undefined') PoolInputClaims.sweepUnposted(PDService.cmd, Date.now());
    if (ticks % 3 === 0) voidSweep();
    loadRelays(function () {
        if (!RELAY.relays.length) { logOnce('no relays configured'); return end(); }
        RELAY.pollInbox(ME.publicId(), HOLD_SECONDS, function (err, msgs, url) {
            if (err) logOnce('inbox poll ' + url + ' failed: ' + err.message);
            var takes = [], perSender = {}, asks = [], askers = {};   // flood limits (review 30 Oct): 2 takes per sender, 16 per cycle; proof requests: 64 senders per cycle (0.0.138; AX.proofs.answer queues them, round robin), one sender's requests merged up to 32 coins
            for (var i = 0; i < (msgs || []).length; i++) {
                var opened = AX.identity.open(ME, msgs[i].env.blob);
                if (!opened || !opened.valid) continue;
                var inner; try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { continue; }
                if (inner && inner.k === 'take' && opened.fromPublicId && takes.length < 16 && (perSender[opened.fromPublicId] || 0) < 2) {
                    perSender[opened.fromPublicId] = (perSender[opened.fromPublicId] || 0) + 1;
                    inner._from = opened.fromPublicId; takes.push(inner);
                } else if (inner && inner.k === 'proofs?' && opened.fromPublicId && Object.prototype.toString.call(inner.coins) === '[object Array]' && (askers[opened.fromPublicId] || asks.length < 64)) {   // 0.0.128: coins may be [] when only attestations are asked
                    // 0.0.116: a taker asks once per ORDER, so several requests of one sender in one poll are merged (up to 32
                    // coins), never dropped: the 0.0.111 "one per sender" left every order but the first unanswered for 10 blocks
                    var aq = askers[opened.fromPublicId] || (askers[opened.fromPublicId] = asks[asks.push({ from: opened.fromPublicId, coins: [], attest: [], seen: {} }) - 1]);
                    for (var ci = 0; ci < inner.coins.length && aq.coins.length < 32; ci++) { var ck = String(inner.coins[ci]).toLowerCase(); if (!aq.seen[ck]) { aq.seen[ck] = true; aq.coins.push(inner.coins[ci]); } }   // NIT: de-duplicated before the cap
                    // 0.0.128: the addresses whose coin-key attestation the taker wants (up to 32); ATTEST OFF (header): none is signed here
                    var at = Object.prototype.toString.call(inner.attest) === '[object Array]' ? inner.attest : [];
                    for (ci = 0; ci < at.length && aq.attest.length < 32; ci++) { var ak = 'a:' + String(at[ci]).toLowerCase(); if (!aq.seen[ak]) { aq.seen[ak] = true; aq.attest.push(at[ci]); } }
                }
            }
            processTakes(takes, function () { answerProofs(asks, function () {
                if (ticks % 3 === 0) settleFills();
                // owner 7 Nov (mirror of APK 0.2.81): the relay check reads every relay's whole book in turn — a repair sweep,
                // so once a minute or straight after a take, not every 10 s tick in front of the next inbox poll
                var sync = takes.length > 0 || ticks % 6 === 0;
                ladderPass(function () { crossPass(function () { afterCross(function () {
                    (sync ? AX.maker.syncRelays : function (a, b, c, cb) { cb({ lines: [] }); })(AX.mds, RELAY, ME, function (rep) {   // then every relay must match this node
                        (rep && rep.lines || []).forEach(function (l) { log(l); });
                        // NEWBLOCK RE-BACK (header): a re-back asked for during this tick is done by its refresh
                        if (ticks % REFRESH_EVERY_TICKS !== 0 && !rebackDue) return end();
                        rebackDue = false;
                        refreshAddresses(function () { runRefresh(end); });
                    });
                }); }); });
            }); });
        });
    });
}

function refreshed(e, n, relocked, relockErrs) {
    if (e) { log('refresh failed: ' + e.message); saveFailed('refresh', e); }
    else if (n || relocked) log('refresh republished ' + n + ' order(s)' + (relocked ? '; relocked stale backing coins in txpow ' + relocked : ''));
    (relockErrs || []).forEach(function (r) {   // 0.0.102: never swallowed (SAID, header)
        log('refresh: ' + r + ' — the order stays coinless; the relock is retried after a backoff (2 blocks, doubling to 64)');
        notify({ type: 'relock_failed', message: String(r) });
    });
}
/** 0.0.109 (review 22 Nov, MINOR 5): one maker refresh at a time — the minute's tick and NEWBLOCK never overlap. A
 *  refresh that never called back frees the slot after 5 minutes (orders must keep their 60-minute heartbeat). done():
 *  at once when the slot is taken, else when the refresh has called back. */
var refreshingSince = 0, REFRESH_STUCK_MS = 5 * 60000;
function runRefresh(done) {
    done = done || function () { };
    if (refreshingSince && Date.now() - refreshingSince < REFRESH_STUCK_MS) return done();
    var mine = refreshingSince = Date.now();
    AX.maker.refresh(AX.mds, RELAY, ME, function (e, n, relocked, relockErrs) { if (refreshingSince === mine) refreshingSince = 0; refreshed(e, n, relocked, relockErrs); done(); });
}
/** 0.0.102: an order placed or edited on coins that had to be refreshed is published coinless; it is re-backed on the
 *  block that confirms the relock, not up to a minute later at the tick's refresh. Only an order coinless because a
 *  relock of its coins is pending counts (AX.maker.awaitingBacking); nothing to do → nothing runs. NEWBLOCK RE-BACK
 *  (header): while a tick runs it is only marked due, and that tick's end does it. */
function rebackOnBlock() {
    if (TICKING && Date.now() - tickStartedMs < TICK_WATCHDOG_MS) { rebackDue = true; return; }
    AX.maker.load(AX.mds, function (e, list) { if (AX.maker.awaitingBacking(list)) runRefresh(); });
}

/** 0.0.111, the coin proof hand-over (lib/proofs.js): a taker whose node cannot see a coin backing one of my live orders
 *  (older than its window) asks for the coin's proof; it gets `coinexport` of each such coin, sealed to it. Takes are
 *  answered first; a request never makes this node export a coin that backs no live order of mine. Review 23 Nov (M1):
 *  one poll seals at most 2 messages / 120K chars in at most 3 s (AX.proofs.answer); the rest waits for the next poll,
 *  after its takes. ATTEST OFF (header): no signing key is passed, so no attestation is signed. */
function answerProofs(asks, done) {
    if (!asks.length && !AX.proofs.pending()) return done();
    AX.maker.load(AX.mds, function (e, list) {
        AX.proofs.answer(AX.mds, list || [], asks, function (replies) {
            replies.forEach(function (r) {
                RELAY.publish(r.raw, function () {});
                var na = r.coins.filter(function (c) { return c.indexOf('a:') === 0; }).length;
                log('coin proofs sent to ' + r.to + ': ' + (r.again ? 'the reply already sealed at this height, again' : (r.coins.length - na) + ' coin(s), ' + na + ' attestation(s), ' + r.raw.length + ' chars'));   // NIT: no coin list (up to 32 ids a line)
            });
            done();
        }, sealed);
    });
}

/** Review 7 Nov (M-1, mirror of APK MakerService.voidStaleTakes): a signed take has no expiry, so a maker could hold an
 *  unanswered one and post it hours later, only if the price moved its way. The page voids a take unanswered for 5 min
 *  (spends one of MY coins in it back to me) - but only while it is open. With the page closed for 2 min, the service
 *  does the same from the same kv records ('pending_takes', 'void_takes'): only an ON-CHAIN spend settles a take; a
 *  coin unspent everywhere is relocked to me; a mempool-only spend is looked at again later. */
var VOID_AFTER_MS = 5 * 60000, UI_GONE_MS = 2 * 60000, voidingSvc = {};
function voidSweep() {
    AX.mds.kvGet('ui_alive', '0', function (alive) {
        var now = Date.now();
        if (now - (Number(alive) || 0) < UI_GONE_MS) return;   // the open page owns its takes
        AX.mds.kvGet('pending_takes', '{}', function (pv) {
            var pending = {}, voids = {}, moved = false;
            try { pending = JSON.parse(pv || '{}') || {}; } catch (e) { pending = {}; }
            AX.mds.kvGet('void_takes', '{}', function (vv) {
                try { voids = JSON.parse(vv || '{}') || {}; } catch (e) { voids = {}; }
                Object.keys(pending).forEach(function (k) {
                    var pt = pending[k] || {};
                    if (now - (Number(pt.sent) || 0) > VOID_AFTER_MS) { voids[k] = { mine: pt.mine || [], act: pt.act || '' }; delete pending[k]; moved = true; }
                });
                if (moved) { AX.mds.kvSet('pending_takes', JSON.stringify(pending), function () { }); AX.mds.kvSet('void_takes', JSON.stringify(voids), function () { }); }
                Object.keys(voids).forEach(function (k) { voidOne(k, voids[k]); });
            });
        });
    });
}
function voidOne(k, v) {
    var coin = String(((v && v.mine) || [])[0] || '');
    if (voidingSvc[k]) return;
    function done(note) {
        AX.mds.kvGet('void_takes', '{}', function (vv) {
            var all = {}; try { all = JSON.parse(vv || '{}') || {}; } catch (e) { all = {}; }
            delete all[k]; delete voidingSvc[k];
            AX.mds.kvSet('void_takes', JSON.stringify(all), function () { });
            if (note) log('void ' + k + ': ' + note);
        });
    }
    if (!/^0x[0-9A-Fa-f]{64}$/.test(coin)) return done('');
    voidingSvc[k] = true;
    AX.mds.cmdR('coins relevant:true coinid:' + coin, function (e0, onChain) {
        if (e0) { delete voidingSvc[k]; return; }
        if (!(Object.prototype.toString.call(onChain) === '[object Array]' && onChain.length)) return done('settled: coin ' + coin + ' is spent on chain, so the maker can no longer post my signed half');
        AX.mds.cmdR('coins relevant:true checkmempool:true coinid:' + coin, function (e, rows) {
            var c = !e && Object.prototype.toString.call(rows) === '[object Array]' ? rows[0] : null;
            if (e || !c) { delete voidingSvc[k]; return; }   // spent in the mempool only: look again later
            AX.mds.cmdR('getaddress', function (e2, ad) {
                if (e2 || !ad || !ad.address) { delete voidingSvc[k]; return; }
                AX.maker.relock(AX.mds, [c], ad.address, function (e3) {
                    delete voidingSvc[k];
                    // keep the record until the spend is ON CHAIN (a posted relock can still be dropped); the next sweep
                    // then finds the coin spent and closes it
                    if (!e3) log('void ' + k + ': relock of ' + coin + ' posted; settles when it is on chain');
                });
            });
        });
    });
}

/** Auto-cross: after each ladder pass, trade PandaPools back to my rungs when it has moved past them (lib/autocross.js). */
function crossPass(then) {
    try { AX.autocross.run({ mds: AX.mds, price: PandaPrice, svc: PDService, log: log, changed: function () { notify({ type: 'ladder' }); } }, then); }
    catch (e) { log('auto-cross: ' + e); then(); }
}

/** A posted cross spent rung coins: re-back those rungs now, not after the 15 s pass gap (Android MakerService.afterCross). */
function afterCross(next) {
    if (!AX.autocross._state.crossed) return next();
    AX.ladder._state.lastPass = 0; ladderPass(next);
}

/** Settlement tracker: a fill is done once one of its output coins exists on chain (`coins coinid:`). The txpowid
 *  from txnpost is the pre-mining id and never matches the mined block, so it is display-only. */
function settleFills() {
    AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
        var rows = (r && r.rows) || [], i = 0;
        function step() {
            if (i >= rows.length) return;
            var row = rows[i++], f = null;
            try { f = JSON.parse(row.V || row.v); } catch (e) { return step(); }
            if (f && f.status === 'unknown') return settleUnknown(String(row.K || row.k), f, step);   // POST UNANSWERED (header)
            if (!f || f.status !== 'settling' || !f.txpowid) return step();
            var probe = (f.coins && f.coins.length) ? f.coins[0] : null;
            if (!probe || !/^0x[0-9A-Fa-f]{64}$/.test(String(probe))) return step();
            AX.mds.cmdR('coins coinid:' + probe, function (err, res) {
                var c = (!err && res) ? (Object.prototype.toString.call(res) === '[object Array]' ? res[0] : res) : null;
                if (c && c.coinid) {
                    f.status = 'done'; f.block = c.created;
                    AX.mds.kvSet('fill_' + f.txpowid, JSON.stringify(f), function () { notify({ type: 'fill', txpowid: f.txpowid, status: 'done' }); step(); });
                } else if (f.ts && nowS() - f.ts > 2 * 3600) {
                    f.status = 'lost';   // two hours without a block: the txn was dropped (double-spent coin, reorg); the UI shows it
                    AX.mds.kvSet('fill_' + f.txpowid, JSON.stringify(f), function () { step(); });
                } else step();
            });
        }
        step();
    });
}

/** POST UNANSWERED (header): a fill whose txnpost was never answered. next() exactly once. */
function settleUnknown(key, f, next) {
    var probe = (f.coins && f.coins.length) ? f.coins[0] : null, mine = (f.spent && f.spent.length) ? f.spent[0] : null;
    function lost(why) {
        f.status = 'lost'; f.reason = why;
        AX.mds.kvSet(key, JSON.stringify(f), function () {
            AX.maker.load(AX.mds, function (e, list) {   // the order was reduced as if the fill had happened: put the amount back
                var o = e ? null : AX.maker.find(list, f.orderId);
                if (!o || o.status !== 'live') return next();   // filled, cancelled or gone meanwhile: left as it is
                o.remaining = AX.fill.plain(AX.fill.d(o.remaining).plus(AX.fill.d(f.filled))); o.seq = Math.max(nowS(), Number(o.seq || 0) + 1);   // lib/maker.js nextSeq
                AX.maker.save(AX.mds, list, function (e3) { if (e3) { log('unanswered fill of ' + f.orderId + ' was never posted (' + why + '), but putting ' + f.filled + ' MINIMA back on the order failed: ' + e3.message); saveFailed('fill', e3); return next(); } log('unanswered fill of ' + f.orderId + ' was never posted (' + why + '): ' + f.filled + ' MINIMA is back on the order'); notify({ type: 'fill', status: 'lost' }); next(); });
            });
        });
    }
    if (!probe || !/^0x[0-9A-Fa-f]{64}$/.test(String(probe))) return next();
    AX.mds.cmdR('coins coinid:' + probe, function (err, res) {
        var c = (!err && res) ? (Object.prototype.toString.call(res) === '[object Array]' ? res[0] : res) : null;
        if (c && c.coinid) {
            f.status = 'done'; f.block = c.created;
            return AX.mds.kvSet(key, JSON.stringify(f), function () { log('unanswered fill of ' + f.orderId + ' IS on the chain (block ' + c.created + ')'); notify({ type: 'fill', status: 'done' }); next(); });
        }
        if (err) return next();   // the node did not say: nothing is concluded
        if (f.ts && nowS() - f.ts > 2 * 3600) return lost('not in a block after 2 hours');
        if (!mine || !f.ts || nowS() - f.ts < 600) return next();
        AX.mds.cmdR('coins coinid:' + mine + ' checkmempool:true', function (e2, rows) {
            if (!e2 && rows && rows.length) return lost('this node\'s coin in it is unspent and not in the mempool');
            next();
        });
    });
}

function processTakes(takes, done) {
    var i = 0;
    function step() {
        if (i >= takes.length) return done();
        handleTake(takes[i++], step);
    }
    retryFills(step);   // FILL PENDING (header): a fill not saved yet is applied first (one at a time with the takes: the tick's guard)
}

/* ---- FILL PENDING (header; DexiconPro 0.2.150 / 0.2.158 / 0.2.159) ---- */
var FILL_PENDING = {};   // orderId -> { orderId, txpowid, filled, spent, verified, coins, ts }
/** Applied already: the order lists its id, is no longer live, or the fill is older than what the order's fillsFrom counts. */
function fillApplied(list, p) { var o = AX.maker.find(list, p.orderId); return !o || o.status !== 'live' || (o.fills || []).indexOf(p.txpowid) >= 0 || (p.ts > 0 && o.fillsFrom > 0 && p.ts < o.fillsFrom); }
function fillDone(p) { if (FILL_PENDING[p.orderId] === p) { delete FILL_PENDING[p.orderId]; unlockCoins(p.coins); log('fill ' + p.txpowid + ' on ' + p.orderId + ' is applied: its order takes takes again'); } }
function retryFills(done) {
    var ids = Object.keys(FILL_PENDING); if (!ids.length) return done();
    AX.maker.load(AX.mds, function (e, list) {
        var i = 0;
        (function next() {
            if (i >= ids.length) return done();
            var p = FILL_PENDING[ids[i++]]; if (!p) return next();
            if (!e && fillApplied(list, p)) { fillDone(p); return next(); }
            AX.maker.afterFill(AX.mds, RELAY, ME, p.orderId, p.filled, p.spent, function (e2) { if (!e2) fillDone(p); else log('afterFill retry: ' + e2.message); next(); }, p.txpowid, p.verified);
        })();
    });
}
/** cb(remaining | null): o's stored remaining less every maker fill_ record of it not yet applied (the vendored
 *  reconcileFills on a copy), never above the stored one; null (refuse) when the records cannot be read. */
function trueRemaining(list, o, cb) {
    var copy = JSON.parse(JSON.stringify(list)), ok = true, m = Object.create(AX.mds);
    m.sql = function (q, k) { AX.mds.sql(q, function (r) { if (!r || !r.status) ok = false; k(r); }); };
    AX.maker.reconcileFills(m, copy, function () {
        var c = AX.maker.find(copy, o.orderId), F = AX.fill;
        if (!ok || !c) return cb(null);
        if (c.status !== 'live') return cb('0');
        try { cb(F.d(c.remaining).lt(F.d(o.remaining)) ? F.plain(F.d(c.remaining)) : String(o.remaining)); } catch (e) { cb(null); }
    });
}
/** POST UNANSWERED (header): the id an unanswered fill is applied under. Never a real txpowid (48 leading zeros). */
var unansweredSeq = 0;
function unansweredId() { return '0x' + ('000000000000000000000000000000000000000000000000' + ('000000000000' + Date.now().toString(16)).slice(-12) + ('0000' + ((++unansweredSeq) & 0xffff).toString(16)).slice(-4)); }

/** The market maker: one reconcile pass (15 s pacing inside), then the feed line for the page's editor. */
function ladderPass(then) {
    AX.ladder.pass({ mds: AX.mds, relay: RELAY, me: ME, price: PandaPrice, log: log, changed: function () { notify({ type: 'ladder' }); } }, function () {
        AX.mds.kvSet('mm_feed', JSON.stringify({ mid: PandaPrice.mid(), ageMs: PandaPrice.ageMs(), line: AX.ladder.feedLine(PandaPrice), at: Date.now() }), function () { then(); });
    });
}

function sealed(toPublicId, obj) { return AX.envelope.msg(ME, toPublicId, AX.identity.seal(ME, toPublicId, AX.hex.utf8(JSON.stringify(obj))), nowS() + 300); }
function reply(toPublicId, obj) {
    var raw = sealed(toPublicId, obj), urls, i = 0;
    if (!obj || obj.k !== 'refused') return RELAY.publish(raw, function () {});   // carries a result ("taken"): never low, never dropped
    // REFUSALS (header): relay after relay like RELAY.publish (lib/relay.js: a msg goes to /dex/msg), at low priority
    urls = RELAY.relays.slice();
    (function step() { if (i >= urls.length) return; MDS.net.POST(urls[i++] + '/dex/msg', raw, function () { step(); }, true); })();
}

function handleTake(take, next) {
    var taker = take._from;
    // a peer's txn goes into txnview/txnimport: hex only, bounded (security review 30 Oct)
    if (!taker || typeof take.txn !== 'string' || typeof take.orderId !== 'string' || !/^(0x)?[0-9A-Fa-f]+$/.test(take.txn) || take.txn.length < 2 || take.txn.length > 200002) return next();
    AX.maker.load(AX.mds, function (err, list) {
        var o = AX.maker.find(list, take.orderId);
        if (!o || o.status !== 'live') { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'order not live' }); return next(); }
        var pend = FILL_PENDING[o.orderId];
        if (pend && fillApplied(list, pend)) { fillDone(pend); pend = null; }
        if (pend) {   // FILL PENDING (header): never a take checked against a size a fill not saved yet has already sold
            log('take for ' + o.orderId + ' from ' + taker + ' refused: its fill ' + pend.txpowid + ' is not saved yet');
            notify({ type: 'take_refused', orderId: o.orderId, taker: taker, reason: 'a fill of this order is still being saved' });
            reply(taker, { k: 'refused', orderId: o.orderId, reason: 'busy: a fill of this order is still being saved; try again shortly' });
            return next();
        }
        if (!lockCoins(o.coins)) { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'taken' }); return next(); }
        trueRemaining(list, o, function (rem) {
        if (rem === null || !AX.fill.d(rem).gt(0)) {
            unlockCoins(o.coins);
            log('take for ' + o.orderId + ' from ' + taker + ' refused: ' + (rem === null ? 'its fill records could not be read' : 'its unapplied fills sold all of it'));
            if (rem === null) notify({ type: 'take_refused', orderId: o.orderId, taker: taker, reason: 'its fill records could not be read (the node database did not answer): nothing was co-signed; it is tried again with the next take' });
            reply(taker, { k: 'refused', orderId: o.orderId, reason: rem === null ? 'busy: try again shortly' : 'order not live' });
            return next();
        }
        // a fill record not applied yet makes the true remaining lower than the stored one: no take is checked while that
        // is so (it would be deducted twice: by afterFill from min(stored, checked), then by the refresh), busy, and the
        // refresh at the end of this tick applies the records (FILL PENDING, header)
        if (AX.fill.d(rem).lt(AX.fill.d(o.remaining))) {
            unlockCoins(o.coins); rebackDue = true;
            log('take for ' + o.orderId + ' from ' + taker + ' refused: a fill of it is recorded but not applied yet (' + rem + ' of the stored ' + o.remaining + ' is left); the refresh applies it');
            notify({ type: 'take_refused', orderId: o.orderId, taker: taker, reason: 'busy: an earlier fill of this order is still being applied' });
            reply(taker, { k: 'refused', orderId: o.orderId, reason: 'busy: an earlier fill of this order is still being applied; try again shortly' });
            return next();
        }
        log('take received for ' + o.orderId + ' from ' + taker + ' (' + take.txn.length / 2 + ' bytes)');
        var recvMs = Date.now();   // ACTIVITY: "Co-signed for <taker> in X.Xs" (take received → posted)
        var spentByMe = [], outs = [];
        /** afterFill's end, either way: applied → the coins are free; not saved → FILL PENDING (header), said */
        function applied(txid, filled, ts) {
            return function (e2) {
                if (!e2) unlockCoins(o.coins);
                else {
                    log('afterFill: ' + e2.message); saveFailed('fill', e2);
                    FILL_PENDING[o.orderId] = { orderId: o.orderId, txpowid: txid, filled: filled, spent: spentByMe, verified: rem, coins: o.coins.slice(), ts: ts };
                    for (var i = 0; i < o.coins.length; i++) coinLocks[o.coins[i]] = Infinity;
                }
            };
        }
        AX.fill.cosign(AX.mds, take.txn, AX.fill.signKeys(o.scripts), function (txn, wallet) {
            var v = AX.fill.verifyAsMaker(txn, { side: o.side, price: o.price, address: o.address }, o.coins, rem, addressList().concat(wallet));
            if (v.ok) for (var i = 0; i < txn.inputs.length; i++) if (o.coins.indexOf(txn.inputs[i].coinid) >= 0) spentByMe.push(txn.inputs[i].coinid);
            if (v.ok) for (var j = 0; j < txn.outputs.length; j++) if (txn.outputs[j] && txn.outputs[j].coinid) outs.push(txn.outputs[j].coinid);
            return v;
        }, function (e, txpowid, verdict, outCoins) {
            // POST UNANSWERED (header): signed, and the node never answered txnpost (main/dexicon.js UNANSWERED)
            if (e && verdict && verdict.ok && /the node did not answer txnpost/.test(String(e.message))) {
                var key = 'fill_unanswered_' + Date.now() + '_' + o.orderId, ux = unansweredId(), ts = nowS();
                log('take for ' + o.orderId + ': the node did not answer txnpost, so it is NOT KNOWN whether the fill was posted. Recorded as ' + key + '; the order is reduced by ' + verdict.filled + ' MINIMA until the chain says which');
                return AX.mds.kvSet(key, JSON.stringify({ role: 'maker', orderId: o.orderId, side: o.side, price: o.price, filled: verdict.filled, received: verdict.received, paid: verdict.paid, txpowid: '', applied: ux, coins: outs, spent: spentByMe, taker: taker, ts: ts, recvMs: recvMs, status: 'unknown', verified: rem }), function () {
                    AX.maker.afterFill(AX.mds, RELAY, ME, o.orderId, verdict.filled, spentByMe, function (e2) {
                        applied(ux, verdict.filled, ts)(e2);
                        notify({ type: 'fill', status: 'unknown' });
                        next();
                    }, ux, rem);
                });
            }
            if (e) {
                unlockCoins(o.coins);
                log('take for ' + o.orderId + ' refused: ' + e.message);
                reply(taker, { k: 'refused', orderId: o.orderId, reason: e.message.replace(/^refused: /, '') });
                return next();
            }
            log('FILLED ' + o.orderId + ' ' + verdict.filled + ' MINIMA → txpow ' + txpowid);
            var fts = nowS();
            AX.mds.kvSet('fill_' + txpowid, JSON.stringify({ role: 'maker', orderId: o.orderId, side: o.side, price: o.price, filled: verdict.filled, received: verdict.received, paid: verdict.paid, txpowid: txpowid, coins: outCoins, spent: spentByMe, taker: taker, ts: fts, recvMs: recvMs, cosignMs: Date.now() - recvMs, status: 'settling', verified: rem }), function () {});   // 0.0.145: verified = the remaining the take was checked against (reconcileFills)
            reply(taker, { k: 'taken', orderId: o.orderId, txpowid: txpowid, filled: verdict.filled, coins: outCoins });
            AX.maker.afterFill(AX.mds, RELAY, ME, o.orderId, verdict.filled, spentByMe, function (e2) {
                applied(txpowid, verdict.filled, fts)(e2);   // 0.0.133: never a silent success; refresh deducts it from fill_ (reconcileFills)
                notify({ type: 'fill', txpowid: txpowid });
                next();
            }, txpowid, rem);   // 0.0.139: the remaining the take was verified against
        });
        });
    });
}

/** ASSETS › CONSOLIDATE (mirror of Dexicon Android WalletTools): the node's standard `consolidate tokenid:` — run HERE
 *  under PandaSignLock so it never signs alongside a fill, split or post. */
function consolidate(data) {
    var tok = String(data.tokenid || '');
    if (!/^0x[0-9A-Fa-f]{2,64}$/.test(tok)) return PDService.tell('ERROR', { message: 'Invalid token id for consolidate' });
    PandaSignLock.gate('consolidate', function (release) {
        PDService.cmd('consolidate tokenid:' + tok, function (r) {
            release.free();
            if (!r || !r.status) return PDService.tell('ERROR', { message: 'Consolidate failed: ' + ((r && (r.error || r.message)) || 'no reply from the node') });
            var resp = r.response || {}, id = resp.txpowid || (resp.txpow && resp.txpow.txpowid) || '';
            log('consolidate ' + tok + ' → ' + id);
            PDService.tell('POSTED', { message: 'Consolidation submitted' + (id ? ' — txpow ' + id : '') + '. Final after the next block.', tx: id });
            if (PDService.ready) PDService.refresh();   // BOOT FIRST (header)
        });
    });
}

/** A LIMIT with nothing but my own orders inside its limit (no third-party order, no pool): say so and send nothing.
 *  Anything it cannot judge (keys unread, a bad amount) is left to PDService.action, which plans past my own orders. */
function onlyOwnOrders(data) {
    var why = '';
    try { if (PDService.ready && PDService.keysUsable()) why = AX.ownskip.onlyOwn(PDService.book, PDService.pools, !!data.buy, data.minima, data.price, PDService.block); } catch (e) { why = ''; }
    if (why) { PDService.setStage(why); PDService.tell('ERROR', { message: why }); }
    return !!why;
}

/** RETRY (header): the resting engine's boot, again while it is not ready, at most once a minute, and never while a
 *  boot is still running (0.18.110). PDService.boot has no callback, so its end is read from what it does: it ends
 *  READY, or it tells an ERROR and stops (the wrapper below). A boot that does neither for 5 minutes (a node command
 *  that never came back) is given up on, loudly, and the next one may start. */
var pdBootingSince = 0, PD_BOOT_STUCK_MS = 300000;
/** NOT READY BECAUSE (0.19.373): the last reason a boot of the on-chain engine ended without READY, in the engine's own
 *  words ("" = none known: it is still starting). The screens say it (DX.restingWhy, and restingWhy on the STATE packet
 *  the page reads) and refuse an on-chain action before any review. Before this an ERROR that ended a boot was seen by
 *  nobody: the native screen keeps only STATE, and this wrapper only reset its boot timer. */
var pdWhy = '';
function pdNotReady(why) {
    why = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!why || why === pdWhy) return;
    pdWhy = why;
    log('on-chain engine not ready: ' + why + ' (its start is tried again every minute; FAST trading is not affected)');
    try { PDService.snapshot(); } catch (e) { }   // the page hears the reason now, not at the next block
}
function pdBoot() {
    var now = Date.now();
    if (PDService.ready) { pdBootingSince = 0; return; }
    if (pdBootingSince > 0) {
        if (now - pdBootingSince < PD_BOOT_STUCK_MS) return;   // still running: a second one would run every step twice, side by side
        log('the on-chain engine\'s start has not finished after ' + (PD_BOOT_STUCK_MS / 60000) + ' minutes; starting it again');
        pdNotReady('its start did not finish within ' + (PD_BOOT_STUCK_MS / 60000) + ' minutes (a node command did not answer)');
    }
    if (lastPdBootMs > 0 && now - lastPdBootMs < 60000) return;
    lastPdBootMs = now; pdBootingSince = now; PDService.boot();
}
(function () {   // a boot that fails says so through PDService.tell('ERROR', …) and returns: that boot is over
    var tell = PDService.tell;
    PDService.tell = function (type, data) {
        if (type === 'ERROR' && !PDService.ready) { var booting = pdBootingSince > 0; pdBootingSince = 0; if (booting) pdNotReady(data && data.message); }
        if (type === 'STATE' && data && typeof data === 'object') data.restingWhy = PDService.ready ? '' : pdWhy;
        return tell.apply(PDService, arguments);
    };
})();

/** The FAST maker (this file) and the vendored PandaDEX RESTING engine (PDService) share one MDS.init. */
function pdEvent(msg) {
    try {
        if (!STORE_MINE) return;   // FOREIGN STORE (header): the resting engine reads its ladder and orders from the store too
        if (msg.event === 'inited' || msg.event === 'MDS_TIMER_10SECONDS') pdBoot();
        else if (msg.event === 'NEWBLOCK') { if (PDService.ready) PDService.cmd('block', function (result) { var tip = PandaSafety.tipBlock(result); if (tip > 0) { PDService.block = tip; PDService.refresh(); } }); }   // BOOT FIRST (header)
        else if (msg.event === 'MDSCOMMS' && msg.data && !msg.data.public) {
            var packet = JSON.parse(msg.data.message || '{}');
            if (packet.origin === 'ui' && packet.type === 'LIMIT' && onlyOwnOrders(packet.data || {})) return;
            if (packet.origin === 'ui') PDService.action(packet);
            else if (packet.origin === 'dexicon' && packet.type === 'CONSOLIDATE') consolidate(packet.data || {});
            // SAVE / STOP on the market maker: reconcile NOW, not on the next 10 s timer after the 8 s inbox hold
            else if (packet.origin === 'dexicon' && packet.type === 'LADDER' && READY) ladderPass(function () { });
            else if (packet.origin === 'dexicon' && packet.type === 'CROSS_REVIEW' && READY) crossReview(packet.data || {});
        }
    } catch (e) { log('resting engine: ' + (e && e.message ? e.message : e)); }
}
/** REVIEW / RELEASE from ORDERS › MARKET MAKER: the owner's only way out of a cross or PandaDEX fill whose outcome
 *  is unknown. Nothing here runs by itself. The answer goes to kv mm_review_result, tagged with the page's nonce. */
function crossReview(data) {
    var ctx = { mds: AX.mds, price: PandaPrice, svc: PDService, log: log, changed: function () { notify({ type: 'ladder' }); } };
    var nonce = /^[0-9a-z.]{1,40}$/.test(String(data.nonce || '')) ? String(data.nonce) : '';
    function done(o) { o.nonce = nonce; AX.mds.kvSet('mm_review_result', JSON.stringify(o), function () { notify({ type: 'ladder' }); }); }
    try {
        if (data.release === 'cross' || data.release === 'fill') AX.autocross.release(ctx, data.release, function (err) { done({ released: data.release, error: err || '' }); });
        else AX.autocross.review(ctx, function (st) { done({ review: st }); });
    } catch (e) { done({ error: 'review failed: ' + (e && e.message ? e.message : e) }); }
}

/* ---- READ MODEL (header). From DexiconPro's service.desktop.js: pollBook, mergedBook, chainMine. ---- */

/** The relay book (FAST orders), one relay per 10 s timer, round-robin, never blocking a tick (hold 0). */
var BOOK_POLLING = false;
function pollBook() {
    if (!READY || BOOK_POLLING || !RELAY.relays.length) return;
    BOOK_POLLING = true;
    RELAY.pollBook(0, function (err, changed, url) { BOOK_POLLING = false; if (err) logOnce('book poll ' + url + ' failed: ' + err.message); });
}

/** FAST + BOOK + POOL as the page shows them (ui/app.js levels, ui/pd_app.js renderBookRows/poolDepth): backed FAST
 *  orders only, fillable unexpired on-chain orders only, pool depth sampled by PandaSynthetic. Plain strings, never
 *  rounded. `ours` marks this node's own orders, `mine` on a pool marks a pool one of this node's keys owns. */
var poolDepthCache = { key: '', asks: [], bids: [] };
function mergedBook() {
    var mySign = ME ? ('0x' + AX.hex.to(ME.signPk)).toLowerCase() : '', out = { fast: [], book: [], poolAsks: [], poolBids: [] }, i, o, key;
    var fast = RELAY ? RELAY.orders() : [];
    for (i = 0; i < fast.length; i++) {
        o = fast[i];
        if (!o || !(o.coins || []).length) continue;   // unbacked: nobody can take it, so not on the book
        out.fast.push({ side: o.side === 'sell' ? 'sell' : 'buy', price: String(o.price), minima: String(o.amount), ours: String(o.signPk || '').toLowerCase() === mySign });
    }
    for (i = 0; i < PDService.book.length; i++) {
        o = PDService.book[i];
        if (!o || o.fillable === false || Math.max(0, Number(PDService.block || 0) - Number(o.created || 0)) > PandaDEX.EXPIRY) continue;
        out.book.push({ side: o.sell ? 'sell' : 'buy', price: PandaDEX.plain(o.price), minima: PandaDEX.plain(o.minima), ours: !!PDService.owns(o) });
    }
    key = String(PDService.block) + '|' + PDService.pools.map(function (p) { return p.address + ':' + p.reserveM + ':' + p.reserveT; }).join('|');
    if (key !== poolDepthCache.key) {
        poolDepthCache.key = key;
        try {
            var lv = function (r) { return { price: PandaDEX.plain(r.price), minima: PandaDEX.plain(r.poolMinima) }; };
            poolDepthCache.asks = PandaSynthetic.sample(PDService.pools, true, '0.00001', 80).map(lv);
            poolDepthCache.bids = PandaSynthetic.sample(PDService.pools, false, '0.00001', 80).map(lv);
        } catch (e) { poolDepthCache.asks = []; poolDepthCache.bids = []; log('pool depth: ' + (e && e.message ? e.message : e)); }
    }
    out.poolAsks = poolDepthCache.asks; out.poolBids = poolDepthCache.bids;
    out.pools = PDService.pools.map(function (p) { return { address: String(p.address), minima: String(p.reserveM), mxusd: String(p.reserveT), mine: ownKey(p.opk) }; });
    return JSON.stringify(out);
}

/** Is this public key one of the node's own (PDService.keyset, from `keys action:list`)? Case-insensitive. */
function ownKey(pk) {
    var want = String(pk || '').toLowerCase(), k;
    if (!want) return false;
    for (k in PDService.keyset) if (PDService.keyset.hasOwnProperty(k) && String(k).toLowerCase() === want) return true;
    return false;
}

/** Our own ON-CHAIN orders and what is still waiting for a block, for the page's My orders. */
function chainMine() {
    var out = { orders: [], pending: [] }, i, o, r;
    for (i = 0; i < PDService.book.length; i++) {
        o = PDService.book[i];
        if (PDService.owns(o)) out.orders.push({ coinid: o.coinid, orderId: o.orderId, sell: !!o.sell, price: PandaDEX.plain(o.price), minima: PandaDEX.plain(o.minima), pending: String(PDService.pendingRefs[o.coinid] || '') });
    }
    for (i = 0; i < (PDService.pendingRows || []).length; i++) {
        r = PDService.pendingRows[i] || {};
        if (r.kind === PandaPending.PLACE) out.pending.push({ orderId: String(r.orderId || ''), sell: !r.buy, price: String(r.price || ''), minima: String(r.minima || '') });
    }
    return JSON.stringify(out);
}

var DX = {
    ready: function () { return READY; },
    restingReady: function () { return !!PDService.ready; },
    restingWhy: function () { return PDService.ready ? '' : pdWhy; },
    publicId: function () { return ME ? ME.publicId() : null; },
    ticking: function () { return TICKING; },
    relays: function () { return RELAY ? RELAY.relays.slice() : []; },
    block: function () { return Number(PDService.block || 0); },
    mine: chainMine,
    book: mergedBook
};

MDS.init(function (msg) {
    pdEvent(msg);
    if (msg.event === 'inited') { tryBoot(); }
    else if (msg.event === 'MDS_TIMER_10SECONDS') { if (!READY) tryBoot(); else { pollBook(); tick(function () {}); } }
    else if (msg.event === 'NEWBLOCK' && READY) rebackOnBlock();   // 0.0.102 (NEWBLOCK RE-BACK, header)
});
