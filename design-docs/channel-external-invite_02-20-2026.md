# Problem

The new `channel invite` command currently supports internal workspace users, but it does not support Slack Connect external invitations. This misses a common channel-management path where teams invite partner emails and choose whether those external invitees can invite others.

Evidence:

- Slack UI exposes an external invite permission choice during Slack Connect invitations.
- `channel invite` currently calls only `conversations.invite` (internal member invite path).

# Solution

Extend `channel invite` with external invite mode:

- `--external`: switch invite mode to Slack Connect via `conversations.inviteShared`.
- `--allow-external-user-invites`: for external mode, sets `external_limited=false`.
  - Default behavior remains restricted (`external_limited=true`) when this flag is omitted.

Behavior details:

- External mode accepts email targets from `--users`.
- Non-email targets are returned in `invalid_external_targets` and not sent to Slack Connect APIs.
- Internal mode behavior remains unchanged (resolve `U...`, `@handle`, `handle`, or `email` to user IDs and call `conversations.invite`).

Output additions for external mode:

- `external: true`
- `external_limited`
- `invited_emails`
- `already_invited_emails`
- `invalid_external_targets`

Docs and skill references are updated to document the new flags and output shape.

# What Could Go Wrong

1. Does it actually solve the problem?

- Risk: workspace policies or missing scopes may reject external invites.
- Mitigation: surface Slack API errors directly and keep flags explicit to avoid hidden behavior.

2. Is the scope right?

- Risk: adding full Slack Connect lifecycle controls (approve/decline/list pending invites) would over-scope this PR.
- Mitigation: implement only invite creation with the key permission toggle.

3. What are we implicitly assuming?

- Assumption: external invite targets are email-based in current workflows.
- Mitigation: enforce/validate email inputs for `--external` and report invalid targets explicitly.
