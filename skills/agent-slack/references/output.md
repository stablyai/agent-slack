# Output + downloads (reference)

## Output format

All commands print JSON to stdout.

- Empty values are pruned (`null`, `[]`, `{}` are removed where possible).
- `auth whoami` redacts secrets in its output.

## Message shapes (high-level)

- `message get` returns:
  - `message: { ... }`
  - `thread?: { ts, length }` (summary only; present when threaded)
  - `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`

- `message list` returns:
  - `messages: [ ... ]` (the full thread)
  - `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`
  - Messages are compact and omit redundant fields on each item where possible.

- `message send` returns:
  - `ok: true`
  - `channel_id: "C..." | "D..."`
  - `ts?: "<seconds>.<micros>"` — the posted message's ts; absent on file-attachment sends
  - `thread_ts?: "<seconds>.<micros>"` — present only when the send was into an existing thread
  - `permalink?: "https://.../archives/..."` — present when `ts` is known and a workspace URL was resolvable

Message payload fields keep canonical user IDs (for example `author.user_id`, reaction `users[]`, and `@U...` mentions in rendered content).
`referenced_users` provides display metadata for those IDs. The cache is per-workspace with a 24-hour per-entry TTL.
This behavior is opt-in and requires passing the `--resolve-users` flag (or `--refresh-users` to bypass the cache).

Use `--max-body-chars` to cap message bodies for token budget control.

## Later shape (high-level)

- `later list` returns:
  - `counts: { in_progress, archived, completed, total }`
  - `items: [{ channel_id, channel_name, ts, state, date_saved, message? }]`
  - `message` includes `author`, `content`, `thread_ts`, `reply_count`
  - Items sorted by most recently saved first
  - With `--counts-only`, `items` is omitted

- `later complete/archive/reopen/save/remove` returns `{ ok: true }`
- `later remind` returns `{ ok: true, remind_at }`

## Unreads shape (high-level)

- `unreads` returns:
  - `channels: [{ channel_id, channel_name, channel_type, unread_count, mention_count, messages? }]`
  - `threads?: { has_unreads, mention_count }` (present when there are unread thread replies)
  - `channel_type` is one of: `"channel"`, `"dm"`, `"mpim"`, `"group"`
  - Channels sorted by mention count (desc), then unread count (desc)
  - System messages (joins, leaves, topic changes) are excluded by default; use `--include-system` to include them
  - With `--counts-only`, `messages` is omitted

## Search shapes (high-level)

- `search messages|all` returns `messages: [ ... ]`
- `search messages|all` may include `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`
- `search files|all` returns `files: [ ... ]`

Use `--max-content-chars` (messages) and `--limit` to control size.

## Channel shapes (high-level)

- `channel list` returns:
  - `channels: [ ... ]`
  - `next_cursor?: string` (present when more pages are available)

- `channel new` returns:
  - `channel: { id, name, is_private }`

- `channel invite` returns:
  - Internal invite mode:
    - `channel_id`
    - `invited_user_ids: [ ... ]`
    - `already_in_channel_user_ids?: [ ... ]`
    - `unresolved_users?: [ ... ]`
  - External invite mode (`--external`):
    - `channel_id`
    - `external: true`
    - `external_limited: boolean`
    - `invited_emails: [ ... ]`
    - `already_invited_emails?: [ ... ]`
    - `invalid_external_targets?: [ ... ]`

- `channel mark` returns:
  - `ok: boolean`
  - `channel: string` (resolved channel ID)
  - `ts: string`

## File fields in compact messages

When messages include file attachments, each file object contains:

- `name` — the original filename (e.g. `"report.pdf"`), omitted if unavailable
- `mimetype` — MIME type (e.g. `"application/pdf"`)
- `mode` — Slack file mode (e.g. `"hosted"`, `"snippet"`)
- `path` — absolute local path to the downloaded file

Only files with a successful download are included.

## Attachment downloads

Attachments are downloaded to an agent-friendly temp directory.

- Successful downloads are returned as absolute paths in output.
- `message get/list` preserves failed attachment downloads with `message.files[].error` and keeps `message.files[].path` pointing to a local `.download-error.txt` file.
- Message results from `search messages|all` preserve failed attachment downloads with `messages[].files[].error` and keep `messages[].files[].path` pointing to a local `.download-error.txt` file.
- `search files` skips files whose download fails and continues returning the remaining matches.

Default download root:

- `~/.agent-slack/tmp/downloads/`

If `XDG_RUNTIME_DIR` is set, downloads live under:

- `$XDG_RUNTIME_DIR/agent-slack/tmp/downloads/`
