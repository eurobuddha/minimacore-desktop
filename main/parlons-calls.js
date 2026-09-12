// Shared with minimaCore Desktop / minimaDesk. Only the account's dedicated loopback
// guest receives media permission, autoplay and call attention. No guest preload or IPC API.
const { app, session, Notification, systemPreferences } = require('electron');
function isPanel(url, port) {
  try { const u = new URL(url); return u.origin === 'http://127.0.0.1:' + port && !u.username && !u.password; }
  catch (_) { return false; }
}
function install({ port, window: getWindow, focusPanel }) {
  let notice = null, attention = null;
  const allowed = wc => !!wc && !wc.isDestroyed() && wc.getType() === 'webview'
    && wc.session === session.fromPartition('persist:parlons') && isPanel(wc.getURL(), port());
  function clear() {
    if (notice) notice.close(); notice = null;
    if (attention != null && app.dock) app.dock.cancelBounce(attention); attention = null;
    const w = getWindow(); if (w && !w.isDestroyed()) w.flashFrame(false);
  }
  function focus() {
    const w = getWindow(); if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore(); w.show(); w.focus(); focusPanel();
  }
  app.whenReady().then(() => {
    const ses = session.fromPartition('persist:parlons');
    ses.setPermissionCheckHandler((wc, permission, origin) =>
      permission === 'media' && allowed(wc) && isPanel(origin, port()));
    ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      if (permission !== 'media' || !allowed(wc) || !isPanel(details.requestingUrl, port()) || details.isMainFrame === false) { callback(false); return; }
      try {
        if (process.platform === 'darwin') {
          for (const type of details.mediaTypes || []) {
            if (type === 'audio' && !await systemPreferences.askForMediaAccess('microphone')) { callback(false); return; }
            if (type === 'video' && !await systemPreferences.askForMediaAccess('camera')) { callback(false); return; }
          }
        }
        callback(allowed(wc));
      } catch (_) { callback(false); }
    });
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (event, prefs, params) => {
      if (isPanel(params.src, port())) {
        prefs.partition = 'persist:parlons'; prefs.backgroundThrottling = false;
        prefs.autoplayPolicy = 'no-user-gesture-required';
      } else if (params.partition === 'persist:parlons') event.preventDefault();
    });
    if (wc.getType() !== 'webview') return;
    let ringing = false;
    wc.on('page-title-updated', (_ev, title) => {
      if (!allowed(wc)) return;
      if (title === 'Parlons — INCOMING_RINGING') {
        if (ringing) return; ringing = true; clear(); focus();
        const w = getWindow(); if (w && !w.isDestroyed()) w.flashFrame(true);
        if (app.dock) attention = app.dock.bounce('critical');
        if (Notification.isSupported()) {
          notice = new Notification({title: 'Incoming Parlons call', body: 'Open Parlons to answer or decline.', silent: true});
          notice.on('click', focus); notice.show();
        }
      } else if (/^Parlons — (CONNECTING|LIVE|ENDED|OUTGOING_RINGING)$/.test(title)) {
        ringing = false; clear();
      }
    });
    wc.on('destroyed', () => { if (ringing) clear(); });
  });
}
module.exports = { install, isPanel };
