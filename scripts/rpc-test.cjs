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

// ---- 0.18.211: a reply that is not JSON is reported without its body ----
test('a non-JSON reply is refused without any of its text in the error', async () => {
  const SECRET = 'apple banana cherry seed words';
  await withServer(socket => socket.once('data', () => {
    const body = '<html>' + SECRET + '</html>';
    socket.end('HTTP/1.1 500 Server Error\r\nContent-Length: ' + body.length + '\r\nConnection: close\r\n\r\n' + body);
  }), async port => {
    await assert.rejects(rpcCall(port, 'test-only', 'status'), (e) => /bad RPC reply \(HTTP 500, \d+ characters, not JSON\)/.test(e.message) && !e.message.includes('apple'));
  });
});

test('identifiers are whole in main and the ETH files are written whole; the amount a swap needs is cut, not rounded', () => {
  const fs = require('node:fs'), path = require('node:path'), M = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ax = M('main/atomix.js');
  assert.ok(!/A\.wallet\.shortAddr\(/.test(ax), 'no shortened ETH address handed to the screen');
  assert.ok(!/String\(b\.tokenid\)\.slice\(/.test(M('main/webwallet.js') + M('main/vestr.js')), 'a token without a name shows its whole id');
  assert.ok(/<div class="mono ew-addr__v">\$\{esc\(b\.address\)\}<\/div>/.test(M('renderer/app.js')), 'the ETH wallet shows the whole address');
  assert.ok(/writeAtomic\(ETH_TOKENS_FILE\(\)/.test(ax) && /writeAtomic\(ETH_RPC_FILE\(\)/.test(ax), 'both ETH files go through temp and rename');
  assert.ok(!/Need ≈/.test(ax) && !/totalUsdt\.toFixed/.test(ax));
  const i = ax.indexOf('function truncDp('), truncDp = new Function(ax.slice(i, ax.indexOf('\n', i)) + '\nreturn truncDp;')();
  assert.equal(truncDp(12.3456789, 6), '12.345678'); assert.equal(truncDp(1.9999999, 6), '1.999999'); assert.equal(truncDp(5, 6), '5.000000');
  const j = ax.indexOf('function ethCleanSymbol('), clean = new Function('lc', ax.slice(j, ax.indexOf('\n}\n', j) + 3) + '\nreturn ethCleanSymbol;')((x) => String(x).toLowerCase());
  assert.equal(clean('', '0xDAC17F958D2EE523A2206206994597C13D831EC7'), '0xdac17f958d2ee523a2206206994597c13d831ec7', 'no symbol: the whole contract address');
});
