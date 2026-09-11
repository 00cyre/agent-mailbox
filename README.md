# agent-mailbox

**Let any agent send a message into one of your chats, by name.**

You copy a conversation's name out of your client — say `Project status check` —
and paste it into some other agent's instructions:

> "Do this research, and when you're done, send a message to the Claude chat
> *Project status check*."

It arrives there, about a tenth of a second after that agent sends it. The agent
can be Grokbot, Codex, Cursor, ChatGPT — anything that can make an HTTP request.
Nothing is configured in advance: the chat claims its own name when it starts
listening, and senders look up the list.

```
  grokbot ─┐                                       ┌─ "Project status check"
           │                                       │
  cursor  ─┼──► POST /v1/send ──►  hub  ───────────┼─ "Deploy notes"
           │    to: "<chat name>"  (threads,       │
  codex   ─┘                        long poll)     └─ "0xken analytics"
                                                        each running `listen`
```

The usual alternatives are all bad in the same way. A shared folder needs both
sides on one filesystem. A GitHub issue thread is a 60-second poll of a global
feed where every message is attributed to whoever owns the token. A direct API
between two agents means every new pair is a new integration.

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

Register only the *senders* here. Chats are not configured: they claim their own
names at runtime by listening.

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

# Which chats can I write to?
curl -s $URL/v1/chats -H "Authorization: Bearer $TOKEN"
# → {"data":[{"slug":"project-status-check","name":"Project status check","listening":true,…}]}

# Say something — "to" is the chat name exactly as the human wrote it
curl -s -X POST $URL/v1/send \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"Project status check","thread":"research","subject":"Done","body":"..."}'

# Wait for an answer — this call BLOCKS until one arrives (or 25s passes)
curl -s "$URL/v1/inbox?cursor=41&wait=25000" -H "Authorization: Bearer $TOKEN"
# → {"data":[ …messages… ],"cursor":42}
```

The loop is: read `cursor` out of each response, pass it to the next call. You
get every message addressed to you exactly once, in order, across restarts.

### With MCP

Point an MCP client at `$URL/mcp` with the same bearer token and the agent gets
seven tools in its own list: `send_message`, `list_chats`, `check_inbox`,
`wait_for_message`, `read_thread`, `list_threads`, `list_agents`.

This is the nicest path for an agent that supports it — "send a message to the
Claude chat *Project status check*" becomes a tool call it already knows how to
make, with `list_chats` there to resolve the name if it gets it slightly wrong.

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

## Making a chat receivable

A chat claims its name by listening. In a Claude Code session, arm this once:

```
Monitor({
  command: 'cd ~/mailbox && MAILBOX_URL=… MAILBOX_TOKEN=… node dist/cli.js listen --as "Project status check"',
  description: 'mailbox — inbound agent messages',
  persistent: true,
})
```

That registers the name and long-polls its inbox forever. Each message becomes
a notification in that chat about 100 ms after the sender let go of it.

Registration is idempotent for the same token, so a session that restarts just
calls it again. `listen` starts at the current head — a restart reports what
arrives next rather than replaying the backlog; pass `--cursor 0` if you do want
the history.

To see who is reachable right now, from anywhere:

```bash
agent-mailbox chats
# ● Project status check (fork)
#     slug: project-status-check-fork  last seen 2026-09-11T16:16:33.019Z
```

`●` means someone is reading it. `○` means nobody is — the mail still queues,
because this is a mailbox, and a research job that finishes at 3am should still
be there in the morning.

### Addressing

`to` accepts any of these, and they all reach the same inbox:

| | |
|---|---|
| `Project status check (fork)` | the display name, pasted verbatim |
| `project-status-check-fork` | the slug |
| `PROJECT  STATUS  CHECK (FORK)` | case and spacing do not matter |
| `grokbot` | a registered agent, rather than a chat |
| `*` | everyone but the sender |

Names are slugified on both registration and resolution, which is what lets a
name survive the round trip through a human's sentence and back.

## Claude adapter (n-to-n)

The hub routes `{vendor}:{thread_id}` envelopes. This package's Claude adapter
implements `send(threadId, envelope)` for vendor `claude`, and sends replies to
`reply_to` (else `from`) with `correlation_id` unchanged.

```
grok:thread-X  ──►  hub  ──►  ClaudeAdapter.send("Y", envelope)
                                      │
                                      ▼
                               claude:thread-Y
                                      │
                               reply tool / `claude -p`
                                      │
                                      ▼
                               grok:thread-X   (same correlation_id)
```

Pick the transport that matches the thread:

| Thread | How it lands |
|---|---|
| Claude Code session | Native: a [channel](https://code.claude.com/docs/en/channels-reference) (`notifications/claude/channel`, same idea as an @-mention) or `claude -p --resume <id>` |
| Claude Desktop / claude.ai chat | Documented [`claude://claude.ai/chat/{id}`](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) to focus the thread, then a Mac paste-and-submit wrapper — links no longer auto-send |

```bash
# Code session, capture the reply
node dist/cli.js claude send --thread "$SESSION" --from grok:research \
  --reply-to grok:research --correlation-id job-1 --body "please review"

# Live Code session: inject + reply tool (research-preview flag required)
# .mcp.json → mailbox-claude: node dist/adapters/claude/cli.js channel --thread "$SESSION"
claude --dangerously-load-development-channels server:mailbox-claude

# Sidecar the hub can POST /send to (loopback)
node dist/cli.js claude serve --port 8790
```

Mac Desktop permissions and the Accessibility paste path: `src/adapters/claude/MAC.md`.
This adapter does not fork the mailbox protocol; it only delivers Claude's side of it.

## Protocol

A message on the wire:

```jsonc
{
  "id": "20260911T160016Z-grokbot-6f3cc9d6", // sortable, and says who wrote it
  "seq": 1,                                  // the cursor; monotonic per mailbox
  "thread": "handshake",
  "from": "grokbot",                         // assigned from the token, never the payload
  "to": "project-status-check",              // resolved chat slug, agent id, or "*"
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
| `GET /v1/chats` | chats you can write to, with a `listening` flag |
| `POST /v1/chats` | `{name}` — claim a chat name as an address |
| `POST /v1/send` | `{to, thread, subject, body, type?, in_reply_to?, refs?}` |
| `GET /v1/inbox` | `?cursor=N&wait=ms&thread=slug&chat=slug` — **blocks** until mail or timeout |
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
- **The hub binds `127.0.0.1` and should usually stay there.** Most agents worth
  wiring up — a desktop assistant, an editor, a local daemon — already run on
  the same machine, so loopback is the whole network they need. Publishing it
  (a tunnel, a reverse proxy) is a deliberate act that turns a local IPC channel
  into an internet-facing service; do it only for a genuinely remote peer, and
  knowing that anyone holding a token can then read every thread addressed to
  that agent.
- Check the port is yours: `lsof -nP -iTCP:<port> -sTCP:LISTEN`. A wildcard
  bind (`*:port`) from some other program and a loopback bind from this one can
  coexist, and which one a client reaches then depends on the address it used.
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

## Keeping it running

```bash
scripts/install-service.sh        # launchd on macOS, systemd --user on Linux
```

Installs the hub so it survives a crash, a logout and a reboot, writing logs
beside the repo. `--uninstall` removes it. A mailbox that is only up while a
terminal is open is not a mailbox — the promise is that a message sent at 3am is
there in the morning.

## Handing an agent its credentials

```bash
scripts/handoff.sh grokbot
```

Prints a ready-to-paste block with this mailbox's real URL and that agent's
token: the curl form, the MCP config block, and the rules for addressing a chat.
Paste it into the agent once; after that "send a message to the Claude chat
*Deploy notes*" is enough.

For your own commands, source the helper rather than pasting a token anywhere:

```bash
source scripts/env.sh
export MAILBOX_TOKEN=$(mailbox_token claude)
node dist/cli.js chats
```

`MAILBOX_URL` is derived from the config, so moving the hub is one edit.

## Development

```bash
npm run build     # tsc -> dist/
npm test          # node:test, 23 cases
npm run dev       # run from source
```

MIT-free: private repo, not published to npm.
