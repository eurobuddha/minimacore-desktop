/*
 * restore.js — the rules for putting ANOTHER wallet into this node: a backup file (megammrsync file: / restore).
 *
 * A backup file carries its wallet's keys as they are, in the key mode they were made in, while this install
 * keeps its own recorded mode (main/keymode.js): a block backup restored into a classic install is the forbidden
 * mix. The file itself cannot say which it is: after an 8-byte salt and an IV everything in it is AES-encrypted
 * under the backup password (upstream backup.java), so the mode is ASKED, and checked here in the main process.
 * No electron: scripts/restore-test.cjs runs it.
 *
 * Replacing the wallet (a backup file, or megammrsync phrase:) also resets every identity derived from it. Two
 * rules for that: it is refused while work that needs the old keys is open (activeWorkList), and no store is
 * ever deleted for it, only moved aside under a dated name (moveAside).
 */
const fs = require("fs");

/** Why a backup of this key mode may not be restored into this install ("" = it may). */
function backupModeProblem(picked, recorded, supported) {
  if (picked !== "classic" && picked !== "block") return "Choose which kind of wallet made this backup.";
  if (recorded !== "classic" && recorded !== "block") return "No wallet has been set up yet. Choose New Wallet or Restore Wallet first.";
  if (picked === "block" && !supported)
    return "This backup holds a block key wallet, and the node in this version of the app runs classic keys only. Restoring it here would put block keys into a node that goes on making classic ones, and the two kinds would be mixed for good. Nothing was changed.\n\nWhat you can do: keep using that wallet in the app that made it (for example Pandamonium on the phone), or send its funds from there to an address of this wallet (Receive). Typing its 24 words in here would not bring it over: the same words give a different, empty wallet with classic keys.";
  if (picked !== recorded)
    return "This install holds a " + recorded + " key wallet, and that cannot be changed. This backup holds a " + picked + " key wallet, so restoring it here would mix the two kinds of key for good. Nothing was changed.\n\nWhat you can do: restore it in a fresh install of the app, or send its funds to an address of this wallet from the app that made it.";
  return "";
}

/** megammrsync for a backup file, or { error }. The node's command parser has no escape character, so refusing a value is the only defence. */
function restoreFileCommand(o) {
  const host = String((o && o.host) || "").trim(), file = String((o && o.file) || "").trim(), password = String((o && o.password) || "");
  if (!/^[\w.\-]+:\d+$/.test(host)) return { error: "MegaMMR host must be host:port." };
  if (!file) return { error: "Enter the backup file's name or path." };
  if (/[\s"\\]/.test(file)) return { error: "File path can't contain spaces or quotes." };
  if (/[\s"\\]/.test(password)) return { error: "Password can't contain spaces or quotes." };
  // The node reads ; as the end of a command: the rest of the value would be run as a second command and the restore would fail on half a name.
  if (file.includes(";")) return { error: "The file path contains a semicolon (;), which the node reads as the end of the command. Rename the file or move it, then try again." };
  if (password.includes(";")) return { error: "The password contains a semicolon (;), which the node reads as the end of the command, so this app cannot pass it. Restore this backup from the node's own command line." };
  let cmd = `megammrsync action:resync host:${host} file:${file}`;
  if (password) cmd += ` password:${password}`;
  return { cmd };
}

/** Is this node command (or any ;-separated part of it) a megammrsync resync, which ends by shutting the node down? */
function isResync(command) {
  return String(command || "").split(";").some(part => /^\s*megammrsync(\s|$)/i.test(part) && /\saction:resync(\s|$)/i.test(part));
}
/** Why a `backup` command may not be sent ("" = it may): the password must be letters and numbers only, the rule the screen applies. A quote closed password:"…" early, so the node encrypted under a different password than the one typed. */
function backupCommandProblem(command) {
  // a ; straight after the value would cut the password short: the node would encrypt under the part before it
  if (/^\s*backup\s[^;]*\s?(password|confirm):[^\s;]*;/i.test(String(command || ""))) return "A backup password can hold letters and numbers only.";
  for (const part of String(command || "").split(";")) {
    if (!/^\s*backup(\s|$)/i.test(part)) continue;
    for (const m of part.matchAll(/\s(password|confirm):(\S*)/gi))
      if (!/^("[A-Za-z0-9]+"|[A-Za-z0-9]+)$/.test(m[2])) return "A backup password can hold letters and numbers only.";
  }
  return "";
}

/** Does this node command (or any ;-separated part of it) replace the wallet from a seed phrase? */
function replacesWalletFromPhrase(command) {
  return String(command || "").split(";").some(part => /^\s*megammrsync(\s|$)/i.test(part) && /\sphrase:/i.test(part));
}

/**
 * Move a store aside, never delete it: <file>-legacy-keys-YYYYMMDD (a second one on the same day gets -2, -3 …).
 * Returns the new path, or "" when there was no file. The old wallet's swaps, preimages and mail stay on disk.
 */
function moveAside(file, now) {
  if (!fs.existsSync(file)) return "";
  const d = now || new Date(), ymd = "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  let to = file + "-legacy-keys-" + ymd;
  for (let n = 2; fs.existsSync(to); n++) to = file + "-legacy-keys-" + ymd + "-" + n;
  fs.renameSync(file, to);
  return to;
}

/**
 * What replacing the wallet would strand, each in plain words ([] = nothing). r holds what the existing read
 * models said: atomix = main/atomix.js activeWork() (null = it could not be asked), pools = PandaPools activity
 * rows (null = could not be read), casino = { offers, bets } or null, dexicon = main/dexicon.js activeWork()
 * (undefined = not asked). Identifiers are given in full.
 */
const DEX_STUCK_MS = 120000;
/** Said with a Dexicon check that cannot be made. The screens offer the way on when this is all that is left. */
const DEX_SKIP_HINT = "If it stays like this, you can go on without this check.";
/** Said with a warning that is not a refusal: the user reads it and may go on (0.18.137: this wallet's own live pools). */
const CONFIRM_HINT = "You can go on after confirming this.";
/** What is said of this wallet's own pools before another wallet is put in their place. */
const OWN_POOLS_WARNING = "These pools belong to the wallet you are replacing. Their funds can only be withdrawn by that wallet. Close them first, or make sure you have its 24 words and a pool backup.";
const SAME_WALLET_NOTE = "The app cannot tell beforehand which wallet you are restoring. If it is this same wallet (the same 24 words), nothing changes for your pools: the wallet is compared before and after, and everything is kept in place.";
function activeWorkList(r) {
  const out = [], ax = r && r.atomix, plural = (n, one) => n + " " + one + (n === 1 ? "" : "s");
  // 0.18.137: a check that can NEVER be made must not block a restore for ever, for AtomiX and PandaPools as for
  // Dexicon (0.18.110). A store that could not be opened (a damaged file fails on every start), or an engine still not
  // started after two minutes, is named exactly, and the user may then go on by a deliberate confirm (r.skipDexicon,
  // which since 0.18.137 leaves out every line that ends in a hint, not only Dexicon's). The store is moved aside, never deleted.
  const skip = !!(r && r.skipDexicon), mins = (ms) => Math.floor(Number(ms) / 60000);
  if (!ax) out.push("AtomiX could not be asked whether a swap is in flight. Wait a moment and try again.");
  // 0.19.101: AtomiX is not READY but its store is open, and the store names unfinished swaps (main/atomix.js
  // storeSwaps). That is a refusal like any swap in flight, with no way past it: not "cannot be checked".
  else if (!ax.ready && Array.isArray(ax.swaps) && ax.swaps.length)
    out.push(plural(ax.swaps.length, "AtomiX swap") + " still in flight, read from AtomiX's store while AtomiX itself has not finished starting (the app holds what is needed to claim or refund " + (ax.swaps.length === 1 ? "it" : "them") + "): " + ax.swaps.join(", "));
  else if (!ax.ready) {
    if (ax.hasStore && ax.error) { if (!skip) out.push("AtomiX could not open its swap store (" + ax.error + "), so whether a swap is in flight, or a maker order or an OTC deal is open, cannot be checked. " + DEX_SKIP_HINT); }
    else if (ax.hasStore && Number(ax.waitedMs) >= DEX_STUCK_MS) { if (!skip) out.push("AtomiX has not finished starting after " + mins(ax.waitedMs) + " minutes, so whether a swap is in flight, or a maker order or an OTC deal is open, cannot be checked. " + DEX_SKIP_HINT); }
    else if (ax.hasStore) out.push("AtomiX has not finished starting, so its swaps could not be checked. Wait a moment and try again.");
  }
  else {
    if (ax.swaps && ax.swaps.length) out.push(plural(ax.swaps.length, "AtomiX swap") + " still in flight (the app holds what is needed to claim or refund " + (ax.swaps.length === 1 ? "it" : "them") + "): " + ax.swaps.join(", "));
    if (ax.maker) out.push("A live AtomiX maker order. Withdraw it in AtomiX first.");
    if (ax.otcOffer) out.push("A live AtomiX OTC offer. Withdraw it first.");
    if (ax.otcDeals) out.push(plural(ax.otcDeals, "AtomiX OTC deal") + " still open.");
  }
  const ps = (r && r.poolsState) || {};
  if (r && r.pools === null) {
    const what = ", so whether a pool transaction is still waiting, and which pools this wallet owns, cannot be checked. ";
    if (ps.error) { if (!skip) out.push("PandaPools could not open its pool store (" + ps.error + ")" + what + DEX_SKIP_HINT); }
    else if (Number(ps.waitedMs) >= DEX_STUCK_MS) { if (!skip) out.push("PandaPools has not finished starting after " + mins(ps.waitedMs) + " minutes" + what + DEX_SKIP_HINT); }
    else out.push("PandaPools could not be asked whether a pool transaction is still waiting. Wait a moment and try again.");
  }
  // This wallet's own pools that are not put away (main/pandapools.js ownPools): not a refusal, a warning to confirm.
  const own = (r && r.ownPools) || [];
  if (own.length && !skip) out.push(plural(own.length, "PandaPools pool") + " of this wallet " + (own.length === 1 ? "is" : "are") + " still open: "
    + own.map(p => p.address + " (" + (p.reserveM == null ? "its reserves are not visible to this node just now" : p.reserveM + " MINIMA and " + p.reserveT + " " + p.token) + ")").join(", ")
    + ". " + OWN_POOLS_WARNING + " " + SAME_WALLET_NOTE + " " + CONFIRM_HINT);
  const waiting = ((r && r.pools) || []).filter(x => x && x.txpowid && x.confirmed === false && !x.failed);
  if (waiting.length) out.push(plural(waiting.length, "PandaPools transaction") + " still waiting to confirm: " + waiting.map(x => x.txpowid).join(", "));
  // Dexicon (main/dexicon.js activeWork). undefined = not asked (the engine is not part of this caller); null = it could not be asked.
  const dx = r && r.dexicon;
  // A Dexicon that cannot be checked must not block a restore for ever (0.18.110): a damaged store or an engine that
  // never becomes ready is named, and after two minutes of it (or at once when it could not be asked at all) the
  // user may go on (r.skipDexicon: main.js, after the screen's warning). The store is moved aside as always.
  if (dx === null) { if (!skip) out.push("Dexicon could not be asked whether an order or a trade is still open; its store may be damaged. " + DEX_SKIP_HINT); }
  else if (dx && !dx.ready) {
    if (dx.hasStore && !skip) out.push(Number(dx.waitedMs) >= DEX_STUCK_MS ? "Dexicon has not finished starting after " + Math.floor(dx.waitedMs / 60000) + " minutes, so its on-chain orders and its trades waiting for an answer cannot be checked. " + DEX_SKIP_HINT
      : "Dexicon has not finished starting, so its orders could not be checked. Wait a moment and try again.");
  }
  else if (dx) {
    if (dx.orders && dx.orders.length) out.push(plural(dx.orders.length, "Dexicon order") + " still on the chain, which only this wallet's keys can cancel or collect. Cancel " + (dx.orders.length === 1 ? "it" : "them") + " first: " + dx.orders.join(", "));
    if (dx.pending) out.push(plural(dx.pending, "Dexicon order") + " still waiting for a block.");
    if (dx.takes) out.push(plural(dx.takes, "Dexicon trade") + " sent and not yet answered. Wait for " + (dx.takes === 1 ? "it" : "them") + " to settle (a few minutes).");
  }
  // Future Cash Next (main/futurecash.js activeWork). undefined = not asked; null = it could not be asked (refused).
  const fc = r && r.futurecash;
  if (fc === null) out.push("Future Cash Next could not be asked whether a collect or a sweep is still under way. Wait a moment and try again.");
  else if (fc && !fc.ready) {
    if (fc.hasStore && fc.error) { if (!skip) out.push("Future Cash Next could not open its store (" + fc.error + "), so whether a collect or a sweep is still under way cannot be checked. " + DEX_SKIP_HINT); }
    else if (fc.hasStore) out.push("Future Cash Next has not started (or is frozen), so its collects and sweeps could not be checked. Start the node, unfreeze it on the Apps tab, and try again.");
  }
  else if (fc && fc.posted) out.push(fc.posted + (fc.posted === 1 ? " Future Cash Next collect or sweep is" : " Future Cash Next collects or sweeps are") + " still under way, which only this wallet's keys can finish: " + fc.collects.concat(fc.queued, fc.sweeps).join(", "));
  const c = r && r.casino;
  if (c && (c.offers || c.bets)) out.push("P2P Chance: " + plural(c.offers || 0, "offer") + " and " + plural(c.bets || 0, "bet") + " still open, which only this wallet's keys can settle.");
  return out;
}
/** Are checks that cannot be made (and, since 0.18.137, warnings to confirm) the ONLY things in the way? Then, and only
 *  then, the user may go on. The name is from 0.18.110, when Dexicon's was the only such check. */
function onlyDexiconUnchecked(list) { return !!list && list.length > 0 && list.every(x => String(x).endsWith(DEX_SKIP_HINT) || String(x).endsWith(CONFIRM_HINT)); }
/** What the user is told before going on: Dexicon's own text when it is the only thing; otherwise every line that
 *  stands in the way, word for word, then what going on means. */
function skipWarning(list) {
  list = list || [];
  if (list.length && list.every(x => /^Dexicon /.test(x))) return DEX_SKIP_WARNING;
  return list.map(x => String(x).replace(" " + DEX_SKIP_HINT, "").replace(" " + CONFIRM_HINT, "")).join("\n\n")
    + "\n\nIf you go on:\n• A store that could not be opened or checked is kept beside the new one under a dated name. Nothing is deleted.\n• Whatever needs THIS wallet's keys (a pool's reserves, a swap to claim or refund, an order on the chain) can afterwards be reached only by restoring this wallet again.\n\nGo on only if you have this wallet's 24 words.";
}
/** What the user is told before going on without the Dexicon check. */
const DEX_SKIP_WARNING = "Dexicon cannot be checked, so the app cannot see whether this wallet still has Dexicon orders on the chain or a trade that was sent and not yet answered.\n\nIf you go on:\n• The Dexicon store is kept beside the new one under a dated name. Nothing is deleted.\n• A Dexicon order of this wallet that is still on the chain can then be cancelled or collected only by restoring this wallet again.\n• A trade that was sent and not answered can no longer be voided by this app.\n\nGo on only if Dexicon stays like this after the app was restarted.";
function activeWorkProblem(list) {
  return list && list.length ? "This would replace the wallet while work that needs its keys is still open:\n\n• " + list.join("\n• ")
    + "\n\nNothing was changed. Let these finish or withdraw them, then try again. A swap that loses its wallet can be neither claimed nor refunded by this app." : "";
}

/** Does this node command (or any ;-separated part of it) load a wallet from a backup file? */
function loadsBackupFile(command) {
  return String(command || "").split(";").some(part => /^\s*(restore|restoresync)(\s|$)/i.test(part) || (/^\s*megammrsync(\s|$)/i.test(part) && /\sfile:/i.test(part)));
}

/**
 * Restore from a backup file: the mode check, then the command, then the node. o = { file, password, host, mode,
 * check }; d = { keyMode, supported, running, run(cmd), work() → activeWorkList }. check:true stops after the checks (the screen asks
 * first, so a refusal comes before its "Replace this node?" question). Throws the plain reason on a refusal.
 */
async function restoreBackup(o, d) {
  o = o || {};
  const why = backupModeProblem(o.mode, d.keyMode, d.supported);
  if (why) throw new Error(why);
  const built = restoreFileCommand(o);
  if (built.error) throw new Error(built.error);
  if (!d.running) throw new Error("The node is not running. Start the node before restoring.");
  const open = activeWorkProblem(await d.work());
  if (open) throw new Error(open);
  if (o.check) return { ok: true };
  return d.run(built.cmd);
}

module.exports = { isResync, backupCommandProblem, backupModeProblem, restoreFileCommand, loadsBackupFile, replacesWalletFromPhrase, moveAside, activeWorkList, activeWorkProblem, restoreBackup,
  onlyDexiconUnchecked, skipWarning, DEX_SKIP_HINT, CONFIRM_HINT, OWN_POOLS_WARNING, SAME_WALLET_NOTE, DEX_SKIP_WARNING, DEX_STUCK_MS };
