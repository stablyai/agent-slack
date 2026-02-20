# agent-slack

Slack automation CLI for AI agents (TypeScript + Bun).

Guiding principle:

- **token-efficient output by default** (compact JSON, minimal duplication, and empty/null fields pruned) so LLMs can consume results cheaply.
- **zero-config auth** -- Auth just works if you have Slack Desktop (with fallbacks available). No Python dependency.

## Getting started

Install via Bun (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/master/install.sh | sh
```

OR npm global install (requires Node >= 22.5):

```bash
npm i -g agent-slack
```

## At a glance

- **Read**: fetch a message, browse channel history, list full threads
- **Search**: messages + files (with filters)
- **Artifacts**: auto-download snippets/images/files to local paths for agents
- **Write**: reply, edit/delete messages, add reactions
- **Canvas**: fetch Slack canvases as Markdown

## Agent skill

This repo ships an agent skill at `skills/agent-slack/` compatible with Claude Code, Codex, Cursor, etc

**Install via [skills.sh](https://skills.sh)** (recommended):

```bash
npx skills add stablyai/agent-slack
```

<details>
<summary>Manual installation</summary>
```bash
bash ./scripts/install-skill.sh
```
</details>

## Command map (high level)

```text
agent-slack
├── auth
│   ├── whoami
│   ├── test
│   ├── import-desktop
│   ├── import-chrome
│   └── parse-curl
├── message
│   ├── get   <target>             # fetch 1 message (+ thread meta )
│   ├── list  <target>             # fetch thread or recent channel messages
│   ├── send  <target> <text>      # send / reply (does the right thing)
│   ├── edit  <target> <text>      # edit a message
│   ├── delete <target>            # delete a message
│   └── react
│       ├── add    <target> <emoji>
│       └── remove <target> <emoji>
├── user
│   ├── list
│   └── get <user>
├── search
│   ├── all      <query>           # messages + files
│   ├── messages <query>
│   └── files    <query>
└── canvas
    └── get <canvas-url-or-id>     # canvas → markdown
```

Notes:

- Output is **always JSON** and aggressively pruned (`null`/empty fields removed).
- Attached files are auto-downloaded and returned as absolute local paths.

## Authentication (no fancy setup)

On macOS, authentication happens automatically:

- Default: reads Slack Desktop local data (no need to quit Slack)
- Fallback: if that fails, tries Chrome extraction (if Slack is open in Chrome)

You can also run manual imports:

```bash
agent-slack auth whoami
agent-slack auth import-desktop
agent-slack auth import-chrome
agent-slack auth test
```

Alternatively, set env vars:

```bash
export SLACK_TOKEN="xoxc-..."      # browser token
export SLACK_COOKIE_D="xoxd-..."   # cookie d
agent-slack auth test
```

Or use a standard Slack token (xoxb/xoxp):

```bash
export SLACK_TOKEN="xoxb-..."
agent-slack auth test
```

## Targets: URL or channel

`message get` / `message list` accept either a Slack message URL or a channel reference:

- URL: `https://workspace.slack.com/archives/<channel>/p<digits>[?thread_ts=...]`
- Channel: `#general` (or bare `general`) or a channel ID like `C0123...`

In practice:

```bash
# Get a single message by channel + ts
agent-slack message get "#general" --ts "1770165109.628379"

# List a full thread by channel + thread root ts
agent-slack message list "#general" --thread-ts "1770165109.000001"
```

If you have multiple workspaces configured and you use a channel **name** (`#channel` / `channel`), you must pass `--workspace` (or set `SLACK_WORKSPACE_URL`).
`--workspace` accepts a full URL or a unique substring selector:

```bash
agent-slack message get "#general" --workspace "https://stablygroup.slack.com" --ts "1770165109.628379"
agent-slack message get "#general" --workspace "stablygroup" --ts "1770165109.628379"
```

## Examples

> [!TIP]
> You should probably just use the skill for your agent instead of reading below.

### Read messages / threads

```bash
# Single message (+ thread summary if threaded)
agent-slack message get "https://workspace.slack.com/archives/C123/p1700000000000000"

# Full thread for a message
agent-slack message list "https://workspace.slack.com/archives/C123/p1700000000000000"

# Recent channel messages (browse channel history)
agent-slack message list "#general" --limit 20

# Recent channel messages that are marked with :eyes:
agent-slack message list "#general" --with-reaction eyes --limit 20

# Recent channel messages that do not have :dart:
agent-slack message list "#general" --without-reaction dart --limit 20
```

Optional:

```bash
# Include reactions + which users reacted
agent-slack message get "https://workspace.slack.com/archives/C123/p1700000000000000" --include-reactions
```

### Reply, edit, delete, and react

```bash
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack message edit "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this today."
agent-slack message delete "https://workspace.slack.com/archives/C123/p1700000000000000"
agent-slack message react add "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
agent-slack message react remove "https://workspace.slack.com/archives/C123/p1700000000000000" "eyes"
```

Channel mode requires `--ts`:

```bash
agent-slack message edit "#general" "Updated text" --workspace "myteam" --ts "1770165109.628379"
agent-slack message delete "#general" --workspace "myteam" --ts "1770165109.628379"
```

### Message get vs list

**`message get`** fetches a single message. If the message is in a thread, it also returns thread metadata (reply count, participants) but **not** the full thread contents:

```json
{
  "message": { "ts": "...", "text": "...", "user": "U123", ... },
  "thread": { "replyCount": 5, "participants": ["U123", "U456"] }
}
```

**`message list`** fetches all replies in a thread, or recent channel messages when no thread is specified. Use this when you need the full conversation:

```json
{
  "messages": [
    { "ts": "...", "text": "...", "user": "U123", ... },
    { "ts": "...", "text": "...", "user": "U456", ... }
  ]
}
```

When to use which:

- Use `get` to check a single message or see if there's a thread worth expanding
- Use `list` to read an entire thread conversation
- Use `list` on a channel (without `--thread-ts`) to browse recent channel messages
- Use `list` with `--with-reaction` / `--without-reaction` to filter channel history by reaction markers

### Files (snippets/images/attachments)

`message get/list` auto-download attached files to an agent-friendly temp directory and return absolute paths in `message.files[].path`:

- macOS default: `~/.agent-slack/tmp/downloads/`

Agents can read those paths directly (e.g. snippets as `.txt`, images as `.png`).

### Search (messages + files)

```bash
# Search both messages and files
agent-slack search all "smoke tests failed" --channel "#alerts" --after 2026-01-01 --before 2026-02-01

# Search messages only
agent-slack search messages "stably ai" --user "@stablyai" --channel general

# Search files only (downloads files and returns local paths)
agent-slack search files "testing" --content-type snippet --limit 10
```

Tips:

- For reliable results, include `--channel ...` (channel-scoped search scans history/files and filters locally).
- Use `--workspace <url-or-unique-substring>` when using `#channel` names across multiple workspaces.

<!-- AI search (assistant.search.*) is described in design.doc but not currently implemented. -->

### Users

```bash
# List users (email requires appropriate Slack scopes; fields are pruned if missing)
agent-slack user list --workspace "https://workspace.slack.com" --limit 200 | jq .

# Get one user by id or handle
agent-slack user get U12345678 --workspace "https://workspace.slack.com" | jq .
agent-slack user get "@alice" --workspace "https://workspace.slack.com" | jq .
```

### Fetch a Canvas as Markdown

```bash
agent-slack canvas get "https://workspace.slack.com/docs/T123/F456"
agent-slack canvas get "F456" --workspace "https://workspace.slack.com"
```

## Developing / Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

<p align="center">
  <a href="https://stably.ai">
    <img src="https://public-artifacts.stably.ai/logo-white-with-bg.png" height="96" alt="Stably">
  </a>
</p>

<h3 align="center">
  <a href="https://stably.ai">Stably</a>
</h3>

<p align="center">
  Code. Ship. <s>Test.</s>
</p>

<p align="center">
  <a href="https://docs.stably.ai/"><strong>Documentation</strong></a> ·
  <a href="https://stably.ai/"><strong>Homepage</strong></a>
</p>
<br/>
