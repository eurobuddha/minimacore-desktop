#!/usr/bin/env node
// keets sidecar — bridges Hyperswarm/HyperDHT peer streams to the local Minima node.
//
// Every peer stream (dialed or accepted) becomes a loopback TCP connection to the
// node's own Minima port. Before piping, exactly one Minima-framed MSG_KEETS (type 24)
// preamble is injected so the Java side can flag the client and derive its synthetic
// per-pubkey identity. Frame spec: ../BRIDGE.md. After the preamble the bytes are
// end-to-end Minima protocol between the two Java nodes — this process never parses them.
//
// Runs on TWO runtimes from one source: node (desktop, incl. Electron via
// ELECTRON_RUN_AS_NODE) and bare (Android bare-kit worklet). Builtins are picked at
// runtime — node's package-"imports" can't target builtins from CJS (ERR_INVALID_URL_SCHEME,
// v24) — and all crypto goes through sodium-universal, which both runtimes load natively.
// Keep every require specifier a string literal so bare-pack can preresolve them.

const IS_BARE = typeof Bare !== 'undefined'
const VERSION = '1.3.1'

// On bare an uncaught error ABORTS the host process — inside a bare-kit worklet that
// takes the whole Android app down with SIGABRT (proven on-device 2026-10-13, missing
// addon). The node hosting us must never die for the sidecar: log and keep running.
if (IS_BARE) {
  Bare.on('uncaughtException', (err) => { console.error('keets uncaught:', err) })
  Bare.on('unhandledRejection', (err) => { console.error('keets unhandled:', err) })
}

const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const diagSnapshot = require('./diag')   // read-only counters, see diag.js
const sodium = require('sodium-universal')
const net = IS_BARE ? require('bare-tcp') : require('net')
const fs = IS_BARE ? require('bare-fs') : require('fs')
const path = IS_BARE ? require('bare-path') : require('path')
const process = IS_BARE ? require('bare-process') : require('process')

// --- args ---------------------------------------------------------------
function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def
}
const PORT = parseInt(arg('port', '9001'))
const DATADIR = arg('datadir', '.')
const TOPIC = arg('topic', 'minima-mainnet-keets-v1')
const MAXCONNS = parseInt(arg('maxconns', '6'))
// DHT duty. 'routing' (default, unchanged behaviour): the main DHT node is adaptive and becomes a
// full routing node once the network shows it is directly reachable, supporting the network for
// everyone. 'client': it never routes others' lookups (still connects, announces and receives);
// a phone passes this on battery when the user picked "DHT relay: on when plugged in".
const DHT_MODE = arg('dht-mode', 'routing') === 'client' ? 'client' : 'routing'
// --serve (1.3.0, fleet boxes): this ONE process is also the box's public DHT bootstrap
// node (fixed --dht-port, non-ephemeral from the start, never firewalled) and its keets
// mailbox (a second HyperDHT server on the mailbox keypair from <--mailbox-dir>/keypair).
// Replaces the separate hyperdht-bootstrap + keets-mailbox daemons for new boxes.
const SERVE = process.argv.includes('--serve')
const DHT_PORT = parseInt(arg('dht-port', '49737'))
const PUBLIC_HOST = arg('public-host', '')
const CONNECT = arg('connect', '').split(',').filter(Boolean)
const APIPORT = parseInt(arg('apiport', String(PORT + 5)))
// default store-and-forward mailboxes: the publicIPnodes fleet's keets-mailbox daemons
// (deployed 2026-10-13, UDP 49738). Untrusted sealed storage — they cannot read, alter
// or forge messages. Anyone can run one. --mailboxes REPLACES this list (1.3.0: the node
// passes the signed, fetched list from eurobuddha.com/keets/mailboxes.json; absent = these).
const DEFAULT_MAILBOXES = [
  '7f84f689d4477395d7c4a2493852a56fe646a8d05a94ce8b0a1baae34ac5d1df', // sally
  '9161e165df60ee780776363143701a82a2e8fb3792a0eea58577b1e4adbb35fd', // eurobuddha
  '3fb497a4eb9ae7681d5967b5fe4c6a56ecd2cd64f0357bd435115fe54dbad6e4', // maxima
  'a5335d9c6d663f8f9d97c6c65750220de479140a627ed317bb200f3167ddd4c6', // openproject
  '5febd9d332b310ec8a0baa0eacb53dc82e86f9ed77e0954fd494e2ede010693d', // vigilance
  '7e63777e3a53a97363b7b6faa16af6d08a315ecca40b76f8352165c52e139221'  // megammr
]
const MAILBOX_ARG = arg('mailboxes', '').split(',').filter(Boolean).map(m => m.replace(/^0x/i, '').toLowerCase())
const MAILBOXES = MAILBOX_ARG.length ? MAILBOX_ARG : DEFAULT_MAILBOXES
// --bootstrap none = a private DHT with no upstream (tests; a serve node that IS the root)
const BOOTSTRAP_ARG = arg('bootstrap', '')
const BOOTSTRAP = BOOTSTRAP_ARG === 'none' ? [] : BOOTSTRAP_ARG.split(',').filter(Boolean).map(s => {
  const ix = s.lastIndexOf(':')
  return { host: s.slice(0, ix), port: parseInt(s.slice(ix + 1)) }
})
const MAILBOX_DIR = arg('mailbox-dir', path.join(DATADIR, 'keets-mailbox'))

// env on desktop (never argv — visible in ps); --token only inside a bare-kit worklet,
// whose arguments live in process memory, not /proc cmdline.
const TOKEN = (process.env.KEETS_TOKEN || arg('token', '')).replace(/^0x/i, '').toLowerCase()
if (TOKEN.length !== 64) {
  console.error('KEETS_TOKEN env var missing or invalid — refusing to start')
  process.exit(1)
}

function sha256 (buf) {
  const out = Buffer.alloc(32)
  sodium.crypto_hash_sha256(out, buf)
  return out
}

// --- keypair: persistent 32-byte seed = this node's network identity ----
const keetsdir = path.join(DATADIR, 'keets')
fs.mkdirSync(keetsdir, { recursive: true })
const seedfile = path.join(keetsdir, 'keypair')
let seed
if (fs.existsSync(seedfile)) {
  seed = fs.readFileSync(seedfile)
} else {
  seed = Buffer.alloc(32)
  sodium.randombytes_buf(seed)
  fs.writeFileSync(seedfile, seed, { mode: 0o600 })
}
const keyPair = DHT.keyPair(seed)
const mypub = keyPair.publicKey.toString('hex')
fs.writeFileSync(path.join(keetsdir, 'pubkey'), '0x' + mypub + '\n')

// --- MSG_KEETS preamble (one Minima frame) -------------------------------
// [4B BE frame len][1B type=24][4B BE len=32][32B token][4B BE len=32][32B pubkey][1B initiator]
function preamble (remotePubKey, initiator) {
  const payload = Buffer.alloc(1 + 4 + 32 + 4 + 32 + 1)
  let o = 0
  payload.writeUInt8(24, o); o += 1
  payload.writeInt32BE(32, o); o += 4
  Buffer.from(TOKEN, 'hex').copy(payload, o); o += 32
  payload.writeInt32BE(32, o); o += 4
  remotePubKey.copy(payload, o); o += 32
  payload.writeUInt8(initiator ? 1 : 0, o)
  const frame = Buffer.alloc(4)
  frame.writeInt32BE(payload.length, 0)
  return Buffer.concat([frame, payload])
}

// Traffic on open peer connections only (each connection's own UDX stream), so DHT lookups and
// announces = node total minus this.
function streamStats (swarmRef) {
  const out = { connections: 0, txPackets: 0, rxPackets: 0, txBytes: 0, rxBytes: 0 }
  try {
    for (const c of swarmRef.connections) {
      const s = c.rawStream
      if (!s) continue
      out.connections++
      out.txPackets += s.packetsTransmitted || 0; out.rxPackets += s.packetsReceived || 0
      out.txBytes += s.bytesTransmitted || 0; out.rxBytes += s.bytesReceived || 0
    }
  } catch (e) {}
  return out
}

function udxStats (udx) {
  try {
    return { txPackets: udx.packetsTransmitted, rxPackets: udx.packetsReceived, txBytes: udx.bytesTransmitted, rxBytes: udx.bytesReceived }
  } catch (e) { return null }
}

// --- swarm ----------------------------------------------------------------
// Liveness heartbeat for the first minute (on-device debugging: if these stop,
// the event loop is blocked in whatever step was logged last).
let hbn = 0
const hb = setInterval(() => {
  console.log('keets hb ' + (++hbn * 5) + 's')
  if (hbn >= 12) clearInterval(hb)
}, 5000)

console.log('keets step: creating swarm')
// Phone (Bare) tuning, measured 2026-10-26: the main DHT node was ~90% of the app's packets.
// - keepalive on each peer connection every 20 s instead of 5 s (still inside mobile NAT timeouts);
// - the announcer pings its relay nodes every 6 s instead of 3 s. It re-announces after 100 ping
//   rounds, so this also moves the re-announce from ~5 to ~10 min, safely inside the 20 min that
//   other nodes keep an announcement (hyperdht defaultMaxAge). Only the announcer pauses 3000 ms.
// Desktop (Node) keeps the library defaults.
const PHONE_KEEPALIVE_MS = 20000
const PHONE_ANNOUNCE_PING_MS = 6000
if (IS_BARE) {
  const Sleeper = require('hyperdht/lib/sleeper')
  const pause = Sleeper.prototype.pause
  Sleeper.prototype.pause = function (ms) { return pause.call(this, ms === 3000 ? PHONE_ANNOUNCE_PING_MS : ms) }
}
const dhtOpts = (BOOTSTRAP.length || BOOTSTRAP_ARG === 'none') ? { bootstrap: BOOTSTRAP } : {}
if (IS_BARE) dhtOpts.connectionKeepAlive = PHONE_KEEPALIVE_MS
if (DHT_MODE === 'client') dhtOpts.ephemeral = true
if (SERVE) {
  // what DHT.bootstrapper() does, minus the empty bootstrap list: a routing node from the
  // first tick (no 20-min adaptive wait, no drop back to ephemeral), pinned to --dht-port
  // so the address clients have listed is the one we answer on.
  Object.assign(dhtOpts, { port: DHT_PORT, anyPort: false, ephemeral: false, firewalled: false })
}
const dht = new DHT(dhtOpts)
if (SERVE && PUBLIC_HOST) dht._nat.add(PUBLIC_HOST, DHT_PORT)
console.log('keets dht mode: ' + (SERVE ? 'serve (bootstrap+mailbox) udp:' + DHT_PORT + (PUBLIC_HOST ? ' host:' + PUBLIC_HOST : '') : DHT_MODE))
const swarm = new Hyperswarm({ dht, keyPair })
console.log('keets step: swarm created')

// --- services (media hosting + messages) on top of the same DHT ------------
const wire = require('./wire')
const media = require('./media')({ keetsdir, seed, bootstrap: BOOTSTRAP, maxconns: 8 })
const messages = require('./messages')({ keetsdir, dht, keyPair, mailboxes: MAILBOXES })
// Private parent/worklet IPC; never exposed to network peers or the HTTP API.
if (IS_BARE && typeof BareKit !== 'undefined') require('./worklet-lifecycle')(BareKit, media)
// serve mode: the box's own mailbox rides the same DHT on its own (published) keypair.
const mailbox = SERVE ? require('./mailbox').createMailbox({ datadir: MAILBOX_DIR, dht }) : null

let conns = 0
let svcConns = 0
const SVC_MAX = 16

function bridge (conn, publicKey, initiator, replay) {
  // An accepted link can die while we peek its first bytes (the remote's swarm dedupes or gives
  // up). Bridging a dead stream counts it forever — its 'close' already fired — and after
  // MAXCONNS of those every new link is refused at the cap (1.2.14 diag on the Fold, 2026-10-26).
  if (conn.destroyed || conn.destroying) {
    diagSnapshot.bridgeDead()
    return
  }
  if (conns >= MAXCONNS) {
    diagSnapshot.bridgeCapped()
    conn.destroy()
    return
  }
  conns++
  const pk = '0x' + publicKey.toString('hex')
  // path = the UDP endpoint actually carrying the bytes: the peer itself after a
  // successful hole punch, or a DHT relay node when punching failed (CGNAT fallback).
  const raw = conn.rawStream
  const via = raw && raw.remoteHost ? raw.remoteHost + ':' + raw.remotePort : 'unknown'
  console.log('peer connected pubkey:' + pk + ' initiator:' + initiator + ' path:' + via + ' conns:' + conns)

  const tcp = net.connect(PORT, '127.0.0.1')
  tcp.on('connect', () => {
    tcp.write(preamble(publicKey, initiator))
    if (replay && replay.length) tcp.write(replay)
    conn.pipe(tcp)
    tcp.pipe(conn)
  })
  let closer = null
  const opened = Date.now()
  tcp.on('close', () => { if (!closer) closer = 'LOCAL' })
  conn.on('end', () => { if (!closer) closer = 'REMOTE-end' })
  conn.on('error', (e) => { if (!closer) closer = 'REMOTE-err:' + ((e && e.code) || 'error'); tcp.destroy() })
  tcp.on('error', () => conn.destroy())
  conn.on('close', () => {
    diagSnapshot.bridgeClosed(closer || '?', Date.now() - opened)
    conns--
    tcp.destroy()
    console.log('peer closed pubkey:' + pk + ' conns:' + conns)
  })
  tcp.on('close', () => conn.destroy())
}

swarm.on('connection', (conn, info) => {
  conn.on('error', () => {})
  // We initiated: always a Minima link (our service dials go out via dht.connect,
  // never through the swarm) — bridge immediately, our Java greets first.
  if (conn.isInitiator) return bridge(conn, info.publicKey, true, null)
  // Accepted: peek the first bytes to route. A Minima initiator's first wire byte is
  // the high byte of a 4-byte BE frame length — 0x00 — while services open with 'KTS1'.
  // Deployed pre-1.2.0 peers never send the magic, so they route to the bridge unchanged.
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => { done(); bridge(conn, info.publicKey, false, buf) }, 15000)
  conn.once('close', () => clearTimeout(timer))
  function done () { clearTimeout(timer); conn.removeListener('data', ondata) }
  function ondata (d) {
    buf = Buffer.concat([buf, d])
    if (buf[0] !== 0x4b) { // not 'K' — Minima
      done()
      return bridge(conn, info.publicKey, false, buf)
    }
    if (buf.length < 5) return
    done()
    if (buf.slice(0, 4).equals(wire.MAGIC) && buf[4] === wire.SVC_MSG && buf.length === 5) {
      if (svcConns >= SVC_MAX) return conn.destroy()
      svcConns++
      conn.on('close', () => svcConns--)
      messages.handleConn(conn)
    } else {
      conn.destroy()
    }
  }
  conn.on('data', ondata)
})

const topic = sha256(Buffer.from(TOPIC))
console.log('keets step: joining topic')
swarm.join(topic, { server: true, client: true })
console.log('keets step: topic joined')
for (const pk of CONNECT) {
  swarm.joinPeer(Buffer.from(pk.replace(/^0x/i, ''), 'hex'))
}

console.log('keets sidecar up — pubkey:0x' + mypub + ' topic:' + TOPIC + ' node:127.0.0.1:' + PORT + ' mailboxes:' + MAILBOXES.length)
if (mailbox) {
  mailbox.listen().catch((e) => console.error('keets mailbox failed to listen: ' + e.message))
}

// --- loopback API for apps (media hosting + messaging) ---------------------
// token also written to a file so host apps that own the datadir can pick it up
fs.writeFileSync(path.join(keetsdir, 'apitoken'), TOKEN + '\n', { mode: 0o600 })
require('./api')({ port: APIPORT, token: TOKEN, mypub, media, messages, version: VERSION,
  dhtInfo: () => ({ mode: SERVE ? 'serve' : DHT_MODE, routing: !swarm.dht.ephemeral, firewalled: swarm.dht.firewalled, mediaRouting: !media.swarm.dht.ephemeral,
    mailboxes: MAILBOXES.map(m => '0x' + m),
    // fleet box: the bootstrap address to list and the mailbox pubkey to sign into the list
    serve: mailbox ? { dhtPort: DHT_PORT, publicHost: PUBLIC_HOST || null, mailboxPubkey: '0x' + mailbox.pubkey, store: mailbox.maildir } : null,
    // cumulative UDP traffic since start, per DHT node (all of its sockets and connections)
    traffic: { main: udxStats(swarm.dht.udx), media: udxStats(media.swarm.dht.udx),
      mainPeers: streamStats(swarm), mediaPeers: streamStats(media.swarm) },
    diag: diagSnapshot() }) })
media.start().then(
  (st) => console.log('keets media up — drive:' + st.drive + ' pins:' + st.pins),
  (e) => console.error('keets media failed: ' + e.message)
)
messages.start()
let flushed = false
swarm.flush().then(
  () => { flushed = true; console.log('swarm flushed — announced on DHT') },
  (e) => console.log('swarm flush FAILED: ' + (e && e.message))
)
// If the announce hasn't completed quickly, say why: how many DHT nodes we actually
// know (0 = our UDP never got a single reply) and whether a bootstrap answers a ping.
setTimeout(() => {
  if (flushed) return
  let known = -1
  try { known = swarm.dht.toArray().length } catch (e) {}
  console.log('keets diag: not announced after 20s — dht nodes known: ' + known)
  const b = BOOTSTRAP.length ? BOOTSTRAP[0] : { host: '65.109.31.226', port: 49737 }
  swarm.dht.ping(b).then(
    (r) => console.log('keets diag: ping ' + b.host + ':' + b.port + ' OK'),
    (e) => console.log('keets diag: ping ' + b.host + ':' + b.port + ' FAILED: ' + (e && e.message))
  )
}, 20000)

// App suspension (bare-kit Worklet.suspend/resume from the phone's battery policy): stop both
// swarms (their DHT ticks, keepalives and discovery) and the mailbox timer/subscription, so a
// suspended sidecar makes no network traffic and no timer wakeups. The loopback API keeps
// answering. Resume reconnects and fetches any mail stored meanwhile.
if (IS_BARE) {
  Bare.on('suspend', () => {
    console.log('keets: suspending')
    messages.suspend()
    swarm.suspend().catch(e => console.log('keets: swarm suspend failed: ' + e.message))
    media.swarm.suspend().catch(e => console.log('keets: media suspend failed: ' + e.message))
  })
  Bare.on('resume', () => {
    console.log('keets: resuming')
    swarm.resume().catch(e => console.log('keets: swarm resume failed: ' + e.message))
    media.swarm.resume().catch(e => console.log('keets: media resume failed: ' + e.message))
    messages.resume()
  })
}

// exit when the parent Minima node dies (its end of our stdin pipe closes).
// NEVER under bare: a worklet's fd 0 is /dev/null, which EOFs instantly — this very
// hook silently exited the worklet ~100ms after startup (proven on Fold 2026-10-13).
// The host app owns a worklet's lifecycle (Worklet.terminate), not stdin.
// KEETS_STDIN_EXIT=0 disables it (tests / running the sidecar standalone in a shell).
if (!IS_BARE && process.env.KEETS_STDIN_EXIT !== '0' && process.stdin && typeof process.stdin.resume === 'function') {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
}
