-- Who sees a conversation follows from the service's communication category
-- plus account ownership — no per-row visibility state:
--
--   * customer-facing services (whatsapp, instagram, …): an ownerless
--     account is the org's shared inbox — visible org-wide. An owned
--     account is personal — owner only.
--   * intra-org services (slack; later discord/teams): nothing is ever
--     org-wide. The ownerless workspace anchor's conversations are visible
--     to the agents listed in conversations_agents, mirroring membership on
--     the external service. (email, when it lands, can be either purely via
--     ownership: shared support@ vs a personal mailbox.)
--
-- There is deliberately NO role bypass: owners/admins cannot read a member's
-- personal conversations. API keys authenticate without auth.uid(), so they
-- only ever see org-wide content (org-scoped keys don't pierce member
-- privacy either).
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
    -- 1. Org-wide shared inbox: the conversation hangs off an ownerless
    --    account on a customer-facing service. No auth.uid() involved — the
    --    "is the caller in this org" half lives in the RLS policy
    --    (get_authorized_orgs). The service guard keeps the ownerless Slack
    --    workspace anchor out of this branch. This is also the only branch
    --    an API key (auth.uid() is null) can ever pass.
    (
      conv_service not in ('slack', 'discord', 'teams')
      and exists (
        select 1 from public.organizations_addresses oa
        where oa.organization_id = conv_org
          and oa.address = conv_addr
          and oa.agent_id is null
      )
    )
    -- 2. Account owner: the conversation hangs off a PERSONAL account whose
    --    owner is the caller (e.g. a future personal WhatsApp/mailbox).
    --    Slack conversations don't use this branch — they anchor to the
    --    workspace, not to the member's T…:U… row — they rely on 3.
    or exists (
      select 1
      from public.organizations_addresses oa
      join public.agents a on a.id = oa.agent_id
      where oa.organization_id = conv_org
        and oa.address = conv_addr
        and a.user_id = auth.uid()
    )
    -- 3. Participant: a conversations_agents row for THIS conversation names
    --    an agent that is the caller. The Slack path, mirroring channel/DM
    --    membership; keyed on the conversation id, not the account.
    or exists (
      select 1
      from public.conversations_agents ca
      join public.agents a on a.id = ca.agent_id
      where ca.conversation_id = conv_id
        and a.user_id = auth.uid()
    );
$$;
