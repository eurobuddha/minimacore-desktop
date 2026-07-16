/*
 * PandaPools covenant — JS port of PoolCovenant.java (the native app), used by the MiniDapp.
 * 0.5% fee. The KISS template is stored as ONE LINE, byte-identical to PoolCovenant.TEMPLATE, so a pool
 * derives to the SAME address on every node (address parity = the whole registry interoperates).
 *
 * Requires decimal.js (loaded first). We pin a Decimal config that reproduces java.math.BigDecimal exactly
 * for the fund-critical maths: 40 significant digits, ROUND_DOWN default, and NEVER exponential notation
 * (so toString() == BigDecimal.toPlainString()), which the covenant/quote/router code all rely on.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN, toExpPos: 9e15, toExpNeg: -9e15 });

var Covenant = (function () {

    // "PANDAPOOLS" in hex — the shared registry sentinel address (same as the native app).
    var SENTINEL = "0x50414E4441504F4F4C53";

    // MiniNumber magnitude ceiling — a KMIN literal >= this won't compile (script overflow at parse).
    var MININUMBER_MAX = new Decimal("18446744073709551615"); // 2^64-1

    // Version literal written to announce state port 1: "PP1" as hex = 0x505031.
    var VERSION_HEX = "0x505031";

    // The covenant template, ONE line, with $OPK/$OADR/$TOK/$KMIN placeholders. Byte-identical to
    // PoolCovenant.TEMPLATE (0.5% fee = *5/1000).
    var TEMPLATE =
        "IF SIGNEDBY($OPK) THEN " +
        "IF VERIFYOUT(@INPUT $OADR @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF " +
        "RETURN GETOUTADDR(@INPUT) EQ @ADDRESS AND GETOUTTOK(@INPUT) EQ @TOKENID AND GETOUTAMT(@INPUT) GTE @AMOUNT " +
        "ENDIF " +
        "IF @TOKENID EQ 0x00 THEN " +
        "ASSERT @INPUT % 2 EQ 0 LET s=@INPUT+1 " +
        "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ $TOK " +
        "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ $TOK " +
        "LET x=@AMOUNT LET y=GETINAMT(s) LET nx=GETOUTAMT(@INPUT) LET ny=GETOUTAMT(s) " +
        "ASSERT VERIFYOUT(@INPUT @ADDRESS nx 0x00 FALSE) " +
        "ELSE " +
        "ASSERT @TOKENID EQ $TOK AND @INPUT % 2 EQ 1 LET s=@INPUT-1 " +
        "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ 0x00 " +
        "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ 0x00 " +
        "LET y=@AMOUNT LET x=GETINAMT(s) LET ny=GETOUTAMT(@INPUT) LET nx=GETOUTAMT(s) " +
        "ASSERT VERIFYOUT(@INPUT @ADDRESS ny $TOK FALSE) " +
        "ENDIF " +
        "LET dx=nx-x LET dy=ny-y LET fx=MAX(dx 0)*5/1000 LET fy=MAX(dy 0)*5/1000 " +
        "RETURN (nx-fx)*(ny-fy) GTE MAX(x*y $KMIN)";

    /** Fill the template with a pool's four literals → the one-line KISS script. `.split().join()` replaces
     *  ALL occurrences ($TOK appears 4×), matching Java String.replace. Values are hex/plain-number so order
     *  is irrelevant, but we mirror Java's order. */
    function script(opk, oadr, tok, kmin) {
        return TEMPLATE
            .split("$OPK").join(opk)
            .split("$OADR").join(oadr)
            .split("$TOK").join(tok)
            .split("$KMIN").join(kmin);
    }

    /** KMIN = SIGDIG(20, x0*y0) rounded DOWN, trailing zeros stripped, plain string — matches
     *  PoolCovenant.kmin. decimal.js normalises away trailing zeros (unlike BigDecimal.multiply), so this
     *  reproduces `.round(MathContext(20,DOWN)).stripTrailingZeros().toPlainString()`. `y0` MUST already be
     *  clamped to the token's decimal grain by the caller (an achievable coin amount), exactly as the Java
     *  app computes kmin from y0c. Throws if x0*y0 >= 2^64 (won't compile). */
    function kmin(x0, y0) {
        var p = new Decimal(x0).times(y0);
        if (p.isZero()) return "0";
        if (p.gte(MININUMBER_MAX)) throw new Error("x0 x y0 >= 2^64 — reserves too large for a single pool (split into several)");
        var k = p.toSignificantDigits(20, Decimal.ROUND_DOWN);
        return k.isZero() ? "0" : k.toString();
    }

    /** True if a pool with these reserves is buildable (KMIN literal compiles). */
    function sizeOk(x0, y0) {
        return new Decimal(x0).times(y0).lt(MININUMBER_MAX);
    }

    /**
     * Quote a KISS script for a command param (runscript/newscript) WITHOUT escaping forward slashes.
     * The native app's Util.scriptArg exists because Java's JSONObject.quote escaped `/`→`\/`, which makes
     * the covenant's `*5/1000` unparseable (parseok=false) → a coin at that malformed address is UNSPENDABLE
     * FOREVER. In JS we simply wrap in double-quotes, escaping only `"` and `\` (which KISS never contains) —
     * and CRUCIALLY leave `/` alone. MDS.cmd passes the string through verbatim, so `/` survives.
     */
    function scriptArg(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '"' || c === '\\') out += '\\';
            out += c;
        }
        return out + '"';
    }

    return {
        SENTINEL: SENTINEL,
        VERSION_HEX: VERSION_HEX,
        MININUMBER_MAX: MININUMBER_MAX,
        script: script,
        kmin: kmin,
        sizeOk: sizeOk,
        scriptArg: scriptArg
    };
})();
