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
- [ ] Realtime visibility updates — subscribe the UI to `conversations_agents`
      changes so a newly-visible conversation appears without refresh (needs the
      table in the realtime publication and possibly `webhook_table`)
- [ ] Token-rotation cron — schedule `slack-management/refresh-tokens` (pg_cron,
      like Instagram's) once rotation is enabled on the Slack app; it is a no-op
      until connections carry a refresh_token
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
      referenced ones require a visible referencing message (v1 file parts
      only; v0 legacy media stays org-scoped)
- [ ] Reaction shortcode↔emoji map — the reaction convention is settled
      (`text` = Unicode display form, empty on removal; `data` always
      `{action, name, unicode}` with `name` = service-native id) and wired
      into slack-webhook/slack-dispatcher (removal included); what's missing
      is the shortcode↔emoji map in \_shared so Slack fills `data.unicode`
      and `text` renders "👍" instead of ":thumbsup:"

## General

- [ ] Webhook delivery retries — pg_net makes one attempt per event (no retry,
      backoff, or dead-letter). Add retry with backoff + a dead-letter view.
      Options: a pg_cron sweep re-firing net.\_http_response failures, or move
      delivery to a queue table (pgmq) with attempt-count + backoff. Enqueue is
      already durable/transactional; only redelivery is missing.

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
