/* termcomplete.js — IDE-style completion engine for the Terminal tab.
 *
 * Straight JS port of the Terminal IDE APK's completion stack
 * (apks/terminalide/.../terminal/CommandRegistry.java + ParamDocs.java + Suggest.java —
 * those files are the source of truth; keep this port line-for-line diffable).
 * Help descriptions come from window.TERM_HELP (termhelp.js, generated from the
 * node's own `help command:x` pages).
 *
 * Produces a tightly scoped dropdown for whichever token the caret is in:
 *   "me"                 -> commands starting with "me" (then substring matches)
 *   "megammr "           -> ONLY that command's params, required first, unused only
 *   "megammr ac"         -> its params starting with "ac"
 *   "megammr action:"    -> ONLY the allowed values of action
 *   "megammr action:e"   -> values starting with "e"
 *   "... action:export " -> the remaining unused params
 * Empty input suggests nothing. Works at any depth in the line, inside ; chains
 * (the segment around the caret is completed independently), and stays quiet
 * while the caret is inside a quoted string.
 */
(function (root) {

  // ---- Command registry (port of CommandRegistry.java) -----------------------
  // Extracted from the node source (v1.1.2.3): CommandRunner.ALL_COMMANDS +
  // each command's getValidParams()/getBooleanParam/action-equals chains.
  // Line format:  name :: param1<v1,v2> param2 param3<true,false>
  // A <...> list means suggestable values (free-form input may still be allowed).
  const DATA = [
    "quit :: compact<true,false>",
    "status :: clean<true> debug<true,false> complete<true,false>",
    "coins :: relevant<true> sendable<true,false> coinid amount address tokenid checkmempool<true,false> order<asc,desc> coinage simplestate<true,false> totalamount depth state megammr<true,false>",
    "txpow :: txpowid block address onchain relevant<true> max action<info> inblock",
    "connect :: host",
    "disconnect :: uid<all>",
    "network :: action<list,reset,recalculateip,restart,loggingon,loggingoff>",
    "message :: uid data",
    "trace :: enable<true,false> filter network<true,false>",
    "help :: command",
    "printtree :: depth cascade<true,false>",
    "automine ::",
    "printmmr ::",
    "rpc :: enable<true,false> ssl<true,false> password action<adduser,removeuser,listusers> username mode<read,write>",
    "send :: action uid address amount multi tokenid state burn coinage split debug<true,false> dryrun<true,false> mine<true,false> password storestate<true,false> fromaddress signkey",
    "balance :: address tokenid confirmations tokendetails<true,false> megammr<true,false> simple<true,false> coinlist<true,false>",
    "tokencreate :: name amount decimals script state signtoken webvalidate burn mine<true,false> uselimits<true,false>",
    "tokenvalidate :: tokenid",
    "tokens :: tokenid action<export,import> data",
    "getaddress ::",
    "newaddress ::",
    "debugflag :: activate<true,false> var",
    "incentivecash :: uid",
    "webhooks :: enable<true,false> action<list,add,remove,clear,errorlogs> hook filter",
    "peers :: action<list,forcecheck,addpeers,publish,fetch> peerslist max file url",
    "p2pstate ::",
    "sendpoll :: action<add,list,remove> uid address amount multi tokenid state burn coinage split debug<true,false> dryrun<true,false> mine<true,false> password storestate<true,false> fromaddress signkey",
    "healthcheck ::",
    "mempool ::",
    "block ::",
    "reset :: action<chainsync,seedsync,restore> archivefile file password phrase keys keyuses",
    "whitepaper ::",
    "sendnosign :: address amount multi tokenid state burn split debug<true,false> dryrun<true,false> file",
    "sendsign :: file password",
    "sendpost :: file",
    "sendview :: file",
    "sendfrom :: fromaddress address amount tokenid script privatekey keyuses mine<true,false> burn state split",
    "createfrom :: fromaddress address amount tokenid script burn",
    "rawfrom :: inputs outputs state",
    "rawtxnfrom :: inputs outputs scripts state",
    "signfrom :: id data privatekey keyuses post<true,false>",
    "postfrom :: data mine<true,false> mmr<true,false>",
    "constructfrom :: coinlist script toaddress toamount changeaddress changeamount tokenid",
    "consolidatefrom :: fromaddress tokenid script privatekey keyuses mine<true,false> burn maxcoins",
    "createtokenfrom :: fromaddress name amount privatekey keyuses script decimals mine<true,false>",
    "archive :: action<resync,integrity,export,exportraw,import,importold,importraw,inspect,inspectraw,addresscheck> host phrase anyphrase<true,false> keys keyuses file address statecheck logs<true,false> maxexport",
    "logs :: scripts<true,false> mining<true,false> maxima<true,false> blocks<true,false> networking<true,false> ibd<true,false> peerschecker<true,false> txpowdb<true,false>",
    "history :: depth max offset action<list,size,customsize,transactions> relevant<true,false> startmilli where",
    "convert :: from<hex,mx,string,base64> to<hex,mx,string,base64> data",
    "maths :: calculate logs<true,false>",
    "restoresync :: file password host",
    "timemilli :: minutesback hoursback",
    "decryptbackup :: file password output",
    "megammrsync :: action<mydetails,resync> host phrase anyphrase<true,false> keys keyuses file password",
    "systemcheck :: processor action<list,details>",
    "scanchain :: depth offset",
    "multisig :: id action<create,getkey,list,spend,sign,post,view> root required file publickeys amount tokenid coinid address password mine<true,false>",
    "multisigread :: id action<getkey,list,spend,post,view> root required file publickeys amount tokenid coinid address password",
    "checkaddress :: address",
    "sphincs :: action<generate,sign,verify,transaction,test> seed data privatekey file publickey signature amount address tokenid mine<true,false>",
    "ping :: host",
    "random :: size type<sha2,sha3>",
    "seedrandom :: modifier",
    "mysql :: action<info,setlogin,clearlogin,integrity,update,autobackup,resync,wipe,addresscheck,h2import,h2export,size,rawexport,rawimport,reset,fixmissing,findtxpow> host database user password keys keyuses phrase address txpowid enable<true,false> file statecheck logs<true,false> maxexport readonly<true,false> startfix endfix block",
    "mysqlcoins :: action<info,wipe,autobackup,update,search> host database user password logs<true,false> readonly<true,false> query where maxblocks maxcoins hidetoken<true,false> address spent<true,false> limit enable<true,false>",
    "slavenode :: host enable<true,false>",
    "jnitest :: testnonce maxattempts targetdifficulty",
    "benchmark :: hashes testnonce maxattempts targetdifficulty",
    "jniminingtest :: maxattempts testnonce targetdifficulty",
    "megammr :: action<info,export,import,integrity> file",
    "vault :: action<seed,wipekeys,restorekeys,passwordlock,passwordunlock,testphrase,resetkeys> seed keyuses phrase password confirm numkeys",
    "consolidate :: tokenid coinage maxcoins maxsigs burn debug<true,false> dryrun<true,false> password",
    "coinnotify :: action<add,remove,check> address",
    "backup :: debug<true,false> password file auto<true,false> confirm maxhistory",
    "restore :: file password shutdown<true,false>",
    "test :: show action",
    "runscript :: script state prevstate globals signatures extrascripts",
    "tutorial ::",
    "keys :: action<list,checkkeys,new,genkey,createallkeys> publickey phrase modifier keyuses",
    "scripts :: address",
    "newscript :: script trackall<true,false> clean<true,false>",
    "removescript :: address",
    "burn ::",
    "txnbasics :: id",
    "txncreate :: id",
    "txninput :: id coinid coindata floating<true,false> address amount tokenid scriptmmr<true,false>",
    "txnlist :: id transactiononly<true,false>",
    "txnclear :: id scripts<true,false> mmr<true,false> signatures<true,false>",
    "txnview :: file data",
    "txnoutput :: id amount address tokenid storestate<true,false>",
    "txnstate :: id port value",
    "txnsign :: id publickey<auto> txndelete<true,false> txnpostauto<true,false> txnpostburn txnpostmine<true,false> password privatekey keyuses",
    "txnpost :: id auto<true,false> burn mine<true,false> txndelete<true,false>",
    "txndelete :: id",
    "txnexport :: id file showtxn<true,false>",
    "txnimport :: id file data",
    "txncheck :: id",
    "txnscript :: id scripts auto<true,false>",
    "txnauto :: id amount address tokenid sign<true,false> burn mmrscript<true,false>",
    "txnaddamount :: id amount address onlychange<true,false> tokenid fromaddress burn storestate<true,false> split",
    "txnlock :: action<lock,unlock,list> timeout unlockdelay",
    "txnmmr :: id",
    "txnmine :: id data",
    "txnminepost :: data",
    "txncoinlock :: action<lock,unlock>",
    "coinimport :: data track<true,false>",
    "coinexport :: coinid",
    "cointrack :: enable<true,false> coinid",
    "coincheck :: data",
    "hash :: data type<sha2,sha3> file",
    "hashtest :: amount",
    "sign :: publickey data",
    "verify :: publickey data signature",
    "mmrcreate :: nodes",
    "mmrproof :: data proof root",
  ];

  let CMDS = null; // Map name -> {name, params:[{name, values:[]}]} (insertion-ordered)

  function parseLine(line) {
    // NOTE: Java's split("::", 2) keeps the remainder; JS split(sep, 2) truncates it.
    const sep = line.indexOf("::");
    const name = (sep < 0 ? line : line.slice(0, sep)).trim();
    if (!name) return null;
    const params = [];
    if (sep >= 0) {
      for (const tok of line.slice(sep + 2).trim().split(/\s+/)) {
        if (!tok) continue;
        const lt = tok.indexOf("<");
        if (lt >= 0 && tok.endsWith(">")) {
          params.push({ name: tok.slice(0, lt), values: tok.slice(lt + 1, -1).split(",").filter(Boolean) });
        } else {
          params.push({ name: tok, values: [] });
        }
      }
    }
    return { name, params };
  }

  function cmds() {
    if (!CMDS) {
      CMDS = new Map();
      for (const line of DATA) { const c = parseLine(line); if (c) CMDS.set(c.name, c); }
    }
    return CMDS;
  }

  function getCmd(name) { return cmds().get(name) || null; }

  /** One-line usage: "send  address:  amount:  debug:true|false …" */
  function usage(name) {
    const cmd = typeof name === "string" ? getCmd(name) : name;
    if (!cmd) return "";
    if (!cmd.params.length) return cmd.name;
    return cmd.name + cmd.params.map((p) => "  " + p.name + ":" + p.values.join("|")).join("");
  }

  // ---- Help store + param docs (port of HelpStore.java + ParamDocs.java) -----
  function helpStore() { return root.TERM_HELP || {}; }
  function helpBrief(command) { const h = helpStore()[command]; return (h && h.help) || null; }
  function helpFull(command) { const h = helpStore()[command]; return (h && h.fullhelp) || null; }

  const DOCS_CACHE = new Map(); // command -> Map(param -> {required, desc})

  /* fullhelp lists each parameter as:
   *     amount: (optional)
   *         The amount to send.
   * A bare "id:" line (no "(optional)" marker) means the parameter is required —
   * but only when at least one sibling param IS marked optional; commands whose
   * help marks nothing are treated as all-optional rather than all-required. */
  function docsFor(command) {
    const cached = DOCS_CACHE.get(command);
    if (cached) return cached;

    const docs = new Map();
    const cmd = getCmd(command);
    const full = helpFull(command);
    if (cmd && full != null) {
      const isParamOf = (n) => cmd.params.some((p) => p.name === n);
      const lines = full.split("\n");
      // First pass: find each "param:" header line and whether any is marked (optional).
      const headerAt = new Map();
      const optionalMark = new Map();
      let anyMarked = false;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const colon = t.indexOf(":");
        if (colon <= 0) continue;
        const name = t.slice(0, colon).trim();
        if (!isParamOf(name) || headerAt.has(name)) continue;
        const after = t.slice(colon + 1).trim();
        // A header line is "name:" possibly followed only by an (optional)/(required) tag.
        const optional = after.includes("(optional)");
        if (after && !after.startsWith("(")) continue; // prose line, not a header
        headerAt.set(name, i);
        optionalMark.set(name, optional);
        if (optional) anyMarked = true;
      }
      // Second pass: first non-empty line under each header = the description.
      for (const [name, at] of headerAt) {
        let desc = "";
        for (let i = at + 1; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t) continue;
          // Ran into the next param header or the examples section.
          if (t.startsWith("Examples")) break;
          const c = t.indexOf(":");
          if (c > 0 && isParamOf(t.slice(0, c).trim())) break;
          desc = t;
          break;
        }
        docs.set(name, { required: anyMarked && !optionalMark.get(name), desc });
      }
    }
    DOCS_CACHE.set(command, docs);
    return docs;
  }

  /** One-line description of a command itself (help "help" string, minus the param spam). */
  function commandBrief(command) {
    const brief = helpBrief(command);
    if (brief == null) return "";
    const i = brief.lastIndexOf(") - ");
    if (i >= 0) return brief.slice(i + 4).trim();
    if (brief.startsWith("- ")) return brief.slice(2).trim();
    return brief.trim();
  }

  // ---- Suggest engine (port of Suggest.java) ---------------------------------
  const KIND_COMMAND = 0, KIND_PARAM = 1, KIND_VALUE = 2;

  /* One dropdown row. Accepting it splices `insert` into the input in place of the
   * token being completed: newText = text[0..tokenStart) + insert + text[caret..end).
   * {label, tokenStart, insert, desc, required, kind} */
  function item(label, tokenStart, insert, desc, required, kind) {
    return { label, tokenStart, insert, desc: desc || "", required: !!required, kind };
  }

  /** Complete the token ending at `caret` (not the end of the string) so completion
   *  works even when the user edits mid-line. Returns {items:[], paramHint:null|string}. */
  function suggest(text, caret) {
    const r = { items: [], paramHint: null };
    text = String(text == null ? "" : text);
    if (caret == null || caret < 0 || caret > text.length) caret = text.length;
    const upto = text.slice(0, caret);

    // Complete only the segment after the last ';' before the caret (multi-command chains).
    const segStart = upto.lastIndexOf(";") + 1;
    const seg = upto.slice(segStart);

    // Inside an unclosed quoted string (script:"..."): free text, no completion.
    let quotes = 0;
    for (let i = 0; i < seg.length; i++) if (seg[i] === '"') quotes++;
    if (quotes & 1) return r;

    let lead = 0;
    while (lead < seg.length && seg[lead] === " ") lead++;
    const body = seg.slice(lead);

    const firstSpace = body.indexOf(" ");
    if (firstSpace < 0) {
      // Typing the command name itself. Empty input -> quiet dropdown.
      // Exact command fully typed (no trailing space yet): its params come FIRST
      // (appended after the command word) so Tab flows into the chosen command,
      // ahead of longer sibling commands (send -> params before sendpoll…).
      const exact = getCmd(body);
      if (exact) {
        r.paramHint = usage(exact);
        addParamItems(r, exact, seg, "", caret, " ");
      }
      if (body) {
        const tokStart = segStart + lead;
        const prefix = [], contains = [];
        for (const c of cmds().values()) {
          if (c.name === body) continue;
          const desc = commandBrief(c.name);
          if (c.name.startsWith(body)) prefix.push(item(c.name, tokStart, c.name + " ", desc, false, KIND_COMMAND));
          else if (c.name.includes(body)) contains.push(item(c.name, tokStart, c.name + " ", desc, false, KIND_COMMAND));
        }
        r.items.push(...prefix, ...contains);
      }
      return r;
    }

    const cmd = getCmd(body.slice(0, firstSpace));
    if (!cmd) return r;
    r.paramHint = usage(cmd);

    // The token in progress = after the last space before the caret.
    const lastSpace = seg.lastIndexOf(" ");
    const token = seg.slice(lastSpace + 1);
    const tokStart = segStart + lastSpace + 1;

    const colon = token.indexOf(":");
    if (colon >= 0) {
      // Param value completion — only the legal values of THIS param.
      const key = token.slice(0, colon);
      const partial = token.slice(colon + 1);
      const helpCmd = cmd.name === "help" && key === "command";
      for (const v of valuesFor(cmd, key)) {
        if (!v.startsWith(partial)) continue;
        // v === partial still offered: Tab then just appends the space.
        r.items.push(item(v, tokStart, key + ":" + v + " ", helpCmd ? commandBrief(v) : "", false, KIND_VALUE));
      }
    } else {
      // Param name completion — only THIS command's params, unused ones.
      addParamItems(r, cmd, seg, token, tokStart, "");
    }
    return r;
  }

  /** Adds this command's unused params matching `token`, required params first. */
  function addParamItems(r, cmd, seg, token, tokStart, prefix) {
    const docs = docsFor(cmd.name);
    const required = [], optional = [];
    for (const p of cmd.params) {
      if (!p.name.startsWith(token)) continue;
      if (seg.includes(" " + p.name + ":")) continue; // already used in this segment
      const d = docs.get(p.name);
      const req = !!(d && d.required);
      let desc = d ? d.desc : "";
      if (!desc && p.values.length) desc = p.values.join(" | ");
      (req ? required : optional).push(item(p.name + ":", tokStart, prefix + p.name + ":", desc, req, KIND_PARAM));
    }
    r.items.push(...required, ...optional);
  }

  function valuesFor(cmd, key) {
    // help command:<x> completes with every command name.
    if (cmd.name === "help" && key === "command") return [...cmds().keys()];
    for (const p of cmd.params) if (p.name === key) return p.values;
    return [];
  }

  /** Applies an item against the CURRENT text + caret (re-derived at accept time). */
  function apply(text, caret, it) {
    if (caret == null || caret < 0 || caret > text.length) caret = text.length;
    const start = Math.min(it.tokenStart, caret);
    return text.slice(0, start) + it.insert + text.slice(caret);
  }

  /** New caret position after applying `it`. */
  function applyCaret(text, caret, it) {
    if (caret == null || caret < 0 || caret > text.length) caret = text.length;
    return Math.min(it.tokenStart, caret) + it.insert.length;
  }

  const TermComplete = { suggest, apply, applyCaret, usage, commandBrief, KIND_COMMAND, KIND_PARAM, KIND_VALUE };
  if (typeof module !== "undefined" && module.exports) module.exports = TermComplete;
  else root.TermComplete = TermComplete;
})(typeof globalThis !== "undefined" ? globalThis : this);
