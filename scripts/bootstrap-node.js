// Runs a small DHT cluster on your own network:
//   npm run bootstrap-node -- --host <lan ip> [--port 49737] [--nodes 3]
//
// Use this when the peers that should meet are behind one restrictive NAT. The public
// hyperdht nodes are reachable from there, but they introduce peers by public address
// and the hole punch back into the LAN is what fails. A cluster on the LAN keeps
// discovery and the connection entirely inside the network.
//
// Why a cluster and not a single bootstrapper: hyperdht keeps a node ephemeral and
// firewalled until several distinct nodes can vouch for its reachability, and a node in
// neither state joins no routing table. With one node in the DHT, two peers announce on
// a topic, find each other, and then never connect — every connection falls back to a
// hole punch with nobody to coordinate it, which looks exactly like a peer that never
// arrived. hyperdht's own testnet starts its nodes with ephemeral and firewalled both
// off, for the same reason.
//
// Leave this running on one machine, then point every session at it:
//   CLAUDE_TOGETHER_BOOTSTRAP=<lan ip>:49737
// Sessions on different bootstraps form separate DHTs and cannot see each other.
import DHT from 'hyperdht'

function arg (name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1 || i === process.argv.length - 1) return fallback
  return process.argv[i + 1]
}

const host = arg('host')
const port = Number(arg('port', '49737'))
const members = Number(arg('nodes', '3'))

if (!host) {
  console.error('Usage: npm run bootstrap-node -- --host <lan ip> [--port 49737] [--nodes 3]')
  console.error('The host must be an address your peers can reach, not 127.0.0.1.')
  process.exit(1)
}
if (!Number.isInteger(members) || members < 1) {
  console.error(`--nodes must be a positive integer, got "${arg('nodes')}".`)
  console.error('A lone bootstrapper cannot introduce two peers to each other — that is the')
  console.error('failure this cluster exists to avoid. Three is the default for a reason.')
  process.exit(1)
}

const bootstrap = [`${host}:${port}`]

const root = DHT.bootstrapper(port, host)
await root.ready()
console.log(`bootstrap node on ${host}:${port}`)

const nodes = []
while (nodes.length < members) {
  const node = new DHT({ bootstrap, ephemeral: false, firewalled: false })
  await node.fullyBootstrapped()
  nodes.push(node)
  console.log(`  member ${nodes.length} on ${node.host}:${node.port} ` +
    `(persistent=${!node.ephemeral}, directly reachable=${!node.firewalled})`)
}

console.log(`cluster of ${nodes.length + 1} nodes up. Point every session at it:`)
console.log(`  CLAUDE_TOGETHER_BOOTSTRAP=${host}:${port}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    for (const node of nodes) await node.destroy()
    await root.destroy()
    process.exit(0)
  })
}
