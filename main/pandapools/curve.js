/*
 * curve.js — VirtualCurve: the JS port of VirtualCurve.java (constant-product quoting) + a small shared
 * `PP` helper namespace used across the other modules.
 *
 * Loaded AFTER covenant.js, so `Decimal` is already pinned to precision:40 / ROUND_DOWN / plain-output —
 * which is exactly what reproduces java.math.BigDecimal for the fund-critical AMM maths. NEVER use native
 * JS floats/parseFloat for reserves/quotes/amounts: they lose precision past ~15 digits and would break
 * the covenant invariant + address parity.
 *
 * Quoting favours the pool (recreate reserve UP to the on-chain grain, clamp input DOWN) so a quote that
 * clears here also clears the covenant on-chain. FEE = 5/1000 (0.5%) — MUST match PoolCovenant *5/1000.
 */

// ---------------------------------------------------------------- shared helpers (PP)
var PP = (function () {
    var D = Decimal;

    function dec(x) {
        if (x instanceof D) return x;
        if (x === null || x === undefined || x === "") return new D(0);
        return new D(x);
    }
    function decOr(s, fb) {
        if (s === null || s === undefined || s === "") return dec(fb);
        try { return new D(String(s).trim()); } catch (e) { return dec(fb); }
    }
    function isMinima(t) { return t === null || t === undefined || t === "0x00"; }

    /** Plain, trailing-zero-stripped amount string for a node command param (never scientific notation).
     *  decimal.js is configured for plain output + normalises trailing zeros, so this reproduces Java's
     *  b.stripTrailingZeros().toPlainString(). */
    function amt(x) { return dec(x).toString(); }

    /** True for the node returning a flag as boolean true / number 1 / "1" / "true" (txncheck is
     *  inconsistent — `valid.scripts` etc. can be a bool or an int/string). */
    function truthy(v) {
        if (v === true) return true;
        if (typeof v === "number") return v === 1;
        if (typeof v === "string") { var s = v.trim().toLowerCase(); return s === "1" || s === "true"; }
        return false;
    }

    function shorten(s) {
        if (!s) return "";
        if (s.length <= 16) return s;
        return s.substring(0, 8) + "…" + s.substring(s.length - 6);
    }

    function clampDec(d) {
        d = parseInt(d, 10);
        if (isNaN(d)) return 8;
        return d < 0 ? 0 : (d > 44 ? 44 : d);
    }

    /** The token's on-chain decimal grain. Minima floors stored token amounts to this precision, so any
     *  output amount MUST be quantized to it. MINIMA (0x00) is full 44-dp. Defaults to 8 if missing. */
    function tokenDecimals(token) {
        if (token && typeof token === "object") {
            if (token.decimals !== undefined && token.decimals !== null) return clampDec(token.decimals);
            if (token.token && token.token.decimals !== undefined && token.token.decimals !== null)
                return clampDec(token.token.decimals);
        }
        return 8;
    }

    /** Human-readable token name from whatever shape the node returns (string / {name:{ticker,name}}). */
    function tokenName(token, tid) {
        if (isMinima(tid)) return "Minima";
        if (typeof token === "string") return token;
        if (token && typeof token === "object") {
            var name = token.name;
            if (name && typeof name === "object") {
                if (name.ticker) return name.ticker;
                if (name.name) return name.name;
            }
            if (typeof name === "string" && name) return name;
        }
        return "Token";
    }

    /** Short display symbol for a pool's token side. */
    function tokenLabel(p) {
        if (p.tokName && p.tokName !== "" && (!p.tok || p.tokName.toLowerCase() !== p.tok.toLowerCase()))
            return p.tokName;
        var h = (p.tok && p.tok.indexOf("0x") === 0) ? p.tok.substring(2) : (p.tok || "");
        return h.length > 8 ? h.substring(0, 8) + "…" : h;
    }

    /** Plain string for display (trailing zeros stripped). */
    function plain(d) { if (d === null || d === undefined) return "—"; return dec(d).toString(); }
    /** Fixed n dp, rounded DOWN, trailing zeros stripped (matches the native trim8 at 8dp). */
    function fix(d, n) { if (d === null || d === undefined) return "—"; return dec(d).toDP(n, D.ROUND_DOWN).toString(); }

    /** Trim a decimal amount string for tidy display. */
    function tidy(a) {
        if (a === null || a === undefined || a === "") return "0";
        try { return dec(a).toString(); } catch (e) { return String(a); }
    }

    return {
        D: D,
        MINIMA: "0x00",
        dec: dec, decOr: decOr, isMinima: isMinima, amt: amt, truthy: truthy,
        shorten: shorten, tokenDecimals: tokenDecimals, tokenName: tokenName,
        tokenLabel: tokenLabel, plain: plain, fix: fix, tidy: tidy
    };
})();

// ---------------------------------------------------------------- VirtualCurve
var Curve = (function () {
    var D = Decimal;
    var FEE_NUM = new D(5);          // 5/1000 = 0.5% — MUST match PoolCovenant *5/1000
    var FEE_DEN = new D(1000);
    var MINIMA_DP = 11;             // recreated-MINIMA grain (well under MINIMA's 44-dp, so no on-chain floor)
    var GUARD = 4;                 // max grain nudges to keep the invariant true under extreme double-rounding

    function grain(dp) { return new D("1e-" + dp); }   // 10^-dp, exact

    function funded(p) {
        return p && p.reserveM && p.reserveT
            && PP.dec(p.reserveM).gt(0) && PP.dec(p.reserveT).gt(0);
    }
    function spotPrice(p) { return funded(p) ? PP.dec(p.reserveT).div(PP.dec(p.reserveM)) : new D(0); }   // token per MINIMA
    function k(p) { return funded(p) ? PP.dec(p.reserveM).times(PP.dec(p.reserveT)) : new D(0); }
    function feeGrowth(p) {
        var km = PP.decOr(p.kmin, 0);
        if (km.isZero()) return new D(0);
        return k(p).div(km).minus(1);
    }

    /**
     * MINIMA -> token. Taker puts in dx MINIMA, gets dy token. ny (recreated token reserve) is rounded UP
     * to the token grain so the value the covenant reads after Minima floors it still clears
     * (nx-fx)*ny >= MAX(x*y, KMIN); dy = y - ny is then on-grain too.
     */
    function quoteMtoT(p, dxRaw) {
        var q = { ok: false };
        if (!funded(p)) return q;
        var dx = PP.dec(dxRaw);
        if (dx.lte(0)) return q;
        var dp = p.tokDecimals;
        var x = PP.dec(p.reserveM), y = PP.dec(p.reserveT), kmin = PP.decOr(p.kmin, 0);
        var nx = x.plus(dx);
        var fx = dx.times(FEE_NUM).div(FEE_DEN);
        var rhs = D.max(x.times(y), kmin);
        var denom = nx.minus(fx);
        if (denom.lte(0)) return q;
        var ny = rhs.div(denom).toDP(dp, D.ROUND_UP);           // token-grain, pool-favourable
        var g = grain(dp);
        for (var i = 0; i < GUARD && denom.times(ny).lt(rhs); i++) ny = ny.plus(g);   // keep invariant true
        var dy = y.minus(ny);
        if (dy.lte(0)) return q;                                 // pool too shallow / trade too small
        q.inAmount = dx; q.outAmount = dy; q.newX = nx; q.newY = ny;
        q.spotBefore = spotPrice(p); q.spotAfter = ny.div(nx);
        q.effPrice = dy.div(dx);                                 // token per MINIMA realised
        q.ok = true;
        return q;
    }

    /**
     * token -> MINIMA. Input is clamped DOWN to the token grain (an achievable coin amount; ny = y + dyin
     * on-grain); nx (recreated MINIMA reserve) is rounded UP, pool-favourable, so nx*(ny-fy) >= rhs.
     */
    function quoteTtoM(p, dyinRaw) {
        var q = { ok: false };
        if (!funded(p)) return q;
        var dyin0 = PP.dec(dyinRaw);
        if (dyin0.lte(0)) return q;
        var dp = p.tokDecimals;
        var dyin = dyin0.toDP(dp, D.ROUND_DOWN);                 // clamp token input to the on-chain grain
        if (dyin.lte(0)) return q;
        var x = PP.dec(p.reserveM), y = PP.dec(p.reserveT), kmin = PP.decOr(p.kmin, 0);
        var ny = y.plus(dyin);
        var fy = dyin.times(FEE_NUM).div(FEE_DEN);
        var rhs = D.max(x.times(y), kmin);
        var denomY = ny.minus(fy);
        if (denomY.lte(0)) return q;
        var nx = rhs.div(denomY).toDP(MINIMA_DP, D.ROUND_UP);    // MINIMA-grain, pool-favourable
        var g = grain(MINIMA_DP);
        for (var i = 0; i < GUARD && nx.times(denomY).lt(rhs); i++) nx = nx.plus(g);
        var dm = x.minus(nx);
        if (dm.lte(0)) return q;
        q.inAmount = dyin; q.outAmount = dm; q.newX = nx; q.newY = ny;
        q.spotBefore = spotPrice(p); q.spotAfter = ny.div(nx);
        q.effPrice = dyin.div(dm);
        q.ok = true;
        return q;
    }

    /** Reserve-weighted mean token-per-MINIMA across funded pools — the virtual-curve mid. */
    function aggregatePrice(pools) {
        var sumX = new D(0), sumY = new D(0);
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            if (funded(p)) { sumX = sumX.plus(PP.dec(p.reserveM)); sumY = sumY.plus(PP.dec(p.reserveT)); }
        }
        return sumX.isZero() ? new D(0) : sumY.div(sumX);
    }

    /** Total MINIMA-side depth across funded pools (aggregate pool size). */
    function totalMinima(pools) {
        var s = new D(0);
        for (var i = 0; i < pools.length; i++) if (funded(pools[i])) s = s.plus(PP.dec(pools[i].reserveM));
        return s;
    }

    return {
        FEE_NUM: FEE_NUM, FEE_DEN: FEE_DEN, MINIMA_DP: MINIMA_DP,
        funded: funded, spotPrice: spotPrice, k: k, feeGrowth: feeGrowth,
        quoteMtoT: quoteMtoT, quoteTtoM: quoteTtoM,
        aggregatePrice: aggregatePrice, totalMinima: totalMinima
    };
})();
