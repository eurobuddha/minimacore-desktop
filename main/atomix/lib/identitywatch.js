/**
 * identitywatch — does this dapp's key material still belong to the node it is running inside?
 *
 * Mirrors native atomix 0.1.19. Two failure shapes, both of which cost real money on the native side:
 *
 *   1. ORPHANED (native): a persisted identity outlives a node reseed, so counterparties lock coins to a key
 *      the node cannot sign for. Native lost 7.86 USDT that way.
 *   2. ROTATED (this dapp's own defect, logged in PARITY.md): htlc.setup() took its identity from `getaddress`,
 *      which is core Wallet.getDefaultAddress() → new Random().nextInt(numkeys) — a RANDOM default key per
 *      call — and persisted nothing. So the published receiver key changed on EVERY service restart / page
 *      reload, and settle.js's claim discovery (isMyPublishKey on state[4]) stopped recognising a counter-leg
 *      locked to the previous boot's key: swap sticks in CLAIMING, counterparty refunds at timeout and keeps
 *      the side we already paid.
 *
 * Fix for both: PERSIST the identity (ax_kv), then keep VERIFYING that the node still owns it, and verify the
 * ETH wallet (seedrandom modifier:ethbridge) still matches too — the ETH key is re-derived per boot but the MDS
 * service lives as long as the node, so a reseed mid-life leaves it stale exactly as it did on Android.
 *
 * Deliberately NO self-heal (user decision): silently re-picking hides that funds sit on a key the node can no
 * longer derive. We HALT new liabilities and tell the user to rescue + reinstall the MiniDapp.
 *
 * "Cannot verify" is never "mismatch": an empty key list or a failed seedrandom leaves the verdict untouched, so
 * a busy/READ-only node can never halt a healthy install.
 */
(function (glob) {
    'use strict';
    var AX = glob.AX = glob.AX || {};
    var H = AX.htlc, M = AX.mds, E = AX.eth, EO = AX.ethops;

    var CHECK_INTERVAL_MS = 5 * 60 * 1000;

    var state = {
        minimaMismatch: false, ethMismatch: false,
        orphanedPk: '', staleEth: '', nodeEth: '',
        lastCheckMs: 0, inFlight: false, alarmRaised: false
    };

    function halted() { return state.minimaMismatch || state.ethMismatch; }
    function verdict() { return state; }
    function forceNext() { state.lastCheckMs = 0; }

    /** Human summary for the UI banner / log. */
    function summary() {
        if (!halted()) return '';
        if (state.minimaMismatch && state.ethMismatch)
            return 'Your Minima key AND your ETH wallet no longer match this node.';
        return state.minimaMismatch
            ? 'This node does not own the Minima key AtomiX publishes.'
            : 'Your ETH wallet no longer matches what this node derives.';
    }

    /**
     * check(ctx, cb) — ctx is the boot context ({htlc:{publickey}, eth:{address}}). Throttled; safe to call
     * from every poll. cb() always fires so it can sit inline in the poll chain.
     */
    function check(ctx, cb) {
        cb = cb || function () {};
        if (!ctx || !ctx.htlc || state.inFlight) return cb();
        var now = Date.now();
        if (now - state.lastCheckMs < CHECK_INTERVAL_MS) return cb();
        state.lastCheckMs = now;
        state.inFlight = true;
        checkMinima(ctx, function () {
            checkEth(ctx, function () { state.inFlight = false; raiseOrClear(); cb(); });
        });
    }

    /** A key list that can PROVE "not owned": every key the node says it has (keys.total) came back, well-formed.
     *  A list without .complete (an older loader) counts as complete only when non-empty — the previous rule. */
    function complete(keys) { return !!(keys && keys.length && (keys.complete === undefined ? true : keys.complete)); }

    function checkMinima(ctx, next) {
        var mine = ctx.htlc.publickey;
        if (!mine) return next();
        var want = H.normKey(mine);
        H.loadKeys(function (err, keys) {
            if (err || !complete(keys)) return next();                // cannot verify — never halt on this
            if (keys.indexOf(want) >= 0) { state.minimaMismatch = false; state.orphanedPk = ''; return next(); }
            // "not owned" from ONE read is not enough to halt: read again at once, and halt only if a second
            // complete list also lacks the key (an incomplete or failed second read leaves the verdict untouched)
            H.loadKeys(function (err2, keys2) {
                if (err2 || !complete(keys2)) return next();
                var owned = keys2.indexOf(want) >= 0;
                state.minimaMismatch = !owned;
                state.orphanedPk = owned ? '' : mine;
                state.keysRead = keys2.length; state.keysTotal = keys2.total === undefined ? null : keys2.total;
                next();
            });
        });
    }

    function checkEth(ctx, next) {
        var have = ctx.eth && ctx.eth.address;
        if (!have) return next();
        // Same derivation as boot (seedrandom modifier:ethbridge), but the key is turned into an address and
        // dropped — never assigned back into ctx, so nothing can swap a funded wallet out mid-swap.
        function derive(cb2) {
            M.cmdR('seedrandom modifier:ethbridge', function (err, r) {
                if (err || !r || !r.seedrandom) return cb2(null);         // node busy / READ-only — cannot verify
                try { var p = String(r.seedrandom); cb2(String(E.addressFromPriv(p.indexOf('0x') === 0 ? p : '0x' + p))); }
                catch (e) { cb2(null); }
            });
        }
        var same = function (a) { return String(a).toLowerCase() === String(have).toLowerCase(); };
        derive(function (addr) {
            if (!addr) return next();
            if (same(addr)) { state.ethMismatch = false; state.staleEth = ''; state.nodeEth = ''; return next(); }
            // one differing derivation is not enough: derive again, halt only if it gives the SAME other address
            derive(function (addr2) {
                if (!addr2 || String(addr2).toLowerCase() !== String(addr).toLowerCase()) return next();
                state.ethMismatch = true; state.staleEth = have; state.nodeEth = addr2;
                next();
            });
        });
    }

    function raiseOrClear() {
        if (!halted()) { state.alarmRaised = false; return; }
        if (state.alarmRaised) return;
        state.alarmRaised = true;
        // every value in FULL (owner rule: a shortened key or address cannot be checked or pasted)
        var msg = 'IDENTITY MISMATCH — halting new trades. ' + summary() +
            (state.minimaMismatch ? ' Published Minima key ' + state.orphanedPk + ' is not in the node\'s key list (' +
                state.keysRead + ' read, node total ' + (state.keysTotal === null ? 'not reported' : state.keysTotal) + ', confirmed by two reads).' : '') +
            (state.ethMismatch ? ' ETH wallet in use ' + state.staleEth + ', node derives ' + state.nodeEth + ' (confirmed by two derivations).' : '');
        if (glob.MDS && MDS.log) MDS.log('[AtomiX] ' + msg);
        if (glob.MDS && MDS.notify) MDS.notify('AtomiX halted — wallet mismatch. Rescue funds and reinstall.');
    }

    // ---- test seams ----
    function _reset() {
        state.minimaMismatch = false; state.ethMismatch = false;
        state.orphanedPk = ''; state.staleEth = ''; state.nodeEth = '';
        state.lastCheckMs = 0; state.inFlight = false; state.alarmRaised = false;
        state.keysRead = 0; state.keysTotal = null;
    }
    function _setMismatch(minima, eth) { state.minimaMismatch = !!minima; state.ethMismatch = !!eth; }

    AX.identitywatch = {
        check: check, halted: halted, verdict: verdict, forceNext: forceNext, summary: summary,
        _reset: _reset, _setMismatch: _setMismatch
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
