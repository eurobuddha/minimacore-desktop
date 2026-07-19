/**
 * boot — the shared init sequence used by BOTH index.html (browser) and service.js (Rhino). Wires the PRNG,
 * inits the kv table, loads the persisted currency, reads the node seed once, derives the per-currency comms
 * identities + the ETH address, and registers the HTLC covenant. Callback-based (Rhino-safe). Attaches to AX.boot.
 *
 * On success cb(null, ctx) where ctx = { identities:{minima,mxusdt}, eth:{privKey,address}, htlc:{...} }.
 * The seed is used only at derive time and never stored on ctx; the ETH privkey stays in memory only (never
 * persisted or logged), exactly like native.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, ID = AX.identity, TR = AX.trading, HT = AX.htlc, F = AX.flow, E = AX.eth, P = AX.prng, H = AX.hex;

    /** WRITE-permission failure — MiniDapps install with READ trust by default ('mds' help), and every write
     *  command (vault/seedrandom/newscript/send/txn*) then returns pending:true instead of a response. AtomiX
     *  cannot run read-only: its identity is seed-derived and the settlement engine must sign claims/refunds
     *  HEADLESSLY against timelocks (a per-write pending-approval would strand time-critical claims). */
    function permErr() { var e = new Error('AtomiX needs WRITE permission on this node'); e.permission = true; return e; }
    function lockedErr() { var e = new Error('the node is password-locked — unlock it (vault action:passwordunlock), then retry'); e.locked = true; return e; }

    function init(cb) {
        var ctx = { identities: {}, eth: {}, htlc: null };
        F.waterfall([
            // TRUST PREFLIGHT: `checkmode` (a read command made for exactly this) reports this MiniDapp's own
            // READ/WRITE mode + whether the vault is password-locked — fail fast with a SPECIFIC error the UI
            // can turn into instructions, instead of dying later on a silently-pending vault read.
            function (next) {
                M.cmd('checkmode', function (r) {
                    try {
                        var resp = r && r.response;
                        if (resp && resp.writemode === false) return next(permErr());
                        if (resp && resp.dblocked === true) return next(lockedErr());
                    } catch (e) { }
                    next();   // checkmode unavailable / odd shape → the per-step pending belt below still catches it
                });
            },
            function (next) { P.init(function (err) { next(err); }); },
            function (next) { M.kvInit(function (err) { next(err); }); },
            function (next) { AX.swapdb.init(function (err) { next(err); }); },   // durable swap tables (both hosts)
            // cross-instance ETH broadcast lock: init the row + a per-instance token, then wire ethtx to use it so
            // the UI + service serialise their sends on the shared wallet (a clash is fund-safe via F1; this trims it).
            function (next) { M.ethLockInit(function () { if (AX.ethtx && AX.ethtx.useLock) AX.ethtx.useLock(M.ethLockAcquire, M.ethLockRelease); next(); }); },
            function (next) { M.kvGet('trading_currency', 'mxusdt', function (v) { TR.loadKey(v); next(); }); },
            // node seed (WRITE command — needs write permission). try/catch: an exception thrown inside an async
            // MDS callback is otherwise uncaught → the boot silently hangs (this is how R1 manifested on-device).
            function (next) {
                M.cmdR('vault action:seed', function (err, r, full) {
                    try {
                        if (err) return next(err);
                        if (full && full.pending === true) return next(permErr());   // belt: READ trust queued the command
                        var seed = (r && (r.seed || r.phrase));
                        if (!seed) return next(lockedErr());
                        ctx.identities.minima = ID.fromSeed(seed, TR.MINIMA.hkdfContext);
                        ctx.identities.mxusdt = ID.fromSeed(seed, TR.MXUSDT.hkdfContext);
                        next();   // seed used only here — never stored on ctx (reduces exposure surface)
                    } catch (e) { next(e); }
                });
            },
            // ETH bridge key (WRITE command) → address
            function (next) {
                M.cmdR('seedrandom modifier:ethbridge', function (err, r, full) {
                    try {
                        if (err) return next(err);
                        if (full && full.pending === true) return next(permErr());   // belt: READ trust queued the command
                        var sr = (r && r.seedrandom);   // node returns exactly `seedrandom`; no wrong-field fallback
                        if (!sr) return next(new Error('no seedrandom for ethbridge (node pending/locked?)'));
                        ctx.eth.privKey = sr.indexOf('0x') === 0 ? sr : '0x' + sr;
                        ctx.eth.address = E.addressFromPriv(ctx.eth.privKey);
                        next();
                    } catch (e) { next(e); }
                });
            },
            // register the HTLC covenant + pick the swap identity key
            function (next) { HT.setup(function (err, info) { if (err) return next(err); ctx.htlc = info; next(); }); }
        ], function (err) {
            cb(err || null, err ? null : ctx);
        });
    }

    /** The active currency's comms identity for the current selection. */
    function activeIdentity(ctx) { return ctx.identities[TR.active().key]; }

    AX.boot = { init: init, activeIdentity: activeIdentity };
})(typeof globalThis !== 'undefined' ? globalThis : this);
