---
name: agent-slack
description: "Slack CLI for agents: read URLs/threads/history/unreads/later/canvases/workflows, search messages/files, download attachments, lookup users, list/create/invite channels, open DMs, draft messages, schedule sends, and explicit sends/edits/deletes/reactions/mark-read/uploads."
---

# agent-slack

CLI on `$PATH`: `agent-slack ...`. If missing, prefer:

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/main/install.sh | sh
```

Fallback: `npm i -g agent-slack` (Node >= 22.5).

Safety: read/search freely. Do not send, edit, delete, react, invite, create channels, mark read, schedule, upload, or cancel scheduled messages unless explicitly asked. Prefer `message draft`. With `AGENT_SLACK_SAFE_MODE=1` set, `message send` redirects to the draft editor and `edit`/`delete` are blocked.

Auth: `agent-slack auth whoami`; if needed `auth import-desktop`, `auth import-brave`, `auth import-chrome`, or `auth import-firefox`, then `auth test`.

Common commands:

```bash
agent-slack message get "SLACK_URL"
agent-slack message list "SLACK_URL"
agent-slack message list "general" --limit 20
agent-slack search messages "query" --channel "general"
agent-slack message draft "general" "text"
agent-slack message send "URL_OR_CHANNEL" "text" --attach ./file.md
agent-slack message send "general" "text" --schedule-in "3h"
agent-slack message scheduled list
agent-slack message scheduled cancel "SCHEDULED_ID" --channel "CHANNEL_ID"
agent-slack unreads
agent-slack later list
agent-slack canvas get "CANVAS_URL"
agent-slack workflow list "general"
agent-slack user list
agent-slack channel list
agent-slack user dm-open @alice @bob
```

With multiple workspaces, pass `--workspace "team"` or set `SLACK_WORKSPACE_URL`. Attachments include local `path` in JSON.

For non-trivial usage, read the bundled references:

- [references/commands.md](references/commands.md): command map and flags
- [references/targets.md](references/targets.md): URL vs channel targeting rules
- [references/output.md](references/output.md): JSON shapes and download paths
