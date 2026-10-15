// A session that cannot reach the DHT at all (the shape of a cloud sandbox that lets
// only HTTPS out) joins a room and talks to a DHT member, entirely through an anchor's
// WebSocket listener. Also: an anchor URL with the wrong key is refused.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'
import { startAnchor } from '../src/anchor.js'
import { parseAnchorUrl } from '../src/wslink.js'

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

console.log('1. Anchor URLs are checked before anything connects…')
assert.throws(() => parseAnchorUrl('https://example.com/x'), /wss:\/\//)
assert.throws(() => parseAnchorUrl('wss://example.com/claude-together'), /64-character hex key/)
assert.throws(() => parseAnchorUrl('not a url'), /looks like/)
const ok = parseAnchorUrl('wss://example.com/claude-together#' + 'AB'.repeat(32))
assert.equal(ok.url, 'wss://example.com/claude-together')
assert.equal(ok.display, 'wss://example.com/claude-together#' + 'ab'.repeat(32))

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap

const anchor = await startAnchor({
  dir: tmpdir('anchor'),
  name: 'anchor-ws',
  bootstrap,
  dhtOptions: { firewalled: false, ephemeral: false },
  webSocket: { port: 0, host: '127.0.0.1', publicUrl: null }
})
const port = anchor.together.wsListener.port
const key = anchor.url.split('#')[1]
const url = `ws://127.0.0.1:${port}/claude-together#${key}`
console.log(`   anchor listening at ${url.slice(0, 48)}…`)

const alice = new Together({ store: new Store(tmpdir('alice')), bootstrap })
alice.store.setName('alice')
await alice.start()

// Carol's DHT has nobody to bootstrap from: she can reach no peer except over the URL.
const carol = new Together({ store: new Store(tmpdir('carol')), bootstrap: [], anchorUrls: [url] })
carol.store.setName('carol')
await carol.start()

console.log('2. The anchor joins Alice\'s room over the DHT…')
const forAnchor = alice.createInvite('cloud-room')
await anchor.join(forAnchor.code)
await until(() => alice.status().rooms[0].connectedPeers.some(p => p.anchor), 'alice to see the anchor')

console.log('3. Carol is connected to the anchor over WebSocket…')
await until(() => carol.status().anchors?.[0]?.connected, 'carol to reach the anchor')

console.log('4. Carol redeems Alice\'s invite through the anchor, with no DHT at all…')
const forCarol = alice.createInvite('cloud-room')
assert.equal(forCarol.alsoRedeemableVia, 1)
await until(() => anchor.together.pendingInvites.size === 1, 'the anchor to hold the invite')
const aliceSawCarol = waitFor(alice, 'message', m => m.kind === 'presence' && m.from === 'carol')
const joined = await carol.joinWithCode(forCarol.code)
assert.equal(joined.roomName, 'cloud-room')
await aliceSawCarol

console.log('5. Messages flow both ways…')
const toAlice = waitFor(alice, 'message', m => m.kind === 'chat' && m.from === 'carol')
carol.sendMessage('cloud-room', 'hello from the cloud')
const got = await toAlice
assert.equal(got.text, 'hello from the cloud')
assert.equal(got.auth, 'verified', 'signatures survive the WebSocket hop (key pinned at her join notice)')
const toCarol = waitFor(carol, 'message', m => m.kind === 'chat' && m.from === 'alice')
alice.sendMessage('cloud-room', 'hello from the desk')
assert.equal((await toCarol).text, 'hello from the desk')

console.log('6. A URL whose key is not the anchor\'s is refused…')
const wrong = `ws://127.0.0.1:${port}/claude-together#${'0'.repeat(64)}`
const mallory = new Together({ store: new Store(tmpdir('mallory')), bootstrap: [], anchorUrls: [wrong] })
await mallory.start()
await until(() => mallory.status().anchors[0].lastError, 'the refusal to be recorded')
assert.match(mallory.status().anchors[0].lastError, /different key/)
assert.equal(mallory.status().anchors[0].connected, false)

console.log('7. Anchors can be added and removed at runtime…')
const res = mallory.removeAnchorUrl(wrong)
assert.equal(res.removed, true)
assert.equal(mallory.status().anchors, undefined)
assert.equal(mallory.addAnchorUrl(url).added, true)
await until(() => mallory.status().anchors[0].connected, 'mallory to reach the real anchor')

await mallory.stop()
await carol.stop()
await alice.stop()
await anchor.stop()
await testnet.destroy()
console.log('All WebSocket tests passed.')
process.exit(0)
