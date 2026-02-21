#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README_FILE="$ROOT_DIR/README.md"
SKILL_FILE="$ROOT_DIR/skills/agent-slack/SKILL.md"
COMMANDS_FILE="$ROOT_DIR/skills/agent-slack/references/commands.md"

failures=0

has_command() {
  command -v "$1" >/dev/null 2>&1
}

require_in_file() {
  local needle="$1"
  local file="$2"
  if has_command rg; then
    if rg -F -q "$needle" "$file"; then
      return
    fi
  elif grep -F -q -- "$needle" "$file"; then
    return
  fi

  if [[ -f "$file" ]]; then
    echo "Missing in $(basename "$file"): $needle" >&2
    failures=$((failures + 1))
  fi
}

require_path() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing file: $path" >&2
    failures=$((failures + 1))
  fi
}

require_path "$README_FILE"
require_path "$SKILL_FILE"
require_path "$COMMANDS_FILE"

skill_lines="$(wc -l < "$SKILL_FILE" | tr -d ' ')"
if (( skill_lines > 500 )); then
  echo "SKILL.md is too long ($skill_lines lines). Keep it under 500 lines." >&2
  failures=$((failures + 1))
fi

# Keep setup guidance in SKILL.md so first-run execution works.
require_in_file "curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/master/install.sh | sh" "$SKILL_FILE"
require_in_file "npm i -g agent-slack" "$SKILL_FILE"

# Keep references linked from SKILL.md (one-level deep).
require_in_file "[references/commands.md](references/commands.md)" "$SKILL_FILE"
require_in_file "[references/targets.md](references/targets.md)" "$SKILL_FILE"
require_in_file "[references/output.md](references/output.md)" "$SKILL_FILE"

# Core command coverage in the exhaustive command reference.
reference_commands=(
  "agent-slack auth whoami"
  "agent-slack auth test"
  "agent-slack auth import-desktop"
  "agent-slack auth import-chrome"
  "agent-slack auth import-brave"
  "agent-slack auth parse-curl"
  "agent-slack auth add"
  "agent-slack auth set-default"
  "agent-slack auth remove"
  "agent-slack message get"
  "agent-slack message list"
  "agent-slack message send"
  "agent-slack message edit"
  "agent-slack message delete"
  "agent-slack message react add"
  "agent-slack message react remove"
  "agent-slack channel new"
  "agent-slack channel invite"
  "agent-slack search all"
  "agent-slack search messages"
  "agent-slack search files"
  "agent-slack canvas get"
  "agent-slack user list"
  "agent-slack user get"
  "agent-slack update --check"
)

for command in "${reference_commands[@]}"; do
  require_in_file "$command" "$COMMANDS_FILE"
done

# Keep frequent day-to-day operations directly in SKILL.md.
skill_common_commands=(
  "agent-slack message get"
  "agent-slack message list"
  "agent-slack message send"
  "agent-slack message edit"
  "agent-slack message delete"
  "agent-slack message react add"
  "agent-slack search all"
  "agent-slack channel invite"
  "agent-slack canvas get"
  "agent-slack user get"
)

for command in "${skill_common_commands[@]}"; do
  require_in_file "$command" "$SKILL_FILE"
done

# README should include top-level command map entries for discoverability.
readme_commands=(
  "├── auth"
  "├── message"
  "├── channel"
  "├── search"
  "├── canvas"
  "├── user"
  "└── update [options]"
)

for command in "${readme_commands[@]}"; do
  require_in_file "$command" "$README_FILE"
done

if (( failures > 0 )); then
  echo "Docs drift check failed with $failures issue(s)." >&2
  exit 1
fi

echo "Docs drift check passed."
