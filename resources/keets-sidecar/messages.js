// keets messages — one-shot, pubkey-addressed, store-and-forward (the Maxima alternative).
//
// send(): dial the recipient's MAIN keets pubkey directly (E2E Noise — no extra crypto
// needed, the channel IS encryption + sender auth). If the peer is offline, seal the
// message to their key (sender-signed, mailbox-unreadable) and hand it to mailbox
// nodes; the recipient fetches on its next start and every POLL thereafter, proving
// ownership simply by dialing the mailbox with its own Noise key.
//
// 1.2.5 — instant store-and-forward: every recipient has a PRIMARY mailbox (chosen
// from its pubkey, so sender and recipient agree without talking). Senders store
// there first; the recipient keeps one live subscription to it and the mailbox pushes
// each stored message the moment it lands. Polling (now 45 s, all mailboxes) remains
// the fallback for old mailboxes, old senders and dropped subscriptions.
//
// Inbox = one JSON file per message under <keetsdir>/inbox; apps read/ack via the API.

const wire = require('./wire')

const IS_BARE = typeof Bare !== 'undefined'
const fs = IS_BARE ? require('bare-fs') : require('fs')
const path = IS_BARE ? require('bare-path') : require('path')

const POLL_SUBSCRIBED = 10 * 60 * 1000 // push is live: the poll only catches mail parked at non-primary mailboxes
const CLOSE_GRACE = 2000 // ms to let a final frame flush before destroy
const DIAL_TIMEOUT = 15000
const POLL = 45 * 1000
const SUB_RETRY_MIN = 5000
const DIRECT_GRACE = 1500            // how long a direct dial gets before the mailbox is also tried
const DIAL_FAIL_MEMORY = 10 * 60 * 1000  // a peer that failed to dial recently goes mailbox-first (0 grace)
const SUB_RETRY_MAX = 60000

/** The mailbox a recipient and its senders both pick first: stable across nodes
 *  because it depends only on the recipient key and the (sorted) mailbox list. */
function primaryMailbox (pkhex, mailboxes) {
  if (!mailboxes.length) return null
  const sorted = [...mailboxes].map(m => m.replace(/^0x/i, '').toLowerCase()).sort()
  const n = parseInt(pkhex.replace(/^0x/i, '').slice(0, 8), 16) >>> 0
  return sorted[n % sorted.length]
}

function hex (b) { return b.toString('hex') }

module.exports = function createMessages ({ keetsdir, dht, keyPair, mailboxes }) {
  const inboxdir = path.join(keetsdir, 'inbox')
  const dialFailed = new Map()   // peer pk -> last failed direct dial (ms)
  fs.mkdirSync(inboxdir, { recursive: true })

  function saveInbox (msg) {
    fs.writeFileSync(path.join(inboxdir, msg.id + '.json'), JSON.stringify(msg))
    console.log('keets msg received from:' + msg.from + ' via:' + msg.via + ' bytes:' + Buffer.from(msg.payload, 'base64').length)
  }

  // dial a pubkey and complete the KTS1 service handshake; resolves to a frame session.
  // ALWAYS with the dht's own ephemeral keypair, never our announced server key — raw
  // connects with an announced key open and then time out (see wire.js header); identity
  // is proven by signatures inside the protocol instead.
  function dialService (pkhex) {
    return new Promise((resolve, reject) => {
      const conn = dht.connect(Buffer.from(pkhex.replace(/^0x/i, ''), 'hex'))
      const timer = setTimeout(() => { conn.destroy(); reject(new Error('dial timeout ' + pkhex)) }, DIAL_TIMEOUT)
      conn.on('error', (e) => { clearTimeout(timer); conn.destroy(); reject(e) })
      conn.once('open', () => {
        conn.write(Buffer.concat([wire.MAGIC, Buffer.from([wire.SVC_MSG])]))
        const feed = wire.frameReader()
        let acked = false
        const waiting = []
        const queued = []
        conn.on('data', (d) => {
          try {
            if (!acked) {
              if (d[0] !== wire.ACK) throw new Error('peer does not speak keets services')
              acked = true
              clearTimeout(timer)
              resolve(session)
              d = d.slice(1)
              if (!d.length) return
            }
            for (const f of feed(d)) {
              if (waiting.length) waiting.shift()(f)
              else queued.push(f)
            }
          } catch (e) { conn.destroy(e) }
        })
        conn.on('close', () => {
          clearTimeout(timer)
          if (!acked) reject(new Error('closed before ack — peer does not speak keets services'))
          while (waiting.length) waiting.shift()(null)
        })
        const session = {
          conn,
          send: (obj) => wire.writeFrame(conn, obj),
          next: () => queued.length ? Promise.resolve(queued.shift()) : new Promise((r) => waiting.push(r)),
          // end() alone half-closes: when the far side never ends too, the stream and its UDP
          // socket stayed open forever (~160 leaked sockets/hour from mail polls, measured
          // 2026-10-24 on the Fold and desktop). Say goodbye, then always destroy.
          close: () => {
            try { conn.end() } catch (e) {}
            setTimeout(() => conn.destroy(), CLOSE_GRACE).unref?.()
          }
        }
      })
    })
  }

  async function sendDirect (tohex, payload) {
    const to = tohex.replace(/^0x/i, '').toLowerCase()
    const s = await dialService(to)
    try {
      const ts = Date.now()
      const payloadB64 = payload.toString('base64')
      s.send({
        t: 'msg',
        from: hex(keyPair.publicKey),
        ts,
        payload: payloadB64,
        sig: wire.signMsg(keyPair, to, ts, payloadB64)
      })
      const r = await s.next()
      if (!r || r.t !== 'ok') throw new Error('no ack from peer')
    } finally { s.close() }
  }

  async function sendViaMailbox (tohex, payload) {
    const to = tohex.replace(/^0x/i, '').toLowerCase()
    const sealed = wire.seal(keyPair, Buffer.from(to, 'hex'), payload)
    let lasterr = new Error('no mailboxes configured')
    // the recipient's primary first (it is subscribed there - instant push), then the
    // rest in random order so load still spreads when the primary is unreachable
    const primary = primaryMailbox(to, mailboxes)
    const order = [...mailboxes].filter(m => m.replace(/^0x/i, '').toLowerCase() !== primary).sort(() => Math.random() - 0.5)
    if (primary) order.unshift(primary)
    for (const mb of order) {
      try {
        const s = await dialService(mb)
        try {
          s.send({ t: 'store', to: tohex.replace(/^0x/i, ''), sealed: sealed.toString('base64') })
          const r = await s.next()
          if (!r || r.t !== 'ok') throw new Error((r && r.e) || 'mailbox refused')
          return mb
        } finally { s.close() }
      } catch (e) { lasterr = e }
    }
    throw lasterr
  }

  // suspend/resume (Bare app suspension): no mailbox timer, no live subscription while
  // suspended; mail keeps waiting in the mailbox and is fetched on resume.
  let suspended = false
  let pollTimer = null
  let liveStream = null
  let subLive = false
  let wakeSub = null

  return {
    // inbound KTS1/0x01 connection on the main server (magic already consumed)
    handleConn (conn) {
      conn.write(Buffer.from([wire.ACK]))
      const feed = wire.frameReader()
      const mypk = hex(keyPair.publicKey)
      conn.on('data', (d) => {
        try {
          for (const f of feed(d)) {
            if (f.t === 'msg') {
              const payload = Buffer.from(f.payload, 'base64')
              if (payload.length > wire.MAX_PAYLOAD) { wire.writeFrame(conn, { t: 'err', e: 'too large' }); continue }
              // signature binds sender identity AND this recipient (channel is E2E Noise)
              if (!/^[0-9a-f]{64}$/.test(f.from) || !wire.verifyMsg(f.from, mypk, f.ts, f.payload, f.sig)) {
                wire.writeFrame(conn, { t: 'err', e: 'bad signature' })
                continue
              }
              const id = hex(wire.sha256(Buffer.from(f.from + f.ts + f.payload)).slice(0, 16))
              saveInbox({ id, from: '0x' + f.from, ts: f.ts, payload: f.payload, via: 'direct', received: Date.now() })
              wire.writeFrame(conn, { t: 'ok' })
            } else {
              wire.writeFrame(conn, { t: 'err', e: 'not a mailbox' })
            }
          }
        } catch (e) { conn.destroy() }
      })
      conn.on('error', () => {})
    },

    // send to a keets pubkey: direct if online, else sealed to a mailbox.
    // 1.2.6: never wait on a dial that is going to fail. The direct dial races the
    // mailbox: after DIRECT_GRACE (0 for a peer whose last dial failed recently) the
    // message is ALSO stored at the recipient's primary mailbox, which pushes it to a
    // subscribed recipient at once. Both apps dedupe by message id, so a message that
    // arrives twice is stored once. `delivered` reports whichever path completed first.
    async send (tohex, payload) {
      if (payload.length > wire.MAX_PAYLOAD) throw new Error('payload over ' + wire.MAX_PAYLOAD + ' bytes — use media for big content')
      const to = tohex.replace(/^0x/i, '').toLowerCase()
      const recentFail = (dialFailed.get(to) || 0) > Date.now() - DIAL_FAIL_MEMORY
      const direct = sendDirect(to, payload).then(
        () => { dialFailed.delete(to); return { delivered: 'direct' } },
        (e) => { dialFailed.set(to, Date.now()); throw e })
      const grace = recentFail ? 0 : DIRECT_GRACE
      let viaMailbox = null
      const mailbox = new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          viaMailbox = sendViaMailbox(to, payload).then((mb) => ({ delivered: 'mailbox', mailbox: mb }))
          viaMailbox.then(resolve, reject)
        }, grace)
        direct.then(() => { if (!viaMailbox) clearTimeout(t) }, () => {})
      })
      try {
        return await Promise.any([direct, mailbox])
      } catch (e) {
        throw (e && e.errors && e.errors[e.errors.length - 1]) || e
      }
    },

    // pull sealed messages waiting at the mailboxes
    async fetchMail () {
      let got = 0
      for (const mb of mailboxes) {
        try {
          const s = await dialService(mb)
          try {
            s.send({ t: 'fetch', pk: hex(keyPair.publicKey) })
            const ch = await s.next()
            if (!ch || ch.t !== 'challenge') throw new Error('no challenge from mailbox')
            s.send({ t: 'proof', sig: wire.signFetch(keyPair, ch.nonce) })
            while (true) {
              const f = await s.next()
              if (!f || f.t === 'done') break
              if (f.t !== 'stored') continue
              try {
                const sealed = Buffer.from(f.sealed, 'base64')
                const m = wire.unseal(keyPair, sealed)
                const id = hex(wire.sha256(sealed).slice(0, 16))
                saveInbox({ id, from: m.from, ts: m.ts, payload: m.payload.toString('base64'), via: 'mailbox', received: Date.now() })
                got++
              } catch (e) { console.log('keets mail: dropped bad sealed msg: ' + e.message) }
              wire.writeFrame(s.conn, { t: 'ack', id: f.id })
            }
          } finally { s.close() }
        } catch (e) { /* mailbox unreachable — try next, retry next poll */ }
      }
      return got
    },

    inbox () {
      const out = []
      for (const f of fs.readdirSync(inboxdir)) {
        if (!f.endsWith('.json')) continue
        try { out.push(JSON.parse(fs.readFileSync(path.join(inboxdir, f), 'utf8'))) } catch (e) {}
      }
      return out.sort((a, b) => a.received - b.received)
    },

    ackMessage (id) {
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('bad id')
      fs.unlinkSync(path.join(inboxdir, id + '.json'))
    },

    /** Live subscription to our primary mailbox: stored messages arrive as pushes.
     *  Reconnects with backoff; an old mailbox (no sub:true in done) is retried slowly
     *  while the poll covers it. Never throws. */
    async subscribeLoop () {
      const me = hex(keyPair.publicKey)
      const primary = primaryMailbox(me, mailboxes)
      if (!primary) return
      let wait = SUB_RETRY_MIN
      let announced = false
      while (true) {
        try {
          if (suspended) await new Promise(r => { wakeSub = r })
          const s = await dialService(primary)
          liveStream = s
          try {
            s.send({ t: 'fetch', pk: me, sub: true })
            const ch = await s.next()
            if (!ch || ch.t !== 'challenge') throw new Error('no challenge from mailbox')
            s.send({ t: 'proof', sig: wire.signFetch(keyPair, ch.nonce) })
            let live = false
            while (true) {
              const f = await s.next()
              if (!f) break                                   // connection closed
              if (f.t === 'done') {
                if (!f.sub) throw new Error('mailbox has no push support')
                live = true; subLive = true; wait = SUB_RETRY_MIN
                if (!announced) { announced = true; console.log('keets mail: subscribed to mailbox ' + primary + ' (push)') }
                continue
              }
              if (f.t !== 'stored') continue
              try {
                const sealed = Buffer.from(f.sealed, 'base64')
                const m = wire.unseal(keyPair, sealed)
                const id = hex(wire.sha256(sealed).slice(0, 16))
                saveInbox({ id, from: m.from, ts: m.ts, payload: m.payload.toString('base64'), via: live ? 'mailbox-push' : 'mailbox', received: Date.now() })
              } catch (e) { console.log('keets mail: dropped bad sealed msg: ' + e.message) }
              wire.writeFrame(s.conn, { t: 'ack', id: f.id })
            }
          } finally { liveStream = null; subLive = false; s.close() }
        } catch (e) { /* unreachable / old mailbox / dropped - back off and retry */ }
        if (suspended) continue                                // resume restarts at once
        await new Promise(r => setTimeout(r, wait))
        wait = Math.min(SUB_RETRY_MAX, wait * 2)
      }
    },

    start () {
      const poll = () => this.fetchMail().then(
        (n) => { if (n) console.log('keets mail: fetched ' + n + ' stored message(s)') },
        () => {}
      )
      // Self-scheduling: every 45 s while the push subscription is down, every 10 min while it is live.
      const loop = () => {
        pollTimer = null
        if (suspended) return
        poll()
        pollTimer = setTimeout(loop, subLive ? POLL_SUBSCRIBED : POLL)
      }
      this._loop = loop
      this._poll = poll
      pollTimer = setTimeout(loop, 10000) // after the swarm is up
      setTimeout(() => this.subscribeLoop(), 12000)
    },

    suspend () {
      if (suspended) return
      suspended = true
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (liveStream) liveStream.close()
    },

    resume () {
      if (!suspended) return
      suspended = false
      if (this._loop && !pollTimer) this._loop()     // fetch at once, then follow the cadence
      if (wakeSub) { const w = wakeSub; wakeSub = null; w() }
    },

    isSuspended () { return suspended }
  }
}
module.exports.primaryMailbox = primaryMailbox
