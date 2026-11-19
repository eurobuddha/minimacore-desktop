/**
 * noderun.js — the ONE node-command runner every engine shares. Copied from DexiconPro (main/noderun.js); here
 * main/rpc.js puts it under rpcCall itself, so AtomiX, PandaPools, miniMall, Vestr, Mail, Chat, the Web Wallet and the
 * wallet's own sends all pass the same gate without each having to opt in.
 *
 * SIGNING IS SERIALISED, PROCESS-WIDE. Minima signs with one-time Winternitz leaves: two signatures with the same key
 * at the same moment can make the node hand out the SAME leaf for two different transactions, which leaks that leaf's
 * private key (proven on a live node — the reason PandaDEX/Dexicon have their SignGate). Each engine already serialises
 * its own signing; with three engines on one node, only a gate here makes it true for the whole app. Every command that
 * signs waits for the previous one to finish; reads run freely in parallel.
 *
 * WHAT IS IN THE PATTERN (checked against the node's command sources: every command that reaches Wallet.signData):
 * send, sendpoll, sendsign, txnsign, sign, multisig, tokencreate, consolidate, txnauto (it runs txnsign when sign:true)
 * and txnpost with burn: (a burn is its own transaction, signed with a wallet key). Two more are serialised although
 * they take no wallet leaf, which costs nothing: signfrom (it signs with a key the caller supplies) and txnpost
 * auto:true (in the node source it only attaches scripts and proofs; kept from the DexiconPro pattern).
 * LEFT OUT ON PURPOSE: sendfrom (main/webwallet.js durably reserves that key's uses before it signs, and the key is
 * not a wallet key), plain txnpost, and sendnosign / sendview / sendpost / txncreate and the other builders (no signature).
 *
 * A SIGNER THE NODE MAY STILL BE RUNNING HOLDS THE QUEUE. A signing call that fails with a timeout or a dropped
 * connection has not necessarily stopped inside the node. Releasing the queue then would let the next signer overlap
 * it. So after such a failure (opts.lost says which) the queue is held until a cheap read (`block`) answers, asked
 * again after a pause, for at most maxHoldMs; then it is released with a loud log line. A `status:false` reply and a
 * clean rejection release at once.
 *
 * A QUEUED SIGNER ITS CALLER GAVE UP ON IS NEVER SENT. run(command, raw, { signal }): if the signal is aborted by the
 * time the entry reaches the head of the queue, it is rejected there and the node never sees it.
 */
const SIGNING = /^\s*(?:(?:send|sendpoll|sendsign|txnsign|txnauto|sign|signfrom|consolidate|tokencreate|multisig)\b|txnpost\s+[^;]*\b(?:auto:true\b|burn:))/i;
const signs = (command) => String(command).split(";").some((part) => SIGNING.test(part));
const verb = (command) => (/^\s*(\w+)/.exec(String(command)) || [])[1] || "?";   // never log a whole command: it can carry a private key

function createNodeRunner(raw, opts = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  const onSign = opts.onSign || (() => {});
  const lost = opts.lost || (() => false);
  const pauseMs = opts.pauseMs == null ? 5000 : opts.pauseMs;
  const maxHoldMs = opts.maxHoldMs == null ? 10 * 60 * 1000 : opts.maxHoldMs;
  const warn = opts.warn || ((line) => console.error("[signing queue]", line));

  // Never rejects. Returns when the node has answered a read, when it is plainly not there, or at the bound.
  async function hold(call, c, e) {
    if (!e || e.dropped || !lost(e)) return;
    warn("held: `" + verb(c) + "` failed (" + e.message + ") and the node may still be signing; waiting for it to answer");
    const until = Date.now() + maxHoldMs;
    for (;;) {
      try { await call("block"); return; } catch (pe) { if (!lost(pe)) return; }
      if (Date.now() >= until) { warn("RELEASED WITHOUT AN ANSWER after " + Math.round(maxHoldMs / 1000) + " s: the next signing command may overlap `" + verb(c) + "`"); return; }
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }

  function run(command, rawForCall, o) {
    const call = rawForCall || raw;
    const c = String(command);
    // a `;`-chained command signs if any part does (a `;` inside a quoted script only over-serialises: harmless)
    if (!signs(c)) return call(c);
    const signal = o && o.signal;
    waiting++;
    const job = tail.then(() => {
      waiting--;
      if (signal && signal.aborted) throw Object.assign(new Error("not sent: `" + verb(c) + "` was still queued when its caller gave up"), { dropped: true });
      onSign(c); return call(c);
    });
    tail = job.then(() => {}, (e) => hold(call, c, e));
    return job;
  }
  return { run, signing: signs, queued: () => waiting };
}

module.exports = { createNodeRunner, SIGNING };
