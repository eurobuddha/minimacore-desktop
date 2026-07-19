/**
 * rhino_shim — MUST load FIRST (before vendored crypto + app code). Rhino 1.7.14 (the MDS service engine) lacks
 * several TypedArray methods that V8 has, which silently broke Phase-1 crypto until we ran it under the node's
 * actual rhino jar: Uint8Array.prototype.slice and .fill are absent (blake2b uses .fill; our code uses .slice).
 * These polyfills make BOTH our code and the vendored libs run identically under Rhino and the browser. No-ops
 * where the methods already exist. (R3, empty-source .set, and R4, keccak word-swap, are fixed at their sites.)
 */
(function (g) {
    'use strict';
    if (typeof Uint8Array === 'undefined') return;
    var P = Uint8Array.prototype;

    if (!P.slice) {
        P.slice = function (start, end) {
            var len = this.length;
            start = start === undefined ? 0 : (start < 0 ? Math.max(len + start, 0) : Math.min(start, len));
            end = end === undefined ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len));
            var n = Math.max(end - start, 0), out = new Uint8Array(n);
            for (var i = 0; i < n; i++) out[i] = this[start + i];
            return out;
        };
    }
    if (!P.fill) {
        P.fill = function (value, start, end) {
            var len = this.length;
            start = start === undefined ? 0 : (start < 0 ? Math.max(len + start, 0) : Math.min(start, len));
            end = end === undefined ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len));
            for (var i = start; i < end; i++) this[i] = value;
            return this;
        };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
