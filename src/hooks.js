// Where delivery hooks live and whether they are installed.
//
// Without them a session still joins rooms and still sends, but nothing arrives on its
// own: messages sit in the inbox until someone asks for them. That looks exactly like a
// quiet room, so it needs to be visible rather than inferred.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { projectDir } from './scope.js'

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const HOOK_SCRIPT = path.join(PKG_ROOT, 'scripts', 'hook.js')
export const HOOK_EVENTS = ['PostToolUse', 'Stop', 'UserPromptSubmit']

// Recognize our own hook entries. The reliable test is the absolute path of the hook
// script this checkout installs: it is what we wrote, whatever the folder is called.
// The name heuristic stays as a fallback so entries written by a checkout at a path we
// no longer know (an older clone, since moved) are still recognized and cleaned up; it
// requires the script name too, so unrelated commands can't match.
export function isOurs (command, hookScript = HOOK_SCRIPT) {
  const c = String(command || '')
  if (hookScript && c.includes(hookScript)) return true
  const norm = c.toLowerCase().replace(/-/g, '')
  return norm.includes('claudetogether') && norm.includes('hook.js')
}

// Returns the events our hooks cover, or an unreadable marker. A settings file that
// will not parse is not evidence that hooks are absent, and saying "no hooks" there
// would send the reader off to install hooks that may already be present. Report what
// actually happened instead.
function eventsIn (settingsPath) {
  if (!fs.existsSync(settingsPath)) return []
  let settings
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (err) {
    return { unreadable: err.message }
  }
  return HOOK_EVENTS.filter(event =>
    (settings.hooks?.[event] || []).some(e => (e.hooks || []).some(h => isOurs(h.command))))
}

// Reports where delivery hooks were found for this project, and whether all three
// events are covered. A partial install is called out: two of three still leaves a
// class of message that never arrives.
export function hooksStatus (dir = projectDir()) {
  const projectSettings = path.join(dir, '.claude', 'settings.local.json')
  const sharedSettings = path.join(dir, '.claude', 'settings.json')
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json')

  for (const [scope, settingsPath] of [
    ['project', projectSettings],
    ['project (shared settings.json)', sharedSettings],
    ['user-wide (pre-0.4 install, fires in every project)', userSettings]
  ]) {
    const events = eventsIn(settingsPath)
    if (!Array.isArray(events)) {
      return {
        installed: false,
        complete: false,
        scope,
        settingsPath,
        events: [],
        summary: `cannot tell whether delivery hooks are installed: ${settingsPath} is not ` +
          `valid JSON (${events.unreadable}). Fix that file, then re-run register.`
      }
    }
    if (events.length === 0) continue
    const complete = events.length === HOOK_EVENTS.length
    return {
      installed: true,
      complete,
      scope,
      settingsPath,
      events,
      summary: complete
        ? `delivery hooks installed ${scope} (${settingsPath})`
        : `delivery hooks only PARTLY installed ${scope}: ${events.join(', ')} — ` +
          `missing ${HOOK_EVENTS.filter(e => !events.includes(e)).join(', ')}. ` +
          'Re-run register in this project.'
    }
  }

  return {
    installed: false,
    complete: false,
    scope: null,
    settingsPath: projectSettings,
    events: [],
    summary: 'NO delivery hooks for this project — incoming messages will NOT appear on ' +
      'their own, they wait in the inbox until check_messages is called. Tell your user, ' +
      `and to fix it: run "npm --prefix ${PKG_ROOT} run register" in this project, then ` +
      'restart Claude Code.'
  }
}
