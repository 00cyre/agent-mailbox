#!/usr/bin/env bash
# Print the block to give another agent so it can message your chats.
#
#   scripts/handoff.sh grokbot
#
# Everything it prints is specific to this mailbox: the URL it is actually
# listening on and that agent's real token. Paste the output into the other
# agent once; after that a plain sentence — "send a message to the Claude chat
# <name>" — is enough for it to act on.
set -euo pipefail

AGENT="${1:-}"
if [ -z "$AGENT" ]; then
  echo "usage: scripts/handoff.sh <agent-id>" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"
TOKEN=$(mailbox_token "$AGENT")

cat <<EOF
=============================================================================
 Paste this into $AGENT once. After that you can just say:
   "...and when you're done, send a message to the Claude chat <chat name>."
=============================================================================

You can send messages to my chats. The mailbox runs at $MAILBOX_URL.
Each chat has a name; I will tell you which one to use.

To send:

  curl -s -X POST $MAILBOX_URL/v1/send \\
    -H "Authorization: Bearer $TOKEN" \\
    -H 'content-type: application/json' \\
    -d '{
          "to": "<the chat name I gave you, verbatim>",
          "thread": "<short slug for this topic>",
          "subject": "<one line>",
          "body": "<what you want to say, markdown>"
        }'

The chat name goes in "to" exactly as I wrote it — spaces, capitals and
parentheses are all fine. A 404 means no chat by that name is registered; list
the ones that exist with:

  curl -s $MAILBOX_URL/v1/chats -H "Authorization: Bearer $TOKEN"

To read replies — this call BLOCKS until one arrives (up to 25s), so loop it,
passing back the "cursor" from each response:

  curl -s "$MAILBOX_URL/v1/inbox?cursor=0&wait=25000" -H "Authorization: Bearer $TOKEN"

If you speak MCP, add this instead and you get send_message, list_chats,
wait_for_message, check_inbox, read_thread, list_threads as tools:

  {
    "mcpServers": {
      "mailbox": {
        "type": "http",
        "url": "$MAILBOX_URL/mcp",
        "headers": { "Authorization": "Bearer $TOKEN" }
      }
    }
  }

  (MCP requests need: accept: application/json, text/event-stream)

Notes
  - You are "$AGENT". That comes from the token; there is no "from" to set.
  - Reuse the same "thread" for a follow-up and both sides keep the context.
  - A chat that is not currently listening still receives the mail — it is a
    mailbox, so it will be read when someone comes back.
EOF
