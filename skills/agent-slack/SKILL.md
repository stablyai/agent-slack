---
name: agent-slack
description: |
  Slack automation CLI for AI agents. Use when:
  - Reading a Slack message or thread (given a URL or channel+ts)
  - Browsing recent channel messages / channel history
  - Downloading Slack attachments (snippets, images, files) to local paths
  - Searching Slack messages or files
  - Sending a reply or adding/removing a reaction
  - Fetching a Slack canvas as markdown
  - Looking up Slack users
  Triggers: "slack message", "slack thread", "slack URL", "slack link", "read slack", "reply on slack", "search slack", "channel history", "recent messages", "channel messages", "latest messages"
---

# agent-slack

Slack automation CLI for AI agents. Read messages, search, reply, download attachments, fetch canvases.

> Output is always JSON. Attached files are auto-downloaded and returned as absolute local paths.

## Install

Recommended (Bun install script):

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/master/install.sh | sh
```

OR npm global install (requires Node >= 22.5):

```bash
npm i -g agent-slack
```

## First time setup

Authentication is automatic on macOS (Slack Desktop first, then Chrome fallback).

```bash
agent-slack auth import-desktop          # Import creds from Slack Desktop (macOS, default)
agent-slack auth test                    # Verify credentials work
agent-slack auth whoami                  # Show configured workspaces
```

Fallback auth methods:

```bash
agent-slack auth import-chrome           # Import from Chrome (macOS)
agent-slack auth parse-curl              # Paste a Slack cURL from browser DevTools (stdin)
agent-slack auth add --workspace-url "https://team.slack.com" --token "xoxb-..."  # Manual token
```

Or set env vars (no import needed):

```bash
export SLACK_TOKEN="xoxc-..."            # Browser token (xoxc) or bot/user token (xoxb/xoxp)
export SLACK_COOKIE_D="xoxd-..."         # Required with xoxc tokens
```

## Quick start

```bash
agent-slack message get "<slack-message-url>"                    # Fetch a single message
agent-slack message list "<slack-message-url>"                   # Fetch full thread
agent-slack message list "#general" --limit 20                   # Browse recent channel messages
agent-slack message send "<slack-message-url>" "Got it!"         # Reply in thread
agent-slack search all "deploy failed" --channel "#alerts"       # Search messages + files
```

## Multi-workspace

When using channel **names** with multiple workspaces, pass `--workspace` (full URL or unique substring):

```bash
agent-slack message get "#general" --workspace "myteam" --ts "1770165109.628379"
agent-slack message get "#general" --workspace "https://myteam.slack.com" --ts "1770165109.628379"
```

Or set the env var instead: `export SLACK_WORKSPACE_URL="myteam"`

Channel IDs (`C...`/`G...`/`D...`) are unambiguous and never need `--workspace`.

## Commands

```bash
# ── Auth ──────────────────────────────────────────────────────────────────────
agent-slack auth whoami                                                          # Show workspaces + token sources
agent-slack auth test                                                            # Verify credentials
agent-slack auth test --workspace "myteam"                                       # Test specific workspace
agent-slack auth import-desktop                                                  # Import from Slack Desktop (macOS)
agent-slack auth import-chrome                                                   # Import from Chrome (macOS)
agent-slack auth parse-curl                                                      # Import from pasted cURL (stdin)
agent-slack auth add --workspace-url <url> --token <xoxb/xoxp>                   # Add bot/user token
agent-slack auth add --workspace-url <url> --xoxc <xoxc> --xoxd <xoxd>          # Add browser creds
agent-slack auth set-default <workspace-url>                                     # Set default workspace
agent-slack auth remove <workspace-url>                                          # Remove workspace creds

# ── Messages ──────────────────────────────────────────────────────────────────
agent-slack message get "<url>"                                                  # Fetch single message (+ thread summary)
agent-slack message get "#channel" --ts "1770165109.628379"                       # Fetch by channel + timestamp
agent-slack message get "<url>" --include-reactions                               # Include reaction details
agent-slack message get "<url>" --max-body-chars -1                               # Full body, no truncation (default: 8000)
agent-slack message get "<url>" --thread-ts "1770165109.000001"                   # Hint for thread permalink resolution
agent-slack message get "#channel" --workspace "myteam" --ts "1770165109.628379"  # Disambiguate workspace

agent-slack message list "<url>"                                                 # All replies in a thread
agent-slack message list "#channel"                                              # Latest 25 channel messages
agent-slack message list "#channel" --limit 50                                   # Latest 50 messages
agent-slack message list "#channel" --thread-ts "1770165109.000001"              # Thread replies by ts
agent-slack message list "#channel" --ts "1770165109.628379"                      # Resolve message to its thread
agent-slack message list "#channel" --oldest "1770000000.000000"                 # Messages after timestamp
agent-slack message list "#channel" --latest "1770999999.000000"                 # Messages before timestamp
agent-slack message list "#channel" --include-reactions                           # Include reactions on each message
agent-slack message list "<url>" --max-body-chars -1                              # Full body, no truncation (default: 8000)

agent-slack message send "<url>" "reply text"                                    # Reply in thread
agent-slack message send "#channel" "hello"                                      # Post to channel
agent-slack message send "#channel" "reply" --thread-ts "1770165109.000001"      # Reply by ts

agent-slack message react add "<url>" "eyes"                                     # Add reaction
agent-slack message react remove "<url>" "eyes"                                  # Remove reaction
agent-slack message react add "#channel" "thumbsup" --ts "1770165109.628379"     # React by channel + ts

# ── Search ────────────────────────────────────────────────────────────────────
agent-slack search all "query"                                                   # Search messages + files
agent-slack search messages "query"                                              # Search messages only
agent-slack search files "query"                                                 # Search files only
agent-slack search all "query" --channel "#alerts"                               # Scope to channel (repeatable)
agent-slack search all "query" --user "@alice"                                   # Filter by user
agent-slack search all "query" --after 2026-01-01 --before 2026-02-01            # Date range
agent-slack search files "query" --content-type snippet                          # Filter: text|image|snippet|file
agent-slack search messages "query" --limit 50                                   # Limit results
agent-slack search messages "query" --max-content-chars -1                       # Full content, no truncation (default: 4000)

# ── Canvas ────────────────────────────────────────────────────────────────────
agent-slack canvas get "<canvas-url>"                                            # Fetch canvas as markdown
agent-slack canvas get "F456" --workspace "myteam"                               # Fetch by canvas ID
agent-slack canvas get "<canvas-url>" --max-chars -1                             # Full content, no truncation (default: 20000)

# ── Users ─────────────────────────────────────────────────────────────────────
agent-slack user list --workspace "myteam"                                       # List workspace users
agent-slack user list --workspace "myteam" --limit 100                           # Limit results
agent-slack user list --workspace "myteam" --include-bots                        # Include bot users
agent-slack user list --workspace "myteam" --cursor "<cursor>"                   # Paginate (cursor from previous response)
agent-slack user get "@alice" --workspace "myteam"                               # Get user by handle
agent-slack user get "U12345678"                                                 # Get user by ID
```

## Targets

`<target>` in commands above accepts:

- **Slack URL** (preferred): `https://<workspace>.slack.com/archives/<channel_id>/p<digits>[?thread_ts=...]`
- **Channel name**: `#general` or `general` (needs `--workspace` with multiple workspaces)
- **Channel ID**: `C...` (channels), `G...` (groups), `D...` (DMs) -- unambiguous, no `--workspace` needed

When using a channel target, `--ts` is required for `message get` and `react`. For `message list`, omit `--ts`/`--thread-ts` to get channel history instead of a thread.

## Output

All commands print JSON to stdout. Empty values (`null`, `[]`, `{}`) are pruned.

- `message get` returns `{ message: {...}, thread?: { ts, length } }` -- thread is a summary, not full replies
- `message list` returns `{ messages: [...] }` -- full thread replies or channel history
- `search messages|all` returns `{ messages: [...] }`, `search files|all` returns `{ files: [...] }`
- Attachments are auto-downloaded to `~/.agent-slack/tmp/downloads/` (or `$XDG_RUNTIME_DIR/agent-slack/tmp/downloads/`) and returned as absolute paths in `files[].path`
