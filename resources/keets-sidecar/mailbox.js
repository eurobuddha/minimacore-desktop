#!/usr/bin/env node
// keets mailbox daemon — store-and-forward for offline keets nodes. Runs on any
// public-IP box (our bootstrap fleet runs one each); node runtime only.
//
// It is a plain HyperDHT server speaking the KTS1/0x01 message protocol (see wire.js):
//   store: anyone may deposit a sealed box addressed to a recipient pubkey — the
//          mailbox cannot read, alter or forge it (sealed to the recipient, signed
//          by the sender).
//   fetch: the recipient dials in; its Noise key IS the proof of ownership — the
//          mailbox hands over everything addressed to conn.remotePublicKey and
//          deletes each message on ack.
// Caps: 256KB/message (wire.MAX_PAYLOAD + envelope), 16MB/recipient, 1GB total,
// 30-day TTL (hourly sweep). Untrusted commodity storage — anyone can run one.
//
// Usage: node mailbox.js --datadir /var/lib/keets-mailbox [--bootstrap host:port,...]

const DHT = require('hyperdht')
const sodium = require('sodium-universal')
const fs = require('fs')
const path = require('path')
const wire = require('./wire')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def
}
const DATADIR = arg('datadir', '.')
const PORT = parseInt(arg('port', '0')) // fixed UDP bind port (open it in the firewall); 0 = ephemeral
const BOOTSTRAP = arg('bootstrap', '').split(',').filter(Boolean).map(s => {
  const ix = s.lastIndexOf(':')
  return { host: s.slice(0, ix), port: parseInt(s.slice(ix + 1)) }
})

const MSG_CAP = wire.MAX_PAYLOAD + 4096
const RECIPIENT_CAP = 16 * 1024 * 1024
const TOTAL_CAP = 1024 * 1024 * 1024
const TTL = 30 * 24 * 3600 * 1000

const maildir = path.join(DATADIR, 'mail')
fs.mkdirSync(maildir, { recursive: true })

// persistent identity
const seedfile = path.join(DATADIR, 'keypair')
let seed
if (fs.existsSync(seedfile)) {
  seed = fs.readFileSync(seedfile)
} else {
  seed = Buffer.alloc(32)
  sodium.randombytes_buf(seed)
  fs.writeFileSync(seedfile, seed, { mode: 0o600 })
}
const keyPair = DHT.keyPair(seed)

function dirSize (dir) {
  let n = 0
  try { for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size } catch (e) {}
  return n
}
function totalSize () {
  let n = 0
  try { for (const d of fs.readdirSync(maildir)) n += dirSize(path.join(maildir, d)) } catch (e) {}
  return n
}

function sweep () {
  const cutoff = Date.now() - TTL
  for (const d of (fs.existsSync(maildir) ? fs.readdirSync(maildir) : [])) {
    const rdir = path.join(maildir, d)
    for (const f of fs.readdirSync(rdir)) {
      const p = path.join(rdir, f)
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p) } catch (e) {}
    }
    try { if (!fs.readdirSync(rdir).length) fs.rmdirSync(rdir) } catch (e) {}
  }
}
setInterval(sweep, 3600 * 1000)
sweep()

const dhtOpts = {}
if (PORT) dhtOpts.port = PORT
if (BOOTSTRAP.length) dhtOpts.bootstrap = BOOTSTRAP
const dht = new DHT(dhtOpts)
const server = dht.createServer((conn) => {
  conn.on('error', () => {})
  let routed = false
  let head = Buffer.alloc(0)
  const feed = wire.frameReader()
  // fetch auth state: clients dial with ephemeral keys, so ownership of a recipient
  // pubkey is proven by signing our nonce — only then do stored messages flow / acks delete.
  let claimedPk = null
  let nonce = null
  let authedPk = null
  conn.on('data', (d) => {
    try {
      if (!routed) {
        head = Buffer.concat([head, d])
        if (head.length < 5) return
        if (!head.slice(0, 4).equals(wire.MAGIC) || head[4] !== wire.SVC_MSG) { conn.destroy(); return }
        routed = true
        conn.write(Buffer.from([wire.ACK]))
        d = head.slice(5)
        if (!d.length) return
      }
      for (const f of feed(d)) handle(f)
    } catch (e) { conn.destroy() }
  })

  function handle (f) {
    if (f.t === 'store') {
      const sealed = Buffer.from(f.sealed, 'base64')
      if (!/^[0-9a-f]{64}$/.test(f.to) || sealed.length > MSG_CAP) {
        return wire.writeFrame(conn, { t: 'err', e: 'bad store' })
      }
      const rdir = path.join(maildir, f.to)
      if (dirSize(rdir) + sealed.length > RECIPIENT_CAP) return wire.writeFrame(conn, { t: 'err', e: 'recipient box full' })
      if (totalSize() + sealed.length > TOTAL_CAP) return wire.writeFrame(conn, { t: 'err', e: 'mailbox full' })
      fs.mkdirSync(rdir, { recursive: true })
      const id = wire.sha256(sealed).slice(0, 16).toString('hex')
      fs.writeFileSync(path.join(rdir, id + '.bin'), sealed)
      wire.writeFrame(conn, { t: 'ok' })
    } else if (f.t === 'fetch') {
      if (!/^[0-9a-f]{64}$/.test(f.pk)) return wire.writeFrame(conn, { t: 'err', e: 'bad pk' })
      claimedPk = f.pk
      const n = Buffer.alloc(32)
      sodium.randombytes_buf(n)
      nonce = n.toString('hex')
      wire.writeFrame(conn, { t: 'challenge', nonce })
    } else if (f.t === 'proof') {
      if (!claimedPk || !nonce || !wire.verifyFetch(claimedPk, nonce, f.sig)) {
        return wire.writeFrame(conn, { t: 'err', e: 'bad proof' })
      }
      authedPk = claimedPk
      const rdir = path.join(maildir, authedPk)
      for (const file of (fs.existsSync(rdir) ? fs.readdirSync(rdir) : [])) {
        if (!file.endsWith('.bin')) continue
        wire.writeFrame(conn, { t: 'stored', id: file.slice(0, -4), sealed: fs.readFileSync(path.join(rdir, file)).toString('base64') })
      }
      wire.writeFrame(conn, { t: 'done' })
    } else if (f.t === 'ack') {
      if (!authedPk || !/^[0-9a-f]{32}$/.test(f.id)) return
      try { fs.unlinkSync(path.join(maildir, authedPk, f.id + '.bin')) } catch (e) {}
    } else {
      wire.writeFrame(conn, { t: 'err', e: 'mailboxes only store/fetch' })
    }
  }
})

server.listen(keyPair).then(() => {
  console.log('keets mailbox up — pubkey:0x' + keyPair.publicKey.toString('hex') + ' store:' + maildir)
})
