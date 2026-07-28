# Changelog

Notable changes, newest first. Schema changes that require action from consumers
of the database (the UI, n8n, MCP clients, custom integrations) are called out
as **Breaking**.

Migrations apply automatically via CI: pushing to `develop` deploys to DEV,
pushing to `main` deploys to PROD.

## Unreleased — Slack integration

### Breaking

- **`conversations.group_address` and `messages.group_address` are dropped.**
  Both were in real use for WhatsApp group keying (116k messages in production
  carried one). The migration copies the value into the new
  `conversation_address` before dropping, so no data is lost — but any reader
  selecting `group_address` breaks the moment the migration lands. Replace it
  with `conversation_address`, which holds the peer for every conversation: a
  phone number, a group JID, a Slack channel id.

- **Visibility is narrower.** Reads of `conversations` and `messages` are now
  filtered by the account rule plus a per-conversation override, rather than by
  organization alone. Nothing widens: the change can only ever hide rows, never
  expose them. Existing WhatsApp/Instagram data is unaffected — those accounts
  are ownerless, and ownerless still means org-wide — but code that assumed
  "member of the org ⇒ sees every row" is now wrong.

- **API keys see shared-inbox content only.** They authenticate without a user,
  so they cannot satisfy the ownership or participation rules.

- **Deleting a connected account deletes its data.**
  `conversations.organization_address` became `on delete cascade`, so removing
  an `organizations_addresses` row now takes its conversations and messages with
  it instead of raising a foreign-key error.

### Added

- Slack as an intra-org channel: connect **as a member** (`xoxp`), **as a bot**
  (`xoxb`), or both. The bot is the shared-inbox connection — everything it is
  in is org-wide, private channels included — while members' own conversations
  stay private. See the README.
- `conversations_agents` — per-member visibility, mirroring membership on the
  external service.
- `conversations_system` — system-controlled facts a member must not rewrite
  (`channel_type`, `private`). Only the service role can write it;
  `conversations.extra` is writable by any caller who can see the conversation,
  which is why these cannot live there. Establishes the `<table>_system` pattern
  for other tables with a public `extra`.
- `organizations_addresses.agent_id` — an account's owner. Null means a shared
  inbox; set means personal.
- `slack-app-manifest.yaml` — the Slack app's configuration, in version control
  rather than only in the dashboard.

### Changed

- `messages.sender_address` replaces `direction` as the source of truth: it is a
  contact reference, or null when the account itself spoke. `direction` and
  `contact_address` are still written and still derived, so existing readers
  keep working; they are scheduled for removal once readers migrate.
- Internal rows (tool traces, notes, agent errors) can never carry
  `status.pending`, so no automation picks them up.
- RLS helpers return sets rather than booleans, which lets Postgres evaluate
  them once per query instead of once per row.
- The Slack client and webhook are typed from the official `@slack/web-api` and
  `@slack/types` packages (type-only imports; nothing added to the runtime
  bundle).

### Fixed

- `member_joined_channel` reports `channel_type` as `C`/`G`, which was being
  read with the message-event vocabulary and recorded every private channel as
  public. Classification now comes from `conversations.info`.
- Reaction events carry `channel_type` under `item`, not at the top level.
- Third-party app messages (CI, alerts, GitHub) are mirrored instead of being
  dropped along with our own bot's echoes.
