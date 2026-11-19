const assert = require('node:assert/strict');
const net = require('node:net');
const { test } = require('node:test');
const { rpcCall } = require('../main/rpc');

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

test('the existing LF-header parser and UTF-8 POST length remain compatible', async () => {
  const command = 'status ' + 'é'.repeat(6000);
  await withServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = received.subarray(0, end).toString();
      const length = Number(/content-length: (\d+)/i.exec(header)?.[1]);
      if (received.length - end - 4 < length) return;
      assert.equal(length, Buffer.byteLength(command));
      assert.equal(received.subarray(end + 4).toString(), command);
      assert.match(header, /^POST \/ HTTP/);
      const body = '{"status":true,"response":{"ok":true}}';
      socket.end('HTTP/1.1 200 OK\nContent-Length: ' + Buffer.byteLength(body) + '\nConnection: close\n\n' + body);
    });
  }, async port => assert.deepEqual(await rpcCall(port, 'test-only', command), { status: true, response: { ok: true } }));
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
    const chained = rpcCall(port, 's', 'txncreate id:b;txnsign id:b publickey:auto');
    await rpcCall(port, 's', 'balance');                       // a read goes straight through
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual([...seen].sort(), ['balance', 'send amount:1 address:0x00'], 'the read went through; the second signer has not reached the node yet');
    releaseFirst();
    await Promise.all([first, second, chained]);
    assert.deepEqual(seen.slice(2), ['txnsign id:a publickey:auto', 'txncreate id:b;txnsign id:b publickey:auto'], 'signers ran one at a time, in order');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
