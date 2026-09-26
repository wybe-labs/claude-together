import sodium from 'sodium-universal'
import b4a from 'b4a'

// Crockford base32 — no I, L, O, U, so codes survive being read aloud or retyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// 12 chars x 5 bits = 60 bits of entropy. The code is single-use and argon2-stretched,
// so 60 bits is far beyond what an attacker can grind through in a pairing window.
export function generateInviteCode () {
  const raw = randomBytes(12)
  let code = ''
  for (let i = 0; i < 12; i++) code += ALPHABET[raw[i] % 32]
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`
}

// Display form: what the user was given and will compare against. Normalizing is for
// matching only — every id shown back to a human goes through this, so the id in
// status is the same string they pasted.
export function formatCode (code) {
  const c = normalizeCode(code)
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : c
}

export function normalizeCode (code) {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I|L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

// Stretch the short code into a 32-byte pairing key. Fixed salt is fine here:
// codes are random, single-use, and short-lived, so precomputation buys nothing useful.
const PW_SALT = hash(b4a.from('claude-together-pairing-salt-v1')).subarray(0, sodium.crypto_pwhash_SALTBYTES)
const PW_OPSLIMIT = 3
const PW_MEMLIMIT = 64 * 1024 * 1024

export function deriveCodeKey (code) {
  const out = b4a.alloc(32)
  sodium.crypto_pwhash(
    out,
    b4a.from(normalizeCode(code)),
    PW_SALT,
    PW_OPSLIMIT,
    PW_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  return out
}

export function hash (data, key = null) {
  const out = b4a.alloc(32)
  if (key) sodium.crypto_generichash(out, data, key)
  else sodium.crypto_generichash(out, data)
  return out
}

// Keyed BLAKE2b as a MAC.
export function mac (key, ...parts) {
  return hash(b4a.concat(parts.map(p => (typeof p === 'string' ? b4a.from(p) : p))), key)
}

// Domain-separated derivations from a 32-byte key.
export function derive (key, context) {
  return hash(b4a.from(context), key)
}

export function topicFor (key, context) {
  return derive(key, `claude-together-topic-${context}`)
}

export function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

export function seal (key, plaintextBuf) {
  const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES)
  const c = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(c, plaintextBuf, nonce, key)
  return b4a.concat([nonce, c])
}

export function open (key, sealedBuf) {
  const nonce = sealedBuf.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
  const c = sealedBuf.subarray(sodium.crypto_secretbox_NONCEBYTES)
  const m = b4a.alloc(c.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(m, c, nonce, key)) return null
  return m
}

export function timingSafeEqual (a, b) {
  if (a.length !== b.length) return false
  return sodium.sodium_memcmp(a, b)
}

// --- ed25519 signatures: TOFU sender authenticity ---

export function signKeyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

export function sign (messageBuf, secretKey) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, messageBuf, secretKey)
  return sig
}

export function verify (messageBuf, sigBuf, publicKey) {
  if (sigBuf.length !== sodium.crypto_sign_BYTES) return false
  if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false
  try {
    return sodium.crypto_sign_verify_detached(sigBuf, messageBuf, publicKey)
  } catch {
    return false
  }
}

// A short, human-comparable form of an identity key. This is what someone actually
// checks when they want to know they are talking to who they think they are.
export function fingerprint (publicKey) {
  const hex = typeof publicKey === 'string' ? publicKey : b4a.toString(publicKey, 'hex')
  return hex.slice(0, 12).replace(/(.{4})(?=.)/g, '$1-')
}

// --- SAS pairing: X25519 agreement authenticated by a spoken number ---

// The rendezvous id names a meeting point and is NOT a secret — it can be pasted in
// a channel, and it never expires on its own. 60 bits of randomness only so two
// rendezvous never collide and a stranger can't stumble onto one; anyone who learns
// it can show up, and is then caught by the SAS comparison rather than by secrecy.
export function generateRendezvousId () {
  return generateInviteCode()
}

export function rendezvousTopic (id) {
  return topicFor(hash(b4a.from(`claude-together-rendezvous-v1|${normalizeCode(id)}`)), 'rendezvous')
}

export function ephemeralKeyPair () {
  const secretKey = randomBytes(sodium.crypto_scalarmult_SCALARBYTES)
  const publicKey = b4a.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult_base(publicKey, secretKey)
  return { publicKey, secretKey }
}

// X25519. Returns null for a degenerate peer key (low order point) rather than a
// shared secret an attacker chose.
export function agree (secretKey, peerPublicKey) {
  if (peerPublicKey.length !== sodium.crypto_scalarmult_BYTES) return null
  const shared = b4a.alloc(sodium.crypto_scalarmult_BYTES)
  try {
    sodium.crypto_scalarmult(shared, secretKey, peerPublicKey)
  } catch {
    return null
  }
  if (shared.every(byte => byte === 0)) return null
  return derive(shared, 'claude-together-pair-secret')
}

// Everything the two sides must agree on, in an order both compute identically
// (sorted by identity key, so there is no initiator/responder asymmetry). Each
// side's ephemeral key is bound to its identity key by the signature in pair-hello,
// so an impostor cannot borrow someone else's identity key here.
export function pairingTranscript (rendezvousId, a, b) {
  const [lo, hi] = b4a.compare(a.pk, b.pk) <= 0 ? [a, b] : [b, a]
  return b4a.concat([
    b4a.from(`claude-together-sas-v1|${normalizeCode(rendezvousId)}|`),
    lo.pk, lo.epk, hi.pk, hi.epk
  ])
}

// Six digits: a man-in-the-middle who relays the rendezvous must show each side a
// DIFFERENT number, so their only escape is a 1-in-a-million guess that both humans
// then read aloud. Not secrecy — detection.
const SAS_DIGITS = 6

export function sasFrom (transcript) {
  const h = hash(transcript)
  let n = 0n
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i])
  const digits = (n % (10n ** BigInt(SAS_DIGITS))).toString().padStart(SAS_DIGITS, '0')
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

export function normalizeSas (sas) {
  return String(sas).replace(/\D/g, '')
}

export function helloSignable (rendezvousId, pk, epk, nonce) {
  return b4a.concat([
    b4a.from(`claude-together-pair-hello-v1|${normalizeCode(rendezvousId)}|`), pk, epk, nonce
  ])
}

export function confirmSignable (transcript) {
  return b4a.concat([b4a.from('claude-together-pair-confirm-v1|'), transcript])
}
