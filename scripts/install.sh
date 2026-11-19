#!/usr/bin/env bash
# agent-bridge installer (Linux)
#
# Idempotent. Never overwrites an existing config. Symlinks the skill into the
# skills directory so `git pull` keeps it current, and prints the MCP block
# instead of editing opencode.json - that file is hand-maintained JSONC and a
# script rewriting it would eventually eat a comment.
#
#   bash scripts/install.sh                 # detect this host
#   bash scripts/install.sh --host big-bro
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.opencode/skills}"
CONFIG_DIR="$HOME/.agent-bridge"
CONFIG_PATH="$CONFIG_DIR/config.json"
HOST_PROFILE=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST_PROFILE="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$HOST_PROFILE" ]; then
  if [ "$(uname -s)" = "Linux" ]; then HOST_PROFILE="big-bro"; else HOST_PROFILE="kyros-home"; fi
fi

EXAMPLE="$REPO/config/$HOST_PROFILE.example.json"
if [ ! -f "$EXAMPLE" ]; then
  echo "no example config for '$HOST_PROFILE' at $EXAMPLE" >&2
  exit 1
fi

echo "agent-bridge -> $REPO"
echo "  host profile : $HOST_PROFILE"

mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_PATH" ] && [ "$FORCE" -eq 0 ]; then
  echo "  config       : kept existing $CONFIG_PATH"
else
  cp "$EXAMPLE" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  echo "  config       : wrote $CONFIG_PATH"
fi

mkdir -p "$SKILLS_DIR"
ln -sfn "$REPO/skill/agent-bridge" "$SKILLS_DIR/agent-bridge"
echo "  skill        : linked $SKILLS_DIR/agent-bridge"

BUN_BIN="$(command -v bun || echo bun)"
echo
echo "Add this to opencode.jsonc under mcp.servers (no restart needed - mcp.servers"
echo "re-resolves per list/connect). The skill link is the opposite: skills paths are"
echo "a startup read, so a new server process is needed before it loads:"
cat <<JSON
    "agent-bridge": {
      "type": "local",
      "command": ["$BUN_BIN", "run", "$REPO/src/mcp.ts"],
      "environment": { "AGENT_BRIDGE_CONFIG": "$CONFIG_PATH" }
    }
JSON

echo
echo "Verify:"
echo "  cd $REPO && bun test && bun run src/cli.ts hosts && bun run src/cli.ts ping $HOST_PROFILE"
