alter table public.conversations_agents enable row level security;

-- Note: visibility rows are managed by the system (service role) — members
-- can only read their own.

create policy "members can read their own conversation memberships"
on public.conversations_agents
for select
to authenticated
using (
  exists (
    select 1 from public.agents a
    where a.id = agent_id
      and a.user_id = auth.uid()
  )
);
