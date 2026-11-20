/*
 * apps-tools.js: the screens of the tray apps added in Phase 5b (KeyUses, Minima Explorer, Entropy), each as its
 * original in Pandamonium draws it (apks/base integrated/…), expanded to the window. Loaded before app.js: it only declares
 * functions, which use app.js's helpers (el, esc, api, copy, toast, running) when they are called. What a screen SHOWS is worked out in renderer/apps-act.js (no DOM
 * there, so it is tested); what it ASKS is one call to the main process per action. Peer, node and server text
 * reaches the page through esc() or textContent only.
 */
"use strict";

// ---- KeyUses: Pandamonium's KeyUses 0.1.4 (integrated/keyreuses MainActivity), over main/keyuses.js ----------------
// One screen: the badge, the title, Run audit, the privacy line; then the verdict and the table; the explainer.
// Not here: "Include minimaWallet's classic keys" (no minimaWallet on the desktop) and the keys derived from the seed.
let KU_STATE = { busy: false, error: "", result: null };
function keyUsesReset() { KU_STATE = { busy: KU_STATE.busy, error: "", result: null }; }   // leaving the screen drops the result, as the original's onStop
async function keyUsesRun() {
  if (KU_STATE.busy) return;
  KU_STATE = { busy: true, error: "", result: null }; renderKeyUses();
  let r;
  try { r = await api.keyUsesAudit(); } catch (e) { r = { ok: false, error: AppsAct.keyuses.UNAVAILABLE }; }
  KU_STATE = { busy: false, error: r && r.ok ? "" : (r && r.error) || AppsAct.keyuses.UNAVAILABLE, result: r && r.ok ? r : null };
  if (activeView === "keyuses") { renderKeyUses(); const b = el("kuRun"); if (b) b.focus(); } else keyUsesReset();
}
function keyUsesResults(r) {
  const K = AppsAct.keyuses, C = K.COPY, v = K.verdict(r);
  const notice = (text, tone) => `<div class="kx-notice kx-notice--${tone}">${esc(text)}</div>`;
  const block = (b) => b.cmd
    ? `<button class="kx-inset kx-inset--copy" data-copy="${esc(b.cmd)}" title="Click to copy"><span class="kx-label">${esc(b.label)}</span><code class="kx-code">${esc(b.cmd)}</code></button>`
    : `<div class="kx-inset"><div class="kx-label">${esc(b.label)}</div><div class="kx-inset__body">${esc(b.body)}</div></div>`;
  const row = (x, n) => { const c = K.chip(x); return `<div class="kx-row" role="row">
      <div class="kx-cell kx-cell--addr" role="cell"><div class="kx-num kx-tone--${c.tone}">#${n}${x.family === "block" ? " · 128/4" : ""}</div><span class="kx-chip kx-chip--${c.tone}">${esc(c.label)}</span>
        <div class="kx-src">Node</div><button class="kx-addr" data-copy="${esc(x.address)}" title="Click to copy">${esc(x.address)}</button></div>
      <div class="kx-cell" role="cell">${esc(K.num(x.local))}</div><div class="kx-cell" role="cell">${esc(K.num(x.sigs))}</div><div class="kx-cell" role="cell">${esc(K.num(x.coins))}</div></div>`; };
  const head = `<div class="kx-row kx-row--head" role="row"><div class="kx-cell kx-cell--addr" role="columnheader">Address (click to copy)</div><div class="kx-cell" role="columnheader">Local uses</div><div class="kx-cell" role="columnheader">Spend blocks</div><div class="kx-cell" role="columnheader">Spent coins</div></div>`;
  return (r.complete ? "" : notice(C.incomplete, "warn"))
    + `<div class="kx-scope">Checked scope: ${esc(r.classicKeys)} classic · ${esc(r.blockKeys)} block-based keys</div>`
    + (r.mismatch ? notice(C.mismatch, "risk") : "") + (r.exhaustion ? notice(C.exhaustion, "warn") : "")
    + `<div class="kx-verdict kx-verdict--${v.tone}"><h2 class="kx-verdict__t">${esc(v.title)}</h2><p class="kx-verdict__b">${esc(v.body)}</p>${v.blocks.map(block).join("")}</div>`
    + `<div class="kx-card kx-card--table">${K.sections(r).map(s => `<div class="kx-section" role="table" aria-label="${esc(s.title)}"><h3 class="kx-section__t">${esc(s.title)}</h3>${head}${s.rows.map((x, i) => row(x, i + 1)).join("")}</div>`).join("")}
      <div class="kx-cov">${r.tip > 0 ? "Archive coverage to block " + esc(r.tip) + "." : "The archive did not say which block it reaches."} Spend blocks can undercount signatures. Only default addresses are checked; custom scripts and multisig usage are not included. A clear result is not proof that a key is safe.</div></div>`;
}
function renderKeyUses() {
  const C = AppsAct.keyuses.COPY, s = KU_STATE;
  el("keyusesBody").innerHTML = `<div class="kx">
    <div class="kx-badge"><i></i>Key audit</div>
    <h1 class="kx-title">KeyUses</h1>
    <p class="kx-sub">Check the keys this node holds for one-time signature reuse: classic keys and block-based keys, whichever this wallet has.</p>
    ${running ? "" : `<div class="kx-pair"><b>The node is not ready</b><span>Start the node on the Node tab, then run the audit.</span></div>`}
    <div class="kx-card">
      <button class="kx-run" id="kuRun"${s.busy || !running ? " disabled" : ""}>${s.busy ? `<i class="kx-spin" aria-hidden="true"></i>Auditing your keys…` : "Run audit"}</button>
      <p class="kx-privacy">Only public keys and addresses are sent to eurobuddha.com for the audit. This reveals the selected addresses to that server. Seeds stay on this computer.</p>
      ${s.error ? `<div class="kx-error" role="alert">${esc(s.error)}</div>` : ""}
    </div>
    <div id="kuResults" aria-live="polite">${s.result ? keyUsesResults(s.result) : ""}</div>
    <div class="kx-card"><div class="kx-label">Key audit</div><p class="kx-explain">${esc(C.explain)}</p>
      <p class="kx-explain">On this computer the audit covers the keys the node holds. The phone also checks the 64 classic and 32 block-based keys it derives from the seed, and minimaWallet’s keys; that is not done here.</p></div>
    <div class="kx-foot">eurobuddha · Minima Ecosystem · KeyUses</div></div>`;
  el("kuRun").onclick = keyUsesRun;
}
