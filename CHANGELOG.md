# Changelog

Notable changes, newest first. Schema changes that require action from consumers
of the database (the UI, n8n, MCP clients, custom integrations) are called out
as **Breaking**.

Migrations apply automatically via CI: pushing to `develop` deploys to DEV,
pushing to `main` deploys to PROD.

## Unreleased — Slack integration

### Breaking

- **`organizations_addresses` is keyed `(organization_id, service, address)`.**
  It was `(organization_id, address)`, which let a conversation's `service`
  disagree with the account it hangs off — production carried three WhatsApp
  conversations anchored to a whatsapp-web account. The three FKs that reference
  an account (`conversations`, `conversations_agents`, `logs`) now carry
  `service` too, so the mismatch is unrepresentable. Consequences:

  - The same address string can now exist twice under different services (bare
    phone digits as both a `whatsapp` and a `whatsapp-web` account), so any
    reader that looks an account up by `(organization_id, address)` alone can
    match the wrong row. Add `service` to those lookups.
  - `get_visible_addresses()` returns `(organization_id, service, address)`
    rather than a pair. It is a published RPC. (`is_conversation_visible()`
    keeps its `(conv_id, conv_org, conv_addr,
    conv_service)` signature —
    `conv_service` was briefly dropped earlier in this release as unread, and is
    now load-bearing again.)
  - `logs` gains a check: state a `service` whenever you state an
    `organization_address`.
  - The migration deletes the three mismatched conversations and their six
    messages. Each shadowed a live bridge conversation with the same peer (67
    and 75 messages), which is untouched.

- **`conversations.status` is gone** (dropped by the preceding migration in this
  release; archived state lives in `extra.channel_archived`). The MCP
  `fetchConversation` tool was still filtering on it and would have returned a
  PostgREST 400 — fixed here. Check any other client that filters conversations
  by `status`.

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

- **`conversations` is read-only for members on every service but `local`.** A
  conversation mirrors state that lives on someone else's server, so members
  hold SELECT and nothing else: no INSERT, UPDATE or DELETE for whatsapp,
  whatsapp-web, instagram or slack. Renaming, archiving or pinning through
  `conversations.extra` now fails silently (zero rows) — those are moving to
  `conversations_agents.extra`, where they are per-member anyway. Starting a
  conversation still works: insert the first MESSAGE and the row is minted for
  you.

- **`conversations.status` and the `quick_replies` table are dropped.** `status`
  held `'active'` in all 22k production rows — it was the session dimension, and
  sessions were never used. Its one real writer recorded Slack channel
  archiving, now `extra.channel_archived`. `quick_replies` had no rows and no
  reader.

- **`conversations_system` is dropped**, one DEV deploy after it was added. Its
  facts moved back into `conversations.extra` (`is_bot_member`,
  `channel_archived`) and into the new `type` column. The separate table existed
  because the old policy granted members UPDATE on every column; now the policy
  grants no UPDATE at all, so there is nothing to protect against. Never reached
  PROD.

- **Duplicate conversations are merged.** Production accumulated 136 duplicated
  `(organization, service, account, peer)` keys over 529 rows under
  lookup-then-insert. The oldest row wins, messages and membership are repointed
  at it, and a unique index now prevents recurrence.

- **Conversations are no longer paused by a human reply.** The 12-hour AI-agent
  pause (`conversations.extra.paused`, written by a trigger on every
  account-authored message) is gone, along with the trigger. Pausing an AI agent
  is a feature of an agentic platform; this is a communication layer.

- **Deleting an agent no longer removes the row.** `DELETE` marks
  `agents.deleted_at` and is cancelled, because an agent is named by things that
  outlive their membership: message authorship, and the conversation address of
  every local direct/multiple they are in. Every access helper skips a marked
  agent, so access is revoked exactly as before — but readers that assume a
  removed member disappears from `agents` need to filter `deleted_at is null`
  themselves. Deleting an organization still removes them outright, and erasing
  the auth user now nulls `agents.user_id` instead of cascading.

- **Deleting a connected account deletes its data.**
  `conversations.organization_address` became `on delete cascade`, so removing
  an `organizations_addresses` row now takes its conversations and messages with
  it instead of raising a foreign-key error.

### Added

- Slack as an intra-org channel: connect **as a member** (`xoxp`), **as a bot**
  (`xoxb`), or both. The bot is the shared-inbox connection — everything it is
  in is org-wide, private channels included — while members' own conversations
  stay private. See the README.
- `conversations_agents` — who is in a conversation. On mirror services it
  reflects membership of the external container and grants visibility; on
  `local` members manage it themselves (join, add, kick).
- `conversations.type` — the channel's shape in one cross-service vocabulary:
  `direct` (1:1), `multiple` (Slack mpim, Teams group chat), `group` (WhatsApp
  group, Slack/Teams private channel), `channel` (Slack public channel),
  `broadcast` (WhatsApp broadcast list). `text` with a check constraint rather
  than an enum, because RLS references it and `db diff` cannot add a value to an
  enum in that position.
- Internal conversations on the `local` service. `direct` and `multiple` are
  identified by their roster: create one by setting `conversation_address` to
  the participating agent ids (`'A:B'`, `'A:B:C'`, any order) and the trigger
  sorts them, derives the type from the count, and writes the membership. The
  canonical form is the identity, so the unique index is what answers "does this
  conversation already exist between these people", and neither can be joined or
  left afterwards. `group` and `channel` are named containers instead: state the
  type, omit the address, and manage membership through `conversations_agents`.
- `organizations_addresses.agent_id` — an account's owner. Null means a shared
  inbox; set means personal.
- `slack-app-manifest.yaml` — the Slack app's configuration, in version control
  rather than only in the dashboard.

### Performance

Measured against production, so the numbers are the pre-change cost.

- **`messages(service, created_at desc)` added.**
  `where service = ? and
  created_at >= ? order by created_at desc` — an
  incremental polling pattern — was the single most expensive statement in the
  database at 10,608 calls, 174 ms mean, ~86 GB read from disk, because nothing
  indexed `created_at` and every call sorted the table.
- **`conversations_identity_idx` reordered** to
  `(organization_id,
  organization_address, service, conversation_address)`.
  Uniqueness is unchanged; the leading columns now also serve the account FK
  (that cascade took 5.4 s on a sequential scan) and the "conversations on this
  account" lookup, which was reading 539M tuples across 279k scans through a
  single-column index.
- **Four redundant indexes dropped:** `conversations_organization_address_idx`
  and `conversations_organization_id_idx` (both prefixes of the reordered
  identity index), `messages_organization_id_idx` (a prefix of
  `messages_org_conv_timestamp_idx`), and `contacts_addresses_phone_number_idx`
  (0 scans over the counter's whole lifetime, 1.4 MB of write tax on a table
  taking ~65k inserts).
- **RLS InitPlan wrapping** on the three `agents` self-policies and the
  `api_keys` owner read: `auth.uid()` and `current_setting('request.headers')`
  are evaluated once per query instead of once per row.

### Changed

- `conversations_agents.service` is derived by a trigger, never written by a
  client. It exists so the account FK can name a whole key; a membership's
  service is always its conversation's, so stating it could only ever introduce
  a disagreement.
- `ConversationType` moved to `_shared/types/conversation_types.ts` and is
  re-exported from `_shared/supabase.ts`; the `conversations.type` column is
  typed with it, so it is no longer Slack-specific.
- `get_visible_addresses()` only returns accounts in organizations the caller
  belongs to. No policy changes behaviour (all of them already filtered by
  organization), but the function is RPC-callable and was not filtering on its
  own.
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
