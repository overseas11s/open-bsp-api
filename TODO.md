# TODO

## Before Product Hunt Launch

- [x] Usage, tiers, limits, etc.

## Billing

Core billing (near-term)

- [ ] Renewal cron job — at period end, call change_plan to re-grant balance
      products, rotate current_period_start/end
- [ ] WhatsApp template billing — record template send costs in the ledger
      (costs table is ready, just needs the ledger insert in the dispatcher)
- [ ] Plan downgrade scheduling — store pending plan change, apply at period end
      instead of immediately

Monetization (medium-term)

- [ ] Invoice generation — aggregate usage + overages from plans_products,
      create invoice + items
- [ ] Payment integration — Stripe checkout for paid plans, webhooks for payment
      success/failure/refunds

## Slack integration (internal comms)

- [ ] Thread panel UI in open-bsp-ui — `messages.thread_id` exists but has no
      UI; Slack without threads is broken
- [ ] UI: don't render unechoed Slack sends — a dispatched row has
      sender_address null until the echo fills in the member's Slack user id, so
      other members would briefly see it attributed as their own; hide (or mark
      pending) rows with sender null + status.accepted in Slack conversations
      until the echo lands
- [ ] Realtime visibility updates — subscribe the UI to `conversations_agents`
      changes so a newly-visible conversation appears without refresh (needs the
      table in the realtime publication and possibly `webhook_table`)
- [x] Token-rotation cron — `refresh-slack-tokens` pg_cron job (every 4h) calls
      `slack-management/refresh-tokens`; a no-op until rotation is enabled on
      the Slack app (connections without a refresh_token are skipped; nothing
      breaks with rotation off — tokens are simply non-expiring). Rotation-on
      hardening done: a dead refresh token (`invalid_refresh_token` etc.)
      disconnects the connection inside the shared `ensureFreshToken` (reconnect
      prompt in the UI), and the webhook's `anyWorkspaceToken` refreshes
      expiring tokens, falling back to the next connected member
- [x] Ground Slack client + webhook in official `@slack/web-api` /
      `@slack/types` (type-only, zero runtime). `slackApi` indexed by method,
      events a discriminated union. Fixed: `member_joined_channel`'s `C`/`G` was
      recorded as public_channel, and reactions read `channel_type` at the wrong
      nesting. Unknown channel types now ask `conversations.info`.
- [ ] Review API keys — there is user-scoped content now; today API keys only
      pass the org-wide visibility branch (auth.uid() is null), revisit whether
      that stays the contract or keys grow a user scope
- [ ] Review webhooks — allow more than one table per webhook
- [ ] Review re-syncs — e.g. re-sync since the last message; does a media
      message re-sync overwrite the internal file uri (internal://media/…),
      causing loss/re-upload/content re-extraction?
- [ ] Offer user-scoped WhatsApp/Instagram connections — the visibility model
      already supports it (personal address = owner-only, branch 2 of
      is_conversation_visible); needs management/UI work
- [x] Storage RLS for user-scoped connections — is_media_visible() on the
      storage.objects download policy: unreferenced objects stay org-scoped,
      referenced ones require a visible referencing message (v1 file parts only;
      v0 legacy media stays org-scoped)
- [x] Reaction shortcode↔emoji map — `_shared/emoji.ts` generated from
      iamcal/emoji-data (the dataset Slack uses). Reactions are data-only
      (`data {action, name, unicode}`, no content.text): Slack fills
      `data.unicode`, dispatchers map Unicode back to wire names; UIs render
      from data.unicode with `:name:` fallback for custom emoji

## General

- [ ] Webhook delivery retries — pg_net makes one attempt per event (no retry,
      backoff, or dead-letter). Add retry with backoff + a dead-letter view.
      Options: a pg_cron sweep re-firing net.\_http_response failures, or move
      delivery to a queue table (pgmq) with attempt-count + backoff. Enqueue is
      already durable/transactional; only redelivery is missing.

- [ ] Batched/async mass deletions — org delete cascades to 15 tables, account
      delete cascades conversations+messages, and the Meta data-deletion
      callback fires it unauthenticated. Mark + reap in pg_cron instead of one
      transaction.

- [x] RLS: per-row `is_conversation_visible()` replaced by InitPlan sets
      (`get_visible_addresses` / `get_participant_conversations` /
      `get_restricted_conversations`) — plans now show hashed SubPlans instead
      of a per-row function call.

- [ ] Index `get_restricted_conversations()` — it scans the caller's org
      conversations reading `extra->>'is_bot_member'` and `type`, with nothing
      to support it. Once per query (InitPlan), but a full scan over 22k rows.
      Partial indexes on the two restricted shapes.

- [ ] Move the RLS helpers out of `public` — every non-trigger function there is
      published by PostgREST as an RPC, and most are SECURITY DEFINER, so each
      one is an API surface nobody designed. `get_visible_addresses` was
      returning every shared inbox in the database that way (fixed by scoping
      it, but the class remains). A non-exposed schema for helpers removes the
      whole category; policies would need re-qualifying. Known residue
      meanwhile: `get_restricted_conversations()` enumerates the ids of
      conversations in your own orgs that you may NOT read — count and uuids of
      colleagues' private DMs, no content.

- [ ] Members' lists still show deleted agents — the SELECT policies keep them
      readable on purpose (message authorship, roster names), so the filtering
      belongs to the readers: UI member lists, and anything that ever counts
      seats.

- [ ] API-key-created `local` conversations are invisible orphans — the insert
      policy admits `anon`, but the participant trigger needs `auth.uid()`, so
      the row lands with no participants and no one can ever see it. Either drop
      `anon` from the policy or give the keyless path a `channel`.

- [ ] Uniform connection ownership — whatsapp/instagram already resolve the
      newest connected row, so reconnecting from another org steals the
      connection (fine: whoever owns the account may move it). Do the same for
      slack (drop the connect 409) and the connectors. Exception: whatsapp-web
      is a device login, so several tenants can hold live sessions for one
      number at once. Optional: tenant discrimination in generic-webhook.

- [ ] Improve routing of organization accounts and members

- [ ] Data export / DB dump

- [ ] Langfuse integration

- [ ] Encrypt API keys

- [ ] Improved error handling
      https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling

- [x] Timestamp precision (JS milliseconds vs PostgreSQL microseconds)

- [x] API keys equal agents (same roles and policies)

- [x] Split supabase.ts into different files

- [x] Revisit contacts and contacts_addresses

- [ ] Respond to all / non-contacts

- [ ] Enhanced privacy (optional, do not store messages from contacts)

- [ ] Coexistence welcome message pauses the conversation

- [x] Revisit whatsapp-management security

- [x] Sanitize tool names Error: 400 Invalid 'tools[0].function.name': string
      does not match pattern. Expected a string that matches the pattern
      '^[a-zA-Z0-9_-]+$'.
