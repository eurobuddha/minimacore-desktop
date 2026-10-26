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
        post(me, makerPublicId, { to: makerPublicId, from: myPublicId, hash: hash }, 'take send: ', cb);
    }

    /** Maker → taker on the same channel (native SwapTake.notice, 0.1.84): why a buy was not locked
     *  (state = retrying | declined). The taker accepts it only from the maker it notified, for its own swap; it
     *  never moves funds. cb(err). */
    function notice(me, takerPublicId, myPublicId, hash, state, reason, cb) {
        post(me, takerPublicId, { to: takerPublicId, from: myPublicId, hash: hash, notice: state, reason: cleanReason(reason) }, 'notice send: ', cb);
    }

    function post(me, toPublicId, obj, what, cb) {
        var blob;
        try { blob = ID.seal(me, toPublicId, H.utf8(JSON.stringify(obj))); }
        catch (e) { return cb(new Error(what + e.message)); }
        var state = { '99': '0x' + blob };
        M.cmdR('send amount:0.000000001 address:' + address() + ' tokenid:0x00 state:' + JSON.stringify(state),
            function (err) { cb(err); });
    }

    /** A notice reason as shown to a user: control chars → space, trimmed, at most 240 chars (native cleanReason). */
    function cleanReason(r) {
        var t = String(r == null ? '' : r).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
        return t.length > 240 ? t.substring(0, 240) : t;
    }

    AX.take = { address: address, send: send, notice: notice, cleanReason: cleanReason };
})(typeof globalThis !== 'undefined' ? globalThis : this);
