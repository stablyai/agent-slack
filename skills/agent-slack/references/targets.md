# Target selection

Prefer a Slack message URL whenever one is available:

```text
https://<workspace>.slack.com/archives/<channel_id>/p<digits>[?thread_ts=...]
```

A URL supplies the workspace, channel, and message timestamp. With a URL target:

- `message get`, `edit`, `delete`, and `react` operate on that message.
- `message list` returns the thread root and all replies.
- `message send` replies in that message's thread. `message draft` does the same unless `--thread-ts` explicitly overrides the URL-derived thread.
- `channel mark` marks through that message timestamp; `--ts` explicitly overrides the timestamp. It rejects `--workspace` because the URL supplies it.

Use a channel name or a `C...`, `G...`, or `D...` channel ID only when no URL is available:

- `message get`, `edit`, `delete`, and `react` require `--ts`.
- `message list` reads channel history unless `--thread-ts` or `--ts` selects a thread.
- `channel mark` requires `--ts`.

Among `message` subcommands, only `message send` accepts a `U...` or `W...` user ID as a target; it opens or reuses that user's direct-message channel. Treat `U`- and `W`-prefixed user IDs equivalently.

Use `user dm-open <users...>` with one to eight other user IDs or handles to get a DM or group-DM channel ID, then use that channel ID for message operations. The authenticated caller is implicit.

Non-URL targets do not carry workspace identity. When multiple workspaces are configured, use the intended configured default or pass `--workspace <url-or-unique-substring>`/`SLACK_WORKSPACE_URL`, including for channel, user, canvas, and workflow IDs.
