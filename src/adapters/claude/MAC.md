# Claude Desktop adapter — macOS setup

This adapter runs on the machine that has Claude. The cloud/Linux builders
cannot drive the Mac app; the code here is the wrapper plus these notes.

There is **no public API that posts a message into an existing Claude Desktop /
claude.ai thread and reads the reply**. Anthropic documents:

| Surface | What it actually does |
|---|---|
| [`claude://` URL scheme](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) | Opens Claude Desktop to a chat, project, Code session, or Cowork session. `q=` prefills the composer on **new** chats (`claude://claude.ai/new?q=…`). After the PromptFiction fix (Desktop ≥ 1.1.2321) a link **does not** auto-send. |
| `claude -p --resume <session-id>` | Documented Claude **Code** headless send+receive. This is the native round-trip for Code threads. Session lookup is scoped to the project directory (`MAILBOX_CLAUDE_CWD`). |
| Claude Code [channels](https://code.claude.com/docs/en/channels-reference) | Documented in-thread inject (`notifications/claude/channel`) plus a `reply` tool — the same mechanism as @-mentions, Telegram, iMessage. Custom channels need `--dangerously-load-development-channels` during the research preview. |

The Mac wrapper only covers the Desktop gap: **open the thread, paste, submit**.

## 1. Claude Code thread (preferred)

Thread id is the Code session id (UUID from `--output-format json` / `/resume`).

```bash
# native send + capture reply
agent-mailbox claude send --thread "$SESSION" --from grok:research --reply-to grok:research \
  --correlation-id job-1 --body "please review the diff"

# live session: inject like an @-mention, reply tool posts back to the hub
# ~/.claude.json / .mcp.json:
#   "mailbox-claude": { "command": "node", "args": ["$REPO/dist/adapters/claude/cli.js", "channel", "--thread", "$SESSION"] }
claude --dangerously-load-development-channels server:mailbox-claude
```

Grant nothing extra. Replies preserve `reply_to` and `correlation_id`.

## 2. Claude Desktop / claude.ai thread

Thread id is the UUID at the end of `https://claude.ai/chat/<uuid>`.

Address: `claude:<uuid>`.

1. Install [Claude Desktop](https://claude.ai/download) and sign in.
2. Confirm the URL scheme: `open "claude://claude.ai/new?q=Hello"` — a new chat should open with the composer prefilled.
3. System Settings → Privacy & Security → **Accessibility**: allow the process that runs this adapter (Terminal, iTerm, `node`, or the launchd job). System Events cannot Cmd+V / Cmd+Return without it.
4. Run the sidecar on the Mac, same host as the hub:

```bash
source scripts/env.sh
export MAILBOX_TOKEN=$(mailbox_token claude)
node dist/cli.js claude serve --port 8790
```

5. Send to that thread:

```bash
node dist/cli.js claude send --thread 550e8400-e29b-41d4-a716-446655440000 \
  --from grok:X --reply-to grok:X --correlation-id job-1 \
  --body "…" --transport desktop
```

What that does:

1. `open "claude://claude.ai/chat/<uuid>?q=…"` (best-effort prefill; documented for `/new`, attempted on `/chat`).
2. `pbcopy` the prompt (avoids AppleScript string escaping).
3. Activate Claude, Cmd+A, Cmd+V, Cmd+Return (Claude Desktop's default send). If your build sends on Enter alone, pass `--submit-key` is not wired on the CLI yet — set the adapter `desktop.submitKey` option to `'return'`.

Desktop cannot be read back through Accessibility reliably (Electron). Round-trip options:

- Point Claude Desktop at this mailbox's MCP (`$MAILBOX_URL/mcp`) and tell it to `send_message` to the `reply_to` address, copying `correlation_id`.
- Or POST to the sidecar: `POST http://127.0.0.1:8790/reply` with `{ "chat_id": "grok:X", "text": "…", "correlation_id": "job-1", "thread_id": "<uuid>" }`.

## 3. Permissions checklist

- [ ] Claude Desktop running and logged in
- [ ] Accessibility for the adapter's parent (osascript / System Events)
- [ ] Hub on `127.0.0.1` (see README — do not publish it casually)
- [ ] `mailbox.config.json` mode 600; `MAILBOX_TOKEN` is the Claude agent's token

## 4. What we will not do

- Drive claude.ai with a stolen session cookie (undocumented private HTTP).
- Auto-submit `claude://` links (Anthropic removed that on purpose).
- Claim the wrapper works on Linux. `send --transport desktop` here is dry-run unless you inject `openUrl` / `runScript`.
