# Cursor + Grok adapters on a Mac

This process is a **vendor adapter**, not a second mailbox. Addresses stay
`{vendor}:{thread_id}`. Envelopes stay `id`, `from`, `to`, `reply_to`,
`correlation_id`, `body`, `created_at`. Replies always go to `reply_to`.

You only need these wrappers when the public API cannot see the thread you
care about.

## What the public APIs already cover (any OS)

| Address | How it is delivered |
|---|---|
| `cursor:bc-…` | [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) `POST /v1/agents/{id}/runs` with `CURSOR_API_KEY`. Reply text comes from the run `result` (or legacy `GET /v0/agents/{id}/conversation`). |
| `cursor:<cli-chat-id>` | Cursor CLI `agent --resume <id> -p` ([parameters](https://cursor.com/docs/cli/reference/parameters)). |
| `grok:resp_…` / `grok:rs_…` | [xAI Responses API](https://docs.x.ai/developers/model-capabilities/text/generate-text) `previous_response_id`. `XAI_API_KEY`. This is **not** a grok.com sidebar chat. |
| Cursor Grok (the model inside Cursor) | Still **Cursor**. Address it as `cursor:…`. |

Cursor **desktop composer chats** have no public inject-by-id API. Official
deeplinks ([docs](https://cursor.com/docs/reference/deeplinks)) prefill a **new**
prompt (`cursor://anysphere.cursor-deeplink/prompt?text=…`) or open a **cloud**
agent (`cursor://anysphere.cursor-deeplink/background-agent?bcId=…`). They do
not target an arbitrary local thread. An undocumented, gated
`cursor desktop send <threadId>` exists in some Cursor Desktop builds; the
adapter tries it, then falls back.

Grok **web** chats (`https://grok.com/c/{uuid}`) are not the xAI API. There is
no documented Grok Bot URL scheme for a specific teammate thread.

## Run the adapter on the Mac

```bash
cd /path/to/agent-mailbox
npm install
# Cloud / API threads (Linux and Mac):
CURSOR_API_KEY=… XAI_API_KEY=… node dist/cli.js adapter serve --port 8788
```

On the Mac that has Safari / Cursor.app / Grok Bot.app, the same command also
enables the wrappers below. Bind stays `127.0.0.1`.

```bash
# send into a grok.com chat whose URL is https://grok.com/c/<uuid>
curl -s -X POST http://127.0.0.1:8788/v1/send \
  -H 'content-type: application/json' \
  -d '{"from":"cursor:bc-YOUR-AGENT","to":"grok:THE-UUID","reply_to":"cursor:bc-YOUR-AGENT","body":"status?"}'
```

Optional: also long-poll the mailbox hub as agents `cursor` and `grok`
(`MAILBOX_URL` + `MAILBOX_TOKEN`). `init` those ids the same way as any other
sender.

Keep the adapter alive with launchd the same way as the hub
(`scripts/install-service.sh` is hub-only; copy the plist and point
`ProgramArguments` at `adapter serve` if you want a second agent).

## grok.com (Safari)

1. Install Safari. Sign in at [grok.com](https://grok.com).
2. Settings → Advanced → **Show features for web developers**.
3. Develop → **Allow JavaScript from Apple Events**.
4. Copy the chat id from the URL: `https://grok.com/c/<uuid>`.
5. Grant Automation permission when macOS asks (osascript → Safari).

The wrapper opens that URL (or finds an existing tab), inserts the envelope,
clicks Send, and polls the page until the text stops growing. Selectors will
lag grok.com UI changes; if it fails, the error names the missing composer.

## Cursor Desktop

- Cloud thread: `open cursor://anysphere.cursor-deeplink/background-agent?bcId=<id>`
  (and, with `CURSOR_API_KEY`, the HTTP follow-up — prefer the API).
- Local thread, if your Cursor build exposes it: Settings → Beta → allow CLI
  to access desktop agents, then `cursor desktop send` works. Otherwise there
  is **no** supported inject path; use a Cloud Agent id or a CLI chat id.

## Grok Bot.app

Official Mac app from [x.ai/bot](https://x.ai/bot). No public send-to-thread
API. The wrapper activates the app, pastes, and hits Return. That needs
**Accessibility** for the process running `osascript` (Terminal, node, or
launchd). It cannot choose a teammate by id; focus the right thread first.

Community tools that decrypt the local Grok Bot gateway from Keychain are
**not** used here.

## Permissions checklist

- Automation: `osascript` controlling Safari and/or Cursor and/or Grok Bot
- Accessibility: only for the Grok Bot paste wrapper
- Safari JavaScript from Apple Events: grok.com inject
- Loopback only: do not publish port 8788
