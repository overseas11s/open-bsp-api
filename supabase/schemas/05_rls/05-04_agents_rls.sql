-- EVERY with-check restates its own authority test, and that is not
-- redundancy with the using clause above it. Permissive policies OR by CLAUSE,
-- not by policy: the new row is accepted if ANY policy's with-check passes,
-- whether or not that policy's using clause is what admitted the row. A
-- with-check that only pins columns therefore hands its permission to every
-- other policy on the table.
--
-- That is exactly how a member could promote themselves before this file was
-- rewritten. "owners can update their orgs agents" checked `using (owner)` but
-- its with-check was the column pin alone, and the column pin said nothing
-- about role — so a member selected their own row through "members can update
-- themselves", set role to owner, failed that policy's with-check, and passed
-- the owner policy's. Fixed here; see the CHANGELOG.
--
-- The whole model, in one place: you see everyone in your organizations, you
-- edit yourself, admins edit anyone, owners do anything, and you can leave.
-- Only owners grant roles.
--
-- Two of the nine policies this replaces went with AI agents ceasing to be a
-- category RLS knows about — the `ai` flag is gone, and `user_id is null` says
-- the same thing, so admins reach human and AI agents through one policy
-- instead of a separate pair. A third went with invitations becoming their own table: "members can
-- read themselves" existed because an invitee held an agents row in an
-- organization they had not joined, out of reach of the org-wide read below.
-- By the time such a row exists now, they are a member.

alter table public.agents enable row level security;

create policy "members can read their orgs agents"
on public.agents
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Name, picture, extra. Not your own role — that is the whole point of the
-- role check in the helper.
create policy "members can update themselves"
on public.agents
for update
to authenticated
using (
  user_id = (select auth.uid())
)
with check (
  user_id = (select auth.uid())
  and public.agent_identity_and_role_unchanged(id, user_id, organization_id, role)
);

-- Admins maintain the roster: renaming a colleague, retiring an AI agent's
-- prompt. Everything except who anyone is and what they may do.
create policy "admins can update their orgs agents"
on public.agents
for update
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
  and public.agent_identity_and_role_unchanged(id, user_id, organization_id, role)
);

-- Owners additionally set roles, create AI agents and remove members. Split by
-- action rather than written as `for all` because the identity check below
-- compares against a STORED row: on an insert there is none to compare with,
-- so the same expression cannot serve both.
--
-- `user_id is null` on the insert is what makes invitations the only door for
-- people. An owner may mint AI agents freely; conjuring a row that names a
-- human would hand that person a membership they never accepted. The two
-- paths that legitimately insert a row with a user_id — organization creation
-- and accept_invitation — are SECURITY DEFINER and never see this policy.
create policy "owners can create their orgs agents"
on public.agents
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
  and user_id is null
);

create policy "owners can update their orgs agents"
on public.agents
for update
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
  and public.agent_identity_unchanged(id, user_id, organization_id)
);

create policy "owners can delete their orgs agents"
on public.agents
for delete
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

-- Leaving. The delete is turned into a mark by mark_agent_deleted, and refused
-- outright by prevent_last_owner_deletion if you are the last owner — hand the
-- organization over first.
create policy "members can delete themselves"
on public.agents
for delete
to authenticated
using (
  user_id = (select auth.uid())
);
