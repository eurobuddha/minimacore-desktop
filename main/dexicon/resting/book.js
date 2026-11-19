var PandaBook = PandaBook || {};
(function (B, P) {
  B.parse = function (coins) { var out=[], i,o; for(i=0;i<(coins||[]).length;i++){o=P.order(coins[i]);if(o)out.push(o);} return out; };
  B.MIN_SLICE_BLOCKS = 12;
  B.half = function (w) { return Math.max(B.MIN_SLICE_BLOCKS, Math.floor(w / 2)); };
  /* cb(found, incomplete). There is no error argument: a window that cannot be read degrades to
     a narrower one and, failing that, is skipped with `incomplete` set — the scan as a whole
     always returns whatever it managed to see. */
  /* Both covenants (V6 new orders, V5 until its coins are gone), one after the other into one book. */
  B.scan = function (cmd, cb) {
    var found = [], seen = {}, incomplete = false;
    (function next(i) {
      if (i >= P.ADDRS.length) return cb(found, incomplete);
      B.slice(cmd, function (f, inc) { incomplete = incomplete || inc; next(i + 1); }, found, seen, 0, P.SCAN_DEPTH, false, false, P.SCAN_DEPTH, P.ADDRS[i]);
    })(0);
  };
  B.slice = function(cmd, cb, found, seen, fromAge, width, incomplete, probed, full, addr) {
    var depth;
    if (fromAge >= P.SCAN_DEPTH) return cb(found, incomplete);
    depth = Math.min(fromAge + width, P.SCAN_DEPTH);
    /* SECURITY (review 7 Nov, 0.4.24): ask for the state ARRAY. A filler can append a second entry for any port to the
       remainder; the covenant binds the FIRST (KISS getPrevState) and P.state returns the first, but simplestate keeps
       the LAST - so the book (and the owner's cancel/relock/collect) would be built from values the script refuses. */
    cmd("coins order:desc address:"+(addr||P.ADDR)+" coinage:"+fromAge+" depth:"+depth, function (r) {
      var rows, parsed, i, o;
      if (r && r.status && Array.isArray(r.response)) {
        rows = r.response;
        /* An MDS reply over the ~256KB cap comes back EMPTY rather than erroring, so a wide window
           returning nothing is ambiguous: genuinely empty, or too large to send. Believing it
           blindly silently drops every order in that range — and the tape then reads those as
           vanished. Halve once and ask again. `probed` bounds this to one extra call per region so
           a sparse book does not become 80 sequential queries. */
        if (rows.length === 0 && !probed && width > B.MIN_SLICE_BLOCKS)
          return B.slice(cmd, cb, found, seen, fromAge, B.half(width), incomplete, true, full, addr);
        parsed = B.parse(rows);
        for (i = 0; i < parsed.length; i++) { o = parsed[i]; if (!seen[o.coinid]) { seen[o.coinid] = true; found.push(o); } }
        /* A confirmed-empty region says nothing about the node's capacity, so restore the full
           window; a window narrowed by a real failure stays narrow. */
        return B.slice(cmd, cb, found, seen, depth, probed ? full : width, incomplete, false, full, addr);
      }
      if (width > B.MIN_SLICE_BLOCKS) return B.slice(cmd, cb, found, seen, fromAge, B.half(width), incomplete, probed, full, addr);
      B.slice(cmd, cb, found, seen, depth, width, true, false, full, addr);
    });
  };
  B.plan = function (book, buy, amount, limit, block) {
    var side=[],i,o,remaining=P.d(amount), takes=[], totalMin=P.d(0), totalUsdt=P.d(0), expiryMargin=30;
    for(i=0;i<book.length;i++){o=book[i]; if(o.fillable===false || o.sell!==buy || (block-o.created)>P.EXPIRY-expiryMargin)continue; if(limit && (buy?o.price.gt(limit):o.price.lt(limit)))continue; side.push(o);}
    side.sort(function(a,b){return buy?a.price.cmp(b.price):b.price.cmp(a.price);});
    for(i=0;i<side.length && takes.length<P.MAX_ORDERS && remaining.gt(0);i++){
      o=side[i]; var avail=o.minima, take=remaining.gte(avail)?avail:remaining, partial=take.lt(avail), lockedTake=o.sell?take:P.up(take.mul(o.price),P.DP), rem=o.locked.sub(lockedTake);
      /* Shrink the take so the order keeps at least its minimum remainder. `rem` MUST be
         recomputed here: it is what txn.js writes as the covenant's remainder output and what the
         new want is derived from, so leaving the pre-clamp value builds a transaction whose
         amounts do not balance and whose remainder is below the floor the covenant enforces —
         rejected on-chain, every time, after paying for the proof-of-work. */
      if(partial && rem.lt(o.minRem)){ lockedTake=o.locked.sub(o.minRem); take=o.sell?lockedTake:P.down(lockedTake.div(o.price),P.DP); if(!take.gt(0))break; rem=o.locked.sub(lockedTake); partial=true; }
      var pay=partial?P.up(o.wantAmt.mul(lockedTake).div(o.locked),P.DP):o.wantAmt;
      /* Against a BUY order the taker delivers MINIMA, and what it actually delivers is `pay` —
         ceiled the maker way — not `take`, which was floored. Reporting `take` understated the
         spend by a grain per fill, so the "rest as a limit order" remainder came out too large. */
      if(!o.sell) take=pay;
      takes.push({order:o,minima:take,partial:partial,lockedTake:lockedTake,pay:pay,remainder:rem}); totalMin=totalMin.add(take); totalUsdt=totalUsdt.add(o.sell?pay:lockedTake); remaining=remaining.sub(take); if(partial)break;
    }
    return {takes:takes,totalMinima:totalMin,totalUsdt:totalUsdt,average:totalMin.gt(0)?totalUsdt.div(totalMin):P.d(0)};
  };
})(PandaBook,PandaDEX);
