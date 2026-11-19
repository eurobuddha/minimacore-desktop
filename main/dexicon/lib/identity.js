/**
 * identity — port of native comms/CommsIdentity.java + LocalEcCryptoProvider.java.
 * Derives the per-currency comms identity from the node seed and does the seal/open envelope, byte-identical to
 * native (so a handshake sealed to an order this identity published can only be opened here — the interop anchor).
 * Requires AX.sodium + AX.hex. Attaches to AX.identity.
 *
 * publicId = "0x" + boxPk(32) + signPk(32).
 * Envelope: sig = ed25519_detached(myPublicId_bytes || plaintext); payload {f,b,s}; blob = crypto_box_seal(payload).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var S = AX.sodium, H = AX.hex;

    /** Native seed-bytes rule: 0x → hex-decode, else raw UTF-8 bytes. */
    function seedBytes(seedStr) {
        return (seedStr.indexOf('0x') === 0 || seedStr.indexOf('0X') === 0) ? H.from(seedStr) : H.utf8(seedStr);
    }

    /** From a node seed string + per-currency HKDF context ("minimaswap"/"usdtswap"). */
    function fromSeed(seedStr, context) {
        var seed = seedBytes(seedStr);
        var box = S.boxSeedKeypair(S.hkdfSha256(seed, H.utf8(context + '-box-v1'), 32));
        var sign = S.signSeedKeypair(S.hkdfSha256(seed, H.utf8(context + '-sign-v1'), 32));
        return makeIdentity(box.publicKey, box.privateKey, sign.publicKey, sign.privateKey);
    }

    function makeIdentity(boxPk, boxSk, signPk, signSk) {
        return {
            boxPk: boxPk, boxSk: boxSk, signPk: signPk, signSk: signSk,
            publicId: function () { return '0x' + H.to(boxPk) + H.to(signPk); }
        };
    }

    function isValidPublicId(id) {
        try { return H.from(id).length === 64; } catch (e) { return false; }
    }
    function boxPkOf(id) { return H.from(id).slice(0, 32); }
    function signPkOf(id) { return H.from(id).slice(32, 64); }

    /**
     * seal(me, toPublicId, plaintextBytes) → lowercase hex blob.
     * sig covers me.publicId_bytes || plaintext; payload = {f: me.publicId, b: hex(plaintext), s: hex(sig)};
     * blob = crypto_box_seal(payload, boxPkOf(to)).
     */
    function seal(me, toPublicId, plaintextBytes) {
        if (!isValidPublicId(toPublicId)) throw new Error('seal: bad recipient publicId');
        var myId = me.publicId();
        var signed = H.concat(H.from(myId), plaintextBytes);
        var sig = S.signDetached(signed, me.signSk);
        // bare hex (no 0x) for exact byte-parity with native LocalEcCryptoProvider's payload.
        var payload = { f: myId, b: H.to(plaintextBytes), s: H.to(sig) };
        var blob = S.seal(H.utf8(JSON.stringify(payload)), boxPkOf(toPublicId));
        return H.to(blob);
    }

    /**
     * open(me, blobHex) → { valid, fromPublicId, plaintext(bytes) } or null if not for me / malformed.
     * crypto_box_seal_open is itself the "is it for me" test; then re-verify the inner Ed25519 signature.
     */
    function open(me, blobHex) {
        try {
            var payloadBytes = S.sealOpen(H.from(blobHex), me.boxPk, me.boxSk);
            if (!payloadBytes) return null;   // not sealed to me (this IS the "is it for me" test)
            var p = JSON.parse(H.utf8Decode(payloadBytes));
            if (!p || !p.f || p.b == null || !p.s) return null;
            if (!isValidPublicId(p.f)) return null;
            var from = canonicalId(p.f), body = H.from(p.b), sig = H.from(p.s);   // canonical form for stable keying
            if (sig.length !== 64) return { valid: false, fromPublicId: from, plaintext: body };
            var valid = S.signVerify(sig, H.concat(H.from(from), body), signPkOf(from));
            return { valid: valid, fromPublicId: from, plaintext: body };
        } catch (e) { return null; }
    }

    /** Like open() but returns null unless the inner signature is valid — the ONLY thing callers should trust. */
    function openValid(me, blobHex) {
        var o = open(me, blobHex);
        return (o && o.valid) ? o : null;
    }

    /** Canonical lowercase 0x form so case/format variants of the same keys can't split string-keyed maps. */
    function canonicalId(id) { var b = H.from(id); return '0x' + H.to(b); }

    AX.identity = {
        fromSeed: fromSeed, fromKeys: makeIdentity, seedBytes: seedBytes,
        isValidPublicId: isValidPublicId, boxPkOf: boxPkOf, signPkOf: signPkOf, canonicalId: canonicalId,
        seal: seal, open: open, openValid: openValid
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
