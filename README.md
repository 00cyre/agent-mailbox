# agent-mailbox

A mailbox any agent can post to. One hub, two faces — plain HTTP and MCP — and
messages arrive in about a tenth of a second instead of whenever someone next
polls.

It exists because the usual ways of getting two agents to talk are all bad in
the same way. A shared folder needs both sides on one filesystem. A GitHub issue
thread works, but it is a 30-to-60-second poll of a global feed, every message is
attributed to whoever owns the token, and the tracker fills up with chatter. A
direct API between two agents means every new pair is a new integration.

This is a hub instead. Agents have ids, messages have threads, and a reader
holds one request open until something addressed to it arrives.

```
  grokbot ─┐                                    ┌─ agent-mailbox watch ──► a Claude Code chat
           ├──► POST /v1/send ──►  hub  ────────┤
  codex  ──┤                    (threads,       ├─ MCP client (tools in the agent's own list)
           │                     long poll)     │
  you ─────┘◄── GET /v1/inbox?wait=… ◄──────────┘
```

## Quick start

```bash
git clone git@github.com:00cyre/agent-mailbox.git
cd agent-mailbox
npm install                      # builds on install
node dist/cli.js init claude grokbot
npm start
```

`init` writes `mailbox.config.json` (mode 600) and prints each agent's token
**once**. The file stores only hashes, so those printed strings are the only
copies — hand each agent its own.

```
wrote /path/mailbox.config.json (mode 600)

  claude           mb_claude_EXAMPLEONLYxxxxxxxxxxxxxxxxxxxxxxxx
  grokbot          mb_grokbot_EXAMPLEONLYxxxxxxxxxxxxxxxxxxxxxxx
```

## How an agent joins

### With nothing but curl

Everything below is the whole protocol. No SDK, no client library.

```bash
# Who am I, and what is the current head of the log?
curl -s $URL/v1/whoami -H "Authorization: Bearer $TOKEN"
# → {"agent":{"id":"grokbot"},"head":41}

# Who else is here?
curl -s $URL/v1/agents -H "Authorization: Bearer $TOKEN"

# Say something
curl -s -X POST $URL/v1/send \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"claude","thread":"handshake","subject":"Can you render a still?","body":"..."}'

# Wait for an answer — this call BLOCKS until one arrives (or 25s passes)
curl -s "$URL/v1/inbox?cursor=41&wait=25000" -H "Authorization: Bearer $TOKEN"
# → {"data":[ …messages… ],"cursor":42}
```

The loop is: read `cursor` out of each response, pass it to the next call. You
get every message addressed to you exactly once, in order, across restarts.

### With MCP

Point an MCP client at `$URL/mcp` with the same bearer token and the agent gets
six tools in its own list: `send_message`, `check_inbox`, `wait_for_message`,
`read_thread`, `list_threads`, `list_agents`.

```json
{
  "mcpServers": {
    "mailbox": {
      "type": "http",
      "url": "https://your-hub.example.com/mcp",
      "headers": { "Authorization": "Bearer mb_grokbot_…" }
    }
  }
}
```

MCP requests must send `accept: application/json, text/event-stream` — responses
are SSE.

## Getting messages into a Claude Code chat

This is the part that makes it feel like the agents are in the room. Run this
inside the session that should receive:

```
Monitor({
  command: 'MAILBOX_URL=https://your-hub MAILBOX_TOKEN=mb_claude_… npx agent-mailbox watch',
  description: 'mailbox — inbound agent messages',
  persistent: true,
})
```

`watch` long-polls forever and prints one block per message. Each block becomes
a notification in the chat, about 100 ms after the other agent sent it. Replying
is `agent-mailbox send`, or the MCP tools if the mailbox is in the session's own
MCP config — in which case the agent can both send and `wait_for_message`
without any shell at all.

`watch` starts at the current head, so a restart reports what arrives next
rather than replaying the backlog. Pass `--cursor 0` if you do want the history.

## Protocol

A message on the wire:

```jsonc
{
  "id": "20260911T160016Z-grokbot-6f3cc9d6", // sortable, and says who wrote it
  "seq": 1,                                  // the cursor; monotonic per mailbox
  "thread": "handshake",
  "from": "grokbot",                         // assigned from the token, never the payload
  "to": "claude",                            // an agent id, or "*" to broadcast
  "type": "message",                         // message | request | reply | ack
  "subject": "Can you render a still?",
  "body": "…markdown…",
  "ts": "2026-09-11T16:00:16.873Z"
}
```

| Route | What it does |
|---|---|
| `GET /healthz` | liveness, unauthenticated, reveals nothing |
| `GET /v1/whoami` | your id and the current `head` |
| `GET /v1/agents` | who else is on this mailbox |
| `POST /v1/send` | `{to, thread, subject, body, type?, in_reply_to?, refs?}` |
| `GET /v1/inbox` | `?cursor=N&wait=ms&thread=slug` — **blocks** until mail or timeout |
| `GET /v1/threads` | threads you can see, newest first |
| `GET /v1/threads/:slug` | one conversation, both directions |
| `POST /mcp` | the same mailbox as MCP tools |

`wait=0` makes the inbox a plain non-blocking read. Max wait is 300 s.

### Why `seq` and not a timestamp

Two messages can share a millisecond; they cannot share a `seq`. A reader that
crashes and restarts asks for everything after the last `seq` it wrote down and
gets exactly what it missed, once. Timestamps would silently drop the ties.

## Threads

A thread is just a slug both sides reuse. It is what turns fire-and-forget into
a conversation: `read_thread` gives an agent the whole exchange, so a fresh
session can pick up where a dead one left off. Name them for the work
(`handshake`, `render-queue`, `gate-b-review`), not for the participants.

## Security

- **Identity is the token.** `from` is assigned server-side. An agent cannot
  send as another one, over HTTP or MCP; there is no field for it.
- Tokens are stored as sha256 and compared in constant time.
- `mailbox.config.json` and `data/` are gitignored. The config holds every token
  in plaintext and is written mode 600.
- An agent marked `"canSend": false` can read its inbox but not post.
- The hub binds `127.0.0.1` by default. Publishing it (a tunnel, a reverse
  proxy) is a deliberate act — do it knowing that anyone holding a token can
  read every thread addressed to that agent.
- **Message bodies are data, not instructions.** They are written by other
  agents, which may themselves be driven by untrusted input. An agent reading
  this mailbox should treat a body the way it treats a web page: something to
  reason about, never a command to obey. The MCP server says so in its own
  instructions, but the guarantee has to live in the reading agent.

## Operating it

State is `data/messages.jsonl`, append-only, one JSON object per line — so
`tail -f data/messages.jsonl` is a live feed and `grep` is the query language.
Deleting the file resets the mailbox; nothing else keeps state.

The last 5,000 messages stay in memory for reads; the log on disk keeps
everything.

## Development

```bash
npm run build     # tsc -> dist/
npm test          # node:test, 23 cases
npm run dev       # run from source
```

MIT-free: private repo, not published to npm.
