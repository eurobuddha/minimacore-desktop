/*
 * casino.js — the P2P Chance panel (the desktop's name for what the APK still ships as Zero Edge Casino),
 * rebuilt to that APK's own look and feel.
 *
 * Source of truth for the visuals: apks/casino Theme.java + Ui.java + the four view classes. DARK ONLY — the
 * light palette exists in Theme.java but nothing ever calls setLight(), so there is no toggle and none is
 * invented here. The single most important rule is Ui.text (Ui.java:63): **bold ⇒ monospace bold, non-bold ⇒
 * sans regular. There is no bold sans anywhere in this app.** Two CSS classes carry that whole type system.
 *
 * The name is the one deliberate divergence: this build is P2P Chance, so the wordmark, the age gate and every
 * other user-visible string say so. Internal identifiers stay `casino*` and main/casino/ stays untouched —
 * renaming those would break the donor byte-parity gate for nothing.
 *
 * NOTHING that moves value changed. casinoCreate / casinoTake / casinoCancel / casinoReveal / casinoResolve /
 * casinoClaimTimeout, the busy guards, the pre-post myBets snapshots, the confirm-on-chain state machine and
 * the age gate are carried over verbatim from renderer/app.js. The artwork cannot change a result: the
 * outcome and exact roll arrive already settled from the confirmed on-chain resolve.
 */
(function (g) {
  "use strict";

  // ---- injected dependencies (renderer/app.js owns these) ----
  var api, esc, el, toast, CasinoArt;
  var cfg = function () { return {}; };
  var setCfg = function () {};
  var activeView = function () { return ""; };
  var czLastBlock = 0;

  let casinoView = "play";        // play | house | mybets | history
  let casinoUpdateTimer = null;
  let casinoPick = {};            // coinid → chosen outcome index (PLAY)
  let casinoStatusCache = null;   // last casinoStatus()

  const CASINO_PRESETS = {
    flip: { name: "Coin Flip", icon: "✦", range: 2, payout: 2, labels: ["Heads", "Tails"] },
    dice: { name: "Dice", icon: "⚀", range: 6, payout: 6, labels: ["1", "2", "3", "4", "5", "6"] },
    roulette: { name: "Roulette", icon: "◉", range: 36, payout: 36, labels: null }
  };
  let casinoHousePreset = "flip";
  let casinoBusy = {};            // coinid/action → true while a txn is in flight (disable buttons)
  const casinoFlashed = {};      // coinid → true once its win/lose flash has shown (session)

  function casinoGame(range) { return range == 2 ? CASINO_PRESETS.flip : range == 6 ? CASINO_PRESETS.dice : range == 36 ? CASINO_PRESETS.roulette : { name: "Custom (" + range + ")", icon: "✳", range: range, payout: range }; }
  function casinoPickLabel(range, pick) { return range == 2 ? (parseInt(pick) === 0 ? "Heads" : "Tails") : "" + (parseInt(pick) + 1); }
  // ===== Currency (MxUSD "dollar mode") — mirrors the native APK / MDS. Persisted in CFG.casinoDollar; the
  // active token is pushed to the main-process engine via api.casinoSetCurrency so NEW bets + the header balance
  // use it. Existing-bet ops derive their token from the coin, so the renderer just filters/labels by tokenid. =====
  var CASINO_USD_TOKENID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  function casinoDollar() { return !!cfg().casinoDollar; }
  function casinoCcyToken() { return casinoDollar() ? CASINO_USD_TOKENID : "0x00"; }
  function casinoCcyLabel() { return casinoDollar() ? "USD" : "MINIMA"; }
  function casinoIsMinimaTok(t) { return !t || t === "0x00"; }
  function casinoCcyName(t) { return casinoIsMinimaTok(t) ? "MINIMA" : "USD"; }   // label a specific bet's token
  function casinoTokIsActive(t) { return casinoIsMinimaTok(t) ? !casinoDollar() : (casinoDollar() && String(t).toLowerCase() === CASINO_USD_TOKENID.toLowerCase()); }
  // Display: Minima keeps the 3dp truncation; MxUSD shows its TRUE token resolution (tidy full precision — a
  // coloured token's whole point is its decimals; truncating would hide real value). Display-only, never tx.
  function casinoFmtTok(v, tokenid) {
    if (casinoIsMinimaTok(tokenid)) return casinoFmt(v);
    var s = String(v == null ? "0" : v);
    if (s.indexOf("e") >= 0 || s.indexOf("E") >= 0) { var n = parseFloat(v); s = isNaN(n) ? "0" : n.toFixed(12); }
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return (s === "" || s === "-") ? "0" : s;
  }
  function applyCasinoCcyTheme() { try { var h = el("casinoBody"); if (!h) return; if (casinoDollar()) h.setAttribute("data-ccy", "usd"); else h.removeAttribute("data-ccy"); } catch (e) {} }
  function casinoSyncCurrency() { try { api.casinoSetCurrency(casinoCcyToken()); } catch (e) {} }   // tell the engine (new bets + balance)
  async function casinoToggleCurrency() {
    const next = !casinoDollar();
    try { setCfg(await api.saveConfig({ casinoDollar: next })); } catch (e) { cfg().casinoDollar = next; }
    casinoSyncCurrency();
    renderCasino();
  }

  function casinoFmt(v) {   // TRUNCATE to 3 dp, NEVER round up — a shown balance must never exceed the real one
    let n = parseFloat(v); if (isNaN(n)) n = 0;
    const neg = n < 0; n = Math.floor(Math.abs(n) * 1000) / 1000;
    let s = n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    const p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + p.join(".");
  }

  // --- pure Web-Audio SFX (CSP-safe: no files, no network) ---
  const casinoSfx = (() => {
    let ac = null, master = null, nbuf = null;
    function ctx() { try { if (!ac) { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination); } return ac; } catch (e) { return null; } }
    const on = () => { try { return localStorage.getItem("casino_mute") !== "1"; } catch (e) { return true; } };
    function noise() { const a = ctx(); if (!a) return null; if (!nbuf) { nbuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const d = nbuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return nbuf; }
    function tone(freq, dur, type, vol, when) { const a = ctx(); if (!a) return; const t = a.currentTime + (when || 0); const o = a.createOscillator(), g = a.createGain(); o.type = type || "sine"; o.frequency.value = freq; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol || 0.14, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur); }
    // noise-based mechanical click (spin ticks / roulette ball clatter)
    function click(freq, dur, vol, q) { const a = ctx(); if (!a) return; const s = a.createBufferSource(); s.buffer = noise(); const bp = a.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q || 9; const g = a.createGain(); s.connect(bp); bp.connect(g); g.connect(master); const t = a.currentTime; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.start(t); s.stop(t + dur + 0.02); }
    // FM bell for the win fanfare
    function bell(freq, at, dur, vol) { const a = ctx(); if (!a) return; const car = a.createOscillator(), mod = a.createOscillator(), mg = a.createGain(), g = a.createGain(); mod.frequency.value = freq * 1.5; mg.gain.value = freq * 1.2; mod.connect(mg); mg.connect(car.frequency); car.frequency.value = freq; car.type = "sine"; car.connect(g); g.connect(master); const t = a.currentTime + at; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05); }
    return {
      resume() { const a = ctx(); if (a && a.resume) try { a.resume(); } catch (e) {} },
      chip() { if (!on()) return; tone(180, 0.06, "square", 0.08); tone(240, 0.05, "square", 0.06, 0.045); },
      deal() { if (!on()) return; tone(330, 0.06, "triangle", 0.09); },
      spin() { if (!on()) return; click(1900, 0.03, 0.07, 10); },
      tick() { if (!on()) return; click(3000, 0.03, 0.05, 6); },
      clatter() { if (!on()) return; click(1700, 0.03, 0.13, 11); },
      land() { if (!on()) return; click(1500, 0.05, 0.18, 4); },
      win() { if (!on()) return; if (!ctx()) return; [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, i * 0.1, 1.0, 0.34)); bell(1318.5, 0.44, 1.3, 0.18); for (let i = 0; i < 7; i++) click(3800 + Math.random() * 3200, 0.06, 0.06, 6); },
      lose() { if (!on()) return; const a = ctx(); if (!a) return; const t = a.currentTime; const o = a.createOscillator(), lp = a.createBiquadFilter(), g = a.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(66, t + 0.55); lp.type = "lowpass"; lp.frequency.value = 1000; o.connect(lp); lp.connect(g); g.connect(master); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.34, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65); o.start(t); o.stop(t + 0.68); const s = a.createBufferSource(); s.buffer = noise(); const l2 = a.createBiquadFilter(); l2.type = "lowpass"; l2.frequency.value = 160; const g2 = a.createGain(); s.connect(l2); l2.connect(g2); g2.connect(master); g2.gain.setValueAtTime(0.45, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.32); s.start(t); s.stop(t + 0.34); },
      chime() { if (!on()) return; tone(880, 0.12, "sine", 0.1); tone(1174, 0.14, "sine", 0.09, 0.08); }
    };
  })();

  // --- in-play looping animation builders (ported from Zero Edge MDS; shown the whole time a bet resolves) ---
  // The in-play visual is the same procedural artwork as the reveal, looping: one 150px canvas per live bet,
  // mounted after the card is in the DOM (a canvas has no measurable size until then).
  function casinoAnimHTML(range, coinid) {
    if (range != 2 && range != 6 && range != 36) return "";
    return `<canvas class="cz-live" data-live="${coinid}" data-range="${range}"></canvas>`;
  }
  let casinoLiveSpins = [];
  function casinoStopLive() { casinoLiveSpins.forEach(s => { try { s.stop(); } catch (e) {} }); casinoLiveSpins = []; }
  function casinoMountLive(root) {
    casinoStopLive();
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("canvas[data-live]").forEach(cv => {
      try { casinoLiveSpins.push(CasinoArt.spinner(cv, parseInt(cv.dataset.range, 10))); } catch (e) {}
    });
  }

  // --- activity board (the notice-board feed; fed by main-side MDS.log lines via onCasinoLog) ---
  // The APK shows the newest line as an 11sp monospace TICKER under the header; tapping it opens the full log.
  let casinoActOpen = false;
  function casinoTickerText() {
    const last = casinoLog[casinoLog.length - 1];
    if (!last) return "› waiting for the engine…";
    const glyph = last.cls === "ok" ? "✓" : last.cls === "err" ? "✕" : last.cls === "warn" ? "⏳" : "›";
    return glyph + " " + last.t + "  " + last.msg;
  }
  let casinoLog = [];
  function casinoActClass(m) {
    const s = String(m).toLowerCase();
    if (/fail|error|reject|missing/.test(s)) return "err";
    if (/\bwon\b|\bwins\b|resolved|revealed|confirmed|created|paid|settle/.test(s)) return "ok";
    if (/reveal|resolv|waiting|pending|building|signing|secret/.test(s)) return "warn";
    if (/new |open bet|seen|took|taken/.test(s)) return "accent";
    return "info";
  }
  function casinoActAppend(box, e) {
    const row = document.createElement("div"); row.className = "cz-act-e";
    row.innerHTML = '<span class="cz-act-t">' + esc(e.t) + '</span><span class="cz-act-m ' + e.cls + '">' + esc(e.msg) + '</span>';
    box.appendChild(row);
  }
  function casinoActPaint() { const box = el("casinoActLog"); if (!box) return; box.innerHTML = ""; casinoLog.forEach(e => casinoActAppend(box, e)); box.scrollTop = box.scrollHeight; }
  function casinoNowHMS() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); }
  // 1-arg = a main-side "HH:MM:SS msg" line (parsed + rebranded); 2-arg = a renderer message with an explicit class.
  function casinoActivity(line, cls) {
    let t, msg = String(line == null ? "" : line);
    if (cls !== undefined) { t = casinoNowHMS(); }
    else {
      const m = msg.match(/^(\d{2}:\d{2}:\d{2})\s+([\s\S]*)$/);
      if (m) { t = m[1]; msg = m[2]; } else { t = casinoNowHMS(); }
      msg = msg.replace(/^Casino service:\s*/i, "");                                // drop the donor prefix
      msg = msg.replace(/Casino/g, "Chance").replace(/casino/g, "chance");          // cosmetic rebrand (donor untouched)
      cls = casinoActClass(msg);
    }
    if (!msg.trim()) return;
    casinoLog.push({ t, msg, cls });
    if (casinoLog.length > 200) casinoLog.shift();
    const box = el("casinoActLog");
    if (box) { casinoActAppend(box, casinoLog[casinoLog.length - 1]); box.scrollTop = box.scrollHeight; }
    const tk = el("casinoTicker");
    if (tk) { tk.textContent = casinoTickerText(); tk.className = "cz-ticker cz-ticker--" + casinoLog[casinoLog.length - 1].cls; }
  }

  // ===== Ported MDS bet-lifecycle state machine (refreshBets diff) — drives the rich activity feed + results =====
  // A bet is NOT "real" until the chain confirms it. Each block we diff the RAW coins (as MDS does) and narrate.
  let casinoPendingCreate = null;   // { game, range, stake }   — a create posted, not yet on-chain
  let casinoTaking = {};            // coinid → { game, range }  — a take posted, not yet on-chain
  let casinoCancelling = {};        // coinid → true             — a cancel posted, not yet confirmed
  let casinoPrevBets = [];          // last raw-coins snapshot (for the diff)
  let casinoResults = [];           // settled bets awaiting payout/result detection
  let casinoStartupChecked = false; // one-shot: recover results that settled while the app was closed
  async function casinoBlock() { try { const s = await api.casinoStatus(); return (s && s.block) ? Number(s.block) : null; } catch (e) { return null; } }
  function casinoGetState(coin, port) { const a = (coin && coin.state) || []; for (let i = 0; i < a.length; i++) { if (String(a[i].port) === String(port)) return a[i].data; } return ""; }
  function casinoNum(v) { return parseFloat(parseFloat(v).toFixed(8)); }
  let casinoCreateMsg = { text: "", cls: "" };   // persists the Offer-page status across re-renders
  function casinoSetCreateStatus(msg, cls) { casinoCreateMsg = { text: msg || "", cls: cls || "" }; const e = el("casinoCreateStatus"); if (e) { e.textContent = casinoCreateMsg.text; e.className = "cz-cstatus" + (cls ? " cz-cstatus--" + cls : ""); } }

  // Per-block: diff the raw coins, narrate every transition, capture settled bets for result detection.
  async function casinoRefresh() {
    let bets; try { bets = await api.casinoRawBets(); } catch (e) { return; }
    if (!Array.isArray(bets)) return;
    const gs = casinoGetState, prev = casinoPrevBets, block = await casinoBlock();

    // (2) phase transitions — match a bet across phases by its house commit state[2] (coinid changes each phase)
    if (prev.length) {
      bets.forEach(c => {
        const hc = gs(c, 2); if (!hc) return;
        const p = prev.find(x => gs(x, 2) === hc && x.coinid !== c.coinid); if (!p) return;
        const oldPh = parseInt(gs(p, 6)) || 0, newPh = parseInt(gs(c, 6)) || 0; if (oldPh === newPh) return;
        const rng = parseInt(gs(c, 3)) || 2, g = casinoGame(rng);
        if (oldPh === 0 && newPh === 1 && c.amHouse) { casinoActivity("Your " + g.name + " bet was taken — player picked " + casinoPickLabel(rng, gs(c, 11)) + ". Revealing your secret next block…", "accent"); toast("Your " + g.name + " bet was taken — game on!", "ok"); if (activeView() === "casino") casinoView = "mybets"; casinoSfx.deal(); }
        if (oldPh === 1 && newPh === 2 && c.amHouse) { casinoActivity("Secret revealed on your " + g.name + " bet — waiting for the player to resolve & collect…", "warn"); }
        if (oldPh === 1 && newPh === 2 && c.amPlayer) { casinoActivity("House revealed the secret on your " + g.name + " bet — resolving your result…", "warn"); casinoSfx.chime(); }
      });
    }
    // (3) settled — a bet I was in (by commit) has no successor now → capture it for payout/result detection
    if (prev.length) {
      const liveCommits = new Set(bets.map(c => gs(c, 2)).filter(Boolean));
      prev.forEach(p => {
        if (!(p.amHouse || p.amPlayer)) return;
        const hc = gs(p, 2); if (!hc || liveCommits.has(hc)) return;              // still on-chain (advanced) → not settled
        if ((parseInt(gs(p, 6)) || 0) < 1) return;                                // only bets that were actually in play
        if (casinoResults.some(r => r.commit === hc)) return;
        const rng = parseInt(gs(p, 3)) || 2;
        casinoResults.push({ commit: hc, coinid: p.coinid, role: p.amHouse ? "House" : "Player", range: rng, payout: parseInt(gs(p, 4)) || rng, bet: gs(p, 5) || "0", amount: parseFloat(p.amount) || 0, pickIdx: parseInt(gs(p, 11)), winAddr: gs(p, p.amHouse ? 1 : 9), atBlock: block || 0, attempts: 0, time: Date.now() });
      });
    }
    // maintain the restart-proof watchlist for my in-play bets; recover (one-shot) any that settled while closed
    bets.forEach(c => {
      if ((c.amHouse || c.amPlayer) && (parseInt(gs(c, 6)) || 0) >= 1) {
        const hc = gs(c, 2);
        if (hc) casinoWatchAdd(hc, { role: c.amHouse ? "House" : "Player", range: parseInt(gs(c, 3)) || 2, payout: parseInt(gs(c, 4)) || 2, bet: gs(c, 5) || "0", amount: parseFloat(c.amount) || 0, pickIdx: parseInt(gs(c, 11)), coinid: c.coinid });
      }
    });
    if (!casinoStartupChecked) {
      casinoStartupChecked = true;
      const live = new Set(bets.map(c => gs(c, 2)).filter(Boolean));
      const w = casinoWatchGet();
      Object.keys(w).forEach(hc => {
        if (!live.has(hc) && !casinoResults.some(r => r.commit === hc)) {
          const m = w[hc];
          casinoResults.push({ commit: hc, coinid: m.coinid, role: m.role, range: m.range, payout: m.payout, bet: m.bet, amount: m.amount, pickIdx: m.pickIdx, winAddr: "", atBlock: block || 0, attempts: 0, time: Date.now() });
        }
      });
    }
    // (4) take confirmed — a new phase-1 coin where I'm player appeared
    if (Object.keys(casinoTaking).length) {
      const prevIds = new Set(prev.map(p => p.coinid));
      const took = bets.find(c => c.amPlayer && (parseInt(gs(c, 6)) || 0) >= 1 && !prevIds.has(c.coinid));
      if (took) { const cid = Object.keys(casinoTaking)[0], tk = casinoTaking[cid]; delete casinoTaking[cid]; casinoActivity("✓ " + tk.game + " bet taken & confirmed on-chain" + (block ? " (block " + block + ")" : "") + " — waiting for the house to reveal.", "ok"); }
    }
    // (5) cancel confirmed — the cancelled coin is gone
    Object.keys(casinoCancelling).forEach(cid => { if (!bets.some(c => c.coinid === cid)) { delete casinoCancelling[cid]; casinoActivity("✓ Bet cancelled & confirmed on-chain — your stake was returned.", "ok"); toast("Cancel confirmed — stake returned ✓", "ok"); } });

    casinoPrevBets = bets;
    await casinoResolveResults(block);
  }

  // Ported coinIsPayout + resolvePendingResults: detect the incoming payout to decide win/lose + winnings for
  // the side the background service did NOT record (mainly the house). De-duped against history.
  function casinoCoinIsPayout(c, pr, amt) {
    const created = parseInt(c.created);
    if (isNaN(created) || created < ((pr.atBlock || 0) - 2)) return false;   // must be a fresh coin
    if (Math.abs(parseFloat(c.amount) - amt) >= 0.001) return false;         // of the payout value
    if (pr.winAddr) { return (c.address || "") === pr.winAddr || (c.miniaddress || "") === pr.winAddr; }
    return true;
  }
  // Restart-proof watchlist of my in-play bets (commit → meta), so a result that settles while the app is closed
  // is still recovered on next launch (via the retroactive txpow read).
  function casinoWatchGet() { try { return JSON.parse(localStorage.getItem("casino_watch") || "{}"); } catch (e) { return {}; } }
  function casinoWatchSet(w) { try { localStorage.setItem("casino_watch", JSON.stringify(w)); } catch (e) {} }
  function casinoWatchAdd(commit, meta) { if (!commit) return; const w = casinoWatchGet(); w[commit] = meta; casinoWatchSet(w); }
  function casinoWatchDrop(commit) { if (!commit) return; const w = casinoWatchGet(); if (w[commit] !== undefined) { delete w[commit]; casinoWatchSet(w); } }
  function casinoResultProfit(pr, out) {
    const bet = parseFloat(out.bet != null ? out.bet : pr.bet), payout = out.payout || pr.payout;
    if (pr.role === "House") return out.won ? bet : casinoNum(bet * (payout - 1));
    return out.won ? casinoNum(casinoNum(bet * payout) - bet) : bet;
  }
  async function casinoResolveResults(block) {
    if (!casinoResults.length) return;
    let hist; try { hist = await api.casinoHistory() || []; } catch (e) { hist = []; }
    const keep = [];
    for (const pr of casinoResults) {
      if (hist.some(h => h.coinid === pr.coinid)) { casinoWatchDrop(pr.commit); continue; }   // service recorded it → casinoWatchResults flashes it
      // PRIMARY — mechanism B: read the taker's resolve txn for the EXACT result, instantly.
      let out = null; try { out = await api.casinoResolveOutcome(pr.commit, pr.role); } catch (e) {}
      if (out && out.found) {
        const profit = casinoResultProfit(pr, out);
        casinoFlashed[out.coinid] = true; if (pr.coinid) casinoFlashed[pr.coinid] = true;   // BEFORE flashing → main just wrote history; block a double-modal
        casinoFlash(out.won, casinoGame(out.range).name, profit, out.pickLabel, out.resultLabel, out.range, pr.role);
        casinoActivity((out.won ? "✓ WON +" : "✗ LOST −") + casinoFmt(profit) + " MINIMA — " + casinoGame(out.range).name + " (as " + pr.role + ")" + (out.resultLabel && out.resultLabel !== "—" ? " · result " + out.resultLabel : ""), out.won ? "ok" : "err");
        casinoWatchDrop(pr.commit);
        continue;
      }
      // Not in the txpowdb yet — retry a few blocks, then FALLBACK A (payout-coin detection), made prompt.
      pr.attempts = (pr.attempts || 0) + 1;
      if (pr.attempts < 3) { keep.push(pr); continue; }
      let wallet; try { wallet = await api.casinoWalletCoins() || []; } catch (e) { keep.push(pr); continue; }
      const plain = wallet.filter(c => !c.state || c.state.length === 0);
      let won, profit;
      if (pr.role === "House") { won = plain.some(c => casinoCoinIsPayout(c, pr, parseFloat(pr.amount))); profit = won ? parseFloat(pr.bet) : casinoNum(parseFloat(pr.bet) * (pr.payout - 1)); }
      else { const winAmt = casinoNum(parseFloat(pr.bet) * pr.payout); won = plain.some(c => casinoCoinIsPayout(c, pr, winAmt)); profit = won ? casinoNum(winAmt - parseFloat(pr.bet)) : parseFloat(pr.bet); }
      if (!won && pr.attempts < 6) { keep.push(pr); continue; }   // give a loss a few more blocks before committing
      const pickLbl = (pr.pickIdx >= 0 && !isNaN(pr.pickIdx)) ? casinoPickLabel(pr.range, pr.pickIdx) : "—";
      casinoFlash(won, casinoGame(pr.range).name, profit, pickLbl, "—", pr.range, pr.role);
      casinoActivity((won ? "✓ WON +" : "✗ LOST −") + casinoFmt(profit) + " MINIMA — " + casinoGame(pr.range).name + " (as " + pr.role + ")", won ? "ok" : "err");
      if (pr.coinid) casinoFlashed[pr.coinid] = true;
      casinoWatchDrop(pr.commit);
    }
    casinoResults = keep;
    if (activeView() === "casino") renderCasino();
  }

  // --- one-time 18+ self-cert gate (styled overlay, matches the approved mock) ---
  function casinoAgeGate(onCertify) {
    const ov = document.createElement("div"); ov.className = "cz-ov czapp";
    ov.innerHTML = '<div class="cz-modal"><div class="cz-modt">⚠ AGE VERIFICATION</div>' +
      '<p class="cz-desc">P2P Chance is <b>peer-to-peer betting with real MINIMA</b> — you play directly against another person, settled on-chain. No house, no edge — true odds.</p>' +
      '<p class="cz-fine">“I certify that I am 18 or older and of legal gambling age in my jurisdiction, and I accept the risks of betting real MINIMA.”</p>' +
      '<div class="cz-row2"><button class="cz-btn" id="ageCancel">Cancel</button><button class="cz-btn cz-btn--gold" id="ageOk">I certify — enable</button></div></div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector("#ageCancel").addEventListener("click", close);
    ov.querySelector("#ageOk").addEventListener("click", () => { close(); try { onCertify(); } catch (e) {} });
  }

  // Create-confirm via the AUTHORITATIVE digested read-model (myBets), not the raw-coin annotation. The instant a
  // NEW phase-0 bet where I'm house appears (not in the pre-post snapshot), the create is confirmed on-chain →
  // clear the transient Offer-page status and JUMP to My Bets, the one place bets live.
  async function casinoCheckCreateConfirm() {
    if (!casinoPendingCreate) return;
    const pc = casinoPendingCreate;
    let mine; try { mine = await api.casinoMyBets() || []; } catch (e) { return; }
    const fresh = mine.find(b => b.amHouse && b.phase === 0 && !(pc.snap && pc.snap.has(b.coinid)));
    if (!fresh) return;
    casinoPendingCreate = null;
    const block = await casinoBlock();
    casinoActivity("✓ " + pc.game + " bet confirmed on-chain — LIVE" + (block ? " (block " + block + ")" : "") + ", " + casinoFmt(pc.stake) + " MINIMA locked. Waiting for a taker.", "ok");
    casinoSetCreateStatus("", "");            // clear the transient status — no stale "waiting"
    toast(pc.game + " bet is live ✓", "ok"); casinoSfx.chime();
    casinoView = "mybets";                     // JUMP to My Bets — the ONLY place bets live
  }

  // Take-confirm via the AUTHORITATIVE myBets read-model (not the flaky per-block raw-coin diff). The instant a NEW
  // amPlayer phase>=1 bet appears, the take is confirmed on-chain → clear the "Confirming" placeholder so the bet
  // renders in My Bets with its in-play animation (and its result later flashes via casinoWatchResults/ResolveResults).
  async function casinoCheckTakeConfirm() {
    if (!Object.keys(casinoTaking).length) return;
    let mine; try { mine = await api.casinoMyBets() || []; } catch (e) { return; }
    const key = Object.keys(casinoTaking)[0], tk = casinoTaking[key];
    const fresh = mine.find(b => b.amPlayer && b.phase >= 1 && !(tk.snap && tk.snap.has(b.coinid)));
    if (!fresh) return;
    delete casinoTaking[key];
    const block = await casinoBlock();
    casinoActivity("✓ " + (tk.game || "Bet") + " bet taken & confirmed on-chain" + (block ? " (block " + block + ")" : "") + " — game on! Waiting for the house to reveal.", "ok");
    toast((tk.game || "Bet") + " is live ✓", "ok"); casinoSfx.chime();
    if (activeView() === "casino") casinoView = "mybets";
  }

  function onCasinoUpdate() {
    if (casinoUpdateTimer) clearTimeout(casinoUpdateTimer);
    casinoUpdateTimer = setTimeout(async () => {
      refreshCasinoBadge();
      await casinoRefresh();        // per-block: diff raw coins → narrate every step + detect results
      await casinoCheckCreateConfirm();   // confirm a just-posted create via myBets → clear status + jump to My Bets
      await casinoCheckTakeConfirm();     // confirm a just-posted TAKE via myBets → clear "Confirming", keep on My Bets
      await casinoWatchResults();   // flash service-recorded (player) results with the exact outcome
      if (activeView() !== "casino") return;
      if (el("casinoBody") && el("casinoBody").querySelector("input:focus")) return;   // never stomp a form
      renderCasino();
    }, 350);
  }
  async function refreshCasinoBadge() {
    try { const n = await api.casinoNewCount(); const b = el("casinoBadge"); if (!b) return; if (n > 0) { b.textContent = n; b.hidden = false; } else b.hidden = true; } catch (e) {}
  }
  // A background reveal/resolve (service.js) records to casino_history — surface the newest fresh win/lose as a flash.
  async function casinoWatchResults() {
    let hist = []; try { hist = await api.casinoHistory(); } catch (e) { return; }
    const now = Date.now();
    const fresh = (hist || []).filter(h => h && h.coinid && !casinoFlashed[h.coinid] && (now - (Number(h.time) || 0)) < 180000);
    if (!fresh.length) { (hist || []).forEach(h => { if (h && h.coinid) casinoFlashed[h.coinid] = true; }); return; }
    (hist || []).forEach(h => { if (h && h.coinid) casinoFlashed[h.coinid] = true; });   // mark all seen so only the newest flashes
    const h = fresh[0];   // history is newest-first
    casinoFlash(!!h.won, h.game, h.profit, h.pickLabel, h.resultLabel, h.range, h.role);
    casinoActivity((h.won ? "✓ WON +" : "✗ LOST −") + casinoFmt(h.profit) + " MINIMA — " + h.game + " (as " + (h.role || "") + ")", h.won ? "ok" : "err");
  }

  let casinoOwnedBets = [];   // last successful all-currency scan; transient RPC misses must not hide claims
  async function renderCasino() {
    const host = el("casinoBody"); if (!host) return;
    let st = null, bal = "0", stake = null;
    try { st = await api.casinoStatus(); } catch (e) {}
    try { bal = await api.casinoBalance(); } catch (e) {}
    try { stake = await api.casinoStakeable(); } catch (e) {}   // honest max single bet (largest signable-address sendable total)
    casinoStatusCache = st;
    casinoSyncCurrency();   // ensure the engine's active token matches the toggle (new bets + balance)
    api.casinoSeen().catch(() => {}); refreshCasinoBadge();   // viewing the tab clears the unseen-result badge
    const ready = st && st.ready;
    try { casinoOwnedBets = await api.casinoMyBets(); } catch (e) {}
    const owned = casinoOwnedBets;
    const claims = owned.filter(b => b.canClaimTimeout);
    const nativeClaims = claims.filter(b => casinoIsMinimaTok(b.tokenid)).length;
    const usdClaims = claims.length - nativeClaims;
    const claimSummary = claims.length + " timeout claim" + (claims.length === 1 ? "" : "s") + " available (" + [nativeClaims ? nativeClaims + " Minima" : "", usdClaims ? usdClaims + " USD" : ""].filter(Boolean).join(" · ") + ")";
    // Header "available to bet": in USD mode the Minima-only stakeable ceiling doesn't apply, so show the
    // MxUSD balance at true resolution; in Minima mode keep the honest single-address stakeable ceiling.
    const availLbl = casinoCcyLabel();
    const availVal = casinoDollar() ? casinoFmtTok(bal, casinoCcyToken()) : casinoFmt(stake != null ? stake : bal);
    const tab = (v, label) => `<button class="cz-tab${casinoView === v ? " is-on" : ""}" data-cv="${v}">${label}</button>`;
    const muted = (() => { try { return localStorage.getItem("casino_mute") === "1"; } catch (e) { return false; } })();
    host.innerHTML =
      `<div class="cz-head">
         <div class="cz-brand">
           <div class="cz-name">P2P CHANCE</div>
           <div class="cz-tagline">TRUE ODDS · NO HOUSE</div>
         </div>
         <div class="cz-bal"><div class="cz-bal-v" title="The largest single bet you can place right now — in-play stakes & pending coins excluded">${availVal}</div><div class="cz-bal-u">${esc(availLbl)}</div></div>
         <span class="cz-dot${ready ? " is-live" : ""}" id="casinoDot" title="${ready ? "engine ready" : "engine starting"}"></span>
         <span class="cz-blk" id="casinoBlk">${st && st.block ? "#" + st.block : "—"}</span>
         <button class="cz-pill" id="casinoCcy" title="Currency — Minima or MxUSD (USD)">${casinoCcyLabel()}</button>
         <button class="cz-pill" id="casinoMute" title="Sound">${muted ? "🔇" : "🔊"}</button>
       </div>
       <div class="cz-ticker" id="casinoTicker" title="Open the activity log">${esc(casinoTickerText())}</div>
       <div class="cz-desc cz-desc--intro">Games of chance played directly between two people, settled on-chain — <b>no middleman, no house edge, true odds</b>. Real ${esc(availLbl)} at stake.</div>
       ${claims.length ? `<button class="cz-btn cz-btn--claims" data-cv="mybets">${esc(claimSummary)} — Open My Bets</button>` : ""}
       <div class="cz-tabs">${tab("play", "PLAY")}${tab("house", "HOUSE")}${tab("mybets", "MY BETS" + (owned.length ? " (" + owned.length + ")" : ""))}${tab("history", "HISTORY")}</div>
       <div id="casinoSub"></div>
       <div class="cz-act${casinoActOpen ? " is-open" : ""}"><div class="cz-act-hdr"><span class="cz-dot is-live"></span>Activity</div><div class="cz-act-log" id="casinoActLog"></div></div>`;
    host.querySelectorAll("[data-cv]").forEach(b => b.addEventListener("click", () => { casinoView = b.dataset.cv; renderCasino(); }));
    const tk = el("casinoTicker");
    if (tk) tk.addEventListener("click", () => { casinoActOpen = !casinoActOpen; renderCasino(); });
    const mute = el("casinoMute");
    if (mute) mute.addEventListener("click", () => { try { const m = localStorage.getItem("casino_mute") === "1"; localStorage.setItem("casino_mute", m ? "0" : "1"); } catch (e) {} renderCasino(); });
    const ccy = el("casinoCcy");
    if (ccy) ccy.addEventListener("click", casinoToggleCurrency);
    applyCasinoCcyTheme();   // green "dollar" accent on casinoBody when USD is active
    renderCasinoSub();
    casinoActPaint();   // restore the activity board from the ring after a re-render
  }

  function renderCasinoSub() {
    casinoStopLive();   // leaving My Bets must not leave a canvas loop running behind the new view
    if (casinoView === "play") return renderCasinoPlay();
    if (casinoView === "house") return renderCasinoHouse();
    if (casinoView === "mybets") return renderCasinoMyBets();
    if (casinoView === "history") return renderCasinoHistory();
  }

  // ---------------- PLAY: take other players' open bets ----------------
  async function renderCasinoPlay() {
    const host = el("casinoSub"); if (!host) return;
    let bets = []; try { bets = await api.casinoOpenBets(); } catch (e) {}
    if (el("casinoSub") !== host) return;   // view changed while awaiting
    bets = (bets || []).filter(b => casinoTokIsActive(b.tokenid));   // show only the active currency's open bets
    if (!bets.length) { host.innerHTML = `<div class="cz-card"><div class="cz-desc">No open ${esc(casinoCcyLabel())} bets right now. Switch to <b>Be the House</b> to offer one, or check back — bets from the native app & MiniDapp appear here too.</div></div>`; return; }
    host.innerHTML = bets.map(b => {
      const g = casinoGame(b.range), odds = (b.payout - 1), tn = casinoCcyName(b.tokenid);
      const win = casinoFmtTok(parseFloat(b.bet) * b.payout, b.tokenid);
      const pick = casinoPick[b.coinid];
      const picker = casinoPicker(b.range, b.coinid, pick);
      const canTake = pick !== undefined && pick !== null && pick !== "";
      return `<div class="cz-card cz-bet">
        <div class="cz-bet-top"><span class="cz-ico">${g.icon}</span>
          <span class="cz-bet-name">${esc(g.name)}</span>
          <span class="cz-badge cz-badge--odds">${odds}:1</span></div>
        <div class="cz-kv"><span>Bet</span><b>${casinoFmtTok(b.bet, b.tokenid)} ${tn}</b></div>
        <div class="cz-kv"><span>You win</span><b style="color:var(--cz-green)">${win} ${tn}</b></div>
        <div class="cz-picks">${picker}</div>
        <button class="cz-btn cz-btn--cta cz-take" data-coin="${b.coinid}" ${canTake && !casinoBusy[b.coinid] ? "" : "disabled"}>${casinoBusy[b.coinid] ? "Taking…" : (canTake ? "TAKE BET — pick " + esc(casinoPickLabel(b.range, pick)) : "Choose your pick")}</button>
      </div>`;
    }).join("");
    // pick controls
    host.querySelectorAll("[data-pick]").forEach(elm => elm.addEventListener("click", () => { casinoPick[elm.dataset.coin] = parseInt(elm.dataset.pick); renderCasinoPlay(); }));
    host.querySelectorAll(".cz-take").forEach(btn => btn.addEventListener("click", () => casinoDoTake(btn.dataset.coin)));
  }

  /**
   * The pick grid. The APK lays these out by game — 2 columns for Flip, 6 for Dice, 6×6 for Roulette — every
   * chip flex:1, the selected one filled gold on ink. Roulette used to be a bare number input here; the grid
   * is what the phone shows, so the grid is what this shows.
   */
  function casinoPicker(range, coinid, pick) {
    const chip = (i, label) => `<button class="cz-chip${pick === i ? " is-on" : ""}" data-pick="${i}" data-coin="${coinid}">${label}</button>`;
    if (range == 2) return `<div class="cz-grid cz-grid--2">${chip(0, "HEADS")}${chip(1, "TAILS")}</div>`;
    if (range == 6) return `<div class="cz-grid cz-grid--6">${[0, 1, 2, 3, 4, 5].map(i => chip(i, i + 1)).join("")}</div>`;
    let cells = "";
    for (let i = 0; i < 36; i++) cells += chip(i, i + 1);
    return `<div class="cz-grid cz-grid--36">${cells}</div>`;
  }

  async function casinoDoTake(coinid) {
    if (casinoBusy[coinid]) return;
    const pick = casinoPick[coinid];
    if (pick === undefined || pick === null || pick === "") { toast("Choose your pick first", "warn"); return; }
    casinoBusy[coinid] = true; renderCasinoPlay(); casinoSfx.deal();
    casinoActivity("Taking bet — building & posting your take transaction…", "accent");
    // Snapshot my current bets BEFORE posting, so the authoritative-myBets take-confirm (casinoCheckTakeConfirm)
    // can spot the NEW taken bet regardless of raw-coin snapshot timing (mirrors casinoDoCreate's snap).
    const takeSnap = new Set();
    try { (await api.casinoMyBets() || []).forEach(b => takeSnap.add(b.coinid)); } catch (e) {}
    try {
      const r = await api.casinoTake(coinid, pick);
      delete casinoBusy[coinid]; delete casinoPick[coinid];
      const g = (r && r.game) || "Bet", range = (r && r.range) || 2;
      casinoTaking[coinid] = { game: g, range, snap: takeSnap };
      casinoActivity("Take accepted by the node — waiting for on-chain confirmation (can take up to 3 blocks)…", "warn");
      toast(g + " bet posted — confirming on-chain…", "ok");
      casinoView = "mybets"; renderCasino();
    } catch (e) {
      delete casinoBusy[coinid];
      const msg = (e && e.message ? e.message : String(e));
      casinoActivity("Take failed: " + msg, "err");
      toast("Take failed: " + msg, "err");
      renderCasinoPlay();
    }
  }

  // ---------------- HOUSE: create a bet + manage your open offers ----------------
  async function renderCasinoHouse() {
    const host = el("casinoSub"); if (!host) return;
    const p = CASINO_PRESETS[casinoHousePreset];
    const betInput = el("casinoBetAmt");
    const curBet = betInput ? betInput.value : "";
    const card = (id, g) => `<button class="cz-preset${casinoHousePreset === id ? " is-on" : ""}" data-preset="${id}"><span class="cz-preset-i">${g.icon}</span><span class="cz-preset-n">${esc(g.name).toUpperCase()}</span><span class="cz-preset-o">${g.payout - 1}:1</span></button>`;
    host.innerHTML =
      `<div class="cz-card">
        <div class="cz-presets">${card("flip", CASINO_PRESETS.flip)}${card("dice", CASINO_PRESETS.dice)}${card("roulette", CASINO_PRESETS.roulette)}</div>
        <label class="cz-lbl">Player's bet (${esc(casinoCcyLabel())})</label>
        <input class="cz-input" id="casinoBetAmt" type="number" min="0" step="0.01" placeholder="e.g. 10" value="${esc(curBet)}">
        <div id="casinoHouseSummary" class="cz-summary"></div>
        <button class="cz-btn cz-btn--gold" id="casinoCreateBtn" ${casinoBusy.create ? "disabled" : ""}>${casinoBusy.create ? "Creating…" : "CREATE BET"}</button>
        <div id="casinoCreateStatus" class="cz-cstatus${casinoCreateMsg.cls ? " casino-cstatus--" + casinoCreateMsg.cls : ""}">${esc(casinoCreateMsg.text)}</div>
        <div class="cz-note">You stake the amount you could lose; the player adds their bet and picks an outcome. When they take it, your node auto-reveals — zero house edge, the whole pot is paid out. Once your bet confirms on-chain (up to 3 blocks) you'll jump to <b>My Bets</b> — that's where all your bets live.</div>
      </div>`;
    host.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { casinoHousePreset = b.dataset.preset; renderCasinoHouse(); }));
    const amt = el("casinoBetAmt");
    if (amt) amt.addEventListener("input", casinoUpdateHouseSummary);
    casinoUpdateHouseSummary();
    const cb = el("casinoCreateBtn");
    if (cb) cb.addEventListener("click", casinoDoCreate);
  }

  function casinoUpdateHouseSummary() {
    const box = el("casinoHouseSummary"); if (!box) return;
    const p = CASINO_PRESETS[casinoHousePreset];
    const bet = parseFloat((el("casinoBetAmt") || {}).value) || 0;
    let stake = parseFloat((bet * (p.payout - 1)).toFixed(8)); if (stake <= 0) stake = bet;
    box.innerHTML = `<div class="cz-kv"><span>You lock</span><b>${casinoFmt(stake)} ${esc(casinoCcyLabel())}</b></div>
      <div class="cz-kv"><span>If the player wins</span><b style="color:var(--cz-red)">−${casinoFmt(stake)}</b></div>
      <div class="cz-kv"><span>If the player loses</span><b style="color:var(--cz-green)">+${casinoFmt(bet)}</b></div>
      <div class="cz-kv"><span>Odds</span><b>${p.payout - 1}:1 (fair)</b></div>`;
    const cb = el("casinoCreateBtn"); if (cb && !casinoBusy.create) cb.textContent = stake > 0 ? "CREATE BET — LOCK " + casinoFmt(stake) : "CREATE BET";
  }

  async function casinoDoCreate() {
    if (casinoBusy.create) return;
    const bet = parseFloat((el("casinoBetAmt") || {}).value);
    if (!bet || bet <= 0 || isNaN(bet)) { toast("Enter a valid bet amount", "warn"); return; }
    const p = CASINO_PRESETS[casinoHousePreset];
    casinoBusy.create = true; casinoSetCreateStatus("Generating secret & posting your stake transaction…", "warn"); renderCasinoHouse(); casinoSfx.chip();
    casinoActivity("Creating " + p.name + " bet — building & posting the stake transaction…", "accent");
    // Snapshot the coinids of my current bets BEFORE posting — the create is confirmed when a NEW phase-0 amHouse bet appears.
    const snap = new Set();
    try { (await api.casinoMyBets() || []).forEach(b => snap.add(b.coinid)); } catch (e) {}
    try {
      const r = await api.casinoCreate(casinoHousePreset, String(bet));
      delete casinoBusy.create;
      casinoPendingCreate = { game: p.name, range: p.range, stake: (r && r.stake) || bet, snap };
      casinoActivity("Transaction accepted by the node — waiting for on-chain confirmation (up to 3 blocks)…", "warn");
      casinoSetCreateStatus("Posted — waiting for on-chain confirmation (up to 3 blocks)…", "warn");
      toast(p.name + " bet posted — confirming on-chain…", "ok");
      renderCasinoHouse();   // STAY on the Offer page; the bet appears in My Bets only once it confirms on-chain
    } catch (e) {
      delete casinoBusy.create;
      const msg = (e && e.message ? e.message : String(e));
      casinoActivity("Create failed: " + msg, "err");
      casinoSetCreateStatus("Create failed: " + msg, "err");
      toast("Create failed: " + msg, "err");
      renderCasinoHouse();
    }
  }

  async function casinoDoCancel(coinid) {
    if (casinoBusy[coinid]) return;
    casinoBusy[coinid] = true; renderCasinoHouse();
    casinoActivity("Cancelling bet — building & posting the reclaim transaction…", "accent");
    try {
      const r = await api.casinoCancel(coinid);
      delete casinoBusy[coinid];
      casinoCancelling[coinid] = true;
      casinoActivity("Cancel accepted by the node — waiting for on-chain confirmation…", "warn");
      toast("Cancel posted — confirming on-chain…", "ok");
      renderCasino();
    } catch (e) {
      delete casinoBusy[coinid];
      const msg = (e && e.message ? e.message : String(e));
      casinoActivity("Cancel failed: " + msg, "err");
      toast("Cancel failed: " + msg, "err");
      renderCasinoHouse();
    }
  }

  // ---------------- MY BETS: active bets in flight ----------------
  async function renderCasinoMyBets() {
    const host = el("casinoSub"); if (!host) return;
    try { casinoOwnedBets = await api.casinoMyBets(); } catch (e) {}
    const bets = casinoOwnedBets;
    if (el("casinoSub") !== host) return;
    const active = bets || [];   // Every owned bet, independent of the currency toggle.
    // Pending placeholders — a create/take is NOT a real bet until the chain confirms it (mirrors MDS).
    // Pending CREATE shows its status on the Offer page; pending TAKE is a TEXT-ONLY card here (no animation —
    // the spinning game only plays once a bet is actually in play, phase >= 1).
    let ph = "";
    if (Object.keys(casinoTaking).length) ph += `<div class="cz-card cz-card--mid"><div class="cz-note" style="color:var(--cz-amber);font-weight:600;margin:0">⏳ Bet taken! It can take up to 3 blocks for your bet to appear here.</div></div>`;
    if (!ph && !active.length) { host.innerHTML = `<div class="cz-card"><div class="cz-desc">No bets in flight. Take one in <b>Play</b> or offer one in <b>Be the House</b>.</div></div>`; return; }
    host.innerHTML = ph + active.map(b => {
      const g = casinoGame(b.range);
      let statusTxt = "", statusCol = "var(--cz-amber)", extra = "";
      const canTimeout = b.canClaimTimeout;
      if (b.phase === 0) { statusTxt = "Open — waiting for a taker"; extra = `<button class="cz-btn cz-btn--sm cz-cancel" data-coin="${b.coinid}">Cancel & reclaim</button>`; }
      else if (b.phase === 1 && b.amHouse) { statusTxt = "Taken — auto-revealing…"; extra = b.age > 10 ? `<button class="cz-btn cz-btn--sm cz-reveal" data-coin="${b.coinid}">Force reveal</button>` : ""; }
      else if (b.phase === 1) { statusTxt = "Waiting for house to reveal…"; }
      else if (b.phase === 2 && b.amPlayer) { statusTxt = "Revealing — auto-resolving…"; statusCol = "var(--cz-green)"; extra = b.age > 10 ? `<button class="cz-btn cz-btn--sm cz-resolve" data-coin="${b.coinid}">Force resolve</button>` : ""; }
      else if (b.phase === 2) { statusTxt = "Waiting for player to resolve…"; }
      if (b.expired && b.phase >= 1) statusTxt = canTimeout ? "Timeout claim available" : "Counterparty can claim timeout";
      if (canTimeout) extra = `<button class="cz-btn cz-btn--sm cz-btn--danger cz-timeout" data-coin="${b.coinid}" style="color:var(--cz-red);border-color:var(--cz-red)">Claim timeout</button>`;
      const pickTxt = (b.pick !== "" && b.pick != null && b.amPlayer) ? " · picked " + casinoPickLabel(b.range, b.pick) : "";
      const inflight = b.phase >= 1;   // taken/revealing/resolving → show the looping game animation
      return `<div class="cz-card cz-bet${inflight ? " cz-bet--live" : ""}">
        <div class="cz-bet-top"><span class="cz-ico">${g.icon}</span><span class="cz-bet-name">${esc(g.name)} · ${casinoCcyName(b.tokenid)}</span>
          <span class="cz-bet-role">${esc(b.role)}${pickTxt}</span></div>
        ${inflight ? casinoAnimHTML(b.range, b.coinid) : ""}
        <div class="cz-kv"><span>Pot</span><b>${casinoFmtTok(b.amount, b.tokenid)} ${casinoCcyName(b.tokenid)}</b></div>
        <div class="cz-kv"><span>Status</span><b style="color:${statusCol}">${statusTxt}</b></div>
        ${b.timeout ? `<div class="cz-kv"><span>Age</span><b>${b.blocksUntilClaim == null ? "Waiting for block age" : b.blocksUntilClaim > 0 ? b.blocksUntilClaim + " blocks until timeout" : "Expired"}</b></div>` : ""}
        ${casinoBusy[b.coinid] ? `<div class="cz-note" style="color:var(--cz-amber)">${casinoCancelling[b.coinid] ? "Cancelling — posting to chain…" : "Posting to chain…"}</div>` : extra}
      </div>`;
    }).join("");
    casinoMountLive(host);   // the in-play canvases can only size themselves once they are in the DOM
    host.querySelectorAll(".cz-cancel").forEach(btn => btn.addEventListener("click", () => casinoDoCancel(btn.dataset.coin)));
    host.querySelectorAll(".cz-reveal").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "reveal")));
    host.querySelectorAll(".cz-resolve").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "resolve")));
    host.querySelectorAll(".cz-timeout").forEach(btn => btn.addEventListener("click", () => casinoDoFallback(btn.dataset.coin, "timeout")));
  }

  async function casinoDoFallback(coinid, kind) {
    if (casinoBusy[coinid]) return;
    const label = kind === "reveal" ? "Revealing secret" : kind === "resolve" ? "Resolving result" : "Claiming timeout";
    casinoBusy[coinid] = true; renderCasinoMyBets();
    casinoActivity(label + " — building & posting the transaction…", "accent");
    const fn = kind === "reveal" ? api.casinoReveal : kind === "resolve" ? api.casinoResolve : api.casinoClaimTimeout;
    try {
      const r = await fn(coinid);
      delete casinoBusy[coinid];
      if (kind === "resolve" && r) {
        casinoFlashed[coinid] = true;
        const won = r.isHouse ? !r.playerWins : r.playerWins;
        casinoFlash(won, casinoGame(r.range).name, null, casinoPickLabel(r.range, r.pick), casinoPickLabel(r.range, r.result), r.range, r.isHouse ? "House" : "Player");
        casinoActivity((won ? "✓ WON — " : "✗ LOST — ") + casinoGame(r.range).name + " resolved on-chain (result " + casinoPickLabel(r.range, r.result) + ")", won ? "ok" : "err");
      } else {
        casinoActivity(label + " accepted — waiting for on-chain confirmation…", "warn");
        toast(kind === "timeout" ? "Timeout claimed — " + casinoFmt(r && r.amount) + " MINIMA returned ✓" : "Posted — confirming on-chain…", "ok");
      }
      renderCasino();
    } catch (e) {
      delete casinoBusy[coinid];
      const msg = (e && e.message ? e.message : String(e));
      casinoActivity(label + " failed: " + msg, "err");
      toast("Failed: " + msg, "err");
      renderCasinoMyBets();
    }
  }

  // ---------------- HISTORY ----------------
  async function renderCasinoHistory() {
    const host = el("casinoSub"); if (!host) return;
    let hist = []; try { hist = await api.casinoHistory(); } catch (e) {}
    if (el("casinoSub") !== host) return;
    hist = (hist || []).filter(rb => casinoTokIsActive(rb.tokenid));   // active currency only (a mixed Minima/USD list is meaningless)
    if (!hist.length) { host.innerHTML = `<div class="cz-card"><div class="cz-desc">No completed ${esc(casinoCcyLabel())} bets yet.</div></div>`; return; }
    host.innerHTML = `<div class="cz-card cz-card--flush">` + hist.map(rb => {
      const won = !!rb.won, col = won ? "var(--cz-green)" : "var(--cz-red)", sign = won ? "+" : "−";
      const pk = (rb.pickLabel && rb.pickLabel !== "—") ? `<div class="cz-hist-s">Picked ${esc(rb.pickLabel)} → Result ${esc(rb.resultLabel)}</div>` : "";
      return `<div class="cz-hist"><span class="cz-ico" style="font-size:17px">${casinoGame(rb.range).icon}</span>
        <div style="flex:1"><div class="cz-hist-t">${esc(rb.game)} <span style="color:var(--cz-dim);font-weight:400">as ${esc(rb.role)}</span></div>${pk}</div>
        <div style="font:800 14px/1 var(--cz-mono);color:${col}">${sign}${casinoFmtTok(rb.profit, rb.tokenid)} <small style="font-weight:600;color:var(--cz-dim)">${casinoCcyName(rb.tokenid)}</small></div></div>`;
    }).join("") + `</div>`;
  }

  // ---------------- reveal experience: spin → LAND on the real on-chain result → win/lose ----------------
  // Purely presentational. The outcome + exact roll come from the confirmed on-chain resolve (mechanism B /
  // service history) — this only spins the coin/dice/no-zero wheel to LAND on that result, then reveals.
  // The contract, engine.js, service.js and payout are untouched; nothing here can change a result.
  function casinoLabelToIdx(range, label) { if (label == null || label === "—") return -1; if (range == 2) return /head/i.test(label) ? 0 : 1; const n = parseInt(label); return isNaN(n) ? -1 : n - 1; }
  function casinoNonPick(pick, range) { range = parseInt(range) || 2; if (range < 2) return 0; let r; do { r = Math.floor(Math.random() * range); } while (r === pick); return r; }

  /**
   * The result overlay: spin → LAND on the real on-chain result → win/lose. Purely presentational — the outcome
   * and the exact roll come from the confirmed on-chain resolve; this only lands on it, and nothing here can
   * change a result. The artwork and its timings live in renderer/casinoart.js (the APK's own animators).
   *
   * The APK's two safety timers are kept: a 2800ms watchdog that reveals the verdict even if the spin never
   * reports back, and a 6000ms auto-dismiss.
   */
  function casinoFlash(won, game, amount, pickLabel, resultLabel, range, role) {
    range = parseInt(range) || 2;
    casinoSfx.resume();
    const g = casinoGame(range);
    const pIdx = casinoLabelToIdx(range, pickLabel);
    let rIdx = casinoLabelToIdx(range, resultLabel);
    if (rIdx < 0 || rIdx >= range) rIdx = won ? (pIdx >= 0 ? pIdx : 0) : casinoNonPick(pIdx, range);   // "—" fallback: won⇒pick, lose⇒a non-pick
    const whose = role === "House" ? "player picked" : "you picked";
    const shownResult = (resultLabel && resultLabel !== "—") ? resultLabel : casinoPickLabel(range, rIdx);
    const T = CasinoArt.T;

    const ov = document.createElement("div"); ov.className = "cz-ov cz-ov--reveal czapp";
    ov.innerHTML = '<div class="cz-modal cz-reveal-card">'
      + '<div class="cz-reveal-head"><span class="cz-reveal-game">' + esc(g.name) + ' · as ' + esc(role || "") + '</span><span class="cz-reveal-pip">RESOLVING ON-CHAIN…</span></div>'
      + '<div class="cz-stage"><canvas class="cz-stage-cv"></canvas><canvas class="cz-conf"></canvas></div>'
      + '<div class="cz-verdictbar"><span class="cz-verdict"></span><span class="cz-vmeta"></span></div>'
      + '<button class="cz-btn cz-btn--gold cz-reveal-go">Continue</button></div>';
    document.body.appendChild(ov);

    let closed = false, revealed = false, autoT = null, watchT = null, spin = null;
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(autoT); clearTimeout(watchT);
      if (spin) { try { spin.stop(); } catch (e) {} }
      ov.remove(); document.removeEventListener("keydown", onKey);
    };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector(".cz-reveal-go").addEventListener("click", close);

    /** Paint the verdict. Runs once — from the landing callback, or from the watchdog if that never fires. */
    const reveal = () => {
      if (closed || revealed) return;
      revealed = true;
      clearTimeout(watchT);
      ov.querySelector(".cz-reveal-pip").textContent = "RESOLVED ON-CHAIN · PROVABLY FAIR";
      const bar = ov.querySelector(".cz-verdictbar");
      bar.classList.add("is-on", won ? "is-win" : "is-lose");
      const amtTxt = (amount != null && amount !== "") ? (" " + (won ? "+" : "−") + casinoFmt(amount) + " MINIMA") : "";
      bar.querySelector(".cz-verdict").textContent = (won ? "YOU WIN" : "YOU LOSE") + amtTxt;
      bar.querySelector(".cz-vmeta").innerHTML = ((pickLabel && pickLabel !== "—") ? whose + " <b>" + esc(pickLabel) + "</b> · " : "") + "landed <b>" + esc(shownResult) + "</b>";
      if (won) { casinoSfx.win(); try { CasinoArt.confetti(ov.querySelector(".cz-conf")); } catch (e) {} }   // WIN ONLY
      else casinoSfx.lose();
      autoT = setTimeout(close, T.OVERLAY_DISMISS_MS);
      if (activeView() === "casino") setTimeout(() => { if (activeView() === "casino") renderCasino(); }, 300);
    };
    watchT = setTimeout(reveal, T.OVERLAY_WATCHDOG_MS);

    // A canvas has no measurable size until it is laid out, so start the spin on the next frame.
    requestAnimationFrame(() => {
      if (closed) return;
      const tickSfx = range == 36 ? casinoSfx.clatter : casinoSfx.tick;
      let lastT = 0;
      try {
        spin = CasinoArt.spinner(ov.querySelector(".cz-stage-cv"), range, {
          tick: (now) => { if (now - lastT > (range == 36 ? 70 : 110)) { lastT = now; try { tickSfx(); } catch (e) {} } }
        });
      } catch (e) { reveal(); return; }
      const PRE = range == 36 ? 350 : 750;   // brief pre-spin; the decel/land is the show
      setTimeout(() => {
        if (closed || !spin) return;
        spin.land(rIdx, () => { if (closed) return; casinoSfx.land(); reveal(); });
      }, PRE);
    });
  }

  // ---- public surface (renderer/app.js talks to the panel only through this) ----
  g.CasinoPanel = {
    init: function (d) {
      api = d.api; esc = d.esc; el = d.el; toast = d.toast;
      CasinoArt = d.CasinoArt || g.CasinoArt;
      cfg = d.cfg; setCfg = d.setCfg; activeView = d.activeView;
    },
    render: renderCasino,
    onUpdate: onCasinoUpdate,
    badge: refreshCasinoBadge,
    activity: casinoActivity,
    ageGate: casinoAgeGate,
    goToMyBets: function () { casinoView = "mybets"; },
    /** A new block: update the header number and pulse the live dot 1 → .25 over 900ms, as the APK does. */
    setBlock: function (n) {
      n = parseInt(n, 10) || 0;
      if (!n || n === czLastBlock) return;
      czLastBlock = n;
      var e = el && el("casinoBlk"); if (e) e.textContent = "#" + n;
      var d = el && el("casinoDot");
      if (d && d.classList) { d.classList.remove("is-pulse"); void d.offsetWidth; d.classList.add("is-pulse"); }
    },
    /** Seed/wallet changed — drop everything derived from the old wallet, and stop any canvas still looping. */
    reset: function () {
      casinoStopLive();
      casinoOwnedBets = []; casinoView = "play"; casinoPick = {}; casinoStatusCache = null;
      casinoPendingCreate = null; casinoTaking = {}; casinoCancelling = {}; casinoPrevBets = [];
      casinoResults = []; casinoStartupChecked = false; casinoCreateMsg = { text: "", cls: "" };
      casinoLog = []; casinoActOpen = false;
      try { localStorage.removeItem("casino_watch"); } catch (e) {}
    },
    /** Template-only exports for scripts/panels-test.cjs — no node or chain contact. */
    _picker: casinoPicker,
    _ticker: casinoTickerText,
    _setView: function (v) { casinoView = v; }
  };
})(window);
