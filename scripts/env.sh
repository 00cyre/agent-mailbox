# Source this before running any agent-mailbox client command.
#
#   source scripts/env.sh
#   export MAILBOX_TOKEN=$(mailbox_token claude)
#   node dist/cli.js chats
#
# The point is that no token is ever typed on a command line, pasted into a
# config, or left in shell history — it is read out of mailbox.config.json at
# the moment it is needed. That file is mode 600 and gitignored; treat it as the
# only place tokens live.

# Repo root, however this file was sourced from.
MAILBOX_HOME="${MAILBOX_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
export MAILBOX_HOME
export MAILBOX_CONFIG="${MAILBOX_CONFIG:-$MAILBOX_HOME/mailbox.config.json}"

# Host and port come from the config, so moving the hub needs one edit, not five.
if [ -z "${MAILBOX_URL:-}" ]; then
  MAILBOX_URL=$(python3 -c "
import json
c = json.load(open('$MAILBOX_CONFIG'))
print(f\"http://{c.get('host','127.0.0.1')}:{c.get('port',8787)}\")
" 2>/dev/null || echo 'http://127.0.0.1:8787')
fi
export MAILBOX_URL

# mailbox_token <agent-id> -> that agent's token on stdout.
mailbox_token() {
  python3 -c "
import json, sys
agents = json.load(open('$MAILBOX_CONFIG'))['agents']
match = [a for a in agents if a['id'] == '$1']
if not match:
    sys.exit('no agent \"$1\" in $MAILBOX_CONFIG')
print(match[0]['token'])
"
}
