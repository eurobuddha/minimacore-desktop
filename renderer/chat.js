/*
 * chat.js — the KeetChat panel (renderer). All state lives in the main process
 * (main/chat.js drains the sidecar inbox; main/chat-store.js is the history);
 * this file only renders and calls the mcd:chat* IPC surface. Scoped to .chatapp
 * (chat.css) so its styling can't leak into other tabs — the MailPanel pattern.
 *
 * minima kind only: app.js hides the tab for the parlons kind (no keets there).
 */
/* global ChatPanel */
(function () {
  let D = null;              // deps from app.js: { api, esc, el, toast, copy, showPrompt, showConfirm }
  let me = { pubkey: "", name: "" };
  let sel = null;            // selected contact pubkey
  let threads = [];
  let booted = false;

  function h(s) { return D.esc("" + (s == null ? "" : s)); }

  async function boot() {
    if (booted) return;
    booted = true;
    try { me = await D.api.chatInit(); } catch (e) { /* node/sidecar still starting — identity fills on next render */ }
  }

  async function refreshThreads() {
    try { threads = await D.api.chatThreads(); } catch (e) { threads = []; }
  }

  function fmtWhen(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString() === new Date().toLocaleDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function shell() {
    return `<div class="chatapp">
      <div class="chat-id">
        <div>
          <span class="chat-id__label">your keets address</span>
          <button class="chat-mini" id="chatNameBtn">name: ${h(me.name || "set")}</button>
        </div>
        <code class="chat-id__pub" id="chatMyPub" title="Click to copy the full address">${h(me.pubkey || "node starting…")}</code>
      </div>
      <div class="chat-cols">
        <div class="chat-left">
          <div class="chat-contacts" id="chatContacts"></div>
          <div class="chat-add">
            <input class="field__input" id="chatAddName" placeholder="Contact name" autocomplete="off" />
            <input class="field__input" id="chatAddPub" placeholder="0x… their keets pubkey (64 hex)" autocomplete="off" />
            <button class="btn btn--primary btn--full" id="chatAddBtn">Add contact</button>
          </div>
        </div>
        <div class="chat-right">
          <div class="chat-head" id="chatHead" hidden>
            <span id="chatSelName"></span>
            <button class="chat-mini" id="chatRenameBtn">rename</button>
            <button class="chat-mini chat-mini--danger" id="chatRemoveBtn">remove</button>
            <code class="chat-head__pub" id="chatSelPub"></code>
          </div>
          <div class="chat-msgs" id="chatMsgs">
            <div class="chat-empty">Add a contact and say hello.<br><br>
            Your address is your node's keets pubkey — share it by QR or any channel.<br>
            Delivered direct when they're online, held at a mailbox when they're not.<br>
            No server, no setup.</div>
          </div>
          <div class="chat-sendrow" id="chatSendRow" hidden>
            <input class="field__input" id="chatText" placeholder="Message… (enter to send)" autocomplete="off" />
            <button class="btn btn--primary" id="chatSendBtn">Send</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderContacts() {
    const box = D.el("chatContacts");
    if (!box) return;
    box.innerHTML = threads.length ? "" : `<div class="chat-empty chat-empty--side">No contacts yet.</div>`;
    for (const t of threads) {
      const d = document.createElement("div");
      d.className = "chat-contact" + (t.pubkey === sel ? " chat-contact--sel" : "");
      d.innerHTML = `<div class="chat-contact__row"><span class="chat-contact__name">${h(t.name)}</span>` +
        (t.unread ? `<span class="chat-unread">${t.unread > 99 ? "99+" : t.unread}</span>` : "") + `</div>` +
        `<div class="chat-contact__pub">${h(t.pubkey)}</div>` +
        (t.last ? `<div class="chat-contact__last">${h((t.last.incoming ? "" : "you: ") + t.last.body)}</div>` : "");
      d.onclick = () => select(t.pubkey, t.name);
      box.appendChild(d);
    }
  }

  async function renderMsgs(scroll) {
    const box = D.el("chatMsgs");
    if (!box || !sel) return;
    let msgs = [];
    try { msgs = await D.api.chatThread(sel); } catch (e) { return; }
    box.innerHTML = msgs.length ? "" : `<div class="chat-empty">No messages yet — say hello.</div>`;
    for (const m of msgs) {
      const d = document.createElement("div");
      d.className = "chat-bubble " + (m.incoming ? "chat-bubble--in" : "chat-bubble--out");
      const status = m.incoming ? (m.via || "") :
        (m.status === "failed" ? "FAILED" : m.status === "mailboxed" ? "at mailbox" : m.status === "delivered" ? "delivered" : m.status || "");
      d.innerHTML = `<div class="chat-bubble__body">${h(m.body)}</div>` +
        (m.ref ? `<div class="chat-bubble__meta">media: ${h(m.ref)}</div>` : "") +
        `<div class="chat-bubble__meta">${fmtWhen(m.ts)}${status ? " · " + h(status) : ""}</div>`;
      box.appendChild(d);
    }
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  async function select(pubkey, name) {
    sel = pubkey;
    const head = D.el("chatHead");
    if (head) {
      head.hidden = false;
      D.el("chatSelName").textContent = name || pubkey;
      D.el("chatSelPub").textContent = pubkey;
    }
    const row = D.el("chatSendRow");
    if (row) { row.hidden = false; }
    renderContacts();
    await renderMsgs(true);
    await refreshThreads();   // selecting marks read (main does it in thread()); refresh badges
    renderContacts();
    ChatPanel.badgeChanged && ChatPanel.badgeChanged();
    const inp = D.el("chatText"); if (inp) inp.focus();
  }

  async function doSend() {
    const inp = D.el("chatText");
    const text = (inp.value || "").trim();
    if (!text || !sel) return;
    inp.value = "";
    try {
      const m = await D.api.chatSend(sel, text);
      D.toast(m && m.via === "direct" ? "Delivered direct" : "Stored at a mailbox — delivered when they come online", "ok");
    } catch (e) {
      D.toast("Send failed: " + (e.message || e), "err");
    }
    await refreshThreads(); renderContacts(); await renderMsgs(true);
  }

  async function doAdd() {
    const name = (D.el("chatAddName").value || "").trim();
    const pub = (D.el("chatAddPub").value || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pub)) { D.toast("Pubkey must be 0x + 64 hex", "err"); return; }
    try { await D.api.chatAddContact(pub.toLowerCase(), name); } catch (e) { D.toast(e.message || "" + e, "err"); return; }
    D.el("chatAddName").value = ""; D.el("chatAddPub").value = "";
    await refreshThreads(); renderContacts();
    select(pub.toLowerCase(), name || pub.toLowerCase());
  }

  function wire(root) {
    D.el("chatMyPub").onclick = async () => { if (me.pubkey) { await D.copy(me.pubkey); D.toast("Address copied", "ok"); } };
    D.el("chatNameBtn").onclick = async () => {
      const n = await D.showPrompt("Your display name (sent with your messages)", me.name || "", "name");
      if (n === null || n === undefined) return;
      me = await D.api.chatSetName(n);
      render();
    };
    D.el("chatAddBtn").onclick = doAdd;
    D.el("chatSendBtn").onclick = doSend;
    D.el("chatText").onkeydown = (ev) => { if (ev.key === "Enter") doSend(); };
    D.el("chatRenameBtn").onclick = async () => {
      if (!sel) return;
      const cur = (threads.find(t => t.pubkey === sel) || {}).name || "";
      const n = await D.showPrompt("Contact name", cur, "name");
      if (!n) return;
      await D.api.chatRenameContact(sel, n);
      await refreshThreads(); renderContacts();
      D.el("chatSelName").textContent = n;
    };
    D.el("chatRemoveBtn").onclick = async () => {
      if (!sel) return;
      const ok = await D.showConfirm("Remove contact", "Remove this contact AND its message history? This cannot be undone.", "Remove", true);
      if (!ok) return;
      await D.api.chatRemoveContact(sel);
      sel = null;
      render();
    };
  }

  window.ChatPanel = {
    init(deps) { D = deps; },
    async render() {
      await boot();
      if (!me.pubkey) { try { me = await D.api.chatInit(); } catch (e) {} }
      const body = D.el("chatBody");
      if (!body) return;
      body.innerHTML = shell();
      wire(body);
      await refreshThreads();
      renderContacts();
      if (sel) {
        const t = threads.find(x => x.pubkey === sel);
        if (t) select(sel, t.name); else { sel = null; }
      }
    },
    /** main pushed an update (new message stored) — refresh what's on screen */
    async onUpdate() {
      await refreshThreads();
      renderContacts();
      if (sel) await renderMsgs(true);
    },
    async badge() {
      try { return (await D.api.chatStatus()).unread || 0; } catch (e) { return 0; }
    },
    /** notification click: jump to the newest unread thread */
    async focusLatest() {
      await refreshThreads();
      const t = threads.find(x => x.unread > 0) || threads[0];
      if (t) select(t.pubkey, t.name);
    },
    reset() { me = { pubkey: "", name: "" }; sel = null; threads = []; booted = false; }
  };
})();
