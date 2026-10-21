// Bounded form of media.js's flush/update/get loop. Reuses Hyperdrive's entry
// object for the blob read so a mutable path cannot change between size check
// and allocation. No profile/browser code is interpreted here.
const MAX_MEDIA_BYTES = 64 * 1024 * 1024

async function readMedia (drive, swarm, pathname, maxBytes = MAX_MEDIA_BYTES, timeout = 30000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES) {
    throw new Error('invalid media size limit')
  }
  const requests = []
  const deadline = Date.now() + timeout
  const expired = new Error('media unavailable — no reachable peer completed the request in time')
  let timer
  let stopped = false
  function check () {
    if (stopped || Date.now() >= deadline) throw expired
  }
  const read = async () => {
    while (true) {
      check()
      const done = drive.findingPeers()
      swarm.flush().then(done, done)
      await drive.update({ wait: true, activeRequests: requests })
      check()
      const opts = { update: false, wait: true, timeout: Math.max(1, deadline - Date.now()), activeRequests: requests }
      const entry = await drive.entry(pathname, opts)
      check()
      if (entry && entry.value && entry.value.blob) {
        const size = entry.value.blob.byteLength
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('media exceeds size limit')
        const bytes = await drive.get(entry, opts)
        check()
        if (!bytes || bytes.length !== size || bytes.length > maxBytes) throw new Error('incomplete media')
        return bytes
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))))
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(expired), timeout) })
    ])
  } finally {
    stopped = true
    clearTimeout(timer)
    // Same cancellation primitive used by Hypercore session.close(), scoped to
    // this request's own references; other readers and replication stay alive.
    if (drive.core.replicator) drive.core.replicator.clearRequests(requests, expired)
  }
}
module.exports = { readMedia, MAX_MEDIA_BYTES }
