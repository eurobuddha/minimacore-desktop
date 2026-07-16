/*
 * params.js — the COMPLETE minima.jar startup-parameter manifest (from `java -jar minima.jar -help`).
 *
 * Dual-loaded: as a browser global (renderer <script>) to render the params editor, and via require()
 * from the main process (config.js) to compute default params + know which flags are app-managed/secret.
 *
 * Each item: { flag, type, label, help, def }
 *   type: "bool"   → emitted as `-flag`            (value true/false)
 *         "value"  → emitted as `-flag <string>`   (skipped when blank)
 *         "int"    → same as value, numeric input
 *         "secret" → same as value but stored in the macOS Keychain, never in config.json
 *
 * MANAGED flags (below) are NOT in the editor's emitted set — the app sets them itself from the core fields
 * (data folder, ports) or forces them because it depends on them (rpcenable/rpcpassword/daemon). They are
 * still SHOWN read-only so nothing is hidden. Seed is provided via the Wallet section (megammrsync), never
 * as a persisted -seed arg.
 */
(function (root) {
  var MANAGED = ["data", "basefolder", "port", "rpc", "rpcenable", "rpcpassword", "daemon", "seed", "anyseed"];

  var GROUPS = [
    { group: "Node role & P2P networking", items: [
      { flag: "host",             type: "value", label: "Host IP (-host)",                 help: "Bind to a specific host IP.", def: "" },
      { flag: "isclient",         type: "bool",  label: "Client node (-isclient)",         help: "Can't accept incoming connections. On for a light wallet.", def: true },
      { flag: "server",           type: "bool",  label: "Server node (-server)",           help: "Accepts incoming connections.", def: false },
      { flag: "desktop",          type: "bool",  label: "Desktop settings (-desktop)",     help: "No incoming connections (desktop profile).", def: false },
      { flag: "mobile",           type: "bool",  label: "Mobile device (-mobile)",         help: "Marks the device as mobile (metrics only).", def: true },
      { flag: "allowallip",       type: "bool",  label: "Allow all IPs (-allowallip)",     help: "Allow all IPs for Maxima / networking.", def: true },
      { flag: "nop2p",            type: "bool",  label: "Disable P2P (-nop2p)",            help: "Turn off the automatic P2P system.", def: false },
      { flag: "noconnect",        type: "bool",  label: "Hold off connecting (-noconnect)", help: "Don't connect out until connected to first.", def: false },
      { flag: "p2p2",             type: "bool",  label: "New P2P2 system (-p2p2)",         help: "Enable the newer P2P2 subsystem.", def: false },
      { flag: "p2prootnode",      type: "value", label: "P2P root node (-p2prootnode)",    help: "Initial P2P host:port to connect to.", def: "" },
      { flag: "p2pnodes",         type: "value", label: "P2P nodes / list URL (-p2pnodes)", help: "List of nodes, or a URL to a peers file, used when your peers list is empty.", def: "https://spartacusrex.com/minimapeers.txt" },
      { flag: "connect",          type: "value", label: "Manual connect list (-connect)",  help: "Disable P2P and connect only to this host:port list.", def: "" },
      { flag: "slavenode",        type: "value", label: "Slave node (-slavenode)",         help: "Connect to this node only; accept only TxBlock messages.", def: "" },
      { flag: "allowgenmessage",  type: "bool",  label: "Allow simple messages (-allowgenmessage)", help: "Allow simple messages sent from peers.", def: false }
    ]},
    { group: "Sync & storage", items: [
      { flag: "nosyncibd",        type: "bool",  label: "Skip heavy IBD (-nosyncibd)",     help: "Don't sync the full initial block download — light client follows the tip fast.", def: true },
      { flag: "limitbandwidth",   type: "bool",  label: "Limit bandwidth (-limitbandwidth)", help: "Limit the amount sent for archive sync.", def: true },
      { flag: "archive",          type: "bool",  label: "Archive node (-archive)",         help: "Store all data / cascade for resync (large).", def: false },
      { flag: "megammr",          type: "bool",  label: "MegaMMR mode (-megammr)",         help: "Keep the full MegaMMR (serves fast resync; bigger).", def: false },
      { flag: "sqlcoindb",        type: "bool",  label: "SQL coin DB (-sqlcoindb)",        help: "Use a SQL coindb in the txpowtree (low-RAM systems).", def: false },
      { flag: "txpowdbstore",     type: "int",   label: "TxPoW DB days (-txpowdbstore)",   help: "Days to keep TxPoW in the internal H2 DB (node default 3).", def: "" },
      { flag: "syncibdlogs",      type: "bool",  label: "Verbose sync logs (-syncibdlogs)", help: "Show detailed SYNC_IBD logs.", def: false },
      { flag: "rescuenode",       type: "value", label: "Rescue node (-rescuenode)",       help: "MegaMMR node to resync from if you meet a heavier chain.", def: "" },
      { flag: "megaprune",        type: "bool",  label: "Prune MegaMMR (-megaprune)",      help: "Prune unspendable addresses from the megammr.", def: false },
      { flag: "megaprunestate",   type: "bool",  label: "Prune state coins (-megaprunestate)", help: "Prune all coins with a state (exchanges).", def: false },
      { flag: "megaprunetokens",  type: "bool",  label: "Prune tokens (-megaprunetokens)", help: "Prune all tokens; keep only Minima coins.", def: false },
      { flag: "clean",            type: "bool",  label: "Wipe data at startup (-clean) ⚠", help: "DANGER: wipes the data folder at startup.", def: false }
    ]},
    { group: "Security & database", items: [
      { flag: "dbpassword",       type: "secret", label: "Wallet DB password (-dbpassword) ⚠", help: "Main wallet / SQL AES password. MUST be set on first launch and CANNOT be changed later. Stored in the Keychain.", def: "" },
      { flag: "nossl",            type: "bool",  label: "No SSL cert (-nossl)",            help: "Don't generate an SSL certificate at startup.", def: false },
      { flag: "dbignorelocks",    type: "bool",  label: "Ignore DB locks (-dbignorelocks)", help: "Debug: stop the DB checking locks.", def: false }
    ]},
    { group: "MySQL backup", items: [
      { flag: "mysqldb",          type: "secret", label: "MySQL DSN (-mysqldb)",           help: "Full MySQL details username:password@host:port (Keychain).", def: "" },
      { flag: "mysqldbcoins",     type: "bool",  label: "MySQL coins backup (-mysqldbcoins)", help: "Enable the MySQL coins DB backup.", def: false },
      { flag: "mysqldbdelay",     type: "int",   label: "MySQL connect delay ms (-mysqldbdelay)", help: "Delay before first MySQL connection (Docker).", def: "" },
      { flag: "mysqlalltxpow",    type: "bool",  label: "MySQL all TxPoW (-mysqlalltxpow)", help: "Store all TxPoW in MySQL when autobackup is on.", def: false }
    ]},
    { group: "Test / private network", items: [
      { flag: "solo",             type: "bool",  label: "Solo private net (-solo)",        help: "Run a private network (-test -nop2p) and genesis on first run.", def: false },
      { flag: "test",             type: "bool",  label: "Test params (-test)",             help: "Use test params on a private network.", def: false },
      { flag: "genesis",          type: "bool",  label: "Genesis block (-genesis)",        help: "Create a genesis block (-clean and -automine).", def: false },
      { flag: "testchainlength",  type: "int",   label: "Test chain length (-testchainlength)", help: "Tree length to keep in -test mode (default 32).", def: "" }
    ]},
    { group: "Logging & advanced", items: [
      { flag: "showparams",       type: "bool",  label: "Show startup params (-showparams)", help: "Print the startup params on launch.", def: false },
      { flag: "shownetcalls",     type: "bool",  label: "Show network calls (-shownetcalls)", help: "Log all network calls.", def: false },
      { flag: "shownetcallsnopoll", type: "bool", label: "Show net calls, no poll (-shownetcallsnopoll)", help: "Log network calls except poll messages.", def: false },
      { flag: "p2p-log-level-info", type: "bool", label: "P2P log: info (-p2p-log-level-info)", help: "Set P2P log level to info.", def: false },
      { flag: "p2p-log-level-debug", type: "bool", label: "P2P log: debug (-p2p-log-level-debug)", help: "Set P2P log level to debug.", def: false },
      { flag: "notifyalltxpow",   type: "bool",  label: "Notify all TxPoW (-notifyalltxpow)", help: "Notifications for ALL TxPoW, not just relevant.", def: false },
      { flag: "rpccrlf",          type: "bool",  label: "RPC CRLF headers (-rpccrlf)",     help: "Use CRLF at the end of RPC headers (NodeJS).", def: false },
      { flag: "enablejni",        type: "bool",  label: "Enable JNI (-enablejni)",         help: "Load the JNI lib libnative.so.", def: false },
      { flag: "hashtest",         type: "int",   label: "Hashrate test (-hashtest)",       help: "How many hashes to test hashrate at startup.", def: "" },
      { flag: "jnlp",             type: "bool",  label: "JNLP (-jnlp)",                    help: "Running from JNLP.", def: false },
      { flag: "noshutdownhook",   type: "bool",  label: "No shutdown hook (-noshutdownhook)", help: "Don't use the shutdown hook (Android).", def: false },
      { flag: "conf",             type: "value", label: "Config file (-conf)",             help: "Absolute path to a configuration file. Overrides other params.", def: "" }
    ]}
  ];

  // The core fields (data folder / ports) render at the top of the wizard; these show as read-only info.
  var MANAGED_INFO = [
    { flag: "rpcenable",   note: "always on — the app talks to the node over RPC" },
    { flag: "rpcpassword", note: "auto-generated, stored in the macOS Keychain" },
    { flag: "daemon",      note: "always on — headless (no stdin)" },
    { flag: "seed",        note: "provided via the Wallet section (restore fast-syncs with megammrsync)" },
    { flag: "anyseed",     note: "provided via the Wallet section" }
  ];

  function defaultParams() {
    var out = {};
    for (var g = 0; g < GROUPS.length; g++)
      for (var i = 0; i < GROUPS[g].items.length; i++) {
        var it = GROUPS[g].items[i];
        out[it.flag] = it.def;
      }
    return out;
  }

  // Network-role presets (the wizard's "Network role" choice + the Node-tab toggle). One source of truth:
  // contribute emits ONLY `-server` (bool flags emit only when true) — never alongside -isclient/-mobile,
  // whose ordering in the jar's ParamConfigurer is a HashMap accident, so passing both races. nosyncibd:false
  // so the node keeps a real archive and can serve syncing peers; limitbandwidth stays on (it caps only
  // archive-serving at 50MB/day, not gossip).
  var ROLE_CONTRIBUTE = { server: true,  isclient: false, mobile: false, desktop: false, nosyncibd: false, limitbandwidth: true };
  var ROLE_LIGHT      = { server: false, isclient: true,  mobile: true,  desktop: false, nosyncibd: true,  limitbandwidth: true };

  var API = { GROUPS: GROUPS, MANAGED: MANAGED, MANAGED_INFO: MANAGED_INFO, defaultParams: defaultParams,
              ROLE_CONTRIBUTE: ROLE_CONTRIBUTE, ROLE_LIGHT: ROLE_LIGHT };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (root) root.MINIMA_PARAMS = API;
})(typeof window !== "undefined" ? window : null);
