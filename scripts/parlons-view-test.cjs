const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.PARLONS_VIEW_SOURCE || path.join(__dirname, '../renderer/app.js'), 'utf8');
function fixture() {
  const nodes = new Map(); let webview, calls = 0, now = 100000;
  function el(id) { if (!nodes.has(id)) nodes.set(id, {set innerHTML(v) { this.html = v; if (id === 'parlonsBody') webview = undefined; }, get innerHTML() { return this.html; }, querySelector() { return webview; }, appendChild(w) { webview = w; }}); return nodes.get(id); }
  const api = {parlonsStatus: async () => ({kind: 'parlons', ready: true, panelPort: 123}), nodeStatus: async () => ({startedTs: 99550, uptimeMs: 500}), parlonsPanelUrl: async () => 'ticket-' + ++calls};
  const ctx = vm.createContext({api, el, activeView: 'parlons', esc: String, Date: {now: () => now}, setTimeout() {}, clearTimeout() {}, document: {createElement() { return {setAttribute(k, v) { this[k] = v; }}; }}});
  vm.runInContext(source.slice(source.indexOf('let parlonsLoadedFor =')) + '\nglobalThis.renderPanel = renderParlons;', ctx);
  return {ctx, api, el, render: () => ctx.renderPanel(), get calls() { return calls; }, get webview() { return webview; }, later() { now += 501; }};
}
test('the same node keeps one panel session across delayed status replies', async () => {
  const f = fixture(); await f.render(); const first = f.webview; f.later(); await f.render();
  assert.equal(f.calls, 1); assert.equal(f.webview, first);
});
test('a late one-time link cannot replace a newer render', async () => {
  const f = fixture(); let resolve; const slow = new Promise(r => resolve = r); let n = 0;
  let started; const requested = new Promise(r => started = r);
  f.api.parlonsPanelUrl = () => { if (++n === 1) { started(); return slow; } return Promise.resolve('new-ticket'); };
  const first = f.render(); await requested;
  const second = f.render(); await second; resolve('stale-ticket'); await first;
  assert.equal(f.webview.src, 'new-ticket');
});
test('an unavailable account exposes a retry instead of a blank spinner', async () => {
  const f = fixture(); f.api.parlonsStatus = async () => { throw new Error('offline'); }; await f.render();
  assert.match(f.el('parlonsBody').innerHTML, /Could not check/); assert.equal(typeof f.el('parlonsReload').onclick, 'function');
});
