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
