/* balance.js — the node's `balance` reply, parsed into the four figures that are actually distinct.
 *
 * WHY THIS EXISTS. The page used to keep two numbers per asset: `free` (sendable) and `confirming`,
 * where `confirming` was computed as confirmed − sendable and captioned "Funds from a recent trade
 * are still confirming." That was wrong twice over:
 *
 *   - confirmed − sendable is LOCKED, not confirming. It is money the node has fully confirmed but
 *     will not spend: coins sitting in a contract, or change from a transaction whose spend is not
 *     yet settled. Calling it "confirming" tells you to wait for something that is not coming.
 *   - the node reports a genuinely UNCONFIRMED figure of its own, and we never read it — so the one
 *     number that really does resolve by waiting was invisible.
 *
 * The node gives four independent figures and they must stay four (native AssetsTab.java, and
 * AtomiX's wallet card, both show all four):
 *
 *   sendable     spendable right now — the only number an order can be funded from
 *   confirmed    settled on chain, spendable or not
 *   locked       confirmed − sendable, floored at zero: settled but not spendable
 *   unconfirmed  seen but not yet settled — this is the one that becomes spendable by waiting
 *
 * `coins` matters too and is not decoration: one coin can fund one rung per block, so ten MINIMA in
 * a single coin builds a ladder far more slowly than ten MINIMA in ten coins. Native warns about
 * this before publishing; so do we.
 *
 * Ported from MainActivity.balanceMeta / AssetsTab.assetCard / appendUnavailable / makerFundingHint,
 * and covered by the same cases as native's BalanceDisplayTest.
 */
var PandaBalance = PandaBalance || {};
(function (B) {

  function d(v) {
    try { return PandaDEX.d(v === undefined || v === null || v === "" ? 0 : v); }
    catch (error) { return PandaDEX.d(0); }
  }

  /* The reply shape varies: `balance` returns an array of rows, `balance tokenid:x` a single
     object, and callers that have already picked a row pass the row itself. */
  B.row = function (input) {
    var resp;
    if (!input) return null;
    resp = (typeof input === "object" && input.response !== undefined) ? input.response : input;
    if (Object.prototype.toString.call(resp) === "[object Array]") return resp.length ? resp[0] : null;
    return (resp && typeof resp === "object") ? resp : null;
  };

  /* MainActivity.balanceMeta: a failed or incomplete read is unknown, never fresh zero. */
  B.meta = function(input, nowMs, expectedToken) {
    var out={sendable:d(0),confirmed:d(0),unconfirmed:d(0),coins:0,at:0}, resp, row, confirmed, sendable, unconfirmed, coins;
    if(!input || !PandaSafety.truthy(input.status) || (expectedToken&&!PandaSafety.hex(expectedToken)))return out;
    resp=input.response;
    if(Array.isArray(resp)) {
      if(!resp.length) { if(expectedToken&&!PandaDEX.eqTok(expectedToken,"0x00"))out.at=Number(nowMs||Date.now());return out; }
      if(resp.length!==1)return out;row=resp[0];
    } else row=resp;
    if(!row||typeof row!=="object" || (expectedToken&&!PandaDEX.eqTok(row.tokenid,expectedToken)))return out;
    confirmed=PandaSafety.balanceDecimal(row.confirmed);sendable=PandaSafety.balanceDecimal(row.sendable);
    unconfirmed=PandaSafety.balanceDecimal(row.unconfirmed===undefined?"0":row.unconfirmed);
    coins=PandaSafety.decimal(row.coins!==undefined?row.coins:row.coinamount!==undefined?row.coinamount:0);
    if(!confirmed||!sendable||!unconfirmed||!coins||confirmed.lt(0)||sendable.lt(0)||unconfirmed.lt(0)||coins.lt(0)||!coins.isInteger()||coins.gt(2147483647))return out;
    out.confirmed=confirmed;out.sendable=sendable;out.unconfirmed=unconfirmed;out.coins=coins.toNumber();out.at=Number(nowMs||Date.now());return out;
  };

  B.locked = function (meta) {
    var l;
    if (!meta) return d(0);
    l = d(meta.confirmed).sub(d(meta.sendable));
    return l.gt(0) ? l : d(0);
  };

  /* Compact, because it sits inside a one-line breakdown that must not wrap on a phone. */
  B.age = function (nowMs, atMs) {
    var sec, min;
    if (!atMs || atMs <= 0) return "never";
    sec = Math.max(0, Math.floor((Number(nowMs) - Number(atMs)) / 1000));
    if (sec < 60) return sec + "s ago";
    min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    return Math.floor(min / 60) + "h ago";
  };

  /* Native MainActivity.balanceMessage. A MiniDapp does not pair — it is installed and enabled or
     it is not — so native's paired/known pair collapses to one "the service has answered" flag.
     What must NOT collapse is loading vs failed: native 0.4.17 told a connected user to connect,
     and the review of that fix found 0.4.18, the same placeholder wrong in the other direction.
     A placeholder that does not follow the real state sends the user somewhere pointless. */
  B.message = function (ready, failed) {
    if (!ready) return "Connecting to MinimaCore…";
    return failed ? "Could not read this balance. Tap to retry." : "Loading balance from MinimaCore…";
  };

  B.line = function (meta, fmt, nowMs, ready, failed) {
    var SEP = "  ·  ";
    if(!meta || !meta.at)return B.message(ready, failed);
    return "confirmed " + fmt(meta.confirmed)
      + SEP + "locked ≈ " + fmt(B.locked(meta))
      + SEP + "unconfirmed " + fmt(meta.unconfirmed)
      + SEP + meta.coins + " coin" + (meta.coins === 1 ? "" : "s")
      + SEP + "updated " + B.age(nowMs, meta.at);
  };

  /* "you have 3 sendable (2 confirmed locked, 1 unconfirmed)" — says WHY the rest is unusable, so
     a shortfall next to a healthy total is not a mystery. */
  B.unavailable = function (meta, fmt) {
    var locked = B.locked(meta), unconf = d(meta.unconfirmed), parts = [];
    if (locked.gt(0)) parts.push(fmt(locked) + " confirmed locked");
    if (unconf.gt(0)) parts.push(fmt(unconf) + " unconfirmed");
    return parts.length ? " (" + parts.join(", ") + ")" : "";
  };

  /* One coin funds one rung per block, so fewer coins than rungs means a ladder that trickles. */
  B.fundingHint = function (nAsks, nBids, minimaCoins, usdtCoins, splitCount) {
    var lines = [];
    if (nAsks > 1 && minimaCoins > 0 && minimaCoins < nAsks)
      lines.push("MINIMA funding looks thin: " + minimaCoins + " coin" + (minimaCoins === 1 ? "" : "s")
        + " for " + nAsks + " ask rungs.");
    if (nBids > 1 && usdtCoins > 0 && usdtCoins < nBids)
      lines.push("MxUSD funding looks thin: " + usdtCoins + " coin" + (usdtCoins === 1 ? "" : "s")
        + " for " + nBids + " bid rungs.");
    if (!lines.length) return "";
    return lines.join("\n") + "\nUse Split funding coins first if you want more funding coins before publishing.";
  };

})(PandaBalance);
