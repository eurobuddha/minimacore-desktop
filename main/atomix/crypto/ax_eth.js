/**
 * ax_eth — Rhino-safe Ethereum helpers: seedrandom privkey → address, and legacy EIP-155 tx signing.
 * Byte-identical to native web3j — gated by test/rhino.sh under the node's actual Rhino. Requires AXEC (elliptic)
 * + AXSHA3 (keccak, via .array() — NOT .arrayBuffer(), which word-swaps under Rhino) + AX.hex + lib/rhino_shim.js.
 * Attaches to AX.eth. The maker's background counter-leg lock, claims and refunds sign here inside service.js.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var H = AX.hex;
    var secp = new g.AXEC.ec('secp256k1');
    var keccak256 = g.AXSHA3.keccak256;

    // MUST use .array() not .arrayBuffer(): js-sha3's arrayBuffer path assumes little-endian Uint32-over-ArrayBuffer,
    // but Rhino 1.7.14 is big-endian there → each 4-byte word reversed → a SILENTLY WRONG keccak (wrong ETH address,
    // wrong tx hash). .array() returns bytes directly and is correct on both engines.
    function keccakBytes(u8) { return new Uint8Array(keccak256.array(u8)); }

    /** minimal big-endian bytes of a non-negative integer (number or decimal string); 0 → empty. */
    function intBytes(v) {
        var hex = toBigHex(v);
        if (hex === '0' || hex === '') return new Uint8Array(0);
        if (hex.length % 2) hex = '0' + hex;
        return H.from(hex);
    }
    // decimal string / number → hex string (no BigInt dependency assumed present in Rhino runtime path)
    function toBigHex(v) {
        if (typeof v === 'number') return v.toString(16);
        var dec = String(v), hex = '0', i, carry, d;
        // repeated *10 + digit in base-16 via manual bigint on a byte array is heavy; use BigInt when available.
        if (typeof g.BigInt === 'function') return g.BigInt(dec).toString(16);
        // Fallback: decimal→hex by schoolbook (rare path; Rhino 1.7.14 does support BigInt so this is a safety net).
        var out = [0];
        for (i = 0; i < dec.length; i++) {
            carry = parseInt(dec.charAt(i), 10);
            for (d = 0; d < out.length; d++) { var val = out[d] * 10 + carry; out[d] = val & 0xff; carry = val >> 8; }
            while (carry) { out.push(carry & 0xff); carry >>= 8; }
        }
        hex = '';
        for (i = out.length - 1; i >= 0; i--) { var h = out[i].toString(16); hex += (hex ? (h.length === 1 ? '0' + h : h) : h); }
        return hex || '0';
    }

    function rlpLenPrefix(len, offset) {
        if (len < 56) return new Uint8Array([offset + len]);
        var lb = intBytes(len);
        return H.concat(new Uint8Array([offset + 55 + lb.length]), lb);
    }
    function rlpBytes(buf) {
        if (buf.length === 1 && buf[0] < 0x80) return buf;
        return H.concat(rlpLenPrefix(buf.length, 0x80), buf);
    }
    function rlpList(items) {
        var body = new Uint8Array(0), i;
        for (i = 0; i < items.length; i++) body = H.concat(body, rlpBytes(items[i]));
        return H.concat(rlpLenPrefix(body.length, 0xc0), body);
    }

    /** address from a 32-byte private key hex (seedrandom output). */
    function addressFromPriv(privHex) {
        var key = secp.keyFromPrivate(H.from(privHex));
        var pub = new Uint8Array(key.getPublic().encode('array', false)).slice(1); // drop 0x04 prefix, 64 bytes
        var hash = keccakBytes(pub);
        return '0x' + H.to(hash.slice(12));
    }

    /** Sign a legacy EIP-155 tx. tx = {nonce, gasPriceWei, gasLimit, to(0x), value, data(0x)}; chainId int. */
    function signLegacyTx(tx, privHex, chainId) {
        var nonce = intBytes(tx.nonce), gasPrice = intBytes(tx.gasPriceWei), gasLimit = intBytes(tx.gasLimit);
        var to = H.from(tx.to), value = intBytes(tx.value), data = H.from(tx.data || '0x');
        var empty = new Uint8Array(0);
        var sigPayload = rlpList([nonce, gasPrice, gasLimit, to, value, data, intBytes(chainId), empty, empty]);
        var msgHash = keccakBytes(sigPayload);
        var sig = secp.keyFromPrivate(H.from(privHex)).sign(msgHash, { canonical: true });
        var r = new Uint8Array(sig.r.toArray('be', 32));
        var s = new Uint8Array(sig.s.toArray('be', 32));
        var v = intBytes(sig.recoveryParam + chainId * 2 + 35);
        return '0x' + H.to(rlpList([nonce, gasPrice, gasLimit, to, value, data, v, r, s]));
    }

    AX.eth = { addressFromPriv: addressFromPriv, signLegacyTx: signLegacyTx, keccakBytes: keccakBytes };
})(typeof globalThis !== 'undefined' ? globalThis : this);
