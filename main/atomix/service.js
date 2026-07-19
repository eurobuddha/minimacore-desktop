/**
 * service.js — the AtomiX background engine (Rhino). Boots the crypto/identity stack and, on every NEWBLOCK
 * (+60s backstop), runs the full engine pass: taker settlement (claim/withdraw with my secret, refund expired
 * legs — terminal status ONLY from the ETH contract flags, F1), the maker keep-alive + auto-responder
 * counter-legs, OTC negotiation/expiry, and the market-history collector. Self-healing boot (retries until
 * WRITE trust), per-poll kv reload (UI edits/currency switches honored), poll watchdog. Lives as long as the
 * node runs — more reliable than Android Doze.
 */
MDS.load('lib/rhino_shim.js');   // MUST be first — polyfills Uint8Array.slice/.fill that Rhino lacks
MDS.load('vendor/nacl.js');
MDS.load('vendor/blake.js');
MDS.load('vendor/sha256.js');
MDS.load('vendor/sha512.js');
MDS.load('vendor/sha3.js');
MDS.load('vendor/elliptic.js');
MDS.load('lib/hex.js');
MDS.load('lib/flow.js');
MDS.load('crypto/ax_sodium.js');
MDS.load('crypto/ax_eth.js');
MDS.load('lib/decimal.js');       // exact BigInt decimal math (no deps) — engine amount quantisation
MDS.load('lib/abi.js');           // ABI encode/decode (needs ax_eth keccak) — ETH calldata
MDS.load('lib/ethhtlc.js');       // ETH HTLC interface (needs abi + sodium + hex + decimal)
MDS.load('lib/identity.js');
MDS.load('lib/trading.js');
MDS.load('lib/mdsw.js');
MDS.load('lib/ethrpc.js');         // ETH JSON-RPC over MDS.net.POST (needs mds)
MDS.load('lib/ethtx.js');          // legacy tx sign+send + nonce serializer (needs ethrpc + ax_eth + flow)
MDS.load('lib/ethops.js');         // ETH HTLC ops (needs ethhtlc + ethrpc + ethtx)
MDS.load('lib/swapdb.js');         // durable swap tables — boot.init() creates them (both hosts)
MDS.load('lib/htlc.js');
MDS.load('lib/order.js');          // order model (responder reads my published ladder)
MDS.load('lib/prng.js');
MDS.load('lib/boot.js');
MDS.load('lib/settle.js');         // taker settlement engine (needs swapdb + htlc + ethops + dec + flow + trading)
MDS.load('lib/orderbook.js');      // publish/scan the shared order book (needs order + identity + sodium + mds)
MDS.load('lib/peg.js');            // price oracle + auto-MM ladder (needs order + trading + mds)
MDS.load('lib/responder.js');      // maker auto-responder (needs swapdb + htlc + ethops + dec + flow + trading + identity + order)
MDS.load('lib/maker.js');          // maker controller: build/publish/keep-alive/tombstone (needs order + orderbook + peg)
MDS.load('lib/take.js');           // buy handshake (engine.startLeg uses it for OTC/taker; needs identity + trading)
MDS.load('lib/swapplan.js');       // amount math (engine start paths quantise via it)
MDS.load('lib/engine.js');         // taker/executor start paths (OTC execute locks leg 1)
MDS.load('lib/otc.js');            // OTC negotiation engine + LP verify (needs mds + identity + order + orderbook + ethops + htlc)
MDS.load('lib/market.js');         // network-wide trade-history collector (needs swapdb + htlc + flow) — service-ONLY writer

var READY = false, CTX = null, POLLING = false, POLL_START = 0, RPC = null;
var POLL_STUCK_MS = 5 * 60 * 1000;   // watchdog: a wedged poll (uncaught throw in a callback chain) must self-clear

function log(s) { MDS.log('[atomix] ' + s); }
/** Engine notification → browser toast AND the node log (native SwapLog parity: settlement/responder events
 *  must be observable in `docker logs`/minima.log — a live interop session is diagnosed from these lines). */
function notifyLog(title, body) { MDS.notify(title + ': ' + body); log(title + ' — ' + body); }

/** (Re)wire every engine that captures the ACTIVE currency's identity. Run at boot and again whenever the UI
 *  switches currency (detected via kv) — a stale captured identity publishes/decrypts as the WRONG currency. */
function configureEngines() {
    AX.settle.configure({
        rpc: RPC, ethPriv: CTX.eth.privKey, ethAddr: CTX.eth.address,
        myMinimaPk: CTX.htlc.publickey, myMinimaAddr: CTX.htlc.miniaddress,
        notify: notifyLog,
        onSwapsChanged: function () { }   // service has no UI to refresh; the UI polls its own SQL
    });
    AX.maker.configure({
        identity: AX.boot.activeIdentity(CTX), myMinimaPk: CTX.htlc.publickey, ethAddr: CTX.eth.address,
        notify: notifyLog, onOrder: function () { }
    });
    AX.responder.configure({
        rpc: RPC, ethPriv: CTX.eth.privKey, ethAddr: CTX.eth.address,
        myMinimaPk: CTX.htlc.publickey, myMinimaAddr: CTX.htlc.miniaddress,
        myIdentity: AX.boot.activeIdentity(CTX),
        getOrder: function () { return AX.maker.currentOrder(); },
        notify: notifyLog,
        onSwapsChanged: function () { }
    });
    AX.engine.configure({ rpc: RPC, ethPriv: CTX.eth.privKey, ethAddr: CTX.eth.address, myMinimaPk: CTX.htlc.publickey, onSwapsChanged: function () { } });
    AX.otc.configure({
        identity: AX.boot.activeIdentity(CTX), myMinimaPk: CTX.htlc.publickey, ethAddr: CTX.eth.address,
        notify: notifyLog, onDealsChanged: function () { },
        onExecute: function (deal, cb) { AX.engine.executeOtc(deal, cb); },
        onIncomingHash: function (hash) { AX.responder.addIncoming(hash, true); }   // authenticated OTC EXECUTE → cap-exempt
    });
}

/** Re-read the shared kv state the UI can change under us: active currency + maker config/peg state. Without this
 *  the service's stale in-memory copy silently UNDOES a UI withdraw/edit on the next keep-alive republish, and
 *  keeps making the OLD currency's market after a switch. Cheap (4 kv reads per poll). cb(). */
function reloadShared(cb) {
    AX.mds.kvGet('trading_currency', AX.trading.active().key, function (k) {
        if (k !== AX.trading.active().key) {
            log('currency switch detected (' + AX.trading.active().key + ' → ' + k + ') — reconfiguring engines');
            AX.trading.loadKey(k);
            AX.maker.resetForReload();      // drop old-currency order/peg (the UI already tombstoned it)
            configureEngines();             // re-capture the new currency's identity everywhere
        }
        AX.maker.loadConfig(function () { cb(); });   // pick up UI edits/withdrawals within one poll
    });
}

/** Fetch the maker's sellable balances (native minima sendable + ERC20 USDT balanceOf) for keep-alive publishing. */
function getBalances(cb) {
    MDS.cmd('balance tokenid:' + AX.trading.active().tokenId, function (r) {
        var minima = 0;
        try { minima = Number(r.response[0].sendable) || 0; } catch (e) { }
        AX.ethops.make(RPC, CTX.eth.privKey, CTX.eth.address).balanceOf(AX.ethops.NET.usdt, function (e, raw) {
            cb({ minima: minima, usdt: e ? 0 : Number(AX.dec.formatUnits(raw, 6)) });
        });
    });
}

/** One full pass: reload shared kv state, then taker settlement + responder discovery (settle.poll), then maker
 *  peg-refresh + keep-alive + OTC. An overlap guard prevents concurrent passes; a WATCHDOG clears a pass that
 *  wedged (an uncaught throw inside an async MDS callback would otherwise leave POLLING true FOREVER and silently
 *  kill all claims/refunds until restart — a fund-safety hazard, not just a bug). */
function poll() {
    if (!READY) return;
    if (POLLING) {
        if (Date.now() - POLL_START > POLL_STUCK_MS) { log('WATCHDOG: poll wedged >' + POLL_STUCK_MS + 'ms — resetting'); POLLING = false; }
        else return;
    }
    POLLING = true; POLL_START = Date.now();
    reloadShared(function () {
        AX.settle.poll(function () {
            AX.maker.refreshPeg(function () {
                getBalances(function (avail) {
                    AX.maker.keepAlive(avail, function () {
                        // OTC: process negotiation messages + retry/expire/settle stale deals.
                        AX.otc.scanChat(function () {
                            AX.otc.expireStale(Date.now(), function (hash, scb) {
                                AX.swapdb.getSwap(hash, function (e, s) { scb(s ? s.status : null); });
                            }, function () {
                                // market feed LAST (display data — never delays settlement); own block read.
                                AX.htlc.currentBlock(function (eB, tip) {
                                    if (eB) { POLLING = false; return; }
                                    AX.market.poll(tip, function () { POLLING = false; });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

// SELF-HEALING BOOT: MiniDapps install with READ trust by default, so first boot commonly fails on the
// write-gated vault/seedrandom reads. Keep retrying (paced) on every block/timer event until the user grants
// WRITE trust — the background engine then comes up ON ITS OWN, no reinstall or node restart. Log only on a
// message CHANGE so a long-unpermissioned install doesn't spam the node log.
var BOOTING = false, lastBootTryMs = 0, lastBootLog = '';
var BOOT_RETRY_PACE_MS = 55000;
function logOnce(s) { if (s !== lastBootLog) { lastBootLog = s; log(s); } }
function tryBoot() {
    if (READY || BOOTING) return;
    var now = Date.now();
    if (lastBootTryMs > 0 && now - lastBootTryMs < BOOT_RETRY_PACE_MS) return;
    lastBootTryMs = now; BOOTING = true;
    AX.boot.init(function (err, ctx) {
        BOOTING = false;
        if (err) {
            logOnce('boot failed: ' + err.message + (err.permission
                ? ' — grant WRITE trust (MiniHub app settings, or: mds action:permission uid:<AtomiX uid> trust:write); retrying'
                : ' — retrying'));
            return;
        }
        CTX = ctx;
        RPC = new AX.ethrpc.Rpc(AX.ethops.NET.rpcs[0]);   // one ETH RPC shared by settle + responder + balances
        // Settlement + maker/responder + taker/OTC engines (its own instances vs the UI's are fund-SAFE — F1
        // recovers a cross-instance nonce clash). configureEngines re-runs on a currency switch (reloadShared).
        configureEngines();
        AX.maker.loadConfig(function () {
            AX.otc.initDb(function () {
                READY = true;
                log('booted — settlement + maker/responder + OTC live; ETH ' + ctx.eth.address);
                poll();   // catch up any in-flight swaps immediately on (re)start
            });
        });
    });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') { tryBoot(); }
    else if (msg.event === 'NEWBLOCK') { if (!READY) tryBoot(); else poll(); }
    else if (msg.event === 'MDS_TIMER_60SECONDS') { if (!READY) tryBoot(); else poll(); }   // backstop between blocks
});
