import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'
import { Together } from './transport.js'
import { root } from './scope.js'
import { WS_PATH } from './wslink.js'

// An anchor is an always-on room member with nobody behind it. It exists for rooms
// whose members cannot reach each other directly: two networks that both randomize
// ports, two Wi-Fi networks in one building whose NAT does not loop back, a guest
// network that drops unsolicited UDP. None of those can be fixed from either end, but
// both ends can usually reach a third machine on a decent network, and every member
// already forwards live messages to the others it is connected to and replays its
// recent log to whoever reconnects. An anchor is simply a member that is always there
// to do that.
//
// It joins like anyone else, by redeeming an invite a member created, so adding one is
// a member's decision and the room is told it joined. It holds the room key and can
// read the room, exactly like any member: run it on a machine you would trust with
// that, not on someone else's server.
export function defaultAnchorDir () {
  return path.join(root(), 'anchor')
}

export function defaultAnchorName () {
  return `anchor-${os.hostname().slice(0, 40)}`
}

// The URL sessions are given: the address they reach the listener at, the path, and the
// listener's key as the fragment. publicUrl is how the outside world reaches this
// machine (a domain behind TLS, a tunnel); without it the URL names the local port.
export function anchorUrl ({ publicUrl, port, tls, key }) {
  const base = publicUrl
    ? new URL(publicUrl)
    : new URL(`${tls ? 'wss' : 'ws'}://${os.hostname()}:${port}`)
  if (base.protocol === 'https:') base.protocol = 'wss:'
  if (base.protocol === 'http:') base.protocol = 'ws:'
  base.pathname = WS_PATH
  base.hash = key
  return base.toString()
}

export async function startAnchor ({ dir = defaultAnchorDir(), name, bootstrap, relay, dhtOptions, firewall, webSocket = null } = {}) {
  // An explicit directory gives the anchor an identity of its own, so it signs as
  // itself and never as the person who runs it.
  const store = new Store(dir)
  if (name || !store.getName()) store.setName(name || defaultAnchorName())
  const together = new Together({ store, bootstrap, relay, dhtOptions, firewall, anchor: true })
  await together.start()

  // Nobody reads an anchor's inbox. What it relays lives on in the room log, which is
  // what it replays to members catching up, so the inbox copy is only clutter.
  store.drainInbound()
  const onMessage = () => store.drainInbound()
  together.on('message', onMessage)

  // Optionally also reachable over WebSocket, for sessions whose network lets only
  // HTTPS out. { port, host, tlsOptions, publicUrl }.
  let url = null
  if (webSocket) {
    const { port, key } = await together.listenWebSocket(webSocket)
    url = anchorUrl({ publicUrl: webSocket.publicUrl, port, tls: !!webSocket.tlsOptions, key })
  }

  return {
    together,
    store,
    url,
    async join (code) {
      return together.joinWithCode(code)
    },
    summary () {
      const s = together.status()
      return {
        name: s.displayName,
        network: s.network,
        rooms: s.rooms.map(r => ({
          name: r.name,
          connected: r.connectedPeers.map(p => p.label ? `${p.name} (${p.label})` : p.name),
          ...(r.unreachablePeers ? { unreachable: r.unreachablePeers.length } : {})
        }))
      }
    },
    async stop () {
      together.off('message', onMessage)
      await together.stop()
    }
  }
}
