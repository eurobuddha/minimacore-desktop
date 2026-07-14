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
  function shortId(id) { id = String(id || ""); return id.length > 12 ? id.slice(0, 6) + "…" + id.slice(-4) : id; }

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
    if (t.length >= 100 && B64.test(t)) return { data: "data:image/png;base64," + t, remote: null };
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

  function tidyAmount(s) {
    s = String(s == null ? "" : s);
    if (s.indexOf(".") < 0) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }

  root.TOK = {
    MINIMA: MINIMA,
    pickIconField: pickIconField,
    webvalidateUrl: webvalidateUrl,
    resolveIcon: resolveIcon,
    identiconDataUri: identiconDataUri,
    tokenName: tokenName,
    tidyAmount: tidyAmount,
    shortId: shortId
  };
})(window);
