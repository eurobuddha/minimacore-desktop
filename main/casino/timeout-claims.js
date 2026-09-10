/* APK 0.7.1 Bet/TimeoutClaims policy. ES5 for MDS Rhino; byte-copied to desktop.
 * This module only discovers claims. It never signs or posts a transaction. */
var CasinoTimeouts = (function () {
  function state(coin, port) {
    var rows = coin.state || [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i].port) === String(port)) return String(rows[i].data);
    return "";
  }
  function integer(value, fallback) {
    var s = String(value == null ? "" : value).trim();
    return /^-?\d+$/.test(s) && isFinite(Number(s)) ? Number(s) : fallback;
  }
  function age(coin) { return integer(coin.age, -1); }
  function timeout(coin) { return integer(state(coin, 7), 1500); }
  function expired(coin) { return age(coin) >= 0 && age(coin) > timeout(coin); }
  function canClaim(coin, owns) {
    var phase = integer(state(coin, 6), 0);
    return !!state(coin, 0) && !!state(coin, 2) && expired(coin) &&
      ((phase === 1 && !!state(coin, 8) && owns(state(coin, 8))) || (phase === 2 && owns(state(coin, 0))));
  }
  function snapshot(coins, owns) {
    var ids = [], minima = 0, usd = 0;
    coins.forEach(function (coin) {
      if (!canClaim(coin, owns) || !coin.coinid || ids.indexOf(coin.coinid) >= 0) return;
      ids.push(coin.coinid);
      if (!coin.tokenid || String(coin.tokenid).toLowerCase() === "0x00") minima++; else usd++;
    });
    ids.sort();
    var currencies = minima ? minima + " Minima" : "";
    if (usd) currencies += (currencies ? " · " : "") + usd + " USD";
    return { ids: ids, minima: minima, usd: usd, summary: ids.length + " timeout claim" +
      (ids.length === 1 ? "" : "s") + " available (" + currencies + ")" };
  }
  function hasNew(current, previous) {
    return current.some(function (id) { return previous.indexOf(id) < 0; });
  }
  // Service owns reminder persistence. A failed scan must never be passed here.
  // MDS has no silent-notification option: foreground claims use the page banner;
  // removals do not sound another alert, and the final removal cancels it.
  function notifier(mds) {
    var busy = false;
    return function (claims, foreground) {
      if (busy) return;
      busy = true;
      mds.keypair.get("casino_timeout_claim_ids", function (r) {
        var previous = [];
        try { if (r && r.value) previous = JSON.parse(r.value); } catch (e) {}
        if (!Array.isArray(previous)) previous = [];
        try {
          if (!claims.ids.length) {
            mds.notifycancel();
            mds.keypair.set("casino_timeout_open", "0");
          } else if (foreground) { busy = false; return; }
          else if (hasNew(claims.ids, previous)) {
            mds.keypair.set("casino_timeout_open", "1");
            mds.notify(claims.summary + " — Open My Bets");
          }
          mds.keypair.set("casino_timeout_claim_ids", JSON.stringify(claims.ids), function () { busy = false; });
        } catch (e) { busy = false; }
      });
    };
  }
  return { state: state, age: age, timeout: timeout, expired: expired, canClaim: canClaim,
    snapshot: snapshot, hasNew: hasNew, notifier: notifier };
}());
