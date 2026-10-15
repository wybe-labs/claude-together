// Runs an always-on member for rooms whose members cannot reach each other:
//   npm run anchor -- --join <invite code> [--join <code> ...] [--name <name>] [--dir <store dir>]
//   npm run anchor                      # later runs: rejoins every room it holds
//
// Start it on a machine with a decent network that stays up: a home server, a desktop
// that is always on, a small VPS. Every member reaches it, and it forwards each live
// message to every other member it is connected to and replays the recent log to
// anyone who comes back, so members who cannot connect to each other still talk.
//
// To add it to a room, have any member create an invite as usual and pass the code
// with --join. The room sees it join under its own name (anchor-<hostname> unless
// --name says otherwise). It reads the room like any member, so run it somewhere you
// trust. Stop it with Ctrl-C; its rooms come back the next time it starts.
//
// CLAUDE_TOGETHER_BOOTSTRAP and CLAUDE_TOGETHER_RELAY apply here exactly as they do in
// a session, and must match the sessions it serves.
import { startAnchor, defaultAnchorDir } from '../src/anchor.js'
import { parseBootstrap, parseRelay } from '../src/transport.js'

function args (name) {
  const out = []
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--' + name) out.push(process.argv[i + 1])
  }
  return out
}

const codes = args('join')
const name = args('name')[0]
const dir = args('dir')[0] || defaultAnchorDir()

const anchor = await startAnchor({
  dir,
  name,
  bootstrap: parseBootstrap(process.env.CLAUDE_TOGETHER_BOOTSTRAP),
  relay: parseRelay(process.env.CLAUDE_TOGETHER_RELAY)
})

console.log(`Anchor "${anchor.store.getName()}" running from ${dir}`)

for (const code of codes) {
  try {
    const { roomName } = await anchor.join(code)
    console.log(`Joined "${roomName}".`)
  } catch (err) {
    console.error(`Could not join with ${code}: ${err.message}`)
  }
}

if (anchor.store.rooms().length === 0) {
  console.error('This anchor is in no rooms. Have a member create an invite, then run:')
  console.error('  npm run anchor -- --join <code>')
  await anchor.stop()
  process.exit(1)
}

function report () {
  const s = anchor.summary()
  console.log(`[${new Date().toISOString()}] network: ${s.network.nat}`)
  for (const r of s.rooms) {
    const unreachable = r.unreachable ? `, ${r.unreachable} found but unreachable` : ''
    console.log(`  ${r.name}: ${r.connected.length ? r.connected.join(', ') : 'nobody connected'}${unreachable}`)
  }
}

// The first report waits for the DHT to finish probing this network: whether the
// anchor is reachable is the thing worth knowing before anyone relies on it.
setTimeout(() => {
  report()
  const { nat } = anchor.summary().network
  if (nat === 'random ports') {
    console.log('  Warning: this network randomizes ports, which makes it a poor anchor. Members on')
    console.log('  networks that do the same will not reach it either. Prefer a machine on another network.')
  }
}, 15_000).unref()
setInterval(report, 5 * 60_000).unref()

const keepAlive = setInterval(() => {}, 1 << 30)
async function shutdown () {
  clearInterval(keepAlive)
  await anchor.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
