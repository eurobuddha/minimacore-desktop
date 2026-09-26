/*
 * casinoart.js — every coin, die, wheel and confetti square in the P2P Chance panel, drawn procedurally on a
 * <canvas>, ported from the APK's own animators (apks/casino GameVisual.java / ResultOverlay.java).
 *
 * The APK has no UI drawables at all: the artwork IS the code, and so are the timings. They are reproduced
 * exactly, because they are the panel's character:
 *
 *   coin      1100ms · 5 turns (+½ for Tails) · ease 1-(1-t)^3.2 · drawn as a HORIZONTAL SQUASH
 *             (scaleX(|cos θ|)), with the H/T glyph fading in past |cos θ| > 0.18 — not a 3-D rotate
 *   dice       900ms · 540° · face reflickers every 55ms until t = 0.82, then locks · snaps upright at the end
 *   roulette  2000ms · 6 turns + the landing offset · ease 1-(1-t)^4.4 · 36 European pockets, NO zero
 *             (zero edge) · fixed gold pointer · gold hub
 *   confetti  exactly 12 squares · 1200ms · gold/pink/cyan · v²·1.1 fall · ±720° spin · linear fade · WIN ONLY
 *
 * Nothing here can change a result. The outcome and the exact roll arrive already settled from the confirmed
 * on-chain resolve; these functions only land on it.
 */
(function (g) {
  "use strict";

  var GOLD = "#FFD700", PINK = "#FF2D78", CYAN = "#00E5FF", INK = "#0A0E1A",
      PANEL = "#121829", PANEL2 = "#1A2238", BORDER = "#2A3550", DIM = "#8A93AD",
      RED = "#B01F2B", BLACK = "#14171C";

  /** 36 pockets in the authentic clustered order, with the zero removed — the zero edge is the whole point. */
  var WHEEL = [32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  var REDS = {}; [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].forEach(function (n) { REDS[n] = 1; });
  /** Die pips on a 3×3 grid, 1-indexed left-to-right, top-to-bottom. */
  var PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  var COIN_MS = 1100, COIN_TURNS = 5, COIN_EASE = 3.2, COIN_GLYPH_AT = 0.18;
  var DICE_MS = 900, DICE_SPIN = 540, DICE_FLICK_MS = 55, DICE_LOCK_AT = 0.82;
  var ROU_MS = 2000, ROU_TURNS = 6, ROU_EASE = 4.4;
  var CONF_N = 12, CONF_MS = 1200, CONF_GRAV = 1.1, CONF_SPIN = 720;

  /** Size a canvas to its box at device resolution and hand back a context already scaled to CSS pixels. */
  function fit(cv) {
    var r = Math.max(1, window.devicePixelRatio || 1);
    var w = cv.clientWidth || cv.width || 150, h = cv.clientHeight || cv.height || 150;
    cv.width = Math.round(w * r); cv.height = Math.round(h * r);
    var ctx = cv.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function clear(ctx, w, h) { ctx.clearRect(0, 0, w, h); }
  function easeOut(t, p) { return 1 - Math.pow(1 - t, p); }

  // ---------------------------------------------------------------- the coin
  function drawCoin(ctx, w, h, theta, glyph) {
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
    var sx = Math.abs(Math.cos(theta));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.03, sx), 1);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = GOLD; ctx.fill();
    ctx.lineWidth = 2 / Math.max(0.03, sx); ctx.strokeStyle = "#9C7D0A"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.88, 0, Math.PI * 2);
    ctx.lineWidth = 1 / Math.max(0.03, sx); ctx.strokeStyle = "rgba(0,0,0,.22)"; ctx.stroke();
    if (sx > COIN_GLYPH_AT) {
      ctx.globalAlpha = Math.min(1, (sx - COIN_GLYPH_AT) / (1 - COIN_GLYPH_AT));
      ctx.scale(1 / Math.max(0.03, sx), 1);                 // the glyph does not squash with the disc
      ctx.fillStyle = INK;
      ctx.font = "700 " + Math.round(R * 1.05) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(glyph, 0, 1);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- the die
  function drawDie(ctx, w, h, face, rot, scale) {
    var cx = w / 2, cy = h / 2, S = Math.min(w, h) * 0.52, r = S * 0.16;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(scale, scale); ctx.translate(-S / 2, -S / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, S, S, r);
    else { ctx.moveTo(r, 0); ctx.arcTo(S, 0, S, S, r); ctx.arcTo(S, S, 0, S, r); ctx.arcTo(0, S, 0, 0, r); ctx.arcTo(0, 0, S, 0, r); ctx.closePath(); }
    ctx.fillStyle = "#F3F4F8"; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = BORDER; ctx.stroke();
    var pr = S * 0.085, pad = S * 0.24, gap = (S - pad * 2) / 2;
    (PIPS[face] || []).forEach(function (p) {
      var col = (p - 1) % 3, row = Math.floor((p - 1) / 3);
      ctx.beginPath(); ctx.arc(pad + col * gap, pad + row * gap, pr, 0, Math.PI * 2);
      ctx.fillStyle = INK; ctx.fill();
    });
    ctx.restore();
  }

  // ---------------------------------------------------------------- the wheel
  function drawWheel(ctx, w, h, rot) {
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42, seg = Math.PI * 2 / 36;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, R + 5, 0, Math.PI * 2); ctx.fillStyle = PANEL2; ctx.fill();
    ctx.save();
    ctx.rotate(rot);
    for (var k = 0; k < 36; k++) {
      var n = WHEEL[k], a0 = k * seg - Math.PI / 2, a1 = a0 + seg;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a0, a1); ctx.closePath();
      ctx.fillStyle = REDS[n] ? RED : BLACK; ctx.fill();
      ctx.save();
      ctx.rotate(a0 + seg / 2 + Math.PI / 2);
      ctx.fillStyle = "#E8E8EE";
      ctx.font = "700 " + Math.max(7, Math.round(R * 0.13)) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(n), 0, -R * 0.82);
      ctx.restore();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.34, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill();   // gold hub
    ctx.beginPath(); ctx.arc(0, 0, R * 0.34, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.strokeStyle = "#9C7D0A"; ctx.stroke();
    ctx.beginPath();                                                                              // fixed gold pointer
    ctx.moveTo(0, -R - 9); ctx.lineTo(-7, -R + 5); ctx.lineTo(7, -R + 5); ctx.closePath();
    ctx.fillStyle = GOLD; ctx.fill();
    ctx.restore();
  }

  /**
   * Mount the game visual in `cv` and start it looping; call land(resultIdx, done) to decelerate onto the
   * settled on-chain result. stop() tears down the frame loop (a view can change mid-spin).
   */
  function spinner(cv, range, opts) {
    opts = opts || {};
    var fitted = fit(cv), ctx = fitted.ctx, w = fitted.w, h = fitted.h;
    var raf = null, stopped = false, landing = false, t0 = 0, from = 0, to = 0, dur = 0, done = null;
    var ang = 0, face = 1, lastFlick = 0, result = 0, diceFrom = 0;
    var tick = opts.tick || function () {};

    function frame(now) {
      if (stopped) return;
      clear(ctx, w, h);
      if (!landing) {
        if (range == 2) { ang += 0.19; drawCoin(ctx, w, h, ang, Math.cos(ang) >= 0 ? "H" : "T"); }
        else if (range == 6) {
          if (now - lastFlick > DICE_FLICK_MS) { face = 1 + Math.floor(Math.random() * 6); lastFlick = now; }
          ang += 0.09; drawDie(ctx, w, h, face, Math.sin(ang) * 0.22, 1);
        } else { ang += 0.05; drawWheel(ctx, w, h, ang); }
      } else {
        var t = Math.min(1, (now - t0) / dur);
        if (range == 2) {
          var th = t >= 1 ? (result === 0 ? 0 : Math.PI) : from + (to - from) * easeOut(t, COIN_EASE);
          drawCoin(ctx, w, h, th, Math.cos(th) >= 0 ? "H" : "T");   // two faces, even mid-landing
        } else if (range == 6) {
          if (t < DICE_LOCK_AT) { if (now - lastFlick > DICE_FLICK_MS) { face = 1 + Math.floor(Math.random() * 6); lastFlick = now; } }
          else face = result + 1;
          var e = easeOut(t, 3);
          drawDie(ctx, w, h, face, (1 - e) * (diceFrom + DICE_SPIN * Math.PI / 180), 1 + (1 - e) * 0.08);
        } else {
          drawWheel(ctx, w, h, from + (to - from) * easeOut(t, ROU_EASE));
        }
        if (t >= 1) { stopped = true; if (done) done(); return; }
      }
      tick(now);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      land: function (idx, cb) {
        result = Math.max(0, parseInt(idx, 10) || 0);
        landing = true; done = cb; t0 = performance.now(); from = ang;
        if (range == 2) { dur = COIN_MS; to = ang + COIN_TURNS * 2 * Math.PI + (result === 0 ? 0 : Math.PI); to -= (ang % (2 * Math.PI)); }
        else if (range == 6) { dur = DICE_MS; diceFrom = Math.sin(ang) * 0.22; }
        else {
          dur = ROU_MS;
          var k = WHEEL.indexOf(result + 1), seg = Math.PI * 2 / 36;
          var offset = (Math.PI * 2) - (k + 0.5) * seg;                       // bring that pocket under the pointer
          to = ang - (ang % (Math.PI * 2)) + ROU_TURNS * Math.PI * 2 + offset;
        }
      },
      stop: function () { stopped = true; if (raf) cancelAnimationFrame(raf); }
    };
  }

  /** Exactly 12 squares, win only. */
  function confetti(cv) {
    var fitted = fit(cv), ctx = fitted.ctx, w = fitted.w, h = fitted.h;
    var cols = [GOLD, PINK, CYAN], P = [];
    for (var i = 0; i < CONF_N; i++) {
      P.push({ x: w * (0.25 + Math.random() * 0.5), y: h * 0.55,
        vx: (Math.random() - 0.5) * 5.5, vy: -6 - Math.random() * 5,
        s: 5 + Math.random() * 5, c: cols[i % cols.length],
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * (CONF_SPIN * Math.PI / 180) / 30 });
    }
    var t0 = performance.now();
    (function fr(now) {
      var t = (now - t0) / CONF_MS;
      clear(ctx, w, h);
      if (t >= 1) return;
      ctx.globalAlpha = 1 - t;                                   // linear fade
      P.forEach(function (p) {
        p.vy += CONF_GRAV; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
        ctx.restore();
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(fr);
    })(t0);
  }

  g.CasinoArt = {
    spinner: spinner, confetti: confetti,
    WHEEL: WHEEL, REDS: REDS, PIPS: PIPS,
    /** The APK's timings, exported so the panel and its tests read one source. */
    T: { COIN_MS: COIN_MS, COIN_TURNS: COIN_TURNS, COIN_EASE: COIN_EASE, COIN_GLYPH_AT: COIN_GLYPH_AT,
         DICE_MS: DICE_MS, DICE_SPIN: DICE_SPIN, DICE_FLICK_MS: DICE_FLICK_MS, DICE_LOCK_AT: DICE_LOCK_AT,
         ROU_MS: ROU_MS, ROU_TURNS: ROU_TURNS, ROU_EASE: ROU_EASE,
         CONF_N: CONF_N, CONF_MS: CONF_MS, CONF_GRAV: CONF_GRAV, CONF_SPIN: CONF_SPIN,
         OVERLAY_WATCHDOG_MS: 2800, OVERLAY_DISMISS_MS: 6000 }
  };
})(window);
