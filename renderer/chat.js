/*
 * chat.js — the KeetChat panel (renderer), a faithful desktop copy of the Pandamonium /
 * BlackBear phone chat (apks/base chat/ChatView + ChatThreadActivity): the "My address & QR"
 * row, the thread list with HSV avatars and the blue unread badge, the blue new-chat FAB, the
 * thread toolbar with its ⋮ menu (address / rename / delete), 14dp bubbles with the phone's
 * text ticks (🕓 sending · ✓ at a mailbox · ✓✓ delivered · light-blue ✓✓ read), date pills,
 * voice notes drawn with the WaveformView geometry, photos with the black viewer, payment
 * bubbles whose "Tap for txid" opens the FULL txid (never truncated), and the pill input bar
 * with paperclip and mini send FAB. All state lives in the main process (main/chat.js drains
 * the sidecar inbox; chat-store.js is the history); this file only renders and calls the
 * mcd:chat* IPC surface. Scoped to .chatapp (chat.css). Both node kinds since 0.18.17.
 */
/* global ChatPanel, qrcode */
(function () {
  let D = null;              // deps from app.js: { api, esc, el, toast, copy, showPrompt, showConfirm }
  let me = { pubkey: "", name: "" };
  let sel = null;            // selected contact pubkey
  let threads = [];
  let booted = false;
  const mediaCache = {};     // ref -> data url (session only)
  let player = null, playingRef = "";

  function h(s) { return D.esc("" + (s == null ? "" : s)); }

  // Material icons used by the phone layouts (ic_qr_code, ic_chat, ic_attach, ic_send, more_vert)
  const I = {
    qr: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8-12v8h8V3h-8zm6 6h-4V5h4v4zm0 10h2v2h-2zm-6-6h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm0-4h2v2h-2zm2 2h2v2h-2z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>',
    attach: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>'
  };

  // ChatUi.avatar: HSV(hue from pubkey chars 4..8, s .55, v .75); "#" for a bare key, "?" for none
  function avatarColor(pk) {
    let hue = 0; try { hue = parseInt(pk.slice(4, 8), 16) % 360; } catch (e) {}
    const s = 0.55, v = 0.75, c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = v - c;
    const i = Math.floor(hue / 60) % 6;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i];
    const to = (q) => Math.round((q + m) * 255);
    return `rgb(${to(r)},${to(g)},${to(b)})`;
  }
  function isNamed(t) { return !!(t && t.name && t.name.indexOf("0x") !== 0); }
  function displayName(t) { return isNamed(t) ? t.name : "New contact"; }
  function avatarHtml(name, pk, cls) {
    let initial = "?";
    if (name) initial = name.startsWith("0x") ? "#" : String.fromCodePoint(name.codePointAt(0)).toUpperCase();
    return `<span class="chat-avatar ${cls || ""}" style="background:${avatarColor(pk || "")}">${h(initial)}</span>`;
  }
  function qrHtml(text) {
    try {
      if (typeof qrcode === "undefined") return "";
      const qr = qrcode(0, "M"); qr.addData(text); qr.make();
      return `<div class="chat-qr">${qr.createImgTag(4, 8)}</div>`;
    } catch (e) { return ""; }
  }
  // ChatUi.statusGlyph + the peerread light-blue ticks
  function statusGlyph(m) {
    if (m.status === "failed") return "✗";
    const via = m.status === "delivered" ? "delivered" : m.status === "mailboxed" ? "mailbox" : (m.via || "");
    if (!via || via.startsWith("sending")) return "🕓";
    if (via === "direct" || via === "delivered") return "✓✓";
    if (via === "mailbox") return "✓";
    return "✓";
  }
  function timeShort(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; }
  function listTime(ts) {           // ChatUi.listTime: time today, weekday this week, date otherwise
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return timeShort(ts);
    if (now - d < 7 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString();
  }
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    const y = new Date(now - 864e5);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  function preview(m) {              // the phone's row_last text
    if (!m) return "";
    const you = m.incoming ? "" : "You: ";
    if (m.state === "image") return you + "📷 " + (m.body || "Photo");
    if (m.state === "audio") return you + "🎤 Voice note · " + (m.body || "").split("|")[0];
    if (m.state === "payment") return you + "💸 " + (m.amt || "") + " " + (m.tokname || "Minima");
    if (m.state === "file") return you + "File: " + (m.body || "");
    return you + (m.body || "");
  }

  async function boot() {
    if (booted) return;
    booted = true;
    try { me = await D.api.chatInit(); } catch (e) { /* node starting — retried on render */ }
  }
  async function refreshThreads() {
    try { threads = await D.api.chatThreads(); } catch (e) { threads = []; }
  }

  // ---- dialogs: Android AlertDialog shapes on the app's overlay --------------------
  const KEEP = {};                  // an action that returns this leaves the dialog open (Copy details)
  function dialog(opts) {
    // opts: { title, body (html), actions: [{label, value, danger}], onOpen(ov) }
    return new Promise((resolve) => {
      const actions = (opts.actions || [{ label: "Close", value: null }])
        .map((a, i) => `<button class="chat-dialog__btn ${a.danger ? "chat-dialog__btn--danger" : ""}" data-i="${i}">${h(a.label)}</button>`).join("");
      document.body.insertAdjacentHTML("beforeend",
        `<div class="overlay" id="chatOv"><div class="chatapp" style="height:auto;min-height:0;display:block;width:100%;max-width:400px"><div class="chat-dialog">
          ${opts.title ? `<div class="chat-dialog__title">${h(opts.title)}</div>` : ""}${opts.body || ""}
          <div class="chat-dialog__actions">${actions}</div></div></div></div>`);
      const ov = D.el("chatOv");
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelectorAll(".chat-dialog__btn").forEach((b) => {
        const a = opts.actions[parseInt(b.dataset.i, 10)];
        b.onclick = () => { const v = typeof a.value === "function" ? a.value(ov) : a.value; if (v !== KEEP) done(v); };
      });
      ov.onclick = (e) => { if (e.target === ov) done(null); };
      const esc = (e) => { if (e.key === "Escape") { document.removeEventListener("keydown", esc); done(null); } };
      document.addEventListener("keydown", esc);
      if (opts.onOpen) opts.onOpen(ov);
      const first = ov.querySelector("input"); if (first) first.focus();
    });
  }

  async function identityModal() {   // dialog_chat_identity: QR, full address, copy, your name
    if (!me.pubkey) { try { me = await D.api.chatInit(); } catch (e) {} }
    const body = `${me.pubkey ? qrHtml(me.pubkey) : `<div class="chat-dialog__msg">Node starting — try again in a moment.</div>`}
      <div class="chat-dialog__mono" id="chatMyAddr">${h(me.pubkey || "")}</div>
      <input id="chatMyName" placeholder="Your display name" value="${h(me.name || "")}" maxlength="40" />`;
    const v = await dialog({ title: "My address & QR", body: body
      + `<div class="chat-dialog__msg" style="margin-top:12px">Chat backup: one encrypted file with this address and every contact and message — the same file the phone apps make.</div>`, actions: [
      { label: "Back up chats", value: () => ({ backup: true }) },
      { label: "Restore chats", value: () => ({ restore: true }) },
      { label: "Copy", value: () => ({ copy: true }) },
      { label: "Cancel", value: null },
      { label: "Save", value: (ov) => ({ name: ov.querySelector("#chatMyName").value.trim() }) }] });
    if (v && v.copy) { await D.copy(me.pubkey); D.toast("Address copied", "ok"); return; }
    if (v && v.backup) return backupChats();
    if (v && v.restore) return restoreChats();
    if (v && v.name !== undefined) { me = await D.api.chatSetName(v.name); render(); }
  }

  async function newChatModal() {    // dialog_chat_new: paste an address (the phone also scans a QR)
    const body = `<div class="chat-dialog__msg">Paste your friend's keets address (0x + 64 hex), as shown under their “My address &amp; QR”.</div>
      <input id="chatNewAddr" placeholder="Their address — 0x…" spellcheck="false" style="font-family:ui-monospace,monospace;font-size:13px" />
      <input id="chatNewName" placeholder="Name (optional)" />
      <div id="chatNewSaved"></div>`;
    let saved = [];
    try { saved = await D.api.chatContacts() || []; } catch (e) { /* node down: paste only */ }
    const v = await dialog({ title: "New chat", body, onOpen: (ov) => {
      // saved contacts (the phone's chat_contact_row list): one click starts or reopens the chat
      const box = ov.querySelector("#chatNewSaved");
      if (!saved.length) return;
      box.innerHTML = `<div class="chat-dialog__sub">Saved contacts</div>` + saved.map((c, i) =>
        `<button class="chat-dialog__item chat-dialog__contact" data-c="${i}">${avatarHtml(c.name.indexOf("0x") === 0 ? "New contact" : c.name, c.pubkey, "chat-avatar--sm")}<span><b>${h(c.name.indexOf("0x") === 0 ? "New contact" : c.name)}</b><small>${h(c.pubkey)}</small></span></button>`).join("");
      box.querySelectorAll("[data-c]").forEach((b) => { b.onclick = async () => { const c = saved[parseInt(b.dataset.c, 10)]; ov.remove(); await refreshThreads(); select(c.pubkey); }; });
    }, actions: [
      { label: "Cancel", value: null },
      { label: "Start chat", value: (ov) => ({ addr: ov.querySelector("#chatNewAddr").value.trim().toLowerCase(), name: ov.querySelector("#chatNewName").value.trim() }) }] });
    if (!v) return;
    if (!/^0x[0-9a-f]{64}$/.test(v.addr)) { D.toast("A keets address is 0x + 64 hex characters", "err"); return; }
    try { await D.api.chatAddContact(v.addr, v.name); } catch (e) { D.toast(e.message || "" + e, "err"); return; }
    await refreshThreads();
    select(v.addr);
  }

  async function contactAddressModal() {
    if (!sel) return;
    const t = threads.find(x => x.pubkey === sel);
    const body = `${qrHtml(sel)}<div class="chat-dialog__mono">${h(sel)}</div>`;
    const v = await dialog({ title: displayName(t), body, actions: [{ label: "Copy", value: "copy" }, { label: "Close", value: null }] });
    if (v === "copy") { await D.copy(sel); D.toast("Address copied", "ok"); }
  }

  // ---- lightbox: the phone's ChatImageActivity (black, pinch/zoom → wheel/drag) ----
  function lightbox(dataUrl, caption) {
    document.body.insertAdjacentHTML("beforeend",
      `<div class="chat-lightbox" id="chatLb">
        <img id="chatLbImg" alt="photo" src="${dataUrl}" />
        ${caption ? `<div class="chat-lightbox__cap">${h(caption)}</div>` : ""}
        <button class="chat-lightbox__close" id="chatLbClose" title="Back">←</button>
      </div>`);
    const lb = D.el("chatLb"), img = D.el("chatLbImg");
    let scale = 1, tx = 0, ty = 0, dragging = false, lx = 0, ly = 0;
    const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    const onMove = (e) => { if (!dragging) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); };
    const onUp = () => { dragging = false; };
    const close = () => { lb.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    D.el("chatLbClose").onclick = close;
    lb.onclick = (e) => { if (e.target === lb) close(); };
    lb.onwheel = (e) => { e.preventDefault(); scale = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); if (scale === 1) { tx = 0; ty = 0; } apply(); };
    img.ondblclick = () => { scale = scale > 1.01 ? 1 : 2.5; if (scale === 1) { tx = 0; ty = 0; } apply(); };
    img.onmousedown = (e) => { dragging = true; lx = e.clientX; ly = e.clientY; e.preventDefault(); };
  }

  // ---- shell -------------------------------------------------------------------------
  const EMPTY_LIST = "No chats yet.\n\nStart one by pasting your friend's address. Messages are end-to-end encrypted and need no server: delivered instantly when they're online, held safely for them when they're not.";
  async function backupChats() {
    const pass = await D.showPrompt("Back up chats", "", "Password (at least 8 characters)", { password: true, ok: "Next",
      message: "Anyone with the file and this password can read your chats and speak as you. Without the password the file cannot be opened." });
    if (pass == null) return;
    if (pass.length < 8) { D.toast("Use at least 8 characters.", "err"); return; }
    const again = await D.showPrompt("Back up chats", "", "Type the password again", { password: true, ok: "Save" });
    if (again == null) return;
    if (again !== pass) { D.toast("The two passwords do not match", "err"); return; }
    try {
      const r = await D.api.chatExportBackup(pass);
      if (!r.canceled) D.toast("Chat backup saved: " + r.contacts + " contacts, " + r.messages + " messages", "ok");
    } catch (e) { D.toast("Chat backup failed: " + (e.message || e), "err"); }
  }

  async function restoreChats() {
    const pass = await D.showPrompt("Restore chats", "", "Backup password", { password: true, ok: "Choose file" });
    if (pass == null) return;
    let r;
    try { r = await D.api.chatOpenBackup(pass); } catch (e) { D.toast(("" + (e.message || e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "err"); return; }
    if (r.canceled) return;
    const none = "(none)";
    // One scrolling body: every address in full, then the RESTORE box, reachable at any window size.
    const body = `<div style="max-height:60vh;overflow:auto">
        <div class="chat-dialog__msg">Keets address in the backup:</div><div class="chat-dialog__mono">${h(r.keetsPubkey || none)}</div>
        <div class="chat-dialog__msg">This computer's keets address now:</div><div class="chat-dialog__mono">${h(r.current || none)}</div>
        <div class="chat-dialog__msg">• This computer's current keets address is REPLACED. It is gone unless you saved a chat backup of it.<br>
        • ${r.contacts} contacts and ${r.messages} messages are added; chats already here are kept.<br>
        • Stop the node on the old device first. Two nodes on one address take each other's messages.<br>
        ${r.hasMax ? "• The backup's MAX# identity is for the phone apps; this computer keeps no MAX# chat, so it is not restored here.<br>" : ""}
        • The node restarts.</div>
        <input id="chatRestoreWord" placeholder="type RESTORE" autocomplete="off" /></div>`;
    const v = await dialog({ title: "Replace this computer's chat identity?", body, actions: [
      { label: "Cancel", value: null },
      { label: "Restore", danger: true, value: (ov) => ov.querySelector("#chatRestoreWord").value.trim().toUpperCase() }] });
    if (v == null) return;
    if (v !== "RESTORE") { D.toast("Not confirmed - nothing was changed.", "err"); return; }
    D.toast("Restoring — the node restarts", "ok");
    try { await D.api.chatApplyBackup(); me = { pubkey: "", name: "" }; booted = false; await boot(); await refreshThreads(); render(); D.toast("Chat backup restored", "ok"); }
    catch (e) { D.toast("Restore failed: " + (e.message || e), "err"); }
  }

  function shell() {
    return `<div class="chatapp"><div class="chat-shell">
      <aside class="chat-side">
        <button class="chat-myrow" id="chatIdBtn" title="Your address & QR">${I.qr}<span class="chat-myrow__label">My address &amp; QR</span><span class="chat-myrow__name" id="chatMyNameLbl">${h(me.name || "")}</span></button>
        <div class="chat-threads" id="chatContacts"></div>
        <button class="chat-fab" id="chatNewBtn" title="New chat">${I.chat}</button>
      </aside>
      <section class="chat-main">
        <div class="chat-toolbar" id="chatHead" hidden>
          <span id="chatHeadAvatar"></span>
          <span class="chat-toolbar__title" id="chatSelName"></span>
          <button class="chat-toolbar__btn" id="chatMoreBtn" title="More">${I.more}</button>
        </div>
        <div class="chat-msgs" id="chatMsgs"><div class="chat-msgs__inner"><div class="chat-empty">${h(EMPTY_LIST)}</div></div></div>
        <div class="chat-inputbar" id="chatSendRow" hidden>
          <button class="chat-attach" id="chatAttachBtn" title="Attach">${I.attach}</button>
          <textarea class="chat-input" id="chatText" rows="1" placeholder="Message" autocomplete="off"></textarea>
          <button class="chat-fab chat-fab--mini" id="chatSendBtn" title="Send">${I.send}</button>
        </div>
      </section>
    </div></div>`;
  }

  function renderContacts() {
    const box = D.el("chatContacts");
    if (!box) return;
    const list = threads.filter(t => t.last && t.last.ts);   // the phone lists conversations only
    box.innerHTML = list.length ? "" : `<div class="chat-empty chat-empty--side">${h(EMPTY_LIST)}<br><button class="btn btn--primary" id="chatEmptyStart" style="background:#2F6BF6;border-color:#2F6BF6;color:#fff;border-radius:20px;padding:10px 28px">Start a new chat</button></div>`;
    const startBtn = D.el("chatEmptyStart"); if (startBtn) startBtn.onclick = newChatModal;
    for (const t of list) {
      const d = document.createElement("div");
      d.className = "chat-thread" + (t.pubkey === sel ? " chat-thread--sel" : "");
      const name = displayName(t);
      d.innerHTML = `${avatarHtml(name, t.pubkey)}
        <div class="chat-thread__mid"><div class="chat-thread__name">${h(name)}</div><div class="chat-thread__last">${h(preview(t.last))}</div></div>
        <div class="chat-thread__side"><span class="chat-thread__time">${h(listTime(t.last && t.last.ts))}</span>${t.unread ? `<span class="chat-unread">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}</div>`;
      d.onclick = () => select(t.pubkey);
      box.appendChild(d);
    }
    const lbl = D.el("chatMyNameLbl"); if (lbl) lbl.textContent = me.name || "";
  }

  // ---- bubbles (chat_msg_row.xml + MsgAdapter.getView) --------------------------------
  function metaHtml(m) {
    const when = timeShort(m.ts);
    if (m.incoming) return `<div class="chat-bubble__meta">${h(when)}</div>`;
    if (m.peerread) return `<div class="chat-bubble__meta chat-bubble__meta--read">${h(when)}  ✓✓</div>`;
    return `<div class="chat-bubble__meta">${h(when)}  ${statusGlyph(m)}</div>`;
  }
  function drawWave(canvas, levels, progress) {   // WaveformView.onDraw
    const dpr = window.devicePixelRatio || 1;
    const w = 150, hgt = 36;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    const g = canvas.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, hgt);
    const n = levels.length; if (!n) return;
    const slot = w / n, bw = Math.max(2, slot * 0.55), r = bw / 2;
    const played = Math.round(progress * n);
    const ink = getComputedStyle(canvas).color;
    for (let i = 0; i < n; i++) {
      const frac = Math.max(1, levels[i]) / 15, bh = Math.max(bw, hgt * frac), cx = i * slot + slot / 2, top = (hgt - bh) / 2;
      g.globalAlpha = i < played ? 1 : 92 / 255; g.fillStyle = ink;
      g.beginPath(); g.roundRect(cx - bw / 2, top, bw, bh, r); g.fill();
    }
  }
  function decodeWave(hex) {
    if (!hex || hex.length > 64 || /[^0-9a-f]/i.test(hex)) return null;
    return hex.split("").map(c => parseInt(c, 16));
  }

  async function toggleAudio(ref, onChange) {
    if (player && playingRef === ref) {
      if (player.paused) player.play(); else player.pause();
      onChange(); return;
    }
    if (player) { player.pause(); player = null; playingRef = ""; onChange(); }
    try {
      const u = mediaCache[ref] || await D.api.chatMedia(ref);
      mediaCache[ref] = u;
      player = new Audio(u); playingRef = ref;
      player.onended = () => { playingRef = ""; player = null; onChange(); };
      player.onplay = onChange; player.onpause = onChange;
      player.ontimeupdate = onChange;
      await player.play();
    } catch (e) { D.toast("Voice note not available yet — try again shortly", "err"); }
  }

  function bubbleFor(m) {
    const row = document.createElement("div");
    row.className = "chat-row " + (m.incoming ? "chat-row--in" : "chat-row--out");
    const b = document.createElement("div");
    b.className = "chat-bubble";
    row.appendChild(b);
    if (m.state === "audio" && m.ref) {
      const bar = (m.body || "").indexOf("|");
      const dur = bar > 0 ? m.body.slice(0, bar) : (m.body || "");
      const levels = (bar > 0 ? decodeWave(m.body.slice(bar + 1)) : null) || new Array(40).fill(0);
      b.innerHTML = `<div class="chat-audio"><button class="chat-audio__btn" title="Play">▶</button><canvas class="chat-audio__wave"></canvas><span class="chat-audio__time">${h(dur)}</span></div>${metaHtml(m)}`;
      const btn = b.querySelector(".chat-audio__btn"), cv = b.querySelector(".chat-audio__wave");
      const paint = () => {
        const mine = player && playingRef === m.ref;
        btn.textContent = mine && !player.paused ? "⏸" : "▶";
        drawWave(cv, levels, mine && player.duration ? player.currentTime / player.duration : 0);
      };
      requestAnimationFrame(paint);
      const play = (e) => { e.stopPropagation(); toggleAudio(m.ref, paint); };
      btn.onclick = play; b.querySelector(".chat-audio").onclick = play;
    } else if (m.state === "image" && m.ref) {
      b.innerHTML = `<div class="chat-img chat-img--loading">Loading photo…</div>${m.body ? `<div class="chat-bubble__body">${h(m.body)}</div>` : ""}${metaHtml(m)}`;
      const slot = b.firstChild;
      const load = () => (mediaCache[m.ref] ? Promise.resolve(mediaCache[m.ref]) : D.api.chatMedia(m.ref)).then((u) => {
        mediaCache[m.ref] = u;
        const img = document.createElement("img"); img.className = "chat-img"; img.src = u; img.alt = "Photo";
        img.onclick = () => lightbox(u, m.body);
        slot.replaceWith(img);
      }).catch(() => { slot.textContent = "Photo — not available yet (click to retry)"; slot.onclick = load; });
      load();
    } else if (m.state === "file" && m.ref) {
      b.innerHTML = `<div class="chat-bubble__body">${h(m.body)}</div><button type="button" class="chat-bubble__attach chat-bubble__attach--btn">Open file transfer</button>${metaHtml(m)}`;
      b.querySelector(".chat-bubble__attach").onclick = () => fileSheet(m.pubkey, m.ref);
    } else if (m.state === "payment") {
      const tok = m.tokname || "Minima";
      b.innerHTML = `<div class="chat-bubble__body">💸 ${m.incoming ? "Payment received" : "Payment sent"}\n${h(m.amt || "")} ${h(tok)}</div>
        <div class="chat-bubble__attach">Tap for txid</div>${metaHtml(m)}`;
      b.querySelector(".chat-bubble__attach").onclick = async () => {
        const v = await dialog({ title: "Transaction id", body: `<div class="chat-dialog__mono">${h(m.txid || "")}</div>`,
          actions: [{ label: "Copy", value: "copy" }, { label: "Close", value: null }] });
        if (v === "copy") { await D.copy(m.txid || ""); D.toast("Transaction id copied", "ok"); }
      };
    } else {
      b.innerHTML = `<div class="chat-bubble__body">${h(m.body)}</div>${m.ref ? `<div class="chat-bubble__attach">Attachment — tap to copy link</div>` : ""}${metaHtml(m)}`;
      if (m.ref) b.querySelector(".chat-bubble__attach").onclick = async () => { await D.copy(m.ref); D.toast("Link copied", "ok"); };
    }
    // long-press on the phone, right-click here: Copy text / Delete (this device)
    b.oncontextmenu = async (e) => {
      e.preventDefault();
      const v = await dialog({ title: "", body: `<button class="chat-dialog__item" data-v="copy">Copy text</button><button class="chat-dialog__item" data-v="del">Delete (this device)</button>`,
        actions: [{ label: "Cancel", value: null }], onOpen: (ov) => ov.querySelectorAll("[data-v]").forEach((x) => { x.onclick = async () => {
          ov.remove();
          if (x.dataset.v === "copy") { await D.copy(m.body || ""); D.toast("Copied", "ok"); }
          else { await D.api.chatDeleteMessage(m.msgid); await refreshThreads(); renderContacts(); renderMsgs(false); }
        }; }) });
      void v;
    };
    return row;
  }

  async function renderMsgs(scroll) {
    const box = D.el("chatMsgs");
    if (!box || !sel) return;
    let msgs = [];
    try { msgs = await D.api.chatThread(sel); } catch (e) { return; }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const inner = document.createElement("div"); inner.className = "chat-msgs__inner";
    if (!msgs.length) inner.innerHTML = `<div class="chat-empty">Say hello 👋</div>`;
    let lastDay = "";
    for (const m of msgs) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement("div"); sep.className = "chat-date"; sep.innerHTML = `<span>${h(day)}</span>`;
        inner.appendChild(sep);
      }
      inner.appendChild(bubbleFor(m));
    }
    box.innerHTML = ""; box.appendChild(inner);
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  }

  async function select(pubkey) {
    sel = pubkey;
    const t = threads.find(x => x.pubkey === pubkey);
    const name = t ? displayName(t) : "New contact";
    const head = D.el("chatHead");
    if (head) {
      head.hidden = false;
      D.el("chatHeadAvatar").innerHTML = avatarHtml(name, pubkey, "chat-avatar--sm");
      D.el("chatSelName").textContent = name;
    }
    D.el("chatSendRow").hidden = false;
    renderContacts();
    await renderMsgs(true);
    await refreshThreads();        // thread() marked read in main — refresh badges
    renderContacts();
    ChatPanel.badgeChanged && ChatPanel.badgeChanged();
    const inp = D.el("chatText"); if (inp) inp.focus();
  }

  function autosize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(118, ta.scrollHeight) + "px"; }

  async function doSend() {
    const inp = D.el("chatText");
    const text = (inp.value || "").trim();
    if (!text || !sel) return;
    inp.value = ""; autosize(inp);
    try { await D.api.chatSend(sel, text); }
    catch (e) { showFailure("Send failed: " + errText(e)); }
    await refreshThreads(); renderContacts(); await renderMsgs(true);
    inp.focus();
  }

  function errText(e) { return ("" + ((e && e.message) || e || "")).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }
  /** ChatFailureDialog: the whole error, selectable, with Copy details; it stays open after copying. */
  function showFailure(message) {
    return dialog({ title: "Error", body: `<div class="chat-dialog__msg chat-dialog__msg--sel" id="chatFailText">${h(message)}</div>`,
      actions: [{ label: "Copy details", value: (ov) => { D.copy(ov.querySelector("#chatFailText").textContent); D.toast("Copied", "ok"); return KEEP; } }, { label: "Close", value: null }] });
  }

  // ---- files: the phone's ChatFiles sheet (explicit download, only a verified file can be saved) ----
  const mb = (n) => (Number(n || 0) / 1048576).toFixed(1);
  const DELIVERY = { "Downloaded and verified · sharing stopped": 1, "Downloaded and verified · sharing": 1, "Waiting for verified download": 1 };
  async function fileSheet(peer, ref, known) {
    let st = known;
    try { if (!st) st = await D.api.chatFileOffer(peer, ref); } catch (e) { showFailure(errText(e) || "File transfer failed. Tap Resume to retry."); return; }
    if (!st) return;
    let timer = null;
    await dialog({ title: st.name, body: `<div class="chat-dialog__msg" id="cfInfo"></div>
        <progress id="cfBar" max="100" value="0"></progress>
        <button class="chat-dialog__item" id="cfRun"></button>
        <button class="chat-dialog__item" id="cfSave">Save verified file</button>
        <label class="chat-dialog__check" id="cfKeepRow" hidden><input type="checkbox" id="cfKeep" /> Keep sharing</label>
        <button class="chat-dialog__item" id="cfAgain" hidden>Share again</button>
        <button class="chat-dialog__item" id="cfRemove">Remove local copy</button>`,
      actions: [{ label: "Close", value: null }],
      onOpen: (ov) => {
        const q = (id) => ov.querySelector("#" + id), fail = (e) => showFailure(errText(e) || "File transfer failed. Tap Resume to retry.");
        const paint = () => {
          const d = st.delivery || {};
          let info = (st.error || (st.ready ? "Verified and ready to save" : st.running ? "Transferring encrypted file…" : "Download or resume. Keep both nodes online. File data travels peer to peer."))
            + "\n" + mb(st.done) + " / " + mb(st.size) + " MB";
          if (st.mine && d.delivery) info += "\n" + (DELIVERY[d.delivery] ? d.delivery : "Download confirmation unavailable") + (d.deliveryError ? "\n" + d.deliveryError : "");
          q("cfInfo").textContent = info;
          q("cfBar").value = Math.floor(100 * Number(st.done || 0) / Math.max(1, Number(st.size || 0)));
          q("cfRun").textContent = st.running ? "Pause" : st.mine ? "Send / resume" : "Download / resume";
          q("cfRun").disabled = !st.running && !st.canRun;
          q("cfSave").disabled = !st.canSave; q("cfRemove").disabled = !st.canRemove;
          q("cfKeepRow").hidden = q("cfAgain").hidden = !st.mine;
          if (document.activeElement !== q("cfKeep")) q("cfKeep").checked = d.keepSharing === "true";
          q("cfAgain").disabled = d.sharingStopped !== "true";
        };
        const tick = async () => {
          if (!ov.isConnected) { clearInterval(timer); return; }
          try { const now = await D.api.chatFileStatus(st.id); if (now) st = now; } catch (e) { /* not stored yet: the offer's own figures stay */ }
          if (ov.isConnected) paint();
        };
        q("cfRun").onclick = () => { (st.running ? D.api.chatFilePause(st.id) : D.api.chatFileRun(peer, st.ref, st.id)).catch(fail); setTimeout(tick, 150); };
        q("cfSave").onclick = async () => { try { const r = await D.api.chatFileSave(st.id); if (r && !r.canceled) D.toast("File saved", "ok"); } catch (e) { fail(e); } };
        q("cfKeep").onchange = () => { D.api.chatFileKeep(st.id, q("cfKeep").checked).catch(fail); };
        q("cfAgain").onclick = () => { D.api.chatFileShareAgain(st.id).then(tick).catch(fail); };
        q("cfRemove").onclick = async () => { if (st.running) return; try { await D.api.chatFileRemove(st.id); } catch (e) { fail(e); return; } clearInterval(timer); ov.remove(); };
        paint(); tick(); timer = setInterval(tick, 400);
      } });
    clearInterval(timer);
  }
  async function fileTransfers() {
    let list = [];
    try { list = await D.api.chatFileTransfers(sel) || []; } catch (e) { showFailure(errText(e)); return; }
    if (!list.length) { D.toast("No stored file transfers in this chat", ""); return; }
    const peer = sel;
    await dialog({ title: "File transfers", body: list.map((t, i) => `<button class="chat-dialog__item" data-t="${i}">${h(t.name)}</button>`).join(""),
      actions: [{ label: "Close", value: null }],
      onOpen: (ov) => ov.querySelectorAll("[data-t]").forEach((b) => { b.onclick = () => { const t = list[parseInt(b.dataset.t, 10)]; ov.remove(); fileSheet(peer, t.ref, t); }; }) });
  }
  async function doFile() {
    const peer = sel;
    D.api.chatFileSend(peer).then(async (st) => {
      if (!st) return;
      if (st.error) showFailure(st.error); else D.toast("File offered: " + st.name, "ok");
      await refreshThreads(); renderContacts(); if (sel === peer) renderMsgs(true);
    }).catch((e) => showFailure(errText(e) || "File transfer failed. Tap Resume to retry."));
    D.toast("Encrypting and publishing the file. It appears in the chat when it is offered; \"File transfers\" shows its progress.", "");
  }

  function closeMenu() { const m = D.el("chatMenu"); if (m) m.remove(); }
  function openMenu() {               // the thread toolbar's ⋮ menu: address / rename / delete
    closeMenu();
    const main = D.el("chatHead").parentElement;
    main.style.position = "relative";
    main.insertAdjacentHTML("beforeend", `<div class="chat-menu" id="chatMenu">
      <button id="chatAddrBtn">Contact address &amp; QR</button>
      <button id="chatRenameBtn">Rename contact</button>
      <button id="chatClearBtn">Delete chat</button>
      <button id="chatRemoveBtn">Delete contact</button></div>`);
    const off = (e) => { if (!e.target.closest("#chatMenu")) { closeMenu(); document.removeEventListener("mousedown", off); } };
    setTimeout(() => document.addEventListener("mousedown", off), 0);
    D.el("chatAddrBtn").onclick = () => { closeMenu(); contactAddressModal(); };
    D.el("chatRenameBtn").onclick = async () => {
      closeMenu();
      if (!sel) return;
      const t = threads.find(x => x.pubkey === sel) || {};
      const v = await dialog({ title: "Contact name", body: `<input id="chatRen" placeholder="Name" value="${h(isNamed(t) ? t.name : "")}" maxlength="40" />`,
        actions: [{ label: "Cancel", value: null }, { label: "Save", value: (ov) => ov.querySelector("#chatRen").value.trim() }] });
      if (!v) return;
      await D.api.chatRenameContact(sel, v);
      await refreshThreads(); renderContacts();
      D.el("chatSelName").textContent = v;
      D.el("chatHeadAvatar").innerHTML = avatarHtml(v, sel, "chat-avatar--sm");
    };
    D.el("chatRemoveBtn").onclick = async () => {
      closeMenu();
      if (!sel) return;
      const ok = await dialog({ title: "Delete contact", body: `<div class="chat-dialog__msg">Permanently remove this contact and the conversation? You'll need their address again to reconnect. This cannot be undone.</div>`,
        actions: [{ label: "Cancel", value: null }, { label: "Delete contact", value: true, danger: true }] });
      if (!ok) return;
      await D.api.chatRemoveContact(sel);
      sel = null;
      render();
    };
    D.el("chatClearBtn").onclick = async () => {
      closeMenu();
      if (!sel) return;
      const ok = await dialog({ title: "Delete chat", body: `<div class="chat-dialog__msg">Clear this conversation? The contact stays in your list — you can start a new chat anytime.</div>`,
        actions: [{ label: "Cancel", value: null }, { label: "Delete chat", value: true, danger: true }] });
      if (!ok) return;
      await D.api.chatClearThread(sel);
      sel = null;
      render();
    };
  }

  async function attachMenu() {       // the phone's attach sheet: photo · payment · request pay address
    if (!sel) return;
    const v = await dialog({ title: "Attach", body: `
      <button class="chat-dialog__item" id="chatAttPhoto">📷 Photo</button>
      <button class="chat-dialog__item" id="chatAttVoice">🎤 Voice note</button>
      <button class="chat-dialog__item" id="chatAttPay">💸 Send payment</button>
      <button class="chat-dialog__item" id="chatAttAddr">🏷 Request their pay address</button>
      <button class="chat-dialog__item" id="chatAttFile">File (up to 100 MB)</button>
      <button class="chat-dialog__item" id="chatAttFiles">File transfers</button>`,
      actions: [{ label: "Cancel", value: null }],
      onOpen: (ov) => {
        ov.querySelector("#chatAttPhoto").onclick = () => { ov.remove(); doPhoto(); };
        ov.querySelector("#chatAttPay").onclick = () => { ov.remove(); doPay(); };
        ov.querySelector("#chatAttVoice").onclick = () => { ov.remove(); doVoice(); };
        ov.querySelector("#chatAttFile").onclick = () => { ov.remove(); doFile(); };
        ov.querySelector("#chatAttFiles").onclick = () => { ov.remove(); fileTransfers(); };
        ov.querySelector("#chatAttAddr").onclick = async () => { ov.remove(); await D.api.chatRequestPayAddr(sel).catch(() => {}); D.toast("Address requested — arrives automatically", "ok"); };
      } });
    void v;
  }
  async function doPhoto() {
    try { const r = await D.api.chatSendImage(sel); if (r) D.toast(r.via === "direct" ? "Photo delivered" : "Photo stored at a mailbox", "ok"); }
    catch (e) { showFailure("Photo failed: " + errText(e)); }
    await refreshThreads(); renderContacts(); await renderMsgs(true);
  }
  /**
   * VoiceRecordDialog: the microphone is asked for only now, when the user chose "Voice note". A live waveform from
   * the mic level (one sample per 100 ms), a blinking dot, the m:ss timer, 60 s at most; Send or Cancel.
   * The phone records Opus in OGG (AAC in MP4 on old Android). Chromium cannot write OGG, so this records AAC in
   * MP4 where the platform can, else Opus in WebM, mono, 16 kbps asked for; the phone's player reads the content.
   */
  const VOICE = { MAX: 60, BARS: 32 };
  function voiceMime() {
    const R = window.MediaRecorder;
    if (!R) return "";
    return ["audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus"].find((t) => R.isTypeSupported(t)) || "";
  }
  /** WaveformView.summarise + encode: 32 bars, 1..15 each, one hex digit per bar. */
  function waveHex(samples) {
    if (!samples.length) return "4".repeat(VOICE.BARS);
    let peak = 1, out = "";
    for (const v of samples) peak = Math.max(peak, Math.trunc(v));
    for (let i = 0; i < VOICE.BARS; i++) {
      const a = Math.trunc(i * samples.length / VOICE.BARS), z = Math.max(a + 1, Math.trunc((i + 1) * samples.length / VOICE.BARS));
      let m = 0;
      for (let j = a; j < z && j < samples.length; j++) m = Math.max(m, Math.trunc(samples[j]));
      out += (1 + Math.min(14, Math.trunc(Math.sqrt(m / peak) * 14))).toString(16);
    }
    return out;
  }
  const fmtSecs = (n) => Math.trunc(n / 60) + ":" + String(Math.trunc(n) % 60).padStart(2, "0");
  async function doVoice() {
    const peer = sel, mime = voiceMime();
    if (!peer) return;
    if (!mime || !navigator.mediaDevices) { D.toast("Microphone unavailable", "err"); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (e) { D.toast("Microphone unavailable", "err"); return; }
    const stop = () => stream.getTracks().forEach((t) => t.stop());
    let rec, ctx;
    const chunks = [], samples = [];
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 16000 });
      ctx = new AudioContext();
    } catch (e) { stop(); D.toast("Microphone unavailable", "err"); return; }
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const started = Date.now(); let stoppedAt = 0, timers = [];
    const elapsed = () => Math.trunc(((stoppedAt || Date.now()) - started) / 1000);
    const halt = () => new Promise((res) => {
      timers.forEach(clearInterval); timers = [];
      if (!stoppedAt) stoppedAt = Date.now();
      if (rec.state === "inactive") { stop(); ctx.close().catch(() => {}); return res(); }
      rec.onstop = () => { stop(); ctx.close().catch(() => {}); res(); };
      try { rec.stop(); } catch (e) { stop(); res(); }
    });
    rec.start();
    const v = await dialog({ title: "Voice note",
      body: `<canvas class="chat-audio__wave chat-rec__wave" id="chatRecWave"></canvas><div class="chat-rec"><span class="chat-rec__dot" id="chatRecDot">●</span><span class="chat-rec__time" id="chatRecTime">0:00</span></div>`,
      actions: [{ label: "Cancel", value: null }, { label: "Send", value: "send" }],
      onOpen: (ov) => {
        const cv = ov.querySelector("#chatRecWave"), time = ov.querySelector("#chatRecTime"), dot = ov.querySelector("#chatRecDot");
        timers.push(setInterval(() => {                 // the mic level, 0..32767 as MediaRecorder.getMaxAmplitude
          if (!ov.isConnected) { halt(); return; }
          an.getByteTimeDomainData(buf);
          let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          samples.push(Math.min(32767, Math.round(peak / 128 * 32767)));
          drawWave(cv, samples.slice(-40).map((a) => 1 + Math.min(14, Math.trunc(Math.sqrt(a / 32767) * 14))), 1);
        }, 100));
        timers.push(setInterval(() => {
          dot.style.opacity = dot.style.opacity === "0.25" ? "1" : "0.25";
          if (elapsed() >= VOICE.MAX) { time.textContent = fmtSecs(VOICE.MAX) + "  max"; halt(); }
          else time.textContent = fmtSecs(elapsed());
        }, 500));
      } });
    await halt();
    if (v !== "send") return;
    const secs = Math.min(VOICE.MAX, Math.max(0, elapsed()));
    let bytes;
    try { bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()); } catch (e) { D.toast("Recording failed", "err"); return; }
    if (!bytes.length || secs < 1) { D.toast("Too short — hold on a moment longer", "err"); return; }
    D.toast("Sending voice note…", "");
    try { await D.api.chatSendVoice(peer, bytes, mime.split(";")[0], secs, waveHex(samples)); }
    catch (e) { showFailure("Send failed: " + errText(e)); }
    await refreshThreads(); renderContacts(); if (sel === peer) await renderMsgs(true);
  }
  async function doPay() {
    const addr = await D.api.chatPayAddr(sel);
    if (!addr) {
      await D.api.chatRequestPayAddr(sel).catch(() => {});
      D.toast("No pay address yet — requested it over chat, try again shortly", "err");
      return;
    }
    const token = await dialog({ title: "Send payment", body: `<div class="chat-dialog__msg">Which currency? Both are sent from this node's wallet to the contact's pay address.</div>`,
      actions: [{ label: "Cancel", value: null }, { label: "MxUSD", value: "mxusd" }, { label: "Minima", value: "minima" }] });
    if (!token) return;
    const label = token === "mxusd" ? "MxUSD" : "Minima";
    const amt = await D.showPrompt("Send " + label + " to " + addr, "", "amount", { message: "This sends real " + label + " from this node's wallet." });
    if (!amt) return;
    try { await D.api.chatSendPayment(sel, amt.trim(), token); D.toast(label + " payment sent", "ok"); }
    catch (e) { showFailure("Payment failed: " + errText(e)); }
    await refreshThreads(); renderContacts(); await renderMsgs(true);
  }

  function wire() {
    D.el("chatNewBtn").onclick = newChatModal;
    D.el("chatIdBtn").onclick = identityModal;
    D.el("chatSendBtn").onclick = doSend;
    D.el("chatAttachBtn").onclick = attachMenu;
    D.el("chatMoreBtn").onclick = (e) => { e.stopPropagation(); openMenu(); };
    const ta = D.el("chatText");
    ta.oninput = () => autosize(ta);
    ta.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); doSend(); } };
  }

  async function render() {
    await boot();
    if (!me.pubkey) { try { me = await D.api.chatInit(); } catch (e) {} }
    const body = D.el("chatBody");
    if (!body) return;
    body.innerHTML = shell();
    wire();
    await refreshThreads();
    renderContacts();
    if (sel && threads.find(x => x.pubkey === sel)) select(sel);
  }

  window.ChatPanel = {
    init(deps) { D = deps; },
    render,
    backup: backupChats, restore: restoreChats,   // also opened from Backup & Recovery
    async onUpdate() {
      await refreshThreads();
      renderContacts();
      if (sel) await renderMsgs(false);
    },
    async badge() {
      try { return (await D.api.chatStatus()).unread || 0; } catch (e) { return 0; }
    },
    async focusLatest() {
      await refreshThreads();
      const t = threads.find(x => x.unread > 0) || threads[0];
      if (t) select(t.pubkey);
    },
    reset() { me = { pubkey: "", name: "" }; sel = null; threads = []; booted = false; if (player) { player.pause(); player = null; playingRef = ""; } }
  };
})();
