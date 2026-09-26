import fs from 'node:fs'
import path from 'node:path'
import b4a from 'b4a'
import { scopedDir, identityFile } from './scope.js'
import { signKeyPair } from './crypto.js'

const LOG_REPLAY_MAX = 200
const LOG_REPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LOG_TRIM_AT = 600
// Dedup only needs to remember ids as long as they can still be replayed to us
// (the log replay window, times a handful of rooms). MAX_SEEN is far above that,
// so bounding it can't cause a real duplicate; it just caps memory and disk.
const MAX_SEEN = 20_000
const SEEN_COMPACT_AT = 60_000

// Rooms held by another store on this machine, read without instantiating it (that
// would create directories and run migrations in someone else's store).
export function roomsInStore (dir) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  } catch {
    return []
  }
  return Object.entries(config.rooms || {}).map(([id, r]) => ({
    id, name: r.name, key: b4a.from(r.key, 'base64')
  }))
}

// Multi-process-safe persistence. Several Claude Code sessions may each run their own
// server instance against this same directory, so everything is either append-only
// (seen.jsonl, log/*.jsonl) or file-per-message keyed by message id (inbox/, outbox/) —
// concurrent writers converge instead of clobbering a shared JSON blob.
//
// Scoping: with no explicit dir and no CLAUDE_TOGETHER_DIR, the store lives in a
// per-project directory (~/.claude-together/projects/<key>) — room membership,
// inbox, and queues belong to the project a session runs in, never to the whole
// machine. Only the display name is machine-global (identity file at the root).
// An explicit dir (tests) or CLAUDE_TOGETHER_DIR keeps everything, name included,
// in that one directory.
//
// Layout:
//   config.json   — display name + room keys (small, rarely written, reloaded on read)
//   outbox/<id>.json — sent messages until some peer acks them
//   inbox/<id>.json  — received messages until the user reads them
//   seen.jsonl    — every message id ever ingested (dedup across restarts/instances)
//   log/<roomId>.jsonl — recent room history, replayed to peers when they reconnect
export class Store {
  constructor (dir) {
    const explicit = dir || process.env.CLAUDE_TOGETHER_DIR
    this.dir = explicit || scopedDir()
    this.identityFile = explicit ? null : identityFile()
    for (const d of ['', 'outbox', 'inbox', 'log', 'members']) {
      fs.mkdirSync(path.join(this.dir, d), { recursive: true })
    }
    this._migrate()
    // Load the tail of the seen log into an insertion-ordered Set (a JS Set iterates
    // in insertion order, so the oldest id is always values().next()). Only the last
    // MAX_SEEN survive, bounding memory even if a legacy file grew huge.
    const lines = this._readLines('seen.jsonl')
    this._seen = new Set(lines.slice(-MAX_SEEN))
    this._seenAppends = lines.length // triggers compaction if the file is oversized
    if (this._seenAppends > SEEN_COMPACT_AT) this._compactSeen()
  }

  _file (...p) { return path.join(this.dir, ...p) }

  // Message and room ids become filenames. Only our own id shape is allowed, so a
  // peer-supplied id can never path-traverse out of the store. Callers validate too
  // (defence in depth) — this is the last line before the filesystem.
  _safeId (id) { return typeof id === 'string' && /^[0-9a-f]{1,64}$/.test(id) }

  _readJson (file, fallback) {
    try { return JSON.parse(fs.readFileSync(this._file(file), 'utf8')) } catch { return fallback }
  }

  _writeJson (file, value) {
    const tmp = this._file(file + '.' + process.pid + '.tmp')
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, this._file(file))
  }

  _readLines (file) {
    try {
      return fs.readFileSync(this._file(file), 'utf8').split('\n').filter(Boolean)
    } catch { return [] }
  }

  // v0.1 kept everything in state.json; carry over the name and room keys.
  _migrate () {
    if (fs.existsSync(this._file('config.json'))) return
    const old = this._readJson('state.json', null)
    if (!old) return
    const config = { name: old.name || null, rooms: old.rooms || {} }
    this._writeJson('config.json', config)
    for (const id of old.seen || []) {
      fs.appendFileSync(this._file('seen.jsonl'), id + '\n')
    }
  }

  // --- config (reloaded on every read: another instance may have added a room) ---

  _config () { return this._readJson('config.json', { name: null, rooms: {} }) }

  // The identity file (machine-global display name + signing keypair) may be the
  // legacy pre-scoping config.json, which also holds old room keys —
  // read-modify-write preserves them for anyone running CLAUDE_TOGETHER_DIR
  // pointed at the root.
  _readIdentity () {
    if (!this.identityFile) return this._config()
    try { return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')) } catch { return {} }
  }

  _updateIdentity (mutate) {
    const c = this._readIdentity()
    mutate(c)
    if (this.identityFile) {
      const tmp = this.identityFile + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2))
      fs.renameSync(tmp, this.identityFile)
    } else {
      this._writeJson('config.json', c)
    }
  }

  getName () { return this._readIdentity().name || null }

  // Where discovery bootstraps, remembered machine-wide rather than per project: it
  // describes the network this computer is on, which does not change between checkouts.
  // Null means the public nodes. CLAUDE_TOGETHER_BOOTSTRAP still wins for a process
  // that sets it, so an explicit environment is never quietly overridden by a stored one.
  getBootstrap () {
    const stored = this._readIdentity().bootstrap
    return Array.isArray(stored) && stored.length ? stored : null
  }

  // Public key of a node that will carry connections which cannot be made directly.
  // Machine-wide for the same reason as the bootstrap: it is a property of the network
  // this computer sits on.
  getRelay () {
    const stored = this._readIdentity().relay
    return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) ? stored : null
  }

  setRelay (key) {
    this._updateIdentity(c => {
      if (key) c.relay = key
      else delete c.relay
    })
  }

  setBootstrap (nodes) {
    this._updateIdentity(c => {
      if (nodes && nodes.length) c.bootstrap = nodes
      else delete c.bootstrap
    })
  }

  setName (name) {
    this._updateIdentity(c => { c.name = name })
  }

  // Long-lived ed25519 identity keypair, generated on first use. Lives with the
  // display name (machine-global by default), so "einar" keeps one stable public
  // key across sessions and projects — the anchor for TOFU sender authenticity.
  signingKeyPair () {
    const c = this._readIdentity()
    if (c.signPk && c.signSk) {
      return { publicKey: b4a.from(c.signPk, 'base64'), secretKey: b4a.from(c.signSk, 'base64') }
    }
    const kp = signKeyPair()
    this._updateIdentity(cfg => {
      cfg.signPk = b4a.toString(kp.publicKey, 'base64')
      cfg.signSk = b4a.toString(kp.secretKey, 'base64')
    })
    return kp
  }

  addRoom (id, name, keyBuf) {
    const c = this._config()
    // Re-adding a room (a fresh invite into one you're already in) must not silently
    // re-arm interrupts: carry the existing choice over.
    c.rooms[id] = {
      name,
      key: b4a.toString(keyBuf, 'base64'),
      allowInterrupt: c.rooms[id]?.allowInterrupt === true
    }
    this._writeJson('config.json', c)
  }

  // Mid-turn interrupts are opt-in per room, and the choice belongs to the receiving
  // session: it runs shell, docker and git, so whether a peer may barge into its turn
  // is not the sender's call. Off means the message still arrives, at turn end.
  setRoomInterrupts (id, allow) {
    const c = this._config()
    if (!c.rooms[id]) throw new Error(`no room with id ${id} in this project's store`)
    c.rooms[id].allowInterrupt = allow === true
    this._writeJson('config.json', c)
  }

  removeRoom (id) {
    const c = this._config()
    delete c.rooms[id]
    this._writeJson('config.json', c)
    for (const m of this.outboundFor(id)) this.ackOutbound(m.id)
    try { fs.rmSync(this._file('log', id + '.jsonl'), { force: true }) } catch {}
    try { fs.rmSync(this._file('members', id + '.json'), { force: true }) } catch {}
  }

  // One-shot per project store: returns the names of pre-0.3 machine-global rooms
  // (still sitting in the root identity/config file) so the server can explain,
  // once, why they are no longer joined after the per-project scoping change.
  takeLegacyRoomsNotice () {
    if (!this.identityFile) return null // explicit dir = old behavior, nothing changed
    if (this._config().legacyNoticeShown) return null
    const c = this._config()
    c.legacyNoticeShown = true
    this._writeJson('config.json', c)
    const names = Object.values(this._readIdentity().rooms || {}).map(r => r?.name).filter(Boolean)
    return names.length ? names : null
  }

  rooms () {
    return Object.entries(this._config().rooms).map(([id, r]) => ({
      id, name: r.name, key: b4a.from(r.key, 'base64'), allowInterrupt: r.allowInterrupt === true
    }))
  }

  // --- open pairings, kept across restarts ---
  //
  // A rendezvous id is public and has no expiry, so the only thing that used to end
  // one was this process exiting — which made "it does not expire" untrue in the way
  // that matters: share an id, restart, and your friend is answering a rendezvous
  // nobody is listening on, with nothing to tell them so.
  //
  // The agreement key is stored with it. Regenerating it on restore would change the
  // number this side shows, so a peer holding the old one would see a second entry
  // appear under the same name with a different number — the exact shape of the
  // impersonation the comparison exists to catch. It is an ephemeral per-pairing
  // secret in a store that already holds the room keys and the signing key.

  savePairing (p) {
    const c = this._config()
    c.pairings = c.pairings || {}
    c.pairings[p.id] = {
      role: p.role,
      roomId: p.roomId || null,
      roomName: p.roomName || null,
      ephPublicKey: b4a.toString(p.eph.publicKey, 'base64'),
      ephSecretKey: b4a.toString(p.eph.secretKey, 'base64'),
      nonce: b4a.toString(p.nonce, 'base64')
    }
    this._writeJson('config.json', c)
  }

  pairings () {
    return Object.entries(this._config().pairings || {}).map(([id, p]) => ({
      id,
      role: p.role,
      roomId: p.roomId || null,
      roomName: p.roomName || null,
      eph: {
        publicKey: b4a.from(p.ephPublicKey, 'base64'),
        secretKey: b4a.from(p.ephSecretKey, 'base64')
      },
      nonce: b4a.from(p.nonce, 'base64')
    }))
  }

  removePairing (id) {
    const c = this._config()
    if (!c.pairings || !c.pairings[id]) return
    delete c.pairings[id]
    this._writeJson('config.json', c)
  }

  roomByName (name) {
    const matches = this.rooms().filter(r => r.name.toLowerCase() === name.toLowerCase())
    return matches[0] || null
  }

  // --- dedup ---

  // O(1), pure memory. Cross-process consistency isn't needed here: duplicate inbox
  // writes are idempotent (keyed by id) and replay dedups by id on the receiver, so a
  // second local session re-ingesting is harmless. This set only stops THIS process
  // re-emitting the same message (e.g. gossiped from two peers).
  hasSeen (id) { return this._seen.has(id) }

  markSeen (id) {
    if (!this._safeId(id) || this._seen.has(id)) return
    this._seen.add(id)
    fs.appendFileSync(this._file('seen.jsonl'), id + '\n')
    this._seenAppends++
    if (this._seen.size > MAX_SEEN) {
      // Evict the oldest id (first in insertion order) to bound memory.
      this._seen.delete(this._seen.values().next().value)
    }
    if (this._seenAppends >= SEEN_COMPACT_AT) this._compactSeen()
  }

  // Rewrite seen.jsonl with only the currently-retained ids, collapsing an append log
  // that has grown past SEEN_COMPACT_AT back down to the working set.
  _compactSeen () {
    const tmp = this._file('seen.jsonl.' + process.pid + '.tmp')
    fs.writeFileSync(tmp, [...this._seen].map(id => id + '\n').join(''))
    fs.renameSync(tmp, this._file('seen.jsonl'))
    this._seenAppends = this._seen.size
  }

  // --- outbox: file per message, deleted on first ack ---

  enqueueOutbound (msg) {
    if (!this._safeId(msg.id)) return
    this._writeJson(path.join('outbox', msg.id + '.json'), msg)
  }

  ackOutbound (id) {
    if (!/^[0-9a-f]+$/.test(id)) return
    try { fs.rmSync(this._file('outbox', id + '.json'), { force: true }) } catch {}
  }

  _readDir (sub) {
    const out = []
    for (const f of fs.readdirSync(this._file(sub))) {
      if (!f.endsWith('.json')) continue
      const m = this._readJson(path.join(sub, f), null)
      if (m) out.push(m)
    }
    return out.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  }

  outboundFor (roomId) {
    return this._readDir('outbox').filter(m => m.roomId === roomId)
  }

  pendingOutboundCount () { return this._readDir('outbox').length }

  // --- inbox: file per message, deleted when the user reads it ---

  pushInbound (msg) {
    if (!this._safeId(msg.id)) return
    this._writeJson(path.join('inbox', msg.id + '.json'), msg)
  }

  drainInbound () {
    const msgs = this._readDir('inbox')
    for (const m of msgs) {
      try { fs.rmSync(this._file('inbox', m.id + '.json'), { force: true }) } catch {}
    }
    return msgs
  }

  unreadCount () { return this._readDir('inbox').length }

  // --- room membership: names we've heard from, with last-seen timestamps ---
  // Best-effort (concurrent instances may race a write), purely informational.

  membersFor (roomId) {
    return this._readJson(path.join('members', roomId + '.json'), {})
  }

  touchMember (roomId, name, ts, info) {
    if (!name || !roomId) return
    const members = this.membersFor(roomId)
    const prev = members[name]
    const pinsKey = info?.pk && !prev?.pk && /^[0-9a-f]{64}$/.test(info.pk)
    const hasNewInfo = (info && (info.host || info.label || info.harness)) || pinsKey
    if (prev && prev.lastSeen >= ts && !hasNewInfo) return
    const next = { ...(prev || {}), lastSeen: Math.max(ts, prev?.lastSeen || 0) }
    if (info?.host) next.host = String(info.host).slice(0, 64)
    if (info?.label) next.label = String(info.label).slice(0, 64)
    if (info?.harness) next.harness = String(info.harness).slice(0, 32)
    // TOFU pin: a member's first verified public key sticks; it is never
    // overwritten here — a different key later is flagged upstream, not adopted.
    if (pinsKey) next.pk = info.pk
    members[name] = next
    this._writeJson(path.join('members', roomId + '.json'), members)
  }

  // --- room history log: what makes offline delivery work through friends ---

  appendLog (msg) {
    if (!this._safeId(msg.roomId) || !this._safeId(msg.id)) return
    fs.appendFileSync(this._file('log', msg.roomId + '.jsonl'), JSON.stringify(msg) + '\n')
    this._maybeTrim(msg.roomId)
  }

  logTail (roomId) {
    const cutoff = Date.now() - LOG_REPLAY_MAX_AGE_MS
    const lines = this._readLines(path.join('log', roomId + '.jsonl'))
    const out = []
    for (const line of lines) {
      try {
        const m = JSON.parse(line)
        if ((m.ts || 0) >= cutoff) out.push(m)
      } catch {}
    }
    return out.slice(-LOG_REPLAY_MAX)
  }

  _maybeTrim (roomId) {
    const file = path.join('log', roomId + '.jsonl')
    const lines = this._readLines(file)
    if (lines.length <= LOG_TRIM_AT) return
    const keep = lines.slice(-LOG_REPLAY_MAX)
    const tmp = this._file(file + '.' + process.pid + '.tmp')
    fs.writeFileSync(tmp, keep.join('\n') + '\n')
    fs.renameSync(tmp, this._file(file))
  }
}
