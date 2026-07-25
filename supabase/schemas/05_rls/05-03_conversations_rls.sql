alter table public.conversations enable row level security;

-- Intra-org conversations (slack) are visible to their MEMBERS only — even
-- public channels: OpenBSP is not a place to discover and join channels, it
-- mirrors what each member is already in. If channel discovery is ever
-- wanted, add a separate RLS rule here that applies iff the channel is
-- public (conversations.extra->>'channel_type' = 'public_channel') AND the
-- user has a connection to the same workspace (an organizations_addresses
-- row with their agent_id under this conversation's organization_address
-- anchor) — not to the whole org.
create policy "members can manage their orgs conversations"
on public.conversations
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and public.is_conversation_visible(
    id, organization_id, organization_address, service
  )
);