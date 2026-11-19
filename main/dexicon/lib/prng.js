/**
 * prng — entropy bootstrap for seal()'s ephemeral keypair. Rhino/MDS has no crypto.getRandomValues, so on the
 * service side we seed a fast local CSPRNG (ChaCha-ish via repeated SHA-512 of a counter||seed) from node entropy
 * fetched once via MDS.cmd("random"). The browser wires crypto.getRandomValues directly. Attaches to AX.prng.
 * Requires AX.sodium (setPRNG + sha256/512 via the vendored globals) + AX.hex + AX.mds.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var H = AX.hex, S = AX.sodium, M = AX.mds;
    var sha512 = g.AXSHA512.sha512;

    /** Browser: use the platform CSPRNG directly. initBrowser(cb(err)). */
    function initBrowser(cb) {
        S.setPRNG(function (x, n) { g.crypto.getRandomValues(x.subarray ? x.subarray(0, n) : x); });
        cb && cb(null);
    }

    /**
     * Service.js (Rhino): fetch 64 bytes of node entropy, mix with a monotonically-incrementing counter through
     * SHA-512 to produce an unbounded keystream. Not for long-term keys (those come from the seed) — only for the
     * ephemeral sealed-box keypair, where forward-unpredictability from a strong seed is sufficient. initService(cb(err)).
     */
    function initService(cb) {
        M.cmdR('random size:64', function (err, r) {
            if (err) return cb && cb(err);
            var seed = H.from((r && (r.random || r.hashed)) || '');
            // A silent zero/short-entropy fallback would make every ephemeral seal keypair predictable → all sealed
            // handshakes decryptable. Fail loud instead.
            if (seed.length < 32) return cb && cb(new Error('bad node entropy (' + seed.length + ' bytes)'));
            var counter = 0, pool = new Uint8Array(0), poolPos = 0;
            function refill() {
                var ctr = new Uint8Array(8), c = counter++;
                for (var i = 0; i < 8; i++) { ctr[i] = c & 0xff; c = Math.floor(c / 256); }
                pool = new Uint8Array(sha512.arrayBuffer(H.concat(ctr, seed)));
                poolPos = 0;
            }
            S.setPRNG(function (x, n) {
                for (var i = 0; i < n; i++) { if (poolPos >= pool.length) refill(); x[i] = pool[poolPos++]; }
            });
            cb && cb(null);
        });
    }

    /** Auto-detect: browser if crypto.getRandomValues exists, else service (node entropy). init(cb(err)). */
    function init(cb) {
        if (g.crypto && typeof g.crypto.getRandomValues === 'function') return initBrowser(cb);
        return initService(cb);
    }

    AX.prng = { init: init, initBrowser: initBrowser, initService: initService };
})(typeof globalThis !== 'undefined' ? globalThis : this);
