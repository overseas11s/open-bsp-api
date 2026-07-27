-- organization_id is useful for realtime. It could be argued that if there
-- is organization_id then there is room for contact_id, but it is not necessary now.
create table public.messages (
  organization_id uuid not null,
  conversation_id uuid not null,
  id uuid default gen_random_uuid() not null,
  external_id text,
  direction public.direction not null,
  agent_id uuid, -- internal sender (should be not null for internal and outgoing)
  contact_address text, -- external sender (should be not null for incoming)
  -- denormalized properties
  service public.service not null,
  organization_address text not null,
  -- Logical partition of a conversation (Slack/Discord-style threads): the
  -- external_id of the thread's root message, shared by the root (which points
  -- to itself) and all of its replies. null = top-level / main channel
  -- timeline. Soft reference like content.re_message_id — not a FK, so it
  -- tolerates out-of-order arrival and out-of-window roots.
  thread_id text,
  -- Unified peer addressing (transition away from direction + contact_address;
  -- both sides kept in sync by before_insert_on_messages until readers migrate
  -- and the legacy columns get dropped):
  -- conversation_address — the peer the conversation is with (individual or
  --   group/channel). Soft reference, like thread_id.
  -- sender_address — who authored the message; does NOT imply an agent.
  --   null                    → internal (tool calls/results, notes)
  --   = organization_address  → sent by the connected account ("outgoing")
  --   anything else           → sent by a peer ("incoming")
  conversation_address text,
  sender_address text,
  ----
  content jsonb not null,
  status jsonb default jsonb_build_object('pending', now()) not null,
  timestamp timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.messages
add constraint messages_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.messages
add constraint messages_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.messages
add constraint messages_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete set null;

alter table only public.messages
add constraint messages_pkey primary key (id);

alter table only public.messages
add constraint messages_external_id_key unique (external_id);

-- Declared NOT VALID (not inline) to match the deployed state. ~46k legacy
-- messages predate the v1 content schema (no version/kind) and were never
-- checked, so the constraint cannot be validated; it still enforces the shape
-- for every new row. Declaring NOT VALID here keeps `supabase db diff` from
-- re-emitting a drop/re-add on every run. See migration
-- 20260424132025_fix_messages_content_schema_allow_empty.
alter table only public.messages
add constraint messages_content_schema check (
  content = '{}'::jsonb -- status-only upserts (content merged later)
  or (
    content->>'version' is not null
    and content->>'type' in ('text', 'file', 'data')
    and content->>'kind' is not null
  )
) not valid;

create index messages_organization_id_idx
on public.messages
using btree (organization_id);

create index messages_conversation_id_idx
on public.messages
using btree (conversation_id);

create index messages_timestamp_idx
on public.messages
using btree (timestamp);

create index messages_updated_at_idx
on public.messages
using btree (updated_at);

create index messages_org_conv_timestamp_idx
on public.messages
using btree (organization_id, conversation_id, timestamp desc);

-- Media-object → referencing-message lookup (is_media_visible, used by the
-- storage.objects download policy). v1 file parts only: v0 legacy media is
-- not matched, so it stays org-scoped like any unreferenced object.
create index messages_file_uri_idx
on public.messages
using btree ((content->'file'->>'uri'))
where content->'file'->>'uri' is not null;

create trigger handle_new_message
before insert
on public.messages
for each row
execute function public.before_insert_on_messages();

create trigger handle_incoming_message_to_agent
after insert
on public.messages
for each row
when (
  new.sender_address is not null
  and new.sender_address <> new.organization_address
  and (new.status ->> 'pending') is not null
)
execute function public.edge_function('/agent-client', 'post');

create trigger handle_mark_as_read_to_dispatcher
after update
on public.messages
for each row
when (
  new.sender_address is not null
  and new.sender_address <> new.organization_address
  and new.service <> 'local'::public.service
  and (
    (old.status ->> 'read') <> (new.status ->> 'read')
    or (old.status ->> 'typing') <> (new.status ->> 'typing')
  )
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();

create trigger handle_outgoing_message_to_dispatcher
after insert
on public.messages
for each row
when (
  new.sender_address = new.organization_address
  and new.timestamp <= now()
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();

-- There are four sources of account-authored (sender = organization_address)
-- messages:
-- 1. history webhook
-- 2. messages echoes webhook (messages sent from WA Business app)
-- 3. UI
-- 4. agent-client
--
-- 1 and 2 do not set status.pending to avoid dispatch.
-- 2 and 3 should pause the conversation.
create trigger pause_conversation_on_human_message
after insert
on public.messages
for each row
when (
  new.sender_address = new.organization_address
  and new.service <> 'local'::public.service
  and new.timestamp <= now() -- messages not in the future
  and new.timestamp >= now() - interval '10 seconds' -- recent messages
)
execute function public.pause_conversation_on_human_message();

create trigger handle_message_to_media_preprocessor
after insert
on public.messages
for each row
when (
  (
    new.direction = 'outgoing'::public.direction
    or new.direction = 'incoming'::public.direction
  )
  and (new.status ->> 'pending') is not null
  and (new.content ->> 'type') = 'file'
)
execute function public.edge_function('/media-preprocessor', 'post');

create trigger z_notify_webhook_messages
after insert or update
on public.messages
for each row
execute function public.notify_webhook();

create trigger preserve_direction
before update
on public.messages
for each row
execute function public.preserve_message_direction();

create trigger set_message
before update
on public.messages
for each row
when (
  new.content is not null
)
execute function public.merge_update('content');

create trigger set_status
before update
on public.messages
for each row
when (
  new.status is not null
)
execute function public.merge_update('status');

create trigger set_updated_at
before update
on public.messages
for each row
execute function public.moddatetime('updated_at');
