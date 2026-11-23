/*
 * mainsaid.js: what the MAIN process says (refusals, reasons, errors), said in the app's language in the window.
 *
 * The main process keeps saying these in English: that is what its log holds, what its tests pin, and the only thing
 * Electron carries from a handler that throws (an Error's message; any other field is dropped on the way). Nothing in
 * main changed for this, so no condition and no English word did. Each sentence main can say is listed here once, with
 * a stable CODE, as the English template main builds it ({x} = a value). The window reads a message back against these
 * templates: an exact, whole match gives the code and the values, and the text is said through the catalog key (the
 * template itself). A message that matches nothing is shown as it came, in English: never a blank, never half a sentence.
 * Values that are themselves sentences of main (a list of reasons) are read back the same way, one by one.
 *
 * Code that must DECIDE something from a main message asks for its code (has()), never for its words on screen.
 * The English never travels translated, so a code read from it does not depend on the language on show.
 *
 *   say(text[, group]) the message in the language on show (English when it is not listed)
 *   read(text)         { code, key, params, parts } of the whole message, or null
 *   has(text, code)    the message, or any sentence inside it, is that code
 *
 * scripts/mainsaid-test.cjs runs the real main functions, reads back what they say, and fails on a message of theirs
 * that is not listed, so the table cannot drift from main.
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.MainSaid = make(); })(this, function () {
  "use strict";
  // [code, English template (a catalog key; a plural key has its English forms in renderer/i18n/en.js), options]
  //   top: false     only read inside another message (a list item), never as a whole message
  //   nest: { param: { split: "separator", sub: [codes] } | { sub: [codes] } }   values that are sentences of main
  //   lower: true    the item may arrive with its first letter made a capital (main/freeze.js capitalises its list)
  //   value: true    (in nest) the value is usually main's own (a program's command line) and only sometimes a listed sentence
  var T = [
    // ---- Freeze (main/freeze.js) ----
    ["FREEZE_CORE", I18N.N_("Minima Core is the node and the wallet. It cannot be frozen.")],
    ["FREEZE_PARLONS", I18N.N_("Parlons is part of the node itself: its account runs inside it. It cannot be frozen. Hide takes it out of the drawer.")],
    ["FREEZE_UNKNOWN", I18N.N_("Unknown app.")],
    ["FREEZE_REPLACING", I18N.N_("The wallet is being replaced, and Dexicon's engines are stopped for it. Dexicon can be frozen once that has finished.")],
    ["FREEZE_INFLIGHT", I18N.N_("Dexicon is still watching funds in flight. It can be frozen once they settle.\n\n{list}"), { nest: { list: { split: "\n", sub: ["FREEZE_LINE"] } } }],
    ["FREEZE_LINE", I18N.N_("• {item}."), { top: false, nest: { item: { sub: "FREEZE_ITEMS", lower: true } } }],
    ["FREEZE_STOP_FAILED", I18N.N_("It could not be stopped, so it is not frozen ({error}). It is running as before.")],
    ["FZ_AX_UNASKED", I18N.N_("AtomiX could not be asked about its swaps"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_SWAPS", I18N.N_("{n} AtomiX swaps not finished"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_NOT_STARTED_OFFERS", I18N.N_("AtomiX has not started, so its market and OTC offers could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_NOT_STARTED_SWAPS", I18N.N_("AtomiX has not started, so its swaps could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_MAKER", I18N.N_("your AtomiX market is on the book (withdraw it first)"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_OTC", I18N.N_("your AtomiX OTC availability is live (withdraw it first)"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_AX_DEALS", I18N.N_("{n} AtomiX OTC deals open"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_PP_NOT_STARTED", I18N.N_("PandaPools has not started, so its transactions could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_PP_TX", I18N.N_("{n} pool transactions not confirmed yet"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_PP_UNREAD", I18N.N_("your pools could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_PP_OWN", I18N.N_("{n} pools of this wallet are open (the app keeps them up)"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_UNASKED", I18N.N_("the Exchange could not be asked about its trades"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_NOT_STARTED_ORDERS", I18N.N_("the Exchange has not started, so its orders could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_NOT_STARTED_TRADES", I18N.N_("the Exchange has not started, so its trades could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_TAKES", I18N.N_("{n} Exchange trades sent and not yet answered"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_UNKNOWN", I18N.N_("{n} Exchange fills with an outcome not known yet"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_PENDING", I18N.N_("{n} Exchange orders waiting for a block"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_HOLDS_UNREAD", I18N.N_("the Exchange's live orders could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_DX_HOLDS", I18N.N_("{n} coins behind live Exchange orders or trades (cancel the orders first)"), { top: false, group: "FREEZE_ITEMS" }],
    ["FREEZE_FC_INFLIGHT", I18N.N_("Future Cash Next is still moving funds. It can be frozen once they settle.\n\n{list}"), { nest: { list: { split: "\n", sub: ["FREEZE_LINE"] } } }],
    ["FZ_FC_UNASKED", I18N.N_("Future Cash Next could not be asked about its collects and sweeps"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_FC_NOT_STARTED", I18N.N_("Future Cash Next has not started, so its collects and sweeps could not be read"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_FC_COLLECTS", I18N.N_("{n} collects are posted and not confirmed yet"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_FC_QUEUED", I18N.N_("{n} collected coins on an at-risk address are waiting for their sweep"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_FC_SWEEPS", I18N.N_("{n} sweeps are under way"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_READ_LATE", I18N.N_("what is in flight could not be read in time"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_READ_FAILED", I18N.N_("what is in flight could not be read"), { top: false, group: "FREEZE_ITEMS" }],

    // ---- Restoring a backup, and replacing the wallet (main/restore.js) ----
    ["RESTORE_PICK_MODE", I18N.N_("Choose which kind of wallet made this backup.")],
    ["NO_WALLET_YET", I18N.N_("No wallet has been set up yet. Choose New Wallet or Restore Wallet first.")],
    ["RESTORE_BLOCK_UNSUPPORTED", I18N.N_("This backup holds a block key wallet, and the node in this version of the app runs classic keys only. Restoring it here would put block keys into a node that goes on making classic ones, and the two kinds would be mixed for good. Nothing was changed.\n\nWhat you can do: keep using that wallet in the app that made it (for example Pandamonium on the phone), or send its funds from there to an address of this wallet (Receive). Typing its 24 words in here would not bring it over: the same words give a different, empty wallet with classic keys.")],
    ["RESTORE_MIX_CLASSIC", I18N.N_("This install holds a classic key wallet, and that cannot be changed. This backup holds a block key wallet, so restoring it here would mix the two kinds of key for good. Nothing was changed.\n\nWhat you can do: restore it in a fresh install of the app, or send its funds to an address of this wallet from the app that made it.")],
    ["RESTORE_MIX_BLOCK", I18N.N_("This install holds a block key wallet, and that cannot be changed. This backup holds a classic key wallet, so restoring it here would mix the two kinds of key for good. Nothing was changed.\n\nWhat you can do: restore it in a fresh install of the app, or send its funds to an address of this wallet from the app that made it.")],
    ["RESTORE_HOST", I18N.N_("MegaMMR host must be host:port.")],
    ["RESTORE_KEYUSES_ADD", I18N.N_("keyuses: on restoresync is added to how many times every key in the backup has signed; the usual figure is small (the node's own default is 256). It can be at most 10000: a large figure would bring the wallet's keys near their limit of 262144 one-time uses, after which they sign with one-time keys they have already used, which can lose funds. Nothing was run.")],
    ["RESTORE_KEYUSES_ADD_BLOCK", I18N.N_("keyuses: on restoresync is added to how many times every key in the backup has signed; the usual figure is small (the node's own default is 256). On this block key wallet it can be at most 10000: a key's count follows the block number, and a key counted far above the chain's tip stops signing after one signature (the funds stay, but this wallet can no longer sign). Nothing was run.")],
    ["RESTORE_KEYUSES_SET", I18N.N_("keyuses: sets how many times every key of this wallet has already signed, so it must be at least that number; a small figure is usual (the node's defaults are 100 to 1000). It can be at most 250000: a figure near a key's limit of 262144 one-time uses would leave the wallet with keys that run out and then sign with one-time keys they have already used, which can lose funds. Nothing was run.")],
    ["RESTORE_KEYUSES_BLOCK", I18N.N_("keyuses: on this block key wallet raises the floor under the block number for every key: at most {max}, the chain's tip (block {tip}) plus 10000. A figure far above the tip makes every key stop signing after one signature: the funds stay, but this wallet can no longer sign. Nothing was run.")],
    ["RESTORE_KEYUSES_BLOCK_UNREAD", I18N.N_("keyuses: on this block key wallet must stay near the chain's tip, which could not be read now, so at most {max} is taken. A figure far above the tip makes every key stop signing after one signature. Nothing was run.")],
    ["RESTORE_KEYUSES_MAX", I18N.N_("keyuses: must be a whole number from 0 to 262143: a key of this wallet has 262144 one-time uses, numbered 0 to 262143, and a higher figure would make the wallet sign with one-time keys it has already used, which can lose funds. Nothing was run.")],
    ["RESTORE_FILE_EMPTY", I18N.N_("Enter the backup file's name or path.")],
    ["RESTORE_FILE_SPACES", I18N.N_("File path can't contain spaces or quotes.")],
    ["RESTORE_PASSWORD_SPACES", I18N.N_("Password can't contain spaces or quotes.")],
    ["RESTORE_FILE_SEMICOLON", I18N.N_("The file path contains a semicolon (;), which the node reads as the end of the command. Rename the file or move it, then try again.")],
    ["RESTORE_PASSWORD_SEMICOLON", I18N.N_("The password contains a semicolon (;), which the node reads as the end of the command, so this app cannot pass it. Restore this backup from the node's own command line.")],
    ["BACKUP_PASSWORD", I18N.N_("A backup password can hold letters and numbers only.")],
    ["RESTORE_NODE_STOPPED", I18N.N_("The node is not running. Start the node before restoring.")],
    ["RESTORE_REFUSED", I18N.N_("The node refused the restore.")],
    // ---- A file the node is told to read (main/importfile.js) ----
    ["IMPORT_BAD_PATH", I18N.N_("The file's path holds a character the node cannot be given safely: one of ; \" : [ ] { }, a backslash outside Windows, or a control character. Rename the file or move it to a plain folder (spaces are fine), then choose it again. Nothing was sent.")],
    ["IMPORT_NOT_PLAIN", I18N.N_("Not a plain file: choose the file itself, not a folder, a link or a device. Nothing was sent.")],
    ["IMPORT_UNREADABLE", I18N.N_("The file could not be read ({error}). Nothing was sent.")],
    ["IMPORT_CHOOSE_FIRST", I18N.N_("Choose the file first (Choose…). Nothing was sent.")],
    ["IMPORT_ROOM_HEAP", I18N.N_("This MegaMMR file is {file} MB. The node needs about four times that in memory while it checks and imports it: {need} MB, and it is set to {heap} MB. In Settings, set Parlons Node memory to {need} or more and press Apply and restart the node, then try again. Nothing was changed.")],
    ["IMPORT_ROOM_HEAP_PLAIN", I18N.N_("This MegaMMR file is {file} MB. The node needs about four times that in memory while it checks and imports it: {need} MB, and the plain Minima node gets {heap} MB here (a quarter of this computer's memory). In Settings, choose the Parlons Node, set Parlons Node memory to {need} or more and press Apply and restart the node, then try again. Nothing was changed.")],
    ["IMPORT_ROOM_RAM", I18N.N_("This computer has {ram} MB of memory. The node would need {heap} MB of it for this MegaMMR file, which leaves too little for everything else, so it cannot be imported on this computer. Nothing was changed.")],
    ["IMPORT_ROOM_DISK", I18N.N_("The node's data folder has {free} MB free, and this import needs about {need} MB. Make room, then try again. Nothing was changed.")],
    ["IMPORT_ON_FAILED", I18N.N_("The node did not come back in MegaMMR mode, so nothing was imported, and the setting was put back as it was. Look at the Logs, and start the node again from the Node tab if it is stopped.")],
    ["IMPORT_UNKNOWN_KIND", I18N.N_("Unknown kind of file.")],
    ["IMPORT_IN_DATABASES", I18N.N_("This file is inside the node's own databases folder, which the import replaces. Copy it to another folder first, then choose the copy. Nothing was sent.")],
    ["IMPORT_NOT_MEGAMMR", I18N.N_("This is not a MegaMMR file: it does not begin as a MegaMMR export does. Nothing was sent.")],
    // ---- Resync from a MegaMMR file, Turn MegaMMR off (main/megammrfile.js) ----
    ["MEGAFILE_BUSY", I18N.N_("A resync, an import, a restore or a MegaMMR switch is already running. Wait for it to finish. Nothing was changed.")],
    ["MEGAFILE_STATUS_UNKNOWN", I18N.N_("The node's status could not be read, so it is not known whether it keeps a MegaMMR. Nothing was changed. Try again in a moment.")],
    ["MEGAFILE_ENGINES", I18N.N_("The trading engines could not be stopped ({error}), so nothing was imported. Nothing was changed.")],
    ["MEGAFILE_OPEN", I18N.N_("This import replaces the node's chain and stops the trading engines until it has finished, while work that needs them is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again."), { nest: { items: { split: "\n• ", sub: "REPLACE_ITEMS" } } }],
    ["MEGAFILE_CHECK_FAILED", I18N.N_("The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. Use a complete MegaMMR file exported by a node you trust.")],
    ["MEGAFILE_CHECK_FAILED_BACK", I18N.N_("The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off). Use a complete MegaMMR file exported by a node you trust.")],
    ["MEGAFILE_FAILED", I18N.N_("The import failed part-way ({why}). The node was restarted. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.")],
    ["MEGAFILE_NOT_STARTED", I18N.N_("The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted. Your wallet and funds were not touched.")],
    ["MEGAFILE_NOT_STARTED_BACK", I18N.N_("The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted as a light node, as it was before. Your wallet and funds were not touched.")],
    ["MEGAFILE_TIP_REFUSED", I18N.N_("This file was not imported: {why}. Nothing was imported, and the node's chain was not touched."), { nest: { why: { sub: ["MEGAFILE_AHEAD", "MEGAFILE_BEHIND"] } } }],
    ["MEGAFILE_TIP_REFUSED_BACK", I18N.N_("This file was not imported: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off)."), { nest: { why: { sub: ["MEGAFILE_AHEAD", "MEGAFILE_BEHIND"] } } }],
    ["MEGAFILE_AHEAD", I18N.N_("its chain reaches block {chaintip}, but this node is at block {tip}, so it is from another chain, or this node is not at the network's tip yet (wait until it is, then try again)"), { top: false }],
    ["MEGAFILE_BEHIND", I18N.N_("its chain ends at block {chaintip}, more than 30 days of blocks behind this node's block {tip} (use a recent MegaMMR file)"), { top: false }],
    ["MEGAFILE_FAILED_BACK", I18N.N_("The import failed part-way ({why}). The node was restarted as a light node, as it was before. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.")],
    ["IMPORT_BACKUP_EXT", I18N.N_("This is not a node backup file: a backup file's name ends in .bak. Nothing was sent.")],
    ["IMPORT_BACKUP_SMALL", I18N.N_("This file is too small to be a node backup ({size} bytes). Nothing was sent.")],
    ["IMPORT_BACKUP_LARGE", I18N.N_("This file is larger than any node backup this app can restore (over 1 GB). Nothing was sent.")],
    ["IMPORT_MEGAMMR_EXT", I18N.N_("This is not a MegaMMR file: its name ends in .mmr or .megammr. Nothing was sent.")],
    ["IMPORT_MEGAMMR_SMALL", I18N.N_("This file is too small to be a MegaMMR file ({size} bytes). Nothing was sent.")],
    ["REPLACE_OPEN", I18N.N_("This would replace the wallet while work that needs its keys is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again. A swap that loses its wallet can be neither claimed nor refunded by this app."), { nest: { items: { split: "\n• ", sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_GO_ON", I18N.N_("{items}\n\nIf you go on:\n• A store that could not be opened or checked is kept beside the new one under a dated name. Nothing is deleted.\n• Whatever needs THIS wallet's keys (a pool's reserves, a swap to claim or refund, an order on the chain) can afterwards be reached only by restoring this wallet again.\n\nGo on only if you have this wallet's 24 words."), { nest: { items: { split: "\n\n", sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_GO_ON_DEXICON", I18N.N_("Dexicon cannot be checked, so the app cannot see whether this wallet still has Dexicon orders on the chain or a trade that was sent and not yet answered.\n\nIf you go on:\n• The Dexicon store is kept beside the new one under a dated name. Nothing is deleted.\n• A Dexicon order of this wallet that is still on the chain can then be cancelled or collected only by restoring this wallet again.\n• A trade that was sent and not answered can no longer be voided by this app.\n\nGo on only if Dexicon stays like this after the app was restarted.")],
    ["REPLACE_SKIP_HINT", I18N.N_("{x} If it stays like this, you can go on without this check."), { top: false, group: "REPLACE_ITEMS", nest: { x: { sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_CONFIRM_HINT", I18N.N_("{x} You can go on after confirming this."), { top: false, group: "REPLACE_ITEMS", nest: { x: { sub: "REPLACE_ITEMS" } } }],
    ["RP_AX_UNASKED", I18N.N_("AtomiX could not be asked whether a swap is in flight. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_FC_UNASKED", I18N.N_("Future Cash Next could not be asked whether a collect or a sweep is still under way. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_CASINO_STUCK", I18N.N_("P2P Chance has not finished reading this wallet's bets after {m} minutes, so whether any is still open cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_CASINO_UNREAD", I18N.N_("P2P Chance could not be checked: this wallet has bets on the chain, and whether any is still open is not read yet. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_FC_STORE", I18N.N_("Future Cash Next could not open its store ({error}), so whether a collect or a sweep is still under way cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_FC_NOT_STARTED", I18N.N_("Future Cash Next has not started (or is frozen), so its collects and sweeps could not be checked. Start the node, unfreeze it on the Apps tab, and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_FC_WORK", I18N.N_("{n} Future Cash Next collects or sweeps are still under way, which only this wallet's keys can finish: {ids}"), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_STORE_SWAPS", I18N.N_("{n} AtomiX swaps still in flight, read from AtomiX's store while AtomiX itself has not finished starting (the app holds what is needed to claim or refund them): {ids}"), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_STORE", I18N.N_("AtomiX could not open its swap store ({error}), so whether a swap is in flight, or a maker order or an OTC deal is open, cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_STUCK", I18N.N_("AtomiX has not finished starting after {m} minutes, so whether a swap is in flight, or a maker order or an OTC deal is open, cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_STARTING", I18N.N_("AtomiX has not finished starting, so its swaps could not be checked. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_SWAPS", I18N.N_("{n} AtomiX swaps still in flight (the app holds what is needed to claim or refund them): {ids}"), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_MAKER", I18N.N_("A live AtomiX maker order. Withdraw it in AtomiX first."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_OTC", I18N.N_("A live AtomiX OTC offer. Withdraw it first."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_AX_DEALS", I18N.N_("{n} AtomiX OTC deals still open."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_PP_STORE", I18N.N_("PandaPools could not open its pool store ({error}), so whether a pool transaction is still waiting, and which pools this wallet owns, cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_PP_STUCK", I18N.N_("PandaPools has not finished starting after {m} minutes, so whether a pool transaction is still waiting, and which pools this wallet owns, cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_PP_UNASKED", I18N.N_("PandaPools could not be asked whether a pool transaction is still waiting. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_PP_OWN", I18N.N_("{n} PandaPools pools of this wallet are still open: {pools}. These pools belong to the wallet you are replacing. Their funds can only be withdrawn by that wallet. Close them first, or make sure you have its 24 words and a pool backup. The app cannot tell beforehand which wallet you are restoring. If it is this same wallet (the same 24 words), nothing changes for your pools: the wallet is compared before and after, and everything is kept in place."), { top: false, group: "REPLACE_ITEMS", nest: { pools: { split: ", ", sub: ["RP_POOL_HIDDEN", "RP_POOL_RESERVES"] } } }],
    ["RP_POOL_HIDDEN", I18N.N_("{address} (its reserves are not visible to this node just now)"), { top: false }],
    ["RP_POOL_RESERVES", I18N.N_("{address} ({minima} MINIMA and {amount} {token})"), { top: false }],
    ["RP_PP_WAITING", I18N.N_("{n} PandaPools transactions still waiting to confirm: {ids}"), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_UNASKED", I18N.N_("Dexicon could not be asked whether an order or a trade is still open; its store may be damaged."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_STUCK", I18N.N_("Dexicon has not finished starting after {m} minutes, so its on-chain orders and its trades waiting for an answer cannot be checked."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_STARTING", I18N.N_("Dexicon has not finished starting, so its orders could not be checked. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_ORDERS", I18N.N_("{n} Dexicon orders still on the chain, which only this wallet's keys can cancel or collect. Cancel them first: {ids}"), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_PENDING", I18N.N_("{n} Dexicon orders still waiting for a block."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_DX_TAKES", I18N.N_("{n} Dexicon trades sent and not yet answered. Wait for them to settle (a few minutes)."), { top: false, group: "REPLACE_ITEMS" }],
    ["RP_CASINO", I18N.N_("P2P Chance: {offers} and {bets} still open, which only this wallet's keys can settle."), { top: false, group: "REPLACE_ITEMS", nest: { offers: { sub: ["COUNT_OFFERS"] }, bets: { sub: ["COUNT_BETS"] } } }],
    ["COUNT_OFFERS", I18N.N_("{n} offers"), { top: false }],
    ["COUNT_BETS", I18N.N_("{n} bets"), { top: false }],
    ["TERMINAL_RESTORE", I18N.N_("Restoring a backup file replaces this wallet's keys. Use Backup & Recovery, Restore from file: it checks the backup's key mode first.")],

    // ---- Key mode: what may start, and what was refused (main/keymode.js, main/node-manager.js, main/config.js, main/main.js) ----
    ["KM_FOLDER_NOT_BLOCK", I18N.N_("The data folder holds node data that is not marked as a block key wallet, and this install is set up for block keys. The node was not started, because starting a classic wallet with block keys mixes the two kinds for good. If this is another wallet's folder, set the data folder back in Startup Params. If it is this wallet's own folder and its file {marker} was removed, the app cannot tell and will not guess: restore the wallet from its seed phrase in a fresh install.")],
    ["KM_FOLDER_BLOCK", I18N.N_("The data folder holds a block key wallet, but this install is set up for classic keys. The node was not started, because that would add keys of the other kind to the wallet for good. Set the data folder back in Startup Params.")],
    ["KM_UNSUPPORTED", I18N.N_("This wallet uses block key uses, and the node in this version of the app cannot run it. The node was not started, because starting it here would add classic keys to the wallet for good. Install the newer version of the app this wallet was made with.")],
    ["KM_ARG_KEYMODE", I18N.N_("{arg} is in the extra arguments. The wallet's key mode sets it, so it cannot be passed by hand. Remove it in Startup Params.")],
    ["KM_ARG_RESERVED", I18N.N_("{arg} is in the extra arguments. The app sets it itself, and a second one would override the app's. Remove it in Startup Params.")],
    ["KM_DASH", I18N.N_("The value of -{param} starts with a dash. The node would read it as another parameter, so it was not started. Correct it in Startup Params.")],
    ["KM_CONF_UNREADABLE", I18N.N_("The config file given with -conf could not be read, so it could not be checked: {file}. The node was not started.")],
    ["KM_CONF_KEYFLAGS", I18N.N_("The config file given with -conf sets -blockaskeyuses or -lowram. The wallet's key mode sets them, so they cannot be passed by hand. Remove them from that file.")],
    ["KM_CONF_OWNED", I18N.N_("The config file given with -conf sets {key}, which the app sets itself. Remove that line from the file.")],
    ["KM_ARGV_FOLDER", I18N.N_("The node was not started: -{name} would point it at a folder other than this install's data folder. Remove it from the extra arguments in Startup Params.")],
    ["KM_ARGV_PARLONS_DATA", I18N.N_("The node was not started: it would be pointed at a folder other than this install's data folder.")],
    ["KM_ARGV_PARLONS_CONF", I18N.N_("The node was not started: a config file was given outside the app's own -conf parameter.")],
    ["KM_ARGV_BLOCK_NONE", I18N.N_("The node was not started: its start command does not hold the block key flags, and this wallet uses block keys, which needs exactly -blockaskeyuses true -lowram true. Check the parameter values and extra arguments in Startup Params.")],
    ["KM_ARGV_BLOCK", I18N.N_("The node was not started: its start command holds {found}, and this wallet uses block keys, which needs exactly -blockaskeyuses true -lowram true. Check the parameter values and extra arguments in Startup Params.")],
    ["KM_ARGV_CLASSIC", I18N.N_("The node was not started: its start command holds {found}, and this wallet uses classic keys, which needs neither -blockaskeyuses nor -lowram. Check the parameter values and extra arguments in Startup Params.")],
    ["KM_MARK_FAILED", I18N.N_("The data folder could not be marked as a block key wallet ({error}). The node was not started.")],
    ["KM_ALERT_CLASSIC", I18N.N_("{what}, but this wallet is recorded as a classic key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on."), { nest: { what: { sub: "KM_WHAT" } } }],
    ["KM_ALERT_BLOCK", I18N.N_("{what}, but this wallet is recorded as a block key wallet. The node was stopped at once and will not be started again until the app is quit and reopened. Do not start it again as it is: each start in the wrong mode can add more keys of the other kind to the wallet. Your seed phrase still controls your funds. Quit the app and ask for help before going on."), { nest: { what: { sub: "KM_WHAT" } } }],
    ["KM_WHAT_MIXED", I18N.N_("The wallet in this node holds keys of both kinds, classic and block"), { top: false, group: "KM_WHAT" }],
    ["KM_WHAT_CLASSIC", I18N.N_("The node is running with classic keys"), { top: false, group: "KM_WHAT" }],
    ["KM_WHAT_BLOCK", I18N.N_("The node is running with block keys"), { top: false, group: "KM_WHAT" }],
    ["KM_WHAT_BOOT", I18N.N_("The node started in block key mode"), { top: false, group: "KM_WHAT" }],
    ["KM_RECORD_UNSUPPORTED", I18N.N_("The node in this version of the app cannot run a block key wallet.")],
    ["KM_KIND_UNSUPPORTED", I18N.N_("This wallet uses block key uses, and that node cannot run it.")],
    ["KM_CFG_ARG", I18N.N_("{arg} cannot be set in the extra arguments. The wallet's key mode sets it.")],
    ["KM_CFG_RESCUE", I18N.N_("The rescue node must be host:port (a name or IP address, a colon, a port number). Nothing was saved.")],
    ["KM_CFG_RESCUE_EXTRA", I18N.N_("-rescuenode is set in Startup Params, not in the extra arguments.")],
    ["KM_CFG_MDS", I18N.N_("{arg} cannot be set in the extra arguments: this app never turns MiniDapps (MDS) on.")],
    ["KM_CFG_OWNED", I18N.N_("{arg} cannot be set in the extra arguments. The app sets it itself.")],
    ["KM_CFG_UNKNOWN", I18N.N_("Unknown key mode.")],
    ["KM_CFG_FIXED_CLASSIC", I18N.N_("This wallet's key mode is classic and cannot be changed.")],
    ["KM_CFG_FIXED_BLOCK", I18N.N_("This wallet's key mode is block and cannot be changed.")],

    // ---- Starting the node, switching its kind, replacing its wallet (main/node-manager.js) ----
    ["NODE_KEYS_UNREAD", I18N.N_("The node's keys could not be read to check the wallet's key mode, so the app has not called the node running and the trading engines stay stopped. Restart the node; if this stays, look at the Logs.")],
    ["NODE_PORT_IN_USE", I18N.N_("Port {port} ({what}) is in use by {program} (pid {pid}). {product} did not start its node and did not touch that program. Stop that program, or choose another base port in Startup Params."), { nest: { what: { sub: "PORT_WHAT" }, program: { sub: ["ANOTHER_PROGRAM"], value: true } } }],
    ["PORT_P2P", I18N.N_("the node's P2P port"), { top: false, group: "PORT_WHAT" }],
    ["PORT_RPC", I18N.N_("the node's RPC"), { top: false, group: "PORT_WHAT" }],
    ["PORT_KEETS", I18N.N_("the keets sidecar"), { top: false, group: "PORT_WHAT" }],
    ["PORT_GATEWAY", I18N.N_("the Parlons wallet gateway"), { top: false, group: "PORT_WHAT" }],
    ["PORT_PANEL", I18N.N_("the Parlons panel"), { top: false, group: "PORT_WHAT" }],
    ["ANOTHER_PROGRAM", I18N.N_("another program"), { top: false }],
    ["NODE_OLD_STUCK", I18N.N_("could not stop this app's node left running by an earlier launch (pid {pid})")],
    ["NODE_JAVA", I18N.N_("could not launch java: {error}")],
    ["NODE_EXITED", I18N.N_("node exited unexpectedly ({code})")],
    ["NODE_HINT_PORT", I18N.N_("a port this node needs is already in use (base port {port}). Start again: this app's own earlier node is stopped first; any other program is named and left alone")],
    ["NODE_MEGAMMR_BROKEN", I18N.N_("This node's MegaMMR does not fit its chain (the node says \"Your MEGAMMR is BROKEN\"), so the node stops at every start. Your wallet, keys and funds are not touched. Press Turn MegaMMR off on this Node tab: the MegaMMR file is deleted and the node starts again as a light node.")],
    ["NODE_CASCADE_BROKEN", I18N.N_("This node's chain files do not fit together (the node says \"Your Cascade is BROKEN\"), so the node stops at every start. Your wallet, keys and funds are not touched. In Startup Params, set Rescue node to a MegaMMR node (host:port, the one Resync node uses) and press Save, then press Start again: the node rebuilds its chain from that node and stops. Then press Start again once more.")],
    ["NODE_HINT_DB", I18N.N_("another node still holds this data folder's databases. Start again: if it is this app's own earlier node it is stopped first")],
    ["PARLONS_SOLO", I18N.N_("The Parlons Node is a mainnet node: a solo/private network needs the plain Minima node.")],
    ["PARLONS_DBPASSWORD", I18N.N_("The Parlons Node cannot take -dbpassword (a wallet DB password): keep the plain Minima node, or set up again without one.")],
    ["PARLONS_NO_JAR", I18N.N_("parlons-node.jar is not bundled in this build.")],
    ["WR_ENGINES", I18N.N_("The trading engines could not be stopped ({error}), so the wallet was not replaced. Nothing was changed.")],
    ["WR_NO_ANSWER", I18N.N_("{error}. The node did not answer, and it may still be resyncing: watch the Logs, and restart the node when it says it has finished.")],
    ["WR_STOPPED", I18N.N_("The node stopped before it answered, so the result is not known. It was started again: check the wallet and the chain before going on.")],

    // ---- The coin guard (main/reserve.js): its refusals, in the node's failure shape, and what a coin is held for ----
    ["CG_TXN_DUP", I18N.N_("The parameter {param}: is given twice. Nothing was signed.")],
    ["CG_POST_DUP", I18N.N_("The parameter id: is given twice. Nothing was posted.")],
    ["CG_COIN_HELD", I18N.N_("Coin {coin} is held for {why}. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" } } }],
    ["CG_SEND_DUP", I18N.N_("Not sent: the parameter {param}: is given twice. Nothing was signed.")],
    ["CG_SEND_FROM", I18N.N_("Not sent: the address this send takes its coins from holds coin {coin}, held for {why}. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" } } }],
    ["CG_SEND_SHORT", I18N.N_("Not enough free funds: {held} {token} is held for {why} (a send takes its coins from one address, so coins at an address with a held coin count as held). Free: {free} {token}. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" }, token: { sub: ["CG_TOKEN"], value: true } } }],
    ["CG_SEND_SHORT_ADDRESS", I18N.N_("Not enough free funds: {held} {token} is held for {why} (a send takes its coins from one address, so coins at an address with a held coin count as held). Free: {free} {token}, and no single address holds the {need} this send needs. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" }, token: { sub: ["CG_TOKEN"], value: true } } }],
    ["CG_TOKEN", I18N.N_("of token {tokenid}"), { top: false }],
    ["CG_CONSOLIDATE_DUP", I18N.N_("Nothing consolidated: the parameter {param}: is given twice. Nothing was signed.")],
    ["CG_CONSOLIDATE_HELD", I18N.N_("Nothing consolidated: {n} coins are held for {why}, and consolidating chooses its own coins and could take one of them. Try again when they are free. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" } } }],
    ["CG_CHAIN_DUP", I18N.N_("The parameter {param}: is given twice in a chained `txninput`. Nothing was signed.")],
    ["CG_CHAIN_HELD", I18N.N_("Not sent: coins are held for {why}, and a send or a consolidation inside a chain of commands cannot be kept away from them. Run it as one command. Nothing was signed."), { nest: { why: { sub: "HOLD_WHY" } } }],
    // what holds a coin: one of these, or several joined ("a, b and c"); read with say(text, "HOLD_WHY") where a screen shows it
    ["WHY_SEVERAL", I18N.N_("{list} and {last}"), { top: false, group: "HOLD_WHY", nest: { list: { split: ", ", sub: "HOLD_WHY_ONE" }, last: { sub: "HOLD_WHY_ONE" } } }],
    ["WHY_ATOMIX", I18N.N_("an AtomiX swap"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_PANDAPOOLS", I18N.N_("a PandaPools transaction"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_DEXICON_TRADE", I18N.N_("a Dexicon trade"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_CASINO", I18N.N_("a P2P Chance transaction"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_WALLET", I18N.N_("a transaction of the wallet"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_DEXICON", I18N.N_("Dexicon"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_OTHER", I18N.N_("another part of the app"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_DEXICON_ORDER", I18N.N_("a live Dexicon order"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_DEXICON_TAKE", I18N.N_("a Dexicon take that has not been answered yet"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_DEXICON_VOID", I18N.N_("a Dexicon take that is being voided"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_FUTURECASH_TXN", I18N.N_("a Future Cash Next transaction"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],
    ["WHY_FUTURECASH", I18N.N_("Future Cash Next"), { top: false, group: ["HOLD_WHY", "HOLD_WHY_ONE"] }],

    // ---- Future Cash Next (main/futurecash.js): what its engine says to the screens; its log lines stay English ----
    ["FCMAIN_GRANT_CHANGED", I18N.N_("The rescue destination changed while you were asked. Nothing was allowed.")],
    ["FC_SIGN_CAP", I18N.N_("Enter a whole number of at least 1.")],
    ["FC_TOO_MANY", I18N.N_("More than 5,000 stakes are at the contract address for this node, so new stakes are not detected. Stakes found before are still followed and swept.")],
    ["FC_NOT_STARTED", I18N.N_("Future Cash Next has not started yet.")],
    ["FC_STAKE_LIST", I18N.N_("Could not read the complete stake list. Refresh and retry.")],
    ["FC_ADDR_MISSING", I18N.N_("Address not found on this node.")],
    ["FC_CHECK_COINS", I18N.N_("Couldn't check this address's coins right now: try again in a moment.")],
    ["FC_INVALID_ADDR", I18N.N_("Invalid address.")],
    ["FC_KEEP_CHANGE", I18N.N_("Keep at least {n} change addresses. Restart your node to generate fresh clean ones, then retire more.")],
    ["FC_NOT_FC", I18N.N_("Not a FutureCash stake.")],
    ["FC_COIN_ID", I18N.N_("Not a valid coin id.")],
    ["FC_NOT_DEFAULT", I18N.N_("Not an active default change address (already retired, or not one of yours).")],
    ["FC_IMMATURE", I18N.N_("Not matured yet: unlocks at block {block} (now {tip}).")],
    ["FC_RETIRE_AT_RISK", I18N.N_("Only an address the key audit found at risk is retired here.")],
    ["FC_RETIRE_UNCHANGED", I18N.N_("Retire didn't take effect: the address is still a default.")],
    ["FC_AUDIT_FIRST", I18N.N_("Run a key audit first, then collect.")],
    ["FC_STAKE_MISSING", I18N.N_("Stake not found: it may already be collected.")],
    ["FC_RETIRE_STAKES", I18N.N_("Stakes still pay out to this address: they'd land here when they mature and get stuck on the nulled key. Leave it live; the guardian keeps sweeping.")],
    ["FC_START_FIRST", I18N.N_("Start the guardian first: a retired address can still be paid, and only the running guardian moves what arrives there to your safe address.")],
    ["FC_NOT_YOURS", I18N.N_("That stake doesn't pay out to this node: it isn't yours to collect.")],
    ["FC_AUTH", I18N.N_("The embedded node did not authorize the request. Check its status before retrying.")],
    ["FC_AUTH_LOCK", I18N.N_("The embedded node did not authorize the request. Check its status before locking again.")],
    ["FC_COINS_REMAIN", I18N.N_("This address still holds {n} coin(s). Sweep them to safety first (they're on an exposed key), then retire it.")],
    ["FC_ALREADY", I18N.N_("This stake is already being collected.")],
    ["FC_RISKY", I18N.N_("This stake pays out to an at-risk address: the Guardian rescues it with collect + sweep instead. Set up rescue on the Guardian tab.")],
    ["FC_RETIRE_SCRIPT", I18N.N_("Unexpected script for a default address: not retiring.")],
    ["FC_NO_GRANT", I18N.N_("Background signing is not allowed on this computer.")],
    ["FC_TIP", I18N.N_("Could not read the chain tip.")],
    ["FC_CONTRACT", I18N.N_("Could not register the FutureCash contract.")],
    ["FC_UNKNOWN_REPLY", I18N.N_("Couldn't read Minima Core's reply to {verb}: it may have succeeded. Check the Activity log before retrying.")],
    ["FC_NO_RESPONSE", I18N.N_("Minima Core didn't respond (at {verb})")],
    ["FC_RESOLVE", I18N.N_("Couldn't resolve that recipient address.")],
    ["FC_POSITIVE", I18N.N_("Enter a positive amount.")],
    ["FC_MX", I18N.N_("Not a valid Mx address (must start with Mx).")],
    ["FC_FUTURE_TIME", I18N.N_("Pick a maturity time in the future.")],
    ["FC_PICK_RESCUE", I18N.N_("Pick where rescued funds should go: the guardian needs a destination.")],
    ["FC_REFUSED_DEST", I18N.N_("Refused before signing: {address} is not the rescue destination. Nothing was signed.")],
    ["FC_REFUSED_SIGNED", I18N.N_("Refused before signing: {why}. Nothing was signed.")],
    ["FC_REFUSED_POSTED", I18N.N_("Refused before signing: {why}. Nothing was posted.")],
    ["FC_BAD_KEY", I18N.N_("Refusing to sign with a malformed public key.")],
    ["FC_REUSED_DEST", I18N.N_("That address has already signed {n} time(s): its key is reused. Sweeping your rescued money there would move it onto another exposed key. Use a fresh address from a clean wallet.")],
    ["FC_VAULT", I18N.N_("Your node's keys are locked, so it can't make a new address. Unlock your node (Vault), then try again.")],
    ["FC_NO_REPLY", I18N.N_("no reply from Minima Core")],
    ["FC_NOTHING_COLLECT", I18N.N_("Nothing to collect.")],
    ["FC_FRESH_ADDR", I18N.N_("Couldn't make a fresh address on this node.")],
    ["FC_FRESH_ADDR_DETAIL", I18N.N_("Couldn't make a fresh address on this node. ({error})")],
    ["FC_LOCAL", I18N.N_("That address belongs to THIS node. Use an EXTERNAL wallet (a different node/seed) with fresh keys.")],
    ["FC_DEST_SAME", I18N.N_("Destination equals the source address.")],
    ["FC_SWEEP_ONLY", I18N.N_("Only an address the key audit found at risk, or a retired one, is swept here.")],
    ["FC_NOT_SIGNABLE", I18N.N_("That isn't one of your signable addresses.")],
    ["FC_NO_SIGN_KEY", I18N.N_("This node has no signing key for that address: it can't be swept from here.")],
    ["FC_NODE_KEYS", I18N.N_("Couldn't read keys from the embedded node. Check Minima Core’s status.")],
    ["FC_AUDIT_NET", I18N.N_("Couldn't reach the audit service (Could not reach the audit service. Check your connection and try again.).")],
    ["FC_MALFORMED_COIN", I18N.N_("Refusing to spend a malformed coin id.")],
    ["FC_MALFORMED_DEST", I18N.N_("This payment's destination looks malformed: refusing.")],
    ["FC_MALFORMED_TOKEN", I18N.N_("This payment's token id looks malformed: refusing.")],
    ["FC_MALFORMED_AMOUNT", I18N.N_("This payment's amount looks malformed: refusing.")],
    ["FC_ZERO", I18N.N_("Refusing to post a zero-amount output: the coin's amount didn't parse.")],
    ["FC_STORE_CHECK", I18N.N_("the Future Cash store failed its integrity check")],
    ["FC_FIRST_KEY", I18N.N_("the node did not show the wallet's first key yet")],

    // ---- ETH Wallet (main/ethwallet.js) ----
    ["EW_FROZEN", I18N.N_("Dexicon is frozen, and this wallet sends through its Ethereum engine. Unfreeze Dexicon on the Apps tab, then send again. Nothing was sent.")],
    ["EW_TYPE", I18N.N_("Type {exportphrase} exactly to continue.")],
    ["EW_CANCELLED", I18N.N_("Cancelled")],

    // ---- miniMall (main/shop.js: pinned by sha256, its exact English) ----
    ["SHOP_SEED", I18N.N_("Couldn't read the node seed (is the wallet unlocked?).")],
    ["SHOP_RECIPIENT", I18N.N_("Invalid recipient shop id.")],
    ["SHOP_TOO_LARGE", I18N.N_("Message too large for one coin (shrink any image).")],
    ["SHOP_VENDOR_ADDRESS_BAD", I18N.N_("Invalid vendor address.")],
    ["SHOP_TOKEN_BAD", I18N.N_("Invalid token.")],
    ["SHOP_AMOUNT_BAD", I18N.N_("Invalid amount.")],
    ["SHOP_VENDOR_CHECK", I18N.N_("Couldn't validate the vendor address — not sending.")],
    ["SHOP_MAY_SUBMITTED", I18N.N_("Payment may have been submitted — check your balance/history before retrying.")],
    ["SHOP_VENDOR_ID", I18N.N_("This shop's vendor id is invalid.")],
    ["SHOP_PAYOUT", I18N.N_("This shop's payout address is invalid.")],
    ["SHOP_NOT_FOUND", I18N.N_("Order not found.")],
    ["SHOP_MAY_SENT", I18N.N_("That payment may already have been sent — check your Balance/History before retrying, to avoid paying twice.")],
    ["SHOP_PAID", I18N.N_("This order is already paid.")],
    // ---- PandaPools glue (main/pandapools.js, 0.19.271) ----
    ["PP_AMOUNTS", I18N.N_("A pool's amounts are plain numbers above zero. Nothing was sent.")],
    ["PP_QUEUE_THROW", I18N.N_("{label} stopped ({error}). It may have been posted: check Activity and your balance before retrying.")],
    ["SHOP_PAYOUT_BAD", I18N.N_("The payout address {address} is not a valid Minima address. Nothing was saved; check the address and save again.")],
    ["SHOP_SENDING", I18N.N_("This payment is being sent to the node now. Wait for its answer.")],
    ["SHOP_NO_VENDOR", I18N.N_("Missing vendor address for retry.")],
    ["SHOP_NOT_DUE", I18N.N_("This order is not paid by what your shop says is due. Check it by hand first.")],
    ["SHOP_HAND_ONLY", I18N.N_("Only an order that does not match your shop is checked by hand.")],
    ["SHOP_NOT_NEXT", I18N.N_("That is not this order's next step.")],
    // ---- the ETH Wallet's custom endpoint (main/atomix.js ethValidateRpc) ----
    ["AXRPC_URL", I18N.N_("That doesn't look like a URL.")],
    ["AXRPC_HTTPS", I18N.N_("Use an https:// endpoint.")],
    ["AXRPC_CREDENTIALS", I18N.N_("Leave the name and password out of the URL (user:password@host is not allowed); use a URL with the key in its path if your provider gives one.")],
    ["AXRPC_NEED_USDT", I18N.N_("Need {need} USDT or more for that — you have {have} USDT.")],   // main/atomix.js computeQuote (USDT: the Ethereum leg)
    ["AXRPC_PRIVATE", I18N.N_("That host isn't allowed (local/private addresses are blocked).")],
    ["SHOP_NO_REFUSED", I18N.N_("This order has no refused payment to retry. Check your Balance/History.")],
    ["SHOP_NOT_UNSURE", I18N.N_("This order has no payment that may have gone through.")],
    ["SHOP_PAY_BEFORE_ORDER", I18N.N_("a payment with this order's reference is older than the order (payment coin {coin} at block {block}, the order at block {orderBlock}): check by hand")],
    ["SHOP_DUP_REF", I18N.N_("another buyer sent an order with the same reference {ref}: a payment with it cannot be told apart, so check both orders by hand")],
    ["SHOP_JUDGE_GAVE_UP", I18N.N_("payment coin {coin} could not be judged: check by hand")],
    ["SHOP_NO_PROOF", I18N.N_("a payment with this order's reference does not carry this order's proof (payment coin {coin}, amount {amount}, token {token}): check by hand")],   // 0.19.352; amount and token 0.19.368
    ["SHOP_SETTLING", I18N.N_("This order's payment is held until block {block} in case another order with the same reference arrives. Check it by hand to move it on now.")],   // 0.19.354
    ["SHOP_BAD_PROOF", I18N.N_("Invalid order proof.")],   // 0.19.353: a buyer's stored proof that is not 0x and 64 capital hexadecimal digits
    ["SHOP_BAD_SECRET", I18N.N_("this order's secret cannot be read, so no payment can be proved to be its buyer's: check by hand")],

    // ---- miniMall: how an incoming order departs from the vendor's own listing (main/shop-listing.js, 0.19.166) ----
    ["SL_DELIVERY", I18N.N_("the delivery method \"{ship}\" is not in your listing")],   // before SL_UNLISTED, whose {what} would take it whole
    ["SL_NOT_MINE", I18N.N_("the shop this order names is not one of your shops on this computer")],
    ["SL_CURRENCY", I18N.N_("the order's currency ({ordercur}) is not your shop's ({shopcur})")],
    ["SL_NO_ITEMS", I18N.N_("the order has no items that can be read")],
    ["SL_ITEM", I18N.N_("an item cannot be read")],
    ["SL_QTY", I18N.N_("{what}: the quantity {qty} is not a whole number above zero")],
    ["SL_QTY_MAX", I18N.N_("{what}: the quantity {qty} is more than you list ({cap})")],
    ["SL_OWN_PRICE", I18N.N_("{what}: your own price {price} is not a plain number")],
    ["SL_PRICE", I18N.N_("{what}: the order's price {stated} is not your price {price}")],
    ["SL_TWICE", I18N.N_("{what} is listed more than once")],
    ["SL_UNLISTED", I18N.N_("{what} is not in your listing")],
    ["SS_TOO_MANY_COINS", I18N.N_("more than {count} payment coins came for this order; check the payment by hand")],   // main/shop-store.js (0.19.170)

    // ---- Minima Vestr (main/vestr.js: pinned, its exact English) ----
    ["VESTR_AMOUNT", I18N.N_("Enter a valid amount to lock")],
    ["VESTR_BENEFICIARY", I18N.N_("Enter a beneficiary address")],
    ["VESTR_TOKEN", I18N.N_("Invalid token id")],
    ["VESTR_BURN", I18N.N_("Invalid burn amount")],
    ["VESTR_PASSWORD", I18N.N_("The wallet password can't contain quotes, backslashes or line breaks")],
    ["VESTR_GRACE", I18N.N_("The grace period must be a whole number of hours.")],
    ["VESTR_LOCK_MAYBE", I18N.N_("The node did not answer, so the lock may have gone. Check Vestr and your balance before you lock again.")],
    ["VESTR_COLLECT_MAYBE", I18N.N_("The node did not answer the collect, so it may have gone. Check Vestr before you collect again.")],
    ["VESTR_STATE_BAD", I18N.N_("This contract coin's state is not one this app can carry. Nothing was signed.")],
    ["VESTR_GRACE_WAIT", I18N.N_("The grace period of this contract is still running, so nothing can be collected yet. Nothing was sent.")],
    ["VESTR_ALREADY_SPENDING", I18N.N_("A collect of this coin is already waiting for the chain, or the coin is already spent. Nothing was sent.")],
    ["VESTR_TIP_UNREAD", I18N.N_("The node's block height could not be read, so nothing was built. Nothing was sent.")],
    ["VESTR_TXNCHECK_INVALID", I18N.N_("The node checked this collect and judged it invalid, so it was not sent. Nothing was collected.")],
    ["VESTR_OVER_COIN", I18N.N_("The node's figure to collect is more than this contract coin holds. Nothing was sent.")],
    ["VESTR_PASSWORD_SEMI", I18N.N_("The wallet password can't contain ; (the node would read what follows as a second command). Nothing was sent.")],
    // ---- Chat (main/chat.js, 0.19.196): a path a node command cannot carry, said before anything is sent ----
    ["CHAT_PATH", I18N.N_("This file's name or folder holds a ; or a \" , which a node command cannot carry. Rename the file or move it to another folder, then try again.")],
    ["CHAT_PAY_MAYBE", I18N.N_("The node did not answer, so the payment may have gone. Check your balance and History before you send it again.")],
    ["CHAT_PAY_ADDR_UNCHECKED", I18N.N_("The recipient's pay address could not be checked by the node, so nothing was sent.")],
    ["CHAT_DATA_FOLDER", I18N.N_("The app's data folder name holds a character a node command cannot carry.")],
    ["VESTR_END", I18N.N_("End must be after start")],
    ["VESTR_BENEFICIARY_BAD", I18N.N_("Invalid beneficiary address")],
    ["VESTR_LOCK_FAILED", I18N.N_("Lock failed")],
    ["VESTR_COIN_ID", I18N.N_("Invalid coin id")],
    ["VESTR_NO_COIN", I18N.N_("Contract coin not found (already collected?)")],
    ["VESTR_NOTHING", I18N.N_("Nothing available to collect yet")],
    ["VESTR_STEP", I18N.N_("collect step failed: {error}")],

    // ---- Web Wallet (main/webwallet.js: pinned, its exact English) ----
    ["WW_STORE_BAD", I18N.N_("The Web Wallet's key-use record could not be read, so nothing was sent (a send now could use a one-time key twice). Check the file webwallet-keyuses.json in the app's data folder.")],
    ["WW_KEYS_UNREAD", I18N.N_("The node's keys could not be read, so the app cannot tell whether this is the node's own wallet. Nothing was sent.")],
    ["WW_KEYUSES_COUNT", I18N.N_("The key uses must be a whole number of at least 0.")],
    ["WW_ADDRESS", I18N.N_("bad address")],
    ["WW_SEED", I18N.N_("Enter your seed phrase (a \" or \\ or line break can't be carried safely)")],
    ["WW_MEGAMMR", I18N.N_("Web Wallet needs a MegaMMR node")],
    ["WW_DERIVE", I18N.N_("Could not derive wallet from seed")],
    ["WW_SEED_BAD", I18N.N_("Invalid seed phrase")],
    ["WW_RECIPIENT", I18N.N_("Invalid recipient address")],
    ["WW_AMOUNT", I18N.N_("Invalid amount")],
    ["WW_RECIPIENT_CHECK", I18N.N_("Recipient address failed validation")],
    ["WW_SIGNING", I18N.N_("Could not derive signing key")],
    ["WW_KEY_CHECK", I18N.N_("Derived key material failed validation")],
    ["WW_ACK", I18N.N_("Confirm this wallet's key-uses count before sending")],
    ["WW_DAMAGED_SEND", I18N.N_("This wallet's saved key-use count is damaged. Confirm its key uses again (at least what the chain shows) before sending. Nothing was sent.")],
    ["WW_DAMAGED_UNREAD", I18N.N_("This wallet's saved key-use count is damaged, and the chain's figure for this key could not be read (the key-use service may be unreachable). Nothing was saved; confirm again when it can be read.")],
    ["WW_FIRST_UNREAD", I18N.N_("The chain's figure for this key could not be read (the key-use service may be unreachable), so the count you confirm cannot be checked against it. Nothing was saved; confirm again when it can be read.")],
    ["WW_BELOW_CHAIN", I18N.N_("The chain shows {chain} uses of this key. Confirm at least that many. Nothing was saved.")],
    ["WW_BLOCK_OFF", I18N.N_("The Web Wallet is not available on a block key wallet yet: here a seed gives a different address than on a classic wallet or the official Web Wallet, and the key-use count does not protect it. Nothing was done.")],
    ["WW_ABOVE_LAST", I18N.N_("The key-use count can be at most 262143 (a key of this wallet has 262144 one-time uses, numbered 0 to 262143). Nothing was saved.")],
    ["WW_USED_UP", I18N.N_("The chain's figure for this key ({chain}) is at or above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). The figure can count more uses than the key signed, but this app will not sign from this address: signing past the last use would reuse a one-time key, which can lose funds. Nothing was saved.")],
    ["WW_REACHED_SENT", I18N.N_("This wallet's count for this key has reached the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.")],
    ["WW_REACHED_SAVED", I18N.N_("This wallet's count for this key has reached the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was saved.")],
    ["WW_STORED_OVER", I18N.N_("This wallet's saved key-use count ({count}) is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was sent.")],
    ["WW_DAMAGED_OVER", I18N.N_("This wallet's saved key-use count ({count}) is above the limit of a key of this wallet (262144 one-time uses, numbered 0 to 262143). It was probably confirmed too high before this version checked it, and the true count cannot be known here, so it is not lowered. This app will not sign from this address: signing past the last use (262143) would reuse a one-time key, which can lose funds. Nothing was saved.")],
    ["WW_DAMAGED_BELOW", I18N.N_("This key's saved count read {count} before it was damaged. Confirm at least that many. Nothing was saved.")],
    ["WW_UNKNOWN", I18N.N_("Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying.")],
    ["WW_UNKNOWN_TWICE", I18N.N_("Send status UNKNOWN — the node didn't confirm. The payment may have gone through; refresh balances and check History before retrying (a blind retry could pay twice).")],

    // ---- Minima Faucet (main/faucet.js: pinned, its exact English) ----
    ["FAUCET_NO_DATA", I18N.N_("Faucet returned no data.")],
    ["FAUCET_UNREACHABLE", I18N.N_("Couldn't reach the faucet.")],
    ["FAUCET_ADDRESS", I18N.N_("Enter a valid Mx… / 0x… address.")],

    // ---- Minima Explorer (main/explorer.js) ----
    ["EXPLORER_QUERY", I18N.N_("Not a block number, a TxPoW ID or an address.")],

    // ---- KeyUses (main/keyuses.js) ----
    ["KU_UNAVAILABLE", I18N.N_("The node’s keys could not be read. Check that the node is running, then run the audit again.")],
    ["KU_CHANGED", I18N.N_("The node’s keys changed during the audit. Run it again.")],
    ["KU_NETWORK", I18N.N_("Could not reach the audit service. Check your connection and try again.")],
    ["KU_SELFTEST", I18N.N_("Address verification failed. This build cannot run a reliable audit.")],

    // ---- Updates (main/updater.js) ----
    ["UPD_OFF", I18N.N_("{product} does not update itself. A newer build is installed by hand.")],
    ["UPD_URL", I18N.N_("refusing a non-https update URL: {url}")],
    ["UPD_FEED", I18N.N_("the update feed must be https")],
    ["UPD_NONE", I18N.N_("no update to download")],
    ["UPD_DOWNLOAD", I18N.N_("refusing a non-https download")],
    ["UPD_NO_SHA", I18N.N_("the feed carries no sha256 for this platform — refusing to download")],
    ["UPD_SHA", I18N.N_("sha256 mismatch — the download does not match the feed; not saved")],
    ["UPD_SIZE", I18N.N_("size mismatch — the download does not match the feed; not saved")],

    // ---- The rest of main/main.js (backups, files, the Terminal) ----
    ["MAIN_NODE_DOWN", I18N.N_("node not running")],
    ["MAIN_EMPTY", I18N.N_("empty command")],
    ["STOP_BUSY", I18N.N_("The node is already being stopped or restarted, or the question about it is still open. Nothing more was done.")],   // main/inflight.js stopGuard (0.19.313, 0.19.316)
    ["MAIN_NOT_STOPPED", I18N.N_("The node keeps running: nothing was stopped.")],
    ["MAIN_LANGUAGE", I18N.N_("Unknown language.")],
    ["MAIN_JAR_UPDATER", I18N.N_("The in-app node updater is disabled.")],
    ["MAIN_NOT_VERIFIED", I18N.N_("The file is not verified yet.")],
    ["MAIN_PASSWORD_8", I18N.N_("Use a password of at least 8 characters.")],
    ["MAIN_BACKUP_PASSWORD", I18N.N_("Enter the backup's password.")],
    ["MAIN_CHAT_TOO_LARGE", I18N.N_("That file is too large to be a chat backup.")],
    ["MAIN_OPEN_AGAIN", I18N.N_("Open the backup again.")],
    ["MAIN_PASSPHRASE_8", I18N.N_("Use a passphrase of at least 8 characters.")],
    ["MAIN_BACKUP_PASSPHRASE", I18N.N_("Enter the backup passphrase.")],
    ["MAIN_NO_ENGINE", I18N.N_("No such engine.")],
    ["MAIN_TOO_LARGE_64", I18N.N_("That file is larger than 64 MB.")],
    ["MAIN_SHOP_FILE", I18N.N_("Not a valid .shop file.")],
    // ---- the commands that show what controls the funds (main/main.js, main/seedgate.js, 0.19.176) ----
    ["HTTP_TOO_LONG_NONASCII", I18N.N_("This command holds characters outside plain ASCII and is too long for the node's command line (over 65,536 characters once encoded). Shorten it, or write those characters in plain ASCII. Nothing was sent.")],   // main/rpc.js (0.19.305)
    ["RPC_ONE_COMMAND", I18N.N_("This command holds \";\", which would start a second command. Nothing was sent.")],
    ["RPC_SMUGGLED", I18N.N_("This command holds a character written as an escape code (a semicolon or a control character), which the node would decode and could run as a second command. Nothing was run.")],
    ["RPC_BUILT", I18N.N_("This command builds further commands from its values, and one of them holds white space, a colon, a quote or a backslash escape that would change those commands. Nothing was run.")],
    ["RPC_TXNDATA", I18N.N_("The data: of this command must be 0x hex holding a transaction whose id is plain letters, digits, \".\", \"-\" or \"_\": the node pastes that id into the commands it runs itself. Nothing was run.")],
    ["RPC_MSKEY", I18N.N_("Each multisig public key, and the root key, must be 0x followed by 64 hexadecimal digits. Nothing was run.")],
    ["RPC_UNCLEAR", I18N.N_("The node would read this command differently from how it is written (a quote inside a word or glued to the next one, a colon inside quotes, or a { or [ outside a JSON value). Write it without them. Nothing was run.")],
    ["MAIN_CMD_REPEATED", I18N.N_("This command names {names} more than once (the node would use only the last). Write each once. Nothing was run.")],
    ["MAIN_OPENS_NODE", I18N.N_("This command would open this node to someone else or send its events out (the RPC login or password, a master node, a web hook, MiniDapps). This app never needs that, so it is not run from the Terminal. Nothing was run.")],
    ["MAIN_UNC_FILE", I18N.N_("A file on another computer (a path that starts with \\\\ or //) is not used: the node would connect to it. Copy the file to this computer first. Nothing was run.")],
    ["MAIN_MDS_ACCEPT", I18N.N_("mds action:accept runs a MiniDapp's waiting command with full rights, past every check of this app. It is not run from the Terminal. Nothing was run.")],
    ["MAIN_MULTISIG_SPEND", I18N.N_("A multisig spend copies the coin's state from the chain into commands the node runs itself, where it could start a second command, and this app cannot read that state first. It is not run from the Terminal. Nothing was run.")],
    ["MAIN_SEND_REPEATED", I18N.N_("This send names {names} more than once (the node would use only the last). Write each once.")],
    ["MAIN_REPLACES_KEYS", I18N.N_("This command replaces this wallet's keys or loads a backup outside Backup & Recovery, which checks the key mode and stops the trading engines first. Use Backup & Recovery. Nothing was run.")],
    ["MAIN_CONTROL_CHAR", I18N.N_("This command holds a control character. Type it again without one.")],
    ["SG_GATED_SEED", I18N.N_("vault, seedrandom and keys action:genkey show a seed or a private key; this one shows the seed phrase. Type SHOW SEED in the Terminal to run it.")],
    ["SG_GATED_KEY", I18N.N_("vault, seedrandom and keys action:genkey show a seed or a private key; this one shows a private key. Type SHOW KEY in the Terminal to run it.")],
    ["SG_GATED_CHANGE", I18N.N_("This vault command changes this wallet's keys or their lock. Type CHANGE KEYS in the Terminal to run it.")],
    ["SG_EMPTY_SECRET", I18N.N_("This command names {name}: with no value, and the node would read it as empty. Write its value, or leave it out. Nothing was run.")],
    ["SG_GATED_SECRET", I18N.N_("This command shows passwords or a private key (rpc action:listusers, mds, sphincs action:generate). Type SHOW KEY in the Terminal to run it.")],
    ["SC_TOO_LONG", I18N.N_("This is longer than the Touch ID prompt can show in full (120 characters, with the secret values hidden). Shorten it, for example by running it without optional parameters. Nothing was shown or run.")],
    ["SG_CHAIN", I18N.N_("vault, seedrandom and keys action:genkey show a seed or a private key, and this chain of commands holds one. Run that command on its own, not in a chain with ;.")],
    ["MAIN_FIRSTRUN_SEED", I18N.N_("The seed is shown here only while a new wallet is being made.")],
    ["SG_NO_CHECK", I18N.N_("This command needs no check.")],
    ["SG_REPEATED", I18N.N_("This command names {names} more than once (the node would keep only the last). Write each parameter once. Nothing was run.")],
    // ---- the system check of every secret gate (main/syscheck.js, 0.19.188) ----
    ["SC_TOUCHID_LOCKED", I18N.N_("Touch ID has worked in this app on this Mac before but cannot be asked now, so nothing was shown. If the lid is closed or your Touch ID keyboard is unplugged, open the lid or connect it and try again. If Touch ID is locked after too many tries, lock the screen and log in again with your password; Touch ID then works again. If this Mac no longer has Touch ID, quit the app and delete this file: {where} . The app then asks with a confirmation window instead.")],
    ["SG_NO_SEED", I18N.N_("Couldn't read the seed.")]
  ];

  var BY = {}, GROUP = {}, TOP = [];
  var rx = function (form) {   // an English form → an anchored pattern and the names of its values, in order
    var names = [], src = "^";
    String(form).split(/(\{\w+\})/).forEach(function (part) {
      var m = /^\{(\w+)\}$/.exec(part);
      if (m && names.indexOf(m[1]) >= 0) src += "\\" + (names.indexOf(m[1]) + 1);   // the same value again: the same text again
      else if (m) { names.push(m[1]); src += m[1] === "n" ? "(\\d+)" : "([\\s\\S]*?)"; }
      else src += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return { re: new RegExp(src + "$"), names: names };
  };
  T.forEach(function (row) {
    var o = row[2] || {}, en = I18N.catalog("en") || {}, plural = en[row[1]] && typeof en[row[1]] === "object";
    var e = { code: row[0], key: row[1], top: o.top !== false, nest: o.nest || null, forms: [] };
    (plural ? Object.keys(en[row[1]]).map(function (f) { return en[row[1]][f]; }) : [row[1]]).forEach(function (f) {
      if (!e.forms.some(function (x) { return x.text === f; })) { var r = rx(f); r.text = f; e.forms.push(r); }
    });
    BY[e.code] = e; if (e.top) TOP.push(e);
    [].concat(o.group || []).forEach(function (g) { (GROUP[g] = GROUP[g] || []).push(e); });
  });
  var listOf = function (sub) { return sub == null ? TOP : typeof sub === "string" ? (GROUP[sub] || []) : sub.map(function (c) { return BY[c]; }); };

  /** The whole text against these templates: { code, key, params, parts: { param: [read of each sentence] } } or null. */
  function read(text, sub, lower) {
    var s = String(text == null ? "" : text), list = listOf(sub), tries = [s];
    if (lower && /^\p{Lu}/u.test(s)) tries.push(s.charAt(0).toLowerCase() + s.slice(1));
    for (var t = 0; t < tries.length; t++) for (var i = 0; i < list.length; i++) for (var j = 0; j < list[i].forms.length; j++) {
      var f = list[i].forms[j], m = f.re.exec(tries[t]); if (!m) continue;
      var params = {}, parts = {};
      f.names.forEach(function (n, k) { params[n] = m[k + 1]; });
      if (list[i].forms.length > 1 && params.n == null && j === 0) params.n = 1;   // an English "one" form written without {n} ("1 offer")
      var nest = list[i].nest || {};
      Object.keys(nest).forEach(function (p) {
        if (params[p] == null) return;
        var how = nest[p], bits = how.split ? params[p].split(how.split) : [params[p]];
        parts[p] = bits.map(function (b) { return { text: b, said: read(b, how.sub, how.lower), value: !!how.value }; });
      });
      return { code: list[i].code, key: list[i].key, params: params, parts: parts, lowered: t > 0 };
    }
    return null;
  }
  var capFirst = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
  function render(r) {
    var p = Object.assign({}, r.params);
    Object.keys(r.parts).forEach(function (name) {
      var how = BY[r.code].nest[name];
      p[name] = r.parts[name].map(function (b) { return b.said ? (b.said.lowered ? capFirst(render(b.said)) : render(b.said)) : b.text; }).join(how.split || "");
    });
    return I18N.t(r.key, p);
  }
  /** The message in the language on show; as it came when it is not listed here. group: read it as one of that group's sentences only (a value a screen shows, such as what holds a coin). */
  function say(text, group) { var r = read(text, group); return r ? render(r) : String(text == null ? "" : text); }
  /** Is this message, or a sentence inside it, the given code? */
  function has(text, code) {
    var walk = function (r) { return !!r && (r.code === code || Object.keys(r.parts).some(function (p) { return r.parts[p].some(function (b) { return walk(b.said); }); })); };
    return walk(typeof text === "object" && text && text.code ? text : read(text));
  }
  return { say: say, read: read, has: has, codes: function () { return T.map(function (r) { return r[0]; }); }, template: function (code) { return BY[code] ? BY[code].key : null; } };
});
