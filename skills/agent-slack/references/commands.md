# `agent-slack` command map (reference)

Run `agent-slack --help` (or `agent-slack <command> --help`) for the full option list.

## Auth

- `agent-slack auth whoami` — show configured workspaces + token sources (secrets redacted)
- `agent-slack auth test [--workspace <url-or-unique-substring>]` — verify credentials (`auth.test`)
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
    - `--workspace <url-or-unique-substring>` (required when using a channel _name_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required when targeting a channel)
    - `--thread-ts <seconds>.<micros>` (optional hint for thread permalinks)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`

- `agent-slack message list <target>`
  - Lists recent channel messages (channel history), or fetches all thread replies
  - **Channel history** (default when targeting a channel without `--thread-ts`):
    - `agent-slack message list "#general"` — latest 25 messages
    - `agent-slack message list "#general" --limit 50` — latest 50 messages
  - **Thread mode** (when `--thread-ts` or `--ts` is provided, or target is a message URL):
    - `agent-slack message list "<url>"` — all replies in that thread
    - `agent-slack message list "#general" --thread-ts "1770165109.000001"` — thread replies
  - Options:
    - `--workspace <url-or-unique-substring>` (same rules as above)
    - `--thread-ts <seconds>.<micros>` (switches to thread mode; fetches replies)
    - `--ts <seconds>.<micros>` (resolve a message to its thread)
    - `--limit <n>` (default `25`, max `200`; channel history mode only)
    - `--oldest <ts>` (only messages after this ts; channel history mode)
    - `--latest <ts>` (only messages before this ts; channel history mode)
    - `--with-reaction <emoji>` (repeatable; include only messages that have this reaction; channel history mode; requires `--oldest`)
    - `--without-reaction <emoji>` (repeatable; include only messages that do not have this reaction; channel history mode; requires `--oldest`)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`

- `agent-slack message draft <target> [text]`
  - Opens a Slack-like WYSIWYG editor in the browser for composing and sending a message.
  - Formatting toolbar: bold, italic, strikethrough, links, numbered/bulleted lists, quotes, inline code, code blocks.
  - Toggle between rich-text editing and raw mrkdwn source view.
  - After sending, shows a "View in Slack" permalink to the posted message.
  - If `<target>` is a Slack message URL, the draft will reply in that thread.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel _names_ across multiple workspaces)
    - `--thread-ts <seconds>.<micros>` (optional, channel mode only)

- `agent-slack message send <target> <text>`
  - If `<target>` is a Slack message URL, replies in that message’s thread.
  - Otherwise posts to the channel/DM.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel _names_ across multiple workspaces)
    - `--thread-ts <seconds>.<micros>` (optional, channel mode only)

- `agent-slack message edit <target> <text>`
  - URL target edits that exact message.
  - Channel target requires `--ts`.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel _names_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

- `agent-slack message delete <target>`
  - URL target deletes that exact message.
  - Channel target requires `--ts`.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel _names_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

- `agent-slack message react add <target> <emoji>`
- `agent-slack message react remove <target> <emoji>`
  - Options (channel mode):
    - `--workspace <url-or-unique-substring>` (needed for channel _names_ across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

## Channels

- `agent-slack channel list [--workspace <url-or-unique-substring>] [--user <U...|@handle|handle> | --all] [--limit <n>] [--cursor <cursor>]`
  - Default mode calls `users.conversations` for the current user.
  - `--user` resolves handles/ids and lists conversations for that user.
  - `--all` switches to `conversations.list` (mutually exclusive with `--user`).
  - Returns one page and optional `next_cursor`; pass `--cursor` to continue.
- `agent-slack channel new --name <name> [--private] [--workspace <url-or-unique-substring>]`
- `agent-slack channel invite --channel <id|name> --users "<U...,@handle,email,...>" [--workspace <url-or-unique-substring>]`
  - Internal invite (default): resolves users (`U...`, `@handle`, `handle`, `email`) and uses `conversations.invite`
  - External invite: add `--external` (email targets only) to use `conversations.inviteShared`
  - Optional: `--allow-external-user-invites` sets `external_limited=false` for external invites

## Search

- `agent-slack search all <query>` — messages + files (default)
- `agent-slack search messages <query>`
- `agent-slack search files <query>`

Common options:

- `--workspace <url-or-unique-substring>` (recommended when using channel names across multiple workspaces)
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
    - `--workspace <url-or-unique-substring>` (required when passing an id and multiple workspaces)
    - `--max-chars <n>` (default `20000`, `-1` unlimited)

## Users

- `agent-slack user list [--workspace <url-or-unique-substring>] [--limit <n>] [--cursor <cursor>] [--include-bots]`
- `agent-slack user get <U...|@handle|handle> [--workspace <url-or-unique-substring>]`
