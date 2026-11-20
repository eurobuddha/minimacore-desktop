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
  let threadOrigin = "inbox";
  var VERSION = "";             // the app's version, for the side menu's last line
  var MODAL = 0;                // open Mail dialogs: nothing is redrawn under them (the phone's modalOpen)
  var PAYFILL = null;           // an open Send funds sheet waiting for the peer's address
  const peerWords = new Map();
  var COMPOSE = null;           // { to, subject, body } kept across a re-render so typing is never lost
  var booted = false;

  var FOLDERS = [["inbox", "Inbox", "inbox"], ["outbox", "Outbox", "outbox"], ["sent", "Sent", "send"], ["archive", "Archive", "archive"],
    ["contacts", "Contacts", "contacts"], ["key", "Your key", "key"], ["settings", "Settings", "settings"]];

  function init(deps) { D = deps; }
  /**
   * What to actually show someone when a send fails. Electron wraps anything thrown in main as
   * "Error invoking remote method 'mcd:mailRetry': Error: …", which is noise; and the node's own funding
   * refusal is true but unhelpful, because the wallet is not empty — the coin it wanted was simply too young
   * to spend. Strip the wrapper, then translate the one message people will actually hit.
   */
  function errText(e) {
    var m = String((e && e.message) || e || "").replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
    if (/No Coins of tokenid/i.test(m)) return "Your node had no coin old enough to spend just then — it needs a few blocks. Try again in a minute.";
    if (/Insufficient funds/i.test(m)) return "Not enough MINIMA in this node's wallet to send.";
    if (/may have been submitted/i.test(m)) return "The node didn't answer in time — check before sending again.";
    return m;
  }
  function reset() { MODAL = 0; PAYFILL = null; threadOrigin = "inbox"; peerWords.clear(); ID = null; CONTACTS = []; STATUS = null; VIEW = "inbox"; PEER = null; SUBJ = ""; HASH = ""; COMPOSE = null; booted = false; }

  // ---------------------------------------------------------------- identity, names, avatars
  /** A peer's key for display: the WHOLE key (RULE 1). It was 0x + 8…6; .mm-key wraps it. */
  function shortKey(id) {
    var s = String(id || "");
    return s;   // RULE 1: the whole key (it used to be 0x + 8…6); the name was kept so call sites stay put
  }
  /**
   * Who wrote this. Prefer a saved name, then the sender’s declared name, then the six-word address
   * — the same chain main/mail.js already uses for OS notifications. The old panel resolved from an id alone,
   * so it could never see `fromname` and every unsaved peer showed as hex.
   */
  function nameFor(id, msg) {
    if (!id) return "(unknown)";
    if (ID && id === ID.publicId) return "You";
    for (var i = 0; i < CONTACTS.length; i++) if (CONTACTS[i].publicId === id) {
      if (typeof CONTACTS[i].username === "string" && CONTACTS[i].username.trim() && CONTACTS[i].username.toLowerCase() !== id.toLowerCase()) return CONTACTS[i].username;
      break;
    }
    if (msg) {
      // fromname travels on every message, but only the SENDER's own messages declare their name.
      var theirs = msg.incoming ? msg.fromname : null;
      if (typeof theirs === "string" && theirs.trim() && theirs.toLowerCase() !== id.toLowerCase()) return theirs;
    }
    return peerWords.get(id) || shortKey(id);
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
  function ago(n, unit) { return n + " " + unit + (n === 1 ? "" : "s") + " ago"; }
  /** The phone's Language.since: now · 33 minutes ago · 5 hours ago · 3 days ago */
  function since(ms) {
    var diff = Date.now() - Number(ms);
    if (diff < 60000) return "now";
    if (diff < 3600000) return ago(Math.floor(diff / 60000), "minute");
    if (diff < 86400000) return ago(Math.floor(diff / 3600000), "hour");
    return ago(Math.floor(diff / 86400000), "day");
  }
  /** MainActivity.rel(): under an hour "33 minutes ago", then today's clock time, "3 days ago" for a week, then "7 Mar". */
  function rel(ms) {
    var t = Number(ms) || 0; if (t <= 0) return "";
    var age = Date.now() - t, d = new Date(t);
    if (age < 3600000) return since(t);
    if (age < 86400000) return clock(t);
    if (age < 7 * 86400000) return since(t);
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
  /** Folder header, as the phone: the menu button and the folder's name. The folders are in the side menu, not a strip of tabs. */
  function header() {
    var title = "";
    FOLDERS.forEach(function (f) { if (f[0] === VIEW) title = f[1]; });
    return '<div class="mm-head"><button class="mm-ibtn" type="button" id="mmMenu" aria-label="Open menu" aria-haspopup="true" aria-expanded="false">' + g.micon("menu") + "</button>"
      + '<h2 class="mm-title">' + D.esc(title) + "</h2></div>";
  }
  function drawer() {
    var items = FOLDERS.map(function (f, i) {
      var n = f[0] === "inbox" ? unreadCount() : f[0] === "outbox" ? OUT.length : 0, sel = VIEW === f[0];
      return (i === 4 ? '<div class="mm-navsep"></div>' : "")
        + '<button type="button" class="mm-nav' + (sel ? " mm-sel" : "") + '" data-f="' + f[0] + '"' + (sel ? ' aria-current="page"' : "") + ">"
        + g.micon(f[2]) + '<span class="mm-grow">' + D.esc(f[1]) + "</span>" + (n ? '<span class="mm-cnt">' + n + "</span>" : "") + "</button>";
    }).join("");
    return '<div class="mm-scrim" id="mmScrim" hidden></div>'
      + '<nav class="mm-drawer" id="mmDrawer" aria-label="Mail folders" hidden>'
      + '<div class="mm-dhead"><div class="mm-brand">MINIMA <i>MAIL</i></div>'
      + '<div class="mm-self">' + D.esc(ID && ID.words ? "you · " + ID.words : "Connecting to your node…") + "</div></div>"
      + items + '<div class="mm-grow"></div><div class="mm-dver">Minima Mail' + (VERSION ? " v" + D.esc(VERSION) : "") + "</div></nav>";
  }
  function setDrawer(open) {
    var d = D.el("mmDrawer"), s = D.el("mmScrim"), b = D.el("mmMenu");
    if (!d || !s) return;
    d.hidden = s.hidden = !open;
    if (b && b.setAttribute) b.setAttribute("aria-expanded", String(open));
    if (open) { var first = d.querySelector && (d.querySelector(".mm-sel") || d.querySelector(".mm-nav")); if (first) first.focus(); }
    else if (b && b.focus && document.activeElement && d.contains && d.contains(document.activeElement)) b.focus();
  }
  /** The freshness line — the panel's one honest statement about how much of the chain it has actually read. */
  function freshness() {
    var st = STATUS || {};
    var bf = st.backfill || {};
    var cls = "mm-fresh", text, act = "Check now";
    if (!st.scannedTip) { cls += " mm-cold"; text = "Connecting to your node…"; }
    else if (bf.active) {
      cls += " mm-busy";
      text = "Catching up — block " + groupInt(bf.floor || 0) + " of " + groupInt(st.scannedTip);
    } else {
      text = "Checked block " + st.scannedTip + " · " + (st.lastScanMs ? since(st.lastScanMs) : "now");   // the phone prints the block plainly
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
    return '<button class="mm-row' + (unread ? " mm-unread" : "") + '" type="button" data-peer="' + D.esc(peer)
      + '" data-subject="' + D.esc(m.subject || "") + '" data-hashref="' + D.esc(t.hashref || "") + '" data-message="' + D.esc(m.randomid || "") + '">'
      + avatar(peer, nm, 44)
      + '<span class="mm-mid mm-inbox-preview">'
      + (subject ? '<span class="mm-subj">' + D.esc(subject) + '</span>' : '')
      + '<span class="mm-snip">' + D.esc((m.incoming ? "" : "You: ") + previewText(m)) + '</span>'
      + '<span class="mm-l1"><span class="mm-nm">' + D.esc(nm) + '</span>'
      + '<span class="mm-time">' + D.esc(rel(m.date)) + '</span></span></span>'
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
    return '<div class="mm-srow" data-peer="' + D.esc(m.topublickey) + '" data-message="' + D.esc(m.randomid) + '" data-message-thread="' + D.esc(m.hashref) + '" data-subject="' + D.esc(m.subject || "") + '">'
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
    peerWords.clear();
    for (const t of THREADS.concat(ARCHIVED)) if (t.words) peerWords.set(t.other, t.words);
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
      var add = '<button class="mm-tbtn" id="mmAddContact" type="button">Add contact</button>';
      if (!CONTACTS.length) return add + '<div class="mm-empty">No contacts yet.</div>';
      return add + '<div class="mm-list">'  + CONTACTS.map(function (c) {
        var nm = c.username || c.words || shortKey(c.publicId);
        return '<button class="mm-row" type="button" data-contact="' + D.esc(c.publicId) + '" style="border-bottom:0">'
          + avatar(c.publicId, nm, 44)
          + '<span class="mm-mid"><span class="mm-nm" style="color:var(--mm-text);font-weight:700;font-size:15px">' + D.esc(nm) + "</span>"
          + '<span class="mm-contact-address mm-key" title="Copy address words">' + D.esc(c.words || c.publicId) + "</span></span></button>";
      }).join("") + "</div>";
    }
    if (f === "key") return identityBody();
    return settingsBody();
  }

  function identityBody() {
    var pid = (ID && ID.publicId) || "";
    return '<div class="mm-id">' + avatar(pid, ID && ID.name, 72)
      + (ID && ID.words ? '<div class="mm-idkey">' + D.esc(ID.words) + '</div>'
        + '<button class="mm-abtn" id="mmPublish" type="button">' + (ID.published ? "Stop publishing address" : "Publish my address") + '</button>'
        + '<div class="mm-idcap" role="status" id="mmBeaconStatus">Checking beacon…</div>'
        + '<button class="mm-tbtn" id="mmWords" type="button">Copy address words</button>'
        + '<button class="mm-tbtn" id="mmLink" type="button">Copy contact link</button>' : '')
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
    var dark = ID && ID.theme === "dark";
    return '<div class="mm-grp">Appearance</div>'
      + '<div class="mm-set"><span class="mm-m"><span class="mm-tt">Theme</span><span class="mm-dd">Paper by day, dark by night — your call</span></span>'
      + '<span class="mm-seg" role="group" aria-label="Theme"><button type="button" data-theme="light" aria-pressed="' + !dark + '">Paper</button>'
      + '<button type="button" data-theme="dark" aria-pressed="' + !!dark + '">Dark</button></span></div>'
      + '<div class="mm-grp">Identity</div>'
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
      host.innerHTML = shellOpen() + '<div class="mm-empty">Connecting to your node…</div></div>';
      try { ID = await D.api.mailInit(); } catch (e) {
        host.innerHTML = shellOpen() + '<div class="mm-empty">' + D.esc(errText(e)) + "</div></div>";
        return;
      }
      booted = true;
      D.api.appVersion().then(function (v) { VERSION = v || ""; }).catch(function () {});
    }
    await loadLists();
    if (VIEW === "thread") return renderThread(host);
    if (VIEW === "compose") return renderCompose(host);
    renderFolder(host);
  }

  /** Mail's own Paper / Dark (Settings, Appearance): it does not follow the shell's theme, as on the phone. */
  function shellOpen() { return '<div class="mailapp"' + (ID && ID.theme === "dark" ? ' data-mm-theme="dark"' : "") + ">"; }
  function renderFolder(host) {
    var f = VIEW;
    var showFresh = f === "inbox";   // the phone: the freshness line and the compose button are the Inbox's
    host.innerHTML = shellOpen() + header() + (showFresh ? freshness() : "")
      + '<div class="mm-body" id="mmBody">' + folderBody(f) + "</div>"
      + (showFresh ? '<button class="mm-fab" type="button" id="mmFab" aria-label="New message">' + g.micon("pen") + "</button>" : "")
      + drawer() + "</div>";
    wireShell(host);
    if (f === "key") drawQr();
    var add = D.el("mmAddContact");
    if (add) add.onclick = async function () {
      var value = await enterAddress();
      if (!value) return;
      var name = await D.showPrompt("Contact name", "", "Name");
      if (!name) return;
      try { await D.api.mailAddContact(value, name.trim()); render(); } catch (e) { D.toast(errText(e), "err"); }
    };
    if (f === "settings") wireSettings(host);
    host.querySelectorAll("[data-peer]").forEach(function (r) {
      r.onclick = async function (e) {
        if (e.target.closest("[data-retry]")) return;
        return openThread(r.dataset.peer, r.dataset.subject || "", r.dataset.messageThread || r.dataset.hashref || "", f);
      };
      if (r.dataset.hashref) r.oncontextmenu = function (e) { e.preventDefault(); rowMenu(r.dataset.hashref, f === "archive"); };
    });
    host.querySelectorAll("[data-retry]").forEach(function (b) {
      b.onclick = async function (e) {
        e.stopPropagation();
        b.disabled = true;
        try { await D.api.mailRetry(b.dataset.retry, b.dataset.rid); D.toast("Re-posting…", "ok"); }
        catch (err) { D.toast(errText(err), "err"); b.disabled = false; }
        render();
      };
    });
    host.querySelectorAll("[data-contact]").forEach(function (b) {
      b.onclick = function (event) {
        const address = event.target.closest(".mm-contact-address");
        if (address) { D.copy(address.textContent); D.toast("Address copied.", "ok"); return; }
        openCompose({ to: b.dataset.contact });
      };
      b.oncontextmenu = function (e) { e.preventDefault(); contactMenu(b.dataset.contact); };
    });
    var fab = D.el("mmFab"); if (fab) fab.onclick = function () { openCompose(null); };
  }

  // Desktop counterpart of Android AddressWordEntry. Exact words win over unique prefixes.
  function addressBoxes(grid, dictionary, changed, useRaw) {
    const boxes = [], choices = document.createElement("datalist");
    choices.id = grid.id ? grid.id + "Options" : "mmAddressOptions"; grid.append(choices);
    for (const word of dictionary) { const option = document.createElement("option"); option.value = word; choices.append(option); }
    function complete(value) {
      const word = value.trim().toLowerCase();
      if (!word || dictionary.includes(word)) return word;
      const matches = dictionary.filter(item => item.startsWith(word));
      return matches.length === 1 ? matches[0] : "";
    }
    for (let i = 0; i < 6; i++) {
      const box = document.createElement("input");
      box.className = "field__input"; box.setAttribute("list", choices.id); box.autocomplete = "off";
      box.setAttribute("aria-label", "Address word " + (i + 1)); box.placeholder = String(i + 1);
      box.spellcheck = false;
      function advance() { if (boxes[i + 1]) boxes[i + 1].focus(); }
      box.oninput = event => {
        const prefix = box.value.toLowerCase();
        if (!event.isComposing && !String(event.inputType).startsWith("delete") && prefix &&
            (prefix.length >= 4 || dictionary.includes(prefix))) {
          const matches = dictionary.filter(w => w.startsWith(prefix));
          if (matches.length === 1) { box.value = matches[0]; advance(); changed(true); return; }
        }
        changed();
      };
      box.onkeydown = event => {
        if ((event.key === " " || event.key === "Enter") && dictionary.includes(box.value.toLowerCase())) {
          event.preventDefault(); advance(); changed(true);
        }
      };
      box.onpaste = event => {
        const text = event.clipboardData.getData("text").trim();
        if (text.includes("://") || text.includes("|") || /^(?:0x)?[0-9a-f]{128}$/i.test(text)) {
          event.preventDefault(); useRaw(text); return;
        }
        const parts = text.split(/[\s-]+/);
        if (parts.length < 2) return;
        event.preventDefault();
        const start = parts.length === 6 ? 0 : i;
        if (start + parts.length > 6) { box.value = ""; changed(); box.setCustomValidity("Enter six address words."); box.reportValidity(); box.setCustomValidity(""); return; }
        parts.forEach((w, n) => { boxes[start + n].value = complete(w) || w; });
        boxes[Math.min(5, start + parts.length)].focus(); changed(true);
      };
      grid.append(box); boxes.push(box);
    }
    return { boxes, complete };
  }

  async function enterAddress() {
    const dictionary = await D.api.mailAddressWords();
    const overlay = document.createElement("div");
    overlay.className = "overlay mail-address-entry";
    overlay.innerHTML = '<form class="modal"><div class="modal__title">Mail address</div>'
      + '<textarea class="field__input" rows="2" aria-label="Contact link or Mail key" placeholder="Paste a contact link or Mail key"></textarea>'
      + '<fieldset><legend>Or enter six address words</legend><div class="mm-word-grid"></div></fieldset>'
      + '<div role="status"></div><div class="seg"><button type="button" class="btn btn--outline">Cancel</button>'
      + '<button type="submit" class="btn btn--primary">Use address</button></div></form>';
    const form = overlay.querySelector("form"), raw = form.querySelector("textarea");
    const grid = form.querySelector(".mm-word-grid"), status = form.querySelector('[role="status"]');
    const { boxes, complete } = addressBoxes(grid, dictionary,
      () => { raw.value = ""; status.textContent = ""; },
      text => { raw.value = text; boxes.forEach(box => { box.value = ""; }); raw.focus(); });
    raw.oninput = () => { if (raw.value) boxes.forEach(box => { box.value = ""; }); };
    const previous = document.activeElement;
    D.el("view-mail").append(overlay); raw.focus();
    return new Promise(resolve => {
      const done = value => { overlay.remove(); if (previous?.isConnected) previous.focus(); resolve(value); };
      form.onsubmit = event => {
        event.preventDefault();
        if (raw.value.trim()) { done(raw.value.trim()); return; }
        const values = boxes.map(box => complete(box.value)), bad = values.findIndex(w => !dictionary.includes(w));
        if (bad >= 0) { status.textContent = "Check word " + (bad + 1); boxes[bad].focus(); return; }
        done(values.join("-"));
      };
      form.querySelector('button[type="button"]').onclick = () => done(null);
      overlay.onkeydown = e => { if (e.key === "Escape") done(null); };
    });
  }
  function wireShell(host) {
    var menu = D.el("mmMenu"); if (menu) menu.onclick = function () { setDrawer(true); };
    var scrim = D.el("mmScrim"); if (scrim) scrim.onclick = function () { setDrawer(false); };
    var dr = D.el("mmDrawer"); if (dr) dr.onkeydown = function (e) { if (e.key === "Escape") { e.stopPropagation(); setDrawer(false); } };
    host.querySelectorAll(".mm-nav").forEach(function (b) {
      b.onclick = function () { VIEW = b.dataset.f; PEER = null; render(); };
    });
    var ck = D.el("mmCheck");
    if (ck) ck.onclick = async function () {
      ck.disabled = true;
      try { await D.api.mailScan(); } catch (e) {}
      ck.disabled = false; render();
    };
  }

  function wireSettings(host) {
    host.querySelectorAll("[data-theme]").forEach(function (b) {
      b.onclick = async function () {
        if ((ID.theme === "dark") === (b.dataset.theme === "dark")) return;
        try { ID = await D.api.mailSetTheme(b.dataset.theme); } catch (e) { D.toast(errText(e), "err"); }
        render();
      };
    });
    D.el("mmSetName").onclick = async function () {
      var n = await D.showPrompt("Display name", (ID && ID.name) || "", "Your name",
        { message: "Sent with every message so your contacts see a name instead of a key." });
      if (n == null) return;
      ID = await D.api.mailSetName(String(n).trim());
      D.toast("Name saved ✓", "ok"); render();
    };
    D.el("mmGoKey").onclick = function () { VIEW = "key"; render(); };
    D.el("mmSweep").onclick = async function () {
      try { await D.api.mailBackfill(); D.toast("Fetching older mail…", "ok"); } catch (e) { D.toast(errText(e), "err"); }
      render();
    };
    D.el("mmHelp").onclick = showAbout;
    D.api.appVersion().then(function (v) { var e = D.el("mmVer"); if (e && v) e.textContent = "v" + v; }).catch(function () {});
  }

  async function toggleAddress(key, enabled) {
    if (enabled && !await D.showConfirm("Keep this address discoverable?",
        "Your node publishes a signed public card and renews it when needed. Each post spends one nano-Minima and a signing operation.", "Enable")) return;
    try { ID = await D.api.mailPublishAddress(key, enabled); render(); }
    catch (e) { D.toast(errText(e), "err"); }
  }
  function drawQr() {
    if (ID && ID.words) {
      D.el("mmWords").onclick = () => D.copy(ID.words);
      D.el("mmLink").onclick = () => D.copy(ID.link);
      const indicator = D.el("mmBeaconStatus");
      async function check() {
        if (!indicator?.isConnected || VIEW !== "key") return;
        try {
          const proof = await D.api.mailCheckOwnBeacon();
          indicator.textContent = proof ? (proof.block ? "Beacon live · block " + proof.block : "Beacon live on this node")
            : (ID.published ? "Beacon not yet visible on this node" : "Publication off · no visible beacon");
        } catch (e) { indicator.textContent = "Could not verify beacon: " + errText(e); }
        if (indicator.isConnected && VIEW === "key") setTimeout(check, 15000);
      }
      check();
      D.el("mmPublish").onclick = () => toggleAddress(ID.publicId, !ID.published);
    }
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
  function openThread(peer, subject, hashref, origin) {
    PEER = peer; SUBJ = subject || ""; HASH = hashref || ""; threadOrigin = origin || "inbox"; VIEW = "thread";
    return render();
  }
  async function renderThread(host) {
    const peer = PEER, hash = HASH, subject = SUBJ;
    var msgs = await (hash ? D.api.mailThread(hash) : D.api.mailThreadWith(peer, subject)).catch(function () { return []; });
    if (VIEW !== "thread" || PEER !== peer || HASH !== hash || SUBJ !== subject) return;
    const current = D.el("mmReply");
    const draft = current && current.dataset && current.dataset.peer === peer && current.dataset.subject === subject ? current.value : "";
    var nm = nameFor(PEER, msgs.length ? msgs[msgs.length - 1] : null);
    var title = SUBJ || nm;
    const address = peerWords.get(PEER) || PEER;
    var sub = SUBJ && nm !== address ? nm + " · " + address : address;
    if (!SUBJ && nm === address) title = "Conversation";
    host.innerHTML = shellOpen()
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
    D.el("mmBack").onclick = function () { VIEW = threadOrigin; PEER = null; render(); };
    D.el("mmThreadMenu").onclick = function () { threadMenu(); };
    D.el("mmPlus").onclick = function () { plusMenu(); };
    var inp = D.el("mmReply");
    D.el("mmSend").onclick = function () { sendReply(); };
    inp.onkeydown = function (e) { if (e.key === "Enter") sendReply(); };
    inp.dataset.peer = peer; inp.dataset.subject = subject; inp.value = draft;
    inp.focus();
    D.el("mmFile").onchange = function (e) { if (e.target.files[0]) sendImage(e.target.files[0]); };
  }
  async function sendReply() {
    var inp = D.el("mmReply"); if (!inp) return;
    var body = inp.value.trim(); if (!body) return;
    inp.value = "";
    try { await D.api.mailSend(PEER, { message: body, subject: SUBJ }); }
    catch (e) { D.toast(errText(e), "err"); }
    render();
  }

  // ---------------------------------------------------------------- compose
  function openCompose(pre) { COMPOSE = { to: (pre && pre.to) || "", subject: (pre && pre.subject) || "", body: "" }; VIEW = "compose"; render(); }
  async function renderCompose(host) {
    var c = COMPOSE || { to: "", subject: "", body: "" };
    let dictionary;
    try { dictionary = await D.api.mailAddressWords(); }
    catch (error) { dictionary = []; D.toast(errText(error), "err"); }
    if (VIEW !== "compose" || COMPOSE !== c) return;
    host.innerHTML = shellOpen()
      + '<div class="mm-chead"><button class="mm-ibtn" type="button" id="mmCancel" aria-label="Close">' + g.micon("close") + "</button>"
      + '<span class="mm-t">New message</span>'
      + '<button class="mm-sendbtn" type="button" id="mmDoSend">' + g.micon("send") + "Send</button></div>"
      + '<div class="mm-f"><span class="mm-lab">To</span>'
      + '<button id="mmCompactTo" type="button" hidden></button>'
      + '<div class="mm-word-grid" id="mmToWords"></div>'
      + '<textarea rows="1" class="mm-monoin" id="mmTo" placeholder="Six words, contact link or Mail key" autocomplete="off" spellcheck="false">' + D.esc(c.to) + '</textarea>'
      + '<span class="mm-chips"><button class="mm-outchip" type="button" id="mmEnterWords">Enter words</button><button class="mm-outchip" type="button" id="mmScan">' + g.micon("scan") + "Scan</button>"
      + '<button class="mm-outchip" type="button" id="mmPick" aria-label="Pick a contact">' + g.micon("contacts") + "</button></span></div>"
      + '<div class="mm-recipient-state"><span id="mmLookup" role="status"></span> <button hidden id="mmRetryLookup" type="button">Retry lookup</button></div>'
      + '<div class="mm-f"><span class="mm-lab">Subject</span>'
      + '<input id="mmSubj" placeholder="(optional — subjects make their own thread)" autocomplete="off" value="' + D.esc(c.subject) + '" /></div>'
      + '<textarea class="mm-cbody" id="mmBodyIn" placeholder="Write your message…">' + D.esc(c.body) + "</textarea>"
      + '<div class="mm-attach"><button class="mm-chip" type="button" id="mmPhoto">' + g.micon("photo") + "Photo</button>"
      + '<button class="mm-chip" type="button" id="mmFunds">' + g.micon("coin") + "Send funds</button></div>"
      + '<div class="mm-hint">' + g.micon("chain")
      + "<span>Delivered with the next block — usually 1–3 minutes. Your message waits in the Outbox until it's on-chain.</span></div>"
      + '<input type="file" id="mmFile" accept="image/*" hidden /></div>';
    const raw = D.el("mmTo"), grid = D.el("mmToWords"), toggle = D.el("mmEnterWords");
    const status = D.el("mmLookup"), retry = D.el("mmRetryLookup");
    const compact = D.el("mmCompactTo"), chips = toggle.parentElement;
    const actions = ["mmDoSend", "mmPhoto", "mmFunds"].map(id => D.el(id));
    let revision = 0, resolved = "", sending = false;
    const { boxes } = addressBoxes(grid, dictionary, wordsChanged, useRaw);
    (c.words || []).forEach((word, i) => { boxes[i].value = word; });
    function mode(asRaw, folded = false) {
      compact.hidden = !folded; chips.hidden = folded;
      compact.textContent = folded ? raw.value : "";
      raw.hidden = !asRaw || folded; grid.hidden = asRaw || folded;
      toggle.textContent = asRaw ? "Enter words" : "Link or Mail key";
      toggle.disabled = !dictionary.length;
    }
    function useRaw(text) { mode(true); raw.value = text; raw.focus(); keep(); check(); }
    function wordsChanged(accepted) {
      const parts = boxes.map(box => box.value.toLowerCase());
      raw.value = accepted && parts.every(word => dictionary.includes(word)) ? parts.join("-") : "";
      if (raw.value) {
        mode(false, true);
        compact.focus();
      }
      keep(); check();
    }
    function keep() {
      Object.assign(c, { to: raw.value, words: boxes.map(box => box.value), raw: !raw.hidden, collapsed: !compact.hidden,
        subject: D.el("mmSubj").value, body: D.el("mmBodyIn").value });
    }
    async function check() {
      const request = ++revision, text = raw.value.trim();
      resolved = ""; actions.forEach(button => { button.disabled = true; });
      status.textContent = ""; retry.hidden = true;
      if (!/^(?:0x)?[0-9a-f]{128}(?:\||$)/i.test(text) && !text.includes("minimamail:") &&
          !(text.split(/[\s-]+/).length === 6 && text.toLowerCase().split(/[\s-]+/).every(word => dictionary.includes(word)))) return;
      status.textContent = "Looking up address…";
      try {
        const key = await D.api.mailResolveAddress(text);
        if (request !== revision || !raw.isConnected) return;
        resolved = key; status.textContent = "Recipient ready";
        actions.forEach(button => { button.disabled = sending; });
      } catch (error) {
        if (request !== revision || !raw.isConnected) return;
        status.textContent = errText(error); retry.hidden = false;
      }
    }
    raw.oninput = () => { keep(); check(); };
    D.el("mmSubj").oninput = D.el("mmBodyIn").oninput = keep;
    mode(!dictionary.length || (c.raw ?? Boolean(c.to)), !!c.collapsed);
    compact.onclick = () => {
      mode(false); wordsChanged(false);
      boxes[0].focus(); boxes[0].select();
    };
    retry.onclick = check;
    check();
    D.el("mmCancel").onclick = function () { COMPOSE = null; VIEW = "inbox"; render(); };
    D.el("mmPick").onclick = function () {
      if (!CONTACTS.length) { D.toast("No contacts yet — paste a Mail key instead.", ""); return; }
      D.showActionSheet("Send to", CONTACTS.map(function (ct) {
        return { label: ct.username || shortKey(ct.publicId), onclick: function () { useRaw(ct.publicId); } };
      }));
    };
    toggle.onclick = () => {
      if (raw.hidden) { useRaw(raw.value); raw.select(); }
      else { mode(false); wordsChanged(); boxes[Math.max(0, boxes.findIndex(box => !dictionary.includes(box.value)))].focus(); }
    };
    D.el("mmScan").onclick = async function () {
      var v = await D.scanQR("Scan a Mail key").catch(function () { return null; });
      if (v) { useRaw(String(v).trim()); }
    };
    D.el("mmPhoto").onclick = function () { D.el("mmFile").click(); };
    D.el("mmFile").onchange = function (e) { if (resolved && e.target.files[0]) composeImage(e.target.files[0], resolved); };
    D.el("mmFunds").onclick = async function () {
      if (resolved) await sendFunds(resolved, D.el("mmSubj").value.trim());
    };
    D.el("mmDoSend").onclick = async () => {
      if (!resolved || sending) return;
      sending = true;
      try { await doSend(resolved); }
      finally { sending = false; actions[0].disabled = !resolved; }
    };
  }
  async function doSend(to) {
    var subject = D.el("mmSubj").value.trim();
    var body = D.el("mmBodyIn").value.trim();
    if (!body) { D.toast("Write a message first.", "err"); return; }
    var btn = D.el("mmDoSend"); btn.disabled = true;
    try {
      await D.api.mailSend(to, { message: body, subject: subject });
      COMPOSE = null;
      openThread(to, subject, "");
    } catch (e) { D.toast(errText(e), "err"); btn.disabled = false; }
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
    } catch (e) { D.toast(errText(e), "err"); }
    render();
  }
  async function composeImage(file, to) {
    var subject = D.el("mmSubj").value.trim();
    try {
      var b64 = await compressImage(file);
      await D.api.mailSend(to, { message: "", subject: subject, type: "image", image: b64 });
      COMPOSE = null; openThread(to, subject, "");
    } catch (e) { D.toast(errText(e), "err"); }
  }
  function plusMenu() {
    D.showActionSheet("Attach", [
      { label: "Photo", onclick: function () { D.el("mmFile").click(); } },
      { label: "Send funds", onclick: function () { sendFunds(PEER, SUBJ); } }
    ]);
  }
  // ---------------------------------------------------------------- dialogs and menus, in Mail's own look
  function root() { return document.querySelector ? document.querySelector("#mailBody .mailapp") : null; }
  /**
   * One Mail dialog: { title, html | message, ok, cancel (false = none), neutral, danger, wide,
   *   onOpen(box, close), onOk(box) → false keeps it open, onNeutral(box) }. Resolves what onOk returned (true when
   * there is none), or null when cancelled. Escape cancels; focus goes back to what opened it.
   */
  function mmDialog(o) {
    return new Promise(function (resolve) {
      var host = root(); if (!host) return resolve(null);
      var opener = document.activeElement, ov = document.createElement("div");
      ov.className = "mm-ov";
      ov.innerHTML = '<div class="mm-dlg' + (o.wide ? " mm-dlg--wide" : "") + '" role="dialog" aria-modal="true" aria-label="' + D.esc(o.title || "Mail") + '">'
        + (o.title ? '<div class="mm-dtitle">' + D.esc(o.title) + "</div>" : "")
        + '<div class="mm-dbody">' + (o.html != null ? o.html : '<div class="mm-dmsg">' + D.esc(o.message || "") + "</div>") + "</div>"
        + '<div class="mm-dstatus" role="alert"></div>'
        + '<div class="mm-dbtns">' + (o.neutral ? '<button type="button" class="mm-dbtn mm-dneutral">' + D.esc(o.neutral) + "</button>" : "") + '<span class="mm-grow"></span>'
        + (o.cancel === false ? "" : '<button type="button" class="mm-dbtn mm-dcancel">' + D.esc(o.cancel || "Cancel") + "</button>")
        + (o.ok === false ? "" : '<button type="button" class="mm-dbtn mm-dok' + (o.danger ? " mm-danger" : "") + '">' + D.esc(o.ok || "OK") + "</button>") + "</div></div>";
      MODAL++;
      host.appendChild(ov);
      var box = ov.querySelector(".mm-dlg"), status = ov.querySelector(".mm-dstatus"), okB = ov.querySelector(".mm-dok"), open = true;
      box.say = function (text) { status.textContent = text || ""; };
      var close = function (v) {
        if (!open) return; open = false; MODAL--; ov.remove();
        if (opener && opener.isConnected && opener.focus) opener.focus();
        resolve(v);
      };
      var cancelB = ov.querySelector(".mm-dcancel"), neutralB = ov.querySelector(".mm-dneutral");
      if (cancelB) cancelB.onclick = function () { close(null); };
      if (neutralB) neutralB.onclick = function () { if (o.onNeutral) o.onNeutral(box); };
      if (okB) okB.onclick = async function () {
        okB.disabled = true;
        var v; try { v = o.onOk ? await o.onOk(box) : true; } catch (e) { box.say(errText(e)); v = false; }
        okB.disabled = false;
        if (v !== false) close(v == null ? true : v);
      };
      ov.onkeydown = function (e) {
        if (e.key === "Escape" && o.cancel !== false) { e.stopPropagation(); close(null); }
        else if (e.key === "Enter" && e.target.tagName === "INPUT" && !e.target.closest(".we") && okB) { e.preventDefault(); okB.click(); }
        else if (e.key === "Tab") {   // stay inside
          var f = box.querySelectorAll("button:not([disabled]):not([hidden]), input:not([hidden]), textarea"), a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
          else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      if (o.onOpen) o.onOpen(box, close);
      var first = box.querySelector("input:not([hidden]), textarea") || okB || cancelB;
      if (first && !box.contains(document.activeElement)) first.focus();
    });
  }
  function mmConfirm(title, message, ok, danger) { return mmDialog({ title: title, message: message, ok: ok, danger: danger }).then(function (v) { return v === true; }); }
  function copied(text, said) { D.copy(text); D.toast(said, "ok"); }

  /** Exact comparison of two plain decimals (no floats: an amount is never rounded to decide whether it can be sent). */
  function decParts(v) { var p = String(v).split("."); return [(p[0] || "0").replace(/^0+(?=\d)/, ""), (p[1] || "").replace(/0+$/, "")]; }
  function decCmp(a, b) {
    var x = decParts(a), y = decParts(b);
    if (x[0].length !== y[0].length) return x[0].length < y[0].length ? -1 : 1;
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    var n = Math.max(x[1].length, y[1].length), f = x[1].padEnd(n, "0"), h = y[1].padEnd(n, "0");
    return f === h ? 0 : f < h ? -1 : 1;
  }
  function looksLikeMinimaAddress(a) {
    a = String(a || "").trim();
    if (/^Mx[0-9A-Za-z]+$/.test(a)) return a.length >= 40 && a.length <= 80;
    return /^0x[0-9A-Fa-f]{64}$/.test(a);
  }
  /**
   * Send funds (MainActivity.showSendFundsSheet): the Parlons-style currency picker (Minima and MxUSD, each with the
   * node's sendable balance), amount, their receiving address (learned from their signed messages; asked for when
   * unknown), a note; then Review, and only then the payment. Main checks the address with the node before any coin moves.
   */
  async function sendFunds(peer, subject) {
    var known = await D.api.mailResolvePayaddr(peer).catch(function () { return ""; });
    if (!known) { try { await D.api.mailRequestPayaddr(peer); } catch (e) {} }
    var tokens = await D.api.mailPayOptions().catch(function () { return []; });
    if (!tokens || !tokens.length) { D.toast("No funds available to send.", "err"); return; }
    var mine = (ID && ID.payaddr) || "", who = nameFor(peer, null);
    var pick = await mmDialog({ title: "Send funds to " + who, ok: "Review",
      html: '<div class="mm-flab" id="mmTokLab">Token</div><div class="mm-radio" role="radiogroup" aria-labelledby="mmTokLab">'
        + tokens.map(function (t, i) {
          return '<label><input type="radio" name="mmTok" value="' + i + '"' + (i === 0 ? " checked" : "") + "><span>" + D.esc(t.name + "  ·  " + t.balance) + "</span></label>";
        }).join("") + "</div>"
        + '<label class="mm-flab" for="mmAmt">Amount</label><input class="mm-inp" id="mmAmt" inputmode="decimal" placeholder="0.0" autocomplete="off">'
        + '<label class="mm-flab" for="mmPayAddr">Their Minima receiving address</label>'
        + '<input class="mm-inp mm-inp--mono" id="mmPayAddr" placeholder="0x… / Mx… address" autocomplete="off" spellcheck="false" value="' + D.esc(known || "") + '">'
        + '<div class="mm-fhint" id="mmPayHint">' + (known ? "Auto-filled from their messages." : "Auto-fills when they message you / are online. Or scan their QR, or paste their address.") + "</div>"
        + '<button type="button" class="mm-tbtn" id="mmPayScan">Scan their QR for their address</button>'
        + '<div class="mm-fhint mm-fhint--addr">You\'ll receive at: ' + D.esc(mine || "(getting your address…)") + "</div>"
        + '<label class="mm-flab" for="mmMemo">Note (optional)</label><input class="mm-inp" id="mmMemo" placeholder="What\'s it for?" autocomplete="off">',
      onOpen: function (box) {
        var addr = box.querySelector("#mmPayAddr");
        PAYFILL = function () {                          // the handshake answered while the sheet is open
          if (!addr.isConnected) { PAYFILL = null; return; }
          if (addr.value.trim()) return;
          D.api.mailResolvePayaddr(peer).then(function (a) { if (a && addr.isConnected && !addr.value.trim()) { addr.value = a; box.querySelector("#mmPayHint").textContent = "Auto-filled from their messages."; } }).catch(function () {});
        };
        box.querySelector("#mmPayScan").onclick = async function () {
          var v = await D.scanQR("Scan their Mail-key QR for their address").catch(function () { return null; });
          if (!v) return;
          var parts = String(v).split("|"), a = (parts[1] || parts[0]).trim();
          if (looksLikeMinimaAddress(a)) addr.value = a; else box.say("That QR does not carry a Minima receiving address.");
        };
      },
      onOk: function (box) {
        var sel = box.querySelector('input[name="mmTok"]:checked'); if (!sel) return false;
        var t = tokens[parseInt(sel.value, 10)], amount = box.querySelector("#mmAmt").value.trim(), addr = box.querySelector("#mmPayAddr").value.trim();
        if (!amount) { box.say("Enter an amount."); return false; }
        if (!/^[0-9]*\.?[0-9]+$/.test(amount)) { box.say("Invalid amount."); return false; }
        if (!/[1-9]/.test(amount)) { box.say("Enter an amount."); return false; }
        if (decCmp(amount, t.balance) > 0) { box.say("Insufficient balance."); return false; }
        if (!looksLikeMinimaAddress(addr)) { box.say("Enter " + who + "'s Minima receiving address (0x… or Mx…)."); return false; }
        return { token: t, amount: amount, addr: addr, memo: box.querySelector("#mmMemo").value };
      } });
    PAYFILL = null;
    if (!pick) return;
    if (!await mmConfirm("Send " + pick.amount + " " + pick.token.name + "?",
        "To " + who + "\n" + pick.addr + "\n\nThis sends real funds and cannot be undone.", "Send")) return;
    var done = null, wait = mmDialog({ title: "Sending " + pick.amount + " " + pick.token.name, message: "Posting to the chain — this can take a few seconds…",
      ok: false, cancel: false, onOpen: function (_box, close) { done = close; } });
    var result, failure = null;
    try { result = await D.api.mailPay(peer, pick.addr, pick.amount, pick.token.tokenid, pick.token.name, pick.memo, subject || ""); }
    catch (e) { failure = e; }
    if (done) done(true); await wait;
    if (failure) {
      // An RPC timeout is AMBIGUOUS — the coin may well have gone out. Never invite a retry that double-spends.
      var msg = String((failure && failure.message) || failure || "");
      await mmDialog({ title: "Payment failed", cancel: false, ok: "OK",
        message: /may have been submitted/i.test(msg) ? "The node didn't answer in time. The payment may have been sent: check your balance and History before sending again."
          : /validate the recipient/i.test(msg) ? "Couldn't validate the recipient address — not sending." : "Payment failed: " + errText(failure) });
    } else {
      var txid = (result && result.txpowid) || "";
      await mmDialog({ title: "Payment sent", cancel: false, ok: "OK", neutral: txid ? "Copy tx id" : null,
        message: "Sent " + pick.amount + " " + pick.token.name + " to " + who + "." + (txid ? "\n\nTx: " + txid : "")
          + (result && result.receiptFailed ? "\n\nThe payment went through, but the receipt message to them did not post." : ""),
        onNeutral: function () { copied(txid, "Copied."); } });
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
    var published = !!CONTACTS.find(c => c.publicId === peer && c.published);
    D.showActionSheet(nameFor(peer, null), [
      { label: "Send a message", onclick: function () { openCompose({ to: peer }); } },
      { label: "Rename", onclick: async function () {
        var n = await D.showPrompt("Rename contact", "", "Name"); if (n == null) return;
        await D.api.mailRenameContact(peer, String(n).trim()); render();
      } },
      { label: published ? "Stop relaying address" : "Relay signed address", onclick: () => toggleAddress(peer, !published) },
      { label: "Copy address words", onclick: () => D.copy(CONTACTS.find(c => c.publicId === peer).words || peer) },
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
    catch (e) { D.toast(errText(e), "err"); }
  }
  async function doRestore() {
    var pass = await D.showPrompt("Restore from a backup", "", "Backup passphrase",
      { password: true, ok: "Restore", message: "This replaces the identity, contacts and messages on this computer." });
    if (pass == null) return;
    try { await D.api.mailImportBackup(pass); D.toast("Restored ✓", "ok"); booted = false; render(); }
    catch (e) { D.toast(errText(e), "err"); }
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
      if (PAYFILL) PAYFILL();
      if (MODAL > 0 || VIEW === "compose") { loadLists(); return; }
      var d = D.el("mmDrawer"); if (d && d.isConnected && d.hidden === false) { loadLists(); return; }   // the side menu is open
      render();
    }, 350);
  }
  async function badge() {
    try { var th = await D.api.mailThreads(); var n = 0; for (var i = 0; i < th.length; i++) n += Number(th[i].unread || 0); return n; }
    catch (e) { return 0; }
  }

  g.MailPanel = { init: init, render: render, reset: reset, onUpdate: onUpdate, badge: badge, backup: doBackup, restore: doRestore,
    _open: function (what, a, b) { if (what === "thread") openThread(a, b || "", "", "inbox"); else if (what === "compose") openCompose(a); else if (what === "funds") sendFunds(a, b || ""); else { VIEW = what; PEER = null; render(); } },   // the dev preview drives screens through this
    _pure: { decCmp: decCmp, looksLikeMinimaAddress: looksLikeMinimaAddress } };   // backup and restore are also opened from Backup & Recovery
})(window);
