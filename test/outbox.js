// A queued message must reach the peer even when no room proof arrives to trigger the
// replay. Reproduces the strand: a message queued while nothing was connected, then a
// live connection that was already proven, so nothing replays it.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'

function tmpdir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ct-${label}-`))
}

function waitFor (emitter, event, pred = () => true, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    const onEvent = v => {
      if (!pred(v)) return
      clearTimeout(t)
      emitter.off(event, onEvent)
      resolve(v)
    }
    emitter.on(event, onEvent)
  })
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const alice = new Together({ store: new Store(tmpdir('alice')), bootstrap })
const bob = new Together({ store: new Store(tmpdir('bob')), bootstrap })
alice.store.setName('alice')
bob.store.setName('bob')
await alice.start()
await bob.start()

const inv = alice.createInvite('outbox-room')
await bob.joinWithCode(inv.code)
await Promise.all([waitFor(alice, 'peer-joined'), waitFor(bob, 'peer-joined')])
const roomId = alice.store.roomByName('outbox-room').id

async function linked (node, name) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (node.status().rooms.find(r => r.name === name)?.connectedPeers.length) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`${name} never got a connected peer`)
}
await Promise.all([linked(alice, 'outbox-room'), linked(bob, 'outbox-room')])

console.log('1. A message sent with nothing connected is queued…')
// Hide the live connection so the send takes the queue-only path, exactly as it does
// when the peer really is away. Restoring it afterwards leaves a proven connection
// that no further proof will arrive on — the situation that stranded the message.
const conns = alice.roomConns.get(roomId)
alice.roomConns.set(roomId, new Set())
const res = alice.sendMessage('outbox-room', 'queued while away')
assert.equal(res.queued, true, 'with no connection the send must queue')
assert.equal(alice.store.outboundFor(roomId).length, 1)
alice.roomConns.set(roomId, conns)

console.log('2. Nothing else delivers it — this is the strand…')
// The connection is live and already proven, so no replay is coming. Without the
// retry this message sits in the outbox for the life of the process.
await new Promise(r => setTimeout(r, 3000))
assert.equal(alice.store.outboundFor(roomId).length, 1,
  'a live proven connection must not deliver it on its own, or this test proves nothing')

console.log('3. The retry delivers it and the outbox drains…')
const got = waitFor(bob, 'message', m => m.text === 'queued while away')
alice.retryOutbound()
const seen = await got
assert.equal(seen.roomName, 'outbox-room')

const drained = Date.now() + 15_000
while (alice.store.outboundFor(roomId).length > 0 && Date.now() < drained) {
  await new Promise(r => setTimeout(r, 200))
}
assert.equal(alice.store.outboundFor(roomId).length, 0, 'the ack must clear the outbox')

console.log('4. Retrying a message the peer already holds still clears the outbox…')
// The receiver dedups by id but acks first, so a duplicate is not a stuck message.
const again = alice.sendMessage('outbox-room', 'delivered once')
await waitFor(bob, 'message', m => m.text === 'delivered once')
alice.store.enqueueOutbound({ ...alice.store.logTail(roomId).find(m => m.id === again.id) })
assert.equal(alice.store.outboundFor(roomId).length, 1, 're-queued for the test')
alice.retryOutbound()
const redrained = Date.now() + 15_000
while (alice.store.outboundFor(roomId).length > 0 && Date.now() < redrained) {
  await new Promise(r => setTimeout(r, 200))
}
assert.equal(alice.store.outboundFor(roomId).length, 0, 'a duplicate must be acked too')

console.log('5. Retrying with nothing connected leaves the message queued…')
const parked = alice.roomConns.get(roomId)
alice.roomConns.set(roomId, new Set())
alice.sendMessage('outbox-room', 'still away')
alice.retryOutbound()
assert.equal(alice.store.outboundFor(roomId).length, 1, 'nothing to send to, nothing lost')
alice.roomConns.set(roomId, parked)

await alice.stop()
await bob.stop()
await testnet.destroy()
console.log('\nAll outbox retry tests passed.')
process.exit(0)
