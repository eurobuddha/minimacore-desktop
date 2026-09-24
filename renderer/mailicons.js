/*
 * mailicons.js — the Minima Mail APK's own glyph set, ported path-for-path from its VectorDrawables
 * (apks/mail/app/src/main/res/drawable/ic_*.xml). Same 24-grid, same rounded caps, same three stroke widths:
 * 1.7 for the body set, 2 for the chrome set, 1.9 for the hamburger. No emoji and no stock icons — the APK
 * deliberately has none, and a glyph the body font lacks renders as tofu.
 *
 * Exposes one function, like the Parlons panel's icons.js: micon(name) → an inline <svg class="mm-ic">.
 */
(function (g) {
  "use strict";
  var B = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  var C = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var M = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

  var P = {
    // chrome (stroke 2)
    back:    ["M14.8,5.8 L8.5,12 l6.3,6.2", C],
    chev:    ["M9.2,5.8 L15.5,12 l-6.3,6.2", C],
    close:   ["M6.2,6.2 L17.8,17.8 M17.8,6.2 L6.2,17.8", C],
    check:   ["M4.8,12.6 l4.8,4.8 L19.2,7.2", C],
    plus:    ["M12,5.5 v13 M5.5,12 h13", C],
    up:      ["M12,18.5 V5.8 M6.8,11 L12,5.8 l5.2,5.2", C],
    menu:    ["M4,7 h16 M4,12 h16 M4,17 h16", M],
    // ic_ring is a circle with trimPathEnd 0.78 — the 78% arc that means "posting"
    ring:    ["M4.5,12 a7.5,7.5 0 1 0 15,0 a7.5,7.5 0 1 0 -15,0", C + ' stroke-dasharray="37 10"'],
    // body (stroke 1.7)
    pen:     ["M4.2,19.8 l1,-3.9 L16.6,4.5 a2.05,2.05 0 0 1 2.9,2.9 L8.1,18.8 l-3.9,1 Z M14.9,6.2 l2.9,2.9", B],
    send:    ["M21.5,2.5 L10.8,13.2 M21.5,2.5 L14.7,21 l-3.9,-7.8 L3,9.3 Z", B],
    chain:   ["M10,13 a5,5 0 0 0 7.54,0.54 l3,-3 a5,5 0 0 0 -7.07,-7.07 l-1.72,1.71 M14,11 a5,5 0 0 0 -7.54,-0.54 l-3,3 a5,5 0 0 0 7.07,7.07 l1.71,-1.71", B],
    refresh: ["M20.5,4.5 v5 h-5 M19.8,9.5 a8,8 0 1 0 0.7,3.5", B],
    coin:    ["M3.6,12 a8.4,8.4 0 1 0 16.8,0 a8.4,8.4 0 1 0 -16.8,0 Z M8.3,15.2 V9.2 l3.7,3.2 3.7,-3.2 v6", B],
    inbox:   ["M3.5,13.5 V16.8 a3.2,3.2 0 0 0 3.2,3.2 h10.6 a3.2,3.2 0 0 0 3.2,-3.2 V13.5 M3.5,13.5 h4.4 l1.7,2.7 h4.8 l1.7,-2.7 h4.4 M12,3.5 v6.2 M9.3,7.1 l2.7,2.7 2.7,-2.7", B],
    outbox:  ["M3.5,13.5 V16.8 a3.2,3.2 0 0 0 3.2,3.2 h10.6 a3.2,3.2 0 0 0 3.2,-3.2 V13.5 M3.5,13.5 h4.4 l1.7,2.7 h4.8 l1.7,-2.7 h4.4 M12,9.7 V3.5 M9.3,6.2 L12,3.5 l2.7,2.7", B],
    archive: ["M4.3,4 h15.4 a1.3,1.3 0 0 1 1.3,1.3 v1.6 a1.3,1.3 0 0 1 -1.3,1.3 H4.3 A1.3,1.3 0 0 1 3,6.9 V5.3 A1.3,1.3 0 0 1 4.3,4 Z M5,8.6 V17.8 a2.2,2.2 0 0 0 2.2,2.2 h9.6 a2.2,2.2 0 0 0 2.2,-2.2 V8.6 M10,12.6 h4", B],
    contacts:["M12,11.4 a3.4,3.4 0 1 0 0,-6.8 a3.4,3.4 0 0 0 0,6.8 Z M5.2,19.6 a6.8,6.8 0 0 1 13.6,0", B],
    key:     ["M8.6,15.4 a3.9,3.9 0 1 0 0,-7.8 a3.9,3.9 0 0 0 0,7.8 Z M11.9,9.8 L20.5,9.8 M17.6,9.8 v3.1 M14.8,9.8 v2.3", B],
    settings:["M4,7.5 h9 M17,7.5 h3 M4,16.5 h3 M11,16.5 h9 M15,4.8 v5.4 M9,13.8 v5.4", B],
    photo:   ["M4,6.4 h16 a1.6,1.6 0 0 1 1.6,1.6 v8.6 a1.6,1.6 0 0 1 -1.6,1.6 H4 A1.6,1.6 0 0 1 2.4,16.6 V8 A1.6,1.6 0 0 1 4,6.4 Z M4.6,17 l4.9,-5.1 3.2,3.2 2.6,-2.4 4.1,4.3 M16.6,10.4 a1.1,1.1 0 1 0 0,-2.2 a1.1,1.1 0 0 0 0,2.2 Z", B],
    scan:    ["M4,8.6 V5.6 a1.6,1.6 0 0 1 1.6,-1.6 h3 M15.4,4 h3 A1.6,1.6 0 0 1 20,5.6 v3 M20,15.4 v3 a1.6,1.6 0 0 1 -1.6,1.6 h-3 M8.6,20 h-3 A1.6,1.6 0 0 1 4,18.4 v-3 M4,12 h16", B],
    clip:    ["M16.8,8.2 l-6.6,6.6 a2.3,2.3 0 0 0 3.3,3.3 l6.6,-6.6 a4.1,4.1 0 0 0 -5.8,-5.8 l-6.6,6.6 a5.9,5.9 0 0 0 8.4,8.4", B],
    theme:   ["M12,3.4 a8.6,8.6 0 1 0 0,17.2 a8.6,8.6 0 0 0 0,-17.2 Z M12,3.4 v17.2", B],
    // ic_dots: three filled 1.5r circles — drawn as a fat round stroke so one <path> carries it
    dots:    ["M12,5.6 h0.01 M12,12 h0.01 M12,18.4 h0.01", 'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"']
  };

  /** micon(name) → inline SVG, or "" for an unknown name (never throws, never renders a broken glyph). */
  g.micon = function (name, cls) {
    var d = P[name];
    if (!d) return "";
    return '<svg class="mm-ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true"><path d="'
      + d[0] + '" ' + d[1] + "/></svg>";
  };
  g.micon.names = Object.keys(P);
})(window);
