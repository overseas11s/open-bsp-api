alter table public.conversations_system enable row level security;

-- Read-only for everyone but the service role: there is no insert/update/
-- delete policy here, and none of those privileges are granted either. Both
-- barriers are deliberate — this table exists precisely because
-- conversations.extra is writable by any caller who can see the conversation.

-- Whoever can see the conversation can see its system facts. The subquery
-- runs with the caller's rights, so conversations RLS scopes it. No
-- recursion: the conversations policy resolves visibility through
-- SECURITY DEFINER helpers, which read this table without re-entering RLS.
create policy "members can read system facts of visible conversations"
on public.conversations_system
for select
to authenticated, anon
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_id
  )
);
