-- System-controlled facts about a conversation: the ones a member must not be
-- able to rewrite. The counterpart to conversations.extra, which is a PUBLIC
-- bag — `authenticated` AND `anon` hold UPDATE on conversations, and set_extra
-- merges, so any caller who can see a conversation can patch a single key of
-- its extra. That is fine for cosmetic state (rename a channel and drift from
-- Slack if you like) and unacceptable for anything visibility depends on.
--
-- The separation is the security boundary, not the column list: this table
-- grants no write to authenticated/anon and carries no write policy, so only
-- the service role (webhooks, management functions) can change it. Expect
-- sibling <table>_system tables for other tables whose extra is public.
--
-- One row per conversation, created lazily by the ingesting webhook — absence
-- means "nothing system-controlled recorded yet", which every reader must
-- treat as the restrictive case (unclassified, not org-visible).
create table public.conversations_system (
  conversation_id uuid not null,
  -- Denormalized from conversations so visibility lookups can filter by org
  -- without joining, and so the row dies with the org.
  organization_id uuid not null,
  -- Container kind on the external service, authoritative once set. Written
  -- from conversations.info / users.conversations (is_im / is_mpim /
  -- is_private), never from an event payload's own vocabulary — those differ
  -- per event type and are ambiguous (see _shared/slack_events.ts).
  channel_type text,
  -- Visible to every member of the organization, regardless of who
  -- participates. Set for containers the workspace bot is in; the bot's
  -- presence is the sanctioning act. Default false: a conversation is never
  -- org-wide unless something deliberately says so.
  org_visible boolean not null default false,
  -- System-controlled counterpart to conversations.extra.
  extra jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations_system
add constraint conversations_system_pkey
primary key (conversation_id);

alter table only public.conversations_system
add constraint conversations_system_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.conversations_system
add constraint conversations_system_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.conversations_system
add constraint conversations_system_channel_type_check
check (
  channel_type is null
  or channel_type in ('im', 'mpim', 'private_channel', 'public_channel')
);

-- Default privileges for postgres-created tables only grant
-- truncate/references/trigger to the API roles, so new tables need explicit
-- grants. Deliberately no insert/update/delete for authenticated or anon —
-- that omission is what makes this table tamper-proof.
grant select, insert, update, delete on table public.conversations_system to service_role;
grant select on table public.conversations_system to authenticated;
grant select on table public.conversations_system to anon;

-- Drives the org-wide visibility branch of get_visible_conversations().
create index conversations_system_org_visible_idx
on public.conversations_system
using btree (organization_id)
where org_visible;

create trigger set_extra
before update
on public.conversations_system
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.conversations_system
for each row
execute function public.moddatetime('updated_at');
