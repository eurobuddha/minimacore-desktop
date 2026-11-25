/*
 * tokenicons.js — pure, synchronous token-icon + identicon logic (window.TOK). A verbatim JS port of the
 * native utxo wallet's IconResolver.java / Identicon.java / Util.tokenName. No I/O: it turns a token's metadata
 * into either a ready `data:` URI (artimage / data: / inline-svg / bare-base64) or a `remote` http(s) URL the
 * main process fetches (SSRF-guarded), and generates a deterministic identicon (inline SVG data URI) as the base
 * layer. The browser renders SVG natively, so (unlike Android) inline/remote SVGs "just work".
 */
(function (root) {
  var MINIMA = "0x00";
  var ARTIMAGE = /<artimage[^>]*>([\s\S]*?)<\/artimage>/i;
  var DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|x-icon|bmp);/i;
  var B64 = /^[A-Za-z0-9+/]+={0,2}$/;

  function first() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }
  function shortId(id) { return String(id || ""); }   // RULE 1: the whole token/coin/tx id (was 6…4); name kept for its callers

  // token.name may be a plain string OR an object {name,url,icon,ticker,webvalidate,...}
  function meta(token) { return (token && typeof token === "object" && token.name && typeof token.name === "object") ? token.name : null; }

  function pickIconField(token) {
    if (!token || typeof token !== "object") return "";
    var m = meta(token);
    return first(m && m.url, token.url, m && m.icon, token.icon);
  }
  function webvalidateUrl(token) {
    if (!token || typeof token !== "object") return "";
    var m = meta(token);
    return first(m && m.webvalidate, token.webvalidate);
  }
  // A metadata field that may live either on the token object or inside its nested name-object.
  function metaField(token, key) {
    if (!token || typeof token !== "object") return "";
    var m = meta(token);
    return first(m && m[key], token[key]);
  }
  function ticker(token) { return metaField(token, "ticker"); }

  /** IconResolver.resolve → { data: dataURI|null, remote: httpUrl|null }. */
  function resolveIcon(raw) {
    if (raw == null) return { data: null, remote: null };
    var t = String(raw).trim();
    if (!t) return { data: null, remote: null };
    if (/%[0-9A-Fa-f]{2}/.test(t)) { try { t = decodeURIComponent(t).trim(); } catch (e) {} }

    if (/^<artimage/i.test(t)) {
      var m = ARTIMAGE.exec(t);
      if (m) { var b64 = m[1].replace(/\s+/g, ""); if (b64.length > 16) return { data: "data:image/jpeg;base64," + b64, remote: null }; }
    }
    if (DATA_IMG.test(t)) return { data: t, remote: null };
    if (/^ipfs:\/\//i.test(t)) return { data: null, remote: "https://ipfs.io/ipfs/" + t.slice(7) };
    if (/^https?:\/\//i.test(t)) return { data: null, remote: t };
    if (/^<svg/i.test(t) && /<\/svg>\s*$/i.test(t)) {
      try { return { data: "data:image/svg+xml;base64," + b64encode(t), remote: null }; } catch (e) { return { data: null, remote: null }; }
    }
    if (t.length >= 100 && B64.test(t)) {
      const head = atob(t.slice(0, 32));
      let type = "png";
      if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") type = "webp";
      else if (head.startsWith("\xff\xd8")) type = "jpeg";
      else if (head.startsWith("GIF8")) type = "gif";
      else if (/^\s*(?:<svg\b|<\?xml\b)/i.test(head.replace(/^\xef\xbb\xbf/, ""))) type = "svg+xml";
      return { data: "data:image/" + type + ";base64," + t, remote: null };
    }
    return { data: null, remote: null };
  }

  function b64encode(str) {
    // utf-8 safe base64 (SVG markup is ASCII in practice, but be safe)
    return btoa(unescape(encodeURIComponent(str)));
  }

  function hsl(h, s, l) { return "hsl(" + h + "," + s + "%," + l + "%)"; }

  /** Identicon.forToken → inline-SVG data URI. Deterministic from the tokenid. */
  function identiconDataUri(tokenid) {
    var hex = String(tokenid || "").replace(/^0x/i, "").toLowerCase();
    while (hex.length < 32) hex += "0";
    hex = hex.slice(0, 32);
    var hue = parseInt(hex.slice(0, 4), 16) % 360;
    var sat = 55 + (parseInt(hex.slice(4, 6), 16) % 25);
    var light = 48 + (parseInt(hex.slice(6, 8), 16) % 10);
    var fg = hsl(hue, sat, light), bg = hsl(hue, Math.max(20, sat - 30), 12);
    var cell = 8, pad = 4;
    var rects = "";
    function put(c, r) { rects += '<rect x="' + (pad + c * cell) + '" y="' + (pad + r * cell) + '" width="' + cell + '" height="' + cell + '" fill="' + fg + '"/>'; }
    for (var r = 0; r < 5; r++) {
      for (var c = 0; c < 3; c++) {
        var idx = (r * 3 + c + 8) % 32;
        if ((parseInt(hex.charAt(idx), 16) & 1) === 0) continue;   // ON iff the nibble is odd
        var mirror = (c === 0) ? 4 : (c === 1 ? 3 : 2);
        put(c, r);
        if (mirror !== c) put(mirror, r);
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="' + bg + '"/>' + rects + '</svg>';
    return "data:image/svg+xml;base64," + b64encode(svg);
  }

  function tokenName(token, tokenid) {
    if (!tokenid || tokenid === MINIMA) return "Minima";
    if (token && typeof token === "object") {
      var n = token.name;
      if (n && typeof n === "object") return n.name || shortId(tokenid);
      if (typeof n === "string" && n) return n;
      return shortId(tokenid);
    }
    if (typeof token === "string" && token) return token;
    return shortId(tokenid);
  }

  /**
   * What a token is CALLED on the Wallet's screens (0.19.236): by its id, not by the name its creator wrote on the chain.
   * Minima and MxUSD (their real ids) by those names; any other token: its name and its whole id; a name that imitates
   * Minima or MxUSD (after folding look-alike letters) is not shown at all, only the id. Stored values, CSV and JSON are
   * untouched (tokenName). token: the node's token object, or a name already stored.
   */
  var MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  var LOOK = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u04bb": "h", "\u0501": "d", "\u043c": "m", "\u0442": "t", "\u043d": "h", "\u0438": "n",
    "\u03b1": "a", "\u03bf": "o", "\u03c1": "p", "\u03c5": "u", "\u03bd": "v", "\u03b9": "i", "\u03ba": "k", "\u03bc": "m", "\u0131": "i", "0": "o", "1": "i", "$": "s" };
  function skeleton(n) {
    return String(n || "").normalize("NFKD").replace(/[\u0300-\u036f\p{Cf}\p{Cc}\u2800]/gu, "").toLowerCase().replace(/./gu, function (ch) { return LOOK[ch] || ch; }).replace(/[^a-z]/g, "");
  }
  function label(token, tokenid) {
    var id = String(tokenid || MINIMA);
    if (id === MINIMA) return "Minima";
    if (id.toLowerCase() === MXUSD.toLowerCase()) return "MxUSD";
    var n = tokenName(token, id), k = skeleton(n);
    if (!n || n === id || /minima|mxusd|usd/.test(k)) return id;
    return n + " (" + id + ")";
  }

  function tidyAmount(s) {
    s = String(s == null ? "" : s);
    if (s.indexOf(".") < 0) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }

  root.TOK = {
    MINIMA: MINIMA,
    pickIconField: pickIconField,
    webvalidateUrl: webvalidateUrl,
    metaField: metaField,
    ticker: ticker,
    resolveIcon: resolveIcon,
    identiconDataUri: identiconDataUri,
    tokenName: tokenName,
    label: label,
    tidyAmount: tidyAmount,
    shortId: shortId
  };
})(window);
