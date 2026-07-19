/**
 * abi — minimal Ethereum ABI encode/decode for the fixed set of HTLC + ERC20 calls (all static types: bytes32,
 * address, uint256, bool). Ports native EthHtlc's FunctionEncoder usage incl. the b32 padding rule (left-pad when
 * shorter, keep the LAST 32 bytes when longer). Requires AX.hex + AX.eth (keccak). Attaches to AX.abi.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var H = AX.hex, keccak = AX.eth.keccakBytes;

    /** 4-byte function selector = keccak256(signature)[0:4], hex (no 0x). */
    function selector(sig) { return H.to(keccak(H.utf8(sig)).slice(0, 4)); }

    /** encode a uint256 (BigInt or decimal string or number) → 32-byte hex word. */
    function encUint(v) {
        var n = (typeof v === 'bigint') ? v : BigInt(v);
        if (n < 0n) throw new Error('uint underflow');
        var h = n.toString(16);
        return pad64(h);
    }
    /** encode an address (0x + 40 hex) → 32-byte word (left-padded). */
    function encAddr(a) { return pad64(strip0x(a).toLowerCase()); }
    /** encode bytes32: left-pad when shorter, keep LAST 32 bytes when longer (native b32). */
    function encBytes32(x) {
        var h = strip0x(x);
        if (h.length > 64) h = h.slice(h.length - 64);
        return pad64(h);
    }
    function encBool(b) { return pad64(b ? '1' : '0'); }

    function pad64(h) {
        h = h.replace(/^0x/i, '');
        if (h.length > 64) throw new Error('abi word overflow: ' + h);
        while (h.length < 64) h = '0' + h;
        return h;
    }
    function strip0x(s) { return String(s == null ? '' : s).replace(/^0x/i, ''); }

    /** encodeCall(sig, [{t,v}...]) → 0x-prefixed calldata. t ∈ uint256|address|bytes32|bool. */
    function encodeCall(sig, args) {
        var data = selector(sig);
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a.t === 'uint256') data += encUint(a.v);
            else if (a.t === 'address') data += encAddr(a.v);
            else if (a.t === 'bytes32') data += encBytes32(a.v);
            else if (a.t === 'bool') data += encBool(a.v);
            else throw new Error('abi: unknown type ' + a.t);
        }
        return '0x' + data;
    }

    /** decode a hex return blob into an array of typed values by the given type list. */
    function decode(types, retHex) {
        var h = strip0x(retHex), out = [];
        for (var i = 0; i < types.length; i++) {
            var word = h.slice(i * 64, i * 64 + 64);
            var t = types[i];
            if (t === 'uint256') out.push(BigInt('0x' + (word || '0')));
            else if (t === 'bool') out.push(BigInt('0x' + (word || '0')) !== 0n);
            else if (t === 'address') out.push('0x' + word.slice(24));
            else if (t === 'bytes32') out.push('0x' + word);
            else throw new Error('abi decode: unknown type ' + t);
        }
        return out;
    }

    AX.abi = { selector: selector, encodeCall: encodeCall, decode: decode, pad64: pad64 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
