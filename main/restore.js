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
function activeWorkList(r) {
  const out = [], ax = r && r.atomix, plural = (n, one) => n + " " + one + (n === 1 ? "" : "s");
  if (!ax) out.push("AtomiX could not be asked whether a swap is in flight. Wait a moment and try again.");
  else if (!ax.ready) { if (ax.hasStore) out.push("AtomiX has not finished starting, so its swaps could not be checked. Wait a moment and try again."); }
  else {
    if (ax.swaps && ax.swaps.length) out.push(plural(ax.swaps.length, "AtomiX swap") + " still in flight (the app holds what is needed to claim or refund " + (ax.swaps.length === 1 ? "it" : "them") + "): " + ax.swaps.join(", "));
    if (ax.maker) out.push("A live AtomiX maker order. Withdraw it in AtomiX first.");
    if (ax.otcOffer) out.push("A live AtomiX OTC offer. Withdraw it first.");
    if (ax.otcDeals) out.push(plural(ax.otcDeals, "AtomiX OTC deal") + " still open.");
  }
  if (r && r.pools === null) out.push("PandaPools could not be asked whether a pool transaction is still waiting. Wait a moment and try again.");
  const waiting = ((r && r.pools) || []).filter(x => x && x.txpowid && x.confirmed === false && !x.failed);
  if (waiting.length) out.push(plural(waiting.length, "PandaPools transaction") + " still waiting to confirm: " + waiting.map(x => x.txpowid).join(", "));
  // Dexicon (main/dexicon.js activeWork). undefined = not asked (the engine is not part of this caller); null = it could not be asked.
  const dx = r && r.dexicon;
  // A Dexicon that cannot be checked must not block a restore for ever (0.18.110): a damaged store or an engine that
  // never becomes ready is named, and after two minutes of it (or at once when it could not be asked at all) the
  // user may go on (r.skipDexicon: main.js, after the screen's warning). The store is moved aside as always.
  const skip = !!(r && r.skipDexicon);
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
  const c = r && r.casino;
  if (c && (c.offers || c.bets)) out.push("P2P Chance: " + plural(c.offers || 0, "offer") + " and " + plural(c.bets || 0, "bet") + " still open, which only this wallet's keys can settle.");
  return out;
}
/** Is the Dexicon check that cannot be made the ONLY thing in the way? (Then, and only then, it may be skipped.) */
function onlyDexiconUnchecked(list) { return !!list && list.length > 0 && list.every(x => String(x).endsWith(DEX_SKIP_HINT)); }
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
  onlyDexiconUnchecked, DEX_SKIP_HINT, DEX_SKIP_WARNING, DEX_STUCK_MS };
