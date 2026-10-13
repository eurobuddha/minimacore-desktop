// keets services wire format — shared by the sidecar (node + bare) and mailbox daemon.
//
// A service connection is a plain HyperDHT Noise stream to a node's MAIN pubkey:
//   dialer  -> 'KTS1' + 1 service byte          (Minima frames never start with 'K',
//   acceptor-> 0x4F ack                          so the bridge peeks and routes)
//   then both sides exchange frames: [4B BE len][utf8 JSON], len <= 1MB.
// Service connections are dialed with an EPHEMERAL keypair: dialing with a pubkey
// that is announced as a DHT server breaks raw hyperdht connects (proven locally
// 2026-10-13 — opens, then 'connection timed out'), so identity is proven inside
// the protocol with ed25519 signatures instead of the Noise remote key.
// Service 0x01 = messages. Frame types:
//   {t:'msg', from, ts, payload, sig}  direct message; sig = sign('KMSG1'+to+ts+payload)
//                                      by `from`, where to = acceptor's pubkey (binds
//                                      the message to this recipient, E2E via Noise)
//   {t:'store', to, sealed}            mailbox store: sealed box only `to` can open
//   {t:'fetch', pk}                    mailbox fetch: claim pk, then prove it:
//   {t:'challenge', nonce}             mailbox -> fetcher
//   {t:'proof', sig}                   sig = sign('KFETCH1'+nonce) by pk
//   {t:'stored', id, sealed}           mailbox -> fetcher, one per stored message
//   {t:'ack', id}                      fetcher -> mailbox, delete id
//   {t:'done'} {t:'ok'} {t:'err',e}
// Sealed blobs: JSON {m:<b64 of JSON {from,ts,payload}>, sig:<b64 ed25519 sig over m>}
// sealed with crypto_box_seal to the recipient's curve25519 key — mailboxes cannot
// read, alter, or forge messages.

const sodium = require('sodium-universal')

const MAGIC = Buffer.from('KTS1')
const SVC_MSG = 0x01
const ACK = 0x4f
const MAX_FRAME = 1024 * 1024
const MAX_PAYLOAD = 256 * 1024

function writeFrame (stream, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  stream.write(Buffer.concat([head, body]))
}

// incremental frame parser: feed(data) -> array of parsed objects (throws on oversize/junk)
function frameReader () {
  let buf = Buffer.alloc(0)
  return function feed (data) {
    buf = Buffer.concat([buf, data])
    const out = []
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0)
      if (len > MAX_FRAME) throw new Error('frame too large')
      if (buf.length < 4 + len) break
      out.push(JSON.parse(buf.slice(4, 4 + len).toString('utf8')))
      buf = buf.slice(4 + len)
    }
    return out
  }
}

function sha256 (b) {
  const out = Buffer.alloc(32)
  sodium.crypto_hash_sha256(out, b)
  return out
}

// --- protocol signatures (identity proof over the wire) ---------------------
function signMsg (fromKeyPair, toHex, ts, payloadB64) {
  const m = Buffer.from('KMSG1' + toHex + ts + payloadB64, 'utf8')
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, m, fromKeyPair.secretKey)
  return sig.toString('base64')
}

function verifyMsg (fromHex, toHex, ts, payloadB64, sigB64) {
  const m = Buffer.from('KMSG1' + toHex + ts + payloadB64, 'utf8')
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(sigB64, 'base64'), m, Buffer.from(fromHex, 'hex'))
  } catch (e) { return false }
}

function signFetch (keyPair, nonceHex) {
  const m = Buffer.from('KFETCH1' + nonceHex, 'utf8')
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, m, keyPair.secretKey)
  return sig.toString('base64')
}

function verifyFetch (pkHex, nonceHex, sigB64) {
  const m = Buffer.from('KFETCH1' + nonceHex, 'utf8')
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(sigB64, 'base64'), m, Buffer.from(pkHex, 'hex'))
  } catch (e) { return false }
}

// --- sealed sender-signed envelope (for mailbox storage) --------------------
function seal (fromKeyPair, toEdPubKey, payload) {
  const m = Buffer.from(JSON.stringify({
    from: fromKeyPair.publicKey.toString('hex'),
    ts: Date.now(),
    payload: payload.toString('base64')
  }), 'utf8')
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, m, fromKeyPair.secretKey)
  const inner = Buffer.from(JSON.stringify({ m: m.toString('base64'), sig: sig.toString('base64') }), 'utf8')
  const curvePk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(curvePk, toEdPubKey)
  const sealed = Buffer.alloc(inner.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(sealed, inner, curvePk)
  return sealed
}

function unseal (myKeyPair, sealed) {
  const curvePk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const curveSk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(curvePk, myKeyPair.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(curveSk, myKeyPair.secretKey)
  const inner = Buffer.alloc(sealed.length - sodium.crypto_box_SEALBYTES)
  if (!sodium.crypto_box_seal_open(inner, sealed, curvePk, curveSk)) throw new Error('unseal failed')
  const { m, sig } = JSON.parse(inner.toString('utf8'))
  const mbuf = Buffer.from(m, 'base64')
  const env = JSON.parse(mbuf.toString('utf8'))
  const ok = sodium.crypto_sign_verify_detached(Buffer.from(sig, 'base64'), mbuf, Buffer.from(env.from, 'hex'))
  if (!ok) throw new Error('bad sender signature')
  return { from: '0x' + env.from, ts: env.ts, payload: Buffer.from(env.payload, 'base64') }
}

module.exports = {
  MAGIC, SVC_MSG, ACK, MAX_FRAME, MAX_PAYLOAD,
  writeFrame, frameReader, seal, unseal, sha256,
  signMsg, verifyMsg, signFetch, verifyFetch
}
