/*
 * parlons-notify-test.cjs — how the app learns of a Parlons message or call without the panel (0.19.3): the node's
 * own log lines, parsed anchored, and kept away from every other check on the log.
 * Run: node --test scripts/parlons-notify-test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const N = require('../main/parlons-notify');
const KEY = '0x' + 'FA4E'.repeat(16);

test('the two lines parlons-node 0.2.152 / 0.2.153 print are read; nothing else is', () => {
  assert.deepEqual(N.parse('[parlons-node] message from ' + KEY + ': See you at six'), { type: 'message', from: KEY, preview: 'See you at six' });
  assert.deepEqual(N.parse('[parlons-node] node: call offer from Mirela Okafor → pushing to devices'), { type: 'call', name: 'Mirela Okafor' });
  for (const other of ['[parlons-node] node: call ice from Mirela → pushing to devices', '[parlons-node] node: call answer from Mirela → pushing to devices',
    '[parlons-node] node: call bye from Mirela → pushing to devices', '[parlons-node] node: call relay offer → Mirela (device→peer)',
    '[parlons-node] account up: MAX#0x', 'x [parlons-node] message from ' + KEY + ': hi', '[parlons-node] message from Mirela: hi'])
    assert.equal(N.parse(other), null, other);
});
test('control and bidi characters never reach a notification, and it is bounded', () => {
  const ev = N.parse('[parlons-node] message from ' + KEY + ': a‮b\u0007c' + 'x'.repeat(500));
  assert.ok(!/[\u0000-\u001f‮]/.test(ev.preview)); assert.ok(ev.preview.length <= 120);
});
test('the message text stays out of the log; a call line is kept', () => {
  assert.equal(N.redact('[parlons-node] message from ' + KEY + ': my secret'), '[parlons-node] message from ' + KEY + ': (text not logged)');
  const call = '[parlons-node] node: call offer from Mirela → pushing to devices';
  assert.equal(N.redact(call), call);
});
test('a line cut across two chunks is one line', () => {
  const got = [], feed = N.lineFeeder((l) => got.push(l));
  feed('[parlons-node] message fr'); feed('om ' + KEY + ': hello\n[parlons-node] acc'); feed('ount up: x\n');
  assert.deepEqual(got, ['[parlons-node] message from ' + KEY + ': hello', '[parlons-node] account up: x']);
});
test('a remote sender cannot drive the node manager through the log (found in review)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'node-manager.js'), 'utf8');
  const chatter = src.indexOf('if (parlonsNotify.isChatter(l)) {'), watch = src.indexOf('try { this.watchParlonsLine(l); }'), keymode = src.indexOf('l.includes("Using NEW Block number as key uses")'), hint = src.indexOf('/Database may be already in use');
  assert.ok(chatter > 0 && chatter < watch && watch < keymode && keymode < hint, 'chatter lines are taken out before every state check');
  assert.match(src.slice(chatter, watch), /continue;\s*\}\s*$/, 'and never fall through');
  for (const evil of ['Using NEW Block number as key uses', 'account layer FAILED', 'Maxima cape FAILED', 'account up:', 'REFUSING to start', 'Address already in use'])
    assert.ok(N.isChatter('[parlons-node] message from ' + KEY + ': ' + evil) && N.isChatter('[parlons-node] node: call offer from ' + evil + ' → pushing to devices'), evil);
  assert.equal(N.isChatter('[parlons-node] account up: x'), false);
  assert.match(src, /p\.stdout\.on\("data", parlonsNotify\.lineFeeder\(/);
});
function rig() {
  const shown = [], events = new EventEmitter(); let opened = 0, flash = [], bounced = 0, cancelled = 0;
  class Notification { constructor(o) { this.o = o; this.h = {}; } static isSupported() { return true; } on(e, f) { this.h[e] = f; } show() { shown.push(this); } close() { this.closed = true; } }
  const electron = { Notification, app: { dock: { bounce: () => { bounced++; return 7; }, cancelBounce: () => { cancelled++; } } } };
  const api = N.install({ events, electron, window: () => ({ isDestroyed: () => false, flashFrame: (v) => flash.push(v) }), open: () => { opened++; } });
  return { events, shown, api, flash, get opened() { return opened; }, get bounced() { return bounced; }, get cancelled() { return cancelled; } };
}
test('a message is one notification; a burst is one, not many; a click opens the panel', () => {
  const r = rig();
  for (let i = 0; i < 20; i++) r.events.emit('parlons-event', { type: 'message', from: KEY, preview: 'hello ' + i });
  assert.equal(r.shown.length, 1); assert.equal(r.shown[0].o.title, 'Parlons: new message'); assert.equal(r.shown[0].o.body, 'hello 0');
  r.shown[0].h.click(); assert.equal(r.opened, 1);
});
test('a call: notification, dock bounce and taskbar flash, cleared on click, which opens the panel', () => {
  const r = rig();
  r.events.emit('parlons-event', { type: 'call', name: 'Mirela Okafor' });
  assert.equal(r.shown.length, 1); assert.equal(r.shown[0].o.title, 'Incoming Parlons call'); assert.match(r.shown[0].o.body, /^From Mirela Okafor\. Answer in the Parlons tab/);
  assert.equal(r.bounced, 1); assert.deepEqual(r.flash, [false, true]);
  r.shown[0].h.click();
  assert.equal(r.opened, 1); assert.equal(r.cancelled, 1); assert.equal(r.flash[r.flash.length - 1], false); assert.equal(r.shown[0].closed, true);
  r.api.clearCall();
});
