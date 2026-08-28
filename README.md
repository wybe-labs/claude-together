# Claude Together

**Session multiplayer for Claude Code.** Your Claude Code session and a friend's session —
different Anthropic accounts, different machines, anywhere on the internet — exchange
messages over a **direct, end-to-end encrypted P2P connection**. No relay, no central
server, nothing to host, nothing to sign up for.

```
you: "create an invite for room bug-hunt"
      → invite code: X7KQ-2MPF-3HV9  (text it to your friend)

friend: "join room X7KQ-2MPF-3HV9"
      → connected, directly, encrypted

you: "tell bug-hunt: the leak is in token refresh, check session.ts"
friend: "check my messages"
```

Built on [Hyperswarm](https://github.com/holepunchto/hyperswarm): peers find each other
through a public BitTorrent-style DHT, hole-punch a direct UDP connection, and talk over
Noise-encrypted sockets. Exposed to Claude as an [MCP](https://modelcontextprotocol.io) server.

### ▶ 30-second explainer

[![Watch the Claude Together explainer](docs/poster.png)](docs/explainer.mp4?raw=true)

*Click to watch. Source lives in [`video/`](video) — a Remotion project, `npm run render` rebuilds it.*

## Install (each person, ~2 minutes)

Requires [Node.js](https://nodejs.org) ≥ 18 and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/wybe-labs/claude-together
cd claude-together
npm install
npm run register
```

`npm run register` runs `claude mcp add` for you (user scope, so it works in every
project). If the `claude` CLI isn't on your PATH it prints the exact command to run
manually. Then restart your Claude Code session — that's it.

## Usage

Two equivalent ways: **slash commands** (installed by `npm run register`) or plain
natural language — both end up calling the same MCP tools.

| Slash command | Shorthand for |
|---|---|
| `/together-invite bug-hunt` | create a room + invite code |
| `/together-join X7KQ-2MPF-3HV9` | redeem a friend's code |
| `/together-send bug-hunt found it, check session.ts` | send a message (lands when their turn ends) |
| `/together-interrupt bug-hunt stop, merging a fix now` | barge into their running session |
| `/together-inbox` | check new + passive messages |
| `/together-status` | rooms, peers, queues |
| `/together-handoff bug-hunt taking over the auth fix` | offer your current session to the room |
| `/together-import a3f9…` | import a session a friend handed off |

Or just talk to Claude in any session:

| You say | What happens |
|---|---|
| "create an invite for room `name`" | Creates the room, prints a short single-use code (15 min TTL). Keep your session open until your friend joins. |
| "join room `X7KQ-2MPF-3HV9`" | Redeems a code from a friend; pairs in a few seconds. |
| "send to `name`: …" | Delivers instantly if they're online, otherwise queues on disk and delivers when you're both online. |
| "check my messages" | Fetches everything unread, across all rooms. |
| "multiplayer status" | Rooms, connected peers, queued/unread counts. |
| "set my display name to …" | The name shown on your messages. |
| "leave room `name`" | Deletes the room key locally. |

### Delivery modes — messages land like a teammate tapping your shoulder

Messages don't sit in a mailbox waiting to be polled. `npm run register` installs
Claude Code hooks that deliver them into live sessions the same way Claude Code
surfaces your own mid-turn messages:

| Priority | How it lands on the other side |
|---|---|
| `interrupt` (`/together-interrupt`) | Injected **mid-turn** at their Claude's next tool boundary — barges into running work. For "stop, don't merge that". |
| `normal` (`/together-send`, default) | Delivered the moment their Claude **finishes its current turn** (or when they next prompt, if idle). |
| `passive` | Never injected. Waits quietly for `/together-inbox`. |

Every injected message is framed as untrusted data with an explicit instruction to
relay it to the human and ask before acting on anything it requests — a friend's
message can inform your Claude, never command it.

### Groups, not just co-op

Rooms are N-way meshes, not 1:1 links:

- **Any member can invite** — `/together-invite` on an existing room mints a new code,
  and the newcomer peers directly with everyone.
- **Messages relay through friends.** Each member keeps a recent room log (last 200
  messages / 7 days) and replays it to peers who reconnect. If Alice sends while
  Carol is offline and then leaves, Carol still gets it from Bob the next time either
  is online — store-and-forward through the group, no server.
- **Every session is a peer.** Your laptop, your desktop, a second account, three
  Claude Code sessions on one machine — each just joins the mesh. Sessions on the
  same machine share one identity, room list, and inbox.

Pairing and reconnecting happen automatically from then on: room keys persist in
`~/.claude-together/`, and sessions re-find each other through the DHT. Codes are
only ever needed to add a new person.

### Session handoff — give a friend your whole session

Sometimes a message isn't enough: you want your friend to *pick up where your session
left off*, with the full conversation as context. `/together-handoff <room>` does that:

```
you:    /together-handoff bug-hunt   → "this sends the conversation text of this
                                        session to the room — confirm?" → sent
friend: (gets a notice) → /together-import a3f9…
        → new local session written; `claude --resume <id>` opens it
```

How it works, and why it's shaped this way:

- **Stripped, not copied.** Claude Code stores sessions as internal JSONL transcripts
  (`~/.claude/projects/…/<session-id>.jsonl`) whose format drifts between versions.
  The handoff never ships that file: the sender reduces it to a small versioned doc of
  plain **user/assistant conversation text** — tool calls, tool output, thinking
  blocks, sidechains, and hook/system plumbing are all dropped and never leave the
  machine.
- **Streamed peer-to-peer.** Handoffs are their own chunked transfer protocol on the
  encrypted room sockets (up to 4 MB, integrity-hashed) — they never enter room chat,
  logs, or the gossip relay, and both sides must be online. Oldest turns are trimmed
  first if the conversation exceeds the cap.
- **Import is explicit, always.** Receiving an offer stores it and posts an inbox
  notice — nothing else. Only `/together-import <id>`, confirmed by the human, turns
  it into a local session: written under a **fresh session id**, bound to the
  receiver's own project directory, wrapped in loud markers telling the receiving
  Claude the history is **untrusted content from the sender** — context to verify
  against the local repo, never instructions. Handed-off history is a classic
  prompt-injection vector; the wrapping plus the explicit-consent gate is the defense.
- `claude --resume <new-id>` (terminal CLI) then opens the imported session. The
  transcript format is internal, so a Claude Code update can break the import writer —
  that's the accepted cost of the stripped-import design, and why the doc format is
  versioned.

## Why the invite codes can be short

The code is not the encryption key — it's a single-use pairing secret
(the [magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) trick):

1. Both sides stretch the code with **argon2id** (64 MB memory-hard) into a pairing key
   and meet at a DHT topic derived from it.
2. They prove knowledge of the code to each other with nonce-bound MACs — a stranger
   who finds the meeting point can't complete the handshake.
3. Over that authenticated, encrypted link the inviter hands over the room's real
   random **256-bit key**. The code is then retired forever.

60 bits of entropy + argon2 + single-use + 15-minute expiry ≫ anything brute-forceable
in the window.

## Security model

- **End-to-end encrypted** — every socket is Noise-encrypted by Hyperswarm. The only
  third-party infrastructure is the public DHT, which sees opaque topic hashes, never
  content or names.
- **Authenticated** — a connection is trusted for a room only after the peer proves
  knowledge of that room's key (keyed BLAKE2b challenge-response, direction-bound,
  replay-safe).
- **Messages are data, not instructions.** Inbound messages are explicitly framed as
  untrusted when handed to Claude: a friend's message can't prompt-inject your session
  into doing something — Claude is told to show you any request found in a message and
  ask before acting.
- **Plain text only**, 16 KB cap. No files, no commands, no code execution. The one
  larger payload — session handoffs (4 MB cap) — is stripped to conversation text,
  never auto-imported, and lands wrapped in untrusted-content markers only after the
  receiving human explicitly says yes.

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

## Repo layout

- [`src/server.js`](src/server.js) — MCP server and tool definitions
- [`src/transport.js`](src/transport.js) — Hyperswarm swarm, pairing handshake, room
  auth, at-least-once message protocol
- [`src/crypto.js`](src/crypto.js) — invite codes, argon2 stretching, MACs, secretbox
- [`src/store.js`](src/store.js) — persistence: identity, room keys, inbox/outbox
- [`src/handoff.js`](src/handoff.js) — session handoff: transcript stripping + import
- [`test/smoke.js`](test/smoke.js) — end-to-end test on a local DHT testnet: `npm test`
- [`test/handoff.js`](test/handoff.js) — handoff strip/transfer/import tests

## License

MIT
