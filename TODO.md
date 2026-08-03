# TODO

## Billing (long-term)

Core billing

- [ ] Renewal cron job — at period end, call change_plan to re-grant balance
      products, rotate current_period_start/end
- [ ] WhatsApp template billing — record template send costs in the ledger
      (costs table is ready, just needs the ledger insert in the dispatcher)
- [ ] Plan downgrade scheduling — store pending plan change, apply at period end
      instead of immediately

Monetization

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

- [ ] UI: Realtime visibility updates — subscribe the UI to
      `conversations_agents` changes so a newly-visible conversation appears
      without refresh (needs the table in the realtime publication and possibly
      `webhook_table`)

- [ ] Review webhooks — allow more than one table per webhook

- [ ] Review re-syncs — e.g. re-sync since the last message; does a media
      message re-sync overwrite the internal file uri (internal://media/…),
      causing loss/re-upload/content re-extraction?

- [ ] Offer user-scoped WhatsApp/Instagram connections

- [ ] Per-member read receipts (team chat). External `status.read` is one fact
      owed to one peer; internal reads are per member. Two candidate homes,
      decide by what the UI will render: - `status.read` as a map keyed by agent
      id — merge_update is recursive merge-patch, so concurrent member reads
      merge (and `null` retracts) with no new machinery; precise per message,
      but N members × M messages row updates (webhook + realtime churn per
      read), and only WhatsApp groups feed it natively. - Watermark
      `last_read_ts` in `conversations_agents.extra` (the slot the schema
      comment already reserves) — one write per read action, feedable by both
      Slack markers and WhatsApp receipts; "seen by" is derived by comparing
      timestamps.

- [ ] Mentions live in content, like `re_message_id`: a `content.mentions` array
      of soft references, dual-keyed the way authorship is — `address` for
      external mentions, `agent_id` for internal ones. Inbound, the
      webhook/bridge parses them (whatsmeow: `ContextInfo.MentionedJID` + the
      `@digits` in text; Slack: `<@U…>` markup); outbound, the dispatcher
      composes them back. Tolerant of absence, never a FK.

## AI agents (frozen; on their way out)

- [ ] Testing an agent = a `local` DIRECT conversation with the AI (locked
      2026-08-03). A local direct's address IS its roster (agent ids, sorted,
      ':'-joined) and RLS only allows roster edits on `group`, so "the AI
      answers where its id is in the address" is safe by construction — a member
      cannot pull the AI into a real team conversation, and "DM the AI" stops
      being a test mode at all. Authorship keys off `agent_id` throughout
      (member = user turn, AI = assistant); `sender_address` is contact-space
      and never enters internal comms. - New trigger: WHEN
      `service = 'local' and agent_id is not null and
        pending`; the
      function checks the address names an AI agent that is not the author, then
      POSTs /agent-client. - agent-client: carve the AI-DM exception from the
      team-chat refusal (re-verify the roster server-side), map roles by
      `agent_id`, skip the contact lookup and the welcome message. - Replies
      need nothing: the AI's row arms the outgoing trigger and
      `dispatcher_edge_function`'s local branch stamps it `delivered`. -
      `multiple` (member + colleagues + AI) can join later under the same rule;
      start with `direct`.

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

- [ ] Move the RLS helpers out of `public`.

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

- [ ] Data export / DB dump

- [ ] Encrypt API keys

- [ ] Improved error handling
      https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling

- [x] Timestamp precision (JS milliseconds vs PostgreSQL microseconds)

- [x] API keys equal agents (same roles and policies)

- [x] Split supabase.ts into different files

- [x] Revisit contacts and contacts_addresses

- [ ] Respond to all / non-contacts

- [ ] Enhanced privacy (optional, do not store messages from contacts)

- [x] Revisit whatsapp-management security

- [x] Sanitize tool names Error: 400 Invalid 'tools[0].function.name': string
      does not match pattern. Expected a string that matches the pattern
      '^[a-zA-Z0-9_-]+$'.
