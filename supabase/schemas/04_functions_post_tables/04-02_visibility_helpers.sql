-- Who sees a conversation: the ACCOUNT rule decides by default, and a
-- conversation may override it.
--
--   Account (organizations_addresses.agent_id):
--     null => public — a shared inbox, visible to the whole org
--     set  => private — a personal account, visible to its owner
--
--   Override (conversations_system.private, default true):
--     absent or false => the account rule stands
--     true            => account rule suppressed; only conversations_agents
--                        members see it
--
-- The override exists because one ownerless account can host both modes.
-- Slack is the case: the workspace anchor is ownerless and holds the bot —
-- the shared-inbox connection, exactly like a common WhatsApp number — while
-- each member's T…:U… row is personal. Every conversation hangs off the
-- anchor regardless of which one it arrived through, so "is this shared?" is
-- a fact about the conversation, not the account. A channel the bot is in is
-- public; a member's DM is not.
--
-- No service is named anywhere below. An ingestor declares what it wants by
-- writing (or not writing) the override; adding discord/teams/email needs no
-- change here.
--
-- There is deliberately NO role bypass: owners/admins cannot read a member's
-- personal conversations. API keys authenticate without auth.uid(), so they
-- only ever see shared-inbox content.
--
-- SHAPE: these return SETS and take no per-row arguments, so the policies can
-- call them as `x in (select …)` — an InitPlan evaluated once per query and
-- then hash-probed per row, the same trick that makes get_authorized_orgs
-- cheap. A boolean helper taking the row's columns cannot get that treatment:
-- it is re-invoked per row, and being SECURITY DEFINER it cannot be inlined
-- either.

-- Accounts whose conversations the caller can see, as (organization_id,
-- address) pairs: the org's shared inboxes, plus personal accounts the
-- caller owns. Conversations under these are visible unless their override
-- says private.
create function public.get_visible_addresses()
returns table (organization_id uuid, address text)
language sql
stable
security definer
set search_path to ''
as $$
  -- Shared inboxes: any ownerless account. No auth.uid() involved — "is the
  -- caller in this org" lives in the policy — so this is the only rule an
  -- API key can satisfy.
  select oa.organization_id, oa.address
  from public.organizations_addresses oa
  where oa.agent_id is null
  union
  -- Personal accounts owned by the caller (their Slack identity, a personal
  -- WhatsApp/mailbox).
  select oa.organization_id, oa.address
  from public.organizations_addresses oa
  join public.agents a on a.id = oa.agent_id
  where a.user_id = auth.uid();
$$;

-- Conversations the caller participates in: a conversations_agents row names
-- an agent that is the caller. Mirrors channel/DM membership on the external
-- service, and is the only way into a conversation marked private.
create function public.get_participant_conversations()
returns setof uuid
language sql
stable
security definer
set search_path to ''
as $$
  select ca.conversation_id
  from public.conversations_agents ca
  join public.agents a on a.id = ca.agent_id
  where a.user_id = auth.uid();
$$;

-- Conversations whose override suppresses the account rule. Scoped to the
-- caller's orgs so the set stays bounded. Members cannot influence it —
-- conversations_system grants them no write.
create function public.get_private_conversations()
returns setof uuid
language sql
stable
security definer
set search_path to ''
as $$
  select cs.conversation_id
  from public.conversations_system cs
  where cs.private
    and cs.organization_id in (select public.get_authorized_orgs('member'));
$$;

-- Boolean form, for callers that hold a single row rather than a query to
-- filter (is_media_visible). Same rules, expressed through the same two
-- functions so the two forms cannot drift apart. Do NOT use this in a policy
-- over a large table: per-row arguments defeat the InitPlan.
create function public.is_conversation_visible(
  conv_id uuid,
  conv_org uuid,
  conv_addr text,
  conv_service public.service
) returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select
    (
      (conv_org, conv_addr) in (
        select v.organization_id, v.address from public.get_visible_addresses() v
      )
      and conv_id not in (select public.get_private_conversations())
    )
    or conv_id in (select public.get_participant_conversations());
$$;

-- Whether the caller may download a media object (storage path
-- organizations/<org>/attachments/<file>). Rule: an object nobody references
-- stays org-scoped (covers freshly uploaded files whose message doesn't
-- exist yet, and v0-content legacy media, which only v1 file parts can
-- reference here); a referenced object requires at least one referencing
-- message whose conversation the caller can see. SECURITY DEFINER on
-- purpose: with invoker rights the invisible referencing messages would be
-- hidden by RLS and the check could not distinguish "unreferenced" from
-- "referenced but private".
create function public.is_media_visible(object_name text) returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  with refs as (
    select m.conversation_id, m.organization_id, m.organization_address, m.service
    from public.messages m
    where m.content->'file'->>'uri' = 'internal://media/' || object_name
  )
  select
    not exists (select 1 from refs)
    or exists (
      select 1 from refs r
      where public.is_conversation_visible(
        r.conversation_id, r.organization_id, r.organization_address, r.service
      )
    );
$$;
