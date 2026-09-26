// Adding a second working directory to a room you are already in is a local copy, not
// a pairing: the key is already on this machine. Covers finding the room in a sibling
// project store, both sessions then receiving independently (the reason not to share
// one store), and refusing to guess when the name is ambiguous or absent.
//
// HOME is redirected: sibling-store discovery reads ~/.claude-together/projects, and
// these must never see the real one.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-linkhome-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_TOGETHER_DIR
assert.equal(os.homedir(), fakeHome, 'test must not touch the real home directory')

const createTestnet = (await import('hyperdht/testnet.js')).default
const { Store } = await import('../src/store.js')
const { Together } = await import('../src/transport.js')

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

// Stores laid out where projectStores() looks for them.
const projects = path.join(fakeHome, '.claude-together', 'projects')
function projectStore (name) {
  const dir = path.join(projects, name)
  fs.mkdirSync(dir, { recursive: true })
  return new Store(dir)
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const first = new Together({ store: projectStore('work-aaaaaaaaaaaa'), bootstrap })
const second = new Together({ store: projectStore('other-bbbbbbbbbbbb'), bootstrap })
const friend = new Together({ store: projectStore('friend-cccccccccccc'), bootstrap })
first.store.setName('kacper')
second.store.setName('kacper')
friend.store.setName('ronny')

// Two projects on one machine share the machine-global identity file. These stores are
// given explicit directories, which makes each hold its own identity, so copy the
// keypair across to reproduce what really happens. Without this the two projects sign
// as different people and the self-recognition below cannot be exercised at all.
const mine = first.store.signingKeyPair()
const secondConfig = path.join(projects, 'other-bbbbbbbbbbbb', 'config.json')
const secondJson = JSON.parse(fs.readFileSync(secondConfig, 'utf8'))
secondJson.signPk = mine.publicKey.toString('base64')
secondJson.signSk = mine.secretKey.toString('base64')
fs.writeFileSync(secondConfig, JSON.stringify(secondJson, null, 2))

await first.start()
await second.start()
await friend.start()
assert.ok(first.keys.publicKey.equals(second.keys.publicKey), 'both projects must share an identity')
assert.ok(!first.keys.publicKey.equals(friend.keys.publicKey), 'the friend must be a different identity')

console.log('1. One project pairs into a room the normal way…')
const inv = first.createInvite('shared-room')
await friend.joinWithCode(inv.code)
await Promise.all([waitFor(first, 'peer-joined'), waitFor(friend, 'peer-joined')])
const roomId = first.store.roomByName('shared-room').id

console.log('2. A second project links the same room locally, no pairing…')
assert.equal(second.store.rooms().length, 0)
const linked = second.linkRoom('shared-room')
assert.equal(linked.name, 'shared-room')
assert.equal(linked.id, roomId, 'must be the same room, not a new one')
assert.equal(second.store.roomByName('shared-room').id, roomId)

console.log('3. Linking again is a no-op rather than a second copy…')
const again = second.linkRoom('SHARED-ROOM')
assert.equal(again.alreadyMember, true)
assert.equal(second.store.rooms().length, 1)

console.log('4. Both sessions receive the same message independently…')
async function linkedUp (node) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (node.status().rooms.find(r => r.name === 'shared-room')?.connectedPeers.length) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('room never got a connected peer')
}
await Promise.all([linkedUp(second), linkedUp(friend)])
const atFirst = waitFor(first, 'message', m => m.text === 'hello both')
const atSecond = waitFor(second, 'message', m => m.text === 'hello both')
friend.sendMessage('shared-room', 'hello both')
await Promise.all([atFirst, atSecond])
// The point of separate stores: each has its own copy, so neither drains the other's.
assert.equal(first.store.drainInbound().filter(m => m.text === 'hello both').length, 1)
assert.equal(second.store.drainInbound().filter(m => m.text === 'hello both').length, 1)

console.log('5. A message from your own other session is labelled as such…')
// Both projects sign with the machine identity, so this must not be reported as first
// contact with a stranger — that invites verifying a fingerprint against yourself.
const ownAtFirst = waitFor(first, 'message', m => m.text === 'from my other project')
second.sendMessage('shared-room', 'from my other project')
const own = await ownAtFirst
assert.equal(own.auth, 'self', 'our own identity key must not read as a new sender')
assert.match(own.pk, /^[0-9a-f]{64}$/, 'the signature still travels with it')
// The name is pinned regardless, which is what makes someone else claiming it show up.
assert.ok(first.store.membersFor(roomId).kacper?.pk, 'the name must still get pinned')

console.log('6. The friend still sees it as an ordinary signed message…')
const atFriend = waitFor(friend, 'message', m => m.text === 'from my other project')
const friendCopy = await atFriend
assert.notEqual(friendCopy.auth, 'self', "someone else's key is not their own")
assert.ok(['verified', 'verified-new'].includes(friendCopy.auth), `unexpected auth ${friendCopy.auth}`)

console.log('7. An unknown room name is refused, and says what it did find…')
assert.throws(() => second.linkRoom('no-such-room'),
  /no project on this machine holds a room called "no-such-room".*shared-room/s)

console.log('8. An empty name is refused rather than matching something…')
assert.throws(() => second.linkRoom('   '), /which room/)

console.log('9. Two different rooms sharing a name are refused, not guessed…')
const decoy = projectStore('decoy-dddddddddddd')
const decoyNode = new Together({ store: decoy, bootstrap })
await decoyNode.start()
decoyNode.createRoom('shared-room') // same name, different key
const third = new Together({ store: projectStore('third-eeeeeeeeeeee'), bootstrap })
await third.start()
assert.throws(() => third.linkRoom('shared-room'),
  /names 2 different rooms|link by pairing instead/)
assert.equal(third.store.rooms().length, 0, 'an ambiguous link must join nothing')

await Promise.all([first.stop(), second.stop(), friend.stop(), decoyNode.stop(), third.stop()])
await testnet.destroy()
fs.rmSync(fakeHome, { recursive: true, force: true })
console.log('\nAll room link tests passed.')
process.exit(0)
