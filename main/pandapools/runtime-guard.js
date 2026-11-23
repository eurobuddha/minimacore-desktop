/* WRITE trust + actual node key-mode gate. Reuses checkmode and BlockOwnerRecovery's
 * public genkey probe. No private key/seed is requested and the probe stores no key.
 * All writes recheck; UI state or a previous successful check never authorizes them. */
var PoolRuntimeGuard = (function () {
    var PROBE = 'keys action:genkey phrase:"PandaPools public recovery mode probe v1"';
    var BLOCK = '0x3FFDB1A06A2DCA90BEE0D7C0F5BA62B9AF23BF5D73A23D63555492F88D1E3828';
    var CLASSIC = '0x8B0CF5A33D71DBB1E986219C57E6B97ED9489F699DE7ED8189BEF7F168A5DA76';
    var raw, installed = false, listener = function () {};
    var NOTICE = 'A phone hosting a pool must keep MinimaCore running and connected to the internet 24/7. Use reliable power and Wi-Fi, and allow background operation in Android. Charging or Wi-Fi alone does not keep the node running. Extended time offline can leave reserves beyond the local chain window and require fund recovery. Keep a verified, password-encrypted combined pool and node backup off this phone. Automatic rescue depends on valid proofs, matching keys and usable signing state; it cannot recover missing essential data.';
    function good(r) { return !!r && r.status === true && r.pending !== true && r.pending !== 'true' && !!r.response; }
    function request(q, cb) {
        var ended = false, timer = typeof setTimeout === 'function' ? setTimeout(function () { done(null); }, 30000) : null;
        function done(r) { if (ended) return; ended = true; if (timer !== null) clearTimeout(timer); cb(r); }
        try { raw(q, done); } catch (e) { done(null); }
    }
    function check(cb) {
        request('checkmode', function (r) {
            if (!good(r) || typeof r.response.writemode !== 'boolean' || typeof r.response.dblocked !== 'boolean') return cb('MODE_UNAVAILABLE: Cannot verify node permission and wallet lock state. Retry when the node is ready.');
            if (!r.response.writemode) return cb('WRITE_REQUIRED: Enable PandaPools WRITE permission in MiniHub, then retry. Deferred approval is not supported.');
            if (r.response.dblocked) return cb('WALLET_LOCKED: Unlock your node wallet, then retry.');
            // Desktop owns its node lifecycle and keeps its existing key-mode policy. The MDS-only gate is mandatory in MiniHub.
            if (MDS.poolDesktop === true) { cb(null); return; }
            request(PROBE, function (p) {
                var key = good(p) ? String(p.response.publickey || '').toUpperCase() : '';
                if (key === BLOCK.toUpperCase()) return cb(null);
                if (key === CLASSIC.toUpperCase()) return cb('BLOCK_MODE_REQUIRED: PandaPools requires block-as-key-uses mode. Use a node set up in that mode. Do not change the key mode of an existing funded wallet or recreate its keys to bypass this check; preserve its original mode and signing state. To recover an existing Classic pool, use native PandaPools → Pool recovery → Recover on existing wallet on the original Classic node.');
                cb('KEY_MODE_UNKNOWN: This node did not prove block-as-key-uses mode. No pool writes are allowed.');
            });
        });
    }
    // The node splits EVERY command on ";" (even inside quotes) and runs each piece, and its parameter splitter breaks on
    // any white space incl. TAB (a tab starts a new parameter). No command this engine builds holds ";" or a control
    // character; such text can only come from outside (a coin's state, a backup file): refused, nothing sent.
    var UNSAFE_RE = /[;\x00-\x1f\x7f]/;
    var UNSAFE = 'UNSAFE_COMMAND: refused a node command holding ";" or a control character (tab, line break, NUL...: the node would read what follows as another command or parameter). Nothing was sent.';
    function unsafe(q) { return typeof q !== 'string' || UNSAFE_RE.test(q); }
    // A pool beacon's (or tracked covenant's) four literals, before ANY use: public key, payout address and tokenid are
    // 0x + 64 hex (32 bytes), never an all-zero token (MINIMA, whatever its length); KMIN a plain positive decimal below
    // 2^64-1, the bound ReserveRecovery.validRecipe and Covenant.sizeOk apply. Anything else: the pool is skipped.
    var HEX32 = /^0x[0-9A-Fa-f]{64}$/, MAX_KMIN = '18446744073709551615';   // 2^64-1 (Covenant.MININUMBER_MAX)
    function belowMax(kmin) {   // kmin already a plain decimal: compare its whole part with 2^64-1, no number parsing
        var whole = kmin.split('.')[0].replace(/^0+/, '');
        return whole.length < MAX_KMIN.length || (whole.length === MAX_KMIN.length && whole < MAX_KMIN);
    }
    function poolParams(opk, oadr, tok, kmin) {
        return typeof opk === 'string' && HEX32.test(opk) && typeof oadr === 'string' && HEX32.test(oadr)
            && typeof tok === 'string' && HEX32.test(tok) && !/^0x0+$/.test(tok) && typeof kmin === 'string' && kmin.length <= 80
            && /^[0-9]+(?:\.[0-9]+)?$/.test(kmin) && /[1-9]/.test(kmin) && belowMax(kmin);
    }
    // Explicit read-only forms only. Mixed/unknown commands must pass the write gate.
    function readOnly(q) {
        if (unsafe(q)) return false;
        return /^(?:status|balance|coins|scripts|block|history|txpow|txnlist|txncheck|coincheck|coinexport|runscript|tokenvalidate|tokens|checkmode)(?:\s|$)/.test(q)
            || q === 'keys' || /^keys action:list(?:\s|$)/.test(q) || q === PROBE;
    }
    function install() {
        if (installed) return; installed = true;
        raw = function (q, cb) { return original.call(MDS, q, cb); };
        var original = MDS.cmd;
        MDS.cmd = function (q, cb) {
            if (unsafe(q)) {
                try { MDS.log('SECURITY ' + UNSAFE + ' ' + JSON.stringify(String(q))); } catch (e) {}
                listener(UNSAFE); if (cb) cb({status:false,pending:false,error:UNSAFE}); return;
            }
            if (readOnly(q)) return raw(q, cb);
            check(function (error) {
                if (error) { listener(error); if (cb) cb({status:false,pending:false,error:error}); return; }
                raw(q, cb);
            });
        };
    }
    return {install:install,check:check,unsafe:unsafe,poolParams:poolParams,onBlocked:function (fn) { listener = fn; },notice:NOTICE,probe:PROBE};
})();
