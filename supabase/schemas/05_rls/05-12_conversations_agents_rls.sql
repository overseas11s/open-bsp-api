alter table public.conversations_agents enable row level security;

-- This table does two jobs, and the difference decides every policy below:
--
--   PARTICIPATION  On a mirror service it reflects membership of the external
--                  container (a Slack channel's members), and it GRANTS
--                  VISIBILITY — it is the only way into a restricted
--                  conversation. Service-managed, therefore: a member who
--                  could insert here at will could read any private DM in the
--                  workspace by naming its id.
--
--   PREFERENCES    A row also carries the caller's own state for the
--                  conversation (extra). That job is harmless, and members
--                  own it.
--
-- The write policies exist to let members do the second without doing the
-- first. Each one is either restricted to rows that grant nothing (because
-- the conversation is already visible without them), or restricted to
-- `local`, where participation is a thing members legitimately manage.
--
-- No recursion: the conversations subqueries below run with the caller's
-- rights and are scoped by conversations RLS, which decides membership
-- through SECURITY DEFINER helpers that read this table without re-entering
-- its policies.

-- Anyone who can see a conversation can see who else is in it (the
-- participant list — same information Slack itself shows).
--
-- `to authenticated` only — no anon, unlike the other policies: anon is the
-- API-key path, and membership can never matter to an API key (the only
-- visibility branch that reads this table requires auth.uid(); API keys see
-- org-wide content only). Membership is a user concept. The table grants
-- match (select granted to authenticated, not anon).
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

-- Your own row, on a conversation you can see. This is the preferences case,
-- and it is why the visibility test is the plain one: if you can already read
-- the conversation, a row about you changes nothing about what you can read.
--
-- WITH CHECK re-tests both halves, so the row cannot be re-pointed at a
-- conversation you cannot see. (The participation branch of that test reads
-- this table's pre-statement snapshot, so a row cannot bootstrap its own
-- visibility by moving.)
create policy "members can update their own membership rows"
on public.conversations_agents
for update
to authenticated
using (
  agent_id in (select public.get_own_agents())
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
  )
)
with check (
  agent_id in (select public.get_own_agents())
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
  )
);

-- Creating a row for yourself is only safe where the row grants nothing: the
-- conversation must be visible WITHOUT participation — a shared inbox, or a
-- personal account you own. That is the account rule minus the restricted
-- set, spelled out rather than delegated, because `exists (select 1 from
-- conversations)` would also pass for conversations you can see only BY
-- participating, which is the case this policy must exclude.
--
-- Concretely: a Slack channel the bot is in, yes. A Slack DM between two
-- other members, no — and that stays true if the bot later leaves a channel,
-- since the row you created then stops being enough on its own.
--
-- It also covers self-joining a `local` channel, which is unrestricted by
-- shape. Local groups are handled by the next policy instead.
create policy "members can create their own membership rows"
on public.conversations_agents
for insert
to authenticated
with check (
  agent_id in (select public.get_own_agents())
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and c.organization_id in (select public.get_authorized_orgs('member'))
      and (c.organization_id, c.service, c.organization_address) in (
        select v.organization_id, v.service, v.address
        from public.get_visible_addresses() v
      )
      and c.id not in (select public.get_restricted_conversations())
  )
);

-- `local` groups: anyone already in one may add or remove anyone else. There
-- are no roles yet, so this is deliberately flat — the constraint that matters
-- is that the conversation must be VISIBLE to the caller, and a local group is
-- restricted by shape, so visible means participating. You can only add people
-- to rooms you are in.
--
-- `direct` and `multiple` are absent on purpose, and it is not a size
-- distinction: their roster IS their identity (it is literally their address),
-- so adding a person would not extend the conversation, it would name a
-- different one. Starting that conversation is how you get it.
--
-- `channel` is absent too — joining one is self-service, above.
create policy "members can manage local group membership"
on public.conversations_agents
for insert
to authenticated
with check (
  -- "You can only add people to rooms you are in" — stated, not implied. An
  -- insert consults with-check alone, and permissive with-checks OR across
  -- every policy on the command, so a clause that only describes the SHAPE of
  -- the target conversation grants that shape to everyone: without this line
  -- any authenticated user could add anyone to any local group in the
  -- database, other tenants' included.
  conversation_id in (select public.get_participant_conversations())
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and c.service = 'local'::public.service
      and c.type = 'group'
  )
);

-- Kicking (local groups) and leaving (local channels). Same rosters-are-fixed
-- rule as above: there is no leaving a direct or multiple, because the room
-- without you is a different room.
--
-- Mirror services are absent: a Slack membership row is Slack's fact, and
-- deleting it here would only desync us until the next sync put it back.
create policy "members can delete local membership rows"
on public.conversations_agents
for delete
to authenticated
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and c.service = 'local'::public.service
      and (
        -- Kicking: same rule as adding, and for the same reason — shape alone
        -- would let anyone empty any group in the database.
        (
          c.type = 'group'
          and conversation_id in (select public.get_participant_conversations())
        )
        -- Leaving: naming your own agent is the authority.
        or (
          c.type = 'channel'
          and agent_id in (select public.get_own_agents())
        )
      )
  )
);
