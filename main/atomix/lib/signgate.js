/**
 * signgate — SERIAL SIGNING. Only one signing command from this context is ever in flight.
 *
 * Minima signatures are STATEFUL: each key is a Winternitz tree and every signature must consume the NEXT
 * leaf. The node picks it by reading, incrementing and writing a per-key `uses` counter. Two commands
 * signing the same key at once both read the same value and both sign the SAME leaf over DIFFERENT data —
 * a reused one-time signature, which leaks that leaf's private key. Not theoretical: 7 of 64 default keys
 * on a live node were confirmed re-used, witness-exact.
 *
 * AtomiX is unusually exposed. The settlement loop retries claims on a timer with no persistent dedup, and
 * the swap identity is deliberately PINNED to one key (so the maker's published key stays constant), which
 * concentrates every claim, refund and change output onto that single key.
 *
 * WHERE THE GATE SITS. Every signing command in this app reaches the node through `M.cmdR` (mdsw.js), so
 * the gate lives there and keys off the command verb. Deliberately NOT also wrapping htlc.js's runSeq:
 * runSeq issues its commands *through* cmdR, so gating both would have the sequence hold the gate and then
 * wait on itself for its own txnsign — a deadlock. One level only.
 *
 * Serialising the individual signing commands is sufficient: the bug is two signatures being issued
 * concurrently, not two sequences overlapping. Sequences carry distinct transaction ids, so interleaving
 * their non-signing steps is harmless.
 *
 * SCOPE, HONESTLY. The MDS page and service.js are SEPARATE JS contexts, so this queue is per-context. It
 * stops the page racing itself and the service racing itself, but not the page racing the service — no
 * JS-level mechanism spans them (the only shared state is SQL). What actually closes that case is the
 * node-side Wallet.signData synchronisation, shipped in minimaCore 1.6.7.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    var QUEUE = [];
    var busy = false;
    var busySince = 0;

    /** Longer than any node write timeout, so a hold is only ever treated as dead for a genuinely lost
     *  callback — never for an operation that is merely slow. Proof-of-work is not quick. */
    var MAX_HOLD_MS = 200000;

    // NO TIMERS. setTimeout does not exist in the Rhino MDS service context — it appears only in
    // lib/app.js, which is the browser page. This file loads in BOTH contexts, so a timer-based watchdog
    // would throw the moment the service tried to sign. The stale-hold check below is lazy instead: it
    // runs when the next operation is submitted, which is the only moment anything cares.

    /** Commands that make the node sign, i.e. consume a one-time key leaf. `send` signs internally exactly
     *  as `txnsign` does, and is this app's highest-frequency signer (one per order publish, OTC publish
     *  and tombstone), so leaving it out would defeat the gate entirely. */
    var SIGNING = ['send', 'txnsign', 'sign', 'consolidate', 'tokencreate'];

    function signs(command) {
        if (!command) return false;
        var c = String(command).trim().toLowerCase();
        for (var i = 0; i < SIGNING.length; i++) if (c.indexOf(SIGNING[i]) === 0) return true;
        return false;
    }

    /** Queue an operation. It receives a `release` it MUST call exactly once, however it ends. */
    function submit(op) {
        QUEUE.push(op);
        // A hold older than the ceiling means its callback was lost; take the gate back rather than
        // wedging every future signature behind a dead operation.
        if (busy && busySince && (Date.now() - busySince) > MAX_HOLD_MS) busy = false;
        if (!busy) next();
    }

    function next() {
        var op = QUEUE.shift();
        if (!op) { busy = false; busySince = 0; return; }
        busy = true;
        busySince = Date.now();
        var freed = false;
        // idempotent: a sequence with several exit paths can safely release from all of them
        var release = function () {
            if (freed) return;
            freed = true;
            next();
        };
        op(release);
    }

    AX.signgate = { submit: submit, signs: signs, _pending: function () { return QUEUE.length; } };
})(this);
