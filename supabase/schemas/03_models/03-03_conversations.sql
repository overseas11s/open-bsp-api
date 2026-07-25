create table public.conversations (
  organization_id uuid not null,
  id uuid default gen_random_uuid() not null,
  service public.service not null,
  organization_address text not null,
  contact_address text, -- legacy, direct chats only; superseded by conversation_address
  -- The peer this conversation is with — an individual or a group/channel
  -- address (e.g. WhatsApp phone/group JID, Slack channel id). Soft reference
  -- (no FK): peers span contacts and external containers. Replaces
  -- contact_address (kept populated by legacy writers until readers migrate,
  -- then dropped) and the never-productive group_address (already dropped).
  conversation_address text,
  name text,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations
add constraint conversations_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.conversations
add constraint conversations_pkey
primary key (id);

-- Cascade (decided 2026-07-24): deleting a connected account deletes its
-- conversations, and messages cascade via conversations_id in turn.
alter table only public.conversations
add constraint conversations_organization_address_fkey
foreign key (organization_id, organization_address)
references public.organizations_addresses(organization_id, address)
on delete cascade;

alter table only public.conversations
add constraint conversations_contact_address_fkey
foreign key (organization_id, service, contact_address)
references public.contacts_addresses(organization_id, service, address)
on delete no action;

create index conversations_organization_id_idx
on public.conversations
using btree (organization_id);

create index conversations_updated_at_idx
on public.conversations
using btree (updated_at);

create index conversations_organization_address_idx
on public.conversations
using btree (organization_address);

create index conversations_contact_address_idx
on public.conversations
using btree (contact_address);

create index conversations_conversation_address_idx
on public.conversations
using btree (conversation_address);

create trigger handle_new_conversation
before insert
on public.conversations
for each row
execute function public.before_insert_on_conversations();

create trigger z_notify_webhook_conversations
after insert or update
on public.conversations
for each row
execute function public.notify_webhook();

create trigger set_extra
before update
on public.conversations
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.conversations
for each row
execute function public.moddatetime('updated_at');
