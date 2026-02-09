---
name: agent-slack
description: |
  Slack automation CLI for AI agents. Use when:
  - Reading a Slack message or thread (given a URL or channel+ts)
  - Downloading Slack attachments (snippets, images, files) to local paths
  - Searching Slack messages or files
  - Sending a reply or adding/removing a reaction
  - Fetching a Slack canvas as markdown
  - Looking up Slack users
  - Listing channels/conversations for a user or workspace
  Triggers: "slack message", "slack thread", "slack URL", "slack link", "read slack", "reply on slack", "search slack", "list slack channels", "slack conversations"
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

## Attachments (snippets/images/files)

`message get/list` and `search` auto-download attachments and include absolute paths in JSON output (typically under `message.files[].path` / `files[].path`).

## Reply or react (does the right thing)

```bash
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack message react add "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
agent-slack message react remove "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
```

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
```

## Canvas + Users

```bash
agent-slack canvas get "https://workspace.slack.com/docs/T123/F456"
agent-slack user list --workspace "https://workspace.slack.com" --limit 100
agent-slack user get "@alice" --workspace "https://workspace.slack.com"
agent-slack channel list --workspace "https://workspace.slack.com"
agent-slack channel list --workspace "https://workspace.slack.com" --user "@alice"
agent-slack channel list --workspace "https://workspace.slack.com" --all
```

`channel list` defaults to current user conversations and always excludes archived conversations.
`--all` switches to `conversations.list` and cannot be combined with `--user`.
`channel list` returns one API page per call; pass `--cursor` with the returned `next_cursor` to continue.
`--limit` defaults to `100` with a practical minimum of `10`.

## References

- [references/commands.md](references/commands.md): full command map + all flags
- [references/targets.md](references/targets.md): URL vs `#channel` targeting rules
- [references/output.md](references/output.md): JSON output shapes + download paths
