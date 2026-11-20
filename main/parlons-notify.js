/*
 * parlons-notify.js — the app's notifier for Parlons while the panel lives in the system browser (0.19.3).
 *
 * The only thing the app can read without the panel's session is what the Parlons node prints on its own stdout
 * (parlons-node 0.2.152 and 0.2.153 print the same lines):
 *   [parlons-node] message from <sender key>: <up to 80 characters of the message>     ParlonsCore.java
 *   [parlons-node] node: call offer from <contact name> → pushing to devices           ParlonsControl.forwardCallSignal
 * The call line is printed ONLY while some device is live (a Parlons tab open in a browser, or a paired phone seen in
 * the last three minutes). With none, the node declines the call at once and prints nothing, so this notifier cannot
 * know of it: that needs the node addition described in docs/PANDAMONIUM_DESKTOP_PLAN.md.
 *
 * Both lines carry text a REMOTE party chose (any peer can send a message). They are parsed here, anchored, and by
 * nothing else: main/node-manager.js keeps them away from every other check it runs on the node's output (nodeLine).
 */
// The sender is a Maxima identity key: an RSA-1024 public key prints as 0x + 324 hex digits (0.19.3 allowed 200, so a
// real line was neither notified nor redacted). Up to 1024 is read, for a longer key kind.
const MESSAGE = /^\[parlons-node\] message from (0x[0-9A-Fa-f]{1,1024}): ([\s\S]*)$/;
const MESSAGE_START = "[parlons-node] message from ";
const CALL = /^\[parlons-node\] node: call offer from ([\s\S]*) → pushing to devices$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;   // control and bidi-override characters never reach a notification

/** A line whose content a remote party controls. node-manager reads no state out of these. */
function isChatter(line) { const l = String(line); return l.startsWith("[parlons-node] message from ") || l.startsWith("[parlons-node] node: "); }
const clean = (s, max) => String(s).replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** { type: "message", from, preview } | { type: "call", name } | null */
function parse(line) {
  const l = String(line).replace(/\r$/, "");
  let m = MESSAGE.exec(l);
  if (m) return { type: "message", from: m[1], preview: clean(m[2], 120) };
  m = CALL.exec(l);
  if (m) return { type: "call", name: clean(m[1], 80) };
  return null;
}
/** What goes to the log and the disk for such a line: who and that, never the message's own words. Fail closed: ANY
 *  line that starts as a message line loses everything after its first ": ", whatever the sender looks like, and a
 *  sender that is not a plain key is not shown either (it could be the text). */
function redact(line) {
  const l = String(line).replace(/\r$/, "");
  if (!l.startsWith(MESSAGE_START)) return line;
  const i = l.indexOf(": ", MESSAGE_START.length), who = i < 0 ? "" : l.slice(MESSAGE_START.length, i);
  return MESSAGE_START + (/^0x[0-9A-Fa-f]{1,1024}$/.test(who) ? who : "(sender not shown)") + ": (text not logged)";
}
const MESSAGE_GAP_MS = 5000;    // at most one message notification in this time: a stranger cannot make it rain
const RING_MS = 45000;          // the panel rings for 45 seconds
/**
 * install({ events, electron, window, open }): events = the node manager (emits "parlons-event"), open() opens the
 * panel in the browser with a one-time link. A message: one desktop notification. A call: a notification and the
 * dock bounce / taskbar flash, until clicked or the ring time is over. Clicking either opens the panel.
 */
function install({ events, electron, window: getWindow, open }) {
  const { app, Notification } = electron;
  let lastMessage = 0, waiting = 0, callNote = null, bounce = null, callTimer = null;
  const supported = () => { try { return Notification.isSupported(); } catch (e) { return false; } };
  function clearCall() {
    clearTimeout(callTimer); callTimer = null;
    if (callNote) { try { callNote.close(); } catch (e) {} callNote = null; }
    if (bounce != null && app.dock) { try { app.dock.cancelBounce(bounce); } catch (e) {} } bounce = null;
    const w = getWindow(); if (w && !w.isDestroyed()) w.flashFrame(false);
  }
  function onEvent(ev) {
    if (!ev) return;
    if (ev.type === "message") {
      const now = Date.now();
      if (now - lastMessage < MESSAGE_GAP_MS) { waiting++; return; }
      const more = waiting; lastMessage = now; waiting = 0;
      if (!supported()) return;
      const n = new Notification({ title: "Parlons: new message", body: (ev.preview || "Open Parlons to read it.") + (more ? " (and " + more + " more)" : "") });
      n.on("click", () => open());
      n.show();
    } else if (ev.type === "call") {
      clearCall();
      const w = getWindow(); if (w && !w.isDestroyed()) w.flashFrame(true);
      if (app.dock) { try { bounce = app.dock.bounce("critical"); } catch (e) {} }
      if (supported()) {
        callNote = new Notification({ title: "Incoming Parlons call", body: (ev.name ? "From " + ev.name + ". " : "") + "Answer in the Parlons tab in your browser." });
        callNote.on("click", () => { clearCall(); open(); });
        callNote.show();
      }
      callTimer = setTimeout(clearCall, RING_MS);
    }
  }
  events.on("parlons-event", onEvent);
  return { onEvent, clearCall };
}
module.exports = { isChatter, parse, redact, install, MESSAGE_GAP_MS, RING_MS };
