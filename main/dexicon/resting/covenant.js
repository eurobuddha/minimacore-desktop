/* Shared V5 constants and exact, decimal-safe order parsing. */
var PandaDEX = PandaDEX || {};
(function (P) {
  P.USDT = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  /* V6 (review 7 Nov, 0.4.25): the V5 covenant's partial-fill branch pinned the remainder's state with SAMESTATE, which
     compares values as TEXT - a filler could rewrite port 0 as the STRING "[0x..]", pass, and every later spend of the
     remainder (cancel, expiry, fill) then threw: the maker's remainder frozen for good (proven on a -test chain). V6
     pins each carried port with STATE(i) EQ PREVSTATE(i), which also fails across types. New orders are placed at V6;
     the book, fills, cancels, relocks and expiry still serve V5 coins at their own address until they are gone. */
  P.ADDR = "0xDCF621472F6A09D5978D24DEF133B756DCED87067FCA692C21374EC38EF2D80A";
  P.ADDR_V5 = "0x2D43279DD85DABCA3EA90C9997DAB9169D8B7A0E8CB594236AF44542489774A5";
  P.ADDRS = [P.ADDR, P.ADDR_V5];
  P.isOrderAddr = function (a) { var u = String(a || "").toUpperCase(), i; for (i = 0; i < P.ADDRS.length; i++) if (u === P.ADDRS[i].toUpperCase()) return true; return false; };
  /* HORIZON is the node's own visibility ceiling (MINIMA_CASCADE_START_DEPTH): a light node cannot
     see a coin older than this, which is why EXPIRY must sit well under it — an order has to be
     able to expire AND still be visible long enough for anyone to sweep it home.
     SCAN_DEPTH must exceed EXPIRY or expired orders are simply never seen: at 600 the collect-
     expired path could never fire, because a coin only becomes collectable at the exact age the
     scan stopped looking. 1000 keeps us under the 1024 trim, as native does.
     RENEW_AT is when a GTC order starts trying to renew. Native renews from age 200, leaving ~5.5h
     of retries. MDS has no Doze-proof watcher and only runs while the node is up, so the wide
     margin matters more here, not less. */
  P.HORIZON = 1024; P.EXPIRY = 600; P.RENEW_AT = 200; P.SCAN_DEPTH = 1000; P.MAX_ORDERS = 5;
  /* Per-LEG cap. The covenant compares by cross-multiplication, so overflow safety depends on
     BOTH legs staying under this — bounding only the locked side leaves the want side free to
     overflow. */
  P.MIN_ORDER = "0.01"; P.MAX_ORDER = "1000000000"; P.DP = 8; P.PRICE_DP = 12;
  Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN, toExpNeg: -1000000000, toExpPos: 1000000000 });
  P.d = function (v) { return new Decimal(v === undefined || v === null || v === "" ? 0 : v); };
  P.plain = function (v) { return P.d(v).toFixed(); };
  P.down = function (v, dp) { return P.d(v).toDecimalPlaces(dp, Decimal.ROUND_DOWN); };
  P.up = function (v, dp) { return P.d(v).toDecimalPlaces(dp, Decimal.ROUND_CEIL); };
  P.eqTok = function (a, b) { return String(a || "0x00").toUpperCase() === String(b || "0x00").toUpperCase(); };
  P.state = function (coin, port) {
    var s = coin && coin.state, i, e;
    if (s && !Array.isArray(s) && s[String(port)] !== undefined) return String(s[String(port)]);
    if (Array.isArray(s)) for (i = 0; i < s.length; i++) { e = s[i]; if (e && Number(e.port) === port) return String(e.data); }
    return null;
  };
  P.order = function (coin) {
    try {
      var p0=P.state(coin,0), p1=P.state(coin,1), p2=P.state(coin,2), p3=P.state(coin,3), p4=P.state(coin,4);
      if (!coin || !coin.coinid || !p0 || !p1 || !p2 || !p4) return null;
      var side=P.state(coin,5), gtc=P.state(coin,7), minimum=PandaSafety.decimal(P.state(coin,8));
      if ((side!=="0" && side!=="1") || (gtc!=="0" && gtc!=="1") || !minimum) return null;
      var sell = side === "1", tok = coin.tokenid || "0x00";
      var locked = PandaSafety.decimal(P.eqTok(tok,"0x00") ? coin.amount : coin.tokenamount), want=PandaSafety.decimal(p2);
      if (!P.amountOk(locked) || !P.amountOk(want)) return null;
      /* the covenant this coin sits at: fills put the remainder back there and relocks keep it there */
      var addr = coin.address === undefined || coin.address === null || coin.address === "" ? P.ADDR_V5 : String(coin.address);
      if (!P.isOrderAddr(addr)) return null;
      var o = { coinid:coin.coinid, addr:addr, ownerPk:p0, wantAddr:p1, wantAmt:want, wantTok:p3 || "0x00", orderId:p4,
        sell:sell, gtc:gtc==="1", minRem:minimum, locked:locked, lockedTok:tok,
        created:PandaSafety.positiveInteger(coin.created), sourceJson:JSON.stringify(coin) };
      /* 0.4.26: a coin that parses but is not fillable (e.g. a filler gave the remainder more than DP decimals - neither
         covenant limits precision) stays in the book so its OWNER can still see, cancel and collect it; takers, composite
         routing and the mid price skip it (o.fillable). Dropping it hid the owner's own coins. */
      if (!o.locked.gt(0) || !o.wantAmt.gt(0) || !P.safeOrder(o)) return null;
      /* 0.4.27: only the precision case is kept. A coin with the wrong token pair or a payout at a covenant can never be
         spent by any path (the script's first line refuses foreign tokens), so keeping it let planted dust occupy the
         owner's renewal slots and show as fake depth; it is dropped as before. */
      if (!P.spendableShape(o)) return null;
      o.fillable = P.fillable(o);
      o.minima = sell ? locked : want; o.usdt = sell ? want : locked;
      o.price = o.usdt.div(o.minima);
      return o;
    } catch (ignore) { return null; }
  };
  P.amountOk = function(value) { return !!(value && value.gt(0) && value.lte(P.MAX_ORDER)); };
  P.safeOrder = function(o) {
    return !!(o && PandaSafety.hex(o.coinid) && PandaSafety.hex(o.ownerPk) && PandaSafety.hex(o.wantAddr) &&
      PandaSafety.hex(o.wantTok) && PandaSafety.hex(o.orderId) && PandaSafety.hex(o.lockedTok) &&
      P.amountOk(PandaSafety.decimal(o.locked.toString())) && P.amountOk(PandaSafety.decimal(o.wantAmt.toString())) &&
      o.minRem && PandaSafety.decimal(o.minRem.toString()) && o.minRem.gte(0));
  };
  P.spendableShape = function (o) {
    var expectedWant=o.sell ? P.USDT : "0x00", expectedLock=o.sell ? "0x00" : P.USDT;
    return P.eqTok(o.wantTok, expectedWant) && P.eqTok(o.lockedTok, expectedLock) &&
      /^0x[0-9a-f]{64}$/i.test(o.wantAddr) && !P.isOrderAddr(o.wantAddr) && !o.minRem.lt(0);
  };
  P.fillable = function (o) {
    if (!P.safeOrder(o)) return false;
    var expectedWant=o.sell ? P.USDT : "0x00", expectedLock=o.sell ? "0x00" : P.USDT;
    return P.eqTok(o.wantTok, expectedWant) && P.eqTok(o.lockedTok, expectedLock) &&
      /^0x[0-9a-f]{64}$/i.test(o.wantAddr) && !P.isOrderAddr(o.wantAddr) &&
      o.locked.decimalPlaces() <= P.DP && o.wantAmt.decimalPlaces() <= P.DP && o.minRem.decimalPlaces() <= P.DP && !o.minRem.lt(0);
  };
  /* ---- the partial-fill arithmetic, mirroring what the covenant enforces on-chain ----
     Every rounding here goes the MAKER's way (ROUND_CEIL on what a taker pays and on the
     remainder's new want), because the covenant compares by cross-multiplication with no
     division and no rounding slack. A taker who shaves one grain off either figure is rejected,
     and the coin is left untouched. These are named so the rule is testable rather than being
     re-derived inline at each call site. */
  P.payFor = function (want, locked, take) { return P.up(P.d(want).mul(take).div(locked), P.DP); };
  P.newWantFor = function (want, locked, rem) {
    var nw = P.up(P.d(want).mul(rem).div(locked), P.DP);
    return nw.gt(want) ? P.d(want) : nw;   /* a remainder can never want MORE than the whole did */
  };
  /* The covenant's acceptance test, as plain arithmetic. If this says false the node will reject
     the transaction, so it is worth asking before spending the proof-of-work. */
  P.covenantAccepts = function (locked, want, rem, minRem, pay, newWant) {
    locked = P.d(locked); want = P.d(want); rem = P.d(rem);
    minRem = P.d(minRem); pay = P.d(pay); newWant = P.d(newWant);
    return rem.lt(locked)                                   /* a partial must make progress */
      && rem.gte(minRem)                                    /* ...and respect the maker's dust floor */
      && newWant.mul(locked).gte(want.mul(rem))             /* the remainder keeps at least its pro-rata price */
      && newWant.lte(want)
      && pay.mul(locked).gte(want.mul(locked.sub(rem)));    /* the maker is paid at least pro-rata */
  };
  /* State port 6, the advertised price. It is DISPLAY ONLY — the covenant never reads it and
     P.order derives the real price from port 2 against the locked amount, because a taker can
     write anything here on a remainder. Defined as want-per-locked in every path (native
     PriceMath.price) so the same order reads the same way whoever last touched it, and rounded to
     PRICE_DP so a partial fill does not carry a 40-digit state value on chain. */
  P.portPrice = function (want, locked) {
    var l = P.d(locked);
    if (!l.gt(0)) return P.d(0);
    return P.d(want).div(l).toDecimalPlaces(P.PRICE_DP, Decimal.ROUND_HALF_UP);
  };
  P.SCRIPT_V5 = "LET u="+P.USDT+" IF (@TOKENID NEQ 0x00 AND @TOKENID NEQ u) OR (PREVSTATE(3) NEQ 0x00 AND PREVSTATE(3) NEQ u) THEN RETURN FALSE ENDIF IF SIGNEDBY(PREVSTATE(0)) THEN IF GETOUTADDR(@INPUT) EQ @ADDRESS THEN IF SAMESTATE(0 1) AND SAMESTATE(3 5) AND SAMESTATE(7 8) AND STATE(2) GT 0 AND VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) THEN RETURN TRUE ENDIF ENDIF IF VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF ENDIF IF @COINAGE GT 600 THEN RETURN VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) ENDIF LET w=PREVSTATE(2) LET r=0 IF @TOTOUT GT @INPUT+1 THEN IF GETOUTADDR(@INPUT+1) EQ @ADDRESS THEN LET r=GETOUTAMT(@INPUT+1) ENDIF ENDIF IF r EQ 0 THEN RETURN VERIFYOUT(@INPUT PREVSTATE(1) w PREVSTATE(3) FALSE) ENDIF RETURN r LT @AMOUNT AND r GTE PREVSTATE(8) AND VERIFYOUT(@INPUT+1 @ADDRESS r @TOKENID TRUE) AND SAMESTATE(0 1) AND SAMESTATE(3 5) AND SAMESTATE(7 8) AND STATE(2)*@AMOUNT GTE w*r AND STATE(2) LTE w AND GETOUTADDR(@INPUT) EQ PREVSTATE(1) AND GETOUTTOK(@INPUT) EQ PREVSTATE(3) AND GETOUTAMT(@INPUT)*@AMOUNT GTE w*(@AMOUNT-r)";
  P.script = "LET u="+P.USDT+" LET o=PREVSTATE(0) LET a=PREVSTATE(1) LET k=PREVSTATE(3) LET m=PREVSTATE(8) IF (@TOKENID NEQ 0x00 AND @TOKENID NEQ u) OR (k NEQ 0x00 AND k NEQ u) THEN RETURN FALSE ENDIF IF SIGNEDBY(o) THEN IF GETOUTADDR(@INPUT) EQ @ADDRESS THEN IF SAMESTATE(0 1) AND SAMESTATE(3 5) AND SAMESTATE(7 8) AND STATE(2) GT 0 AND VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) THEN RETURN TRUE ENDIF ENDIF IF VERIFYOUT(@INPUT a @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF ENDIF IF @COINAGE GT 600 THEN RETURN VERIFYOUT(@INPUT a @AMOUNT @TOKENID FALSE) ENDIF LET w=PREVSTATE(2) LET r=0 IF @TOTOUT GT @INPUT+1 THEN IF GETOUTADDR(@INPUT+1) EQ @ADDRESS THEN LET r=GETOUTAMT(@INPUT+1) ENDIF ENDIF IF r EQ 0 THEN RETURN VERIFYOUT(@INPUT a w k FALSE) ENDIF RETURN r LT @AMOUNT AND r GTE m AND VERIFYOUT(@INPUT+1 @ADDRESS r @TOKENID TRUE) AND STATE(0) EQ o AND STATE(1) EQ a AND STATE(3) EQ k AND STATE(4) EQ PREVSTATE(4) AND STATE(5) EQ PREVSTATE(5) AND STATE(7) EQ PREVSTATE(7) AND STATE(8) EQ m AND STATE(2)*@AMOUNT GTE w*r AND STATE(2) LTE w AND GETOUTADDR(@INPUT) EQ a AND GETOUTTOK(@INPUT) EQ k AND GETOUTAMT(@INPUT)*@AMOUNT GTE w*(@AMOUNT-r)";
})(PandaDEX);
