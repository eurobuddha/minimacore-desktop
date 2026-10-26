// keets diagnostics (battery work, 2026-10-26): counts what the DHT does on this device so the phone
// can see WHY it receives ~20 packets/s with no peer connections. Read-only wrappers: every wrapped
// function still runs exactly as before. Exposed through GET /info as dht.diag.
const DHT = require('hyperdht')
const Server = require('hyperdht/lib/server')
const { COMMANDS } = require('hyperdht/lib/constants')

const EXTERNAL = Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [v, k]))
const INTERNAL = { 0: 'PING', 1: 'PING_NAT', 2: 'FIND_NODE', 3: 'DOWN_HINT', 4: 'DELAYED_PING' }

const d = {
  since: Date.now(),
  requests: {},          // incoming DHT requests by command (i: = dht-rpc internal)
  inHandshake: 0,        // someone asked to connect to a server on this device
  inHolepunch: 0,        // holepunch rounds for those attempts
  inConnected: 0,        // ... and how many became a connection
  aborts: {},            // ... and why the rest were aborted (hyperdht ERROR code)
  outConnect: 0,         // our own dht.connect() calls (mail, direct messages, swarm peers)
  outOpen: 0,
  outErrors: {},
  bridge: { capped: 0, dead: 0, closedBy: {}, lived: {} } // Minima bridge links: who ended them, how long they lived
}
const handshakePeers = new Map()
const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }

const onrequest = DHT.prototype._onrequest
DHT.prototype._onrequest = function (req, external) {
  try { bump(d.requests, req.internal ? 'i:' + (INTERNAL[req.command] || req.command) : (EXTERNAL[req.command] || 'x' + req.command)) } catch (e) {}
  return onrequest.call(this, req, external)
}

const onhandshake = Server.prototype._onpeerhandshake
Server.prototype._onpeerhandshake = function (msg, req) {
  try {
    d.inHandshake++
    const from = msg && msg.peerAddress ? msg.peerAddress.host : (req && req.from ? req.from.host : '?')
    handshakePeers.set(from, (handshakePeers.get(from) || 0) + 1)
  } catch (e) {}
  return onhandshake.call(this, msg, req)
}

const onholepunch = Server.prototype._onpeerholepunch
Server.prototype._onpeerholepunch = function (msg, req) {
  d.inHolepunch++
  return onholepunch.call(this, msg, req)
}

const abort = Server.prototype._abort
Server.prototype._abort = function (h, error) {
  bump(d.aborts, String(error === undefined ? 'ABORTED' : error))
  return abort.call(this, h, error)
}

const emit = Server.prototype.emit
Server.prototype.emit = function (name, ...args) {
  if (name === 'connection') d.inConnected++
  return emit.call(this, name, ...args)
}

const connect = DHT.prototype.connect
DHT.prototype.connect = function (...args) {
  d.outConnect++
  const s = connect.apply(this, args)
  try {
    s.once('open', () => { d.outOpen++ })
    s.once('error', (e) => bump(d.outErrors, (e && (e.code || e.message)) || 'error'))
  } catch (e) {}
  return s
}

function snapshot () {
  const top = [...handshakePeers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return { ...d, uptimeS: Math.round((Date.now() - d.since) / 1000), handshakeFromHosts: handshakePeers.size, topHandshakeHosts: top }
}

// A bridged Minima link ended: closer is LOCAL (our node), REMOTE-end / REMOTE-err:<code>, or ?.
snapshot.bridgeClosed = function (closer, ms) {
  bump(d.bridge.closedBy, closer)
  bump(d.bridge.lived, ms < 1000 ? '<1s' : ms < 10000 ? '<10s' : ms < 60000 ? '<60s' : ms < 600000 ? '<10m' : '>=10m')
}
snapshot.bridgeCapped = function () { d.bridge.capped++ }
snapshot.bridgeDead = function () { d.bridge.dead++ }
module.exports = snapshot
