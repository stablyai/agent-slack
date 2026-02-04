---
name: agent-slack
description: Slack automation CLI for AI agents. Use when the task involves reading a Slack message/thread from a Slack URL, extracting content (text/code/snippets/files), or posting a reply / adding a reaction.
allowed-tools: Bash(*)
---

# Slack Automation with agent-slack

## Quick Start

1. Authentication is automatic on macOS (Slack Desktop first, then Chrome fallback). If it fails, run one of:

- Slack Desktop (default):

```bash
agent-slack auth import-desktop
agent-slack doctor
```

- Chrome fallback:

```bash
agent-slack auth import-chrome
agent-slack doctor
```

- Or set env vars (browser tokens):

```bash
export SLACK_TOKEN="xoxc-..."
export SLACK_COOKIE_D="xoxd-..."
agent-slack doctor
```

- Or set a standard token:

```bash
export SLACK_TOKEN="xoxb-..."  # or xoxp-...
agent-slack doctor
```

## Read a Slack URL (message + full thread)

```bash
agent-slack msg "https://workspace.slack.com/archives/C123/p1700000000000000"
```

## Read just the thread

```bash
agent-slack thread "https://workspace.slack.com/archives/C123/p1700000000000000"
```

## Download attached files (images/snippets/etc.)

`msg` auto-downloads attached files and includes absolute paths in the JSON output (`message.files[].path`).

## Reply or react

```bash
agent-slack reply "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack react "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
```
