-- Who sees a conversation follows from the service's communication category
-- plus account ownership — no per-row visibility state:
--
--   * customer-facing services (whatsapp, instagram, …): an ownerless
--     account is the org's shared inbox — visible org-wide. An owned
--     account is personal — owner only.
--   * intra-org services (slack; later discord/teams): nothing is ever
--     org-wide by default. The ownerless workspace anchor's conversations
--     are visible to the agents listed in conversations_agents, mirroring
--     membership on the external service. The exception is an explicit
--     conversations_system.org_visible flag (containers the workspace bot is
--     in), which lives in a service-role-only table precisely so a member
--     cannot set it.
--
-- There is deliberately NO role bypass: owners/admins cannot read a member's
-- personal conversations. API keys authenticate without auth.uid(), so they
-- only ever see org-wide content (org-scoped keys don't pierce member
-- privacy either).
--
-- SHAPE: these return SETS, not booleans, and take no per-row arguments. The
-- policies call them as `x in (select …)`, which the planner evaluates once
-- per query as an InitPlan and then probes per row — the same trick that
-- makes get_authorized_orgs cheap. A boolean helper taking the row's columns
-- cannot get that treatment: it is re-invoked per row, and being SECURITY
-- DEFINER it cannot be inlined either, so each call is a real function call
-- with correlated subqueries inside. Both sets are small (bounded by
-- organizations_addresses, and by the caller's own memberships).

-- Accounts whose conversations the caller can see, as (organization_id,
-- address) pairs. Folds the two address-based rules: the org's shared
-- inboxes, and personal accounts the caller owns. The service guard keeps
-- the ownerless Slack workspace anchor out of the shared-inbox rule.
create function public.get_visible_addresses()
returns table (organization_id uuid, address text)
language sql
stable
security definer
set search_path to ''
as $$
  -- Shared inboxes: ownerless accounts on customer-facing services. No
  -- auth.uid() involved — "is the caller in this org" lives in the policy —
  -- so this is the only rule an API key can satisfy.
  select oa.organization_id, oa.address
  from public.organizations_addresses oa
  where oa.agent_id is null
    and oa.service not in ('slack', 'discord', 'teams')
  union
  -- Personal accounts owned by the caller (a personal WhatsApp/mailbox).
  -- Slack does not use this rule: its conversations anchor to the workspace,
  -- not to the member's T…:U… row, so they rely on participation instead.
  select oa.organization_id, oa.address
  from public.organizations_addresses oa
  join public.agents a on a.id = oa.agent_id
  where a.user_id = auth.uid();
$$;

-- Conversations the caller can see irrespective of which account they hang
-- off: ones they participate in, plus ones flagged org-wide by the system.
create function public.get_visible_conversations()
returns setof uuid
language sql
stable
security definer
set search_path to ''
as $$
  -- Participation: a conversations_agents row names an agent that is the
  -- caller. The Slack path, mirroring channel/DM membership.
  select ca.conversation_id
  from public.conversations_agents ca
  join public.agents a on a.id = ca.agent_id
  where a.user_id = auth.uid()
  union
  -- Org-wide by system decision (e.g. a container the workspace bot is in).
  -- Restricted to the caller's orgs so the set stays small; the policy
  -- checks org membership again anyway. Members cannot set this flag —
  -- conversations_system grants them no write.
  select cs.conversation_id
  from public.conversations_system cs
  where cs.org_visible
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
    (conv_org, conv_addr) in (
      select v.organization_id, v.address from public.get_visible_addresses() v
    )
    or conv_id in (select public.get_visible_conversations());
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
