// A rendezvous id is public and never expires, so it has to keep working after the
// session that opened it restarts. Before this was persisted, a restart silently
// voided the id: the friend answered a meeting point nobody was listening on, and
// nothing on either side said so.
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

async function peerNamed (node, id, name, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = node.status().pendingPairings.find(s => s.id === id)
    const peer = session?.peers.find(p => p.name === name)
    if (peer) return peer
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`${name} never answered rendezvous ${id}`)
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap
const aliceDir = tmpdir('alice')

let alice = new Together({ store: new Store(aliceDir), bootstrap })
const bob = new Together({ store: new Store(tmpdir('bob')), bootstrap })
alice.store.setName('alice')
bob.store.setName('bob')
await alice.start()
await bob.start()

console.log('1. An open rendezvous is written to the store…')
const pairing = alice.createPairing('restart-room')
assert.deepEqual(alice.store.pairings().map(p => p.id), [pairing.id])
const savedEph = alice.store.pairings()[0].eph.publicKey

console.log('2. It comes back after a restart, with the same agreement key…')
await alice.stop()
alice = new Together({ store: new Store(aliceDir), bootstrap })
await alice.start()
const restored = alice.status().pendingPairings
assert.equal(restored.length, 1, 'the rendezvous must survive the restart')
assert.equal(restored[0].id, pairing.id)
assert.equal(restored[0].role, 'inviter')
assert.equal(restored[0].roomName, 'restart-room')
assert.ok(alice.store.pairings()[0].eph.publicKey.equals(savedEph),
  'regenerating the key would change the number this side shows, and a peer holding ' +
  'the old one would see a second entry with a different number')

console.log('3. A friend can still answer the id that was shared before the restart…')
const view = await bob.joinRendezvous(pairing.id, { firstLookMs: 25_000 })
const bobSeesAlice = view.peers.find(p => p.name === 'alice') ||
  await peerNamed(bob, pairing.id, 'alice')
const aliceSeesBob = await peerNamed(alice, pairing.id, 'bob')
assert.equal(aliceSeesBob.sas, bobSeesAlice.sas, 'both sides must still agree on the number')

console.log('4. Pairing completes and the stored rendezvous is cleared…')
const paired = waitFor(bob, 'paired')
bob.confirmPairing(pairing.id, bobSeesAlice.sas)
alice.confirmPairing(pairing.id, aliceSeesBob.sas)
await paired
assert.ok(bob.store.rooms().some(r => r.name === 'restart-room'))
assert.deepEqual(alice.store.pairings(), [], 'a completed rendezvous must not be restored again')
assert.deepEqual(alice.status().pendingPairings, [])

console.log('5. A cancelled rendezvous stays gone across a restart…')
const doomed = alice.createPairing('restart-room-2')
assert.equal(alice.store.pairings().length, 1)
alice.cancelPairing(doomed.id)
assert.deepEqual(alice.store.pairings(), [])
await alice.stop()
alice = new Together({ store: new Store(aliceDir), bootstrap })
await alice.start()
assert.deepEqual(alice.status().pendingPairings, [], 'cancelling must not come back')

await alice.stop()
await bob.stop()
await testnet.destroy()
console.log('\nAll pairing restart tests passed.')
process.exit(0)
