/**
 * take — the buy-mxUSDT handshake channel, a port of native SwapTake.java. When a taker buys mxUSDT it locks USDT
 * first (generating the hashlock), then seals {to, from, hash} to the maker's comms identity and posts it as a
 * 1-nano coin (state[99]) to the currency's TAKE sentinel. The maker scans that address, opens the sealed message,
 * and uses the hashlock to find the USDT lock by deterministic contractId = sha256(hash) via getContract — no
 * eth_getLogs, so it works on free RPCs. The hashlock is NOT secret (already on-chain); the preimage is never sent.
 * This delivery is ESSENTIAL, not cosmetic: without the hashlock the maker cannot locate the taker's lock.
 * Requires AX.identity, AX.trading, AX.mds, AX.hex. Attaches to AX.take.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var ID = AX.identity, TR = AX.trading, M = AX.mds, H = AX.hex;

    /** The active currency's TAKE sentinel — distinct from the order-book + OTC channels. */
    function address() { return TR.active().takeAddr; }

    /** Taker → maker: seal the hashlock to the maker's publicId and post it to the take channel. cb(err). */
    function send(me, makerPublicId, myPublicId, hash, cb) {
        var blob;
        try {
            var j = JSON.stringify({ to: makerPublicId, from: myPublicId, hash: hash });
            blob = ID.seal(me, makerPublicId, H.utf8(j));
        } catch (e) { return cb(new Error('take send: ' + e.message)); }
        var state = { '99': '0x' + blob };
        M.cmdR('send amount:0.000000001 address:' + address() + ' tokenid:0x00 state:' + JSON.stringify(state),
            function (err) { cb(err); });
    }

    AX.take = { address: address, send: send };
})(typeof globalThis !== 'undefined' ? globalThis : this);
