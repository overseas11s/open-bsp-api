-- A conversation is visible when:
--   1. its organization address has visibility 'shared' — the org-wide
--      shared-inbox behavior of every pre-Slack account. NOT keyed on
--      agent_id: the Slack workspace anchor is ownerless yet 'membership';
--   2. the requesting user owns the address (their personal account); or
--   3. the requesting user is listed in conversations_agents.
--
-- There is deliberately NO role bypass: owners/admins cannot read a member's
-- personal conversations. API keys authenticate without auth.uid(), so they
-- only ever see shared-account content (org-scoped keys don't pierce member
-- privacy either).
create function public.is_conversation_visible(
  conv_id uuid,
  conv_org uuid,
  conv_addr text
) returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select
    exists (
      select 1 from public.organizations_addresses oa
      where oa.organization_id = conv_org
        and oa.address = conv_addr
        and oa.visibility = 'shared'
    )
    or exists (
      select 1
      from public.organizations_addresses oa
      join public.agents a on a.id = oa.agent_id
      where oa.organization_id = conv_org
        and oa.address = conv_addr
        and a.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.conversations_agents ca
      join public.agents a on a.id = ca.agent_id
      where ca.conversation_id = conv_id
        and a.user_id = auth.uid()
    );
$$;
