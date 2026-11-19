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
 */
const SIGNING = /^\s*(send|sendpoll|txnsign|consolidate|tokencreate|multisig|sendsign|txnpost\s+[^;]*\bauto:true)\b/i;

function createNodeRunner(raw, opts = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  const onSign = opts.onSign || (() => {});

  function run(command, rawForCall) {
    const call = rawForCall || raw;
    const c = String(command);
    // a `;`-chained command signs if any part does (a `;` inside a quoted script only over-serialises: harmless)
    if (!c.split(";").some((part) => SIGNING.test(part))) return call(c);
    waiting++;
    const job = tail.then(() => { waiting--; onSign(c); return call(c); });
    tail = job.then(() => {}, () => {});   // a failed signing command never blocks the next one
    return job;
  }
  return { run, signing: (c) => String(c).split(";").some((part) => SIGNING.test(part)), queued: () => waiting };
}

module.exports = { createNodeRunner, SIGNING };
