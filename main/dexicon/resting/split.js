/* split.js — the maker funding-split tool. Port of native SelfSplit.java (0.3.9).
 *
 * A ladder rung is one on-chain transaction, and each rung's change has to confirm before the
 * next rung on that side can be funded from it. With a single fat wallet coin that serialises the
 * whole ladder: one rung per side per cycle, minutes to build, and rungs retrying while they wait.
 * Splitting the funding coin into N pieces first gives each side a queue of independent coins to
 * draw on, so the ladder builds as fast as blocks arrive rather than as fast as change confirms.
 *
 * It is a plain wallet self-send. It still signs, so it still goes through the signing gate.
 */
var PandaSplit = PandaSplit || {};
(function (S, P) {

  S.COUNT = 10;

  /* Pure, so the exact command is testable. Native puts tokenid before split, and omits it
     entirely for MINIMA — `send tokenid:0x00` is not the same request as `send` with no token. */
  S.command = function (address, tokenid, amount) {
    return "send address:" + address + " amount:" + P.plain(amount)
      + (P.eqTok(tokenid, "0x00") ? "" : " tokenid:" + tokenid)
      + " split:" + S.COUNT;
  };

  S.run = function (cmd, address, tokenid, amount, done) {
    var value = P.d(amount);
    if (!address) return done("No wallet address to split into");
    if (!value.gt(0)) return done("Enter an amount to split");
    PandaSignLock.gate("split", function (release) {
      cmd(S.command(address, tokenid, value), function (result) {
        release.free();
        if (!result || (!result.status && !result.pending)) return done((result && result.error) || "The split was not accepted");
        done(null, result.response && result.response.txpowid);
      });
    });
  };

})(PandaSplit, PandaDEX);
