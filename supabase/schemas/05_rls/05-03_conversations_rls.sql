alter table public.conversations enable row level security;

-- Intra-org conversations (slack) are visible to their MEMBERS only, by
-- default even public channels: OpenBSP is not a place to discover and join
-- channels, it mirrors what each member is already in. The one way out is
-- conversations_system.org_visible, which get_visible_conversations() folds
-- in — set by the system for containers the workspace bot is in, and
-- unsettable by members because that table grants them no write. Do NOT
-- reintroduce this as a flag on conversations.extra: authenticated AND anon
-- hold UPDATE there, so any caller who can see a conversation could publish
-- it to the whole org.
create policy "members can manage their orgs conversations"
on public.conversations
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  -- Set membership, not a per-row function call: both subqueries are
  -- InitPlans (evaluated once, then hash-probed per row). See
  -- 04-02_visibility_helpers.sql.
  and (
    (organization_id, organization_address) in (
      select v.organization_id, v.address from public.get_visible_addresses() v
    )
    or id in (select public.get_visible_conversations())
  )
);