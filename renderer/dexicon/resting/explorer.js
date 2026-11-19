/* explorer.js — optional third-party confirmation of a recorded fill. Port of native
 * ExplorerVerifier.java (0.3.9).
 *
 * The app's own trade record is built from what this node saw on-chain, which is the honest
 * source and the only one that works offline. This module exists purely so a user exporting an
 * accounting record can ALSO show a public explorer agreed the transaction exists. It is never
 * required, never blocks anything, and a failure to reach the explorer is reported as exactly
 * that — never as "the trade did not happen".
 *
 * The transport is injectable so the state machine is testable without a network.
 */
var PandaExplorer = PandaExplorer || {};
(function (E) {

  E.HOST = "explorer.minima.global";
  E.BASE = "https://explorer.minima.global/api/trpc/txpow.findById";
  E.TIMEOUT_MS = 15000;

  E.LOCAL_ONLY = "LOCAL_ONLY";
  E.OK = "EXPLORER_OK";
  E.NOT_FOUND = "EXPLORER_NOT_FOUND";
  E.ERROR = "EXPLORER_ERROR";
  E.http = function (code) { return "EXPLORER_HTTP_" + code; };

  /* A txpowid is node-derived hex, but it ends up inside a URL. Refuse anything that is not
     plainly hex rather than escaping it — an id that fails this is a bug, not a request. */
  E.validId = function (id) { return /^0x[0-9A-Fa-f]{2,128}$/.test(String(id || "")); };

  E.url = function (txpowid) {
    return E.BASE + "?batch=1&input=" + encodeURIComponent(JSON.stringify({"0":{json:{id:String(txpowid)}}}));
  };

  /* Classify a reply into one of the five states. Pure. */
  E.classify = function (status, body) {
    var parsed, entry, result;
    if (status === 0) return {status:E.ERROR, note:"Could not reach the explorer"};
    if (status === 404) return {status:E.NOT_FOUND, note:"The explorer does not have this transaction"};
    if (status < 200 || status >= 300) return {status:E.http(status), note:"The explorer replied " + status};
    try { parsed = typeof body === "string" ? JSON.parse(body) : body; } catch (error) { return {status:E.ERROR, note:"The explorer reply could not be read"}; }
    entry = Array.isArray(parsed) ? parsed[0] : parsed;
    result = entry && entry.result && entry.result.data;
    if (result && result.json !== undefined) result = result.json;
    if (entry && entry.error) return {status:E.ERROR, note:"The explorer reported an error"};
    if (!result) return {status:E.NOT_FOUND, note:"The explorer does not have this transaction"};
    return {status:E.OK, note:"Confirmed present on " + E.HOST};
  };

  /* Default transport. Replaced wholesale in tests. */
  E.request = function (url, done) {
    var xhr, settled = false, timer;
    function finish(status, body) { if (settled) return; settled = true; if (timer) clearTimeout(timer); done(status, body); }
    try {
      xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.onreadystatechange = function () { if (xhr.readyState === 4) finish(Number(xhr.status) || 0, xhr.responseText); };
      xhr.onerror = function () { finish(0, ""); };
      /* A request that never calls back would leave the row spinning forever. */
      timer = setTimeout(function () { try { xhr.abort(); } catch (ignore) {} finish(0, ""); }, E.TIMEOUT_MS);
      xhr.send();
    } catch (error) { finish(0, ""); }
  };

  E.verify = function (txpowid, done) {
    if (!E.validId(txpowid)) return done({status:E.LOCAL_ONLY, note:"No transaction id was recorded for this fill"});
    E.request(E.url(txpowid), function (status, body) { done(E.classify(status, body)); });
  };

})(PandaExplorer);
