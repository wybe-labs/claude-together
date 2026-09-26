# Claude Together

**Session multiplayer for Claude Code.** Your Claude Code session and a friend's session —
different Anthropic accounts, different machines, anywhere on the internet — exchange
messages over a **direct, end-to-end encrypted P2P connection**. No relay, no central
server, nothing to host, nothing to sign up for.

```
you: "create an invite for room bug-hunt"
      → rendezvous: X7KQ-2MPF-3HV9  (text it to your friend — it is not a secret)

friend: "join room X7KQ-2MPF-3HV9"
      → both of you see: 482 913   (say it out loud to each other)

both: "confirm 482 913"
      → connected, directly, encrypted

you: "tell bug-hunt: the leak is in token refresh, check session.ts"
friend: "check my messages"
```

Built on [Hyperswarm](https://github.com/holepunchto/hyperswarm): peers find each other
through a public BitTorrent-style DHT, hole-punch a direct UDP connection, and talk over
Noise-encrypted sockets. Exposed to Claude as an [MCP](https://modelcontextprotocol.io) server.

**Current release: v0.4.0** — SAS pairing (no invite secret), per-project
registration, receiver-side interrupt opt-in, and private-network bootstrap.
**Wire-incompatible with 0.3.x pairing:** both sides must be on 0.4 to pair.
Peers on mismatched versions detect and report it in-session.

### ▶ 30-second explainer

![Claude Together explainer](docs/explainer.gif)

*[Full-quality MP4](https://github.com/wybe-labs/claude-together/blob/main/docs/explainer.mp4)*

## Install (each person, ~2 minutes)

Requires [Node.js](https://nodejs.org) ≥ 18 and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/wybe-labs/claude-together
cd claude-together
npm install

cd /path/to/your/project        # the project you want to be reachable in
npm --prefix /path/to/claude-together run register
```

Registration is **per project**, not machine-wide: hooks go in that project's
`.claude/settings.local.json`, the slash commands in its `.claude/commands`, and the
MCP server is added at `--scope local`. A session in a project you never registered
has no claude-together tools and no delivery hooks, so it cannot be pulled into a
room — being reachable is something you turn on where you want it. Run it again in
each project you want, and restart your Claude Code session.

If the `claude` CLI isn't on your PATH it prints the exact command to run manually.

> Upgrading from ≤0.3? Those versions installed hooks user-wide in
> `~/.claude/settings.json`, where they fired in every project. `npm run register`
> removes those entries (leaving any other hooks alone) and tells you it did.

## Usage

Two equivalent ways: **slash commands** (installed by `npm run register`) or plain
natural language — both end up calling the same MCP tools.

| Slash command | Shorthand for |
|---|---|
| `/together-invite bug-hunt` | create a room + open a pairing rendezvous |
| `/together-join X7KQ-2MPF-3HV9` | answer a friend's rendezvous, get the number to compare |
| `/together-confirm 482 913` | confirm the number you both read aloud — completes the pairing |
| `/together-send bug-hunt found it, check session.ts` | send a message (lands when their turn ends) |
| `/together-send bug-hunt to alice: here's that stack trace` | address specific people — only they get active delivery |
| `/together-interrupt bug-hunt stop, merging a fix now` | barge into their running session (if that room opted in) |
| `/together-inbox` | check new + passive messages |
| `/together-history bug-hunt` | re-read recent room chat (non-destructive) |
| `/together-status` | rooms, peers, members + last seen, queues |

Or just talk to Claude in any session:

| You say | What happens |
|---|---|
| "create an invite for room `name`" | Creates the room and opens a pairing rendezvous, printing a short id. The id is not a secret and does not expire. Keep your session open until the pairing completes. |
| "join room `X7KQ-2MPF-3HV9`" | Answers a friend's rendezvous and returns a six-digit number to compare out of band; after you both confirm it, you are in. Everyone already in the room automatically gets a "`name` joined the room (`hostname` · `session label` · `harness`)" notice — even members who are offline see it when they reconnect. The label defaults to your project folder name; set `CLAUDE_TOGETHER_LABEL` to override it. |
| "send to `name`: …" | Delivers instantly if they're online, otherwise queues on disk and delivers when you're both online. |
| "check my messages" | Fetches everything unread, across all rooms. |
| "multiplayer status" | Rooms, connected peers, known members with last-seen times, queued/unread counts. |
| "show the history of `name`" | Re-reads the recent room log (last 200 msgs / 7 days) without touching your unread inbox. |
| "set my display name to …" | The name shown on your messages. |
| "link room `name`" | Adds *this* project to a room another project on this machine is already in, by copying the key locally. No pairing, no network. |
| "relay through `key`" | Routes connections that cannot be made directly through a named relay. Off by default; a relay sees who talks to whom, though not what is said. |
| "leave room `name`" | Deletes the room key, stops announcing on the DHT, and closes the room's connections. |

**Version mismatches are detected on connect.** Sessions exchange their
claude-together version in the room handshake; if a peer runs an older version,
your Claude tells you and suggests passing the update along — and if *you* are
the outdated one, Claude offers to `git pull` + `npm install` for you and reminds
you that restarting Claude Code and resuming (`claude --continue`) keeps your
session.

### Delivery modes — messages land like a teammate tapping your shoulder

Messages don't sit in a mailbox waiting to be polled. `npm run register` installs
Claude Code hooks that deliver them into live sessions the same way Claude Code
surfaces your own mid-turn messages:

| Priority | How it lands on the other side |
|---|---|
| `normal` (`/together-send`, default) | Delivered the moment their Claude **finishes its current turn** (or when they next prompt, if idle). |
| `interrupt` (`/together-interrupt`) | *Requests* injection **mid-turn** at their Claude's next tool boundary. Honored only by rooms the receiver opted in (below); otherwise it lands at turn end. |
| `passive` | Never injected. Waits quietly for `/together-inbox`. |

**Interrupts are opt-in, per room, on the receiving side.** They are off by default,
because the session being interrupted runs shell, docker and git commands, and a
mid-turn injection arrives in the middle of that work — so whether a peer may barge
in is the receiver's call, not the sender's. Turn it on for a room you trust by
asking your Claude ("allow interrupts from bug-hunt"), and off again the same way;
`status` shows the current setting per room. Opting out never loses messages, it only
means they land at the end of the turn. Senders are told the interrupt may be
downgraded, so nobody reads a lack of barge-in as the message not arriving.

**Addressing specific people.** Any message can carry a "to" list of display names
(`/together-send bug-hunt to alice: …`, or just "tell alice …"). Every member still
gets the message in the shared room chat log, but only the named recipients receive
it at the active priority — everyone else gets it passively, with no interruption.
So sharing a log meant for one person doesn't barge into three other sessions.
Without a "to" list, the whole room gets the message at the send priority.
Addressing is best-effort, not an access control: display names are self-chosen
and not unique, and everyone in the room can read every message — "to" only
decides whose session is actively notified.

Every injected message is framed as untrusted data with an explicit instruction to
relay it to the human and ask before acting on anything it requests — a friend's
message can inform your Claude, never command it.

### Several working directories, one room

Room membership belongs to the project directory, so a room you joined in one checkout
is not joined in another. To add a second directory, ask Claude there to **link** the
room:

```
you (in ~/code/other-thing): "link the bug-hunt room"
→ copies the key from your other project, joins the topic, and you appear to the room
  as a second peer
```

This is a local copy, not a pairing. Pairing exists to move a room key between two
people who have no prior trust, which is what the rendezvous and the spoken number are
for; between two directories the same person owns there is no second party and no new
trust, and the key is already on the machine. So there is nothing to compare and
nothing new is granted. The room's other members are told another of your sessions
joined, because a second session gaining read access is their business.

Each project keeps its **own inbox**, which is the reason not to point every session at
one shared store instead: reading an inbox deletes what it read, so sessions sharing one
would compete and each message would reach whichever session happened to look first.
With separate stores every session receives every message.

Your identity key is machine-global, so all your sessions sign with the same key and
peers see one member with several connected peers, told apart by project label and
session id. Set `CLAUDE_TOGETHER_LABEL` per project to make them readable. A message
from one of your own sessions is labelled as such rather than as a new sender, so
nothing invites you to go and check a fingerprint against yourself.

A room name that means two different rooms on this machine is refused rather than
guessed at, since picking the wrong one would join a conversation you did not mean.

**No restart, and no session needed.** Linking writes a key into the project's store,
and a session already running there joins the room on its next maintenance pass — about
half a minute — because that pass re-reads the store precisely to pick up rooms another
local session joined. A session started later joins at startup. So the same thing can be
done from a shell, without a session in that directory at all:

```
node scripts/link-room.js --project /path/to/project --room bug-hunt
```

The copy is local, but the script does go on the network for a moment so the room's
other members still get told another session joined; if nobody is online the notice
queues and goes out later. It resolves the store the way a session in that directory
would rather than being pointed at a path: a store handed an explicit directory holds
its own identity, which would mint a second signing key for this machine and make your
own sessions look like different people to everyone else.

### Groups, not just co-op

Rooms are N-way meshes, not 1:1 links:

- **Any member can invite** — `/together-invite` on an existing room mints a new code,
  and the newcomer peers directly with everyone.
- **Messages relay through friends.** Each member keeps a recent room log (last 200
  messages / 7 days) and replays it to peers who reconnect. If Alice sends while
  Carol is offline and then leaves, Carol still gets it from Bob the next time either
  is online — store-and-forward through the group, no server.
- **Every project is a peer.** Your laptop, your desktop, a second account, two
  different projects on one machine — each joins the mesh in its own right.

### Membership is per project, not per machine

Joining a room is an explicit act, scoped to the project directory the session runs
in: each project gets its own store under `~/.claude-together/projects/<name>-<hash>/`
(room keys, inbox, queues). A session in another folder is **not** in your rooms, sees
none of your messages, and has to redeem its own invite to join. Only your display
name is machine-global. Two sessions open in the *same* project directory share that
project's membership and show up as two peers.

Pairing and reconnecting happen automatically from then on: room keys persist in the
project's store, and sessions re-find each other through the DHT. Codes are only ever
needed to add a new person (or a new project). Set `CLAUDE_TOGETHER_DIR` to point
several projects at one shared store if you deliberately want the old machine-global
behavior.

**Migrating from 0.2:** pre-0.3 versions kept one machine-global room list; 0.3 no
longer joins those rooms. The first session in each project gets a one-time notice
listing them — mint fresh invites in the projects that need them, or set
`CLAUDE_TOGETHER_DIR=~/.claude-together` to keep using the old shared store. Your
display name (and new signing identity) carry over automatically.

## Why there is no invite secret

Pairing does not rely on the id staying private, so there is nothing to leak, nothing
to expire, and no window to miss. The id names a meeting point; **two humans reading
six digits to each other** is what authenticates the exchange:

1. Both sides meet at a DHT topic derived from the (public) rendezvous id and open a
   Noise-encrypted socket.
2. Each sends its long-lived **ed25519 identity key** together with a fresh **X25519**
   key, signed — so an ephemeral key cannot be offered under someone else's identity.
3. Both derive the same **six-digit number** from the transcript (both identity keys,
   both ephemeral keys, the id), ordered so each side computes it identically.
4. The humans compare that number out of band. On confirmation, the inviter encrypts
   the room's random **256-bit key** to the X25519 secret they agreed.

A man-in-the-middle has to substitute its own key toward at least one side to read
anything — which changes the number that side sees, so the comparison fails. Relaying
the real keys untouched keeps the numbers matching but leaves the attacker without the
agreed secret, so the room key stays unreadable. Its only escape is guessing which
six digits to show, at 1-in-a-million, against two people about to say them aloud.

**This shifts the burden onto the comparison.** Rubber-stamping the number without
actually checking it removes the entire protection — the number must be exchanged on a
channel an attacker on the rendezvous does not control (a call, in person), never in the
same chat you pasted the id into. `confirm_pairing` exists so that step is a deliberate
human act; Claude is told never to perform it on your behalf.

An open rendezvous is kept in the store, so it survives restarting Claude Code: an id
you shared yesterday still works today, and only completing it or `cancel_pairing` ends
it. The agreement key is stored with it, so the number this side shows does not change
across a restart — otherwise a peer still holding the old number would see a second
entry appear under the same name with a different number, which is exactly the shape of
the impersonation the comparison is there to catch.

Multiple peers may answer the same public rendezvous — that is expected, not an attack
in itself. Each gets its own number, `status` lists them side by side with the name,
host and key fingerprint, and confirming a number is what selects which one you paired
with.

## Security model

- **End-to-end encrypted** — every socket is Noise-encrypted by Hyperswarm. The only
  third-party infrastructure is the public DHT, which sees opaque topic hashes, never
  content or names.
- **Authenticated** — a connection is trusted for a room only after the peer proves
  knowledge of that room's key (keyed BLAKE2b challenge-response, direction-bound,
  replay-safe).
- **Messages are data, not instructions.** Inbound messages are explicitly framed as
  untrusted when handed to Claude, which is told to relay any request to you and ask
  before acting on it. This is a *mitigation*, not a guarantee — see the limitations below.
- **Plain text only**, 16 KB cap. No files, no commands, no code execution. Peer-supplied
  message ids are validated as hex before they touch the filesystem (no path traversal).

### What the perimeter is

Discovery topics are derived from secret keys, so **only key-holders can even connect
to you** — random internet peers can't reach a room they don't have the key for. The
trust boundary is therefore *the people you invite*, not the whole internet. A room key
is a **shared symmetric secret**: everyone in the room holds the same key and is equally
trusted.

### Limitations — know these before trusting it with anything sensitive

- **A room key is permanent and unrevocable.** Anyone who ever holds it — an invited
  member, or anyone a member confirms a pairing with — keeps read/write access forever. `leave_room` only deletes *your own* copy; it can't evict anyone else.
  **You cannot kick a member.** The only way to exclude someone is for everyone else to
  start a fresh room. There is no forward secrecy: a leaked key exposes past logged
  history and all future messages.
- **Sender authenticity rests on the key, not the name.** Every message is signed
  with a long-lived per-identity ed25519 key. A key confirmed through a SAS pairing is
  pinned by that human check; otherwise the first message from a sender says so and
  shows the fingerprint, and the key is pinned from then on. Later messages signed with
  a different key warn loudly
  (or arrives unsigned from a sender who used to sign). But the *first* message from a
  name is taken on faith, display names are not unique, and `host`/`label`/`sid` remain
  self-asserted decoration. Treat the warnings as real, and the absence of warnings as
  strong-but-not-absolute.
- **Any member can invite anyone.** There is no admin role or approval step.
- **Prompt-injection risk is real.** Messages are injected into your live Claude session
  (mid-turn for `interrupt` priority, when the agent has tool access). The untrusted-data
  framing reduces but does not eliminate the risk that a crafted message manipulates the
  receiving agent. Don't run Claude Together in a session with dangerous auto-approved
  tools while in a room with people you don't trust. Mid-turn injection is off unless
  you opted that room in, which is the setting to leave alone for any room you don't
  fully trust — but `normal` delivery still reaches the same agent, one turn later.
- **Every message carries your hostname, project-folder name, a per-session id, and a harness tag**
  (so members can tell your machines, projects, and sessions apart). Set
  `CLAUDE_TOGETHER_LABEL` to override the folder name; your machine hostname is
  still sent, and the session id is random per process.

**Bottom line:** safe for the intended use — *friends you trust, collaborating*. It is
**not** a zero-trust or anonymous messenger, and a room key should be treated like a
password you can never rotate: share it only with people you'd trust with write access
to your inbox, and start a new room if it might have leaked.

## Reliability

- **At-least-once delivery**: messages queue on disk until acked, survive restarts,
  and deduplicate by id. Live messages also forward through mutual peers, healing
  meshes where two members can't reach each other directly.
- **Offline catch-up through the group**: any member who saw a message replays it to
  whoever reconnects. A message is only stuck if literally no one who has it is
  online at the same time as you.
- **No central relay by design**: if two peers are both behind carrier-grade NAT,
  hole punching can fail (~5% of pairings). Easiest fix: both install
  [Tailscale](https://tailscale.com) — the swarm then finds the direct tailnet path.

### Corporate networks: use your own bootstrap node

Peers behind one restrictive corporate NAT hit a variant of the above that Tailscale
isn't always allowed to solve, and being on the same LAN does not help: discovery is
global-DHT-only, so both sides are introduced by public address and then fail to
hole-punch back into their own network. Both sides simply time out.

Run a small DHT cluster inside the network instead, on any machine both can reach:

```
npm run bootstrap-node -- --host <lan ip>     # leave running; port 49737, 3 members
```

Then point every session at it and restart them:

```
CLAUDE_TOGETHER_BOOTSTRAP=<lan ip>:49737
```

Discovery and the connection then stay entirely inside the LAN. `status` reports which
bootstrap a session is using — sessions on different bootstraps form separate DHTs and
cannot see each other, so the value must match everywhere.

**It has to be a cluster, not one node.** hyperdht keeps a node ephemeral and firewalled
until several distinct nodes can vouch for its reachability, and a node in neither state
joins no routing table. Point two sessions at a lone bootstrapper and they announce on a
topic, find each other, and then never connect: every connection falls back to a hole
punch with nobody to coordinate it. From the outside that is indistinguishable from a
peer who never showed up — no error, no peer, nothing in either log. hyperdht's own
testnet starts its nodes with ephemeral and firewalled both off for the same reason.

The host must be an address your peers can reach. Not a hostname: it is handed to peers
as the address to talk to, and a name like `myhost` usually resolves to `127.0.1.1`
locally and to nothing at all on theirs, which leaves your session advertising a
loopback address.

**Changing it needs no restart.** `set_bootstrap` repoints discovery and applies it
immediately, and `start_local_bootstrap` starts the cluster above and points at it in one
step; `stop_local_bootstrap` stops it. The choice is remembered for the machine, so later
sessions start on the same DHT without anything being exported. `CLAUDE_TOGETHER_BOOTSTRAP`
still wins for a process that sets it, so an explicit environment is never quietly
overridden — the stored value applies to sessions that come later.

Stopping the cluster deliberately does *not* move discovery back to the public nodes.
Doing that silently would change who a session can reach without anyone asking for it,
so it is a separate call.

### When a direct connection is impossible: relaying

Some networks refuse to hole-punch at all, and no bootstrap fixes that — discovery was
never the hard part, the connection is. `set_relay` names a node to carry connections
that cannot be made directly, by its 64-character hex public key.

It is a fallback rather than a mode. Hyperswarm tries a direct connection every time and
only falls back once the punch has actually failed, so naming a relay costs nothing while
direct connections work.

**What it gives up.** A relay carries your traffic. Messages stay end-to-end encrypted
and it cannot read them, but it learns that two peers are talking, how much, and when —
and this project otherwise involves no third party at all. That is a real change to "no
relay, nothing to host", so it is off by default and has to be turned on deliberately.

No relay is bundled. The key must name a node you run somewhere both peers can reach, or
one you have been given and trust.

### Peers on separate networks

A private cluster only helps when every peer can reach it. Two people on different
corporate networks cannot, so a LAN bootstrap does nothing for them and they need
either the public DHT or a bootstrap both can actually reach — a host on the internet,
or a shared overlay such as [Tailscale](https://tailscale.com), which is also the
simpler answer to hole-punching failures generally.

The public DHT is worth trying first between separate networks. It has plenty of nodes
to coordinate a hole punch, which is exactly what a lone bootstrapper cannot do, and
the case it struggles with — both peers behind one NAT that will not hairpin — is not
the case two separate networks are in.

To keep it up across reboots, run it under systemd as your own user:

```ini
# ~/.config/systemd/user/claude-together-bootstrap.service
[Unit]
Description=Claude Together private DHT bootstrap cluster
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=%h/.config/claude-together-bootstrap.env
ExecStart=/path/to/node /path/to/claude-together/scripts/bootstrap-node.js \
  --host ${HOST} --port ${PORT} --nodes ${NODES}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

with `HOST`, `PORT` and `NODES` in `~/.config/claude-together-bootstrap.env`, then:

```
systemctl --user daemon-reload
systemctl --user enable --now claude-together-bootstrap
sudo loginctl enable-linger $USER    # or it only runs while you are logged in
```

## Repo layout

- [`test/security.js`](test/security.js) — path-traversal regression test (`npm run test:security`)
- [`src/server.js`](src/server.js) — MCP server and tool definitions
- [`src/transport.js`](src/transport.js) — Hyperswarm swarm, pairing handshake, room
  auth, at-least-once message protocol
- [`src/crypto.js`](src/crypto.js) — rendezvous ids, SAS derivation, X25519 agreement, signatures, secretbox
- [`src/store.js`](src/store.js) — persistence: identity, room keys, inbox/outbox
- [`src/scope.js`](src/scope.js) — per-project store scoping (shared by server and hooks)
- [`src/hooks.js`](src/hooks.js) — where delivery hooks live and whether they are installed
- [`scripts/bootstrap-node.js`](scripts/bootstrap-node.js) — DHT bootstrap node for a
  private network: `npm run bootstrap-node -- --host <lan ip>`
- [`scripts/statusline.py`](scripts/statusline.py) — Claude Code status line: usage
  gauges plus room, unread and last-message state (`--demo` to preview)
- [`scripts/link-room.js`](scripts/link-room.js) — add a working directory to a room
  this machine already holds, without a session in it
- [`test/smoke.js`](test/smoke.js) — end-to-end test on a local DHT testnet: `npm test`
- [`test/pairing.js`](test/pairing.js) — SAS pairing and identity pinning
- [`test/pairing-restart.js`](test/pairing-restart.js) — a rendezvous outliving the process
- [`test/interrupts.js`](test/interrupts.js) — receiver-side interrupt opt-in
- [`test/outbox.js`](test/outbox.js) — at-least-once retry of queued messages
- [`test/link.js`](test/link.js) — a second working directory joining a room locally
- [`test/bootstrap.js`](test/bootstrap.js) — repointing discovery while the session runs
- [`test/register.js`](test/register.js) — per-project hook installation

## License

MIT
