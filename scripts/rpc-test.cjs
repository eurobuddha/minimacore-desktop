const assert = require('node:assert/strict');
const net = require('node:net');
const { test } = require('node:test');
const { rpcCall } = require('../main/rpc');
require('../main/rpc')._setMinHold(0);   // the 60 s minimum hold of a lost signer (0.19.225) is tested on its own below

async function withServer(handler, run) {
  const server = net.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('an interrupted RPC response rejects instead of leaving the operation pending', async () => {
  await withServer(socket => socket.once('data', () => {
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"status":');
  }), async port => {
    let timer;
    try {
      await assert.rejects(Promise.race([
        rpcCall(port, 'test-only', 'status'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation stayed pending')), 1500); })
      ]), error => error.message !== 'operation stayed pending');
    } finally { clearTimeout(timer); }
  });
});

// CHANGED on purpose (0.19.305): a POST body is pure ASCII, so the shipped node (Content-Length read as CHARACTERS) and a fixed
// one (read as BYTES) both get it whole; anything else goes by GET (URL-decoded the way Java's URLDecoder does, "+" as a space),
// or is refused before sending when too long for it. Two stand-ins, one per node, must receive the exact command.
function nodeStandIn(readBodyAs, seen) {
  return (socket) => {
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n'); if (end < 0) return;
      const header = received.subarray(0, end).toString('latin1'), line = header.split('\r\n')[0], [method, target] = line.split(' ');
      let command;
      if (method === 'GET') command = decodeURIComponent(target.replace(/^\//, '').replace(/\/$/, '').replace(/\+/g, ' ')).trim();   // URLDecoder: "+" is a space
      else {
        const length = Number(/content-length: (\d+)/i.exec(header)?.[1]), body = received.subarray(end + 4);
        if (readBodyAs === 'bytes') { if (body.length < length) return; command = body.subarray(0, length).toString('utf8'); }
        else { const chars = body.toString('utf8'); if (chars.length < length) return; command = chars.slice(0, length); }
      }
      seen.push({ method, command });
      const reply = '{"status":true,"response":{"ok":true}}';
      socket.end('HTTP/1.1 200 OK\nContent-Length: ' + Buffer.byteLength(reply) + '\nConnection: close\n\n' + reply);
    });
  };
}
test('ASCII by POST and non-ASCII by GET reach a characters-reading node and a bytes-reading node exactly; a non-ASCII command too long for GET is refused before sending', async () => {
  const cases = [['ASCII, long: POST', 'send amount:1 address:0x02 state:{"0":"' + 'a'.repeat(7000) + '"}', 'POST'], ['ASCII with + % / and spaces: GET', 'txnstate id:x port:1 value:"1+1 = 2% a/b/"', 'GET'],
    ['non-ASCII, short: GET', 'txnstate id:x port:1 value:"café ✓ 😀"', 'GET'], ['non-ASCII, longer than POST starts: GET', 'txnstate id:x port:1 value:"' + 'é'.repeat(7000) + ' 😀"', 'GET']];
  for (const reads of ['chars', 'bytes']) {
    const seen = [];
    await withServer(nodeStandIn(reads, seen), async port => {
      for (const [what, command, method] of cases) {
        seen.length = 0;
        assert.deepEqual(await rpcCall(port, 'test-only', command), { status: true, response: { ok: true } }, reads + ': ' + what);
        assert.deepEqual(seen, [{ method, command }], reads + ': ' + what);
      }
      seen.length = 0;
      await assert.rejects(rpcCall(port, 'test-only', 'txnstate id:x port:1 value:"' + 'é'.repeat(12000) + '"'), /outside plain ASCII and is too long/);
      assert.deepEqual(seen, [], reads + ': nothing was sent');
    });
  }
});

test('signing commands are serialised process-wide; reads are not held behind them', async () => {
  const http = require('node:http');
  const seen = []; let releaseFirst;
  const server = http.createServer((req, res) => {
    const cmd = decodeURIComponent(req.url.slice(1)); seen.push(cmd);
    const reply = () => res.end(JSON.stringify({ status: true, command: cmd }));
    if (cmd.startsWith('send amount:1')) releaseFirst = reply; else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const first = rpcCall(port, 's', 'send amount:1 address:0x00');
    const second = rpcCall(port, 's', 'txnsign id:a publickey:auto');
    const chained = rpcCall(port, 's', 'txnsign id:b publickey:auto');
    await assert.rejects(rpcCall(port, 's', 'txncreate id:c;txnsign id:c publickey:auto'), /send the commands one at a time/);   // a chain never reaches the node (0.19.418)
    await rpcCall(port, 's', 'balance');                       // a read goes straight through
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual([...seen].sort(), ['balance', 'send amount:1 address:0x00'], 'the read went through; the second signer has not reached the node yet');
    releaseFirst();
    await Promise.all([first, second, chained]);
    assert.deepEqual(seen.slice(2), ['txnsign id:a publickey:auto', 'txnsign id:b publickey:auto'], 'signers ran one at a time, in order');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// ---- the signing queue (main/noderun.js), 0.18.75 ----
const { createNodeRunner, SIGNING } = require('../main/noderun');
const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('the SIGNING pattern: every command that signs is queued, nothing else is', () => {
  const q = createNodeRunner(async () => ({}));
  const signs = [
    'send amount:1 address:0x00', 'sendpoll action:add amount:1 address:0x00', 'sendsign file:a.txn',
    'txnsign id:a publickey:auto', 'consolidate tokenid:0x00', 'tokencreate name:x amount:10', 'multisig action:sign id:a',
    'sign publickey:0xAA data:0xBB', 'signfrom data:0xAA privatekey:0xBB keyuses:3', 'txnauto id:a amount:1 address:0x00 sign:true',
    'txnpost id:a auto:true', 'txnpost id:a burn:0.1', '  SEND amount:1 address:0x00',
    'txncreate id:b;txnsign id:b publickey:auto', 'txncreate id:c; txnpost id:c auto:true', 'balance;sign publickey:0xAA data:0xBB'
  ];
  const reads = [
    'balance', 'coins relevant:true', 'txnpost id:a', 'txnpost id:a mine:true', 'sendfrom fromaddress:0xAA address:0xBB amount:1 privatekey:0xCC keyuses:2',
    'txncreate id:a', 'quit', 'block', 'keys', 'sendnosign amount:1 address:0x00', 'sendview file:a.txn', 'sendpost file:a.txn',
    'signature', 'txnlist', 'txncreate id:a;txninput id:a coinid:0x01;txnpost id:a', 'verify publickey:0xAA data:0xBB signature:0xCC'
  ];
  for (const c of signs) assert.equal(q.signing(c), true, 'signs: ' + c);
  for (const c of reads) assert.equal(q.signing(c), false, 'does not sign: ' + c);
  assert.ok(SIGNING.test('sign data:0x01') && !SIGNING.test('signature'), 'the verb is matched whole');
});

// 0.19.189: the verb read as the node reads it (main/cmdverb.js). Each of these is run by the node as a signing command and
// slipped past the old /^\s*send\b/: two signings could then share a key use.
test('the signing queue reads a command the way the node does: quoted, control-character and ":"-spaced signers are queued', () => {
  const q = createNodeRunner(async () => ({}));
  for (const c of ['"send" amount:1 address:0x00', '\u0001send amount:1 address:0x00', 's"en"d amount:1 address:0x00', '"send"amount:1 address:0x00',
    'send:amount:1 address:0x00', '"txnsign" id:a publickey:auto', '\u0002txnsign id:a publickey:auto', 'tx"nsi"gn id:a publickey:auto', 'CONSOLIDATE tokenid:0x00',
    '"consolidate" tokenid:0x00', 'txnpost id:a "burn":0.1', 'txnpost id:a burn : 0.1', '"txnpost" id:a auto : true', 'txnpost id:a "auto":"true"',
    'balance;"send" amount:1 address:0x00', 'status;\u0001txnsign id:b publickey:auto', '\u212aeys action:list;"sign" data:0x01'])
    assert.equal(q.signing(c), true, 'queued: ' + JSON.stringify(c));
  for (const c of ['"balance"', 'txnpost id:a', '"txnpost" id:a', 'sendfrom amount:1 address:0x00', '"sendnosign" amount:1', 'signature']) assert.equal(q.signing(c), false, 'not queued: ' + JSON.stringify(c));
});

test('a signer that timed out holds the queue until the node answers a read; the next signer never overlaps it', async () => {
  const seen = []; let probes = 0; const warned = [];
  const raw = async (c) => {
    seen.push(c);
    if (c === 'send amount:1 address:0x00') throw new Error('RPC timeout');           // the node is still signing it
    if (c === 'block') { if (++probes < 3) throw new Error('RPC timeout'); return { status: true, response: { block: 7 } }; }
    return { status: true };
  };
  const q = createNodeRunner(raw, { lost: (e) => /timeout|ECONNRESET|socket hang up/.test(e.message), pauseMs: 40, minHoldMs: 0, warn: (l) => warned.push(l) });
  const first = q.run('send amount:1 address:0x00');
  const second = q.run('txnsign id:a publickey:auto');
  await assert.rejects(first, /RPC timeout/, 'the caller is told at once');
  await tick(60);
  assert.deepEqual(seen.filter(c => c !== 'block'), ['send amount:1 address:0x00'], 'the node has not answered yet: the next signer is still held');
  await second;
  assert.deepEqual(seen, ['send amount:1 address:0x00', 'block', 'block', 'block', 'txnsign id:a publickey:auto'], 'it ran only after `block` answered');
  assert.equal(warned.length, 1, 'one log line for the hold');
  assert.ok(!/amount:1/.test(warned[0]), 'which names the verb only, never the whole command');
});

test('a status:false reply and a clean rejection release the queue at once (no probe)', async () => {
  const seen = [];
  const raw = async (c) => { seen.push(c); if (/^send /.test(c)) return { status: false, message: 'Insufficient funds' }; if (/^sign /.test(c)) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return { status: true }; };
  const q = createNodeRunner(raw, { lost: (e) => e.code !== 'ECONNREFUSED', pauseMs: 5000 });
  const a = q.run('send amount:1 address:0x00'), b = q.run('sign publickey:0xAA data:0xBB'), c = q.run('txnsign id:a publickey:auto');
  assert.equal((await a).status, false); await assert.rejects(b, /ECONNREFUSED/); await c;
  assert.deepEqual(seen, ['send amount:1 address:0x00', 'sign publickey:0xAA data:0xBB', 'txnsign id:a publickey:auto']);
});

test('a node that never answers again: the hold ends at its bound, loudly', async () => {
  const seen = []; const warned = [];
  const raw = async (c) => { seen.push(c); if (c === 'txnsign id:b publickey:auto') return { status: true }; throw new Error('RPC timeout'); };
  const q = createNodeRunner(raw, { lost: () => true, pauseMs: 20, maxHoldMs: 70, minHoldMs: 0, warn: (l) => warned.push(l) });
  await assert.rejects(q.run('txnsign id:a publickey:auto'));
  await q.run('txnsign id:b publickey:auto');
  assert.ok(seen.filter(c => c === 'block').length >= 2, 'it kept asking');
  assert.equal(seen[seen.length - 1], 'txnsign id:b publickey:auto');
  assert.match(warned[warned.length - 1], /RELEASED WITHOUT AN ANSWER/);
});

test('rpcCall: a dropped connection on a signer holds the queue until `block` answers', async () => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    const cmd = decodeURIComponent(req.url.slice(1)); seen.push(cmd);
    if (cmd.startsWith('send ')) { req.socket.destroy(); return; }
    setTimeout(() => res.end(JSON.stringify({ status: true, command: cmd })), cmd === 'block' ? 80 : 0);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const quiet = console.error; console.error = () => {};
  try {
    const first = rpcCall(port, 's', 'send amount:1 address:0x00');
    const second = rpcCall(port, 's', 'txnsign id:a publickey:auto');
    await assert.rejects(first);
    await second;
    assert.deepEqual(seen, ['send amount:1 address:0x00', 'block', 'txnsign id:a publickey:auto']);
  } finally { console.error = quiet; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('rpcCall: a queued signer whose caller gave up never reaches the node', async () => {
  const http = require('node:http');
  const seen = []; let releaseFirst;
  const server = http.createServer((req, res) => {
    const cmd = decodeURIComponent(req.url.slice(1)); seen.push(cmd);
    const reply = () => res.end(JSON.stringify({ status: true, command: cmd }));
    if (cmd.startsWith('send amount:1 ')) releaseFirst = reply; else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const gaveUp = new AbortController(), patient = new AbortController();
    const first = rpcCall(port, 's', 'send amount:1 address:0x00');
    const dropped = rpcCall(port, 's', 'send amount:2 address:0x00', { signal: gaveUp.signal });
    const kept = rpcCall(port, 's', 'send amount:3 address:0x00', { signal: patient.signal });
    dropped.catch(() => {});
    await tick(100);
    gaveUp.abort();                    // the caller's own 60 s ran out while its send was still queued
    releaseFirst();
    await first;
    await assert.rejects(dropped, (e) => e.dropped === true && /still queued when its caller gave up/.test(e.message));
    await kept;
    assert.deepEqual(seen, ['send amount:1 address:0x00', 'send amount:3 address:0x00'], 'the abandoned send was never sent; the queue moved on at once');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('rpcCall: a coin one owner named for a transaction is refused to another owner before the node (main/reserve.js)', async () => {
  const http = require('node:http');
  const seen = [], COIN = '0x' + 'C1'.repeat(32);
  const server = http.createServer((req, res) => {
    const cmd = decodeURIComponent(req.url.slice(1)); seen.push(cmd);
    res.end(JSON.stringify(/^coins /.test(cmd) ? { status: true, response: [{ coinid: COIN, amount: '1', address: '0x' + 'AA'.repeat(32), tokenid: '0x00' }] } : { status: true, command: cmd }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await rpcCall(port, 's', 'txninput id:ax1 coinid:' + COIN, { owner: 'atomix' })).status, true);
    const refused = await rpcCall(port, 's', 'txninput id:pp1 coinid:' + COIN, { owner: 'pandapools' });
    assert.equal(refused.status, false); assert.equal(refused.reserved, true);
    assert.equal(refused.error, 'Coin ' + COIN + ' is held for an AtomiX swap. Nothing was signed.');
    assert.equal((await rpcCall(port, 's', 'txninput id:w1 coinid:' + COIN)).reserved, true, 'a call that names no owner is the wallet');
    assert.deepEqual(seen.filter(c => /^txninput/.test(c)), ['txninput id:ax1 coinid:' + COIN]);
    await rpcCall(port, 's', 'txndelete id:ax1', { owner: 'atomix' });
    assert.equal((await rpcCall(port, 's', 'txninput id:pp1 coinid:' + COIN, { owner: 'pandapools' })).status, true, 'released by the txndelete');
    await rpcCall(port, 's', 'txndelete id:pp1', { owner: 'pandapools' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('every engine names itself on its node commands, and the registry follows the node', () => {
  const fs = require('node:fs'), read = (f) => fs.readFileSync(require('node:path').join(__dirname, '..', 'main', f), 'utf8');
  for (const [f, owner] of [['atomix.js', 'atomix'], ['pandapools.js', 'pandapools'], ['dexicon.js', 'dexicon']])
    assert.match(read(f), new RegExp('rpcCall\\(node\\.rpcPort\\(\\), config\\.rpcSecret\\(\\), cmd, (?:Object\\.assign\\()?\\{ owner: "' + owner + '" \\}'), f);
  const main = read('main.js');
  assert.match(main, /reserve\.open\(app\.getPath\("userData"\), reserveRead\)/);
  assert.match(main, /reserve\.close\(\)/);
  assert.match(main, /await each\("coin reservations", \(\) => reserve\.invalidate\(\)\)/);
  assert.ok(main.indexOf('reserve.open(') < main.indexOf('atomix.startLoop()'), 'opened before an engine starts');
  assert.match(read('rpc.js'), /r\.run\(command, \(c\) => reserve\.guard\(opts && opts\.owner, c, raw, opts\), opts\)/);
});

// 0.19.225: a lost (timed-out) signer holds the queue for a minimum grace as well as until `block` answers
test('a lost signer holds the queue for the minimum grace even when `block` answers at once', async () => {
  const seen = [], t0 = Date.now();
  const raw = async (c) => { seen.push([c, Date.now() - t0]); if (c.startsWith('send ')) throw new Error('RPC timeout'); return { status: true }; };
  const q = createNodeRunner(raw, { lost: () => true, pauseMs: 10, minHoldMs: 150, warn() {} });
  await assert.rejects(q.run('send amount:1 address:0x00'));
  await q.run('txnsign id:a publickey:auto');
  const next = seen.find(([c]) => c.startsWith('txnsign'));
  assert.ok(seen.some(([c]) => c === 'block'), 'block was asked'); assert.ok(next[1] >= 145, 'the next signer waited out the grace: ' + next[1] + ' ms');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'noderun.js'), 'utf8');
  assert.ok(/const minHoldMs = opts\.minHoldMs == null \? 60 \* 1000 : opts\.minHoldMs;/.test(src), 'the default grace is 60 s');
});
