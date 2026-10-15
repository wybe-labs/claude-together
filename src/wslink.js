import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { WebSocket, WebSocketServer } from 'ws'

// A second way to reach a room, for networks where the DHT cannot be reached at all.
// Hyperswarm speaks UDP only, and some networks (cloud sandboxes, locked-down offices)
// allow nothing but HTTPS through a proxy. There no peer, relay or anchor on the DHT can
// be reached, however good its own network. An anchor can also listen for WebSockets,
// and a session that is told the anchor's URL connects to it over plain HTTPS.
//
// The WebSocket only carries bytes. Over it runs the same Noise handshake hyperswarm
// uses, and the connection that comes out of that is handed to the room protocol exactly
// like a swarm connection, so rooms, invites, signatures and forwarding work unchanged.
// That matters because whatever terminates TLS on the way (a proxy that re-terminates
// it, a tunnel in front of the anchor) sees only Noise ciphertext. The anchor's public
// key travels in the URL's fragment, which is never sent to the server, and a session
// refuses an anchor that answers with any other key.

export const WS_PATH = '/claude-together'

// wss://host[:port]/claude-together#<64 hex>: the fragment is the anchor's key.
export function parseAnchorUrl (value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error(`an anchor URL looks like wss://host/claude-together#<key>, got "${String(value).slice(0, 80)}"`)
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(`an anchor URL starts with wss:// (or ws:// on a private network), got "${url.protocol}"`)
  }
  const key = url.hash.replace(/^#/, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error('the anchor URL must end in #<64-character hex key>, as the anchor prints it. ' +
      'The key is what proves you reached the anchor and not whatever is in between.')
  }
  url.hash = ''
  return { url: url.toString(), key: b4a.from(key, 'hex'), display: `${url.toString()}#${key}` }
}

// A WebSocket as the byte stream Noise expects underneath it.
function streamFromSocket (ws) {
  const stream = new Duplex({
    write (data, cb) {
      ws.send(data, { binary: true }, err => cb(err || null))
    },
    final (cb) {
      ws.close()
      cb(null)
    },
    predestroy () {
      ws.terminate()
    }
  })
  ws.on('message', data => {
    stream.push(Array.isArray(data) ? b4a.concat(data) : b4a.from(data))
  })
  ws.on('close', () => {
    stream.push(null)
    stream.destroy()
  })
  ws.on('error', err => stream.destroy(err))
  return stream
}

// Resolves once the handshake completes, with a connection shaped like a swarm one:
// write, 'data', 'close', destroy and remotePublicKey.
function secure (ws, isInitiator, keyPair, expectedKey = null) {
  return new Promise((resolve, reject) => {
    const conn = new NoiseSecretStream(isInitiator, streamFromSocket(ws), { keyPair })
    const fail = err => {
      conn.destroy()
      reject(err)
    }
    conn.on('error', fail)
    conn.opened.then(ok => {
      conn.off('error', fail)
      if (!ok) return reject(new Error('the encrypted handshake did not complete'))
      if (expectedKey && !b4a.equals(conn.remotePublicKey, expectedKey)) {
        conn.destroy()
        return reject(new Error('the anchor answered with a different key than its URL names. ' +
          'Something between you and it is not the anchor; refusing the connection.'))
      }
      conn.on('error', () => {}) // the room layer listens for 'close'
      resolve(conn)
    })
  })
}

function bypassesProxy (host) {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  host = host.toLowerCase()
  return list.some(entry => {
    if (entry === '*') return true
    const bare = entry.replace(/^\*?\./, '')
    return host === bare || host.endsWith('.' + bare)
  })
}

// Through an HTTPS proxy when the environment names one, which is the only way out of
// the networks this path exists for. ws has no proxy support of its own, so the tunnel
// is opened here with CONNECT and TLS is started over it.
function proxiedConnection (target) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!proxyUrl || target.protocol !== 'wss:' || bypassesProxy(target.hostname)) return undefined
  const proxy = new URL(proxyUrl)
  const port = target.port || '443'
  return (opts, cb) => {
    const req = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` }
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        const hint = res.statusCode === 403
          ? ` The proxy refused ${target.hostname}: on a cloud session, add it to the environment's allowed domains.`
          : ''
        cb(new Error(`proxy answered ${res.statusCode} to CONNECT ${target.hostname}:${port}.${hint}`))
        return
      }
      const secured = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] }, () => cb(null, secured))
      secured.on('error', cb)
    })
    req.on('error', cb)
    req.end()
  }
}

// Anchor side. Listens on its own HTTP(S) server; TLS can also be left to whatever sits
// in front of it (a reverse proxy, a tunnel), since the room traffic is Noise either way.
export function listenWebSocket ({ port, host, keyPair, tlsOptions = null, maxConnections = 64, onConnection, onError = () => {} }) {
  const server = tlsOptions ? https.createServer(tlsOptions) : http.createServer()
  server.on('request', (req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('claude-together anchor: connect with a WebSocket\n')
  })
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 1024 * 1024 })
  wss.on('connection', ws => {
    // Anyone can open a socket; only a room key gets them anywhere, and the room layer
    // drops a connection that proves none within 30 seconds. This bounds the rest.
    if (wss.clients.size > maxConnections) {
      ws.close(1013, 'too many connections')
      return
    }
    secure(ws, false, keyPair).then(onConnection, onError)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve({
        port: server.address().port,
        close: () => new Promise(done => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => server.close(() => done()))
        })
      })
    })
  })
}

// Session side: keeps one connection to an anchor up, reconnecting with backoff.
// onState reports what happened, for status.
export function dialAnchor ({ anchor, keyPair, onConnection, onState = () => {} }) {
  let stopped = false
  let timer = null
  let delay = 1000
  let current = null

  const attempt = () => {
    if (stopped) return
    const target = new URL(anchor.url)
    const ws = new WebSocket(anchor.url, {
      createConnection: proxiedConnection(target),
      handshakeTimeout: 15_000,
      maxPayload: 1024 * 1024
    })
    const retry = err => {
      if (stopped) return
      onState({ connected: false, error: err?.message || 'connection closed', at: Date.now() })
      clearTimeout(timer)
      timer = setTimeout(attempt, delay)
      if (timer.unref) timer.unref()
      delay = Math.min(delay * 2, 60_000)
    }
    ws.once('error', retry)
    ws.once('open', () => {
      ws.off('error', retry)
      secure(ws, true, keyPair, anchor.key).then(conn => {
        if (stopped) return conn.destroy()
        delay = 1000
        current = conn
        onState({ connected: true, at: Date.now() })
        conn.once('close', () => {
          current = null
          retry(new Error('the anchor connection closed'))
        })
        onConnection(conn)
      }, err => {
        ws.terminate()
        retry(err)
      })
    })
  }
  attempt()

  return {
    stop () {
      stopped = true
      clearTimeout(timer)
      current?.destroy()
    }
  }
}
