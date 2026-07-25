alter table public.conversations_agents enable row level security;

-- Note: visibility rows are managed by the system (service role); members
-- only read.

-- Anyone who can see a conversation can see who else is in it (the
-- participant list — same information Slack itself shows). The subquery runs
-- with the caller's rights, so conversations RLS scopes it; no recursion:
-- that policy checks membership through the SECURITY DEFINER
-- is_conversation_visible(), which reads this table without re-entering RLS.
create policy "members can read memberships of visible conversations"
on public.conversations_agents
for select
to authenticated
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_id
  )
);
