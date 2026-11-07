// Codex support: talking to Codex's own app-server, and where Codex keeps a project's
// claude-together setup.
//
// Codex reads a project's .codex/config.toml (MCP server) and .codex/hooks.json
// (delivery hooks) only when the project is trusted, and runs a hook only once its
// exact definition has been trusted by hash. Those hashes are Codex's to compute, so
// rather than re-deriving them we ask Codex: `hooks/list` reports each hook's key and
// current hash, and `config/batchWrite` records trust the same way Codex's own /hooks
// screen does. The same writer edits TOML for us, so no TOML library is needed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { isOurs, HOOK_SCRIPT, HOOK_EVENTS, readSettingsText } from './hooks.js'

export const MCP_NAME = 'claude-together'

export function codexHooksPath (project) {
  return path.join(project, '.codex', 'hooks.json')
}

export function codexConfigPath (project) {
  return path.join(project, '.codex', 'config.toml')
}

// Start `codex app-server`, run fn(call) against it, and always shut it down. JSON-RPC
// over stdio, one message per line; only responses to our own ids matter here.
export async function withAppServer (fn, { bin = process.env.CODEX_BIN || 'codex', timeoutMs = 30000 } = {}) {
  const isWin = process.platform === 'win32'
  // On Windows the CLI is a .cmd that only a shell resolves; quote it for paths with spaces.
  const child = spawn(isWin ? `"${bin}"` : bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell: isWin, windowsHide: true })
  let stderr = ''
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
  const pending = new Map()
  let nextId = 0
  let exited = null
  const failAll = err => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err) } pending.clear() }
  child.on('error', err => { exited = err; failAll(err) })
  child.on('exit', code => {
    exited = exited || new Error(`codex app-server exited (${code})${stderr ? `: ${stderr.trim()}` : ''}`)
    failAll(exited)
  })
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id == null || !pending.has(msg.id)) return
    const { resolve, reject, timer } = pending.get(msg.id)
    pending.delete(msg.id)
    clearTimeout(timer)
    if (msg.error) reject(new Error(`${msg.error.message || 'app-server error'} (${JSON.stringify(msg.error.data ?? msg.error.code)})`))
    else resolve(msg.result)
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    if (exited) return reject(exited)
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs / 1000}s`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await call('initialize', { clientInfo: { name: 'claude-together', version: '1' } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return await fn(call)
  } finally {
    child.stdin.end()
    child.kill()
  }
}

// Codex keys trust by the real path (on macOS /tmp is /private/tmp).
export function realProject (project) {
  try { return fs.realpathSync(project) } catch { return path.resolve(project) }
}

// Our delivery hooks as Codex lists them for this project.
// Only what register:codex itself wrote counts: the exact command, from the exact
// hooks.json. Anything else that merely resembles it — a look-alike in a committed
// .codex/config.toml, or a parent folder's hooks.json — is never trusted on our say-so.
export async function listOurCodexHooks (call, project, { hooksFile = codexHooksPath(project), commands } = {}) {
  const res = await call('hooks/list', { cwds: [project] })
  const entry = (res?.data || [])[0] || { hooks: [], warnings: [], errors: [] }
  const exact = new Set(commands)
  const ours = (entry.hooks || []).filter(h => h.handlerType === 'command' &&
    exact.has(h.command) && h.sourcePath && realProject(h.sourcePath) === realProject(hooksFile))
  return { ours, warnings: entry.warnings || [], errors: entry.errors || [] }
}

// Cheap, offline check used by the status tool: is the hooks file there and does it
// cover all three events? Whether Codex trusts them needs the app-server, which the
// status tool does not start; register reports that.
export function codexHooksStatus (dir) {
  const file = codexHooksPath(dir)
  const fix = `run npm --prefix "${path.resolve(HOOK_SCRIPT, '..', '..')}" run register:codex from this project, then restart the Codex session.`
  if (!fs.existsSync(file)) {
    return {
      installed: false,
      complete: false,
      scope: null,
      settingsPath: file,
      events: [],
      summary: 'NO Codex delivery hooks for this project — incoming messages will NOT appear on ' +
        `their own, they wait in the inbox until check_messages is called. Tell your user, and to fix it: ${fix}`
    }
  }
  let settings
  try {
    settings = JSON.parse(readSettingsText(file))
  } catch (err) {
    return { installed: false, complete: false, scope: 'codex project', settingsPath: file, events: [], summary: `cannot tell whether Codex delivery hooks are installed: ${file} is not valid JSON (${err.message}).` }
  }
  const events = HOOK_EVENTS.filter(event =>
    (Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [])
      .some(g => Array.isArray(g?.hooks) && g.hooks.some(h => isOurs(h?.command))))
  const complete = events.length === HOOK_EVENTS.length
  return {
    installed: events.length > 0,
    complete,
    scope: 'codex project',
    settingsPath: file,
    events,
    summary: complete
      ? `Codex delivery hooks installed (${file}); Codex runs them only while the project and the hooks are trusted — register:codex takes care of both`
      : events.length
        ? `Codex delivery hooks only PARTLY installed: ${events.join(', ')}. ${fix}`
        : `NO Codex delivery hooks in ${file}. ${fix}`
  }
}
