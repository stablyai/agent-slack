# `agent-slack` command map (reference)

Run `agent-slack --help` (or `agent-slack <command> --help`) for the full option list.

## Auth

- `agent-slack auth whoami` — show configured workspaces + token sources (secrets redacted)
- `agent-slack auth test [--workspace <url>]` — verify credentials (`auth.test`)
- `agent-slack auth import-desktop` — import browser-style creds from Slack Desktop (macOS)
- `agent-slack auth import-chrome` — import creds from Chrome (macOS)
- `agent-slack auth parse-curl` — read a copied Slack cURL command from stdin and save creds
- `agent-slack auth add --workspace-url <url> [--token <xoxb/xoxp> | --xoxc <xoxc> --xoxd <xoxd>]`
- `agent-slack auth set-default <workspace-url>`
- `agent-slack auth remove <workspace-url>`

## Messages / threads

- `agent-slack message get <target>`
  - `<target>`: Slack message URL OR `#channel`/`channel`/channel id (`C...`) (see `targets.md`)
  - Options:
    - `--workspace <url>` (required when using a channel _name_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required when targeting a channel)
    - `--thread-ts <seconds>.<micros>` (optional hint for thread permalinks)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`

- `agent-slack message list <target>`
  - Fetches the full thread
  - Options:
    - `--workspace <url>` (same rules as above)
    - `--thread-ts <seconds>.<micros>` (required for channel targets unless you pass `--ts`)
    - `--ts <seconds>.<micros>` (optional: resolve a message to its thread)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`

- `agent-slack message send <target> <text>`
  - If `<target>` is a Slack message URL, replies in that message’s thread.
  - Otherwise posts to the channel/DM.
  - Options:
    - `--workspace <url>` (needed for channel _names_ across multiple workspaces)
    - `--thread-ts <seconds>.<micros>` (optional, channel mode only)

- `agent-slack message react add <target> <emoji>`
- `agent-slack message react remove <target> <emoji>`
  - Options (channel mode):
    - `--workspace <url>` (needed for channel _names_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

## Search

- `agent-slack search all <query>` — messages + files (default)
- `agent-slack search messages <query>`
- `agent-slack search files <query>`

Common options:

- `--workspace <url>` (recommended when using channel names across multiple workspaces)
- `--channel <channel...>` repeatable (`#name`, `name`, or id)
- `--user <@name|name|U...>`
- `--after YYYY-MM-DD`
- `--before YYYY-MM-DD`
- `--content-type any|text|image|snippet|file`
- `--limit <n>` (default `20`)
- `--max-content-chars <n>` (default `4000`, `-1` unlimited; messages only)

## Canvas

- `agent-slack canvas get <canvas-url-or-id>`
  - Options:
    - `--workspace <url>` (required when passing an id and multiple workspaces)
    - `--max-chars <n>` (default `20000`, `-1` unlimited)

## Users

- `agent-slack user list [--workspace <url>] [--limit <n>] [--cursor <cursor>] [--include-bots]`
- `agent-slack user get <U...|@handle|handle> [--workspace <url>]`

## Channels / conversations

- `agent-slack channel list [--workspace <url>] [--user <U...|@handle|handle>] [--all] [--limit <n>] [--cursor <cursor>]`
  - Default mode calls `users.conversations` for the current authed user
  - `--user` resolves the user and calls `users.conversations` for that user
  - `--all` calls `conversations.list`
  - Returns one API page per call (caller paginates with `--cursor` / `next_cursor`)
  - `--limit` defaults to `100`; practical minimum is `10`
  - `--all` and `--user` are incompatible (hard error)
  - Always sets `exclude_archived=true`
  - Includes all conversation types: `public_channel,private_channel,im,mpim`
