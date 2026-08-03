-- An invitation is a pending offer of membership, not a member: an agents
-- row means a member, unconditionally. Keeping the pending state in its own
-- table means no access helper needs an exclusion clause it could forget —
-- and forgetting one anywhere would grant access to someone who never
-- replied.
--
-- EMAIL is the key. The invitee typically has no auth user yet, and when they
-- do they are not in the organization, so nothing about them can be named by
-- id at invitation time. Their identity is resolved once, at acceptance, from
-- the JWT.
create table public.invitations (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  email text not null,
  -- The role the agent gets on acceptance. Stated by the inviter, applied by
  -- accept_invitation, and never by the invitee: this is the only path by
  -- which someone new arrives with a role, so it is the only place the role
  -- can be chosen for them.
  role public.role default 'member'::public.role not null,
  -- text with a check rather than an enum, for the reason documented on
  -- conversations.type: RLS references this column, and `db diff` cannot add a
  -- value to an enum a policy depends on.
  status text default 'pending' not null,
  invited_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.invitations
add constraint invitations_pkey
primary key (id);

alter table only public.invitations
add constraint invitations_status_check
check (status in ('pending', 'accepted', 'rejected', 'revoked'));

alter table only public.invitations
add constraint invitations_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

-- Provenance only. Agents are marked deleted rather than removed, so this
-- nulls in practice only when the organization is being dropped anyway.
alter table only public.invitations
add constraint invitations_invited_by_fkey
foreign key (invited_by)
references public.agents(id)
on delete set null;

-- One open offer per address per organization — the constraint the old
-- implementation faked with a trigger that ran a lookup and raised. Partial,
-- so a rejected or revoked invitation does not block a later one; lowered,
-- because auth.users normalises email and an invitation typed in mixed case
-- must still collide with it.
create unique index invitations_pending_email_key
on public.invitations
using btree (organization_id, lower(email))
where status = 'pending';

-- "My pending invitations", the signed-in user's cross-organization lookup
-- behind the banner on the conversations page. No organization to scope it by
-- — that is the point of an invitation — so email is all there is to index.
create index invitations_email_idx
on public.invitations
using btree (lower(email))
where status = 'pending';

create trigger set_updated_at
before update
on public.invitations
for each row
execute function public.moddatetime('updated_at');

-- Default privileges for postgres-created tables only grant the owner, so the
-- API roles need these explicitly. Rows are narrowed by 05-13; anon is here
-- because an owner-scoped API key may run the invitation flow, exactly as it
-- may on agents.
grant select, insert, update, delete on table public.invitations to service_role;
grant select, insert, update, delete on table public.invitations to authenticated, anon;
