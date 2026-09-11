# Codex and ChatGPT Mac setup

Claude can take an inbound mailbox message in-thread (native @-mention / Monitor).
The ChatGPT and Codex **Mac apps do not**. This folder is the wrapper those
adapters use when there is no CLI path.

The TypeScript adapters embed the same JXA. You do not have to run these
scripts by hand unless you are debugging Accessibility.

## What exists natively

| Surface | Public way to address a thread | Public way to **send** into it |
|---|---|---|
| Codex CLI 0.149+ | session UUID or exact name | `codex queue --thread <id> --message <text>` |
| Codex CLI | session UUID | `codex exec resume <id> --output-last-message out.txt` |
| Codex / ChatGPT desktop | `codex://threads/<uuid>` | **none** — deep link opens, does not submit. `?prompt=` is documented only for **new** chats and still does not send. |
| ChatGPT conversation | `https://chatgpt.com/c/<uuid>` | **none**. Classic app has been opened with `com.openai.chat://chatgpt.com/c/<uuid>` (community / Shortcuts). Accessibility paste is required to submit. |

Copy ids from the desktop app: **Copy session ID** (⌘⌥C), **Copy chat deep link** (⌘⌥L).

## Permissions

1. Install [ChatGPT for Mac](https://openai.com/chatgpt/desktop/).
   - Classic ChatGPT.app bundle id: `com.openai.chat`
   - Current ChatGPT desktop (Codex lineage) bundle id: `com.openai.codex` — the app name may be `ChatGPT.app` or `Codex.app`
2. **System Settings → Privacy & Security → Accessibility**: enable the terminal, `node`, or launchd job that runs `agent-mailbox adapt`.
3. If macOS asks, allow Automation for System Events / ChatGPT.

## Run the adapter on the Mac

The hub can stay on `127.0.0.1`. The adapter has to run where the apps run.

```bash
export MAILBOX_URL=http://127.0.0.1:8787
export MAILBOX_TOKEN=mb_…          # a sender/listener token from init

# ChatGPT consumer conversation
agent-mailbox adapt chatgpt --thread 8f3c1a2b-…

# Codex session (CLI first, desktop wrapper if CLI cannot inject)
agent-mailbox adapt codex --thread 019d25ff-3701-75d1-b331-160b90f8a456

# Loopback inject API (Shortcuts, curl, another agent on this Mac)
agent-mailbox adapt serve chatgpt --thread 8f3c1a2b-… --port 8790
curl -s -X POST http://127.0.0.1:8790/send \
  -H 'content-type: application/json' \
  -d '{"threadId":"8f3c1a2b-…","envelope":{"id":"1","from":"claude:abc","to":"chatgpt:8f3c1a2b-…","reply_to":"claude:abc","correlation_id":"1","body":"hello","created_at":"2026-09-11T00:00:00.000Z"}}'
```

Replies are posted to `reply_to`. That is how thread Y answers thread X.

## Manual JXA (debug)

`inject.jxa` activates an app and pastes the clipboard with ⌘V then Return.
Put the payload on the clipboard first (`pbcopy`).

```bash
osascript -l JavaScript macos/inject.jxa -- com.openai.chat ChatGPT
```
