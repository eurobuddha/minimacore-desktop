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
        labelForToken: labelForToken,
        PALETTE: PALETTE, USDT_TEAL: USDT_TEAL, STAGE_WARN: STAGE_WARN
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
