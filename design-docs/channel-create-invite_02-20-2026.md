# Problem

Issue #5 asks for a `channel` command group with channel creation and user invites. The exact issue body is minimal, but the underlying problem is real: agents can read/search/write messages today, yet still cannot perform basic channel setup workflows.

Evidence this matters:

- `src/index.ts` currently registers `auth`, `message`, `search`, `user`, `canvas`, and `update`, but no `channel` commands.
- Team workflows often need a setup step (`create room` + `invite participants`) before message automation can begin.

This is worth solving now because it is a clear gap in core Slack automation coverage and can be added without changing existing command semantics.

# Solution

Add a new top-level `channel` command group with two focused subcommands:

1. `agent-slack channel new --name <name> [--private] [--workspace <selector>]`
   Creates a channel via `conversations.create` and returns compact JSON:
   `{ channel: { id, name, is_private } }`.

2. `agent-slack channel invite --channel <id|name> --users "<csv>" [--workspace <selector>]`
   Invites users to a channel by accepting mixed identifiers (user id, handle, email), resolving them to Slack user IDs, and inviting each user. Output includes:
   `channel_id`, `invited_user_ids`, `already_in_channel_user_ids`, and `unresolved_users`.

Implementation shape:

- New CLI registration module for channel commands (`src/cli/channel-command.ts`).
- New Slack API helpers for creation/invites (`src/slack/channel-admin.ts`).
- Extend reusable user resolution to support email lookup (`src/slack/users.ts`).
- Wire command registration in `src/index.ts`.
- Sync docs in `README.md` and `skills/agent-slack/`.

Expected impact:

- Removes a setup bottleneck for agents that need to bootstrap collaboration spaces.
- Keeps output token-efficient and machine-friendly.
- Preserves backward compatibility with all existing commands.

# What Could Go Wrong

1. Does it actually solve the problem?

- Risk: invite resolution may fail for email lookups if workspace scopes are missing.
- Mitigation: fallback to `users.list` scan and report unresolved identifiers explicitly.

2. Is the scope right?

- Risk: expanding into full channel lifecycle management (archive/rename/topic) would over-scope this issue.
- Mitigation: ship only `new` and `invite`, which covers the core setup workflow.

3. What are we implicitly assuming?

- Assumption: channel name ambiguity across multiple workspaces can be handled with existing `--workspace` guardrails.
- Mitigation: reuse existing workspace disambiguation checks before resolving channel names.

4. Is there a more efficient method?

- Alternative: one bulk `conversations.invite` call for all users.
- Decision: invite users one-by-one so we can preserve partial success and return `already_in_channel_user_ids` accurately.
