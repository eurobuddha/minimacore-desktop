/*
 * paylabel.js — what a payment MESSAGE may say (0.19.7). Shared by Mail and Chat (renderer) and by the main process.
 *
 * A payment message is the sender's claim: anyone can send one with no payment behind it, or pay one unit of a
 * worthless token they named "MxUSD". So:
 *  - the currency is named from the TOKEN ID only (0x00 = MINIMA, the one MxUSD id = MxUSD). Any other id is
 *    "another token", shown with its WHOLE id; the sender's name for it is never shown.
 *  - a received payment is "not verified" until this node has found the transaction on chain paying this wallet that
 *    amount of that token (main/payverify.js). Only then does a bubble say "sent you" and "Received".
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");   // loaded by a test or the main process: the same t(), th(), tr() the window has
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.PayLabel = make(); })(this, function () {
  "use strict";
  var MINIMA = "0x00", MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  function token(tokenid) {
    var id = String(tokenid == null ? "" : tokenid).trim();
    if (id === MINIMA) return { known: true, name: "MINIMA", id: MINIMA };
    if (id.toUpperCase() === MXUSD.toUpperCase()) return { known: true, name: "MxUSD", id: MXUSD };
    return { known: false, name: "another token", id: id };
  }
  /** One identity for a claimed payment: what is asked of the node and what the answer is kept under. */
  function key(txid, tokenid, amount) { return (String(txid || "") + "|" + String(tokenid || "") + "|" + String(amount || "")).toLowerCase(); }
  /**
   * The words of a payment bubble. p = { incoming, who, amount, tokenid, status } with status "received" (found by
   * this node) or anything else (not found, or not looked for yet).
   * -> { head, amount, token, tokenLine, state, verified }   plain text, not escaped
   */
  function describe(p) {
    var t = token(p.tokenid), ok = p.status === "received";
    return {
      head: !p.incoming ? I18N.t("You sent") : (p.who || I18N.t("They")) + (ok ? " sent you" : " says they sent you"),
      amount: String(p.amount == null ? "" : p.amount), token: t.name,
      tokenLine: t.known ? "" : (t.id ? I18N.t("Token id: {id}", { id: t.id }) : I18N.t("No token id was given")),
      state: !p.incoming ? "" : ok ? I18N.t("Received: this node found the payment to this wallet on chain")
        : I18N.t("Not verified: this node has not found this payment. Check your balance before relying on it."),
      verified: !p.incoming || ok
    };
  }
  /** One line for a list row or a notification. Never the token id (a row is cut short; the bubble has it whole). */
  function preview(p) {
    var t = token(p.tokenid), what = String(p.amount == null ? "" : p.amount) + (t.known ? " " + t.name : " of another token");
    return !p.incoming || p.status === "received" ? what : I18N.t("Payment notice, not verified: {what}", { what: what });
  }
  return { MINIMA: MINIMA, MXUSD: MXUSD, token: token, key: key, describe: describe, preview: preview };
});
