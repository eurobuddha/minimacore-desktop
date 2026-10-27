// Parent-only Bare Kit IPC. Reply only after every media store has released its locks.
module.exports = function registerLifecycle (kit, media) {
  kit.on('push', (payload, reply) => {
    if (payload.toString() !== 'close-media-v1') return reply(new Error('Unknown worklet control'))
    // Both branches handle the promise: an unhandled rejection can abort a Bare host.
    Promise.resolve().then(() => media.close()).then(
      () => reply(null, 'media-closed-v1'),
      error => reply(error)
    )
  })
}
