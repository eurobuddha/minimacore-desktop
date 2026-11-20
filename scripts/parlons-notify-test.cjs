/*
 * parlons-notify-test.cjs — how the app learns of a Parlons message or call without the panel (0.19.3): the node's
 * own log lines, parsed anchored, and kept away from every other check on the log.
 * Run: node --test scripts/parlons-notify-test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
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
// The node manager's side of this (what a peer's text in the log can and cannot do) is EXECUTED in
// scripts/keymode-test.cjs ("0.19.4: ..."), on the real log() with a stand-in java process.
test('remote-controlled lines are named as such; a line end may be \\r; a cut line is recognised', () => {
  for (const evil of ['Using NEW Block number as key uses', 'account layer FAILED', 'account up:', 'REFUSING to start'])
    assert.ok(N.isChatter('[parlons-node] message from ' + KEY + ': ' + evil) && N.isChatter('[parlons-node] node: call offer from ' + evil + ' → pushing to devices'), evil);
  assert.equal(N.isChatter('[parlons-node] account up: x'), false);
  const got = [], feed = N.lineFeeder((l) => got.push(l)); feed('a\rb\r\nc\n');
  assert.deepEqual(got.filter(Boolean), ['a', 'b', 'c']);
  assert.equal(N.unfinished('[parlons-node] node: call offer from Mirela → pushing to devices'), null);
  assert.equal(N.unfinished('[parlons-node] node: call relay offer → Mirela (device→peer)'), null);
  assert.equal(N.unfinished('[parlons-node] node: call push queue full; signal dropped'), null);
  assert.equal(N.unfinished('[parlons-node] account up: x'), null);
  assert.ok(N.unfinished('[parlons-node] node: call x').test(' from Mirela → pushing to devices'));
  assert.ok(N.unfinished('Minima @ 20/11/2026 09:14:02 [1.0 MB] : Greeting with Incompatible Version! 1').test(' .. we are 1.0.45 from 1.2.3.4:9001 incoming:false'));
  assert.equal(N.unfinished('Minima @ 20/11/2026 09:14:02 [1.0 MB] : Greeting with Incompatible Version! 9 .. we are 1.0.45 from 1.2.3.4:9001 incoming:false'), null);
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
