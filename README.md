# agent-slack

Slack automation CLI for AI agents (TypeScript + Bun).

Guiding principle:

- **Token-efficient** — (compact JSON, minimal duplication, and empty/null fields pruned) so LLMs can consume results cheaply.
- **Zero-config auth** — Auth just works if you have Slack Desktop (with fallbacks available). No Python dependency.
- **Human-in-the-loop** — When appropriate (not in CI environments), loop humans in. Ex: `message compose`
  <img width="1228" height="741" alt="image" src="https://github.com/user-attachments/assets/92ecbb71-18ca-4516-a874-c83c154b0709" />

## Getting started

Install via Bun (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/main/install.sh | sh
```

OR npm global install (requires Node >= 22.5):

```bash
npm i -g agent-slack
```

OR run via Nix flake:

```bash
nix run github:stablyai/agent-slack
```

## At a glance

- **Read**: fetch a message, browse channel history, list full threads
- **Search**: messages + files (with filters)
- **Artifacts**: auto-download snippets/images/files to local paths for agents
- **Write**: send now or schedule delivery, edit/delete messages, add reactions (bullet lists auto-render as native Slack rich text)
- **Compose & drafts**: open a browser editor (`message compose`), or manage Slack-native drafts that show up in your Slack client (`message draft`)
- **Channels**: list conversations, create channels, and invite users by id/handle/email
- **Canvas**: create Slack canvases from Markdown and fetch them as Markdown

## Agent skill

This repo ships an agent skill at `skills/agent-slack/` compatible with Claude Code, Codex, Cursor, etc

Treat the installed CLI's `agent-slack --help` and `agent-slack <command> --help` output as authoritative for supported commands and flags.

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
├── update                         # self-update (detects npm/bun/binary)
├── auth
│   ├── whoami
│   ├── test
│   ├── import-desktop
│   ├── import-brave
│   ├── import-chrome
│   ├── import-firefox
│   └── parse-curl
├── message
│   ├── get   <target>             # fetch 1 message (+ thread meta )
│   ├── list  <target>             # fetch thread or recent channel messages
│   ├── send  <target> [text]      # send / reply / schedule (supports --attach, --blocks)
│   ├── scheduled
│   │   ├── list                   # list pending scheduled messages
│   │   └── cancel <id>            # cancel a pending scheduled message
│   ├── compose <target> [text]    # open Slack-like editor in browser
│   ├── draft                      # Slack-native drafts (appear in your Slack client)
│   │   ├── list                   # list Slack-native drafts
│   │   ├── create <target> <text> # create a Slack-native draft
│   │   ├── update <id> <text>     # replace a draft's text
│   │   └── delete <id>            # delete a draft
│   ├── edit  <target> <text>      # edit a message
│   ├── delete <target>            # delete a message
│   └── react
│       ├── add    <target> <emoji>
│       └── remove <target> <emoji>
├── channel
│   ├── list                        # list conversations (user-scoped or all)
│   ├── new                         # create channel
│   └── invite                      # invite users to channel
├── user
│   ├── list
│   └── get <user>
├── search
│   ├── all      <query>           # messages + files
│   ├── messages <query>
│   └── files    <query>
├── workflow
│   ├── list    <channel>          # workflows bookmarked in a channel
│   ├── preview <trigger-id>       # trigger metadata (no side effects)
│   ├── get     <id>               # workflow definition + form fields
│   └── run     <trigger-id>       # trip a workflow trigger
└── canvas
    ├── create                     # markdown file/blob → canvas
    └── get <canvas-url-or-id>     # canvas → markdown
```

Notes:

- Slack data commands output aggressively pruned JSON (`null`/empty fields removed); help, update, and some authentication setup commands output text.
- Attached files are auto-downloaded and returned as absolute local paths.

## Authentication (no fancy setup)

On macOS and Windows, authentication happens automatically:

- Default: reads Slack Desktop local data (no need to quit Slack)
- Fallbacks: if that fails, tries Chrome/Brave/Firefox extraction (macOS)

You can also run manual imports:

```bash
agent-slack auth whoami
agent-slack auth import-desktop
agent-slack auth import-brave
agent-slack auth import-chrome
agent-slack auth import-firefox
agent-slack auth test
```

> [!NOTE]
> `import-brave` / `import-chrome` read tokens from a logged-in Slack tab via AppleScript. Both browsers ship with **Allow JavaScript from Apple Events** disabled by default — enable it in **View → Developer** before running these commands. macOS will prompt for your password the first time.

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
agent-slack message list "#general" --with-reaction eyes --oldest "1770165109.000000" --limit 20

# Recent channel messages that do not have :dart:
agent-slack message list "#general" --without-reaction dart --oldest "1770165109.000000" --limit 20
```

Optional:

```bash
# Include reactions + which users reacted
agent-slack message get "https://workspace.slack.com/archives/C123/p1700000000000000" --include-reactions
```

### Compose a message (browser editor)

Opens a Slack-like WYSIWYG editor in your browser for composing messages with full formatting support (bold, italic, strikethrough, links, lists, quotes, code, code blocks).

```bash
# Open editor for a channel
agent-slack message compose "#general"

# Open editor with initial text
agent-slack message compose "#general" "Here's my update"

# Reply in a thread
agent-slack message compose "https://workspace.slack.com/archives/C123/p1700000000000000"
```

After sending, the editor shows a "View in Slack" link to the posted message.

`message compose` is send-capable. In CI, it skips the browser editor and immediately sends supplied text; do not use it for a compose-only request in a noninteractive environment.

### Slack-native drafts

Manage drafts through Slack's own drafts API, so they show up natively in the user's Slack client (mobile and desktop) ready to review and send. Requires browser-style auth (xoxc/xoxd).

> [!NOTE]
> These commands use Slack's **undocumented** internal `drafts.*` client endpoints (the same ones the Slack app uses), authenticated with your own browser session. They act only as you, on your own drafts — nothing is exposed that you can't already see, and `create` posts nothing. But because the endpoints are unsupported: their behavior may change without notice, and on **Enterprise Grid** this style of session-token API use can be flagged by Slack's security/anomaly detection. This is the same auth model the rest of agent-slack already uses (`later`, `unreads`, `search`); use it where that's acceptable.

```bash
# List unsent drafts
agent-slack message draft list

# Draft a message to a channel (shows up in Slack's Drafts section)
agent-slack message draft create "#general" "Here's my update"

# Draft a thread reply
agent-slack message draft create "https://workspace.slack.com/archives/C123/p1700000000000000" "Looking into it"

# Replace a draft's text, or delete it
agent-slack message draft update "DR_ID" "Here's my revised update"
agent-slack message draft delete "DR_ID"
```

### Safe mode (enforced human-in-the-loop)

Skill instructions like "always use `draft`, never `send`" are guidance an agent can ignore. Safe mode enforces it at the tool level — useful when an AI agent has access to `agent-slack` and you want a guarantee that nothing posts without human review.

```bash
# Env var (recommended for agent environments)
export AGENT_SLACK_SAFE_MODE=1

# Or a global CLI flag
agent-slack --safe-mode message send "#general" "hello"
```

While safe mode is active:

- `message send` → redirected to the draft editor with the text pre-filled; you review and send from the browser. The output includes `"safe_mode": true` and `"redirected_from": "send"`, and a warning is printed to stderr. Flags the editor cannot represent (`--attach`, `--blocks`, `--schedule`, `--schedule-in`, `--reply-broadcast`) are rejected with an error instead of being silently dropped.
- `message edit` and `message delete` → blocked with an error.
- All read operations (`get`, `list`, `search`, etc.) and reactions are unchanged.

The env var accepts `1`, `true`, `yes`, or `on` (case-insensitive); anything else leaves safe mode off.

### Reply, edit, delete, and react

```bash
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "I can take this."
agent-slack message send "#alerts-staging" "here's the report" --attach ./report.md
agent-slack message send "#announcements" "Deploy starts at 6pm." --schedule "<future-iso-with-timezone>"
agent-slack message send "U05BRPTKL6A" "Heads up before standup" --schedule-in "monday 9am"
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

`message edit` and ordinary `message send` calls convert bullet/numbered lists to Slack native rich text. `message send --blocks` uses the supplied blocks instead, while `message send --attach` sends its initial comment as plain text without automatic list conversion. Inside auto-converted lists, inline mentions, broadcasts, emoji shortcodes, `<#C...>` channel references, and Slack manual links such as `<https://example.com/pull/42|PR #42>` are preserved as Slack elements. CommonMark links such as `[PR #42](https://example.com/pull/42)` are not converted into labeled link elements.

Send options for `message send`:

- `--attach <path>` upload a local file (repeatable; `<text>` is optional when attaching files)
- `--blocks <path>` send raw [Block Kit](https://docs.slack.dev/block-kit/) blocks from a JSON file (or `-` for stdin). Bypasses the automatic markdown-to-rich-text conversion, unlocking header/divider/section/table blocks and other structured layouts. Cannot be combined with `--attach`.
- `--reply-broadcast` when replying in a thread, also post the reply to the parent channel (Slack's "Also send to #channel" checkbox). For channel targets, pair with `--thread-ts`; for URL targets, the thread context is derived from the message. Not supported for DM targets; cannot be combined with `--attach`.
- `--schedule <time>` schedule delivery at an ISO 8601 timestamp with explicit timezone (for example `YYYY-MM-DDTHH:mm:ss-07:00`) or a Unix timestamp. The timestamp must be in the future and within Slack's 120-day scheduled-send limit. Works with `--blocks`, `--thread-ts`, and `--reply-broadcast`; cannot be combined with `--attach`.
- `--schedule-in <duration>` schedule delivery after a duration or simple future phrase (`30m`, `3h`, `2d`, `tomorrow 9am`, `monday 9am`; phrases use your local timezone). Mutually exclusive with `--schedule`; cannot be combined with `--attach`.

Upload files through `message send`:

```bash
agent-slack message send "#general" "Coverage report" --attach ./report.md
```

Broadcast a thread reply to the parent channel:

```bash
agent-slack message send "#general" "Decision: shipping v2 today" \
  --thread-ts "1770160000.000001" --reply-broadcast
```

Scheduled sends use Slack's server-side scheduled message queue:

```bash
# Absolute time with explicit timezone; replace with a future value within 120 days
agent-slack message send "#general" "Reminder: deploy starts soon." \
  --schedule "<future-iso-with-timezone>"

# Relative / natural future time
agent-slack message send "#general" "Monday launch checklist" --schedule-in "monday 9am"

# Scheduled thread reply with a Block Kit payload
agent-slack message send "#general" "fallback text" \
  --thread-ts "1770160000.000001" --blocks /tmp/blocks.json --schedule-in "3h"
```

Manage pending scheduled messages:

```bash
agent-slack message scheduled list
agent-slack message scheduled list --channel "#general" --limit 25
agent-slack message scheduled cancel "Q1234ABCD" --channel "C12345678"
```

Example — post a message with a native Slack table block:

```bash
cat > /tmp/blocks.json <<'EOF'
[
  {
    "type": "header",
    "text": { "type": "plain_text", "text": "Weekly digest" }
  },
  {
    "type": "table",
    "rows": [
      [
        { "type": "raw_text", "text": "Name" },
        { "type": "raw_text", "text": "Why" }
      ],
      [
        { "type": "raw_text", "text": "Caveman MCP" },
        { "type": "raw_text", "text": "~80% token cut on nav" }
      ]
    ]
  }
]
EOF
agent-slack message send "#alerts-staging" --blocks /tmp/blocks.json
```

When `--blocks` is used, the positional `<text>` argument (if provided) is still sent as the message's `text` fallback (for notifications and unfurls).

`message send` returns `channel_id` plus the posted `ts` and a `permalink` (for non-attachment sends). `thread_ts` appears only when replying in a thread. Scheduled sends return `scheduled_message_id` and `post_at` instead of `ts`/`permalink`.

### List, create, and invite channels

```bash
# List conversations for current user (users.conversations)
agent-slack channel list

# List conversations for a specific user
agent-slack channel list --user "@alice" --limit 50

# List all workspace conversations (conversations.list)
agent-slack channel list --all --limit 100

# Create a public channel
agent-slack channel new --name "incident-war-room"

# Create a private channel
agent-slack channel new --name "incident-leads" --private

# Invite users by id, handle, or email
agent-slack channel invite --channel "incident-war-room" --users "U01234567,@alice,bob@example.com"

# Invite external Slack Connect users by email (restricted by default)
agent-slack channel invite --channel "incident-war-room" --users "partner@vendor.com" --external

# External invite with permission for invitees to invite others
agent-slack channel invite --channel "incident-war-room" --users "partner@vendor.com" --external --allow-external-user-invites
```

Notes:

- `channel list` returns a single page plus `next_cursor`; use `--cursor` to fetch the next page.
- `channel list --all` and `channel list --user` are mutually exclusive.
- `--external` maps to `conversations.inviteShared` and expects email targets.
- External invites default to restricted mode (`external_limited=true`); add `--allow-external-user-invites` to disable that restriction.
- External invites require Slack Connect permissions/scopes in your workspace.

### Message get vs list

**`message get`** fetches a single message. If the message is in a thread, it also returns thread metadata (reply count, participants) but **not** the full thread contents:

```json
{
  "message": { "ts": "...", "text": "...", "user": "U123", ... },
  "thread": { "ts": "...", "length": 6 }
}
```

**`message list`** fetches the thread root plus all replies, or recent channel messages when no thread is specified. Use this when you need the full conversation:

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
- Use `list` with `--with-reaction` / `--without-reaction` plus `--oldest` to filter channel history by reaction markers

### Files (snippets/images/attachments)

`message get/list` auto-download attached files to an agent-friendly temp directory and return file metadata in `message.files[]`, including `name` when Slack provides the original filename and `path` for the local download. Failed downloads keep the attachment entry, preserve `message.files[].path` with a local `.download-error.txt` file, and include `message.files[].error`. `search messages` and `search all` use the same attachment shape for message results, while `search files` skips entries whose download fails. Use `search messages --content-type file` when you also need the source-message permalink for a reply.

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

Treat Slack user IDs beginning with `U` or `W` equivalently.

```bash
# List users (email requires appropriate Slack scopes; fields are pruned if missing)
agent-slack user list --workspace "https://workspace.slack.com" --limit 200 | jq .

# Get one user by id or handle
agent-slack user get U12345678 --workspace "https://workspace.slack.com" | jq .
agent-slack user get "@alice" --workspace "https://workspace.slack.com" | jq .

# Open a DM or group DM with one to eight other users (the caller is implicit)
agent-slack user dm-open "@alice" "@bob" --workspace "https://workspace.slack.com" | jq .
```

### Unreads (inbox view)

See all unread messages across channels, DMs, and threads in one place:

```bash
# Show all unreads with message content
agent-slack unreads

# Show only unread counts (no message content)
agent-slack unreads --counts-only

# Limit messages per channel (default 10)
agent-slack unreads --max-messages 5

# Include system messages (joins, leaves, topic changes)
agent-slack unreads --include-system
```

Output includes channels sorted by mention count, then unread count:

```json
{
  "channels": [
    {
      "channel_id": "C123...",
      "channel_name": "general",
      "channel_type": "channel",
      "unread_count": 5,
      "mention_count": 2,
      "messages": [...]
    }
  ],
  "threads": {
    "has_unreads": true,
    "mention_count": 3
  }
}
```

Note: This feature uses the `client.counts` API which may be restricted in some Enterprise Grid workspaces (`team_is_restricted` error).

### Later (saved messages)

Manage your saved-for-later messages (Slack's Later tab):

```bash
# List saved messages (in-progress by default)
agent-slack later list

# Show only counts per state
agent-slack later list --counts-only

# Filter by state: in_progress, completed, archived, all
agent-slack later list --state completed

# Save a message for later
agent-slack later save "https://workspace.slack.com/archives/C123/p1700000000000000"

# Mark as completed
agent-slack later complete "https://workspace.slack.com/archives/C123/p1700000000000000"

# Archive
agent-slack later archive "https://workspace.slack.com/archives/C123/p1700000000000000"

# Move back to in-progress
agent-slack later reopen "https://workspace.slack.com/archives/C123/p1700000000000000"

# Remove from saved
agent-slack later remove "https://workspace.slack.com/archives/C123/p1700000000000000"

# Set a reminder
agent-slack later remind "https://workspace.slack.com/archives/C123/p1700000000000000" --in 1h
agent-slack later remind "https://workspace.slack.com/archives/C123/p1700000000000000" --in tomorrow
```

Named reminder days such as `tomorrow` and `monday` mean 9:00 in the CLI process's local timezone. Use a Unix timestamp when timezone precision matters.

### Create or fetch a Canvas as Markdown

```bash
# Create from a local Markdown file
agent-slack canvas create --file ./launch-plan.md --title "Launch plan"

# Create from an inline Markdown blob
agent-slack canvas create --markdown $'# Launch plan\n\n- [ ] Ship it' --title "Launch plan"

# Add the new canvas as a channel tab (required on free Slack plans)
agent-slack canvas create --file ./launch-plan.md --channel "project-launch"

# Fetch an existing canvas as Markdown
agent-slack canvas get "https://workspace.slack.com/docs/T123/F456"
agent-slack canvas get "F456" --workspace "https://workspace.slack.com"
```

`canvas create` requires exactly one of `--file <path>` or `--markdown <text>`. Use
`--workspace <url-or-unique-substring>` to select a workspace when needed. The command returns
`canvas: { id, title?, channel_id? }`. Imported browser credentials can create standalone
canvases; `--channel` requires a standard Slack token with Slack's `canvases:write` scope.

## Developing / Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Check out our other OSS project

[Orca](https://github.com/stablyai/orca) - ADE for 100x builders
