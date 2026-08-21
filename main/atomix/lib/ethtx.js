/**
 * ethtx — signs + broadcasts a legacy (EIP-155) Ethereum tx via ethrpc, a faithful port of native EthTx.java.
 *
 * Per-address nonce serializer (F1): a market sweep fires several ETH locks back-to-back and the poll loop can
 * issue a claim/withdraw concurrently; the RPC "pending" count lags a just-broadcast tx, so two sends would read
 * the SAME nonce and one is silently dropped. Native holds a per-address lock across read→sign→broadcast→commit;
 * here — callbacks, no threads — we get the same atomicity with a per-address JOB QUEUE (one send in flight per
 * address). We hand out strictly-increasing nonces and SELF-HEAL a dropped own-tx by falling back to "pending"
 * once it has sat stuck-behind us for STALE_MS. A false heal is fund-safe: it's an RBF of an in-flight nonce — if
 * the original is fine it wins and the heal-send is rejected ("nonce too low"), so send() errors and nothing is
 * committed. F5: floor the gasPrice at base fee +12.5% + a 0.2 gwei tip so a stale value can't sit below a risen base fee and hang (0.1.40: was 2× base — over-reserved ~4× and starved new wallets).
 * Cross-instance (UI vs service) handoff still relies on a fresh "pending" at cold start.
 * Requires AX.ethrpc, AX.eth (signLegacyTx), AX.flow. Attaches to AX.ethtx.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    var FALLBACK_GAS_PRICE = 1000000000n;   // 1 gwei (only used when eth_gasPrice returns ≤0)
    var PRIORITY_TIP_WEI = 200000000n;      // 0.2 gwei tip on the base-fee floor
    var STALE_MS = 120000;

    // address → { st:{next,syncAtMs}, q:[jobs], busy:bool }. next=-1 means cold (read "pending").
    var ADDR = {};
    var _now = function () { return Date.now(); };   // seam for tests

    // Cross-instance broadcast lock (wired at boot via useLock). Unwired → no lock (per-instance queue + F1 only).
    var _acquire = null, _release = null;
    function useLock(acquireFn, releaseFn) { _acquire = acquireFn; _release = releaseFn; }
    function acquire(cb) { if (_acquire) _acquire(cb); else cb(true); }
    function release(cb) { if (_release) _release(cb); else cb(); }
    function busyErr() { var e = new Error('ETH_BUSY: another instance is broadcasting — retry'); e.busy = true; return e; }

    function slot(address) {
        return ADDR[address] || (ADDR[address] = { st: { next: -1, syncAtMs: 0 }, q: [], busy: false });
    }
    /** Forget all cached nonce state — call on a chain/endpoint switch so we cold-start from the new node. */
    function resetAll() { ADDR = {}; }

    /**
     * send(rpc, privHex, address, chainId, to, data, value, gasLimit, cb(err, txHash)). value/gasLimit are
     * BigInt (value may be null → 0). Serialised per address: concurrent calls queue and run one at a time.
     */
    function send(rpc, privHex, address, chainId, to, data, value, gasLimit, cb) {
        var s = slot(address);
        s.q.push({ rpc: rpc, privHex: privHex, address: address, chainId: chainId, to: to, data: data,
            value: value == null ? 0n : value, gasLimit: gasLimit, cb: AX.flow.once(cb) });
        pump(s);
    }

    function pump(s) {
        if (s.busy) return;
        var job = s.q.shift();
        if (!job) return;
        s.busy = true;
        // once(): a double-fired RPC callback inside doSend must NOT release the queue twice (which would let two
        // jobs run concurrently and read the same nonce) — the exact collision the serializer exists to prevent.
        doSend(s.st, job, AX.flow.once(function (err, hash) {
            s.busy = false;
            job.cb(err, hash);
            pump(s);                 // drain the next queued send for this address
        }));
    }

    function doSend(st, job, done) {
        var rpc = job.rpc;
        rpc.getTransactionCount(job.address, function (e1, pendingBig) {
            if (e1) return done(e1);
            var pending = Number(pendingBig), now = _now();
            var alloc, newNext, newSync;
            if (st.next < 0 || pending >= st.next) {          // cold | in-sync | external tx advanced us
                alloc = pending; newNext = pending + 1; newSync = now;
            } else if (now - st.syncAtMs >= STALE_MS) {       // stuck behind too long → our tx dropped → HEAL
                alloc = pending; newNext = pending + 1; newSync = now;
            } else {                                          // pending just lagging our broadcast → keep counting
                alloc = st.next; newNext = st.next + 1; newSync = st.syncAtMs;
            }
            rpc.gasPrice(function (e2, gp) {
                if (e2) return done(e2);
                if (gp <= 0n) gp = FALLBACK_GAS_PRICE;
                gp = (gp * 9n) / 8n;                          // +12.5% headroom (was +20%)
                rpc.baseFeePerGasOrZero(function (_e3, baseFee) {
                    // 0.1.40: floor at base+12.5%+tip (was 2×base). The old 2× floor with a fixed 500k gas limit
                    // forced a near-empty node-derived wallet to pre-hold ~0.0005 ETH for a ~0.00005 ETH op, so
                    // new users' swaps silently mutual-refunded.
                    if (baseFee > 0n) { var floor = (baseFee * 9n) / 8n + PRIORITY_TIP_WEI; if (gp < floor) gp = floor; }
                    var raw;
                    try {
                        raw = AX.eth.signLegacyTx(
                            { nonce: alloc, gasPriceWei: gp, gasLimit: job.gasLimit, to: job.to, value: job.value, data: job.data },
                            job.privHex, job.chainId);
                    } catch (e) { return done(e); }
                    // Cross-instance lock (if wired): serialise the actual broadcast with the OTHER instance so the
                    // UI + service never clash a nonce on the shared wallet. On contention → a BUSY error (the caller
                    // retries next cycle, no worse than F1). The lock is released regardless of the broadcast outcome.
                    acquire(function (won) {
                        if (!won) return done(busyErr());
                        rpc.sendRawTransaction(raw, function (e4, txHash) {
                            release(function () {
                                if (e4) return done(e4);
                                if (!txHash || String(txHash).indexOf('0x') !== 0) return done(new Error('send failed: ' + txHash));
                                st.next = newNext; st.syncAtMs = newSync;    // commit ONLY after a successful broadcast
                                done(null, txHash);
                            });
                        });
                    });
                });
            });
        });
    }

    AX.ethtx = { send: send, resetAll: resetAll, useLock: useLock, _setNow: function (fn) { _now = fn; }, STALE_MS: STALE_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
