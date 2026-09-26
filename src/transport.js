import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Hyperswarm from 'hyperswarm'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { projectStores } from './scope.js'
import { roomsInStore } from './store.js'
import {
  generateInviteCode, deriveCodeKey, derive, topicFor,
  randomBytes, mac, seal, open, timingSafeEqual, hash, sign, verify,
  generateRendezvousId, rendezvousTopic, ephemeralKeyPair, agree, pairingTranscript,
  sasFrom, normalizeSas, normalizeCode, formatCode, helloSignable, confirmSignable, fingerprint
} from './crypto.js'

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version

function cmpVersion (a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1
  }
  return 0
}

const AUTH_TIMEOUT_MS = 30_000
const PAIR_TIMEOUT_MS = 90_000
// Lifetime of a pre-0.4 invite code (the legacy secret-code path; v0.4 rendezvous ids
// do not expire). Long enough for a real handoff (say the code on a call, paste it in
// chat, wait for them to get to their keyboard) without minting a second code. Brute
// force is not what this bounds: 60 bits behind argon2id-64MB, single-use, guessable
// only online against a live announce, means even an hour is not attackable. What it
// bounds is how long a code left in a chat thread stays a working credential.
// Default 15 min; CLAUDE_TOGETHER_INVITE_TTL_MIN overrides it (minutes, clamped
// 1..1440), read at startup.
const INVITE_TTL_MS = (() => {
  const raw = Number(process.env.CLAUDE_TOGETHER_INVITE_TTL_MIN)
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 1), 1440) : 15
  return minutes * 60_000
})()

// Largest single newline-delimited frame we'll buffer from a peer. The biggest
// legitimate frame is one 16 KB message plus its base64/JSON envelope; 256 KB is
// generous headroom while still bounding a flood.
const MAX_LINE_BYTES = 256 * 1024

// One place that decides what a bootstrap list looks like, used for the environment
// variable and for the stored setting alike. A malformed value is refused rather than
// dropped: silently falling back to the public nodes would put this session on a
// different DHT from its peers, which looks exactly like nobody being online.
export function parseBootstrap (value) {
  if (value === null || value === undefined || value === '') return undefined
  const list = Array.isArray(value) ? value : String(value).split(',')
  const nodes = list.map(entry => String(entry).trim()).filter(Boolean)
  if (nodes.length === 0) return undefined
  for (const node of nodes) {
    if (!/^[^\s:@]+:\d+$/.test(node)) {
      throw new Error(`bootstrap nodes must be host:port, got "${node}". ` +
        'Use an address peers can reach, not a hostname that resolves to loopback.')
    }
  }
  return nodes
}

// A relay is named by the public key of a node both sides can reach. Hyperswarm only
// uses it once a direct connection has actually failed, so this changes nothing until
// the hole punch gives up.
export function parseRelay (value) {
  if (value === null || value === undefined || value === '') return undefined
  const hex = String(value).trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`a relay is a 64-character hex public key, got "${String(value).slice(0, 32)}". ` +
      'It names the node that will carry the connection, not an address.')
  }
  return b4a.from(hex, 'hex')
}

function roomIdFor (roomKey) {
  return b4a.toString(derive(roomKey, 'claude-together-roomid').subarray(0, 8), 'hex')
}

// Optional recipient list on a message: display names that should get the message
// at its active priority; everyone else in the room receives it passively.
function sanitizeTo (to) {
  if (!Array.isArray(to)) return undefined
  const out = []
  const seen = new Set()
  for (const n of to) {
    const name = String(n).trim().slice(0, 64)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 32) break
  }
  return out.length ? out : undefined
}

// A human-readable tag for THIS session, sent with the hello handshake and on
// every message so peers can tell your sessions apart. Claude Code launches MCP
// servers in the project directory, so the folder name is a good default;
// override with CLAUDE_TOGETHER_LABEL.
function sessionLabel () {
  if (process.env.CLAUDE_TOGETHER_LABEL) return process.env.CLAUDE_TOGETHER_LABEL.slice(0, 64)
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  return path.basename(dir).slice(0, 64)
}

// Which agent harness this server is running under. Adapters/users set the env
// var explicitly; CLAUDECODE=1 is set by Claude Code and serves as a fallback.
// NOTE: harness is deliberately NOT covered by the message signature — the
// 0.3.0 canonical signing form is frozen, so this field is advisory decoration
// like the version string. Kept identical to session-multiplayer for interop.
function harnessName () {
  const env = process.env.SESSION_MULTIPLAYER_HARNESS
  if (env) return env.slice(0, 32).replace(/[^A-Za-z0-9._ -]/g, '')
  if (process.env.CLAUDECODE) return 'claude-code'
  if (process.env.CODEX_HOME || process.env.CODEX_API_KEY) return 'codex'
  return 'mcp'
}

// Wire fields arrive as untrusted strings: accept only an exact-length hex blob, so
// a short/oversized/garbage value is rejected before it reaches a crypto primitive.
function hexBytes (value, len) {
  if (typeof value !== 'string' || value.length !== len * 2) return null
  if (!/^[0-9a-f]+$/.test(value)) return null
  return b4a.from(value, 'hex')
}

const SID_RE = /^[0-9a-f]{1,16}$/
const PK_RE = /^[0-9a-f]{64}$/
const SIG_RE = /^[0-9a-f]{128}$/
const HARNESS_RE = /^[A-Za-z0-9._ -]{1,32}$/

// Canonical byte string a message signature covers: every field a receiver acts
// on, in fixed order, excluding pk/sig themselves. Sender signs the final message
// object; receivers rebuild this from the raw wire fields, so any tampering in
// transit or relay breaks verification.
function signable (m) {
  return b4a.from(JSON.stringify([
    m.id, m.roomId, m.from, m.text, m.ts, m.priority, m.kind,
    m.host || '', m.label || '', m.sid || '',
    Array.isArray(m.to) ? m.to.join('\n') : ''
  ]))
}

// P2P layer. One Hyperswarm instance; every room is a DHT topic derived from its
// 256-bit room key; pairing happens on a short-lived topic derived from the invite code.
// Hyperswarm gives us ONE E2E Noise-encrypted socket per peer (connections are per-peer,
// not per-topic), so a single connection can carry several authenticated contexts:
// each side proves knowledge of its keys with nonce-bound MACs, and re-proves whenever
// it learns a new key (e.g. right after a pairing grant hands over the room key).
export class Together extends EventEmitter {
  constructor ({ store, bootstrap = undefined, relay = undefined } = {}) {
    super()
    this.store = store
    this.bootstrap = bootstrap
    this.relay = relay
    // Short per-process session id: distinguishes two sessions running in the
    // same project on the same machine (name, host, and label all match there).
    this.sid = b4a.toString(randomBytes(3), 'hex')
    this.swarm = null
    this.conns = new Set()               // all sockets, authed or not
    this.roomConns = new Map()           // roomId -> Set<conn>
    this.discoveries = new Map()         // topicHex -> discovery session
    this.pendingInvites = new Map()      // pairing topicHex -> { roomId, codeKey, timer, topic }
    this.pendingJoins = new Map()        // pairing topicHex -> { codeKey, resolve, reject, timer, topic, retry }
    // SAS pairing: rendezvous topicHex -> session. The rendezvous id is public and
    // does not expire, so a session lives until it grants, is cancelled, or the
    // process ends. Several peers can answer the same rendezvous at once — each gets
    // its own entry in session.peers with its own SAS, and the human picks by reading
    // the number back, which is what makes an impostor fail.
    this.pendingPairs = new Map()
    // Why recent pairing attempts were turned away. A rejected attempt is invisible to
    // both sides otherwise: the peer just sees a connection that goes nowhere, and
    // there is nothing to distinguish "nobody answered" from "someone answered and was
    // refused". Surfaced in status, newest last.
    this.pairRejections = []
    this._versionNotified = new Set()    // peer+version pairs already surfaced this process
  }

  async start () {
    if (!this.store.getName()) this.store.setName(os.userInfo().username)
    // Long-lived identity keypair for TOFU message signing (created on first run).
    this.keys = this.store.signingKeyPair()

    // Ephemeral keypair per process: several sessions on one machine (or several of
    // your machines) each show up as their own peer in the room mesh. Trust comes
    // from room keys, not from this connection identity.
    // relayThrough is consulted only after a direct connection fails, or when this
    // node's NAT randomizes ports, so naming a relay costs nothing while punching works.
    this.swarm = new Hyperswarm({
      keyPair: hypercoreCrypto.keyPair(),
      bootstrap: this.bootstrap,
      ...(this.relay ? { relayThrough: this.relay } : {})
    })
    this.swarm.on('connection', conn => this._onConnection(conn))

    for (const room of this.store.rooms()) this._joinTopic(topicFor(room.key, 'room'))

    // Rendezvous outlive the process that opened them: an id already shared has to
    // keep working after a restart, or "it does not expire" is only true until someone
    // restarts Claude Code. Peers re-announce themselves, so the peer list rebuilds
    // itself; only the session has to come back.
    for (const saved of this.store.pairings()) {
      const topic = rendezvousTopic(saved.id)
      const hex = b4a.toString(topic, 'hex')
      const session = {
        id: saved.id,
        role: saved.role,
        roomId: saved.roomId,
        roomName: saved.roomName,
        eph: saved.eph,
        nonce: saved.nonce,
        topic,
        hex,
        peers: new Map(),
        granted: false,
        resolve: null
      }
      this.pendingPairs.set(hex, session)
      this._joinTopic(topic)
      if (session.role === 'joiner') {
        session.retry = setInterval(() => {
          this.discoveries.get(hex)?.refresh().catch(() => {})
        }, 4_000)
        if (session.retry.unref) session.retry.unref()
      }
    }

    // Hyperswarm's own DHT re-query cadence is ~10 minutes; that's too slow for
    // "my friend just came online". Nudge lookups for rooms with no live peers,
    // and pick up rooms another local session joined since we started.
    this._maintenance = setInterval(() => {
      for (const room of this.store.rooms()) {
        const hex = b4a.toString(topicFor(room.key, 'room'), 'hex')
        if (!this.discoveries.has(hex)) {
          this._joinTopic(topicFor(room.key, 'room'))
          this._reproveAll()
          continue
        }
        if (this.roomConns.get(room.id)?.size) continue
        this.discoveries.get(hex)?.refresh().catch(() => {})
      }
      this.retryOutbound()
    }, 30_000)
    if (this._maintenance.unref) this._maintenance.unref()
  }

  // Point discovery somewhere else without restarting Claude Code. Hyperswarm binds its
  // bootstrap when the swarm is constructed, so the swarm is rebuilt — rooms and open
  // rendezvous come back from the store on the way up, and peers reconnect on their own.
  // Live connections do drop: they belong to the DHT being left behind.
  async reconfigureBootstrap (nodes) {
    const parsed = parseBootstrap(nodes)
    this.store.setBootstrap(parsed || null)
    await this._rebuild(() => { this.bootstrap = parsed })
    return { bootstrap: parsed || null }
  }

  // Route through a relay when a direct connection cannot be made. Hyperswarm falls
  // back to it only on a failed punch, so this is a safety net rather than a mode.
  async reconfigureRelay (key) {
    const parsed = parseRelay(key)
    this.store.setRelay(parsed ? b4a.toString(parsed, 'hex') : null)
    await this._rebuild(() => { this.relay = parsed })
    return { relay: parsed ? b4a.toString(parsed, 'hex') : null }
  }

  // Swarm settings are bound at construction, so changing one means building a new
  // swarm. Rooms and open rendezvous come back from the store on the way up; live
  // connections drop, because they belong to the setup being replaced.
  async _rebuild (apply) {
    await this.stop()
    this.conns.clear()
    this.roomConns.clear()
    this.discoveries.clear()
    apply()
    await this.start()
  }

  async stop () {
    clearInterval(this._maintenance)
    for (const { timer } of this.pendingInvites.values()) clearTimeout(timer)
    for (const { timer, reject, retry } of this.pendingJoins.values()) {
      clearTimeout(timer)
      clearInterval(retry)
      reject(new Error('shutting down'))
    }
    this.pendingJoins.clear()
    for (const session of this.pendingPairs.values()) {
      clearInterval(session.retry)
      session.resolve?.()
    }
    this.pendingPairs.clear()
    await this.swarm?.destroy()
  }

  // --- topics ---

  _joinTopic (topic) {
    const hex = b4a.toString(topic, 'hex')
    if (this.discoveries.has(hex)) return
    this.discoveries.set(hex, this.swarm.join(topic, { server: true, client: true }))
  }

  async _leaveTopic (topic) {
    const hex = b4a.toString(topic, 'hex')
    if (!this.discoveries.has(hex)) return
    this.discoveries.delete(hex)
    try { await this.swarm.leave(topic) } catch {}
  }

  // --- rooms / invites ---

  createRoom (name) {
    const key = randomBytes(32)
    const id = roomIdFor(key)
    this.store.addRoom(id, name, key)
    this._joinTopic(topicFor(key, 'room'))
    return { id, name }
  }

  // Fully leave a room: forget the key, stop announcing on its DHT topic, and tear
  // down the live room contexts — otherwise messages keep arriving on connections
  // whose proof outlives our membership, until the process restarts.
  async leaveRoom (roomName) {
    const room = this.store.roomByName(roomName)
    if (!room) return null
    await this._leaveTopic(topicFor(room.key, 'room'))
    for (const conn of [...(this.roomConns.get(room.id) || [])]) {
      const s = conn._ct
      s?.rooms.delete(room.id)
      // A socket that no longer carries any proven context has no reason to live.
      if (s && s.rooms.size === 0 && s.pairs.size === 0) conn.destroy()
    }
    this.roomConns.delete(room.id)
    this.store.removeRoom(room.id)
    return room
  }

  // Returns a short single-use code. Anyone who redeems it within its TTL gets this
  // room's key over a code-authenticated channel; then the code is dead.
  createInvite (roomName) {
    let room = this.store.roomByName(roomName)
    if (!room) {
      this.createRoom(roomName)
      room = this.store.roomByName(roomName)
    }
    const code = generateInviteCode()
    const codeKey = deriveCodeKey(code)
    const topic = topicFor(codeKey, 'pairing')
    const hex = b4a.toString(topic, 'hex')

    const timer = setTimeout(() => this._expireInvite(hex), INVITE_TTL_MS)
    if (timer.unref) timer.unref()
    this.pendingInvites.set(hex, { roomId: room.id, codeKey, timer, topic })
    this._joinTopic(topic)
    this._reproveAll()
    return { code, roomName: room.name, expiresInMinutes: INVITE_TTL_MS / 60000 }
  }

  _expireInvite (hex) {
    const inv = this.pendingInvites.get(hex)
    if (!inv) return
    clearTimeout(inv.timer)
    this.pendingInvites.delete(hex)
    this._leaveTopic(inv.topic)
  }

  joinWithCode (code) {
    const codeKey = deriveCodeKey(code)
    const topic = topicFor(codeKey, 'pairing')
    const hex = b4a.toString(topic, 'hex')

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const join = this.pendingJoins.get(hex)
        clearInterval(join?.retry)
        this.pendingJoins.delete(hex)
        this._leaveTopic(topic)
        reject(new Error('Timed out waiting for the inviter. Make sure their session is open and the code is fresh.'))
      }, PAIR_TIMEOUT_MS)
      // Re-run the DHT lookup every few seconds — the inviter's announce may land
      // after our first query, and hyperswarm's own refresh cadence is minutes.
      const retry = setInterval(() => {
        this.discoveries.get(hex)?.refresh().catch(() => {})
      }, 4_000)
      if (retry.unref) retry.unref()
      this.pendingJoins.set(hex, { codeKey, resolve, reject, timer, topic, retry })
      this._joinTopic(topic)
      this._reproveAll()
    })
  }

  // Copy a room this machine already holds from another project's store into this one.
  //
  // Pairing exists to move a room key between two people with no prior trust, which is
  // why it costs a rendezvous and a number read aloud. Between two directories the same
  // person owns there is no second party and no new trust: the key is already here. So
  // this is local and offline, and it can grant nothing that was not already granted.
  //
  // The other members are told, because a second session gaining read access to the
  // room is their business even when it belongs to someone already in it.
  linkRoom (roomName) {
    const wanted = String(roomName || '').trim().toLowerCase()
    if (!wanted) throw new Error('which room? give the name as it appears in the other project')

    const mine = this.store.roomByName(roomName)
    if (mine) return { alreadyMember: true, name: mine.name }

    const found = []
    for (const store of projectStores()) {
      if (path.resolve(store.dir) === path.resolve(this.store.dir)) continue
      for (const room of roomsInStore(store.dir)) {
        if (String(room.name || '').toLowerCase() === wanted) found.push({ ...room, from: store.name })
      }
    }

    if (found.length === 0) {
      const seen = [...new Set(projectStores()
        .flatMap(s => roomsInStore(s.dir).map(r => r.name)))]
      throw new Error(seen.length
        ? `no project on this machine holds a room called "${roomName}". Rooms found elsewhere: ${seen.join(', ')}.`
        : `no other project on this machine holds any room, so there is nothing to link. Pair into "${roomName}" instead.`)
    }

    // Same name, different key means two unrelated rooms. Guessing which one is meant
    // would hand this project into the wrong conversation.
    const distinct = [...new Set(found.map(r => r.id))]
    if (distinct.length > 1) {
      throw new Error(`"${roomName}" names ${distinct.length} different rooms on this machine ` +
        `(${found.map(r => `${r.id.slice(0, 8)} in ${r.from}`).join(', ')}). ` +
        'They are not the same conversation — link by pairing instead, so the right one is chosen deliberately.')
    }

    const room = found[0]
    this.store.addRoom(room.id, room.name, room.key)
    this._joinTopic(topicFor(room.key, 'room'))
    this._reproveAll()
    this._broadcast(room.id, {
      text: `linked this room into another project on the same machine (${sessionLabel()})`,
      priority: 'normal',
      kind: 'presence'
    })
    return { name: room.name, id: room.id, from: room.from }
  }

  // --- SAS pairing ---
  //
  // No shared secret. Both sides meet at a public rendezvous, exchange identity keys
  // bound to fresh X25519 keys by a signature, and derive a six-digit number from the
  // transcript. The humans read that number to each other; matching numbers mean no
  // one is in the middle, because a relay must present its own key to at least one
  // side and that changes the number it sees. The room key is then encrypted to the
  // agreed secret, so a passive relay that forwards everything untouched still learns
  // nothing. Nothing here expires: secrecy is not what is protecting the exchange.

  _pairReject (reason, detail = {}) {
    this.pairRejections.push({ at: new Date().toISOString(), reason, ...detail })
    if (this.pairRejections.length > 20) this.pairRejections.shift()
    this.emit('warning', new Error(`pairing attempt refused: ${reason}`))
  }

  _pairSessionFor (id) {
    const want = normalizeCode(String(id || ''))
    if (!want) return null
    for (const session of this.pendingPairs.values()) {
      if (normalizeCode(session.id) === want) return session
    }
    return null
  }

  _pairingView (session) {
    return {
      id: session.id,
      role: session.role,
      roomName: session.roomName || null,
      peers: [...session.peers.values()].map(p => ({
        name: p.name,
        host: p.host,
        label: p.label,
        fingerprint: fingerprint(p.pk),
        sas: p.sas,
        confirmed: p.localConfirmed
      }))
    }
  }

  createPairing (roomName) {
    let room = this.store.roomByName(roomName)
    if (!room) {
      this.createRoom(roomName)
      room = this.store.roomByName(roomName)
    }
    const id = generateRendezvousId()
    const topic = rendezvousTopic(id)
    const hex = b4a.toString(topic, 'hex')
    const session = {
      id,
      role: 'inviter',
      roomId: room.id,
      roomName: room.name,
      eph: ephemeralKeyPair(),
      nonce: randomBytes(24),
      topic,
      hex,
      peers: new Map(),
      granted: false
    }
    this.pendingPairs.set(hex, session)
    this.store.savePairing(session)
    this._joinTopic(topic)
    for (const conn of this.conns) this._sendPairHello(conn, session)
    return { id, roomName: room.name }
  }

  // Resolves as soon as a peer answers, or after firstLookMs with an empty peer list —
  // the rendezvous stays open either way, and a peer arriving later is announced
  // through the inbox. There is no failure deadline to miss.
  joinRendezvous (id, { firstLookMs = 20_000 } = {}) {
    const existing = this._pairSessionFor(id)
    if (existing) return Promise.resolve(this._pairingView(existing))

    const topic = rendezvousTopic(id)
    const hex = b4a.toString(topic, 'hex')
    const session = {
      id: formatCode(id),
      role: 'joiner',
      eph: ephemeralKeyPair(),
      nonce: randomBytes(24),
      topic,
      hex,
      peers: new Map(),
      granted: false,
      resolve: null
    }
    this.pendingPairs.set(hex, session)
    this.store.savePairing(session)
    this._joinTopic(topic)
    // The other side's announce may land after our first query, and hyperswarm's own
    // refresh cadence is minutes. Keep looking for as long as the rendezvous is open.
    session.retry = setInterval(() => {
      this.discoveries.get(hex)?.refresh().catch(() => {})
    }, 4_000)
    if (session.retry.unref) session.retry.unref()
    for (const conn of this.conns) this._sendPairHello(conn, session)

    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        session.resolve = null
        resolve(this._pairingView(session))
      }
      const timer = setTimeout(finish, firstLookMs)
      if (timer.unref) timer.unref()
      session.resolve = finish
    })
  }

  // The human has read the number back and it matched. Selecting the peer BY its SAS
  // is what rejects an impostor: a wrong peer simply has a different number, so there
  // is nothing to confirm it with.
  confirmPairing (id, sas) {
    const session = this._pairSessionFor(id)
    if (!session) throw new Error(`no pairing in progress with id ${id}`)
    const want = normalizeSas(sas)
    const match = [...session.peers.entries()].find(([, p]) => normalizeSas(p.sas) === want)
    if (!match) {
      const seen = [...session.peers.values()].map(p => p.sas)
      throw new Error(seen.length
        ? `no peer at this rendezvous is showing ${sas}. Currently answering: ${seen.join(', ')}. ` +
          'A number that does not match on both sides means someone else answered — do not confirm it.'
        : `no peer has answered rendezvous ${session.id} yet.`)
    }
    const [conn, peer] = match
    peer.localConfirmed = true
    this._send(conn, {
      t: 'pair-confirm',
      id: session.id,
      sig: b4a.toString(sign(confirmSignable(peer.transcript), this.keys.secretKey), 'hex')
    })
    this._maybeGrant(session, conn, peer)
    return { name: peer.name, fingerprint: fingerprint(peer.pk), waiting: !session.granted }
  }

  cancelPairing (id) {
    const session = this._pairSessionFor(id)
    if (!session) return null
    this._closePairing(session)
    return { id: session.id }
  }

  _closePairing (session) {
    clearInterval(session.retry)
    this.pendingPairs.delete(session.hex)
    this.store.removePairing(session.id)
    this._leaveTopic(session.topic)
  }

  _sendPairHello (conn, session) {
    const state = conn._ct
    if (!state) return
    state.pairHellos = state.pairHellos || new Set()
    if (state.pairHellos.has(session.hex)) return
    state.pairHellos.add(session.hex)
    const pk = this.keys.publicKey
    const epk = session.eph.publicKey
    this._send(conn, {
      t: 'pair-hello',
      id: session.id,
      pk: b4a.toString(pk, 'hex'),
      epk: b4a.toString(epk, 'hex'),
      nonce: b4a.toString(session.nonce, 'hex'),
      name: this.store.getName(),
      host: os.hostname().slice(0, 64),
      label: sessionLabel(),
      sid: this.sid,
      harness: harnessName(),
      v: VERSION,
      sig: b4a.toString(sign(helloSignable(session.id, pk, epk, session.nonce), this.keys.secretKey), 'hex')
    })
  }

  // Inviter side: hand over the room key once BOTH humans have confirmed the number.
  _maybeGrant (session, conn, peer) {
    if (session.role !== 'inviter' || session.granted) return
    if (!peer.localConfirmed || !peer.peerConfirmed) return
    const room = this.store.rooms().find(r => r.id === session.roomId)
    if (!room) return
    session.granted = true
    const grant = JSON.stringify({
      roomKey: b4a.toString(room.key, 'base64'),
      roomName: room.name
    })
    this._send(conn, {
      t: 'pair-grant',
      id: session.id,
      box: b4a.toString(seal(peer.secret, b4a.from(grant)), 'base64')
    })
    // Pin the key we just verified by hand. This is a stronger anchor than pinning
    // whatever key happens to sign the first message: a human confirmed this one.
    this.store.touchMember(room.id, peer.name, Date.now(), {
      host: peer.host, label: peer.label, harness: peer.harness, pk: b4a.toString(peer.pk, 'hex')
    })
    this._closePairing(session)
  }

  // --- connections & handshake ---

  _candidates () {
    const out = []
    for (const room of this.store.rooms()) {
      out.push({ kind: 'room', id: room.id, key: room.key })
    }
    for (const [hex, inv] of this.pendingInvites) {
      out.push({ kind: 'pair', id: hex, key: inv.codeKey })
    }
    for (const [hex, join] of this.pendingJoins) {
      out.push({ kind: 'pair', id: hex, key: join.codeKey })
    }
    return out
  }

  _onConnection (conn) {
    this.conns.add(conn)
    const state = {
      nonce: randomBytes(24),
      peerNonce: null,
      rooms: new Set(),        // roomIds proven by the peer
      pairs: new Set(),        // pairing topicHexes proven by the peer
      peerName: null,
      buf: ''
    }
    conn._ct = state

    // A peer that never proves any shared key gets dropped. Say so: from the far side
    // this looks like a connection that simply died, and it is the shape a version or
    // protocol mismatch takes — the peers find each other and then talk past each other.
    state.authTimer = setTimeout(() => {
      this._pairReject('peer connected but completed no handshake within 30s — likely a different protocol or version on the other side', {
        openRendezvous: [...this.pendingPairs.values()].map(s => s.id)
      })
      conn.destroy()
    }, AUTH_TIMEOUT_MS)

    // Rendezvous ids are public, so there is nothing to withhold until the peer
    // proves something: announce our open rendezvous and let the SAS sort out who
    // actually answered.
    for (const session of this.pendingPairs.values()) this._sendPairHello(conn, session)

    conn.on('data', data => {
      state.buf += b4a.toString(data)
      // Cap the unparsed line. Our largest legit frame is a 16 KB message plus
      // envelope; a peer that streams past MAX_LINE_BYTES without a newline is
      // trying to exhaust memory — drop it rather than buffer unboundedly.
      if (state.buf.length > MAX_LINE_BYTES) {
        this.emit('warning', new Error('peer exceeded max line length; dropping connection'))
        conn.destroy()
        return
      }
      let idx
      while ((idx = state.buf.indexOf('\n')) !== -1) {
        const line = state.buf.slice(0, idx)
        state.buf = state.buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        try { this._onMessage(conn, state, msg) } catch (err) {
          this.emit('warning', err)
        }
      }
    })

    const cleanup = () => {
      clearTimeout(state.authTimer)
      this.conns.delete(conn)
      for (const roomId of state.rooms) {
        this.roomConns.get(roomId)?.delete(conn)
        if (state.peerName) {
          this.store.touchMember(roomId, state.peerName, Date.now(), {
            host: state.peerHost, label: state.peerLabel
          })
        }
        this.emit('peer-left', { roomId, name: state.peerName })
      }
      state.rooms.clear()
    }
    conn.on('close', cleanup)
    conn.on('error', cleanup)

    this._send(conn, { t: 'auth1', nonce: b4a.toString(state.nonce, 'base64') })
  }

  _send (conn, obj) {
    try { conn.write(JSON.stringify(obj) + '\n') } catch {}
  }

  // Send MAC proofs for every key we hold. Safe to repeat: MACs are bound to this
  // connection's nonce pair and to direction, so they can't be replayed elsewhere.
  _sendProofs (conn, state) {
    if (!state.peerNonce) return
    const proofs = this._candidates().map(c => ({
      id: c.id,
      kind: c.kind,
      mac: b4a.toString(mac(derive(c.key, 'auth'), state.peerNonce, state.nonce), 'base64')
    }))
    this._send(conn, { t: 'auth2', proofs })
  }

  // Called when our candidate set changes (new room key learned, invite/join started)
  // so live connections can pick up the new context.
  _reproveAll () {
    for (const conn of this.conns) {
      const state = conn._ct
      if (state?.peerNonce) this._sendProofs(conn, state)
    }
  }

  _onMessage (conn, state, msg) {
    switch (msg.t) {
      case 'auth1': {
        if (state.peerNonce) return
        state.peerNonce = b4a.from(msg.nonce, 'base64')
        this._sendProofs(conn, state)
        break
      }

      case 'auth2': {
        if (!state.peerNonce) return
        let matchedNew = false
        for (const proof of msg.proofs || []) {
          const cand = this._candidates().find(c => c.id === proof.id && c.kind === proof.kind)
          if (!cand) continue
          const already = cand.kind === 'room' ? state.rooms.has(cand.id) : state.pairs.has(cand.id)
          if (already) continue
          const expected = mac(derive(cand.key, 'auth'), state.nonce, state.peerNonce)
          if (!timingSafeEqual(b4a.from(proof.mac, 'base64'), expected)) continue

          matchedNew = true
          clearTimeout(state.authTimer)
          if (cand.kind === 'room') {
            state.rooms.add(cand.id)
            if (!this.roomConns.has(cand.id)) this.roomConns.set(cand.id, new Set())
            this.roomConns.get(cand.id).add(conn)
            this._send(conn, {
              t: 'hello',
              roomId: cand.id,
              name: this.store.getName(),
              host: os.hostname().slice(0, 64),
              label: sessionLabel(),
              sid: this.sid,
              harness: harnessName(),
              v: VERSION
            })
            // At-least-once delivery: replay everything not yet acked for this room,
            // then gossip recent room history. The peer dedups by message id, so this
            // is how someone who was offline catches up through ANY member who was
            // around — store-and-forward through friends, no server.
            const replayed = new Set()
            for (const m of this.store.outboundFor(cand.id)) {
              replayed.add(m.id)
              this._send(conn, { t: 'msg', ...m })
            }
            for (const m of this.store.logTail(cand.id)) {
              if (!replayed.has(m.id)) this._send(conn, { t: 'msg', ...m })
            }
          } else {
            state.pairs.add(cand.id)
            const inv = this.pendingInvites.get(cand.id)
            // Single-grant: the FIRST joiner to prove the code gets the room key;
            // the invite is spent at grant-send, not at ack — so a second redeemer
            // racing the ack window gets nothing. If the winner's connection dies
            // mid-pairing the code is burned; codes are cheap, mint a new one.
            if (inv && !inv.granted) {
              const room = this.store.rooms().find(r => r.id === inv.roomId)
              if (room) {
                inv.granted = true
                const grant = JSON.stringify({
                  roomKey: b4a.toString(room.key, 'base64'),
                  roomName: room.name
                })
                this._send(conn, {
                  t: 'grant',
                  id: cand.id,
                  box: b4a.toString(seal(inv.codeKey, b4a.from(grant)), 'base64')
                })
              }
            }
          }
        }
        // The peer proved something new — answer with our proofs so both sides
        // converge on the same contexts (at most one extra round).
        if (matchedNew) this._sendProofs(conn, state)
        break
      }

      case 'hello': {
        const roomId = String(msg.roomId || '')
        if (!state.rooms.has(roomId)) return
        state.peerName = String(msg.name || 'unknown').slice(0, 64)
        // Optional session identifiers (older peers don't send them).
        state.peerHost = msg.host ? String(msg.host).slice(0, 64) : null
        state.peerLabel = msg.label ? String(msg.label).slice(0, 64) : null
        state.peerSid = typeof msg.sid === 'string' && SID_RE.test(msg.sid) ? msg.sid : null
        state.peerHarness = typeof msg.harness === 'string' && HARNESS_RE.test(msg.harness) ? msg.harness : null
        state.peerVersion = typeof msg.v === 'string' && /^\d+\.\d+\.\d+$/.test(msg.v) ? msg.v : null
        this.store.touchMember(roomId, state.peerName, Date.now(), {
          host: state.peerHost, label: state.peerLabel, harness: state.peerHarness
        })
        this._versionCheck(state, roomId)
        this.emit('peer-joined', { roomId, name: state.peerName })
        break
      }

      case 'pair-hello': {
        const session = this._pairSessionFor(msg.id)
        if (!session) {
          this._pairReject('no rendezvous open with that id here', { theirId: String(msg.id || '').slice(0, 32) })
          return
        }
        if (session.granted) {
          this._pairReject('rendezvous already completed', { id: session.id })
          return
        }
        if (session.peers.has(conn)) return
        const pk = hexBytes(msg.pk, 32)
        const epk = hexBytes(msg.epk, 32)
        const nonce = hexBytes(msg.nonce, 24)
        const sig = hexBytes(msg.sig, 64)
        if (!pk || !epk || !nonce || !sig) {
          this._pairReject('malformed hello — a key, nonce or signature field was missing or the wrong size', {
            id: session.id,
            got: { pk: typeof msg.pk === 'string' ? msg.pk.length : null, epk: typeof msg.epk === 'string' ? msg.epk.length : null, nonce: typeof msg.nonce === 'string' ? msg.nonce.length : null, sig: typeof msg.sig === 'string' ? msg.sig.length : null },
            peerVersion: typeof msg.v === 'string' ? msg.v : 'unknown'
          })
          return
        }
        // The signature is what binds this ephemeral key to that identity key. Without
        // it a relay could offer its own ephemeral key under someone else's name and
        // still show a matching number.
        if (!verify(helloSignable(session.id, pk, epk, nonce), sig, pk)) {
          this._pairReject('hello signature did not verify — the peer signed for a different rendezvous id, or its build derives the signed bytes differently', {
            id: session.id,
            peerName: String(msg.name || 'unknown').slice(0, 64),
            peerVersion: typeof msg.v === 'string' ? msg.v : 'unknown',
            ourVersion: VERSION
          })
          return
        }
        if (b4a.equals(pk, this.keys.publicKey)) {
          this._pairReject('a session using this same identity key answered — pair between two different identities', { id: session.id })
          return
        }
        const secret = agree(session.eph.secretKey, epk)
        if (!secret) {
          this._pairReject('key agreement failed — the peer offered a degenerate agreement key', { id: session.id })
          return
        }
        const transcript = pairingTranscript(
          session.id,
          { pk: this.keys.publicKey, epk: session.eph.publicKey },
          { pk, epk }
        )
        const peer = {
          pk,
          epk,
          secret,
          transcript,
          sas: sasFrom(transcript),
          name: String(msg.name || 'unknown').slice(0, 64),
          host: msg.host ? String(msg.host).slice(0, 64) : undefined,
          label: msg.label ? String(msg.label).slice(0, 64) : undefined,
          harness: HARNESS_RE.test(String(msg.harness || '')) ? msg.harness : undefined,
          localConfirmed: false,
          peerConfirmed: false
        }
        session.peers.set(conn, peer)
        clearTimeout(state.authTimer)
        this._sendPairHello(conn, session)
        if (session.resolve) session.resolve()
        this.emit('pair-peer', { id: session.id, name: peer.name, sas: peer.sas })
        // Surface it in-session too: the rendezvous has no deadline, so the answer
        // can arrive long after the tool call that opened it returned.
        this.store.pushInbound({
          id: b4a.toString(randomBytes(12), 'hex'),
          roomName: session.roomName || `pairing ${session.id}`,
          from: `claude-together pairing ${session.id}`,
          text: `${peer.name} (${peer.host || 'unknown host'}, key ${fingerprint(peer.pk)}) answered. ` +
            `Compare this number with them out of band — say it out loud, do not paste it into the same ` +
            `channel you shared the rendezvous id in: ${peer.sas}. ` +
            'If they read back the same number, confirm the pairing with that number. If it differs, ' +
            'someone else is answering — do not confirm, and tell your user.',
          ts: Date.now(),
          priority: 'normal',
          kind: 'presence'
        })
        break
      }

      case 'pair-confirm': {
        const session = this._pairSessionFor(msg.id)
        if (!session) return
        const peer = session.peers.get(conn)
        if (!peer) {
          this._pairReject('confirmation from a peer that never said hello', { id: session.id })
          return
        }
        const sig = hexBytes(msg.sig, 64)
        if (!sig || !verify(confirmSignable(peer.transcript), sig, peer.pk)) {
          this._pairReject('confirmation signature did not verify', { id: session.id, peerName: peer.name })
          return
        }
        peer.peerConfirmed = true
        this._maybeGrant(session, conn, peer)
        break
      }

      case 'pair-grant': {
        // Joiner side: the inviter confirmed the same number and is handing over the
        // room key, encrypted to the key we agreed — a relay that forwarded every byte
        // untouched still cannot read it.
        const session = this._pairSessionFor(msg.id)
        if (!session || session.role !== 'joiner' || session.granted) return
        const peer = session.peers.get(conn)
        if (!peer || !peer.localConfirmed) return
        const plain = open(peer.secret, b4a.from(String(msg.box || ''), 'base64'))
        if (!plain) return
        const grant = JSON.parse(b4a.toString(plain))
        const roomKey = b4a.from(grant.roomKey, 'base64')
        const roomId = roomIdFor(roomKey)
        const alreadyMember = this.store.rooms().some(r => r.id === roomId)
        session.granted = true
        this.store.addRoom(roomId, grant.roomName, roomKey)
        this.store.touchMember(roomId, peer.name, Date.now(), {
          host: peer.host, label: peer.label, harness: peer.harness, pk: b4a.toString(peer.pk, 'hex')
        })
        this._joinTopic(topicFor(roomKey, 'room'))
        this._send(conn, { t: 'pair-grant-ack', id: session.id })
        this._closePairing(session)
        this._reproveAll()
        if (!alreadyMember) {
          this._broadcast(roomId, { text: 'joined the room', priority: 'normal', kind: 'presence' })
        }
        this.emit('paired', { roomId, roomName: grant.roomName, name: peer.name })
        this.store.pushInbound({
          id: b4a.toString(randomBytes(12), 'hex'),
          roomName: grant.roomName,
          from: `claude-together pairing ${session.id}`,
          text: `paired with ${peer.name} — you are now in room "${grant.roomName}". ` +
            `Their identity key ${fingerprint(peer.pk)} is pinned; you will be warned if it ever changes.`,
          ts: Date.now(),
          priority: 'normal',
          kind: 'presence'
        })
        break
      }

      case 'pair-grant-ack': {
        const session = this._pairSessionFor(msg.id)
        if (!session || session.role !== 'inviter') return
        this._closePairing(session)
        break
      }

      case 'grant': {
        // Joiner side of pairing: the inviter is handing us the room key.
        const hex = String(msg.id || '')
        if (!state.pairs.has(hex)) return
        const join = this.pendingJoins.get(hex)
        if (!join) return
        const plain = open(join.codeKey, b4a.from(msg.box, 'base64'))
        if (!plain) return
        const grant = JSON.parse(b4a.toString(plain))
        const roomKey = b4a.from(grant.roomKey, 'base64')
        const roomId = roomIdFor(roomKey)
        const alreadyMember = this.store.rooms().some(r => r.id === roomId)
        this.store.addRoom(roomId, grant.roomName, roomKey)
        this._joinTopic(topicFor(roomKey, 'room'))
        this._send(conn, { t: 'grant-ack', id: hex })
        clearTimeout(join.timer)
        clearInterval(join.retry)
        this.pendingJoins.delete(hex)
        this._leaveTopic(join.topic)
        // Prove the new room key on all live connections — including this one,
        // which hyperswarm will reuse for the room (one socket per peer).
        this._reproveAll()
        // Announce ourselves to the room through the normal message path: it sits
        // in the outbox now and replays as soon as the room context is proven, and
        // it queues/gossips for members who are currently offline.
        if (!alreadyMember) {
          this._broadcast(roomId, { text: 'joined the room', priority: 'normal', kind: 'presence' })
        }
        join.resolve({ roomId, roomName: grant.roomName })
        break
      }

      case 'grant-ack': {
        // Inviter side: pairing succeeded, retire the code.
        const hex = String(msg.id || '')
        if (!state.pairs.has(hex)) return
        const inv = this.pendingInvites.get(hex)
        if (!inv) return
        this._expireInvite(hex)
        this.emit('invite-redeemed', { roomId: inv.roomId })
        break
      }

      case 'msg': {
        const roomId = String(msg.roomId || '')
        if (!state.rooms.has(roomId)) return
        // The peer's proven context may outlive our membership (we left the room
        // mid-connection) — if we no longer hold the key, drop silently.
        const room = this.store.rooms().find(r => r.id === roomId)
        if (!room) return
        const id = String(msg.id || '')
        // The id is peer-chosen and becomes a filename in the store (inbox/<id>.json,
        // log keys, seen log). Accept only our own id shape — hex, bounded length —
        // so a malicious peer can't path-traverse out of the store directory.
        if (!/^[0-9a-f]{1,32}$/.test(id)) return
        this._send(conn, { t: 'ack', id })
        if (this.store.hasSeen(id)) return
        this.store.markSeen(id)
        const ts = Number(msg.ts) || Date.now()
        const priority = ['interrupt', 'normal', 'passive'].includes(msg.priority) ? msg.priority : 'normal'
        const to = sanitizeTo(msg.to)
        // TOFU verification. A message with a bad signature is forged or corrupted
        // — dropped outright (already acked/marked seen so it isn't re-sent).
        // A valid signature pins the sender's key on first sight; a later message
        // signed with a DIFFERENT key, or an unsigned one from a pinned sender,
        // is delivered but flagged so the user sees the warning.
        const pkHex = typeof msg.pk === 'string' && PK_RE.test(msg.pk) ? msg.pk : null
        const sigHex = typeof msg.sig === 'string' && SIG_RE.test(msg.sig) ? msg.sig : null
        const senderName = String(msg.from || state.peerName || 'unknown').slice(0, 64)
        const pinned = this.store.membersFor(roomId)[senderName]?.pk || null
        let auth = 'unsigned'
        if (pkHex && sigHex) {
          if (!verify(signable(msg), b4a.from(sigHex, 'hex'), b4a.from(pkHex, 'hex'))) {
            this.emit('warning', new Error(`dropped message ${id} with invalid signature (claimed sender: ${senderName})`))
            return
          }
          // First contact is its own state, not silent success: the fingerprint is
          // shown once so a human can check it, and pinned from then on.
          auth = pinned ? (pinned === pkHex ? 'verified' : 'key-changed') : 'verified-new'
          // A message signed with our own identity key is another of this person's
          // sessions — several projects on one machine share the key. Calling that
          // first contact invites the user to go and verify a fingerprint against
          // themselves, and teaches them to wave the check through.
          if (pkHex === b4a.toString(this.keys.publicKey, 'hex')) auth = 'self'
        } else if (pinned) {
          auth = 'unsigned-expected-signed'
        }
        // The relayed/logged copy keeps the sender's priority and addressing:
        // every hop (including offline members catching up later) decides locally
        // how the message lands there.
        const relay = {
          id,
          roomId,
          roomName: room.name,
          from: senderName,
          text: String(msg.text || '').slice(0, 16384),
          ts,
          priority,
          kind: msg.kind === 'presence' ? 'presence' : 'chat',
          ...(msg.host ? { host: String(msg.host).slice(0, 64) } : {}),
          ...(msg.label ? { label: String(msg.label).slice(0, 64) } : {}),
          ...(typeof msg.sid === 'string' && SID_RE.test(msg.sid) ? { sid: msg.sid } : {}),
          ...(typeof msg.harness === 'string' && HARNESS_RE.test(msg.harness) ? { harness: msg.harness } : {}),
          // The signature travels with the message so members catching up later
          // through a friend's log can verify the original sender themselves.
          ...(auth !== 'unsigned-expected-signed' && pkHex ? { pk: pkHex, sig: sigHex } : {})
        }
        if (to) relay.to = to
        // Local delivery: an addressed message lands actively only for the named
        // recipients — everyone else gets it passively (inbox/log only).
        const myName = (this.store.getName() || '').toLowerCase()
        let localPriority = priority
        if (to && !to.some(n => n.toLowerCase() === myName)) localPriority = 'passive'
        // A gossiped/replayed "interrupt" from hours ago shouldn't barge into a
        // session now — urgency expires.
        if (localPriority === 'interrupt' && Date.now() - ts > 5 * 60_000) localPriority = 'normal'
        // Barging in is the receiver's decision, not the sender's: this session runs
        // shell, docker and git, and a mid-turn injection lands while it is doing so.
        // Unless this room was opted in, the message still arrives — at turn end.
        if (localPriority === 'interrupt' && !room.allowInterrupt) localPriority = 'normal'
        const inbound = { ...relay, priority: localPriority, auth }
        this.store.touchMember(roomId, inbound.from, ts, {
          host: relay.host,
          label: relay.label,
          harness: relay.harness,
          ...((auth === 'verified-new' || auth === 'self') && !pinned ? { pk: pkHex } : {})
        })
        this.store.pushInbound(inbound)
        this.store.appendLog(relay)
        // Forward to other live peers in the room — heals meshes where two members
        // can't reach each other directly but both reach us. Dedup stops loops.
        for (const other of this.roomConns.get(roomId) || []) {
          if (other !== conn) this._send(other, { t: 'msg', ...relay })
        }
        this.emit('message', inbound)
        break
      }

      case 'ack': {
        if (state.rooms.size === 0) return
        this.store.ackOutbound(String(msg.id || ''))
        break
      }
    }
  }

  // A version mismatch is surfaced as a LOCAL synthetic inbox notice (never sent
  // to peers, never logged/gossiped) so the delivery hooks hand it to the live
  // Claude session, which can tell the user and offer the right next step.
  _versionCheck (state, roomId) {
    const peerV = state.peerVersion || '0.2.0' // peers predating the version field
    const c = cmpVersion(peerV, VERSION)
    if (c === 0) return
    const who = [state.peerName, state.peerHost, state.peerLabel, state.peerSid,
      state.peerHarness ? `harness: ${state.peerHarness}` : null].filter(Boolean).join(' · ')
    const key = `${who}|${peerV}`
    if (this._versionNotified.has(key)) return
    this._versionNotified.add(key)
    const room = this.store.rooms().find(r => r.id === roomId)
    const text = c < 0
      ? `runs claude-together v${peerV}, older than this session's v${VERSION}. Tell your user, and suggest ` +
        'they ask that peer (over the room, or any channel) to update: git pull in their claude-together ' +
        'folder, then restart their Claude Code session.'
      : `runs claude-together v${peerV} — NEWER than this session's v${VERSION}. Offer your user to update it ` +
        `for them right now (run "git pull" then "npm install" in ${PKG_ROOT}), and explain that after ` +
        'updating they should restart Claude Code and resume this conversation with "claude --continue" ' +
        '(or the resume picker) — restarting does not lose the session.'
    this.store.pushInbound({
      id: b4a.toString(hash(randomBytes(16)).subarray(0, 12), 'hex'),
      roomId,
      roomName: room?.name || roomId,
      from: who || 'a peer',
      text,
      ts: Date.now(),
      priority: 'normal',
      kind: 'presence'
    })
  }

  // --- messaging ---

  sendMessage (roomName, text, priority = 'normal', to = undefined) {
    const room = this.store.roomByName(roomName)
    if (!room) throw new Error(`No room named "${roomName}". Rooms: ${this.store.rooms().map(r => r.name).join(', ') || '(none)'}`)
    if (!['interrupt', 'normal', 'passive'].includes(priority)) priority = 'normal'
    return this._broadcast(room.id, { text, priority, kind: 'chat', to: sanitizeTo(to) })
  }

  // Shared send path for chat and presence: outbox until acked, room log for
  // offline catch-up through friends, immediate fan-out to live peers.
  // Every message carries the sender's host, session label, and session id so
  // receivers can tell which machine/project/session it came from.
  // At-least-once has to mean retrying, not offering once and hoping. The outbox is
  // replayed when a peer proves a room, and a message handed over in the window before
  // that peer has bound the room to the connection is dropped on arrival with no ack —
  // stranded until another proof happens to come along, which it may never do.
  //
  // Re-offering is safe and idempotent: the receiver acks before it dedups, so a copy
  // it already holds still clears our outbox.
  retryOutbound () {
    for (const [roomId, conns] of this.roomConns) {
      if (conns.size === 0) continue
      for (const m of this.store.outboundFor(roomId)) {
        for (const conn of conns) this._send(conn, { t: 'msg', ...m })
      }
    }
  }

  _broadcast (roomId, { text, priority, kind, to }) {
    const msgId = b4a.toString(hash(randomBytes(16)).subarray(0, 12), 'hex')
    const msg = {
      id: msgId,
      roomId,
      from: this.store.getName(),
      text: String(text).slice(0, 16384),
      ts: Date.now(),
      priority,
      kind,
      host: os.hostname().slice(0, 64),
      label: sessionLabel(),
      sid: this.sid
    }
    if (to) msg.to = to
    // TOFU authenticity: sign the canonical fields with our identity key and
    // attach the public key, so any receiver (including one catching up later
    // through a friend's log) can verify who really wrote this.
    if (this.keys) {
      msg.pk = b4a.toString(this.keys.publicKey, 'hex')
      msg.sig = b4a.toString(sign(signable(msg), this.keys.secretKey), 'hex')
    }
    // After signing: harness is advisory and excluded from the frozen canonical
    // form, so older peers still verify our signatures.
    msg.harness = harnessName()
    this.store.markSeen(msgId) // never re-ingest our own message if echoed
    this.store.enqueueOutbound(msg)
    this.store.appendLog(msg)
    const conns = this.roomConns.get(roomId) || new Set()
    for (const conn of conns) this._send(conn, { t: 'msg', ...msg })
    const online = new Set([...conns].map(c => (c._ct?.peerName || '').toLowerCase()))
    return {
      id: msgId,
      deliveredToPeers: conns.size,
      queued: conns.size === 0,
      to,
      offlineRecipients: to ? to.filter(n => !online.has(n.toLowerCase())) : []
    }
  }

  // --- introspection ---

  status () {
    const rooms = this.store.rooms().map(r => {
      const conns = [...(this.roomConns.get(r.id) || [])]
      const connectedPeers = conns.map(c => {
        const s = c._ct
        if (!s?.peerName) return { name: 'connecting…' }
        return {
          name: s.peerName,
          ...(s.peerHost ? { host: s.peerHost } : {}),
          ...(s.peerLabel ? { label: s.peerLabel } : {}),
          ...(s.peerSid ? { sid: s.peerSid } : {}),
          ...(s.peerHarness ? { harness: s.peerHarness } : {})
        }
      })
      const onlineNames = new Set(connectedPeers.map(p => p.name))
      const members = Object.entries(this.store.membersFor(r.id))
        .map(([name, m]) => ({
          name,
          online: onlineNames.has(name),
          lastSeen: new Date(m.lastSeen).toISOString(),
          ...(m.host ? { host: m.host } : {}),
          ...(m.label ? { label: m.label } : {}),
          ...(m.harness ? { harness: m.harness } : {}),
          ...(m.pk ? { keyFingerprint: m.pk.slice(0, 12) } : {})
        }))
        .sort((a, b) => (b.online - a.online) || (b.lastSeen < a.lastSeen ? -1 : 1))
      return {
        name: r.name,
        id: r.id,
        interrupts: r.allowInterrupt ? 'allowed mid-turn' : 'off — messages land at turn end',
        connectedPeers,
        members,
        pendingOutbound: this.store.outboundFor(r.id).length
      }
    })
    return {
      displayName: this.store.getName(),
      session: { host: os.hostname().slice(0, 64), label: sessionLabel(), sid: this.sid, harness: harnessName() },
      rooms,
      pendingInvites: this.pendingInvites.size,
      pendingPairings: [...this.pendingPairs.values()].map(s => this._pairingView(s)),
      ...(this.pairRejections.length ? { recentPairingRejections: this.pairRejections } : {}),
      unreadMessages: this.store.unreadCount()
    }
  }
}
