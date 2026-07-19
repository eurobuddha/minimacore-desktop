/**
 * decimal — exact decimal-string math (no float error) for trade amounts. Minima/mxUSDT amounts are decimal
 * STRINGS passed to node commands; ETH amounts are integer wei-scale (BigInt) for the ABI. Ports native
 * MinimaHtlc.grain (6dp DOWN) + computeUsdt/computeMinima (BigDecimal setScale DOWN/UP) + EthWallet parseUnits.
 * Rhino has BigInt. Attaches to AX.dec.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    /** Normalise a decimal string: trim, strip +, collapse leading zeros, ensure a digit before '.'. */
    function norm(s) {
        s = String(s == null ? '' : s).trim();
        if (s.charAt(0) === '+') s = s.slice(1);
        var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
        if (s === '' || s === '.') s = '0';
        if (s.indexOf('.') === 0) s = '0' + s;
        return (neg ? '-' : '') + s;
    }

    /** Floor a decimal string to `dp` places (round DOWN toward zero) — the grain quantiser. */
    function floorDp(s, dp) {
        s = norm(s);
        var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
        var dot = s.indexOf('.');
        if (dot < 0) return (neg ? '-' : '') + strip(s + '.' + rep('0', dp), dp);
        var intp = s.slice(0, dot), frac = s.slice(dot + 1);
        frac = (frac + rep('0', dp)).slice(0, dp);   // truncate (floor toward zero)
        return (neg ? '-' : '') + strip(intp + '.' + frac, dp);
    }

    /** Ceil a decimal string to `dp` places (round UP away from zero) — for the buyer's USDT they must pay. */
    function ceilDp(s, dp) {
        s = norm(s);
        var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
        var dot = s.indexOf('.');
        var intp = dot < 0 ? s : s.slice(0, dot);
        var frac = dot < 0 ? '' : s.slice(dot + 1);
        var keep = (frac + rep('0', dp)).slice(0, dp);
        var rest = frac.slice(dp);
        if (rest.replace(/0/g, '') !== '') {   // there is a non-zero remainder → bump the last kept digit
            keep = bumpFrac(intp, keep, dp);
            // bumpFrac returns "int.frac" already assembled
            return (neg ? '-' : '') + strip(keep, dp);
        }
        return (neg ? '-' : '') + strip(intp + '.' + keep, dp);
    }
    function bumpFrac(intp, keep, dp) {
        // add 1 ulp at dp to intp.keep using BigInt on the scaled integer
        var scaled = BigInt(intp + (keep || '')) + 1n;
        var str = scaled.toString();
        while (str.length <= dp) str = '0' + str;
        var i = str.slice(0, str.length - dp), f = str.slice(str.length - dp);
        return i + '.' + f;
    }

    /** grain6 = floor to 6dp (the ERC20-USDT / mxUSDT trade grain). */
    function grain6(s) { return floorDp(s, 6); }

    /** multiply two decimal strings, floor result to dp. amount * price (proceeds/USDT you receive). */
    function mulFloor(a, b, dp) { return scaleOp(a, b, dp, true, false); }
    /** multiply two decimal strings, CEIL result to dp (USDT you must pay). */
    function mulCeil(a, b, dp) { return scaleOp(a, b, dp, true, true); }
    /** divide a/b, floor to dp (mxUSDT you receive for a USDT amount). */
    function divFloor(a, b, dp) { return scaleOp(a, b, dp, false, false); }

    // helper: integer math on scaled BigInts. For mul: (A*B) at combined scale → rescale to dp. For div: A/B.
    function scaleOp(a, b, dp, isMul, up) {
        a = norm(a); b = norm(b);
        var A = toScaled(a), B = toScaled(b);   // { n: BigInt, s: scale }
        if (isMul) {
            var prod = A.n * B.n, scale = A.s + B.s;   // value = prod / 10^scale
            return rescale(prod, scale, dp, up);
        } else {
            // a/b to dp: (A.n * 10^(dp + B.s)) / (B.n * 10^A.s) then it's already at dp
            if (B.n === 0n) return '0';
            var num = A.n * pow10(dp + B.s), den = B.n * pow10(A.s);
            var q = num / den, r = num % den;
            if (up && r !== 0n) q = q + 1n;
            return fromScaled(q, dp);
        }
    }
    function rescale(n, fromScale, dp, up) {
        if (fromScale === dp) return fromScaled(n, dp);
        if (fromScale > dp) {
            var div = pow10(fromScale - dp), q = n / div, r = n % div;
            if (up && r !== 0n) q = q + 1n;
            return fromScaled(q, dp);
        }
        return fromScaled(n * pow10(dp - fromScale), dp);
    }
    function toScaled(s) {
        var dot = s.indexOf('.');
        if (dot < 0) return { n: BigInt(s), s: 0 };
        var frac = s.slice(dot + 1);
        return { n: BigInt(s.slice(0, dot) + frac), s: frac.length };
    }
    function fromScaled(n, dp) {
        var neg = n < 0n; if (neg) n = -n;
        var str = n.toString();
        while (str.length <= dp) str = '0' + str;
        var i = str.slice(0, str.length - dp), f = str.slice(str.length - dp);
        return (neg ? '-' : '') + strip(dp ? (i + '.' + f) : i, dp);
    }
    function pow10(e) { return BigInt('1' + rep('0', e)); }

    /** Exact decimal subtraction a − b (may be negative) — for a claim/refund change output (fund-relevant). */
    function sub(a, b) {
        a = norm(a); b = norm(b);
        var A = toScaled(a), B = toScaled(b), scale = Math.max(A.s, B.s);
        return fromScaled(A.n * pow10(scale - A.s) - B.n * pow10(scale - B.s), scale);
    }
    /** True iff the decimal string is strictly > 0 — decides whether a change output is emitted at all. */
    function gt0(a) { return toScaled(norm(a)).n > 0n; }

    /** parseUnits: decimal string → integer of `decimals` scale, as a BigInt (for ETH ABI). */
    function parseUnits(s, decimals) {
        s = norm(s);
        var dot = s.indexOf('.');
        var intp = dot < 0 ? s : s.slice(0, dot);
        var frac = dot < 0 ? '' : s.slice(dot + 1);
        frac = (frac + rep('0', decimals)).slice(0, decimals);   // truncate extra precision
        var neg = intp.charAt(0) === '-'; if (neg) intp = intp.slice(1);
        var v = BigInt((intp || '0') + frac);
        return neg ? -v : v;
    }
    /** formatUnits: BigInt of `decimals` scale → decimal string. */
    function formatUnits(v, decimals) { return fromScaled(typeof v === 'bigint' ? v : BigInt(v), decimals); }

    // ---- string utils ----
    function rep(ch, n) { var s = ''; for (var i = 0; i < n; i++) s += ch; return s; }
    /** strip trailing zeros in the fractional part + a dangling dot (keep integers whole). */
    function strip(s, dp) {
        if (s.indexOf('.') < 0) return s;
        s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s === '' || s === '-' ? '0' : s;
    }

    AX.dec = {
        norm: norm, floorDp: floorDp, ceilDp: ceilDp, grain6: grain6,
        mulFloor: mulFloor, mulCeil: mulCeil, divFloor: divFloor, sub: sub, gt0: gt0,
        parseUnits: parseUnits, formatUnits: formatUnits
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
