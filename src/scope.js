import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Per-project scoping. Room membership is a property of the project directory a
// session runs in, not of the machine: each project gets its own store under
// ~/.claude-together/projects/<key>, so joining a room in one project never makes
// sessions in other projects members. The MCP server and the delivery hooks are
// both launched in the project directory (hooks additionally get
// CLAUDE_PROJECT_DIR), so both sides derive the same key with no coordination.
//
// CLAUDE_TOGETHER_DIR overrides scoping entirely: it names one exact store
// directory (the pre-0.3 machine-global behavior, and the escape hatch for tests
// or deliberately shared state).

export function root () {
  return path.join(os.homedir(), '.claude-together')
}

export function projectDir () {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd())
}

// Readable + collision-safe directory name: project basename, plus a hash of the
// full path (case-folded on case-insensitive filesystems) to disambiguate
// same-named folders in different places.
export function projectKey (dir = projectDir()) {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const norm = caseInsensitive ? dir.toLowerCase() : dir
  const digest = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12)
  const base = (path.basename(dir) || 'root').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return `${base}-${digest}`
}

export function scopedDir () {
  return process.env.CLAUDE_TOGETHER_DIR || path.join(root(), 'projects', projectKey())
}

// Every per-project store on this machine, newest name first. Used to find a room you
// already hold in another project: the key is already here, so copying it locally needs
// no pairing and grants nothing that was not already granted.
export function projectStores () {
  const dir = path.join(root(), 'projects')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map(name => ({ name, dir: path.join(dir, name) }))
    .filter(entry => fs.existsSync(path.join(entry.dir, 'config.json')))
}

// Display name stays machine-global — you are the same person in every project.
export function identityFile () {
  return path.join(root(), 'config.json')
}
