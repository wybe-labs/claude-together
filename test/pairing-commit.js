// The v2 pairing exchange (commit–reveal) against a hostile peer speaking the wire
// protocol directly. The v1 exchange derived the number from public keys alone, so a
// man-in-the-middle could generate agreement keys until both humans saw the same
// number. With commitments that stops working, and the only move left — seeing our
// value and walking away to try again — is counted and capped.
//
// Covers: an honest-to-the-protocol peer reaching the same number we show, a
// walk-away being counted, the humans being warned and the rendezvous closing at the
// cap, a reveal that does not match its commitment, a pre-commitment (v1) peer being
// refused with a reason, and an exchange disappearing with its connection.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'
import {
  signKeyPair, sign, ephemeralKeyPair, randomBytes, helloSignable, sasCommitment,
  pairingTranscript, sasFrom
} from '../src/crypto.js'

const tmpdir = label => fs.mkdtempSync(path.join(os.tmpdir(), `ct-${label}-`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hex = buf => b4a.toString(buf, 'hex')

const testnet = await createTestnet(3)
const alice = new Together({ store: new Store(tmpdir('commit-alice')), bootstrap: testnet.bootstrap })
alice.store.setName('alice')
await alice.start()

// A connection the test drives by hand: everything alice writes is captured, and the
// test feeds frames in as if they came off the wire.
function fakePeer (name, { protocol = 2 } = {}) {
  const handlers = {}
  const sent = []
  const conn = {
    on (ev, fn) { handlers[ev] = fn },
    write (data) {
      const text = typeof data === 'string' ? data : b4a.toString(data)
      for (const line of text.split('\n')) if (line.trim()) sent.push(JSON.parse(line))
    },
    destroy () { handlers.close?.() }
  }
  alice._onConnection(conn)
  const keys = signKeyPair()
  const eph = ephemeralKeyPair()
  const nonce = randomBytes(24)
  const r = randomBytes(32)
  return {
    conn,
    sent,
    keys,
    eph,
    r,
    feed (msg) { handlers.data(b4a.from(JSON.stringify(msg) + '\n')) },
    close () { handlers.close() },
    last (t) { return [...sent].reverse().find(m => m.t === t) },
    hello (id) {
      const msg = {
        t: 'pair-hello',
        id,
        pk: hex(keys.publicKey),
        epk: hex(eph.publicKey),
        nonce: hex(nonce),
        name,
        sig: hex(sign(helloSignable(id, keys.publicKey, eph.publicKey, nonce), keys.secretKey))
      }
      if (protocol !== 1) msg.sas = protocol
      this.feed(msg)
    }
  }
}

const inboxText = () => alice.store.drainInbound().map(m => m.text).join('\n')
const viewOf = id => alice.status().pendingPairings.find(p => p.id === id)

console.log('1. A peer following the protocol reaches the same number alice shows…')
const { id } = alice.createPairing('commit-room')
const honest = fakePeer('bob')
honest.hello(id)
const aliceHello = honest.last('pair-hello')
const aliceCommit = honest.last('pair-commit')
assert.ok(aliceHello && aliceCommit, 'alice answers a hello with her own hello and a commitment')
assert.equal(aliceHello.sas, 2, 'alice speaks the commit–reveal protocol')
assert.equal(honest.last('pair-reveal'), undefined, 'alice must not reveal before our commitment arrives')
honest.feed({ t: 'pair-commit', id, c: hex(sasCommitment(id, honest.keys.publicKey, honest.eph.publicKey, honest.r)) })
const aliceReveal = honest.last('pair-reveal')
assert.ok(aliceReveal, 'alice reveals once our commitment is in')
const rAlice = b4a.from(aliceReveal.r, 'hex')
assert.ok(b4a.equals(
  sasCommitment(id, b4a.from(aliceHello.pk, 'hex'), b4a.from(aliceHello.epk, 'hex'), rAlice),
  b4a.from(aliceCommit.c, 'hex')), 'alice\'s reveal opens the commitment she sent')
honest.feed({ t: 'pair-reveal', id, r: hex(honest.r) })
await sleep(1000)
const ourNumber = sasFrom(pairingTranscript(id,
  { pk: honest.keys.publicKey, epk: honest.eph.publicKey, r: honest.r },
  { pk: b4a.from(aliceHello.pk, 'hex'), epk: b4a.from(aliceHello.epk, 'hex'), r: rAlice }))
assert.equal(viewOf(id).peers.length, 1)
assert.equal(viewOf(id).peers[0].sas, ourNumber, 'both ends compute the same number from both values')
assert.match(inboxText(), new RegExp(ourNumber), 'the human is told which number to compare')

console.log('2. The exchange disappears with its connection…')
honest.close()
await sleep(1000)
assert.equal(viewOf(id).peers.length, 0, 'no stale entry left to confirm into a dead connection')

console.log('3. A reveal that does not open its commitment is refused and counted…')
const liar = fakePeer('liar')
liar.hello(id)
liar.feed({ t: 'pair-commit', id, c: hex(sasCommitment(id, liar.keys.publicKey, liar.eph.publicKey, liar.r)) })
liar.feed({ t: 'pair-reveal', id, r: hex(randomBytes(32)) })
await sleep(1000)
assert.equal(viewOf(id).peers.length, 0, 'no number is shown for a broken reveal')
assert.ok(alice.pairRejections.some(r => /does not match its commitment/.test(r.reason)))
let abandoned = 1

console.log('4. Seeing alice\'s value and walking away is counted; the humans hear at 5…')
while (abandoned < 5) {
  const prober = fakePeer(`prober-${abandoned}`)
  prober.hello(id)
  prober.feed({ t: 'pair-commit', id, c: hex(randomBytes(32)) })
  assert.ok(prober.last('pair-reveal'), 'alice revealed to the prober')
  prober.close()
  abandoned++
}
assert.match(inboxText(), /5 pairing attempts .* walked away/, 'the humans are warned')
assert.ok(viewOf(id), 'still open below the cap')

console.log('5. …and the rendezvous closes itself at 20…')
while (abandoned < 20) {
  const prober = fakePeer(`prober-${abandoned}`)
  prober.hello(id)
  prober.feed({ t: 'pair-commit', id, c: hex(randomBytes(32)) })
  prober.close()
  abandoned++
}
assert.equal(viewOf(id), undefined, 'the rendezvous is closed')
assert.deepEqual(alice.store.pairings(), [], 'and it does not come back on restart')
assert.match(inboxText(), /has been closed/, 'the humans are told why')

console.log('6. A peer that never commits is not counted — alice never revealed to it…')
const second = alice.createPairing('commit-room')
const shy = fakePeer('shy')
shy.hello(second.id)
assert.equal(shy.last('pair-reveal'), undefined)
shy.close()
await sleep(1000)
assert.ok(viewOf(second.id), 'nothing was revealed, so nothing was risked')

console.log('7. A pre-commitment (v1) peer is refused, and alice\'s human is told why…')
const old = fakePeer('old-bob', { protocol: 1 })
old.hello(second.id)
assert.equal(old.last('pair-commit'), undefined, 'no exchange starts with a v1 peer')
assert.ok(alice.pairRejections.some(r => /protocol v1/.test(r.reason)))
assert.match(inboxText(), /older pairing protocol \(v1\)/)

await alice.stop()
await testnet.destroy()
console.log('\nAll pairing commitment tests passed.')
process.exit(0)
