# Slack integration status

Branch `slack-integration`, as of 2026-07-27. Backend is feature-complete for
v1; not yet in production. What stands between here and merge is the
real-workspace E2E and the UI pieces.

## Done (verified against the local DB)

- **Schema remodel** — `conversation_address` + `sender_address` (soft
  references), `group_address` dropped everywhere, `conversations_agents`
  visibility table, cascade deletes on org-address removal. Squashed into one
  migration plus the sender re-think follow-ups.
- **Sender/dispatch model** — sender is a contact reference or null (null = the
  account itself spoke). Dispatch = sender null + `status.pending` +
  sendable-kind whitelist + no `content.tool`. Internal rows get pending
  stripped on insert AND update (merge-trigger-proof). The Slack echo fills
  sender fill-once (null → member's U…); non-null senders are immutable.
- **Visibility & RLS** — the account rule decides (ownerless address = shared
  inbox = org-wide; owned = personal), and `conversations_system.private`
  overrides it per conversation. No service is named in the policies any more:
  Slack's ownerless anchor holds the bot (the shared-inbox connection), so
  members' DMs under that same anchor stay private via the override. Policies
  use set-returning helpers (`get_visible_addresses` /
  `get_participant_conversations` / `get_private_conversations`) so the checks
  become hashed SubPlans instead of a per-row SECURITY DEFINER call;
  `is_conversation_visible` remains as the boolean form over the same helpers,
  for `is_media_visible`. Owners/admins cannot read members' conversations; API
  keys see shared-account content only. Explicit grants for the new tables
  (default privileges don't cover them).
- **`conversations_system`** — service-role-only home for facts members must not
  rewrite (`channel_type`, `private`). `conversations.extra` cannot hold them:
  `authenticated` AND `anon` both have UPDATE on conversations. Verified against
  the local DB — insert/update/delete all denied to `authenticated`, select
  allowed. Sets the `<table>_system` pattern.
- **Official Slack types** — `@slack/web-api` + `@slack/types` imported
  `import type` (erased; zero runtime). `slackApi` indexed by method, events a
  discriminated union. Caught two real bugs: `member_joined_channel`'s `C`/`G`
  was recorded as `public_channel`, and reactions read `channel_type` at the
  wrong nesting.
- **App manifest** — `slack-app-manifest.yaml` at the repo root; scope lists
  verified identical to `USER_SCOPES`/`BOT_SCOPES`, and every subscribed event
  has a handler (and vice versa).
- **slack-management** — per-member OAuth connect (workspace anchor `T…` +
  personal `T…:U…` rows, 409 if the workspace belongs to another org), sync
  (users → contacts, channels → conversations + memberships), disconnect
  (revokes token, clears secrets, keeps everything else — disconnect ≠ delete),
  `/refresh-tokens` sweep.
- **slack-webhook** — signature verify, 3-second ack via waitUntil, tenant by
  team_id → anchor. Handlers: messages (file_share, thread_broadcast, edits,
  deletions), reactions, member joined/left, channel rename/archive,
  user_change, tokens_revoked, app_uninstalled. All writes idempotent on
  `external_id = team:channel:ts` (Slack delivers once per app, so multiple
  connected members never duplicate rows).
- **slack-dispatcher** — credentials resolved by `message.agent_id` → the
  member's personal row (never by sender_address). markdown↔mrkdwn conversion,
  upload-then-reference file sends (synchronous ts), data-only reactions, error
  taxonomy (retryable set; token errors → disconnect).
- **Cross-service conventions** — data-only reactions
  (`data {action, name, unicode}`, no `content.text`) across all
  dispatchers/webhooks including the whatsmeow bridge; shortcode↔emoji map
  (`_shared/emoji.ts`); bridge owns its wire mapping, generic functions are pure
  pass-throughs. No v0 content support in any new logic.
- **Token rotation** — connect stores `refresh_token`/`expires_at`, inline
  refresh in the dispatcher (`ensureFreshToken`), `/refresh-tokens` sweep,
  `refresh-slack-tokens` pg_cron job every 4h.
- Docs: README Slack section, plugin API reference, TODO.md.

## Token rotation posture

The first Slack app will be created with rotation ON (the integration never
shipped, so there are no pre-rotation tokens and `oauth.v2.exchange` is
irrelevant). **If rotation is ever off, nothing breaks** — Slack just issues
non-expiring tokens: no `refresh_token` means `ensureFreshToken` passes the
stored token straight through, the sweep matches zero rows (cron is a no-op),
and `anyWorkspaceToken` picks are always valid.

Rotation-on hardening (done 2026-07-27): refresh logic is centralized in
`_shared/slack.ts` `ensureFreshToken` — used by the dispatcher, the webhook and
the cron sweep. A dead refresh token (`invalid_refresh_token`, `token_revoked`,
…) flips the connection to `disconnected` and clears its secrets so the UI
prompts a reconnect (same semantics as `tokens_revoked`). The webhook's
`anyWorkspaceToken` is expiry-aware: it runs each candidate through
`ensureFreshToken` and falls back to the next connected member when a refresh
fails.

## Left

1. **Real-workspace E2E** — needs the dev Slack app created (rotation on) and
   secrets set: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
   `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (app-level, for
   `apps.event.authorizations.list`). Create it from `slack-app-manifest.yaml`;
   that file has never been through Slack's validator, so the first apply is
   also its test.
2. **UI (open-bsp-ui)** — thread panel (`messages.thread_id` has no UI); hide
   unechoed Slack sends (sender null until the echo — other members would
   briefly see them as their own); `conversations_agents` realtime subscription;
   per-user scoping on the integrations page; commit the mirrored `db_types.ts`.
3. **Phase B cleanup (post-merge)** — drop `direction` + `contact_address` after
   migrating readers (agent-client/protocols/MCP/UI/n8n) to `content.tool`;
   remove the compat derivation in `before_insert_on_messages`; drop direction
   from wire contracts.
4. **Bot mode ingestion** — OAuth accepts `mode=user|bot|both` and a bot token
   is stored on the workspace anchor, but nothing writes
   `conversations_system.private = false` yet, and `bot_events` are commented
   out in the manifest for that reason: enabling them before the writer exists
   would ingest conversations with no `conversations_agents` row, visible to
   nobody. Decision already taken — bot presence makes a container org-visible
   regardless of whether it is private.
5. **TODO.md reviews** — API keys vs user-scoped content, multi-table webhooks,
   re-sync media-uri safety, user-scoped WhatsApp/Instagram connections.

## Known acceptable gaps

- Credentials live in `organizations_addresses.extra`, readable via the org-wide
  select policy (acknowledged debt).
- Conversations lack a unique constraint on (org, org_address,
  conversation_address) — lookup-then-insert races acknowledged.
- Webhook delivery is single-attempt (pg_net, no retry) — general TODO item.
