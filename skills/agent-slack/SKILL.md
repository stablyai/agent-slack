---
name: agent-slack
description: |
  Slack automation CLI for AI agents. Use when:
  - Reading a Slack message or thread (given a URL or channel+ts)
  - Browsing recent channel messages / channel history
  - Downloading Slack attachments (snippets, images, files) to local paths
  - Searching Slack messages or files
  - Sending, editing, or deleting a message; adding/removing reactions
  - Listing channels/conversations; creating channels and inviting users
  - Fetching a Slack canvas as markdown
  - Looking up Slack users
  - Marking channels/DMs as read
  - Opening DM or group DM channels
  - Discovering and running Slack workflows
  Triggers: "slack message", "slack thread", "slack URL", "slack link", "read slack", "reply on slack", "search slack", "channel history", "recent messages", "channel messages", "latest messages", "mark as read", "mark read"
---

# Slack automation with `agent-slack`

`agent-slack` is a CLI binary on `$PATH`. Invoke directly (e.g. `agent-slack user list`).

## Installation

If `agent-slack` is not found on `$PATH`, install it:

- `curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/main/install.sh | sh` (recommended)
- `npm i -g agent-slack` (requires Node >= 22.5)
- `nix run github:stablyai/agent-slack -- <args>` (no install needed, prefix all commands)

## CRITICAL: Bash command formatting rules

Claude Code's permission checker has security heuristics that force manual approval prompts. Avoid these patterns to keep commands auto-allowed. See: https://github.com/anthropics/claude-code/issues/34379

1. **No `#` anywhere in the command string.** Treated as a comment delimiter even inside quotes. Use bare channel names (`general` not `#general`). No `#` comments in inline scripts — use the Bash tool's `description` parameter instead.
2. **No `''` (consecutive single quotes) or `""` (consecutive double quotes).** Triggers "potential obfuscation" check. Avoid Python empty string literals like `d.get('key', '')` — use `d.get('key')` instead.
3. **Only `| jq` for filtering — no python3, no other commands.** `python3 -c` is not in the allow list and triggers prompts. `jq` with single-quote-only expressions (no `"` inside) is safe:
   - WRONG: `agent-slack search ... | python3 -c "..."` (not allowed)
   - WRONG: `agent-slack search ... | jq '.a + "x"'` (mixed quotes)
   - RIGHT: `agent-slack search ... | jq '.a'`
   - RIGHT: `agent-slack search ... | jq '.messages[] | .ts'`
4. **No `||` or `&&` chains.** Run multiple agent-slack commands as separate Bash tool calls.
5. **No file redirects (`>`, `>>`).** Process JSON output directly, don't write to files.

## Quick start (auth)

Authentication is automatic on macOS and Windows (Slack Desktop first, then Chrome/Firefox fallbacks on macOS).

If credentials aren’t available, run one of:

- Slack Desktop import (macOS/Windows):

```bash
agent-slack auth import-desktop
agent-slack auth test
```

- Chrome fallback:

```bash
agent-slack auth import-chrome
agent-slack auth test
```

- Firefox fallback:

```bash
agent-slack auth import-firefox
agent-slack auth test
```

- Or set env vars (browser tokens; avoid pasting these into chat logs):

```bash
export SLACK_TOKEN="xoxc-..."
export SLACK_COOKIE_D="xoxd-..."
agent-slack auth test
```

- Or set a standard token:

```bash
export SLACK_TOKEN="xoxb-..."  # or xoxp-...
agent-slack auth test
```

Check configured workspaces:

```bash
agent-slack auth whoami
```

## Canonical workflow (given a Slack message URL)

1. Fetch a single message (plus thread summary, if any):

```bash
agent-slack message get "https://workspace.slack.com/archives/C123/p1700000000000000"
```

2. If you need the full thread:

```bash
agent-slack message list "https://workspace.slack.com/archives/C123/p1700000000000000"
```

## Browse recent channel messages

To see what's been posted recently in a channel (channel history):

```bash
agent-slack message list "general" --limit 20
agent-slack message list "C0123ABC" --limit 10
agent-slack message list "general" --with-reaction eyes --oldest "1770165109.000000" --limit 20
agent-slack message list "general" --without-reaction dart --oldest "1770165109.000000" --limit 20
```

This returns the most recent messages in chronological order. Use `--limit` to control how many (default 25).
When using `--with-reaction` or `--without-reaction`, you must also pass `--oldest` to bound scanning.

## Attachments (snippets/images/files)

`message get/list` and `search` auto-download attachments and include file metadata in JSON output (typically under `message.files[]` / `files[]`), including `name` when available and `path` for the local download. Failed message attachment downloads keep the attachment entry, preserve a local `.download-error.txt` path, and include `message.files[].error` for `message get/list` or `messages[].files[].error` for `search messages|all`; `search files` skips files whose download fails.

## Draft a message (browser editor)

Opens a Slack-like rich-text editor in the browser for composing messages with formatting toolbar (bold, italic, strikethrough, links, lists, quotes, code, code blocks). After sending, shows a "View in Slack" link.

```bash
agent-slack message draft "general"
agent-slack message draft "general" "initial text"
agent-slack message draft "https://workspace.slack.com/archives/C123/p1700000000000000"
```

## Send, edit, delete, or react

```bash
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack message send "alerts-staging" "here's the report" --attach ./report.md
agent-slack message edit "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this today."
agent-slack message delete "https://workspace.slack.com/archives/C123/p1700000000000000"

agent-slack message send "general" "Here's the plan:
- Step 1: do the thing
- Step 2: verify it worked
  - Sub-step: check logs"
agent-slack message react add "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
agent-slack message react remove "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
```

Channel mode for edit/delete requires `--ts`:

```bash
agent-slack message edit "general" "Updated text" --workspace "myteam" --ts "1770165109.628379"
agent-slack message delete "general" --workspace "myteam" --ts "1770165109.628379"
```

Attach options for `message send`:

- `--attach <path>` upload a local file (repeatable)

## List channels + create/invite users

```bash
agent-slack channel list
agent-slack channel list --user "@alice" --limit 50
agent-slack channel list --all --limit 100
agent-slack channel new --name "incident-war-room"
agent-slack channel new --name "incident-leads" --private
agent-slack channel invite --channel "incident-war-room" --users "U01AAAA,@alice,bob@example.com"
agent-slack channel invite --channel "incident-war-room" --users "partner@vendor.com" --external
agent-slack channel invite --channel "incident-war-room" --users "partner@vendor.com" --external --allow-external-user-invites
```

For `--external`, invite targets must be emails. By default, invitees are external-limited; add
`--allow-external-user-invites` to allow them to invite other users.

## Search (messages + files)

Prefer channel-scoped search for reliability:

```bash
agent-slack search all "smoke tests failed" --channel "alerts" --after 2026-01-01 --before 2026-02-01
agent-slack search messages "stably test" --user "@alice" --channel general
agent-slack search files "testing" --content-type snippet --limit 10
```

## Multi-workspace guardrail (important)

If you have multiple workspaces configured and you use a channel **name** (e.g. `general`), pass `--workspace` (or set `SLACK_WORKSPACE_URL`) to avoid ambiguity:

```bash
agent-slack message get "general" --workspace "https://myteam.slack.com" --ts "1770165109.628379"
agent-slack message get "general" --workspace "myteam" --ts "1770165109.628379"
```

## DM / group DM channels

Get the channel ID for a DM or group DM, useful for sending messages to a group of users:

```bash
agent-slack user dm-open @alice @bob
agent-slack user dm-open U01AAAA U02BBBB U03CCCC
```

## Mark as read

Mark a channel, DM, or group DM as read up to a given message:

```bash
agent-slack channel mark "https://workspace.slack.com/archives/C123/p1700000000000000"
agent-slack channel mark "general" --workspace "myteam" --ts "1770165109.628379"
agent-slack channel mark "D0A04PB2QBW" --workspace "myteam" --ts "1770165109.628379"
```

To make a specific message appear unread, set `--ts` to just before it (subtract `0.000001`). This moves the read cursor so that message and everything after it appear as new:

```bash
agent-slack channel mark "general" --workspace "myteam" --ts "1770165109.628378"
```

## Workflows

Discover and run Slack workflows bookmarked in channels:

```bash
# List workflows in a channel
agent-slack workflow list "#ops"

# Preview trigger metadata (no side effects)
agent-slack workflow preview "Ft123ABC"

# Get workflow definition including form fields and steps
agent-slack workflow get "Ft123ABC"
agent-slack workflow get "Wf456DEF"

# Trip a workflow trigger
agent-slack workflow run "Ft123ABC" --channel "#ops"
```

## Canvas + Users

```bash
agent-slack canvas get "https://workspace.slack.com/docs/T123/F456"
agent-slack user list --workspace "https://workspace.slack.com" --limit 100
agent-slack user get "@alice" --workspace "https://workspace.slack.com"
```

## References

- [references/commands.md](references/commands.md): full command map + all flags
- [references/targets.md](references/targets.md): URL vs `#channel` targeting rules
- [references/output.md](references/output.md): JSON output shapes + download paths
