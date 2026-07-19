/**
 * ax_sodium — the exact libsodium primitives AtomiX uses, from Rhino-safe pure-JS deps (no WASM).
 * Byte-identical to native lazysodium — gated by test/rhino.sh (runs under the node's actual rhino-1.7.14.jar
 * against native vectors) + the Node harness. Needs lib/rhino_shim.js loaded first (Uint8Array.slice/.fill).
 * Requires vendored globals: AXNACL (tweetnacl), AXBLAKE (blakejs), AXSHA256, AXSHA512. Attaches to AX.sodium.
 *
 * libsodium internals reproduced:
 *   crypto_box_seed_keypair(seed): sk = SHA512(seed)[0:32]; pk = X25519_base(sk)
 *   crypto_sign_seed_keypair(seed): standard Ed25519 seed keypair
 *   crypto_box_seal(m, rpk): epk ephemeral; nonce = blake2b(epk||rpk, 24); c = box(m,nonce,rpk,esk); out = epk||c
 *   crypto_box_seal_open(c, rpk, rsk): epk = c[0:32]; nonce = blake2b(epk||rpk,24); box_open(c[32:],nonce,epk,rsk)
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var nacl = g.AXNACL, blake = g.AXBLAKE;
    var sha256 = g.AXSHA256.sha256, sha512 = g.AXSHA512.sha512;

    function hmacSha256(keyBytes, msgBytes) {
        return new Uint8Array(sha256.hmac.arrayBuffer(keyBytes, msgBytes));
    }

    /** HKDF-SHA256 (RFC 5869) — native Hkdf.java: salt = 32 zero bytes, info string, length. */
    function hkdfSha256(ikm, infoBytes, length) {
        var prk = hmacSha256(new Uint8Array(32), ikm);
        var out = new Uint8Array(length), t = new Uint8Array(0), pos = 0, counter = 1;
        while (pos < length) {
            var input = new Uint8Array(t.length + infoBytes.length + 1);
            input.set(t, 0); input.set(infoBytes, t.length); input[input.length - 1] = counter;
            t = hmacSha256(prk, input);
            var take = Math.min(t.length, length - pos);
            out.set(t.subarray(0, take), pos);
            pos += take; counter++;
        }
        return out;
    }

    function boxSeedKeypair(seed) {
        var h = new Uint8Array(sha512.arrayBuffer(seed));
        var kp = nacl.box.keyPair.fromSecretKey(h.slice(0, 32));
        return { publicKey: kp.publicKey, privateKey: kp.secretKey };
    }

    function signSeedKeypair(seed) {
        var kp = nacl.sign.keyPair.fromSeed(seed);
        return { publicKey: kp.publicKey, privateKey: kp.secretKey };
    }

    function cat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

    function seal(message, rpk) {
        var ek = nacl.box.keyPair();
        var nonce = blake.blake2b(cat(ek.publicKey, rpk), null, 24);
        var boxed = nacl.box(message, nonce, rpk, ek.secretKey);
        return cat(ek.publicKey, boxed);
    }

    function sealOpen(cipher, rpk, rsk) {
        var epk = cipher.slice(0, 32), boxed = cipher.slice(32);
        var nonce = blake.blake2b(cat(epk, rpk), null, 24);
        return nacl.box.open(boxed, nonce, epk, rsk);   // Uint8Array or null
    }

    /**
     * Wire the entropy source for seal()'s ephemeral keypair — MUST be called once at init:
     *   browser (index.html): setPRNG(function(x,n){ crypto.getRandomValues(x); })
     *   service.js (Rhino):   seed from MDS.cmd("random size:...") then serve bytes (see lib/prng bootstrap).
     * Open/verify/derive need NO prng; only sealing (taker handshake, OTC message send) does.
     */
    function setPRNG(fillFn) { nacl.setPRNG(fillFn); }

    AX.sodium = {
        setPRNG: setPRNG,
        hkdfSha256: hkdfSha256,
        boxSeedKeypair: boxSeedKeypair,
        signSeedKeypair: signSeedKeypair,
        seal: seal,
        sealOpen: sealOpen,
        signDetached: function (msg, sk) { return nacl.sign.detached(msg, sk); },
        signVerify: function (sig, msg, pk) { return nacl.sign.detached.verify(msg, sig, pk); },
        sha256Bytes: function (u8) { return new Uint8Array(sha256.arrayBuffer(u8)); }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
