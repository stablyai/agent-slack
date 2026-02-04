# agent-slack

Slack automation CLI for AI agents (TypeScript + Bun).

Guiding principle: 
  * **token-efficient output by default** (compact JSON, minimal duplication, and empty/null fields pruned) so LLMs can consume results cheaply.
  * **zero-config auth** -- Auth just works if you have the Slack Desktop (with fallbacks available)

## At a glance

- **Read**: fetch a message, detect threads, list full threads
- **Search**: messages + files (with filters)
- **Artifacts**: auto-download snippets/images/files to local paths for agents
- **Write**: reply in thread, add reactions
- **Canvas**: fetch Slack canvases as Markdown

## Command map (high level)

```text
agent-slack
  auth
    status
    import-desktop
    import-chrome
    parse-curl

  msg
    get   <target>    # default: agent-slack msg <target>
    list  <target>    # full thread for a message/thread

  thread <slack-url>  # alias for: msg list <slack-url>

  search
    all      <query>  # default: search all
    messages <query>
    files    <query>

  canvas
    get <canvas-url-or-id>   # default: canvas get

  reply <slack-url> <text>
  react <slack-url> <emoji>
  doctor
```

Notes:
- Output is **always JSON** and aggressively pruned (`null`/empty fields removed).
- Attached files are auto-downloaded and returned as absolute local paths.

## Installation

```bash
# Quick install (downloads a native executable)
curl -fsSL https://raw.githubusercontent.com/nwparker/agent-slack/main/install.sh | sh

# Package managers (downloads a native executable during install)
npm install -g agent-slack
pnpm add -g agent-slack
bun add -g agent-slack
```

Run via:

```bash
agent-slack --help
```

For local development:

```bash
bun install
bun run dev -- --help
node ./bin/agent-slack.cjs --help
bun ./bin/agent-slack.bun.js --help
```

## Authentication (no fancy setup)

On macOS, authentication happens automatically:

- Default: reads Slack Desktop local data (no need to quit Slack)
- Fallback: if that fails, tries Chrome extraction (if Slack is open in Chrome)

You can also run manual imports:

```bash
agent-slack auth import-desktop
agent-slack auth import-chrome
agent-slack doctor
```

Alternatively, set env vars:

```bash
export SLACK_TOKEN="xoxc-..."      # browser token
export SLACK_COOKIE_D="xoxd-..."   # cookie d
agent-slack doctor
```

Or use a standard Slack token (xoxb/xoxp):

```bash
export SLACK_TOKEN="xoxb-..."
agent-slack doctor
```

## Read messages / threads

```bash
# Single message (+ thread summary if threaded)
agent-slack msg "https://workspace.slack.com/archives/C123/p1700000000000000"

# Full thread for a message
agent-slack msg list "https://workspace.slack.com/archives/C123/p1700000000000000"
```

### Targets: URL or channel

`msg get` / `msg list` accept either a Slack message URL or a channel reference:

- URL: `https://workspace.slack.com/archives/<channel>/p<digits>[?thread_ts=...]`
- Channel: `#general` (or bare `general`) or a channel ID like `C0123...`

Examples:

```bash
# Get a single message by channel + ts
agent-slack msg get "#general" --ts "1770165109.628379"

# List a full thread by channel + thread root ts
agent-slack msg list "#general" --thread-ts "1770165109.000001"
```

If you have multiple workspaces configured and you use a channel **name** (`#channel` / `channel`), you must pass `--workspace` (or set `SLACK_WORKSPACE_URL`):

```bash
agent-slack msg get "#general" --workspace "https://stablygroup.slack.com" --ts "1770165109.628379"
```

## Files (snippets/images/attachments)

`msg` auto-downloads attached files to an agent-friendly temp directory and returns absolute paths in `message.files[].path`:

- macOS default: `~/.agent-slack/tmp/downloads/`

Agents can read those paths directly (e.g. snippets as `.txt`, images as `.png`).

## Codex skill

This repo ships a Codex skill at `skills/agent-slack/SKILL.md` (install via your skill installer workflow).

## Fetch a Canvas as Markdown

```bash
agent-slack canvas get "https://workspace.slack.com/docs/T123/F456"
agent-slack canvas get "F456" --workspace "https://workspace.slack.com"
```

## Search (messages + files)

```bash
# Search both messages and files
agent-slack search all "smoke tests failed" --channel "#alerts" --after 2026-01-01 --before 2026-02-01

# Search messages only
agent-slack search messages "kernel vm" --user "@nwparker" --channel general

# Search files only (downloads files and returns local paths)
agent-slack search files "playwright" --content-type snippet --limit 10
```

Tips:
- For reliable results, include `--channel ...` (channel-scoped search scans history/files and filters locally).
- Use `--workspace https://...slack.com` when using `#channel` names across multiple workspaces.
