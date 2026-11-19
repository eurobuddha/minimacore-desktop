/* signlock.js — MiniDapp-wide serial signing gate. Service-only; the page never signs.
 *
 * WHY THIS EXISTS (carried across from the native SignGate.java, because the reason will not
 * survive a refactor otherwise):
 *
 *   Minima signatures are stateful. Each key is a tree of one-time (Winternitz) signatures and the
 *   node picks the next leaf by reading, incrementing and writing a per-key `uses` counter. Two
 *   transactions signing the same key at once both read the same value and both sign the SAME leaf
 *   over DIFFERENT data — a reused one-time signature, which leaks that leaf's private key. This is
 *   not theoretical: 7 of 64 default keys on a live node were confirmed re-used, witness-exact.
 *
 * TWO RULES FOR ANYONE EDITING THIS FILE. Both were learned by shipping outages.
 *
 *   1. NO TIMERS. The MDS service is Rhino: ServiceJSRunner builds the scope with
 *      ctx.initStandardObjects() and injects only `MDS`. There is no setTimeout, no setInterval, no
 *      XMLHttpRequest. An earlier version called setInterval to start a heartbeat; it threw
 *      ReferenceError before the work function ever ran, and the app could not sign or post
 *      ANYTHING from 0.2.33 to 0.3.7. Date.now() is available; everything time-based rides
 *      L.tick(), which the service calls on each NEWBLOCK.
 *
 *   2. NO SQL, AND NO HOST METHODS HELD BY REFERENCE. This file used to keep a durable lock row via
 *      `PandaSignLock.use(MDS.sql)`. Storing `MDS.sql` DETACHES a Java method: Rhino then calls it
 *      with the wrong `this` and the bridge refuses —
 *        Java method "sql" was invoked with [object Object] as "this" value
 *      — so every claim threw and, again, nothing could be signed. A host method must always be
 *      called as a property of its owner.
 *
 * The SQL layer is gone rather than repaired, because it was guarding against something this app
 * does not have. It existed to stop two CONTEXTS signing at once; the page does not load this file
 * and never signs. Native's SignGate is a plain in-process queue with no database at all, so this
 * is now exactly native's design — and five SQL round-trips per transaction have left the critical
 * path with it. It was inherited from pandapools-mds, which genuinely needs it because its page
 * does sign. Copying it here was the mistake.
 *
 * What remains is the part that earns its place: one queue held until the owning operation completes. A timeout is not completion.
 */
var PandaSignLock = PandaSignLock || {};
(function (L) {

  /* Compatibility constant only. Elapsed time never releases an active signing operation. */
  L.MAX_HOLD_MS = 200 * 1000;

  var QUEUE = [], ACTIVE = null, TOKEN = 0;

  L.busy = function () { return !!ACTIVE; };
  L.queued = function () { return QUEUE.length; };
  /* Test hook only. Drops queued work and forgets the active holder. */
  L.reset = function () { QUEUE = []; ACTIVE = null; };
  /* Kept so older callers do not break; there is no longer anything to inject. */
  L.use = function () {};

  function now() { return Date.now(); }

  /* Queue a signing operation. `work` is called with a release whose free() it MUST call exactly
     once, however the chain ends — success, validation failure, post rejection or transport error.
     NOT RE-ENTRANT: gating something that itself reaches T.checkPost self-deadlocks. Gate at
     exactly one level — currently T.checkPost and the bare `send` paths. */
  L.gate = function (prefix, work, onBlocked) {
    QUEUE.push({ prefix: prefix || "sign", work: work, onBlocked: onBlocked || null });
    pump();
  };

  function pump() {
    var job, rel;
    if (ACTIVE) return;
    job = QUEUE.shift();
    if (!job) return;
    TOKEN++;
    ACTIVE = { token: TOKEN, startedAt: now() };
    rel = makeRelease(TOKEN);
    /* A throw can occur after a node write was dispatched. Only the owner knows whether
       completion is established; elapsed time or a local exception cannot release it. */
    job.work(rel);
  }

  /* Idempotent, and identified by token so a LATE release cannot free somebody else's lock. An
     earlier version compared nothing: a job whose callback arrived after its watchdog had fired
     would clear the CURRENT holder and start a third job alongside it — two chains signing at
     once, the exact hazard this file exists to prevent. */
  function makeRelease(token) {
    var freed = false;
    return { free: function () {
      if (freed) return;
      freed = true;
      if (!ACTIVE || ACTIVE.token !== token) { pump(); return; }
      ACTIVE = null;
      pump();
    } };
  }

  /* Called by the service on every NEWBLOCK. The only clock this file has. */
  L.tick = function () {
    if (!ACTIVE) { pump(); return; }
    /* The active operation remains held until its own completion, as in native SerialQueue. */
  };

})(PandaSignLock);
