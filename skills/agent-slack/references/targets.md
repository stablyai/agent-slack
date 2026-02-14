# Targets: URL vs channel (reference)

`agent-slack` accepts either a **Slack message URL** (preferred) or a **channel reference**.

## Preferred: Slack message URL

Use the message permalink whenever you have it:

```text
https://<workspace>.slack.com/archives/<channel_id>/p<digits>[?thread_ts=...]
```

Examples:

- `agent-slack message get "<url>"`
- `agent-slack message list "<url>"`
- `agent-slack message send "<url>" "reply text"`
- `agent-slack message react add "<url>" "eyes"`

## Channel targets (when you don’t have a URL)

Channel references can be:

- channel name: `#general` or `general`
- channel id: `C...` (or `G...`/`D...`)

### `message get` by channel + `--ts`

```bash
agent-slack message get "#general" --ts "1770165109.628379"
```

### `message list` by channel + `--thread-ts` (or `--ts` to resolve)

```bash
agent-slack message list "#general" --thread-ts "1770165109.000001"
agent-slack message list "#general" --ts "1770165109.628379"  # resolves to its thread
```

### Reactions by channel + `--ts`

```bash
agent-slack message react add "#general" "eyes" --ts "1770165109.628379"
```

## Multi-workspace ambiguity (channel names only)

If you have multiple workspaces configured and your target is a channel **name** (`#general` / `general`), you must disambiguate:

- pass `--workspace "https://myteam.slack.com"` (or a unique substring like `--workspace "myteam"`), or
- set `SLACK_WORKSPACE_URL` to the same selector format

Channel IDs (`C...`/`G...`/`D...`) do not require `--workspace`.
