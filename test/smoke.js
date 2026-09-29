// End-to-end smoke test on a local Hyperswarm testnet (no internet, no real DHT).
// Covers: short-code pairing, two-way messaging, three-member rooms via any-member
// invites, group broadcast, recipient-addressed messages, and offline catch-up
// relayed through a friend's log.
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

process.env.CLAUDE_TOGETHER_LABEL = 'smoke-session'
process.env.SESSION_MULTIPLAYER_HARNESS = 'smoke-harness'

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const aliceDir = tmpdir('alice')
const bobDir = tmpdir('bob')
const carolDir = tmpdir('carol')

const alice = new Together({ store: new Store(aliceDir), bootstrap })
const bob = new Together({ store: new Store(bobDir), bootstrap })
alice.store.setName('alice')
bob.store.setName('bob')

await alice.start()
await bob.start()

console.log('1. Alice creates an invite…')
const inv = alice.createInvite('test-room')
console.log(`   code: ${inv.code}`)
assert.match(inv.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)

console.log('2. Bob joins with the code (argon2 + DHT rendezvous + handshake)…')
const aliceSawJoin = waitFor(alice, 'message', m => m.kind === 'presence')
const joined = await bob.joinWithCode(inv.code.toLowerCase()) // case-insensitive
assert.equal(joined.roomName, 'test-room')

await Promise.all([waitFor(alice, 'peer-joined'), waitFor(bob, 'peer-joined')])

console.log('   alice gets an automatic join announcement…')
const joinNotice = await aliceSawJoin
assert.equal(joinNotice.from, 'bob')
assert.equal(joinNotice.text, 'joined the room')
assert.equal(joinNotice.kind, 'presence')
assert.equal(joinNotice.host, os.hostname().slice(0, 64))
assert.equal(joinNotice.label, 'smoke-session')
assert.match(joinNotice.sid, /^[0-9a-f]{6}$/, 'join notice carries the session id')

console.log('3. Two-way messaging…')
const gotByAlice = waitFor(alice, 'message', m => m.kind === 'chat')
bob.sendMessage('test-room', 'hello from bob')
const bobMsg = await gotByAlice
assert.equal(bobMsg.text, 'hello from bob')
console.log('   chat messages carry session identifiers and verify (TOFU)…')
assert.equal(bobMsg.host, os.hostname().slice(0, 64))
assert.equal(bobMsg.label, 'smoke-session')
assert.equal(bobMsg.sid, bob.sid, 'chat carries the sender session id')
assert.equal(bobMsg.harness, 'smoke-harness', 'chat carries the sender harness')
assert.equal(bobMsg.auth, 'verified', 'signature verifies — harness rides outside the signed form')

const gotByBob = waitFor(bob, 'message', m => m.kind === 'chat')
alice.sendMessage('test-room', 'hey bob, ship it')
assert.equal((await gotByBob).from, 'alice')
console.log('   both directions ok')

console.log('4. Carol joins the SAME room via an invite from Bob (not Alice)…')
const carol = new Together({ store: new Store(carolDir), bootstrap })
carol.store.setName('carol')
await carol.start()
const bobSawCarolJoin = waitFor(bob, 'message', m => m.kind === 'presence' && m.from === 'carol')
const inv2 = bob.createInvite('test-room')
const joined2 = await carol.joinWithCode(inv2.code)
assert.equal(joined2.roomName, 'test-room')
// Carol should hear about at least one member; catch-up history should flow too.
await waitFor(carol, 'peer-joined')
await bobSawCarolJoin
console.log('   carol is in, connected to the mesh; bob got her join announcement')

console.log('   status shows membership with last-seen…')
const bobStatus = bob.status()
assert.match(bobStatus.session.sid, /^[0-9a-f]{6}$/, 'status reports own session id')
const { VERSION } = await import('../src/transport.js')
assert.equal(bobStatus.version, VERSION, 'status reports the version this process is running')
assert.match(bobStatus.version, /^\d+\.\d+\.\d+$/)
const bobRoom = bobStatus.rooms.find(r => r.name === 'test-room')
assert.ok(bobRoom.members.some(m => m.name === 'alice'))
assert.ok(bobRoom.members.some(m => m.name === 'carol'))
assert.ok(bobRoom.connectedPeers.every(p => typeof p.name === 'string'), 'peers are structured')
assert.ok(bobRoom.connectedPeers.some(p => p.sid && p.label === 'smoke-session'), 'peers carry session identifiers')

console.log('5. Group broadcast: Alice sends, Bob AND Carol receive…')
const bobGot = waitFor(bob, 'message', m => m.text === 'group ping')
const carolGot = waitFor(carol, 'message', m => m.text === 'group ping')
alice.sendMessage('test-room', 'group ping')
await Promise.all([bobGot, carolGot])
console.log('   both received the broadcast')

console.log('6. Addressed message: Alice sends "to bob" — Bob active, Carol passive…')
const bobAddressed = waitFor(bob, 'message', m => m.text === 'just for bob')
const carolAddressed = waitFor(carol, 'message', m => m.text === 'just for bob')
const sendRes = alice.sendMessage('test-room', 'just for bob', 'normal', ['Bob']) // name match is case-insensitive
assert.deepEqual(sendRes.to, ['Bob'])
const [bobCopy, carolCopy] = await Promise.all([bobAddressed, carolAddressed])
assert.equal(bobCopy.priority, 'normal', 'named recipient keeps the active priority')
assert.equal(carolCopy.priority, 'passive', 'unnamed member is demoted to passive')
assert.deepEqual(carolCopy.to, ['Bob'], 'addressing survives the wire for the chat log')
console.log('   bob got it actively, carol only in her inbox/log')

console.log('7. Offline relay: Carol goes offline, Alice sends, Alice goes offline,')
console.log('   Carol returns and catches up through BOB (store-and-forward via friend)…')
await carol.stop()
const bobRelay = waitFor(bob, 'message', m => m.text === 'relay me')
alice.sendMessage('test-room', 'relay me')
await bobRelay
await alice.stop()

const carol2 = new Together({ store: new Store(carolDir), bootstrap })
const carolCaughtUp = waitFor(carol2, 'message', m => m.text === 'relay me', 60_000)
await carol2.start()
const relayed = await carolCaughtUp
assert.equal(relayed.from, 'alice')
assert.equal(relayed.auth, 'verified', 'signature survives relay through a friend and still verifies')
console.log('   carol received alice\'s message from bob\'s log — sender was offline, signature intact')

console.log('8. Dedup: exactly one copy in carol\'s inbox…')
const inbox = carol2.store.drainInbound()
assert.equal(inbox.filter(m => m.text === 'relay me').length, 1)

console.log('9. TOFU pinning: alice\'s store pinned bob\'s public key…')
const pinnedBob = alice.store.membersFor(joined.roomId).bob
assert.match(pinnedBob.pk, /^[0-9a-f]{64}$/, 'bob\'s key is pinned in alice\'s member list')

console.log('10. leave_room disconnects for real…')
await bob.leaveRoom('test-room')
assert.equal(bob.store.rooms().length, 0, 'key forgotten')
const bobGotAfterLeave = new Promise(resolve => {
  bob.once('message', () => resolve(true))
  setTimeout(() => resolve(false), 4000).unref?.()
})
carol2.sendMessage('test-room', 'bob should not see this')
assert.equal(await bobGotAfterLeave, false, 'no messages arrive after leaving')
assert.equal(bob.status().rooms.length, 0, 'status shows no rooms')

await bob.stop()
await carol2.stop()
await testnet.destroy()

console.log('\nAll smoke tests passed.')
process.exit(0)
