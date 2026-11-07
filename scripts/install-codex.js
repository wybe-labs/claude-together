// Registers claude-together with Codex for ONE project: `npm run register:codex`.
//
// The Codex counterpart of install-hooks.js + `claude mcp add --scope local`, kept per
// project for the same reason: a Codex session in a project you never registered has
// no claude-together tools and no delivery hooks.
//
//   <project>/.codex/hooks.json   the same hook.js, for PostToolUse / Stop / UserPromptSubmit
//   <project>/.codex/config.toml  [mcp_servers.claude-together], pinned to this project
//   ~/.codex/config.toml          the project marked trusted, and our hooks' hashes trusted
//
// Codex ignores a project's .codex/ folder until the project is trusted, and skips a
// hook until its exact definition is trusted, without saying so in the session. Both
// are recorded through Codex's own app-server (see src/codex.js), never by hand.
//
// Both project files hold absolute, machine-specific paths. Inside a git repo they are
// added to .git/info/exclude (local, uncommitted) unless the repo already tracks them.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_SCRIPT, PKG_ROOT, writeSettingsAtomic } from '../src/hooks.js'
import { readSettings, withoutOurs } from './install-hooks.js'
import {
  MCP_NAME, codexHooksPath, codexConfigPath, listOurCodexHooks, realProject, withAppServer
} from '../src/codex.js'
import { registrationTarget } from '../src/scope.js'

// Environment the MCP server may need from the session. Codex starts MCP servers with
// a minimal environment, so anything not listed here (or pinned in `env`) is not seen.
const FORWARDED_ENV = [
  'CLAUDE_TOGETHER_LABEL', 'CLAUDE_TOGETHER_DIR', 'CLAUDE_TOGETHER_BOOTSTRAP',
  'CLAUDE_TOGETHER_RELAY', 'CLAUDE_TOGETHER_INVITE_TTL_MIN'
]

// The exact command register:codex writes, and the only thing it will ever trust.
export function codexHookCommand (mode, project, { node = process.execPath, hookScript = HOOK_SCRIPT } = {}) {
  if ([node, hookScript, project].some(v => v.includes('"'))) throw new Error('paths containing a double quote are not supported')
  return `"${node}" "${hookScript}" ${mode} "${project}"`
}
export const HOOK_MODES = ['posttool', 'stop', 'prompt']

export function installCodexHooks (project, opts = {}) {
  const { hookScript = HOOK_SCRIPT } = opts
  const file = codexHooksPath(project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const settings = readSettings(file)
  const cmd = mode => codexHookCommand(mode, project, opts)
  const wanted = {
    // Codex matchers are regular expressions; "*" alone is not one.
    PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: cmd('posttool') }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }]
  }
  settings.hooks = settings.hooks || {}
  for (const [event, entries] of Object.entries(wanted)) {
    const existing = settings.hooks[event] ?? []
    if (!Array.isArray(existing)) {
      throw new Error(`${file}: hooks.${event} is not a list — fix it by hand first rather than have it overwritten`)
    }
    settings.hooks[event] = [...withoutOurs(existing, hookScript).kept, ...entries]
  }
  writeSettingsAtomic(file, settings)
  return file
}

export function mcpServerConfig (project, { node = process.execPath, server = path.join(PKG_ROOT, 'src', 'server.js') } = {}) {
  return {
    command: node,
    args: [server],
    // Codex may start MCP servers from its own working directory, not the session's;
    // the store is per project, so pin it rather than rely on cwd.
    cwd: project,
    env: { CLAUDE_PROJECT_DIR: project, CLAUDE_TOGETHER_CODEX: '1' },
    env_vars: FORWARDED_ENV,
    // Joining the DHT can take a few seconds on a cold start.
    startup_timeout_sec: 30
  }
}

// TOML for the one table we own. JSON string escapes are valid TOML basic strings.
const tomlValue = v => Array.isArray(v)
  ? `[${v.map(tomlValue).join(', ')}]`
  : v && typeof v === 'object'
    ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join(', ')} }`
    : typeof v === 'string' ? JSON.stringify(v) : String(v)

// Codex's app-server only writes the user config, so the project file is edited here:
// our table (and any sub-tables of it) is removed and written fresh at the end, and
// every other line is left exactly as it was.
export function writeMcpServerToml (file, config) {
  const ours = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${MCP_NAME}\\1\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`)
  const header = /^\s*\[/
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : ''
  const kept = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (header.test(line)) skipping = ours.test(line)
    if (!skipping) kept.push(line)
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  const table = [`[mcp_servers.${MCP_NAME}]`, ...Object.entries(config).map(([k, v]) => `${k} = ${tomlValue(v)}`)]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, [...kept, ...(kept.length ? [''] : []), ...table, ''].join('\n'))
  fs.renameSync(tmp, file)
  return file
}

// Trusting the project makes Codex load ALL of its .codex/ setup, not just ours: other
// MCP servers (which start with every session), sandbox and approval settings, other
// hooks. Name anything like that so the person registering sees what they also trust.
export function otherProjectSetup (project) {
  const found = new Set()
  const toml = codexConfigPath(project)
  if (!fs.existsSync(toml)) return []
  const oursRe = new RegExp(`^mcp_servers\\.\\s*"?${MCP_NAME}"?(\\.|$)`)
  let table = null // null = top level
  for (const line of fs.readFileSync(toml, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const header = t.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/)
    if (header) {
      table = header[1]
      if (!oursRe.test(table)) found.add(`[${table}]`)
    } else if (table === null) {
      found.add(t.split('=')[0].trim())
    }
  }
  return [...found]
}

// Keep machine-specific files out of commits without touching the repo's .gitignore.
export function excludeLocally (project, files) {
  const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' })
  const top = git('rev-parse', '--show-toplevel')
  if (top.status !== 0) return { repo: false, excluded: [], tracked: [] }
  const root = top.stdout.trim()
  const excludeFile = git('rev-parse', '--git-path', 'info/exclude').stdout.trim()
  const excludePath = path.isAbsolute(excludeFile) ? excludeFile : path.join(project, excludeFile)
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
  const lines = new Set(current.split(/\r?\n/))
  const excluded = []
  const tracked = []
  for (const f of files) {
    const rel = '/' + path.relative(fs.realpathSync(root), realProject(f)).split(path.sep).join('/')
    if (git('ls-files', '--error-unmatch', f).status === 0) { tracked.push(rel); continue }
    if (!lines.has(rel)) excluded.push(rel)
  }
  if (excluded.length) {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const sep = current && !current.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(excludePath, `${sep}# claude-together (machine-specific Codex setup)\n${excluded.join('\n')}\n`)
  }
  return { repo: true, excluded, tracked }
}

// Writes everything, then has Codex confirm it can see and run our three hooks.
export async function installCodex (target, opts = {}) {
  const project = realProject(target)
  const alsoTrusted = otherProjectSetup(project)
  const hooksFile = installCodexHooks(project, opts)
  const configFile = writeMcpServerToml(codexConfigPath(project), mcpServerConfig(project, opts))
  // Before Codex is involved, so a failure there never leaves these paths committable.
  const git = excludeLocally(project, [hooksFile, configFile])
  const commands = HOOK_MODES.map(m => codexHookCommand(m, project, opts))
  return withAppServer(async call => {
    await call('config/batchWrite', {
      edits: [{ keyPath: 'projects', value: { [project]: { trust_level: 'trusted' } }, mergeStrategy: 'upsert' }],
      reloadUserConfig: true
    })
    const { ours, warnings, errors } = await listOurCodexHooks(call, project, { hooksFile, commands })
    const toTrust = ours.filter(h => h.trustStatus === 'untrusted' || h.trustStatus === 'modified')
    if (toTrust.length) {
      await call('config/batchWrite', {
        edits: [{
          keyPath: 'hooks.state',
          value: Object.fromEntries(toTrust.map(h => [h.key, { trusted_hash: h.currentHash }])),
          mergeStrategy: 'upsert'
        }],
        reloadUserConfig: true
      })
    }
    const after = await listOurCodexHooks(call, project, { hooksFile, commands })
    // Read the MCP entry back the way a session in this project will see it.
    const effective = await call('config/read', { cwd: project })
    const mcpSeen = Boolean(effective?.config?.mcp_servers?.[MCP_NAME])
    const events = [...new Set(after.ours.filter(h => h.trustStatus === 'trusted' && h.enabled).map(h => h.eventName))]
    return {
      project,
      hooksFile,
      configFile,
      trustedNow: toTrust.length,
      mcpSeen,
      events,
      alsoTrusted,
      warnings: [...warnings, ...after.warnings],
      errors: [...errors, ...after.errors],
      git
    }
  }, opts)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await installCodex(registrationTarget())
  console.log(JSON.stringify(r, null, 2))
}
