// Session handoff tests: transcript stripping, the chunked P2P transfer on a local
// testnet (no internet), and the import that writes a resumable local session.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import createTestnet from 'hyperdht/testnet.js'
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'
import {
  stripTranscript, buildHandoffDoc, importHandoffDoc,
  encodeProjectDir, transcriptDirFor
} from '../src/handoff.js'

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

// A fixture transcript in the real record shapes: user turns, assistant turns with
// thinking/tool_use noise, tool_result user records, sidechains, meta records.
function fixtureTranscript (sessionId, cwd) {
  const rec = (extra) => JSON.stringify({
    parentUuid: null, isSidechain: false, userType: 'external',
    cwd, sessionId, version: '2.1.246', uuid: 'u-' + Math.random(), timestamp: new Date().toISOString(),
    ...extra
  })
  return [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }),
    rec({ type: 'user', message: { role: 'user', content: 'Fix the auth token refresh bug<system-reminder>secret local reminder</system-reminder>' } }),
    rec({
      type: 'assistant',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5',
        content: [
          { type: 'thinking', thinking: 'private thinking must not leak', signature: 'x' },
          { type: 'text', text: 'Looking at session.ts now.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'session.ts' } }
        ],
        stop_reason: 'tool_use'
      }
    }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }] } }),
    rec({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain agent prompt, must not leak' } }),
    rec({ type: 'user', message: { role: 'user', content: '<command-name>/together-status</command-name>' } }),
    rec({
      type: 'assistant',
      message: {
        id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-fable-5',
        content: [{ type: 'text', text: 'Found it: the refresh path drops the expiry. Fixed in session.ts:42.' }],
        stop_reason: 'end_turn'
      }
    }),
    rec({ type: 'user', message: { role: 'user', content: 'great, hand this off to my friend' } }),
    ''
  ].join('\n')
}

console.log('1. encodeProjectDir matches Claude Code munging…')
assert.equal(encodeProjectDir('C:\\Users\\einar\\ClaudeTogether'), 'C--Users-einar-ClaudeTogether')
assert.equal(encodeProjectDir('/home/x/my.project (v2)'), '-home-x-my-project--v2-')

console.log('2. stripTranscript keeps conversation, drops internals…')
const srcCwd = 'C:\\Users\\alice\\proj'
const jsonl = fixtureTranscript('src-session-1', srcCwd)
const stripped = stripTranscript(jsonl)
assert.equal(stripped.sourceSessionId, 'src-session-1')
assert.equal(stripped.sourceCwd, srcCwd)
assert.deepEqual(stripped.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'user'])
const all = JSON.stringify(stripped.messages)
assert.ok(all.includes('auth token refresh'))
assert.ok(all.includes('session.ts:42'))
assert.ok(!all.includes('private thinking'), 'thinking leaked')
assert.ok(!all.includes('sidechain agent'), 'sidechain leaked')
assert.ok(!all.includes('secret local reminder'), 'system-reminder leaked')
assert.ok(!all.includes('tool_result') && !all.includes('file contents here'), 'tool result leaked')
assert.ok(!all.includes('command-name'), 'slash-command meta leaked')

console.log('3. size cap trims oldest turns first…')
const big = stripTranscript(jsonl, { maxBytes: 4300 })
assert.ok(big.truncated || big.messages.length === stripped.messages.length)
const tiny = stripTranscript(fixtureTranscript('s', srcCwd), { maxBytes: 4200 })
assert.ok(tiny.messages.length >= 1)
assert.equal(tiny.messages[tiny.messages.length - 1].text, 'great, hand this off to my friend')

console.log('4. P2P transfer: alice offers, bob receives + gets an inbox notice…')
const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap
const alice = new Together({ store: new Store(tmpdir('alice')), bootstrap })
const bob = new Together({ store: new Store(tmpdir('bob')), bootstrap })
alice.store.setName('alice')
bob.store.setName('bob')
await alice.start()
await bob.start()
const inv = alice.createInvite('handoff-room')
await bob.joinWithCode(inv.code)
await Promise.all([waitFor(alice, 'peer-joined'), waitFor(bob, 'peer-joined')])

const transcriptFile = path.join(tmpdir('fixture'), 'src-session-1.jsonl')
fs.writeFileSync(transcriptFile, jsonl)
const doc = buildHandoffDoc({
  from: 'alice', roomName: 'handoff-room', title: 'auth bug hunt', transcriptPath: transcriptFile
})

const bobGot = waitFor(bob, 'handoff-received')
const delivered = waitFor(alice, 'handoff-delivered')
const offer = alice.offerHandoff('handoff-room', doc)
assert.equal(offer.offeredToPeers, 1)
const got = await bobGot
await delivered
assert.equal(got.from, 'alice')
assert.equal(got.title, 'auth bug hunt')

const handoffs = bob.store.listHandoffs()
assert.equal(handoffs.length, 1)
assert.equal(handoffs[0].id, offer.id)
assert.equal(handoffs[0].imported, false)
const notice = bob.store.drainInbound().find(m => m.id === offer.id)
assert.ok(notice, 'no inbox notice for the handoff')
assert.ok(notice.text.includes('/together-import ' + offer.id))
assert.ok(!notice.text.includes('session.ts'), 'handoff body leaked into chat notice')

console.log('5. large payloads chunk and reassemble intact…')
const bigJsonl = [
  JSON.stringify({
    parentUuid: null, isSidechain: false, type: 'user', uuid: 'u1', sessionId: 'big', cwd: srcCwd,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'X'.repeat(300 * 1024) + ' END-MARKER' }
  })
].join('\n')
const bigFile = path.join(tmpdir('fixture2'), 'big.jsonl')
fs.writeFileSync(bigFile, bigJsonl)
const bigDoc = buildHandoffDoc({ from: 'alice', roomName: 'handoff-room', title: 'big', transcriptPath: bigFile })
const bobGotBig = waitFor(bob, 'handoff-received')
const bigOffer = alice.offerHandoff('handoff-room', bigDoc)
assert.ok(bigOffer.bytes > 200 * 1024, 'expected a multi-chunk payload')
await bobGotBig
const storedBig = bob.store.getHandoff(bigOffer.id)
assert.ok(storedBig.doc.messages[0].text.endsWith('END-MARKER'), 'chunked payload corrupted')

console.log('6. import writes a fresh resumable session with rewritten cwd…')
const projectsRoot = tmpdir('projects')
const targetCwd = 'C:\\Users\\bob\\other-project'
const imp = importHandoffDoc(bob.store.getHandoff(offer.id).doc, { cwd: targetCwd, root: projectsRoot })
bob.store.markHandoffImported(offer.id, imp.sessionId)
assert.ok(imp.file.startsWith(transcriptDirFor(targetCwd, projectsRoot)))
const records = fs.readFileSync(imp.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
assert.ok(records.length === doc.messages.length + 2, 'banner + messages + epilogue')
assert.equal(records[0].type, 'user')
assert.ok(records[0].message.content.includes('IMPORTED SESSION HANDOFF'))
assert.ok(records[0].message.content.includes('UNTRUSTED'))
assert.ok(records[records.length - 1].message.content.includes('END OF IMPORTED HANDOFF'))
for (const [i, r] of records.entries()) {
  assert.equal(r.cwd, targetCwd, 'cwd not rewritten')
  assert.equal(r.sessionId, imp.sessionId, 'sessionId not fresh')
  assert.notEqual(r.sessionId, 'src-session-1')
  if (i > 0) assert.equal(r.parentUuid, records[i - 1].uuid, 'parent chain broken')
}
assert.equal(records[2].type, 'assistant')
assert.equal(records[2].message.role, 'assistant')
assert.ok(Array.isArray(records[2].message.content))
assert.equal(bob.store.listHandoffs()[0].imported, true)

console.log('7. transfers leave no lingering state on either side…')
assert.equal(bob.incomingHandoffs.size, 0)

await alice.stop()
await bob.stop()
await testnet.destroy()

console.log('\nAll handoff tests passed.')
process.exit(0)
