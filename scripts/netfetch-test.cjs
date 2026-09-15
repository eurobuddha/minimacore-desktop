/*
 * netfetch-test.cjs — the SSRF guard's regression suite.
 *
 * The bug this exists for: netfetch used to resolve a host to VET it, then hand the bare hostname to
 * http.request, which resolved it AGAIN. An attacker-controlled resolver answers public for the check and
 * 127.0.0.1 for the connect, so a token's icon url (token metadata is attacker-supplied, and the wallet list
 * fetches icons automatically) reached the node's own RPC — which on the Parlons node runs commands with NO
 * authentication. That is a `send` from a picture.
 *
 * These tests never touch the network: http.request is stubbed so we can assert on the options netfetch
 * passes, which is exactly where the fix lives.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');

const netfetch = require('../main/netfetch');

// ---- stubs -----------------------------------------------------------------
const realLookup = dns.promises.lookup;
const realHttpRequest = http.request;
const realHttpsRequest = https.request;

/** Queue DNS answers: the 1st is what the guard sees, the 2nd is what a rebinding client would have got. */
function stubDns(answers) {
  const calls = [];
  dns.promises.lookup = async (host) => { calls.push(host); return answers[Math.min(calls.length - 1, answers.length - 1)]; };
  return calls;
}

/** Capture the options netfetch hands http(s).request, then fail the request immediately. */
function stubRequest() {
  const seen = [];
  // netfetch calls request(url, options, cb) — capture the OPTIONS, not the url.
  const fake = (a, b, c) => {
    seen.push(typeof b === 'function' || b === undefined ? a : b);
    const req = new EventEmitter();
    req.end = () => {}; req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
    setImmediate(() => req.emit('error', new Error('stubbed — no real socket')));
    return req;
  };
  http.request = fake; https.request = fake;
  return seen;
}

function restore() {
  dns.promises.lookup = realLookup;
  http.request = realHttpRequest;
  https.request = realHttpsRequest;
}

// ---- tests -----------------------------------------------------------------

test('a host that resolves to loopback is refused outright', async () => {
  const calls = stubDns([[{ address: '127.0.0.1', family: 4 }]]);
  const seen = stubRequest();
  try {
    assert.strictEqual(await netfetch.tokenIcon('http://rpc.evil.test:12005/status'), null);
    assert.strictEqual(seen.length, 0, 'no request may be attempted for a loopback answer');
    assert.strictEqual(calls.length, 1);
  } finally { restore(); }
});

test('one private answer among several blocks the host (rebinding via multi-record)', async () => {
  stubDns([[{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]]);
  const seen = stubRequest();
  try {
    assert.strictEqual(await netfetch.tokenIcon('https://mixed.evil.test/icon.png'), null);
    assert.strictEqual(seen.length, 0);
  } finally { restore(); }
});

test('the vetted address is PINNED — the connect cannot take a second, rebound DNS answer', async () => {
  // answer #1 = what the guard checks (public, allowed); answer #2 = the rebind the client would have used
  stubDns([[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]);
  const seen = stubRequest();
  try {
    await netfetch.tokenIcon('http://rebind.evil.test:12005/send%20address:0xATTACKER');
    assert.strictEqual(seen.length, 1, 'the request should have been attempted (the host vetted clean)');
    const opts = seen[0];
    assert.strictEqual(typeof opts.lookup, 'function', 'a custom lookup MUST be supplied, or node re-resolves');

    // the (err, address, family) shape
    let got = null;
    opts.lookup('rebind.evil.test', {}, (e, address, family) => { got = { e, address, family }; });
    assert.strictEqual(got.e, null);
    assert.strictEqual(got.address, '93.184.216.34', 'must dial the address that was vetted, not the rebind');
    assert.strictEqual(got.family, 4);

    // the {all:true} shape — Happy Eyeballs / autoSelectFamily, default-on since node 20, so this is the
    // path electron actually takes. Answering it with the non-array shape breaks EVERY fetch.
    let all = null;
    opts.lookup('rebind.evil.test', { all: true }, (e, entries) => { all = { e, entries }; });
    assert.strictEqual(all.e, null);
    assert.ok(Array.isArray(all.entries), 'with {all:true} node expects an ARRAY of entries');
    assert.deepStrictEqual(all.entries, [{ address: '93.184.216.34', family: 4 }]);
  } finally { restore(); }
});

test('postText pins the vetted address too (the ETH JSON-RPC path)', async () => {
  stubDns([[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]);
  const seen = stubRequest();
  try {
    await netfetch.postText('https://eth.evil.test/', '{"jsonrpc":"2.0"}');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(typeof seen[0].lookup, 'function');
    let got = null;
    seen[0].lookup('eth.evil.test', {}, (e, address) => { got = address; });
    assert.strictEqual(got, '93.184.216.34');
  } finally { restore(); }
});

test('a literal loopback/private IP is still refused without any DNS at all', async () => {
  const calls = stubDns([[{ address: '93.184.216.34', family: 4 }]]);
  const seen = stubRequest();
  try {
    assert.strictEqual(await netfetch.tokenIcon('http://127.0.0.1:12005/status'), null);
    assert.strictEqual(await netfetch.tokenIcon('http://[::1]:12005/status'), null);
    assert.strictEqual(await netfetch.tokenIcon('http://169.254.169.254/latest/meta-data/'), null);
    assert.strictEqual(await netfetch.tokenIcon('http://192.168.1.1/'), null);
    assert.strictEqual(calls.length, 0, 'a literal IP must never be resolved');
    assert.strictEqual(seen.length, 0);
  } finally { restore(); }
});

test('isBlockedHost keeps its boolean contract for existing callers', async () => {
  stubDns([[{ address: '93.184.216.34', family: 4 }]]);
  try {
    assert.strictEqual(await netfetch.isBlockedHost('127.0.0.1'), true);
    assert.strictEqual(await netfetch.isBlockedHost('10.1.2.3'), true);
    assert.strictEqual(await netfetch.isBlockedHost('ok.example.test'), false);
    assert.strictEqual(await netfetch.isBlockedHost(''), true);
  } finally { restore(); }
});
