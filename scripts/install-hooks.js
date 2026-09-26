// Merges the Claude Together delivery hooks into ONE project's
// .claude/settings.local.json. Idempotent: existing claude-together hook entries are
// replaced, everything else in the file is left untouched. Run directly or via
// `npm run register`.
//
// Per project, not user-wide, so that being reachable is a decision you make in the
// projects you want it in. A session in a project you never registered has no delivery
// hooks and no MCP server, and cannot be pulled into a room.
//
// settings.local.json rather than settings.json because the hook command embeds an
// absolute path to your node binary and this checkout — machine-specific, so it must
// not be committed to a shared repo.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { projectDir } from '../src/scope.js'
import { isOurs, HOOK_SCRIPT } from '../src/hooks.js'

function readSettings (settingsPath) {
  if (!fs.existsSync(settingsPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (err) {
    throw new Error(`${settingsPath} exists but is not valid JSON — fix it first (${err.message})`)
  }
}

export function installHooks (target = projectDir()) {
  const hookScript = HOOK_SCRIPT
  const settingsPath = path.join(target, '.claude', 'settings.local.json')

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const settings = readSettings(settingsPath)

  const cmd = mode => `"${process.execPath}" "${hookScript}" ${mode}`
  const wanted = {
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('posttool') }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }]
  }

  settings.hooks = settings.hooks || {}
  for (const [event, entries] of Object.entries(wanted)) {
    const existing = settings.hooks[event] || []
    const others = existing.filter(e =>
      !(e.hooks || []).some(h => isOurs(h.command, hookScript)))
    settings.hooks[event] = [...others, ...entries]
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

// Pre-0.4 installs put these hooks in ~/.claude/settings.json, where they fire in
// every project on the machine — exactly what per-project registration is meant to
// stop. Removes only our own entries; returns the events it cleaned, or [] if there
// was nothing there.
export function removeUserWideHooks () {
  const hookScript = HOOK_SCRIPT
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return { settingsPath, events: [] }
  const settings = readSettings(settingsPath)
  const events = []
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    const kept = entries.filter(e => !(e.hooks || []).some(h => isOurs(h.command, hookScript)))
    if (kept.length === entries.length) continue
    events.push(event)
    if (kept.length > 0) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
  if (events.length > 0) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { settingsPath, events }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const where = installHooks()
  console.log(`Delivery hooks installed in ${where}`)
  console.log('Messages now flow into sessions in THIS project: "normal" at turn end, "passive" in the inbox.')
  console.log('Mid-turn "interrupt" is off until a room is opted in — ask your Claude to allow interrupts for it.')
}
