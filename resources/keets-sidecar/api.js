// keets loopback API — the ONLY thing an app (Atellier, the Salon, any MiniDapp or APK)
// needs to host media or message by pubkey. No server, no config: the sidecar is already
// running next to the node; this binds 127.0.0.1:<minima port + 5>.
//
// Auth: every request carries header  x-keets-token: <KEETS_TOKEN hex>  (the per-boot
// token the node/app already holds; also written to <keetsdir>/apitoken, mode 0600).
// CORS is open so MiniDapp webviews can call it directly — the token is the gate.
//
//   GET    /info                         -> { pubkey, drive, apiport, version }
//   POST   /media/<path>   (raw bytes)   -> { url, drive, path, hash, size }   host a file
//   GET    /media?url=keets://...        -> the bytes (fetched P2P, then re-seeded)
//   GET    /files                        -> own drive listing
//   DELETE /media/<path>                 -> remove from own drive
//   POST   /pin    {"url"|"drive": ...}  -> mirror a drive permanently
//   GET    /pins          DELETE /pin/<drivekey>
//   POST   /message {"to":"0x..","payload":"text"|"payloadb64":".."} -> {delivered}
//   GET    /messages                     -> inbox   DELETE /message/<id> -> ack

const IS_BARE = typeof Bare !== 'undefined'
const http = IS_BARE ? require('bare-http1') : require('http')

const MAX_BODY = 64 * 1024 * 1024

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', json: 'application/json', txt: 'text/plain'
}

module.exports = function startApi ({ port, token, mypub, media, messages, version }) {
  function send (res, code, body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    res.writeHead(code, {
      'content-type': type || 'application/json',
      'content-length': buf.length,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'x-keets-token, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
    })
    res.end(buf)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    let len = 0
    req.on('data', (d) => {
      len += d.length
      if (len > MAX_BODY) { req.destroy(); return }
      chunks.push(d)
    })
    req.on('end', () => handle(req, res, Buffer.concat(chunks)).catch((e) => send(res, 500, { error: e.message })))
    req.on('error', () => {})
  })

  async function handle (req, res, body) {
    if (req.method === 'OPTIONS') return send(res, 204, Buffer.alloc(0), 'text/plain')
    if ((req.headers['x-keets-token'] || '').replace(/^0x/i, '').toLowerCase() !== token) {
      return send(res, 401, { error: 'bad or missing x-keets-token header' })
    }
    const q = req.url.indexOf('?')
    const pathname = decodeURIComponent(q === -1 ? req.url : req.url.slice(0, q))
    const query = {}
    if (q !== -1) {
      for (const kv of req.url.slice(q + 1).split('&')) {
        const eq = kv.indexOf('=')
        if (eq !== -1) query[kv.slice(0, eq)] = decodeURIComponent(kv.slice(eq + 1))
      }
    }

    if (req.method === 'GET' && pathname === '/info') {
      const st = await media.start() // idempotent: returns own drive key
      return send(res, 200, { pubkey: '0x' + mypub, drive: st.drive, apiport: port, version })
    }

    if (pathname === '/media' || pathname.startsWith('/media/')) {
      if (req.method === 'POST') {
        const p = pathname.slice('/media'.length) || '/file'
        if (!body.length) return send(res, 400, { error: 'empty body' })
        return send(res, 200, await media.publish(p, body))
      }
      if (req.method === 'GET') {
        // /media?url=keets://<drive>/<path>?hash=..  or  /media/<64-hex drive>/<path>
        let url = query.url
        if (!url) {
          const m = /^\/media\/([0-9a-fA-F]{64})(\/.*)$/.exec(pathname)
          if (!m) return send(res, 400, { error: 'need ?url=keets://... or /media/<drivekey>/<path>' })
          url = 'keets://' + m[1] + m[2] + (query.hash ? '?hash=' + query.hash : '')
        }
        const buf = await media.fetch(url)
        const ext = url.split('?')[0].split('.').pop().toLowerCase()
        return send(res, 200, buf, TYPES[ext] || 'application/octet-stream')
      }
      if (req.method === 'DELETE') {
        await media.remove(pathname.slice('/media'.length))
        return send(res, 200, { removed: true })
      }
    }

    if (req.method === 'GET' && pathname === '/files') return send(res, 200, await media.list())

    if (req.method === 'POST' && pathname === '/pin') {
      const j = JSON.parse(body.toString())
      return send(res, 200, await media.pin(j.url || j.drive))
    }
    if (req.method === 'GET' && pathname === '/pins') return send(res, 200, media.pinsList())
    if (req.method === 'DELETE' && pathname.startsWith('/pin/')) {
      await media.unpin(pathname.slice(5))
      return send(res, 200, { unpinned: true })
    }

    if (req.method === 'POST' && pathname === '/message') {
      const j = JSON.parse(body.toString())
      if (!j.to) return send(res, 400, { error: 'need "to": 0x<64-hex keets pubkey>' })
      const payload = j.payloadb64 ? Buffer.from(j.payloadb64, 'base64') : Buffer.from(String(j.payload || ''), 'utf8')
      return send(res, 200, await messages.send(j.to, payload))
    }
    if (req.method === 'GET' && pathname === '/messages') return send(res, 200, messages.inbox())
    if (req.method === 'DELETE' && pathname.startsWith('/message/')) {
      messages.ackMessage(pathname.slice('/message/'.length))
      return send(res, 200, { acked: true })
    }

    send(res, 404, { error: 'unknown endpoint' })
  }

  server.listen(port, '127.0.0.1', () => {
    console.log('keets api up on 127.0.0.1:' + port)
  })
  server.on('error', (e) => console.error('keets api error: ' + e.message))
  return server
}
