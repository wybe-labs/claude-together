// Registers this MCP server with Claude Code for ONE project: `npm run register`
// Run it from the project you want to be reachable in (or set CLAUDE_PROJECT_DIR).
// Uses the exact node binary running this script, so it works with any Node install.
//
// Everything here is project-scoped on purpose: hooks in that project's
// .claude/settings.local.json, slash commands in its .claude/commands, and the MCP
// server at --scope local. Sessions in projects you never registered have no
// claude-together tools at all, so being joinable is something you opt into per
// project rather than machine-wide.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installHooks, removeUserWideHooks } from './install-hooks.js'
import { projectDir } from '../src/scope.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = path.join(root, 'src', 'server.js')
const project = projectDir()

if (project === root) {
  console.error(`Refusing to register: this looks like the claude-together checkout itself (${root}).`)
  console.error('Run `npm run register` from the project directory you want to be reachable in:')
  console.error(`  cd /path/to/your/project && npm --prefix "${root}" run register`)
  process.exit(1)
}

console.log(`Registering claude-together for project: ${project}\n`)

try {
  const where = installHooks(project)
  console.log(`Delivery hooks installed in ${where} (normal at turn end / passive inbox).`)
  console.log('Mid-turn interrupts stay off until you opt a room in.')
} catch (err) {
  console.error(`Could not install delivery hooks: ${err.message}`)
  console.error('Messages will still arrive, but only via /together-inbox.')
}

const { settingsPath: userSettings, events } = removeUserWideHooks()
if (events.length > 0) {
  console.log(`\nRemoved old user-wide hooks (${events.join(', ')}) from ${userSettings}.`)
  console.log('Those fired in every project on this machine. Re-run this in each project you want.')
}

// Install the /together-* slash commands for this project only.
const cmdSrc = path.join(root, 'commands')
const cmdDst = path.join(project, '.claude', 'commands')
fs.mkdirSync(cmdDst, { recursive: true })
const cmdFiles = fs.readdirSync(cmdSrc).filter(f => f.endsWith('.md'))
for (const f of cmdFiles) {
  fs.copyFileSync(path.join(cmdSrc, f), path.join(cmdDst, f))
}
console.log(`\nInstalled slash commands to ${cmdDst}: ${cmdFiles.map(f => '/' + f.replace(/\.md$/, '')).join(', ')}`)

const args = ['mcp', 'add', '--scope', 'local', 'claude-together', '--', process.execPath, server]

const isWin = process.platform === 'win32'
const res = spawnSync(isWin ? 'claude.cmd' : 'claude', args, { stdio: 'inherit', cwd: project, shell: isWin })

if (res.error || res.status !== 0) {
  console.error('\nCould not run the `claude` CLI automatically. Register manually from that project with:\n')
  console.error(`  claude mcp add --scope local claude-together -- "${process.execPath}" "${server}"\n`)
  process.exit(1)
}
console.log('\nRegistered for this project. Restart your Claude Code session, then say: "create an invite for room <name>".')
