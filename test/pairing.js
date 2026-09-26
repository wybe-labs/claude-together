// SAS pairing: no secret code, no expiry. Security comes from two humans reading the
// same six digits to each other. Covers: both sides deriving the same number, no grant
// until BOTH confirm, a wrong number refusing to pair, an impostor at the same public
// rendezvous showing a different number, and the confirmed key being pinned.
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
const mallory = new Together({ store: new Store(tmpdir('mallory')), bootstrap })
alice.store.setName('alice')
bob.store.setName('bob')
mallory.store.setName('mallory')
await alice.start()
await bob.start()
await mallory.start()

console.log('1. The rendezvous id is not a secret and carries no expiry…')
const pairing = alice.createPairing('sas-room')
assert.match(pairing.id, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
assert.equal(alice.status().pendingPairings.length, 1)
assert.ok(!('expiresInMinutes' in pairing), 'nothing about this expires')

console.log('2. Both sides derive the SAME six digits…')
const bobView = await bob.joinRendezvous(pairing.id)
const bobSeesAlice = bobView.peers.find(p => p.name === 'alice')
assert.ok(bobSeesAlice, 'bob should see alice answering')
assert.match(bobSeesAlice.sas, /^\d{3} \d{3}$/)
const aliceSeesBob = alice.status().pendingPairings[0].peers.find(p => p.name === 'bob')
assert.ok(aliceSeesBob, 'alice should see bob answering')
assert.equal(aliceSeesBob.sas, bobSeesAlice.sas, 'the number must match on both sides')

console.log('3. A wrong number refuses to pair, and says what it actually saw…')
assert.throws(() => bob.confirmPairing(pairing.id, '000 000'), /no peer at this rendezvous is showing/)
assert.equal(bob.store.rooms().length, 0, 'a refused confirm must not join anything')

console.log('4. One side confirming is not enough — the grant waits for both…')
const bobConfirm = bob.confirmPairing(pairing.id, bobSeesAlice.sas)
assert.equal(bobConfirm.waiting, true)
await new Promise(r => setTimeout(r, 1500))
assert.equal(bob.store.rooms().length, 0, 'no room key may be handed over on one confirmation')

console.log('5. When both confirm the same number, the room key is handed over…')
const paired = waitFor(bob, 'paired')
alice.confirmPairing(pairing.id, aliceSeesBob.sas)
const result = await paired
assert.equal(result.roomName, 'sas-room')
assert.equal(bob.store.rooms().length, 1)
assert.equal(bob.store.rooms()[0].name, 'sas-room')

console.log('6. The confirmed identity key is pinned on both sides…')
const roomId = bob.store.rooms()[0].id
const bobsPinOfAlice = bob.store.membersFor(roomId).alice
assert.ok(bobsPinOfAlice?.pk, 'bob pinned the key he confirmed by hand')
const alicesPinOfBob = alice.store.membersFor(roomId).bob
assert.ok(alicesPinOfBob?.pk, 'alice pinned the key she confirmed by hand')

console.log('7. The rendezvous closes once it has granted…')
assert.equal(alice.status().pendingPairings.length, 0)
assert.equal(bob.status().pendingPairings.length, 0)

console.log('8. An impostor at the same public rendezvous shows a DIFFERENT number…')
const second = alice.createPairing('sas-room-2')
const [carolView, malloryView] = await Promise.all([
  bob.joinRendezvous(second.id),
  mallory.joinRendezvous(second.id)
])
const alicePending = alice.status().pendingPairings[0]
const aliceSeesBob2 = alicePending.peers.find(p => p.name === 'bob')
const aliceSeesMallory = alicePending.peers.find(p => p.name === 'mallory')
assert.ok(aliceSeesBob2 && aliceSeesMallory, 'both answered the public rendezvous')
assert.notEqual(aliceSeesBob2.sas, aliceSeesMallory.sas,
  'each peer must get its own number, or an impostor could ride the real one')
// joinRendezvous resolves on the FIRST peer to answer a public rendezvous, which on
// this topic may be the other joiner rather than the inviter. Later arrivals show up
// in status, so read the live view rather than that snapshot.
async function peerNamed (node, id, name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = node.status().pendingPairings.find(s => s.id === id)
    const peer = session?.peers.find(p => p.name === name)
    if (peer) return peer
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`${name} never answered rendezvous ${id}`)
}

const malloryPending = await peerNamed(mallory, second.id, 'alice')
assert.notEqual(malloryPending.sas, aliceSeesBob2.sas,
  "mallory's number with alice must differ from the one alice reads to bob")
assert.equal((await peerNamed(bob, second.id, 'alice')).sas, aliceSeesBob2.sas,
  'the real peer still matches')
assert.ok(carolView.peers.length >= 1, 'bob got a snapshot when he joined')

console.log('9. Confirming the number alice read to BOB pairs bob, not the impostor…')
const paired2 = waitFor(bob, 'paired')
bob.confirmPairing(second.id, aliceSeesBob2.sas)
alice.confirmPairing(second.id, aliceSeesBob2.sas)
await paired2
assert.ok(bob.store.rooms().some(r => r.name === 'sas-room-2'))
assert.equal(mallory.store.rooms().length, 0, 'the impostor got nothing')

console.log('10. After a confirmed pairing, the very first message is already trusted…')
// Both sides must have the room context proven on the shared socket before sending.
// A message sent in the window where only the sender has it is delivered into a
// connection the receiver has not yet bound to that room, and is dropped there.
async function roomLinked (node, roomName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const room = node.status().rooms.find(r => r.name === roomName)
    if (room && room.connectedPeers.length > 0) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`${roomName} never got a connected peer`)
}
await Promise.all([roomLinked(alice, 'sas-room-2'), roomLinked(bob, 'sas-room-2')])
const firstMsg = waitFor(bob, 'message', m => m.text === 'hello after pairing')
alice.sendMessage('sas-room-2', 'hello after pairing')
const seen = await firstMsg
assert.equal(seen.auth, 'verified',
  'a key a human confirmed by number must not be reported as unverified first contact')

console.log('11. Without a pairing, first contact is labelled and pinned…')
const legacyCode = alice.createInvite('legacy-room').code
await mallory.joinWithCode(legacyCode)
const legacyMsg = waitFor(mallory, 'message', m => m.text === 'first ever')
alice.sendMessage('legacy-room', 'first ever')
const legacySeen = await legacyMsg
assert.equal(legacySeen.auth, 'verified-new', 'an unpinned sender must be flagged as new')
assert.match(legacySeen.pk, /^[0-9a-f]{64}$/, 'the fingerprint must be shown, so it can be checked')
const legacyRoomId = mallory.store.rooms().find(r => r.name === 'legacy-room').id
assert.ok(mallory.store.membersFor(legacyRoomId).alice?.pk, 'and pinned from then on')
const secondMsg = waitFor(mallory, 'message', m => m.text === 'second one')
alice.sendMessage('legacy-room', 'second one')
assert.equal((await secondMsg).auth, 'verified', 'the second message is no longer first contact')

console.log('12. Cancelling stops announcing…')
const third = alice.createPairing('sas-room-3')
assert.equal(alice.status().pendingPairings.length, 1)
assert.deepEqual(alice.cancelPairing(third.id), { id: third.id })
assert.equal(alice.status().pendingPairings.length, 0)
assert.equal(alice.cancelPairing(third.id), null)

await alice.stop()
await bob.stop()
await mallory.stop()
await testnet.destroy()
console.log('\nAll SAS pairing tests passed.')
process.exit(0)
