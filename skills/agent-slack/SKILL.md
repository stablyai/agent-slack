---
name: agent-slack
description: "Slack CLI for agents: read URLs/threads/history/unreads/later/canvases/workflows, create canvases from Markdown, search messages/files, download attachments, lookup users, list/create/invite channels, open DMs, draft messages, schedule sends, and explicit sends/edits/deletes/reactions/mark-read/uploads."
---

# agent-slack

CLI on `$PATH`: `agent-slack ...`. If missing, prefer:

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/main/install.sh | sh
```

Fallback: `npm i -g agent-slack` (Node >= 22.5).

Treat the installed CLI's `agent-slack --help` and `agent-slack <command> --help` output as authoritative for supported commands and flags.

Safety: read/search freely. Treat sends, edits, deletes, reactions, invitations, channel or canvas creation, mark-read operations, schedules, uploads, scheduled-message cancellation, and `workflow run` as write actions; perform them only when explicitly requested. Workflow runs can execute downstream actions. Prefer `message draft`.

Auth: `agent-slack auth whoami`; if needed `auth import-desktop`, `auth import-brave`, `auth import-chrome`, or `auth import-firefox`, then `auth test`.

For labeled links inside bullet or numbered lists, use Slack's `<URL|label>` syntax. Auto-converted lists do not convert CommonMark `[label](URL)` links into labeled link elements.

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
agent-slack canvas create --file ./plan.md --title "Plan"
agent-slack canvas create --markdown $'# Plan\n\n- [ ] Ship it'
agent-slack canvas get "CANVAS_URL"
agent-slack workflow list "general"
agent-slack user list
agent-slack channel list
agent-slack user dm-open @alice @bob
```

With multiple workspaces, pass `--workspace "team"` or set `SLACK_WORKSPACE_URL`. Attachments include local `path` in JSON.
Treat Slack user IDs beginning with `U` or `W` equivalently.

For non-trivial usage, read the bundled references:

- [references/commands.md](references/commands.md): command map and flags
- [references/targets.md](references/targets.md): URL, channel, and direct-message targeting rules
- [references/output.md](references/output.md): JSON shapes and download paths
