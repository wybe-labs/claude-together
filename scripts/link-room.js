// Adds a working directory to a room another project on this machine already holds:
//   node scripts/link-room.js --project /path/to/project --room bug-hunt
//
// The same thing the link_room tool does, from a shell. Useful because it needs no
// session: a Claude Code session already running in that project re-reads its store on
// its maintenance pass and joins the room within about half a minute, so nothing has to
// be restarted for this to take effect.
//
// It runs briefly on the network even though the copy itself is local, so that the
// room's other members get told another session joined. Anything undelivered stays
// queued and goes out from the project's own session later.
import { Store } from '../src/store.js'
import { Together } from '../src/transport.js'

function arg (name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1 || i === process.argv.length - 1) return fallback
  return process.argv[i + 1]
}

const project = arg('project')
const room = arg('room')

if (!project || !room) {
  console.error('Usage: node scripts/link-room.js --project <dir> --room <name>')
  console.error('Both are required: the directory to add, and the room it should join.')
  process.exit(1)
}

// Resolve the store the same way a session in that directory would, rather than
// pointing Store at a path directly — an explicit directory makes the store hold its
// own identity, which would mint a second signing key for this machine and make your
// own sessions look like different people to everyone else.
process.env.CLAUDE_PROJECT_DIR = project
delete process.env.CLAUDE_TOGETHER_DIR

const bootstrapEnv = process.env.CLAUDE_TOGETHER_BOOTSTRAP
const bootstrap = bootstrapEnv
  ? bootstrapEnv.split(',').map(entry => entry.trim()).filter(Boolean)
  : undefined

const together = new Together({ store: new Store(), bootstrap })
await together.start()

const result = together.linkRoom(room)
if (result.alreadyMember) {
  console.log(`${project} is already in "${result.name}" — nothing to do.`)
} else {
  console.log(`Linked "${result.name}" into ${project} (from ${result.from}).`)
  console.log('A session already running there will join within ~30s; a new one joins at startup.')
  // Give the presence notice a moment to reach anyone online. The outbox keeps it if
  // nobody is, so exiting early loses the timing, not the message.
  await new Promise(resolve => setTimeout(resolve, 3000))
}

await together.stop()
process.exit(0)
