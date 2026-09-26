// Registration is per project, so that a session in a project you never registered
// has no delivery hooks and cannot be pulled into a room. Covers: hooks landing in
// the target project only, idempotence, leaving unrelated settings intact, isolation
// between projects, and cleanup of pre-0.4 user-wide hooks.
//
// HOME is redirected to a temp dir for the whole file: these must never read or
// rewrite the real ~/.claude/settings.json.
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
assert.equal(os.homedir(), fakeHome, 'test must not touch the real home directory')

const { installHooks, removeUserWideHooks } = await import('../scripts/install-hooks.js')

const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-projA-'))
const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-projB-'))
const settingsOf = p => path.join(p, '.claude', 'settings.local.json')
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const EVENTS = ['PostToolUse', 'Stop', 'UserPromptSubmit']

console.log('1. Hooks install into the named project, not the home directory…')
const written = installHooks(projectA)
assert.equal(written, settingsOf(projectA))
const a = readJson(written)
for (const e of EVENTS) assert.equal(a.hooks[e].length, 1, `${e} hook installed`)
assert.ok(!fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')),
  'installing must not create user-wide settings')

console.log('2. settings.local.json, never the committed settings.json…')
assert.ok(!fs.existsSync(path.join(projectA, '.claude', 'settings.json')),
  'the hook command holds machine-specific absolute paths and must stay uncommitted')

console.log('3. Installing twice does not duplicate entries…')
installHooks(projectA)
for (const e of EVENTS) assert.equal(readJson(written).hooks[e].length, 1, `${e} still single`)

console.log('4. Unrelated settings and unrelated hooks survive…')
const mixed = readJson(written)
mixed.permissions = { allow: ['Bash(ls)'] }
mixed.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'echo someone-elses-hook' }] })
fs.writeFileSync(written, JSON.stringify(mixed, null, 2))
installHooks(projectA)
const after = readJson(written)
assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] }, 'unrelated keys preserved')
assert.equal(after.hooks.Stop.length, 2, 'foreign Stop hook preserved alongside ours')
assert.match(after.hooks.Stop[0].hooks[0].command, /someone-elses-hook/, 'foreign hook kept first')

console.log('5. A second project is independent — registering one does not register the other…')
assert.ok(!fs.existsSync(settingsOf(projectB)), 'project B untouched by project A')
installHooks(projectB)
assert.ok(fs.existsSync(settingsOf(projectB)))
assert.equal(readJson(settingsOf(projectA)).hooks.Stop.length, 2, 'project A unchanged')

console.log('6. Pre-0.4 user-wide hooks are removed, foreign ones kept…')
const userSettings = path.join(fakeHome, '.claude', 'settings.json')
fs.mkdirSync(path.dirname(userSettings), { recursive: true })
fs.writeFileSync(userSettings, JSON.stringify({
  model: 'opus',
  hooks: {
    Stop: [
      { hooks: [{ type: 'command', command: '"/usr/bin/node" "/home/x/claude-together/scripts/hook.js" stop' }] },
      { hooks: [{ type: 'command', command: 'echo keep-me' }] }
    ],
    PostToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: '"/usr/bin/node" "/home/x/ClaudeTogether/scripts/hook.js" posttool' }] }
    ]
  }
}, null, 2))
const { events } = removeUserWideHooks()
assert.deepEqual(events.sort(), ['PostToolUse', 'Stop'])
const cleaned = readJson(userSettings)
assert.equal(cleaned.model, 'opus', 'unrelated user settings preserved')
assert.equal(cleaned.hooks.Stop.length, 1)
assert.match(cleaned.hooks.Stop[0].hooks[0].command, /keep-me/)
assert.ok(!('PostToolUse' in cleaned.hooks), 'an event left with no hooks is dropped, not left empty')

console.log('7. Cleanup is a no-op when there is nothing user-wide…')
assert.deepEqual(removeUserWideHooks().events, [], 'second run removes nothing')
fs.rmSync(userSettings)
assert.deepEqual(removeUserWideHooks().events, [], 'missing file is not an error')

console.log('8. Hook state is reported for a project, not guessed at…')
const { hooksStatus, HOOK_EVENTS } = await import('../src/hooks.js')
const projectC = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-projC-'))
const missing = hooksStatus(projectC)
assert.equal(missing.installed, false)
assert.match(missing.summary, /NO delivery hooks/)
assert.match(missing.summary, /check_messages/, 'must say what happens to messages meanwhile')

installHooks(projectC)
const present = hooksStatus(projectC)
assert.equal(present.installed, true)
assert.equal(present.complete, true)
assert.deepEqual(present.events.sort(), [...HOOK_EVENTS].sort())
assert.equal(present.scope, 'project')

console.log('9. A partial install is reported as partial, not as installed…')
const partial = JSON.parse(fs.readFileSync(settingsOf(projectC), 'utf8'))
delete partial.hooks.Stop
fs.writeFileSync(settingsOf(projectC), JSON.stringify(partial, null, 2))
const half = hooksStatus(projectC)
assert.equal(half.installed, true)
assert.equal(half.complete, false, 'two of three events is not installed')
assert.match(half.summary, /PARTLY/)
assert.match(half.summary, /Stop/, 'must name the event that is missing')

console.log('10. Unparseable settings say so, rather than claiming no hooks…')
const projectD = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-projD-'))
fs.mkdirSync(path.join(projectD, '.claude'), { recursive: true })
fs.writeFileSync(settingsOf(projectD), '{ this is not json')
const broken = hooksStatus(projectD)
assert.equal(broken.installed, false)
assert.match(broken.summary, /cannot tell/, 'a file we cannot read is not proof hooks are absent')
assert.match(broken.summary, /not valid JSON/)

for (const d of [fakeHome, projectA, projectB, projectC, projectD]) {
  fs.rmSync(d, { recursive: true, force: true })
}
console.log('\nAll per-project registration tests passed.')
