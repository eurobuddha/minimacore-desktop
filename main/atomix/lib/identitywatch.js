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

    function checkMinima(ctx, next) {
        var mine = ctx.htlc.publickey;
        if (!mine) return next();
        H.loadKeys(function (err, keys) {
            if (err || !keys || !keys.length) return next();          // cannot verify — never halt on this
            var owned = keys.indexOf(H.normKey(mine)) >= 0;
            state.minimaMismatch = !owned;
            state.orphanedPk = owned ? '' : mine;
            next();
        });
    }

    function checkEth(ctx, next) {
        var have = ctx.eth && ctx.eth.address;
        if (!have) return next();
        // Same derivation as boot (seedrandom modifier:ethbridge), but the key is turned into an address and
        // dropped — never assigned back into ctx, so nothing can swap a funded wallet out mid-swap.
        M.cmdR('seedrandom modifier:ethbridge', function (err, r) {
            if (err || !r || !r.seedrandom) return next();            // node busy / READ-only — cannot verify
            var addr;
            try {
                var p = String(r.seedrandom);
                addr = E.addressFromPriv(p.indexOf('0x') === 0 ? p : '0x' + p);
            } catch (e) { return next(); }
            var same = String(addr).toLowerCase() === String(have).toLowerCase();
            state.ethMismatch = !same;
            state.staleEth = same ? '' : have;
            state.nodeEth = same ? '' : addr;
            next();
        });
    }

    function raiseOrClear() {
        if (!halted()) { state.alarmRaised = false; return; }
        if (state.alarmRaised) return;
        state.alarmRaised = true;
        var msg = 'IDENTITY MISMATCH — halting new trades. ' + summary();
        if (glob.MDS && MDS.log) MDS.log('[AtomiX] ' + msg);
        if (glob.MDS && MDS.notify) MDS.notify('AtomiX halted — wallet mismatch. Rescue funds and reinstall.');
    }

    // ---- test seams ----
    function _reset() {
        state.minimaMismatch = false; state.ethMismatch = false;
        state.orphanedPk = ''; state.staleEth = ''; state.nodeEth = '';
        state.lastCheckMs = 0; state.inFlight = false; state.alarmRaised = false;
    }
    function _setMismatch(minima, eth) { state.minimaMismatch = !!minima; state.ethMismatch = !!eth; }

    AX.identitywatch = {
        check: check, halted: halted, verdict: verdict, forceNext: forceNext, summary: summary,
        _reset: _reset, _setMismatch: _setMismatch
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
