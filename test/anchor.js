// An anchor lets two members who cannot reach each other share a room: the joiner
// redeems the invite through the anchor, and messages flow both ways through it.
// Alice and Bob refuse each other's connections outright, so on any network this
// test only passes if nothing goes directly between them.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'
import { startAnchor } from '../src/anchor.js'

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

async function until (check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const blocked = new Set()
const firewall = remotePublicKey => blocked.has(b4a.toString(remotePublicKey, 'hex'))

const alice = new Together({ store: new Store(tmpdir('alice')), bootstrap, firewall })
const bob = new Together({ store: new Store(tmpdir('bob')), bootstrap, firewall })
alice.store.setName('alice')
bob.store.setName('bob')
// The anchor stands for a machine on a good network: reachable without a hole punch.
const anchor = await startAnchor({
  dir: tmpdir('anchor'),
  name: 'anchor-test',
  bootstrap,
  dhtOptions: { firewalled: false, ephemeral: false }
})

await alice.start()
await bob.start()
blocked.add(b4a.toString(alice.swarm.keyPair.publicKey, 'hex'))
blocked.add(b4a.toString(bob.swarm.keyPair.publicKey, 'hex'))

console.log('1. Alice adds an anchor to her room with an ordinary invite…')
const forAnchor = alice.createInvite('far-apart')
assert.equal(forAnchor.alsoRedeemableVia, undefined, 'no anchor yet, nothing to delegate to')
const anchorJoined = waitFor(alice, 'message', m => m.kind === 'presence' && m.from === 'anchor-test')
await anchor.join(forAnchor.code)
await anchorJoined
await until(() => alice.status().rooms[0].connectedPeers.some(p => p.anchor), 'alice to see the anchor flag')
const asMember = alice.status().rooms[0].members.find(m => m.name === 'anchor-test')
assert.equal(asMember.anchor, true, 'the anchor is remembered as one in the member list')

console.log('2. Alice invites Bob; the anchor is handed the code too…')
const forBob = alice.createInvite('far-apart')
assert.equal(forBob.alsoRedeemableVia, 1, 'the invite was delegated to the connected anchor')
await until(() => anchor.together.pendingInvites.size === 1, 'the anchor to hold the delegated invite')

console.log('3. Bob, who cannot reach Alice, joins through the anchor…')
const aliceSawBob = waitFor(alice, 'message', m => m.kind === 'presence' && m.from === 'bob')
const joined = await bob.joinWithCode(forBob.code)
assert.equal(joined.roomName, 'far-apart')
await aliceSawBob

console.log('   the code is spent everywhere, not just where it was redeemed…')
await until(() => alice.pendingInvites.size === 0, 'alice to retire the code')
assert.equal(anchor.together.pendingInvites.size, 0)

console.log('4. Messages flow both ways through the anchor…')
const toAlice = waitFor(alice, 'message', m => m.kind === 'chat' && m.from === 'bob')
bob.sendMessage('far-apart', 'can you hear me?')
assert.equal((await toAlice).text, 'can you hear me?')
const toBob = waitFor(bob, 'message', m => m.kind === 'chat' && m.from === 'alice')
alice.sendMessage('far-apart', 'loud and clear')
assert.equal((await toBob).text, 'loud and clear')

console.log('   …and never directly: each of them is connected to the anchor alone…')
for (const t of [alice, bob]) {
  const peers = t.status().rooms[0].connectedPeers.map(p => p.name)
  assert.deepEqual(peers, ['anchor-test'])
}

console.log('   the anchor keeps no inbox, only the room log it replays…')
assert.equal(anchor.store.unreadCount(), 0)
assert.ok(anchor.store.logTail(anchor.store.rooms()[0].id).length >= 2)

console.log('5. A delegation for a room the anchor is not in is ignored…')
const other = alice.createInvite('elsewhere')
assert.equal(other.alsoRedeemableVia, undefined)
assert.equal(anchor.together.pendingInvites.size, 0)

await alice.stop()
await bob.stop()
await anchor.stop()
await testnet.destroy()
console.log('All anchor tests passed.')
process.exit(0)
