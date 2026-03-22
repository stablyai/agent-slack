# Output + downloads (reference)

## Output format

All commands print JSON to stdout.

- Empty values are pruned (`null`, `[]`, `{}` are removed where possible).
- `auth whoami` redacts secrets in its output.

## Message shapes (high-level)

- `message get` returns:
  - `message: { ... }`
  - `thread?: { ts, length }` (summary only; present when threaded)

- `message list` returns:
  - `messages: [ ... ]` (the full thread)
  - Messages are compact and omit redundant fields on each item where possible.

Use `--max-body-chars` to cap message bodies for token budget control.

## Search shapes (high-level)

- `search messages|all` returns `messages: [ ... ]`
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
