/**
 * trading — port of native TradingContext.java: the two currencies (MINIMA / mxUSDT), their sentinels, tokens,
 * per-currency HKDF context, pricing model, and the full theme palette (Design.java tokens × TradingContext accent).
 * The active currency is a single selection persisted in the kv store. Attaches to AX.trading.
 *
 * Sentinels/token/context are the interop anchors — byte-identical to native so the MDS peer joins the same books.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    var MINIMA_TOKENID = '0x00';
    var USDT_TOKENID = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';

    var CTX = {
        MINIMA: {
            key: 'minima', coinLabel: 'MINIMA', tokenId: MINIMA_TOKENID, pricingParity: false,
            hkdfContext: 'minimaswap',
            orderBookAddr: '0x4D494E494D4153574150',            // "MINIMASWAP"
            otcBoardAddr:  '0x4D494E494D41535741504F544342',    // "MINIMASWAPOTCB"
            otcChatAddr:   '0x4D494E494D41535741504F544343',    // "MINIMASWAPOTCC"
            takeAddr:      '0x4D494E494D415357415054414B45',    // "MINIMASWAPTAKE"
            accent: '#F7931A', gradStart: '#FFAB3D',
            onAccentDark: '#0B0D12', onAccentLight: '#201400'
        },
        MXUSDT: {
            key: 'mxusdt', coinLabel: 'mxUSDT', tokenId: USDT_TOKENID, pricingParity: true,
            hkdfContext: 'usdtswap',
            orderBookAddr: '0x5553445453574150',                // "USDTSWAP"
            otcBoardAddr:  '0x55534454535741504F544342',        // "USDTSWAPOTCB"
            otcChatAddr:   '0x55534454535741504F544343',        // "USDTSWAPOTCC"
            takeAddr:      '0x555344545357415054414B45',        // "USDTSWAPTAKE"
            accent: '#26A17B', gradStart: '#3DBF93',
            onAccentDark: '#FFFFFF', onAccentLight: '#FFFFFF'
        }
    };

    var _active = CTX.MXUSDT;   // native default until load()

    function active() { return _active; }
    function other() { return _active === CTX.MINIMA ? CTX.MXUSDT : CTX.MINIMA; }
    function byKey(k) { return k === 'minima' ? CTX.MINIMA : CTX.MXUSDT; }
    function setActive(ctx) { _active = ctx; return _active; }
    function loadKey(k) { _active = byKey(k); return _active; }
    function labelForToken(tokenid) {
        if (tokenid) {
            var t = String(tokenid).toLowerCase();
            if (t === MINIMA_TOKENID) return CTX.MINIMA.coinLabel;
            if (t === USDT_TOKENID.toLowerCase()) return CTX.MXUSDT.coinLabel;
        }
        return _active.coinLabel;
    }

    // ---- attributing a RECORDED swap to its market (native TradingContext.forCoinLabel/forSwap) ----

    /**
     * The market a Minima-side coin LABEL belongs to, or null for an Ethereum-leg symbol ("USDT", "WETH") or an
     * unrecognised legacy label. Swap rows persist the label current when they were written, so the dollar
     * token's ALIASES both match: it is properly MxUSD and rows on disk say "mxUSDT", so a later rename cannot
     * orphan existing history. Deliberately does NOT match the bare "USDT" — that is the ERC20 leg of every
     * swap in BOTH markets, so matching it would attribute every row to the dollar market.
     */
    function forCoinLabel(label) {
        if (label === null || label === undefined) return null;
        var l = String(label).trim();
        if (!l) return null;
        var k;
        for (k in CTX) if (CTX[k].coinLabel.toLowerCase() === l.toLowerCase()) return CTX[k];
        if (l.toLowerCase() === 'mxusd' || l.toLowerCase() === 'mxusdt') return CTX.MXUSDT;
        if (l.toLowerCase() === 'minima') return CTX.MINIMA;
        return null;
    }

    /** The market a recorded swap belongs to — whichever leg carries a Minima-side label. null when neither
     *  does (an unattributable legacy row); callers MUST show such a row, never hide it. */
    function forSwap(sellToken, buyToken) {
        return forCoinLabel(sellToken) || forCoinLabel(buyToken);
    }

    // ---- which recorded swaps belong on screen in the selected market (native swap/SwapVisibility.java) ----

    /** Grace past a BLOCK-denominated timelock, ~20h at Minima's ~50s blocks — far longer than the sweep needs,
     *  so a refund landing can never blink a row off screen mid-confirmation. */
    var GRACE_BLOCKS = 1440;
    /** Grace past a SECONDS-denominated (Ethereum leg) timelock. */
    var GRACE_SECS = 24 * 60 * 60;

    /** A finished swap: nothing left to claim or refund. */
    function isTerminalSwap(s) {
        var st = s && (s.status || s.STATUS);
        return st === 'COMPLETE' || st === 'REFUNDED' || st === 'ERROR';
    }

    /**
     * Is my own locked leg still inside its timelock (plus grace)? The units differ by leg and nothing in the
     * value says which: mylegminima means myTimelock is a Minima BLOCK height, otherwise it is unix SECONDS.
     * Switched explicitly rather than guessed from magnitude — reading one as the other would compare an epoch
     * against a block count and call every such swap live forever.
     */
    function withinWindow(s, chainBlock, nowMs) {
        var tl = Number(s && (s.mytimelock !== undefined ? s.mytimelock : s.myTimelock)) || 0;
        if (tl <= 0) return true;                                           // no known deadline → assume live
        var minimaLeg = s.mylegminima !== undefined ? s.mylegminima : s.myLegIsMinima;
        if (minimaLeg === 1 || minimaLeg === '1' || minimaLeg === true) {
            if (!chainBlock || chainBlock <= 0) return true;                // tip not fetched yet → assume live
            return chainBlock <= tl + GRACE_BLOCKS;
        }
        return Math.floor(nowMs / 1000) <= tl + GRACE_SECS;
    }

    /**
     * Should this swap appear while `act` is the selected market? Its own market always; the OTHER market only
     * while it is still actionable (non-terminal AND inside its window), because settlement is deliberately
     * currency-agnostic and hiding a leg you could still recover could cost real funds — while a row whose
     * window closed long ago is not actionable from any screen and belongs in its own currency's history.
     * Every unknown fails OPEN: an unattributable legacy row, a missing timelock, or an unknown tip all render.
     */
    function visibleIn(s, act, chainBlock, nowMs) {
        if (!s) return false;
        var own = forSwap(s.selltoken !== undefined ? s.selltoken : s.sellToken,
                          s.buytoken !== undefined ? s.buytoken : s.buyToken);
        if (!own || !act || own === act) return true;
        return !isTerminalSwap(s) && withinWindow(s, chainBlock, nowMs);
    }

    /** Semantic palette (Design.java) — mode ∈ {dark,light}; accent overlaid from the active currency. */
    var PALETTE = {
        dark: {
            BG: '#0B0D12', SURFACE: '#12151C', SURFACE2: '#1B1F28', BORDER: 'rgba(255,255,255,0.07)',
            TEXT: '#EEF0F4', DIM: '#8B909C', DIM2: '#6F7583', IN: '#3FD0A2', RED: '#FF5C5C',
            accentSoftAlpha: 0.20
        },
        light: {
            BG: '#F3F4F7', SURFACE: '#FFFFFF', SURFACE2: '#EDEEF2', BORDER: '#E6E8EE',
            TEXT: '#181B22', DIM: '#8B909C', DIM2: '#A6ABB6', IN: '#12A97E', RED: '#E5484D',
            accentSoftAlpha: 0.12
        }
    };
    var USDT_TEAL = '#26A69A';        // coin-chip only, distinct from accent
    var STAGE_WARN = '#E6A23C';

    AX.trading = {
        CTX: CTX, MINIMA: CTX.MINIMA, MXUSDT: CTX.MXUSDT,
        MINIMA_TOKENID: MINIMA_TOKENID, USDT_TOKENID: USDT_TOKENID,
        active: active, other: other, byKey: byKey, setActive: setActive, loadKey: loadKey,
        labelForToken: labelForToken, forCoinLabel: forCoinLabel, forSwap: forSwap,
        isTerminalSwap: isTerminalSwap, withinWindow: withinWindow, visibleIn: visibleIn,
        GRACE_BLOCKS: GRACE_BLOCKS, GRACE_SECS: GRACE_SECS,
        PALETTE: PALETTE, USDT_TEAL: USDT_TEAL, STAGE_WARN: STAGE_WARN
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
