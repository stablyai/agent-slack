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
  Triggers: "slack message", "slack thread", "slack URL", "slack link", "read slack", "reply on slack", "search slack", "channel history", "recent messages", "channel messages", "latest messages"
---

# Slack automation with `agent-slack`

`agent-slack` is a CLI binary installed on `$PATH`. Invoke it directly (e.g. `agent-slack user list`)

## Quick start (auth)

Authentication is automatic on macOS (Slack Desktop first, then Chrome fallback).

If credentials aren’t available, run one of:

- Slack Desktop (default):

```bash
agent-slack auth import-desktop
agent-slack auth test
```

- Chrome fallback:

```bash
agent-slack auth import-chrome
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
agent-slack message list "#general" --limit 20
agent-slack message list "C0123ABC" --limit 10
agent-slack message list "#general" --with-reaction eyes --oldest "1770165109.000000" --limit 20
agent-slack message list "#general" --without-reaction dart --oldest "1770165109.000000" --limit 20
```

This returns the most recent messages in chronological order. Use `--limit` to control how many (default 25).
When using `--with-reaction` or `--without-reaction`, you must also pass `--oldest` to bound scanning.

## Attachments (snippets/images/files)

`message get/list` and `search` auto-download attachments and include absolute paths in JSON output (typically under `message.files[].path` / `files[].path`).

## Draft a message (browser editor)

Opens a Slack-like rich-text editor in the browser for composing messages with formatting toolbar (bold, italic, strikethrough, links, lists, quotes, code, code blocks). After sending, shows a "View in Slack" link.

```bash
agent-slack message draft "#general"
agent-slack message draft "#general" "initial text"
agent-slack message draft "https://workspace.slack.com/archives/C123/p1700000000000000"
```

## Send, edit, delete, or react

```bash
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack message edit "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this today."
agent-slack message delete "https://workspace.slack.com/archives/C123/p1700000000000000"
agent-slack message react add "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
agent-slack message react remove "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
```

Channel mode for edit/delete requires `--ts`:

```bash
agent-slack message edit "#general" "Updated text" --workspace "myteam" --ts "1770165109.628379"
agent-slack message delete "#general" --workspace "myteam" --ts "1770165109.628379"
```

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
agent-slack search all "smoke tests failed" --channel "#alerts" --after 2026-01-01 --before 2026-02-01
agent-slack search messages "stably test" --user "@alice" --channel general
agent-slack search files "testing" --content-type snippet --limit 10
```

## Multi-workspace guardrail (important)

If you have multiple workspaces configured and you use a channel **name** (`#general` / `general`), pass `--workspace` (or set `SLACK_WORKSPACE_URL`) to avoid ambiguity:

```bash
agent-slack message get "#general" --workspace "https://myteam.slack.com" --ts "1770165109.628379"
agent-slack message get "#general" --workspace "myteam" --ts "1770165109.628379"
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
