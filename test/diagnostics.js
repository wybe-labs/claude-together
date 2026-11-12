// status explains a peer that is found but cannot be connected to, instead of
// leaving it indistinguishable from a peer who never came online.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'

function tmpdir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ct-${label}-`))
}

async function until (check, what, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const alice = new Together({ store: new Store(tmpdir('alice')), bootstrap })
// Bob is directly reachable but turns Alice away, which is a failed connection on
// Alice's side that does not depend on what the test machine's network allows.
let aliceKey = null
const bob = new Together({
  store: new Store(tmpdir('bob')),
  bootstrap,
  dhtOptions: { firewalled: false, ephemeral: false },
  firewall: pk => aliceKey !== null && b4a.equals(pk, aliceKey)
})
alice.store.setName('alice')
bob.store.setName('bob')

await alice.start()
aliceKey = alice.swarm.keyPair.publicKey
const room = alice.createRoom('blocked')
bob.store.addRoom(room.id, 'blocked', alice.store.rooms().find(r => r.id === room.id).key)
await bob.start()

console.log('1. The network section is always present…')
assert.ok(typeof alice.status().network.nat === 'string')
assert.ok(typeof alice.status().network.explanation === 'string')

console.log('2. A peer that keeps refusing shows up as unreachable, with a reason…')
await until(() => alice.status().rooms[0].unreachablePeers?.length, 'alice to record the failed attempts')
const [entry] = alice.status().rooms[0].unreachablePeers
assert.equal(entry.peer, b4a.toString(bob.swarm.keyPair.publicKey, 'hex').slice(0, 12))
assert.ok(entry.failedAttempts >= 1)
assert.ok(entry.why.length > 0)
assert.equal(alice.status().rooms[0].connectedPeers.length, 0)

await alice.stop()
await bob.stop()
await testnet.destroy()
console.log('All diagnostics tests passed.')
process.exit(0)
