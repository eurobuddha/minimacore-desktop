/*
 * mail.js — the minimaMail panel, rebuilt to Minima Mail APK 0.5.8 parity.
 *
 * Screens and behaviour follow the APK's own email shell (DESIGN_MAP.md, "0.5.0 — email shell, chat heart"):
 * folders Inbox/Outbox/Sent/Archive plus Contacts/Your key/Settings, one row per (contact, subject) thread with
 * sender + time / subject / snippet, day-grouped bubbles with an honest per-message chain status, and a
 * freshness line that says what has actually been scanned. The folder strip is the Parlons tab strip.
 *
 * Why this is its own file: the old panel lived in ~590 lines inside app.js, shared app.css classes with
 * miniMall (#view-minimall owns .mail-thread), and could not carry the APK palette without leaking it into
 * every other tab. Everything here is scoped to .mailapp / .mm-*.
 *
 * Shared helpers come in through init(deps) rather than globals, so load order never matters.
 */
(function (g) {
  "use strict";

  var D = null;                 // { api, esc, el, toast, copy, short, showPrompt, showConfirm, showActionSheet, scanQR, TOK }
  var ID = null;                // { publicId, name, payaddr }
  var CONTACTS = [];
  var STATUS = null;            // main's scan/backfill status
  var VIEW = "inbox";           // inbox | outbox | sent | archive | contacts | key | settings | thread | compose
  var PEER = null, SUBJ = "", HASH = "";
  var COMPOSE = null;           // { to, subject, body } kept across a re-render so typing is never lost
  var booted = false;

  var FOLDERS = [["inbox", "Inbox"], ["outbox", "Outbox"], ["sent", "Sent"], ["archive", "Archive"],
    ["contacts", "Contacts"], ["key", "Your key"], ["settings", "Settings"]];

  function init(deps) { D = deps; }
  function reset() { ID = null; CONTACTS = []; STATUS = null; VIEW = "inbox"; PEER = null; SUBJ = ""; HASH = ""; COMPOSE = null; booted = false; }

  // ---------------------------------------------------------------- identity, names, avatars
  /** 0x + first 8 + … + last 6 — the APK's shortKey. NEVER used where the whole value must be copyable:
   *  every shortened id in this panel sits on an element whose click copies the complete string. */
  function shortKey(id) {
    var s = String(id || "");
    if (!s) return "";
    var h = s.replace(/^0x/i, "");
    if (h.length <= 14) return s;
    return "0x" + h.slice(0, 8) + "…" + h.slice(-6);
  }
  /**
   * Who wrote this. Contact name first, then the sender's own declared name off the message, then the short key
   * — the same chain main/mail.js already uses for OS notifications. The old panel resolved from an id alone,
   * so it could never see `fromname` and every unsaved peer showed as hex.
   */
  function nameFor(id, msg) {
    if (!id) return "(unknown)";
    if (ID && id === ID.publicId) return "You";
    for (var i = 0; i < CONTACTS.length; i++) if (CONTACTS[i].publicId === id) {
      if (CONTACTS[i].username) return CONTACTS[i].username;
      break;
    }
    if (msg) {
      // fromname travels on every message, but only the SENDER's own messages declare their name.
      var theirs = msg.incoming ? msg.fromname : null;
      if (theirs) return theirs;
    }
    return shortKey(id);
  }
  /** The APK's avatar: hash → HSV(S .55, V .72). In CSS that is exactly hsl(H, 38%, 52%). */
  function discHue(key) { var h = 0, s = String(key || ""); for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return ((h % 360) + 360) % 360; }
  function initials(name, key) {
    var n = String(name || "").trim();
    if (n && !/^0x/i.test(n)) {
      var parts = n.split(/\s+/);
      var a = parts[0].charAt(0), b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
      return (a + b).toUpperCase();
    }
    var h = String(key || "").replace(/^0x/i, "");
    return h ? h.slice(0, 2).toUpperCase() : "•";
  }
  function avatar(key, name, size) {
    return '<span class="mm-av mm-av--' + size + '" style="background:hsl(' + discHue(key) + ',38%,52%)">'
      + D.esc(initials(name, key)) + "</span>";
  }

  // ---------------------------------------------------------------- time, in the APK's words
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function clock(ms) { var d = new Date(Number(ms)); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** now · 42m · HH:mm · 3d · "7 Mar" — MainActivity.rel() */
  function rel(ms) {
    var t = Number(ms) || 0; if (!t) return "";
    var diff = Date.now() - t, d = new Date(t);
    if (diff < 60000) return "now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m";
    if (diff < 86400000) return clock(t);
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + "d";
    return d.getDate() + " " + MON[d.getMonth()];
  }
  function dayStart(ms) { var d = new Date(Number(ms)); d.setHours(0, 0, 0, 0); return d.getTime(); }
  /** Today · Yesterday · "7 Mar 2026" — MainActivity.dateLabel() */
  function dayLabel(ms) {
    var days = Math.round((dayStart(Date.now()) - dayStart(ms)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    var d = new Date(Number(ms));
    return d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear();
  }
  function groupInt(n) { return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // ---------------------------------------------------------------- message helpers
  function previewText(m) {
    if (!m) return "";
    if (m.type === "image") return "Photo";
    if (m.type === "payment") return D.TOK.tidyAmount(m.amount || "") + " " + (m.tokenname || "MINIMA") + (m.message ? " — " + oneLine(m.message) : "");
    return oneLine(m.message || "");
  }
  function oneLine(s) { var t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > 64 ? t.slice(0, 64) + "…" : t; }
  function otherOf(t) {
    var m = t.last || t;
    if (!ID) return "";
    return m.incoming ? m.frompublickey : m.topublickey;
  }

  // ---------------------------------------------------------------- shell
  function header() {
    return '<div class="mm-bar"><span class="mm-brand">MINIMA <i>MAIL</i></span>'
      + '<button class="mm-ibtn" type="button" id="mmTheme" aria-label="Theme" title="Light / dark">' + g.micon("theme") + "</button>"
      + '<button class="mm-ibtn" type="button" id="mmMore" aria-label="About Minima Mail" title="About">' + g.micon("dots") + "</button></div>"
      + '<div class="mm-tabs" role="tablist" id="mmTabs">' + FOLDERS.map(function (f) {
        var n = f[0] === "inbox" ? unreadCount() : f[0] === "outbox" ? OUT.length : 0;
        return '<button type="button" role="tab" data-f="' + f[0] + '" aria-selected="' + (VIEW === f[0]) + '">' + D.esc(f[1])
          + (n ? '<span class="mm-cnt">' + n + "</span>" : "") + "</button>";
      }).join("") + "</div>";
  }
  /** The freshness line — the panel's one honest statement about how much of the chain it has actually read. */
  function freshness() {
    var st = STATUS || {};
    var bf = st.backfill || {};
    var cls = "mm-fresh", text, act = "Check now";
    if (!st.scannedTip) { cls += " mm-cold"; text = "Waiting for your node…"; }
    else if (bf.active) {
      cls += " mm-busy";
      text = "Catching up — block " + groupInt(bf.floor || 0) + " of " + groupInt(st.scannedTip);
    } else {
      var mins = st.lastScanMs ? Math.floor((Date.now() - st.lastScanMs) / 60000) : 0;
      text = "Checked block " + groupInt(st.scannedTip) + " · " + (mins < 1 ? "just now" : mins + " min ago");
      if (bf.done) act = "Check now";
    }
    return '<div class="' + cls + '" id="mmFresh"><span class="mm-dot"></span>'
      + '<span class="mm-grow">' + D.esc(text) + "</span>"
      + '<button class="mm-act" type="button" id="mmCheck">' + g.micon("refresh") + D.esc(act) + "</button></div>";
  }

  // ---------------------------------------------------------------- rows
  function threadRow(t) {
    var m = t.last || {};
    var peer = t.other || otherOf(t);
    var unread = !!t.unread;
    var subject = (m.subject || "").trim();
    var nm = nameFor(peer, m);
    var isHex = nm.indexOf("0x") === 0;
    return '<button class="mm-row' + (unread ? " mm-unread" : "") + '" type="button" data-peer="' + D.esc(peer)
      + '" data-subject="' + D.esc(subject) + '" data-hashref="' + D.esc(t.hashref || "") + '">'
      + avatar(peer, nm, 44)
      + '<span class="mm-mid"><span class="mm-l1">'
      + '<span class="mm-nm' + (isHex ? " mm-key" : "") + '">' + D.esc(nm) + "</span>"
      + '<span class="mm-time">' + D.esc(rel(m.date)) + "</span></span>"
      + '<span class="mm-subj' + (subject ? "" : " mm-none") + '">' + D.esc(subject || "(no subject)") + "</span>"
      + '<span class="mm-snip">' + D.esc((m.incoming ? "" : "You: ") + previewText(m)) + "</span></span>"
      + (unread ? '<span class="mm-udot"></span>' : "") + "</button>";
  }
  /** The four chain states, said plainly. The old panel showed ✓ / ✓✓ — ticks it had invented, since this
   *  protocol has no read receipt at all; what a sender can actually know is whether the coin reached a block. */
  function statusLine(m, withRetry) {
    var st = m.status || "sent", ic, cls, lbl;
    if (st === "posting") { ic = "ring"; cls = "mm-posting"; lbl = "Posting to chain…"; }
    else if (st === "failed") { ic = "close"; cls = "mm-failed"; lbl = "Failed — didn't reach the chain"; }
    else if (st === "confirmed") { ic = "check"; cls = "mm-ok"; lbl = "Confirmed" + (m.sentblock ? " · block " + groupInt(m.sentblock) : ""); }
    else { ic = "chain"; cls = "mm-chain"; lbl = "On-chain" + (m.sentblock ? " · blk " + groupInt(m.sentblock) : "") + " — confirming"; }
    return '<div class="mm-stat ' + cls + '">' + g.micon(ic) + "<span>" + D.esc(lbl) + "</span>"
      + (withRetry && st === "failed"
        ? '<button class="mm-retry" type="button" data-retry="' + D.esc(m.hashref) + '" data-rid="' + D.esc(m.randomid) + '">'
          + g.micon("refresh") + "Retry</button>"
        : "") + "</div>";
  }
  function statusRow(m, withRetry) {
    var subject = (m.subject || "").trim();
    return '<div class="mm-srow" data-peer="' + D.esc(m.topublickey) + '" data-subject="' + D.esc(subject) + '">'
      + '<div class="mm-sto"><b>To ' + D.esc(nameFor(m.topublickey, m)) + " — " + D.esc(subject || "(no subject)") + "</b>"
      + "<span>" + D.esc(rel(m.date)) + "</span></div>"
      + '<div class="mm-ssnip">' + D.esc(previewText(m)) + "</div>"
      + statusLine(m, withRetry) + "</div>";
  }

  // ---------------------------------------------------------------- data caches (so the tab strip can count)
  var THREADS = [], ARCHIVED = [], OUT = [], SENTL = [];
  function unreadCount() { var n = 0; for (var i = 0; i < THREADS.length; i++) n += Number(THREADS[i].unread || 0); return n; }

  async function loadLists() {
    var r = await Promise.all([
      D.api.mailThreads().catch(function () { return []; }),
      D.api.mailArchivedThreads().catch(function () { return []; }),
      D.api.mailOutbox().catch(function () { return []; }),
      D.api.mailSent().catch(function () { return []; }),
      D.api.mailContacts().catch(function () { return []; }),
      D.api.mailStatus().catch(function () { return null; })
    ]);
    THREADS = r[0] || []; ARCHIVED = r[1] || []; OUT = r[2] || []; SENTL = r[3] || [];
    CONTACTS = r[4] || []; STATUS = r[5];
  }

  // ---------------------------------------------------------------- screens
  function folderBody(f) {
    if (f === "inbox" || f === "archive") {
      var list = f === "inbox" ? THREADS : ARCHIVED;
      if (!list.length) {
        return '<div class="mm-empty">' + (f === "inbox"
          ? "No mail yet.\nCompose a message to get started." : "No archived threads.") + "</div>";
      }
      return '<div class="mm-list">' + list.map(threadRow).join("") + "</div>";
    }
    if (f === "outbox") {
      return OUT.length ? OUT.map(function (m) { return statusRow(m, true); }).join("")
        : '<div class="mm-empty">Outbox is empty — everything you sent has reached the chain.</div>';
    }
    if (f === "sent") {
      return SENTL.length ? SENTL.map(function (m) { return statusRow(m, false); }).join("")
        : '<div class="mm-empty">Nothing sent yet.</div>';
    }
    if (f === "contacts") {
      if (!CONTACTS.length) return '<div class="mm-empty">No contacts yet.\nAdd someone\'s Mail key to start.</div>';
      return '<div class="mm-list">' + CONTACTS.map(function (c) {
        var nm = c.username || shortKey(c.publicId);
        return '<button class="mm-row" type="button" data-contact="' + D.esc(c.publicId) + '" style="border-bottom:0">'
          + avatar(c.publicId, nm, 44)
          + '<span class="mm-mid"><span class="mm-nm" style="color:var(--mm-text);font-weight:700;font-size:15px">' + D.esc(nm) + "</span>"
          + '<span class="mm-snip mm-key" style="font-size:12px">' + D.esc(shortKey(c.publicId)) + "</span></span></button>";
      }).join("") + "</div>";
    }
    if (f === "key") return identityBody();
    return settingsBody();
  }

  function identityBody() {
    var pid = (ID && ID.publicId) || "";
    return '<div class="mm-id">' + avatar(pid, ID && ID.name, 72)
      + '<div class="mm-qr" id="mmQr"></div>'
      + '<div class="mm-idcap">Have someone scan this, or share your key:</div>'
      + '<div class="mm-idkey" id="mmShare" title="Click to copy">' + D.esc(pid || "(connecting to your node…)") + "</div>"
      + '<button class="mm-abtn" type="button" id="mmCopyKey">Copy my key</button>'
      + (ID && ID.payaddr
        ? '<div class="mm-idcap">Your Minima receiving address (so people can pay you):</div>'
          + '<div class="mm-idkey" id="mmPay" title="Click to copy">' + D.esc(ID.payaddr) + "</div>" : "")
      + '<button class="mm-tbtn" type="button" id="mmBackup">Back up identity + messages</button>'
      + '<button class="mm-tbtn" type="button" id="mmRestore">Restore from a backup</button></div>';
  }

  function settingsBody() {
    var st = STATUS || {}, bf = st.backfill || {};
    var sweep = bf.active ? "Sweeping — block " + groupInt(bf.floor || 0)
      : bf.done ? "Complete — the node serves no further back"
      : "Ready";
    return '<div class="mm-grp">Identity</div>'
      + '<button class="mm-set mm-tap" type="button" id="mmSetName"><span class="mm-m"><span class="mm-tt">Display name</span>'
      + '<span class="mm-dd">Sent with every message, so people see who you are</span></span>'
      + '<span class="mm-vv">' + D.esc((ID && ID.name) || "(not set)") + "</span>" + g.micon("chev") + "</button>"
      + '<button class="mm-set mm-tap" type="button" id="mmGoKey"><span class="mm-m"><span class="mm-tt">Your key &amp; backup</span>'
      + '<span class="mm-dd">QR, export, restore</span></span>' + g.micon("chev") + "</button>"
      + '<div class="mm-grp">History</div>'
      + '<button class="mm-set mm-tap" type="button" id="mmSweep"><span class="mm-m"><span class="mm-tt">Fetch older mail</span>'
      + '<span class="mm-dd">Walk back through the chain for messages that arrived while this app was closed</span></span>'
      + '<span class="mm-vv">' + D.esc(sweep) + "</span>" + g.micon("chev") + "</button>"
      + '<div class="mm-grp">About</div>'
      + '<button class="mm-set mm-tap" type="button" id="mmHelp"><span class="mm-m"><span class="mm-tt">How delivery works</span>'
      + '<span class="mm-dd">Messages travel as coins — next block, ~1–3 min</span></span>' + g.micon("chev") + "</button>"
      + '<div class="mm-set"><span class="mm-m"><span class="mm-tt">Version</span>'
      + '<span class="mm-dd">minimaCore Desktop</span></span><span class="mm-vv" id="mmVer"></span></div>';
  }

  // ---------------------------------------------------------------- thread
  function bubble(m, showFooter, showName) {
    var mine = !m.incoming, inner;
    if (m.type === "image" && m.image) inner = '<img class="mm-img" src="data:image/jpeg;base64,' + D.esc(m.image) + '" alt="Photo">';
    else if (m.type === "payment") {
      inner = '<span class="mm-pay"><span class="mm-phead">' + g.micon("coin")
        + (mine ? "You sent" : D.esc(nameFor(m.frompublickey, m)) + " sent you") + "</span>"
        + '<span class="mm-pamt">' + D.esc(D.TOK.tidyAmount(m.amount || "")) + "&nbsp;&nbsp;" + D.esc(m.tokenname || "MINIMA") + "</span>"
        + (m.message ? '<span class="mm-pmemo">' + D.esc(m.message) + "</span>" : "") + "</span>";
    } else inner = D.esc(m.message || "");
    var html = '<div class="mm-mrow ' + (mine ? "mm-out" : "mm-in") + '"><div class="mm-bub">'
      + (showName && !mine ? '<span class="mm-sname">' + D.esc(nameFor(m.frompublickey, m)) + "</span>" : "")
      + inner + "</div></div>";
    if (!showFooter) return html;
    var foot = '<div class="mm-foot' + (mine ? " mm-out" : "") + '"><span>' + D.esc(clock(m.date)) + "</span>";
    if (mine) {
      var st = m.status || "sent";
      var ic = st === "posting" ? ["ring", "mm-a"] : st === "failed" ? ["close", "mm-r"]
        : st === "confirmed" ? ["check", "mm-g"] : ["chain", "mm-g"];
      var lbl = st === "posting" ? "Posting to chain…" : st === "failed" ? "Failed — retry from Outbox"
        : st === "confirmed" ? "Confirmed" : "On-chain" + (m.sentblock ? " · blk " + groupInt(m.sentblock) : "");
      foot += "<span>·</span>" + g.micon(ic[0], ic[1])
        + '<span class="mm-lbl' + (st === "posting" ? " mm-posting" : st === "failed" ? " mm-failed" : "") + '">' + D.esc(lbl) + "</span>";
    }
    return html + foot + "</div>";
  }
  /** The APK's grouping rule: a footer closes a run when the sender flips, more than five minutes pass, the day
   *  changes, the message is the last one, or it is still posting / has failed (a stuck or failed send must always show its state). */
  function convHtml(msgs) {
    if (!msgs.length) return '<div class="mm-empty">No messages yet — say hi.</div>';
    var html = "", lastDay = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i], next = msgs[i + 1];
      var d = dayStart(m.date);
      if (d !== lastDay) { html += '<div class="mm-day">' + D.esc(dayLabel(m.date)) + "</div>"; lastDay = d; }
      var footer = !next || !!next.incoming !== !!m.incoming || (Number(next.date) - Number(m.date)) > 5 * 60 * 1000
        || dayStart(next.date) !== d || (!m.incoming && (m.status === "posting" || m.status === "failed"));
      var prev = msgs[i - 1];
      var showName = !!m.incoming && (!prev || !prev.incoming || dayStart(prev.date) !== d);
      html += bubble(m, footer, showName);
    }
    return html;
  }

  // ---------------------------------------------------------------- render
  async function render() {
    var host = D.el("mailBody");
    if (!host) return;
    if (!booted) {
      host.innerHTML = '<div class="mailapp"><div class="mm-empty">Starting Minima Mail…</div></div>';
      try { ID = await D.api.mailInit(); } catch (e) {
        host.innerHTML = '<div class="mailapp"><div class="mm-empty">' + D.esc(e.message || String(e)) + "</div></div>";
        return;
      }
      booted = true;
    }
    await loadLists();
    if (VIEW === "thread") return renderThread(host);
    if (VIEW === "compose") return renderCompose(host);
    renderFolder(host);
  }

  function renderFolder(host) {
    var f = VIEW;
    var showFresh = (f === "inbox" || f === "archive");
    host.innerHTML = '<div class="mailapp">' + header() + (showFresh ? freshness() : "")
      + '<div class="mm-body" id="mmBody">' + folderBody(f) + "</div>"
      + (showFresh ? '<button class="mm-fab" type="button" id="mmFab" aria-label="Compose">' + g.micon("pen") + "</button>" : "")
      + "</div>";
    wireShell(host);
    if (f === "key") drawQr();
    if (f === "settings") wireSettings(host);
    host.querySelectorAll("[data-peer]").forEach(function (r) {
      r.onclick = function (e) {
        if (e.target.closest("[data-retry]")) return;
        openThread(r.dataset.peer, r.dataset.subject || "", r.dataset.hashref || "");
      };
      if (r.dataset.hashref) r.oncontextmenu = function (e) { e.preventDefault(); rowMenu(r.dataset.hashref, f === "archive"); };
    });
    host.querySelectorAll("[data-retry]").forEach(function (b) {
      b.onclick = async function (e) {
        e.stopPropagation();
        b.disabled = true;
        try { await D.api.mailRetry(b.dataset.retry, b.dataset.rid); D.toast("Re-posting…", "ok"); }
        catch (err) { D.toast(err.message || String(err), "err"); b.disabled = false; }
        render();
      };
    });
    host.querySelectorAll("[data-contact]").forEach(function (b) {
      b.onclick = function () { openCompose({ to: b.dataset.contact }); };
      b.oncontextmenu = function (e) { e.preventDefault(); contactMenu(b.dataset.contact); };
    });
    var fab = D.el("mmFab"); if (fab) fab.onclick = function () { openCompose(null); };
  }

  function wireShell(host) {
    host.querySelectorAll("#mmTabs button").forEach(function (b) {
      b.onclick = function () { VIEW = b.dataset.f; PEER = null; render(); };
    });
    var t = D.el("mmTheme"); if (t) t.onclick = function () { if (D.cycleTheme) D.cycleTheme(); };
    var mo = D.el("mmMore"); if (mo) mo.onclick = showAbout;
    var ck = D.el("mmCheck");
    if (ck) ck.onclick = async function () {
      ck.disabled = true;
      try { await D.api.mailScan(); } catch (e) {}
      ck.disabled = false; render();
    };
  }

  function wireSettings(host) {
    D.el("mmSetName").onclick = async function () {
      var n = await D.showPrompt("Display name", (ID && ID.name) || "", "Your name",
        { message: "Sent with every message so your contacts see a name instead of a key." });
      if (n == null) return;
      ID = await D.api.mailSetName(String(n).trim());
      D.toast("Name saved ✓", "ok"); render();
    };
    D.el("mmGoKey").onclick = function () { VIEW = "key"; render(); };
    D.el("mmSweep").onclick = async function () {
      try { await D.api.mailBackfill(); D.toast("Fetching older mail…", "ok"); } catch (e) { D.toast(e.message || String(e), "err"); }
      render();
    };
    D.el("mmHelp").onclick = showAbout;
    D.api.appVersion().then(function (v) { var e = D.el("mmVer"); if (e && v) e.textContent = "v" + v; }).catch(function () {});
  }

  function drawQr() {
    try {
      if (typeof g.qrcode === "undefined" || !ID || !ID.publicId) return;
      D.api.mailShare().then(function (share) {
        var box = D.el("mmQr"); if (!box) return;
        var q = g.qrcode(0, "M"); q.addData(share || ID.publicId); q.make();
        box.innerHTML = q.createImgTag(4, 8);
        var sh = D.el("mmShare"), ck = D.el("mmCopyKey");
        if (sh) sh.onclick = function () { D.copy(share); };
        if (ck) ck.onclick = function () { D.copy(share); D.toast("Key copied ✓", "ok"); };
      }).catch(function () {});
      var pay = D.el("mmPay"); if (pay) pay.onclick = function () { D.copy(ID.payaddr); D.toast("Copied ✓", "ok"); };
      D.el("mmBackup").onclick = doBackup;
      D.el("mmRestore").onclick = doRestore;
    } catch (e) {}
  }

  // ---------------------------------------------------------------- thread screen
  function openThread(peer, subject, hashref) {
    PEER = peer; SUBJ = subject || ""; HASH = hashref || ""; VIEW = "thread"; render();
  }
  async function renderThread(host) {
    var msgs = await D.api.mailThreadWith(PEER, SUBJ).catch(function () { return []; });
    var nm = nameFor(PEER, msgs.length ? msgs[msgs.length - 1] : null);
    var title = SUBJ || nm;
    var sub = SUBJ ? nm + " · " + shortKey(PEER) : shortKey(PEER);
    host.innerHTML = '<div class="mailapp">'
      + '<div class="mm-cbar"><button class="mm-ibtn" type="button" id="mmBack" aria-label="Back">' + g.micon("back") + "</button>"
      + avatar(PEER, nm, 34)
      + '<span class="mm-ctitles"><span class="mm-ct">' + D.esc(title) + '</span><span class="mm-cs">' + D.esc(sub) + "</span></span>"
      + '<button class="mm-ibtn" type="button" id="mmThreadMenu" aria-label="Details">' + g.micon("dots") + "</button></div>"
      + '<div class="mm-body" id="mmConv">' + convHtml(msgs) + "</div>"
      + '<div class="mm-comp"><button class="mm-ibtn mm-plus" type="button" id="mmPlus" aria-label="Attach or send funds">' + g.micon("plus") + "</button>"
      + '<input class="mm-reply" id="mmReply" placeholder="Reply" autocomplete="off" />'
      + '<button class="mm-send" type="button" id="mmSend" aria-label="Send">' + g.micon("up") + "</button></div>"
      + '<input type="file" id="mmFile" accept="image/*" hidden /></div>';
    var conv = D.el("mmConv"); if (conv) conv.scrollTop = conv.scrollHeight;
    D.el("mmBack").onclick = function () { VIEW = "inbox"; PEER = null; render(); };
    D.el("mmThreadMenu").onclick = function () { threadMenu(); };
    D.el("mmPlus").onclick = function () { plusMenu(); };
    var inp = D.el("mmReply");
    D.el("mmSend").onclick = function () { sendReply(); };
    inp.onkeydown = function (e) { if (e.key === "Enter") sendReply(); };
    inp.focus();
    D.el("mmFile").onchange = function (e) { if (e.target.files[0]) sendImage(e.target.files[0]); };
  }
  async function sendReply() {
    var inp = D.el("mmReply"); if (!inp) return;
    var body = inp.value.trim(); if (!body) return;
    inp.value = "";
    try { await D.api.mailSend(PEER, { message: body, subject: SUBJ }); }
    catch (e) { D.toast(e.message || String(e), "err"); }
    render();
  }

  // ---------------------------------------------------------------- compose
  function openCompose(pre) { COMPOSE = { to: (pre && pre.to) || "", subject: (pre && pre.subject) || "", body: "" }; VIEW = "compose"; render(); }
  function renderCompose(host) {
    var c = COMPOSE || { to: "", subject: "", body: "" };
    host.innerHTML = '<div class="mailapp">'
      + '<div class="mm-chead"><button class="mm-ibtn" type="button" id="mmCancel" aria-label="Close">' + g.micon("close") + "</button>"
      + '<span class="mm-t">New message</span>'
      + '<button class="mm-sendbtn" type="button" id="mmDoSend">' + g.micon("send") + "Send</button></div>"
      + '<div class="mm-f"><span class="mm-lab">To</span>'
      + '<input class="mm-monoin" id="mmTo" placeholder="0x… Mail key" autocomplete="off" spellcheck="false" value="' + D.esc(c.to) + '" />'
      + '<span class="mm-chips"><button class="mm-outchip" type="button" id="mmScan">' + g.micon("scan") + "Scan</button>"
      + '<button class="mm-outchip" type="button" id="mmPick" aria-label="Pick a contact">' + g.micon("contacts") + "</button></span></div>"
      + '<div class="mm-f"><span class="mm-lab">Subject</span>'
      + '<input id="mmSubj" placeholder="(optional — subjects make their own thread)" autocomplete="off" value="' + D.esc(c.subject) + '" /></div>'
      + '<textarea class="mm-cbody" id="mmBodyIn" placeholder="Write your message…">' + D.esc(c.body) + "</textarea>"
      + '<div class="mm-attach"><button class="mm-chip" type="button" id="mmPhoto">' + g.micon("photo") + "Photo</button>"
      + '<button class="mm-chip" type="button" id="mmFunds">' + g.micon("coin") + "Send funds</button></div>"
      + '<div class="mm-hint">' + g.micon("chain")
      + "<span>Delivered with the next block — usually 1–3 minutes. Your message waits in the Outbox until it's on-chain.</span></div>"
      + '<input type="file" id="mmFile" accept="image/*" hidden /></div>';
    var keep = function () { COMPOSE = { to: D.el("mmTo").value, subject: D.el("mmSubj").value, body: D.el("mmBodyIn").value }; };
    ["mmTo", "mmSubj", "mmBodyIn"].forEach(function (id) { D.el(id).oninput = keep; });
    D.el("mmCancel").onclick = function () { COMPOSE = null; VIEW = "inbox"; render(); };
    D.el("mmPick").onclick = function () {
      if (!CONTACTS.length) { D.toast("No contacts yet — paste a Mail key instead.", ""); return; }
      D.showActionSheet("Send to", CONTACTS.map(function (ct) {
        return { label: ct.username || shortKey(ct.publicId), onclick: function () { D.el("mmTo").value = ct.publicId; keep(); } };
      }));
    };
    D.el("mmScan").onclick = async function () {
      var v = await D.scanQR("Scan a Mail key").catch(function () { return null; });
      if (v) { D.el("mmTo").value = String(v).split("|")[0].trim(); keep(); }
    };
    D.el("mmPhoto").onclick = function () { D.el("mmFile").click(); };
    D.el("mmFile").onchange = function (e) { if (e.target.files[0]) composeImage(e.target.files[0]); };
    D.el("mmFunds").onclick = function () {
      var to = D.el("mmTo").value.trim();
      if (!to) { D.toast("Add a recipient first.", "err"); return; }
      sendFunds(to);
    };
    D.el("mmDoSend").onclick = doSend;
  }
  async function doSend() {
    var to = D.el("mmTo").value.trim().split("|")[0];
    var subject = D.el("mmSubj").value.trim();
    var body = D.el("mmBodyIn").value.trim();
    if (!/^0x[0-9A-Fa-f]{130}$/.test(to)) { D.toast("That doesn't look like a valid Mail key.", "err"); return; }
    if (!body) { D.toast("Write a message first.", "err"); return; }
    var btn = D.el("mmDoSend"); btn.disabled = true;
    try {
      await D.api.mailSend(to, { message: body, subject: subject });
      COMPOSE = null;
      openThread(to, subject, "");
    } catch (e) { D.toast(e.message || String(e), "err"); btn.disabled = false; }
  }

  // ---------------------------------------------------------------- attachments + funds
  /** Shrink to a JPEG small enough to fit one coin's sealed blob (main caps at 49 000 bytes). */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 720, w = img.width, h = img.height;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h > max) { w = Math.round(w * max / h); h = max; }
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        for (var q = 0.72; q >= 0.3; q -= 0.12) {
          var b64 = cv.toDataURL("image/jpeg", q).split(",")[1];
          if (b64.length < 44000) return resolve(b64);
        }
        reject(new Error("That photo is too large to send on-chain — try a smaller one."));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
      img.src = url;
    });
  }
  async function sendImage(file) {
    try {
      var b64 = await compressImage(file);
      await D.api.mailSend(PEER, { message: "", subject: SUBJ, type: "image", image: b64 });
    } catch (e) { D.toast(e.message || String(e), "err"); }
    render();
  }
  async function composeImage(file) {
    var to = D.el("mmTo").value.trim().split("|")[0];
    if (!/^0x[0-9A-Fa-f]{130}$/.test(to)) { D.toast("Add a valid recipient first.", "err"); return; }
    var subject = D.el("mmSubj").value.trim();
    try {
      var b64 = await compressImage(file);
      await D.api.mailSend(to, { message: "", subject: subject, type: "image", image: b64 });
      COMPOSE = null; openThread(to, subject, "");
    } catch (e) { D.toast(e.message || String(e), "err"); }
  }
  function plusMenu() {
    D.showActionSheet("Attach", [
      { label: "Photo", onclick: function () { D.el("mmFile").click(); } },
      { label: "Send funds", onclick: function () { sendFunds(PEER); } }
    ]);
  }
  /** The payment sheet. The address is the peer's own, learned from their signed messages (never typed by us
   *  unless they've never written), and main re-validates it with `checkaddress` before any coin moves. */
  async function sendFunds(peer) {
    var addr = await D.api.mailResolvePayaddr(peer).catch(function () { return ""; });
    if (!addr) { try { await D.api.mailRequestPayaddr(peer); } catch (e) {} }
    var amount = await D.showPrompt("Send funds", "", "0.0",
      { message: "To " + nameFor(peer, null) + (addr ? "\n" + addr : "\nNo address known yet — asking them for it now.") });
    if (amount == null) return;
    if (!addr) { D.toast("No receiving address for them yet — try again once they reply.", "err"); return; }
    if (!/^[0-9]*\.?[0-9]+$/.test(amount) || parseFloat(amount) <= 0) { D.toast("Enter a valid amount.", "err"); return; }
    var memo = await D.showPrompt("Note (optional)", "", "What's it for?");
    if (memo == null) memo = "";
    var ok = await D.showConfirm("Send " + amount + " MINIMA?",
      "To " + nameFor(peer, null) + "\n" + addr + "\n\nThis sends real funds and cannot be undone.", "Send", true);
    if (!ok) return;
    try {
      await D.api.mailPay(peer, addr, amount, "0x00", "MINIMA", memo);
      D.toast("Payment sent ✓", "ok");
    } catch (e) {
      // An RPC timeout is AMBIGUOUS — the coin may well have gone out. Never invite a retry that double-spends.
      var msg = e.message || String(e);
      if (/may have been submitted/i.test(msg)) D.toast("The node didn't answer in time — check your balance before resending.", "err");
      else D.toast(msg, "err");
    }
    render();
  }

  // ---------------------------------------------------------------- menus, backup, about
  function rowMenu(hashref, archived) {
    D.showActionSheet("Thread", [
      { label: archived ? "Unarchive" : "Archive", onclick: async function () { await D.api.mailSetArchived(hashref, !archived); render(); } },
      { label: "Delete", danger: true, onclick: async function () {
        if (!await D.showConfirm("Delete this thread?", "Every message in it is removed from this computer. It cannot be undone.", "Delete", true)) return;
        await D.api.mailDeleteThread(hashref); render();
      } }
    ]);
  }
  function threadMenu() {
    var known = CONTACTS.some(function (c) { return c.publicId === PEER; });
    D.showActionSheet(nameFor(PEER, null), [
      { label: known ? "Rename contact" : "Add to contacts", onclick: async function () {
        var n = await D.showPrompt(known ? "Rename contact" : "Add to contacts", "", "Name");
        if (n == null) return;
        if (known) await D.api.mailRenameContact(PEER, String(n).trim());
        else await D.api.mailAddContact(PEER, String(n).trim());
        render();
      } },
      { label: "Copy their Mail key", onclick: function () { D.copy(PEER); D.toast("Copied ✓", "ok"); } },
      { label: "Delete thread", danger: true, onclick: async function () {
        if (!await D.showConfirm("Delete this thread?", "Every message in it is removed from this computer.", "Delete", true)) return;
        if (HASH) await D.api.mailDeleteThread(HASH);
        VIEW = "inbox"; PEER = null; render();
      } }
    ]);
  }
  function contactMenu(peer) {
    D.showActionSheet(nameFor(peer, null), [
      { label: "Send a message", onclick: function () { openCompose({ to: peer }); } },
      { label: "Rename", onclick: async function () {
        var n = await D.showPrompt("Rename contact", "", "Name"); if (n == null) return;
        await D.api.mailRenameContact(peer, String(n).trim()); render();
      } },
      { label: "Copy Mail key", onclick: function () { D.copy(peer); D.toast("Copied ✓", "ok"); } },
      { label: "Remove", danger: true, onclick: async function () {
        if (!await D.showConfirm("Remove this contact?", "Their messages stay; only the saved name goes.", "Remove", true)) return;
        await D.api.mailRemoveContact(peer); render();
      } }
    ]);
  }
  async function doBackup() {
    var pass = await D.showPrompt("Back up identity", "", "Passphrase (min 8 characters)",
      { password: true, ok: "Back up", message: "The file holds your private key, so it is encrypted with this passphrase — you need it to restore." });
    if (pass == null) return;
    if (pass.length < 8) { D.toast("Use a passphrase of at least 8 characters.", "err"); return; }
    if (!/^[\x20-\x7e]+$/.test(pass)) { D.toast("Use plain ASCII — the phone app cannot read other characters.", "err"); return; }
    try { var p = await D.api.mailExportBackup(pass); D.toast(p ? "Backed up → " + p : "Cancelled", p ? "ok" : ""); }
    catch (e) { D.toast(e.message || String(e), "err"); }
  }
  async function doRestore() {
    var pass = await D.showPrompt("Restore from a backup", "", "Backup passphrase",
      { password: true, ok: "Restore", message: "This replaces the identity, contacts and messages on this computer." });
    if (pass == null) return;
    try { await D.api.mailImportBackup(pass); D.toast("Restored ✓", "ok"); booted = false; render(); }
    catch (e) { D.toast(e.message || String(e), "err"); }
  }
  function showAbout() {
    D.showConfirm("How delivery works",
      "Every message is a tiny coin (0.000000001 MINIMA) sent to one shared address, carrying a sealed blob only "
      + "the recipient can open. It is delivered with the next block — usually 1 to 3 minutes — and waits in your "
      + "Outbox until it is on-chain.\n\nYour identity comes from this node's seed. There is no server and no "
      + "Maxima involved.\n\nThis does NOT interoperate with the web ChainMail MiniDapp — it is its own on-chain "
      + "network, shared with the Minima Mail phone app.", "Close");
  }

  // ---------------------------------------------------------------- live updates
  var pending = null;
  function onUpdate() {
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (!booted) return;
      // Never rebuild the compose form under someone's hands — their draft would go with it.
      if (VIEW === "compose") { loadLists(); return; }
      render();
    }, 350);
  }
  async function badge() {
    try { var th = await D.api.mailThreads(); var n = 0; for (var i = 0; i < th.length; i++) n += Number(th[i].unread || 0); return n; }
    catch (e) { return 0; }
  }

  g.MailPanel = { init: init, render: render, reset: reset, onUpdate: onUpdate, badge: badge };
})(window);
