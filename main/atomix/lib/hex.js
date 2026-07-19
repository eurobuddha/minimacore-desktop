/**
 * Hex codec — port of native comms/Hex.java. Lowercase output, tolerates an optional 0x on decode.
 * Dual-target: attaches to the global AX namespace (browser <script> + Rhino MDS.load).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    function toHex(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i++) {
            var h = (u8[i] & 0xff).toString(16);
            s += h.length === 1 ? '0' + h : h;
        }
        return s;
    }

    var HEXRE = /^[0-9a-fA-F]*$/;
    function fromHex(h) {
        if (h == null) return new Uint8Array(0);
        if (h.indexOf('0x') === 0 || h.indexOf('0X') === 0) h = h.substring(2);
        // Strict, fail-closed (matches native Hex.from throwing on bad input): reject odd length + non-hex, so
        // isValidPublicId and every downstream byte-compare rejects exactly what native rejects.
        if (h.length % 2 !== 0 || !HEXRE.test(h)) throw new Error('bad hex');
        var out = new Uint8Array(h.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
        return out;
    }

    /** UTF-8 encode a JS string to bytes (Rhino has no TextEncoder). */
    function utf8(str) {
        var bytes = [], c;
        for (var i = 0; i < str.length; i++) {
            c = str.charCodeAt(i);
            if (c < 0x80) bytes.push(c);
            else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
            else if (c >= 0xd800 && c <= 0xdbff) { // surrogate pair
                c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
                bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            } else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
        }
        return new Uint8Array(bytes);
    }

    /** UTF-8 decode bytes to a JS string. */
    function utf8Decode(u8) {
        var s = '', i = 0, c;
        while (i < u8.length) {
            c = u8[i++];
            if (c < 0x80) s += String.fromCharCode(c);
            else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f));
            else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f));
            else {
                var cp = ((c & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
                cp -= 0x10000;
                s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            }
        }
        return s;
    }

    function concat() {
        var total = 0, i;
        for (i = 0; i < arguments.length; i++) total += arguments[i].length;
        var out = new Uint8Array(total), off = 0;
        // Rhino throws RangeError on out.set(emptySrc, off===out.length); skip zero-length args (signLegacyTx's
        // EIP-155 payload ends with two empty items, so this fires on every tx signing).
        for (i = 0; i < arguments.length; i++) { if (arguments[i].length) { out.set(arguments[i], off); off += arguments[i].length; } }
        return out;
    }

    AX.hex = { to: toHex, from: fromHex, utf8: utf8, utf8Decode: utf8Decode, concat: concat };
})(typeof globalThis !== 'undefined' ? globalThis : this);
