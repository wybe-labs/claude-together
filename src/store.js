import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import b4a from 'b4a'

const LOG_REPLAY_MAX = 200
const LOG_REPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LOG_TRIM_AT = 600

// Multi-process-safe persistence. Several Claude Code sessions may each run their own
// server instance against this same directory, so everything is either append-only
// (seen.jsonl, log/*.jsonl) or file-per-message keyed by message id (inbox/, outbox/) —
// concurrent writers converge instead of clobbering a shared JSON blob.
//
// Layout:
//   config.json   — display name + room keys (small, rarely written, reloaded on read)
//   outbox/<id>.json — sent messages until some peer acks them
//   inbox/<id>.json  — received messages until the user reads them
//   seen.jsonl    — every message id ever ingested (dedup across restarts/instances)
//   log/<roomId>.jsonl — recent room history, replayed to peers when they reconnect
export class Store {
  constructor (dir) {
    this.dir = dir || process.env.CLAUDE_TOGETHER_DIR || path.join(os.homedir(), '.claude-together')
    for (const d of ['', 'outbox', 'inbox', 'log']) {
      fs.mkdirSync(path.join(this.dir, d), { recursive: true })
    }
    this._migrate()
    this._seen = new Set(this._readLines('seen.jsonl'))
  }

  _file (...p) { return path.join(this.dir, ...p) }

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

  getName () { return this._config().name }

  setName (name) {
    const c = this._config()
    c.name = name
    this._writeJson('config.json', c)
  }

  addRoom (id, name, keyBuf) {
    const c = this._config()
    c.rooms[id] = { name, key: b4a.toString(keyBuf, 'base64') }
    this._writeJson('config.json', c)
  }

  removeRoom (id) {
    const c = this._config()
    delete c.rooms[id]
    this._writeJson('config.json', c)
    for (const m of this.outboundFor(id)) this.ackOutbound(m.id)
    try { fs.rmSync(this._file('log', id + '.jsonl'), { force: true }) } catch {}
  }

  rooms () {
    return Object.entries(this._config().rooms).map(([id, r]) => ({
      id, name: r.name, key: b4a.from(r.key, 'base64')
    }))
  }

  roomByName (name) {
    const matches = this.rooms().filter(r => r.name.toLowerCase() === name.toLowerCase())
    return matches[0] || null
  }

  // --- dedup ---

  hasSeen (id) {
    if (this._seen.has(id)) return true
    // Another instance on this machine may have ingested it after we loaded.
    const fresh = this._readLines('seen.jsonl')
    if (fresh.length !== this._seen.size) this._seen = new Set(fresh)
    return this._seen.has(id)
  }

  markSeen (id) {
    if (this._seen.has(id)) return
    this._seen.add(id)
    fs.appendFileSync(this._file('seen.jsonl'), id + '\n')
  }

  // --- outbox: file per message, deleted on first ack ---

  enqueueOutbound (msg) {
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

  // --- handoffs: received session-handoff docs, held until explicitly imported ---
  // Dir is created lazily (not in the constructor list) so this stays orthogonal
  // to other store layout changes.

  _handoffDir () {
    const d = this._file('handoffs')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  saveHandoff (id, doc, meta = {}) {
    if (!/^[0-9a-f]+$/.test(id)) throw new Error('bad handoff id')
    this._handoffDir()
    this._writeJson(path.join('handoffs', id + '.json'), { id, receivedAt: Date.now(), ...meta, doc })
    this._pruneHandoffs()
  }

  getHandoff (id) {
    if (!/^[0-9a-f]+$/.test(id)) return null
    return this._readJson(path.join('handoffs', id + '.json'), null)
  }

  hasHandoff (id) { return this.getHandoff(id) !== null }

  markHandoffImported (id, sessionId) {
    const h = this.getHandoff(id)
    if (!h) return
    h.importedAt = Date.now()
    h.importedSessionId = sessionId
    this._writeJson(path.join('handoffs', id + '.json'), h)
  }

  listHandoffs () {
    this._handoffDir()
    return this._readDir('handoffs')
      .sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0))
      .map(h => ({
        id: h.id,
        from: h.doc?.from,
        roomName: h.doc?.roomName,
        title: h.doc?.title,
        turns: h.doc?.messages?.length,
        receivedAt: h.receivedAt,
        imported: !!h.importedAt
      }))
  }

  _pruneHandoffs () {
    const all = this._readDir('handoffs').sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0))
    while (all.length > 10) {
      const drop = all.shift()
      try { fs.rmSync(this._file('handoffs', drop.id + '.json'), { force: true }) } catch {}
    }
  }

  // --- room history log: what makes offline delivery work through friends ---

  appendLog (msg) {
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
