/*
 * chat.js — the KeetChat panel (renderer), messenger-grade: avatar thread list (no raw
 * hex in rows), identity modal with QR + full-address copy, bubbles with day separators
 * and delivery ticks (🕓 sending, ✓ held at a mailbox, ✓✓ delivered direct). All state
 * lives in the main process (main/chat.js drains the sidecar inbox; chat-store.js is
 * the history); this file only renders and calls the mcd:chat* IPC surface. Scoped to
 * .chatapp (chat.css). minima kind only — app.js hides the tab for the parlons kind.
 */
/* global ChatPanel, qrcode */
(function () {
  let D = null;              // deps from app.js: { api, esc, el, toast, copy, showPrompt, showConfirm }
  let me = { pubkey: "", name: "" };
  let sel = null;            // selected contact pubkey
  let threads = [];
  let booted = false;
  const mediaCache = {};   // ref -> data url

  function h(s) { return D.esc("" + (s == null ? "" : s)); }

  function hueOf(pk) {
    try { return parseInt(pk.slice(4, 8), 16) % 360; } catch (e) { return 200; }
  }
  function displayName(t) { return t.name && t.name.indexOf("0x") !== 0 ? t.name : "New contact"; }
  function avatarHtml(name, pk, cls) {
    const initial = (name && name.indexOf("0x") !== 0) ? name[0].toUpperCase() : "#";
    return `<span class="chat-avatar ${cls || ""}" style="background:hsl(${hueOf(pk)},55%,52%)">${h(initial)}</span>`;
  }
  function qrHtml(text) {
    try {
      if (typeof qrcode === "undefined") return "";
      const qr = qrcode(0, "M"); qr.addData(text); qr.make();
      return `<div class="chat-qr">${qr.createImgTag(4, 8)}</div>`;
    } catch (e) { return ""; }
  }
  function tick(m) {
    if (m.incoming) return "";
    if (m.peerread) return ` <span class="chat-tick--read">✓✓</span>`;
    if (m.status === "failed") return " ✗";
    if (m.status === "delivered" || m.via === "direct") return " ✓✓";
    if (m.status === "mailboxed" || m.via === "mailbox") return " ✓";
    return " 🕓";
  }
  function listTime(ts) {
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  async function boot() {
    if (booted) return;
    booted = true;
    try { me = await D.api.chatInit(); } catch (e) { /* node starting — retried on render */ }
  }
  async function refreshThreads() {
    try { threads = await D.api.chatThreads(); } catch (e) { threads = []; }
  }

  // ---- lightbox: full-size photo, wheel zoom, drag pan, double-click toggle --
  function lightbox(dataUrl, caption) {
    document.body.insertAdjacentHTML("beforeend",
      `<div class="chat-lightbox" id="chatLb">
        <img id="chatLbImg" alt="photo" src="${dataUrl}" />
        ${caption ? `<div class="chat-lightbox__cap">${h(caption)}</div>` : ""}
        <button class="chat-lightbox__close" id="chatLbClose">✕</button>
      </div>`);
    const lb = D.el("chatLb");
    const img = D.el("chatLbImg");
    let scale = 1, tx = 0, ty = 0, dragging = false, lx = 0, ly = 0;
    const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    const onMove = (e) => {
      if (!dragging) return;
      tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
    };
    const onUp = () => { dragging = false; };
    const close = () => {
      lb.remove();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    D.el("chatLbClose").onclick = close;
    lb.onclick = (e) => { if (e.target === lb) close(); };
    lb.onwheel = (e) => {
      e.preventDefault();
      scale = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    };
    img.ondblclick = () => { scale = scale > 1.01 ? 1 : 2.5; if (scale === 1) { tx = 0; ty = 0; } apply(); };
    img.onmousedown = (e) => { dragging = true; lx = e.clientX; ly = e.clientY; e.preventDefault(); };
  }

  // ---- modals (same overlay/modal classes the rest of the app uses) --------
  function modalWithRead(title, inner, okLabel, readFn) {
    return new Promise((resolve) => {
      document.body.insertAdjacentHTML("beforeend",
        `<div class="overlay" id="chatOv"><div class="modal chat-modal">
          <div class="modal__title">${h(title)}</div>${inner}
          <div class="seg" style="margin-top:14px">
            <button class="btn btn--outline btn--full" id="chatOvCancel">Cancel</button>
            <button class="btn btn--primary btn--full" id="chatOvOk">${h(okLabel || "Done")}</button>
          </div></div></div>`);
      const ov = D.el("chatOv");
      D.el("chatOvCancel").onclick = () => { ov.remove(); resolve(null); };
      D.el("chatOvOk").onclick = () => { const v = readFn ? readFn() : true; ov.remove(); resolve(v); };
    });
  }

  async function identityModal() {
    if (!me.pubkey) { try { me = await D.api.chatInit(); } catch (e) {} }
    const inner = `
      ${me.pubkey ? qrHtml(me.pubkey) : `<div class="chat-empty">Node starting — try again in a moment.</div>`}
      <code class="chat-fulladdr">${h(me.pubkey || "")}</code>
      <button class="btn btn--outline btn--full" id="chatCopyAddr" style="margin-top:8px">Copy address</button>
      <input class="field__input" id="chatMyName" placeholder="Your display name" value="${h(me.name || "")}" style="margin-top:10px" />`;
    const p = modalWithRead("My address", inner, "Save", () => D.el("chatMyName").value.trim());
    const copyBtn = D.el("chatCopyAddr");
    if (copyBtn) copyBtn.onclick = async () => { await D.copy(me.pubkey); D.toast("Address copied", "ok"); };
    const name = await p;
    if (name !== null && name !== undefined) {
      me = await D.api.chatSetName(name);
      render();
    }
  }

  async function newChatModal() {
    const inner = `
      <input class="field__input" id="chatNewAddr" placeholder="Their address — 0x…" style="font-family:ui-monospace,monospace" />
      <input class="field__input" id="chatNewName" placeholder="Name (optional)" style="margin-top:8px" />`;
    const v = await modalWithRead("New chat", inner, "Start chat", () => ({
      addr: D.el("chatNewAddr").value.trim().toLowerCase(),
      name: D.el("chatNewName").value.trim()
    }));
    if (!v) return;
    if (!/^0x[0-9a-f]{64}$/.test(v.addr)) { D.toast("A keets address is 0x + 64 hex characters", "err"); return; }
    try { await D.api.chatAddContact(v.addr, v.name); } catch (e) { D.toast(e.message || "" + e, "err"); return; }
    await refreshThreads();
    select(v.addr);
  }

  async function contactAddressModal() {
    if (!sel) return;
    const inner = `${qrHtml(sel)}<code class="chat-fulladdr">${h(sel)}</code>
      <button class="btn btn--outline btn--full" id="chatCopyAddr" style="margin-top:8px">Copy address</button>`;
    const p = modalWithRead("Contact address", inner, "Done", () => true);
    const copyBtn = D.el("chatCopyAddr");
    if (copyBtn) copyBtn.onclick = async () => { await D.copy(sel); D.toast("Address copied", "ok"); };
    await p;
  }

  // ---- shell ----------------------------------------------------------------
  function shell() {
    return `<div class="chatapp">
      <div class="chat-cols">
        <div class="chat-left">
          <div class="chat-left-head">
            <button class="btn btn--primary btn--full" id="chatNewBtn">New chat</button>
            <button class="chat-idbtn" id="chatIdBtn" title="Your address & QR">
              ${me.pubkey ? avatarHtml(me.name || "Me", me.pubkey, "chat-avatar--sm") : ""}
              <span>${h(me.name || "My address")}</span>
            </button>
          </div>
          <div class="chat-contacts" id="chatContacts"></div>
        </div>
        <div class="chat-right">
          <div class="chat-head" id="chatHead" hidden>
            <span id="chatHeadAvatar"></span>
            <div class="chat-head__names">
              <span id="chatSelName"></span>
              <span class="chat-head__sub">end-to-end encrypted · no server</span>
            </div>
            <span class="chat-head__actions">
              <button class="chat-mini" id="chatAddrBtn">address</button>
              <button class="chat-mini" id="chatRenameBtn">rename</button>
              <button class="chat-mini chat-mini--danger" id="chatRemoveBtn">delete</button>
            </span>
          </div>
          <div class="chat-msgs" id="chatMsgs">
            <div class="chat-empty">Pick a chat, or start a new one.<br><br>
            Your address is your node's keets key — share it from the button top-left.<br>
            Messages deliver instantly when your contact is online,<br>and wait safely at a mailbox when they're not.</div>
          </div>
          <div class="chat-sendrow" id="chatSendRow" hidden>
            <button class="chat-attachbtn" id="chatAttachBtn" title="Attach">📎</button>
            <input class="chat-input" id="chatText" placeholder="Message" autocomplete="off" />
            <button class="chat-sendbtn" id="chatSendBtn" title="Send">➤</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderContacts() {
    const box = D.el("chatContacts");
    if (!box) return;
    box.innerHTML = threads.length ? "" : `<div class="chat-empty chat-empty--side">No chats yet.<br>Start one with “New chat”.</div>`;
    for (const t of threads) {
      const d = document.createElement("div");
      d.className = "chat-contact" + (t.pubkey === sel ? " chat-contact--sel" : "");
      const name = displayName(t);
      d.innerHTML = `${avatarHtml(name, t.pubkey)}
        <div class="chat-contact__mid">
          <div class="chat-contact__name">${h(name)}</div>
          <div class="chat-contact__last">${h(t.last ? ((t.last.incoming ? "" : "You: ") + t.last.body) : "")}</div>
        </div>
        <div class="chat-contact__side">
          <span class="chat-contact__time">${h(listTime(t.last && t.last.ts))}</span>
          ${t.unread ? `<span class="chat-unread">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}
        </div>`;
      d.onclick = () => select(t.pubkey);
      box.appendChild(d);
    }
  }

  async function renderMsgs(scroll) {
    const box = D.el("chatMsgs");
    if (!box || !sel) return;
    let msgs = [];
    try { msgs = await D.api.chatThread(sel); } catch (e) { return; }
    box.innerHTML = msgs.length ? "" : `<div class="chat-empty">Say hello 👋</div>`;
    let lastDay = "";
    for (const m of msgs) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement("div");
        sep.className = "chat-day";
        sep.innerHTML = `<span>${h(day)}</span>`;
        box.appendChild(sep);
      }
      const d = document.createElement("div");
      d.className = "chat-bubble " + (m.incoming ? "chat-bubble--in" : "chat-bubble--out");
      const when = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const meta = `<div class="chat-bubble__meta">${h(when)}${h(tick(m))}</div>`;
      if (m.state === "image" && m.ref) {
        // photo: thumb loads lazily, click for the lightbox
        d.innerHTML = `<div class="chat-bubble__body" style="opacity:.6">📷 loading…</div>` + meta;
        box.appendChild(d);
        D.api.chatMedia(m.ref).then((u) => {
          d.firstChild.outerHTML =
            `<img src="${u}" alt="photo" style="max-width:260px;max-height:260px;border-radius:10px;cursor:zoom-in" />`;
          d.querySelector("img").onclick = () => lightbox(u, m.body);
        }).catch(() => { d.firstChild.textContent = "📷 Photo — not available yet"; });
      } else if (m.state === "audio" && m.ref) {
        // voice note: body is "M:SS|waveformhex" — show the duration, fetch on play
        const dur = (m.body || "").split("|")[0] || "";
        d.innerHTML = `<div class="chat-bubble__body" style="cursor:pointer">▶ 🎤 Voice note · ${h(dur)}</div>` + meta;
        box.appendChild(d);
        const bodyEl = d.firstChild;
        const playOnce = async () => {
          bodyEl.onclick = null;
          bodyEl.style.opacity = ".6";
          try {
            const u = await D.api.chatMedia(m.ref);
            bodyEl.outerHTML = `<audio controls autoplay src="${u}" style="max-width:240px;height:34px"></audio>`;
          } catch (e) {
            bodyEl.textContent = "🎤 Voice note — not available yet (tap to retry)";
            bodyEl.style.opacity = "1";
            bodyEl.onclick = playOnce;   // a transient failure must stay tappable
          }
        };
        bodyEl.onclick = playOnce;
      } else {
        d.innerHTML = `<div class="chat-bubble__body">${h(m.body)}</div>` +
          (m.ref ? `<div class="chat-bubble__attach" title="Click to copy the full link">📎 Attachment</div>` : "") +
          meta;
        if (m.ref) {
          const a = d.querySelector(".chat-bubble__attach");
          a.onclick = async () => { await D.copy(m.ref); D.toast("Link copied", "ok"); };
        }
        box.appendChild(d);
      }
    }
    if (scroll) box.scrollTop = box.scrollHeight;
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

  async function doSend() {
    const inp = D.el("chatText");
    const text = (inp.value || "").trim();
    if (!text || !sel) return;
    inp.value = "";
    try { await D.api.chatSend(sel, text); }
    catch (e) { D.toast("Not sent — " + (e.message || e), "err"); }
    await refreshThreads(); renderContacts(); await renderMsgs(true);
  }

  function wire() {
    D.el("chatNewBtn").onclick = newChatModal;
    D.el("chatIdBtn").onclick = identityModal;
    D.el("chatSendBtn").onclick = doSend;
    D.el("chatAttachBtn").onclick = async () => {
      if (!sel) return;
      const inner = `<div class="seg" style="flex-direction:column;gap:8px">
        <button class="btn btn--outline btn--full" id="chatAttPhoto">📷 Photo</button>
        <button class="btn btn--outline btn--full" id="chatAttPay">💸 Send payment</button>
        <button class="btn btn--outline btn--full" id="chatAttAddr">🏷 Request their pay address</button></div>`;
      let settle = null;
      const p = modalWithRead("Attach", inner, "Close", () => null);
      const closeMenu = () => { const ov = D.el("chatOv"); if (ov) { ov.remove(); } if (settle) settle(); };
      // modalWithRead resolves only via its own buttons; option handlers settle through closeMenu
      const settled = new Promise((r) => { settle = r; });
      D.el("chatAttPhoto").onclick = async () => {
        closeMenu();
        try { const r = await D.api.chatSendImage(sel); if (r) D.toast(r.via === "direct" ? "Photo delivered" : "Photo stored at a mailbox", "ok"); }
        catch (e) { D.toast("Photo failed: " + (e.message || e), "err"); }
        await refreshThreads(); renderContacts(); await renderMsgs(true);
      };
      D.el("chatAttPay").onclick = async () => {
        closeMenu();
        const addr = await D.api.chatPayAddr(sel);
        if (!addr) {
          await D.api.chatRequestPayAddr(sel).catch(() => {});
          D.toast("No pay address yet — requested it over chat, try again shortly", "err");
          return;
        }
        const amt = await D.showPrompt("Send Minima to " + addr, "", "amount", { message: "This sends real Minima from this node's wallet." });
        if (!amt) return;
        try { await D.api.chatSendPayment(sel, amt.trim()); D.toast("Payment sent", "ok"); }
        catch (e) { D.toast("Payment failed: " + (e.message || e), "err"); }
        await refreshThreads(); renderContacts(); await renderMsgs(true);
      };
      D.el("chatAttAddr").onclick = async () => {
        closeMenu();
        await D.api.chatRequestPayAddr(sel).catch(() => {});
        D.toast("Address requested — arrives automatically", "ok");
      };
      await Promise.race([p, settled]);
    };
    D.el("chatText").onkeydown = (ev) => { if (ev.key === "Enter") doSend(); };
    D.el("chatAddrBtn").onclick = contactAddressModal;
    D.el("chatRenameBtn").onclick = async () => {
      if (!sel) return;
      const t = threads.find(x => x.pubkey === sel) || {};
      const cur = t.name && t.name.indexOf("0x") !== 0 ? t.name : "";
      const n = await D.showPrompt("Contact name", cur, "name");
      if (!n) return;
      await D.api.chatRenameContact(sel, n);
      await refreshThreads(); renderContacts();
      D.el("chatSelName").textContent = n;
    };
    D.el("chatRemoveBtn").onclick = async () => {
      if (!sel) return;
      const ok = await D.showConfirm("Delete chat", "Delete this chat AND its history? This cannot be undone.", "Delete", true);
      if (!ok) return;
      await D.api.chatRemoveContact(sel);
      sel = null;
      render();
    };
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
    async onUpdate() {
      await refreshThreads();
      renderContacts();
      if (sel) await renderMsgs(true);
    },
    async badge() {
      try { return (await D.api.chatStatus()).unread || 0; } catch (e) { return 0; }
    },
    async focusLatest() {
      await refreshThreads();
      const t = threads.find(x => x.unread > 0) || threads[0];
      if (t) select(t.pubkey);
    },
    reset() { me = { pubkey: "", name: "" }; sel = null; threads = []; booted = false; }
  };
})();
