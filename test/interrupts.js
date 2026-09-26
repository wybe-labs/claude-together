// Mid-turn interrupts are opt-in per room, decided by the RECEIVER. Covers: the
// default (downgraded to turn-end delivery), an opted-in room (honored), the flag
// surviving a re-invite into a room you're already in, and the sender being unable
// to influence any of it.
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

const inv = alice.createInvite('urgent-room')
await bob.joinWithCode(inv.code)
await Promise.all([waitFor(alice, 'peer-joined'), waitFor(bob, 'peer-joined')])

console.log('1. A room starts with interrupts off…')
const bobRoom = () => bob.store.rooms().find(r => r.name === 'urgent-room')
assert.equal(bobRoom().allowInterrupt, false, 'joining must not arm interrupts')

console.log('2. An "interrupt" into a room that has not opted in lands at turn end…')
let got = waitFor(bob, 'message', m => m.text === 'wake up')
alice.sendMessage('urgent-room', 'wake up', 'interrupt')
let copy = await got
assert.equal(copy.priority, 'normal', 'interrupt must be downgraded, not honored')
assert.equal(
  bob.store.drainInbound().find(m => m.text === 'wake up').priority,
  'normal',
  'the downgrade must be what reaches the inbox the hooks read'
)

console.log('3. The sender still sees the room log copy at its original priority…')
const log = alice.store.logTail(alice.store.roomByName('urgent-room').id)
assert.equal(log.find(m => m.text === 'wake up').priority, 'interrupt',
  'the shared log records what was sent; only local delivery is re-decided')

console.log('4. Once the receiver opts in, interrupts are honored…')
bob.store.setRoomInterrupts(bobRoom().id, true)
assert.equal(bobRoom().allowInterrupt, true)
got = waitFor(bob, 'message', m => m.text === 'really wake up')
alice.sendMessage('urgent-room', 'really wake up', 'interrupt')
copy = await got
assert.equal(copy.priority, 'interrupt', 'opted-in room must keep interrupt priority')

console.log('5. Opting back out takes effect immediately…')
bob.store.setRoomInterrupts(bobRoom().id, false)
got = waitFor(bob, 'message', m => m.text === 'never mind')
alice.sendMessage('urgent-room', 'never mind', 'interrupt')
copy = await got
assert.equal(copy.priority, 'normal')

console.log('6. A fresh invite into the same room does not silently re-arm it…')
bob.store.setRoomInterrupts(bobRoom().id, true)
const again = alice.createInvite('urgent-room')
await bob.joinWithCode(again.code)
assert.equal(bobRoom().allowInterrupt, true, 're-adding a room must preserve the choice')
bob.store.setRoomInterrupts(bobRoom().id, false)
const third = alice.createInvite('urgent-room')
await bob.joinWithCode(third.code)
assert.equal(bobRoom().allowInterrupt, false, 're-adding must not arm interrupts either')

console.log('7. setRoomInterrupts refuses an unknown room…')
assert.throws(() => bob.store.setRoomInterrupts('deadbeefdeadbeef', true), /no room with id/)

await alice.stop()
await bob.stop()
await testnet.destroy()
console.log('\nAll interrupt opt-in tests passed.')
