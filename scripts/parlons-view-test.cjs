/*
 * parlons-view-test.cjs — Parlons opens in the system browser (0.19.3): nothing of it is embedded.
 * Run: node --test scripts/parlons-view-test.cjs
 */
const test = require('node:test');
require('../renderer/i18n.js');   // t(), th(), tr() as the window has them: code lifted out of the renderer reads as before
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const source = read('renderer/app.js');
function fixture(status) {
  const nodes = new Map(); let opened = 0; const toasts = [];
  function el(id) { if (!nodes.has(id)) nodes.set(id, { innerHTML: '' }); return nodes.get(id); }
  const api = { parlonsStatus: async () => status, parlonsOpenExternal: async () => { opened++; return true; } };
  const ctx = vm.createContext({ ...require('./i18n-plain.cjs').globals(), api, el, esc: String, toast: (m) => toasts.push(m), copy() {}, showConfirm: async () => false });
  const from = source.indexOf('let parlonsLastSig = "";'), to = source.indexOf('\n}', source.indexOf('async function renderParlons()')) + 2;
  vm.runInContext(source.slice(from, to) + '\nglobalThis.renderPanel = renderParlons; globalThis.openPanel = openParlons;', ctx);
  return { ctx, api, el, toasts, render: () => ctx.renderPanel(), open: () => ctx.openPanel(), get opened() { return opened; } };
}
test('a ready account shows one button that opens the panel in the browser, and embeds nothing', async () => {
  const f = fixture({ kind: 'parlons', ready: true, panelPort: 123, address: 'MAX#0xFA4E#FA4E@198.51.100.7:9001', version: '0.2.152' });
  await f.render();
  const html = f.el('parlonsBody').innerHTML;
  assert.match(html, /Open Parlons in the browser/); assert.match(html, /MAX#0xFA4E#FA4E@198\.51\.100\.7:9001/);
  assert.doesNotMatch(html, /webview|iframe|ticket/);
  assert.equal(f.opened, 0, 'drawing the screen opens nothing');
  await f.el('parlonsOpen').onclick();
  assert.equal(f.opened, 1);
});
test('no link yet is said, not hidden', async () => {
  const f = fixture({ kind: 'parlons', ready: true }); f.api.parlonsOpenExternal = async () => false;
  assert.equal(await f.open(), false); assert.match(f.toasts[0], /no sign-in link yet/);
});
test('an unavailable account exposes a retry instead of a blank spinner', async () => {
  const f = fixture(null); f.api.parlonsStatus = async () => { throw new Error('offline'); }; await f.render();
  assert.match(f.el('parlonsBody').innerHTML, /Could not check/); assert.equal(typeof f.el('parlonsReload').onclick, 'function');
});
test('a starting or failed account says so and offers no open button', async () => {
  const f = fixture({ kind: 'parlons', ready: false, error: '' }); await f.render();
  assert.match(f.el('parlonsBody').innerHTML, /Waiting for the account/); assert.doesNotMatch(f.el('parlonsBody').innerHTML, /parlonsOpen/);
});
test('the embedded view, its session and its permissions are gone; the renderer never holds the ticket', () => {
  const main = read('main/main.js'), preload = read('main/preload.js'), html = read('renderer/index.html');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'main', 'parlons-calls.js')));
  for (const [name, src] of [['main.js', main], ['preload.js', preload], ['app.js', source], ['index.html', html], ['app.css', read('renderer/app.css')]]) {
    assert.ok(!/persist:parlons/.test(src), name + ': no parlons session');
    assert.ok(!/createElement\("webview"\)|<webview|webviewTag: true/.test(src), name + ': no webview');
    assert.ok(!/parlonsPanelUrl|mcd:parlonsPanelUrl/.test(src), name + ': the one-time link stays in the main process');
  }
  assert.ok(/will-attach-webview", \(ev\) => ev\.preventDefault\(\)/.test(main), 'a webview can never be attached');
  const parlons = read('main/parlons.js');
  assert.ok(/url\.startsWith\("http:\/\/127\.0\.0\.1:" \+ node\.panelPort\(\) \+ "\/open\?ticket="\)/.test(parlons), 'only the loopback panel is ever opened');
  assert.ok(/r\.dataset\.app === "parlons"\) api\.parlonsStatus\(\)/.test(source), 'the tray row opens it');
});
