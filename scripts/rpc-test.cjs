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

// CHANGED on purpose (0.18.240, as Pandamonium Desktop 0.19.305, correcting 0.18.239): a POST body is pure ASCII, so the shipped node (Content-Length read as CHARACTERS) and a fixed
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
  const i = ax.indexOf('function truncDp('), truncDp = new Function(ax.slice(i, ax.indexOf('\n}\n', i) + 3) + '\nreturn truncDp;')();
  assert.equal(truncDp(12.3456789, 6), '12.345678'); assert.equal(truncDp(1.9999999, 6), '1.999999'); assert.equal(truncDp(5, 6), '5.000000');
  // 0.18.218: an exponent form is cut exactly too (toFixed rounded it)
  assert.equal(truncDp(1.9999999e-5, 6), '0.000019'); assert.equal(truncDp(1e-7, 6), '0.000000'); assert.equal(truncDp(1.5e21, 2), '1500000000000000000000.00'); assert.equal(truncDp(-2.75e-3, 4), '-0.0027');
  const j = ax.indexOf('function ethCleanSymbol('), clean = new Function('lc', ax.slice(j, ax.indexOf('\n}\n', j) + 3) + '\nreturn ethCleanSymbol;')((x) => String(x).toLowerCase());
  assert.equal(clean('', '0xDAC17F958D2EE523A2206206994597C13D831EC7'), '0xdac17f958d2ee523a2206206994597c13d831ec7', 'no symbol: the whole contract address');
});
