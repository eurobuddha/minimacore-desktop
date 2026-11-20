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
 *   say(text)          the message in the language on show (English when it is not listed)
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
    ["FZ_READ_LATE", I18N.N_("what is in flight could not be read in time"), { top: false, group: "FREEZE_ITEMS" }],
    ["FZ_READ_FAILED", I18N.N_("what is in flight could not be read"), { top: false, group: "FREEZE_ITEMS" }],

    // ---- Restoring a backup, and replacing the wallet (main/restore.js) ----
    ["RESTORE_PICK_MODE", I18N.N_("Choose which kind of wallet made this backup.")],
    ["NO_WALLET_YET", I18N.N_("No wallet has been set up yet. Choose New Wallet or Restore Wallet first.")],
    ["RESTORE_BLOCK_UNSUPPORTED", I18N.N_("This backup holds a block key wallet, and the node in this version of the app runs classic keys only. Restoring it here would put block keys into a node that goes on making classic ones, and the two kinds would be mixed for good. Nothing was changed.\n\nWhat you can do: keep using that wallet in the app that made it (for example Pandamonium on the phone), or send its funds from there to an address of this wallet (Receive). Typing its 24 words in here would not bring it over: the same words give a different, empty wallet with classic keys.")],
    ["RESTORE_MIX_CLASSIC", I18N.N_("This install holds a classic key wallet, and that cannot be changed. This backup holds a block key wallet, so restoring it here would mix the two kinds of key for good. Nothing was changed.\n\nWhat you can do: restore it in a fresh install of the app, or send its funds to an address of this wallet from the app that made it.")],
    ["RESTORE_MIX_BLOCK", I18N.N_("This install holds a block key wallet, and that cannot be changed. This backup holds a classic key wallet, so restoring it here would mix the two kinds of key for good. Nothing was changed.\n\nWhat you can do: restore it in a fresh install of the app, or send its funds to an address of this wallet from the app that made it.")],
    ["RESTORE_HOST", I18N.N_("MegaMMR host must be host:port.")],
    ["RESTORE_FILE_EMPTY", I18N.N_("Enter the backup file's name or path.")],
    ["RESTORE_FILE_SPACES", I18N.N_("File path can't contain spaces or quotes.")],
    ["RESTORE_PASSWORD_SPACES", I18N.N_("Password can't contain spaces or quotes.")],
    ["RESTORE_FILE_SEMICOLON", I18N.N_("The file path contains a semicolon (;), which the node reads as the end of the command. Rename the file or move it, then try again.")],
    ["RESTORE_PASSWORD_SEMICOLON", I18N.N_("The password contains a semicolon (;), which the node reads as the end of the command, so this app cannot pass it. Restore this backup from the node's own command line.")],
    ["BACKUP_PASSWORD", I18N.N_("A backup password can hold letters and numbers only.")],
    ["RESTORE_NODE_STOPPED", I18N.N_("The node is not running. Start the node before restoring.")],
    ["REPLACE_OPEN", I18N.N_("This would replace the wallet while work that needs its keys is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again. A swap that loses its wallet can be neither claimed nor refunded by this app."), { nest: { items: { split: "\n• ", sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_GO_ON", I18N.N_("{items}\n\nIf you go on:\n• A store that could not be opened or checked is kept beside the new one under a dated name. Nothing is deleted.\n• Whatever needs THIS wallet's keys (a pool's reserves, a swap to claim or refund, an order on the chain) can afterwards be reached only by restoring this wallet again.\n\nGo on only if you have this wallet's 24 words."), { nest: { items: { split: "\n\n", sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_GO_ON_DEXICON", I18N.N_("Dexicon cannot be checked, so the app cannot see whether this wallet still has Dexicon orders on the chain or a trade that was sent and not yet answered.\n\nIf you go on:\n• The Dexicon store is kept beside the new one under a dated name. Nothing is deleted.\n• A Dexicon order of this wallet that is still on the chain can then be cancelled or collected only by restoring this wallet again.\n• A trade that was sent and not answered can no longer be voided by this app.\n\nGo on only if Dexicon stays like this after the app was restarted.")],
    ["REPLACE_SKIP_HINT", I18N.N_("{x} If it stays like this, you can go on without this check."), { top: false, group: "REPLACE_ITEMS", nest: { x: { sub: "REPLACE_ITEMS" } } }],
    ["REPLACE_CONFIRM_HINT", I18N.N_("{x} You can go on after confirming this."), { top: false, group: "REPLACE_ITEMS", nest: { x: { sub: "REPLACE_ITEMS" } } }],
    ["RP_AX_UNASKED", I18N.N_("AtomiX could not be asked whether a swap is in flight. Wait a moment and try again."), { top: false, group: "REPLACE_ITEMS" }],
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
    ["KM_CFG_OWNED", I18N.N_("{arg} cannot be set in the extra arguments. The app sets it itself.")],
    ["KM_CFG_UNKNOWN", I18N.N_("Unknown key mode.")],
    ["KM_CFG_FIXED_CLASSIC", I18N.N_("This wallet's key mode is classic and cannot be changed.")],
    ["KM_CFG_FIXED_BLOCK", I18N.N_("This wallet's key mode is block and cannot be changed.")],

    // ---- Starting the node, switching its kind, replacing its wallet (main/node-manager.js) ----
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
    ["NODE_HINT_DB", I18N.N_("another node still holds this data folder's databases. Start again: if it is this app's own earlier node it is stopped first")],
    ["PARLONS_SOLO", I18N.N_("The Parlons Node is a mainnet node: a solo/private network needs the plain Minima node.")],
    ["PARLONS_DBPASSWORD", I18N.N_("The Parlons Node cannot take -dbpassword (a wallet DB password): keep the plain Minima node, or set up again without one.")],
    ["PARLONS_NO_JAR", I18N.N_("parlons-node.jar is not bundled in this build.")],
    ["WR_ENGINES", I18N.N_("The trading engines could not be stopped ({error}), so the wallet was not replaced. Nothing was changed.")],
    ["WR_NO_ANSWER", I18N.N_("{error}. The node did not answer, and it may still be resyncing: watch the Logs, and restart the node when it says it has finished.")],
    ["WR_STOPPED", I18N.N_("The node stopped before it answered, so the result is not known. It was started again: check the wallet and the chain before going on.")]
  ];

  var BY = {}, GROUP = {}, TOP = [];
  var rx = function (form) {   // an English form → an anchored pattern and the names of its values, in order
    var names = [], src = "^";
    String(form).split(/(\{\w+\})/).forEach(function (part) {
      var m = /^\{(\w+)\}$/.exec(part);
      if (m) { names.push(m[1]); src += m[1] === "n" ? "(\\d+)" : "([\\s\\S]*?)"; }
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
    if (o.group) (GROUP[o.group] = GROUP[o.group] || []).push(e);
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
  /** The message in the language on show; as it came when it is not listed here. */
  function say(text) { var r = read(text); return r ? render(r) : String(text == null ? "" : text); }
  /** Is this message, or a sentence inside it, the given code? */
  function has(text, code) {
    var walk = function (r) { return !!r && (r.code === code || Object.keys(r.parts).some(function (p) { return r.parts[p].some(function (b) { return walk(b.said); }); })); };
    return walk(typeof text === "object" && text && text.code ? text : read(text));
  }
  return { say: say, read: read, has: has, codes: function () { return T.map(function (r) { return r[0]; }); }, template: function (code) { return BY[code] ? BY[code].key : null; } };
});
