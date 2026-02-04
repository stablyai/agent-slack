---
name: agent-slack
description: Slack automation CLI for AI agents. Use when you need to read a Slack message/thread (URL or channel+ts), download attachments to local paths, search messages/files, or send a reply / add a reaction.
---

# Slack automation with `agent-slack`

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
agent-slack search messages "kernel vm" --user "@alice" --channel general
agent-slack search files "playwright" --content-type snippet --limit 10
```

## Multi-workspace guardrail (important)

If you have multiple workspaces configured and you use a channel **name** (`#general` / `general`), pass `--workspace` (or set `SLACK_WORKSPACE_URL`) to avoid ambiguity:

```bash
agent-slack message get "#general" --workspace "https://myteam.slack.com" --ts "1770165109.628379"
```

## Deep-dive references

- [references/commands.md](references/commands.md): command map + key flags
- [references/targets.md](references/targets.md): URL vs `#channel` targeting rules
- [references/output.md](references/output.md): output shapes + download locations
