-- Per-agent visibility of conversations on member-owned accounts (e.g. a
-- member's Slack identity). Source of truth: membership of the container on
-- the external service (Slack channel members) intersected with org members
-- who connected that service. Maintained by the service's webhook/management
-- functions with the service role; members only read their own rows (see
-- 05-12). Conversations on shared accounts (organizations_addresses.agent_id
-- is null) do not use this table — they are visible org-wide as before.
create table public.conversations_agents (
  organization_id uuid not null,
  -- The member's personal account this visibility stems from (e.g. their
  -- Slack identity T…:U…) — NOT the shared anchor the conversation hangs off.
  -- Cascade makes "disconnect = delete the personal address row" drop exactly
  -- this connection's visibility, and nothing from other services.
  organization_address text not null,
  conversation_id uuid not null,
  agent_id uuid not null,
  extra jsonb, -- e.g. per-member state: muted, last_read_ts
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations_agents
add constraint conversations_agents_pkey
primary key (conversation_id, agent_id);

alter table only public.conversations_agents
add constraint conversations_agents_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.conversations_agents
add constraint conversations_agents_organization_address_fkey
foreign key (organization_id, organization_address)
references public.organizations_addresses(organization_id, address)
on delete cascade;

alter table only public.conversations_agents
add constraint conversations_agents_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.conversations_agents
add constraint conversations_agents_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete cascade;

-- Default privileges for postgres-created tables only grant
-- truncate/references/trigger to the API roles, so new tables need explicit
-- grants. service_role writes memberships (webhook/management functions);
-- members only read (RLS narrows rows to their own).
grant select, insert, update, delete on table public.conversations_agents to service_role;
grant select on table public.conversations_agents to authenticated;

create index conversations_agents_agent_id_idx
on public.conversations_agents
using btree (agent_id);

create index conversations_agents_organization_id_idx
on public.conversations_agents
using btree (organization_id);

-- Supports the on-delete-cascade lookup from organizations_addresses.
create index conversations_agents_organization_address_idx
on public.conversations_agents
using btree (organization_id, organization_address);

create trigger set_extra
before update
on public.conversations_agents
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.conversations_agents
for each row
execute function public.moddatetime('updated_at');
