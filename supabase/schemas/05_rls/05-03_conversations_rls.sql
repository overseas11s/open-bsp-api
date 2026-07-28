alter table public.conversations enable row level security;

-- The account rule decides unless the conversation overrides it: see
-- 04-02_visibility_helpers.sql. conversations_system.private is what a Slack
-- member's DM uses to stay private even though the workspace anchor it hangs
-- off is ownerless (that anchor holds the bot, i.e. the shared inbox). Do NOT
-- reintroduce that flag on conversations.extra: authenticated AND anon hold
-- UPDATE there, so any caller who can see a conversation could publish it to
-- the whole org.
create policy "members can manage their orgs conversations"
on public.conversations
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  -- Account rule, minus conversations whose override says private; or
  -- participation. All three subqueries are InitPlans (evaluated once, then
  -- hash-probed per row). See 04-02_visibility_helpers.sql.
  and (
    (
      (organization_id, organization_address) in (
        select v.organization_id, v.address from public.get_visible_addresses() v
      )
      and id not in (select public.get_private_conversations())
    )
    or id in (select public.get_participant_conversations())
  )
);