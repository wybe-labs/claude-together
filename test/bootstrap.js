// Discovery and relaying can both be repointed while the session runs. Restarting Claude Code to change
// a bootstrap is a poor trade when the setting is one line, and the case it exists for
// — peers who can find each other but not connect — is discovered mid-conversation.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together, parseBootstrap } from '../src/transport.js'

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

async function linked (node, name, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (node.status().rooms.find(r => r.name === name)?.connectedPeers.length) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

console.log('1. A bootstrap list is validated in one place…')
assert.deepEqual(parseBootstrap('10.0.0.1:49737'), ['10.0.0.1:49737'])
assert.deepEqual(parseBootstrap(['10.0.0.1:49737', ' 10.0.0.2:1 ']), ['10.0.0.1:49737', '10.0.0.2:1'])
assert.equal(parseBootstrap(''), undefined)
assert.equal(parseBootstrap(null), undefined)
assert.equal(parseBootstrap([]), undefined)
// A hostname with no port, or a bare host, is the mistake that leaves a session
// advertising an address nobody else can use. Refuse rather than fall back.
assert.throws(() => parseBootstrap('myhost'), /host:port/)
assert.throws(() => parseBootstrap(['10.0.0.1:49737', 'nope']), /host:port/)

// Two separate DHTs, standing in for two networks.
const netA = await createTestnet(3)
const netB = await createTestnet(3)

const aliceDir = tmpdir('alice')
const alice = new Together({ store: new Store(aliceDir), bootstrap: netA.bootstrap.map(b => `${b.host}:${b.port}`) })
const bob = new Together({ store: new Store(tmpdir('bob')), bootstrap: netA.bootstrap.map(b => `${b.host}:${b.port}`) })
alice.store.setName('alice')
bob.store.setName('bob')
await alice.start()
await bob.start()

console.log('2. Two sessions meet on the first DHT…')
const inv = alice.createInvite('moving-room')
await bob.joinWithCode(inv.code)
await Promise.all([waitFor(alice, 'peer-joined'), waitFor(bob, 'peer-joined')])
assert.ok(await linked(alice, 'moving-room'), 'should be connected on the first DHT')

console.log('3. Moving one of them to a different DHT takes effect without a restart…')
const moved = await alice.reconfigureBootstrap(netB.bootstrap.map(b => `${b.host}:${b.port}`))
assert.equal(moved.bootstrap.length, netB.bootstrap.length)
assert.ok(alice.swarm, 'the swarm must be rebuilt, not left destroyed')
// Rooms and identity survive the rebuild — only the network changed.
assert.equal(alice.store.roomByName('moving-room').id, bob.store.roomByName('moving-room').id)
assert.ok(alice.keys.publicKey.length > 0)

console.log('4. On a different DHT the peer is simply absent…')
assert.equal(await linked(alice, 'moving-room', 6000), false,
  'a session on another DHT must not still be connected')

console.log('5. Moving back reconnects them, still with no restart…')
await alice.reconfigureBootstrap(netA.bootstrap.map(b => `${b.host}:${b.port}`))
assert.ok(await linked(alice, 'moving-room'), 'should reconnect after moving back')
const back = waitFor(alice, 'message', m => m.text === 'still here')
bob.sendMessage('moving-room', 'still here')
await back

console.log('6. The choice is remembered for the machine, not the project…')
assert.deepEqual(alice.store.getBootstrap(), netA.bootstrap.map(b => `${b.host}:${b.port}`))
const reopened = new Store(aliceDir)
assert.deepEqual(reopened.getBootstrap(), netA.bootstrap.map(b => `${b.host}:${b.port}`),
  'a later session must start on the same DHT without anything being exported')

console.log('7. Clearing it returns to the public nodes…')
await alice.reconfigureBootstrap(null)
assert.equal(alice.bootstrap, undefined)
assert.equal(alice.store.getBootstrap(), null)

console.log('8. A bad value is refused and changes nothing…')
await alice.reconfigureBootstrap(netA.bootstrap.map(b => `${b.host}:${b.port}`))
await assert.rejects(() => alice.reconfigureBootstrap(['not-a-node']), /host:port/)
assert.deepEqual(alice.bootstrap, netA.bootstrap.map(b => `${b.host}:${b.port}`),
  'a refused change must leave discovery where it was')

console.log('9. A relay key is validated, and only accepted as a key…')
const { parseRelay } = await import('../src/transport.js')
const relayKey = 'a'.repeat(64)
assert.ok(parseRelay(relayKey).equals(Buffer.from(relayKey, 'hex')))
assert.equal(parseRelay(''), undefined)
assert.equal(parseRelay(null), undefined)
// The likely mistake is giving an address, since everything else here is one.
assert.throws(() => parseRelay('192.168.1.10:49737'), /hex public key/)
assert.throws(() => parseRelay('a'.repeat(63)), /hex public key/)

console.log('10. Setting a relay takes effect live and is remembered…')
await alice.reconfigureRelay(relayKey)
assert.ok(alice.swarm.relayThrough, 'the rebuilt swarm must carry the relay')
assert.equal(alice.store.getRelay(), relayKey)
assert.deepEqual(new Store(aliceDir).getRelay(), relayKey, 'a later session picks it up')
// Naming a relay must not disturb rooms or the connection that already works.
assert.ok(alice.store.roomByName('moving-room'), 'rooms survive the rebuild')
assert.ok(await linked(alice, 'moving-room'), 'a direct connection is still used')

console.log('11. Clearing the relay stops relaying…')
await alice.reconfigureRelay(null)
assert.equal(alice.relay, undefined)
assert.equal(alice.store.getRelay(), null)
assert.ok(!alice.swarm.relayThrough, 'the rebuilt swarm must not carry a relay')

console.log('12. A bad relay key is refused and changes nothing…')
await alice.reconfigureRelay(relayKey)
await assert.rejects(() => alice.reconfigureRelay('nonsense'), /hex public key/)
assert.ok(alice.relay, 'a refused change must leave relaying where it was')

await alice.stop()
await bob.stop()
await netA.destroy()
await netB.destroy()
console.log('\nAll bootstrap and relay tests passed.')
process.exit(0)
