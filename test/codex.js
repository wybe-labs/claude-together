// Codex registration and delivery. HOME and CODEX_HOME are temp dirs for the whole
// file: nothing here may read or rewrite the real ~/.codex/config.toml or a real
// claude-together store. The trust steps need the `codex` CLI; without it they are
// skipped (and say so), the rest still runs.
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-home-')))
const codexHome = path.join(fakeHome, '.codex')
fs.mkdirSync(codexHome)
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.CODEX_HOME = codexHome
delete process.env.CLAUDE_PROJECT_DIR
delete process.env.CLAUDE_TOGETHER_DIR
assert.equal(os.homedir(), fakeHome, 'test must not touch the real home directory')

const { installCodex, installCodexHooks, mcpServerConfig } = await import('../scripts/install-codex.js')
const { codexHooksStatus } = await import('../src/codex.js')
const { harnessName } = await import('../src/transport.js')
const { HOOK_SCRIPT, PKG_ROOT } = await import('../src/hooks.js')
const { projectKey } = await import('../src/scope.js')

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-codex-proj-')))
const hooksFile = path.join(project, '.codex', 'hooks.json')
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))

console.log('1. Harness names: Codex is told apart from Claude Code…')
assert.equal(harnessName({ CLAUDE_TOGETHER_CODEX: '1' }), 'codex')
assert.equal(harnessName({ CLAUDECODE: '1' }), 'claude-code')
assert.equal(harnessName({ SESSION_MULTIPLAYER_HARNESS: 'my-adapter', CLAUDE_TOGETHER_CODEX: '1' }), 'my-adapter', 'an explicit name is used as given')
assert.equal(harnessName({}), 'mcp')

console.log('2. Codex hooks go in the project, merge with foreign hooks, and stay single…')
fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo someone-elses-hook' }] }] } }))
installCodexHooks(project)
installCodexHooks(project)
const h = readJson(hooksFile)
assert.equal(h.hooks.Stop.length, 2, 'foreign Stop hook kept, ours added once')
assert.match(h.hooks.Stop[0].hooks[0].command, /someone-elses-hook/)
assert.equal(h.hooks.PostToolUse.length, 1)
assert.equal(h.hooks.PostToolUse[0].matcher, '.*', 'Codex matchers are regexes')
assert.equal(h.hooks.UserPromptSubmit.length, 1)
assert.ok(codexHooksStatus(project).complete, 'status sees all three events')
assert.ok(!codexHooksStatus(path.join(project, 'nope')).installed, 'status reports a missing install')

console.log('3. The MCP server is pinned to the project and labelled as Codex…')
const mcp = mcpServerConfig(project)
assert.equal(mcp.cwd, project)
assert.equal(mcp.env.CLAUDE_PROJECT_DIR, project)
assert.equal(mcp.env.CLAUDE_TOGETHER_CODEX, '1')
assert.ok(mcp.env_vars.includes('CLAUDE_TOGETHER_LABEL'), 'user settings reach the server through Codex\'s minimal environment')

console.log('3b. The project TOML keeps foreign content and holds our table once…')
const { writeMcpServerToml } = await import('../scripts/install-codex.js')
const tomlFile = path.join(project, '.codex', 'config.toml')
fs.writeFileSync(tomlFile, 'model = "x"\n\n[mcp_servers.claude-together]\ncommand = "old"\n\n[mcp_servers.claude-together.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "keep"\n')
writeMcpServerToml(tomlFile, mcp)
writeMcpServerToml(tomlFile, mcp)
const toml = fs.readFileSync(tomlFile, 'utf8')
assert.equal(toml.match(/\[mcp_servers\.claude-together\]/g).length, 1)
assert.ok(!toml.includes('"old"') && !toml.includes('A = "1"'), 'stale table and sub-table replaced')
assert.match(toml, /^model = "x"$/m)
assert.match(toml, /\[mcp_servers\.other\]\ncommand = "keep"/)

console.log('4. Under Codex the hook drains its own project\'s inbox, whatever the cwd and environment…')
const inbox = path.join(fakeHome, '.claude-together', 'projects', projectKey(project), 'inbox')
fs.mkdirSync(inbox, { recursive: true })
fs.writeFileSync(path.join(inbox, '1.json'), JSON.stringify({ roomName: 'bug-hunt', from: 'alice', text: 'check session.ts', priority: 'normal', ts: 1, harness: 'claude-code' }))
const sub = path.join(project, 'src', 'deep')
fs.mkdirSync(sub, { recursive: true })
const env = { ...process.env }
delete env.CLAUDE_PROJECT_DIR
// As Codex runs it: from a subfolder, with an unrelated CLAUDE_PROJECT_DIR inherited
// from wherever Codex was launched. The project argument must win.
env.CLAUDE_PROJECT_DIR = path.join(fakeHome, 'some-other-project')
const runHook = (mode, stdin = '{}') => spawnSync(process.execPath, [HOOK_SCRIPT, mode, project], { cwd: sub, env, input: stdin, encoding: 'utf8' })
assert.equal(runHook('posttool').stdout, '', 'normal messages are not injected mid-turn')
const stop = runHook('stop', JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: sub }))
const out = JSON.parse(stop.stdout)
assert.equal(out.decision, 'block', 'Stop continues the turn to relay the message')
assert.match(out.reason, /\[room: bug-hunt\] alice \(harness: claude-code\): check session\.ts/)
assert.match(out.reason, /untrusted data/)
assert.equal(fs.readdirSync(inbox).length, 0, 'delivered once')
assert.equal(runHook('stop', JSON.stringify({ stop_hook_active: false })).stdout, '', 'nothing left to deliver')

const codex = spawnSync(process.env.CODEX_BIN || 'codex', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
if (codex.status !== 0) {
  console.log('5–7. SKIPPED: no `codex` CLI on PATH, so Codex trust could not be checked.')
} else {
  spawnSync('git', ['init', '-q', project])
  // A repo's committed config can carry a hook that merely looks like ours.
  fs.appendFileSync(tomlFile, '\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo pwned # claude-together/scripts/hook.js stop"\n')
  console.log(`5. Codex itself confirms the project and all three hooks are trusted (${codex.stdout.trim()})…`)
  const r = await installCodex(project)
  assert.deepEqual([...r.events].sort(), ['postToolUse', 'stop', 'userPromptSubmit'], JSON.stringify(r))
  assert.equal(r.trustedNow, 3)
  assert.ok(r.mcpSeen, 'Codex reads the MCP server from the project config')
  const userToml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
  assert.ok(userToml.includes(`[projects."${project}"]`), 'project trusted in the (fake) user config')
  const projToml = fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')
  assert.match(projToml, /\[mcp_servers\.claude-together\]/)
  assert.ok(projToml.includes(JSON.stringify(path.join(PKG_ROOT, 'src', 'server.js'))), 'server path written')
  assert.match(projToml, /CLAUDE_TOGETHER_CODEX = "1"/)
  assert.ok(!userToml.includes('someone-elses-hook'), 'a foreign hook is not trusted on its owner\'s behalf')
  const { withAppServer } = await import('../src/codex.js')
  const listed = await withAppServer(call => call('hooks/list', { cwds: [project] }))
  const lookAlike = listed.data[0].hooks.find(x => x.command.includes('pwned'))
  assert.ok(lookAlike, 'Codex sees the look-alike hook')
  assert.notEqual(lookAlike.trustStatus, 'trusted', 'a look-alike of our hook is never trusted')
  assert.deepEqual(r.alsoTrusted, ['model', '[mcp_servers.other]', '[hooks.Stop]', '[hooks.Stop.hooks]'],
    'the rest of the project setup is named before it is trusted, and our own table is not')

  console.log('6. Machine-specific files are kept out of git locally…')
  const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8')
  assert.match(exclude, /^\/\.codex\/hooks\.json$/m)
  assert.match(exclude, /^\/\.codex\/config\.toml$/m)

  console.log('7. Registering again changes nothing and trusts nothing new…')
  const again = await installCodex(project)
  assert.equal(again.trustedNow, 0)
  assert.equal(again.events.length, 3)
  assert.equal(again.git.excluded.length, 0, 'exclude lines not duplicated')
}

console.log('8. A missing codex CLI fails fast instead of waiting out the timeout…')
const { withAppServer: was } = await import('../src/codex.js')
const t0 = Date.now()
await assert.rejects(was(async () => {}, { bin: path.join(fakeHome, 'no-such-codex') }))
assert.ok(Date.now() - t0 < 5000, 'rejected quickly')

fs.rmSync(fakeHome, { recursive: true, force: true })
fs.rmSync(project, { recursive: true, force: true })
console.log('\nAll Codex tests passed.')
