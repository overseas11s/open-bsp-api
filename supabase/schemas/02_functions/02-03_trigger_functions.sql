create function public.lookup_user_id_by_email_before_insert_on_agents() returns trigger
language plpgsql
security definer -- bypass RLS to access auth.users
set search_path to ''
as $$
begin
  -- Check if an invitation already exists for this email in this org (case-insensitive)
  if exists (
    select 1
    from public.agents
    where organization_id = new.organization_id
      and lower(extra->'invitation'->>'email') = lower(new.extra->'invitation'->>'email')
  ) then
    raise exception 'An invitation for this email already exists in this organization';
  end if;

  -- Associate user_id to the agent (auth.users.email is normalized to lowercase
  -- by Supabase, but compare case-insensitively in case the invitation email was
  -- entered with mixed case)
  select id into new.user_id
  from auth.users
  where lower(email) = lower(new.extra->'invitation'->>'email');

  return new;
end;
$$;

-- Auto-associate user_id to agents when new user signs up
create function public.lookup_agents_by_email_after_insert_on_auth_users() returns trigger
language plpgsql
security definer -- bypass RLS to update agents table
set search_path to ''
as $$
begin
  -- Update invitations matching the new user's email (case-insensitive)
  update public.agents
  set user_id = new.id
  where user_id is null
    and lower(extra->'invitation'->>'email') = lower(new.email);

  return new;
end;
$$;

-- Enforce invitation status flow: pending → accepted/rejected only
create function public.enforce_invitation_status_flow() returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if old.extra->'invitation' is not null then -- invitation
    if new.extra->'invitation' is null then -- invitation removed
      raise exception 'Cannot remove invitation';
    end if;

    if new.extra->'invitation'->>'email' is distinct from old.extra->'invitation'->>'email' then
      raise exception 'Cannot change invitation email';
    end if;

    if old.extra->'invitation'->>'status' is distinct from new.extra->'invitation'->>'status' then
      if old.extra->'invitation'->>'status' <> 'pending' then
        raise exception 'Cannot change invitation status from %', old.extra->'invitation'->>'status';
      end if;
    
      if new.extra->'invitation'->>'status' not in ('accepted', 'rejected') then
        raise exception 'Invitation status can only be changed to accepted or rejected';
      end if;
    end if;
  else -- no invitation; original owner
    if new.extra->'invitation' is not null then
      raise exception 'Cannot add invitation to existing agent';
    end if;
  end if;

  return new;
end;
$$;

-- Create local address and owner agent after org creation
create function public.after_insert_on_organizations() returns trigger
language plpgsql
security definer -- bypass RLS to create the first owner
set search_path to ''
as $$
declare
  user_id uuid := auth.uid();
  user_name text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (new.id, 'local', new.id::text);

  if user_id is not null then
    select coalesce(raw_user_meta_data->>'full_name', email, '?') into user_name
    from auth.users
    where id = user_id;

    insert into public.agents (organization_id, user_id, name, ai, extra)
    values (new.id, user_id, user_name, false, '{"role": "owner"}');
  end if;

  return new;
end;
$$;

-- A conversation's identity is its address, so the address never changes.
-- Nothing legitimate needs it to: an ingestor upserts on the identity index,
-- and `local` mints the address at creation. Anything that could move it could
-- also point a room it owns at two colleagues' canonical roster, and make the
-- DM between them impossible — the identity index would already be taken.
--
-- `type` is immutable to API roles for a sharper reason: retyping a private
-- `multiple` as `channel` publishes everyone else's messages to the whole
-- organization, and any one participant could do it with no role to stop them.
-- The service role keeps the write, because Slack really does convert a
-- private channel to a public one and the sync must follow.
--
-- RLS cannot express either: an UPDATE policy sees the old row in USING and
-- the new row in WITH CHECK, never both, so "this column may not change" has
-- to be a trigger. Same reason preserve_message_direction exists.
create function public.preserve_conversation_identity() returns trigger
language plpgsql
as $$
begin
  new.conversation_address := old.conversation_address;

  if current_role not in ('service_role', 'postgres', 'supabase_admin') then
    new.type := old.type;
  end if;

  return new;
end;
$$;

-- A deletion the deleted can undo is not a deletion. `members can update
-- themselves` is keyed on user_id = auth.uid() alone, so a removed member
-- reaches their own row and could otherwise clear deleted_at and restore every
-- access it revoked.
create function public.preserve_agent_deletion() returns trigger
language plpgsql
as $$
begin
  if current_role not in ('service_role', 'postgres', 'supabase_admin') then
    new.deleted_at := old.deleted_at;
  end if;

  return new;
end;
$$;

-- Prevent deletion of the last owner in an organization
create function public.prevent_last_owner_deletion() returns trigger
language plpgsql
set search_path to ''
as $$
declare
  owner_count int;
begin
  -- Skip check if org is being deleted (cascade delete)
  if not exists (
    select 1 from public.organizations
    where id = old.organization_id
    for update skip locked
  ) then
    return old;
  end if;

  if old.extra->>'role' = 'owner' then
    select count(*) into owner_count
    from public.agents
    where organization_id = old.organization_id
      and extra->>'role' = 'owner'
      and (
        extra->>'invitation' is null
        or extra->'invitation'->>'status' = 'accepted'
      )
      and deleted_at is null
      and id <> old.id;

    if owner_count = 0 then
      raise exception 'Cannot delete the last owner of an organization';
    end if;
  end if;

  return old;
end;
$$;

-- Deleting an agent marks the row instead of removing it, for every agent —
-- hence its own trigger rather than a branch in the owner guard above, whose
-- WHEN clause narrows it to human owners.
--
-- An agent is referenced by things that outlive their membership: message
-- authorship, and — since local conversations are identified by their roster —
-- the very ADDRESS of every direct and multiple they are in. Removing the row
-- cascades away their participation while the address goes on naming them,
-- leaving a conversation that can never be repaired and a roster slot occupied
-- forever.
--
-- SECURITY DEFINER for two reasons: the caller has no UPDATE on someone else's
-- agent row, and preserve_agent_deletion would restore the old deleted_at for
-- any non-privileged role — including the member deleting themselves.
--
-- The same organizations probe as above: during an organization cascade the
-- parent row is locked, SKIP LOCKED finds nothing, and the delete is allowed
-- through — otherwise a suppressed cascade would leave the FK unsatisfiable
-- and the organization undeletable.
create function public.mark_agent_deleted() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (
    select 1 from public.organizations
    where id = old.organization_id
    for update skip locked
  ) then
    return old;
  end if;

  update public.agents
  set deleted_at = coalesce(deleted_at, now())
  where id = old.id;

  return null;
end;
$$;

-- SECURITY DEFINER because this is now the ONLY way a conversation gets
-- created for a mirror service: 05-03 grants INSERT on conversations to API
-- roles for `local` alone, so a member starting a WhatsApp chat does it by
-- inserting the first message and letting this trigger mint the row. The
-- elevation cannot be used to reach a conversation the caller may not see —
-- the messages WITH CHECK policy runs after BEFORE triggers, so it re-tests
-- visibility against the conversation_id this function just resolved.
create function public.before_insert_on_messages() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Transition compat (direction → sender_address, contact_address →
  -- conversation_address): legacy writers still send direction +
  -- contact_address; new writers send sender_address/conversation_address
  -- only. Derive whichever side is missing so both stay consistent until
  -- direction and contact_address are dropped.
  --
  -- sender_address is a contact reference or null: the peer who authored the
  -- message (a phone/BSUID, a Slack workspace member — ties to
  -- contacts_addresses), or null when the account itself spoke. Deliverable
  -- vs record-only is decided by content kind + status.pending, not by
  -- authorship (see the dispatch trigger's kind whitelist).
  if new.conversation_address is null then
    new.conversation_address := new.contact_address;
  end if;

  if new.sender_address is null and new.direction = 'incoming'::public.direction then
    new.sender_address := new.contact_address;
  elsif new.direction is null then
    new.direction := case
      when new.sender_address is not null then 'incoming'::public.direction
      when new.content->'tool' is not null then 'internal'::public.direction
      else 'outgoing'::public.direction
    end;
  end if;

  -- Internal rows (tool traces, notes, agent errors) are record-only and
  -- never need the pending arm bit — strip it so no automation (dispatch,
  -- retry sweeps, media preprocessing) can ever pick them up. This also IS
  -- the deprecation of dispatching agent errors.
  if new.direction = 'internal'::public.direction then
    new.status := new.status - 'pending';
  end if;

  -- If conversation_id is already provided, proceed as is
  if new.conversation_id is not null then
    return new;
  end if;

  -- Look up conversation_id. A conversation IS a channel, so this is an exact
  -- hit on conversations_identity_idx — no `status` predicate (the session
  -- dimension is gone) and no most-recent tiebreak (the key is unique).
  --
  -- organization_id is in the predicate so the scan can start from the index's
  -- leading column. Plain equality throughout: conversation_address is never
  -- null, so the old `is not distinct from` — which is not indexable and
  -- degraded it to a filter over every conversation on the account — is gone.
  --
  -- A peerless (local) message with neither conversation_id nor
  -- conversation_address matches nothing and falls through to the insert
  -- below, where the conversations trigger mints an id for it.
  if new.conversation_address is not null then
    select id into new.conversation_id
    from public.conversations
    where organization_id = new.organization_id
      and service = new.service
      and organization_address = new.organization_address
      and conversation_address = new.conversation_address;
  end if;

  -- Create conversation if it doesn't exist. The legacy contact_address is
  -- only meaningful on direct chats (peer = a contact); in group messages
  -- contact_address carries the per-message sender, which must not become
  -- the conversation's peer.
  if new.conversation_id is null then
    insert into public.conversations (
      organization_id,
      organization_address,
      conversation_address,
      contact_address,
      service
    ) values (
      new.organization_id,
      new.organization_address,
      new.conversation_address,
      case
        when new.contact_address = new.conversation_address
        then new.contact_address
      end,
      new.service
    )
    returning id into new.conversation_id;
  end if;

  return new;
end;
$$;

-- BEFORE UPDATE: addressing is fill-once. direction/conversation_address are
-- set at insert and never change; sender_address may be FILLED (null → the
-- actual author) but never flipped — the Slack echo of a send from OpenBSP
-- updates the dispatched row (sender null) with the member who sent it, while
-- an Instagram self-message echo landing on an already-attributed row cannot
-- rewrite it. Updates otherwise only merge content/status.
create function public.preserve_message_direction() returns trigger
language plpgsql
as $$
begin
  new.direction := old.direction;
  new.sender_address := coalesce(old.sender_address, new.sender_address);
  new.conversation_address := old.conversation_address;

  -- Internal rows can never be armed — not even by a later merged update.
  -- This runs BEFORE set_status (trigger order is alphabetical), so the
  -- merge never sees a pending key.
  if old.direction = 'internal'::public.direction and new.status is not null then
    new.status := new.status - 'pending';
  end if;

  return new;
end;
$$;

-- BEFORE trigger: creates contact on ADD, unlinks on REMOVE.
-- Must stay BEFORE to modify new.contact_id.
create function public.manage_contact_on_address_sync() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Case 1: Synced Action = ADD
  if new.extra->'synced'->>'action' = 'add' then
    if old is not null and old.contact_id is not null then
      -- Preserve existing link: the upsert payload doesn't include contact_id,
      -- so new.contact_id would be null and overwrite the existing link.
      new.contact_id := old.contact_id;
    elsif new.contact_id is null then
      -- No contact linked from either side, create one
      insert into public.contacts (
        organization_id,
        name
      ) values (
        new.organization_id,
        new.extra->'synced'->>'name'
      ) returning id into new.contact_id;
    end if;
  end if;

  -- Case 2: Synced Action = REMOVE
  -- Unlink. The orphan cleanup happens in the AFTER trigger below to avoid
  -- error 27000 ("tuple to be updated was already modified by an operation
  -- triggered by the current command") caused by the ON DELETE SET NULL
  -- cascade touching the current row.
  -- Note: the address itself might be deleted by cleanup_unlinked_address_if_empty.
  if new.extra->'synced'->>'action' = 'remove' then
    new.contact_id := null;
  end if;

  return new;
end;
$$;

-- AFTER trigger: cleans up orphaned contact when the last address that
-- referenced it is unlinked via a REMOVE sync event.
create function public.cleanup_orphaned_contact_on_sync() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _active_count int;
begin
  -- At this point new.contact_id is null (set by manage_contact_on_address_sync).
  -- Count any other active addresses still referencing the old contact.
  select count(*) into _active_count
  from public.contacts_addresses
  where contact_id = old.contact_id
    and status = 'active';

  -- If no other addresses reference it, delete the orphaned contact.
  if _active_count = 0 then
    delete from public.contacts where id = old.contact_id;
  end if;

  return null;
end;
$$;

-- 1. Manual unlink by user
-- 2. Unlink caused by contact deletion (via ON DELETE SET NULL constraint)
create function public.cleanup_unlinked_address_if_empty() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only if we became unlinked (contact_id IS NULL)
  if new.contact_id is null and old.contact_id is not null then
    -- If no conversations, delete the address
    if not exists (
      select 1 from public.conversations c
      where c.organization_id = new.organization_id
        and c.service = new.service
        and c.contact_address = new.address
    ) then
      delete from public.contacts_addresses
      where organization_id = new.organization_id
        and service = new.service
        and address = new.address;
    end if;
  end if;

  return null;
end;
$$;

-- Derives conversations_agents.service from the conversation the row is in.
--
-- The column exists so the reference to organizations_addresses can name a
-- whole account key, not because a membership decides its own service — a
-- Slack membership stems from a Slack identity, and the conversation already
-- says so. Deriving it keeps the two from ever disagreeing, and keeps `service`
-- out of the write contract: members insert their own rows through 05-12, and
-- asking a client to restate a value it cannot choose only invites a wrong one.
-- The FK checks (organization_id, service, organization_address) against a real
-- account either way, so a stated service could pass that check while naming a
-- different service than the conversation's.
--
-- Runs on UPDATE too: conversation_id is not immutable here, so a row moved to
-- another conversation re-derives instead of keeping the old service.
create function public.set_conversation_agent_service() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select c.service into new.service
  from public.conversations c
  where c.id = new.conversation_id;

  return new;
end;
$$;

-- Writes the participants of a `local` conversation.
--
-- `local` is the one service where a member creates the conversation directly
-- (05-03 grants INSERT for it alone), and the one whose visibility is decided
-- purely by shape: a `channel` is org-wide, everything else is participants
-- only. So without these rows the member who just created a conversation could
-- not see it.
--
-- Where the participants come from depends on the shape, and it is the same
-- split as the address (before_insert_on_conversations):
--
--   direct, multiple  The roster IS the identity, so it is read straight back
--                     out of the canonical address — which is why they are
--                     always roster-addressed, including a note to self.
--                     Fixed here, for good: 05-12 grants no member insert or
--                     delete for these two, because changing who is in one
--                     would make it a different conversation.
--   group, channel    Membership is mutable and starts with the creator alone;
--                     everyone else arrives through 05-12.
--
-- SECURITY DEFINER: conversations_agents is service-managed for the shapes
-- that matter (05-12), so the caller has no INSERT of their own here. A
-- service-role or API-key insert has no auth.uid() and so no creator to
-- record — for group/channel that yields a conversation nobody is in (see
-- TODO).
create function public.after_insert_on_local_conversation() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- service is omitted on purpose: set_conversation_agent_service derives it,
  -- here as for every other writer.
  insert into public.conversations_agents (
    organization_id,
    organization_address,
    conversation_id,
    agent_id
  )
  select
    new.organization_id,
    new.organization_address,
    new.id,
    a.id
  from public.agents a
  where a.organization_id = new.organization_id
    and case
      when new.type in ('direct', 'multiple')
      then a.id::text = any (string_to_array(new.conversation_address, ':'))
      else a.user_id = auth.uid()
    end
  on conflict do nothing;

  return new;
end;
$$;

create function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _existing_address text;
  _declared text[];
  _unknown text[];
  _roster uuid[];
  _caller uuid;
begin
  -- Transition compat: derive conversation_address from the legacy column.
  if new.conversation_address is null then
    new.conversation_address := new.contact_address;
  end if;

  -- `local` addresses itself, in one of two ways, and the client chooses by
  -- stating a type:
  --
  --   group / channel   A named container whose membership changes. Identity
  --                     is its own; it gets the row's id, further down.
  --   anything else     A ROSTER. The client says who is in it ('A:B:C', any
  --                     order) and this canonicalises to sorted agent ids.
  --                     That canonical form IS the identity, so the unique
  --                     index answers "does this conversation already exist
  --                     between these people" with a conflict — for two
  --                     participants and for eight alike. direct and multiple
  --                     differ only in how many ids there are, so neither is
  --                     a special case of the other.
  --
  -- The author is always in the room they open, so it is added rather than
  -- demanded: you cannot start a conversation you are not in, and omitting the
  -- address entirely is then just a roster of one — a note to self, which is
  -- what the UI's "new conversation" has always produced. One of those per
  -- member, for the same reason there is one DM per pair.
  if new.service = 'local'
    and (new.type is null or new.type in ('direct', 'multiple'))
  then
    -- Null for the service role, which has no agent of its own; a roster it
    -- states is taken as given.
    select a.id into _caller
    from public.agents a
    where a.organization_id = new.organization_id
      and a.user_id = auth.uid();

    _declared := array_remove(
      coalesce(string_to_array(new.conversation_address, ':'), '{}'), ''
    );

    if _caller is not null then
      _declared := _declared || _caller::text;
    end if;

    -- Named before resolved, so the error can say WHICH id failed. Every
    -- malformed roster arrives here: a stranger's id, an agent of another
    -- organization, an uppercased uuid (agent ids render lowercase), a word
    -- that is not a uuid at all.
    _unknown := array(
      select distinct d
      from unnest(_declared) d
      where not exists (
        select 1 from public.agents a
        where a.organization_id = new.organization_id and a.id::text = d
      )
    );

    if array_length(_unknown, 1) is not null then
      raise exception 'Roster names %, not an agent of this organization',
        array_to_string(_unknown, ', ');
    end if;

    -- distinct: naming someone twice is a typo, not a bigger room.
    select array_agg(distinct a.id order by a.id) into _roster
    from public.agents a
    where a.organization_id = new.organization_id
      and a.id::text = any (_declared);

    if _roster is not null then
      new.conversation_address := array_to_string(_roster, ':');

      -- Size decides the shape, so the two can never disagree.
      if array_length(_roster, 1) > 2 then
        new.type := 'multiple';
      else
        new.type := 'direct';
      end if;
    end if;
  end if;

  -- A named container is identified by ITSELF, so its address is not the
  -- client's to choose. A supplied address could name the canonical roster of
  -- two other people — a `group` addressed 'B:C' would occupy the identity
  -- index and make the DM between B and C impossible forever, while neither
  -- could see or delete the row holding it.
  if new.service = 'local' and new.type in ('group', 'channel') then
    new.conversation_address := new.id::text;
  end if;

  -- A conversation minted without a stated shape is 1:1 — that is what an
  -- inbound message from an unknown peer means, and it is the only shape
  -- WhatsApp Cloud and Instagram have. Connectors that know better state it
  -- before the message lands (generic-webhook, for whatsapp-web group JIDs and
  -- broadcast lists).
  --
  -- `slack` is exempt: its ingestor classifies asynchronously and relies on a
  -- null meaning "ask conversations.info again", which a default would erase.
  if new.type is null and new.service <> 'slack' then
    new.type := 'direct';
  end if;

  -- Conversations with external services must have a peer.
  if new.service <> 'local' and new.conversation_address is null then
    raise exception 'Conversations with external services require a conversation_address';
  end if;

  -- A `local` group or channel is identified by itself, not by who is in it,
  -- so it addresses itself: the conversation's own id. Column defaults are
  -- applied before BEFORE-INSERT triggers run, so new.id is already there.
  -- Keeping the column NOT NULL is what lets the identity index be a plain
  -- unique constraint rather than one whose behaviour depends on NULL
  -- semantics.
  if new.conversation_address is null then
    new.conversation_address := new.id::text;
  end if;

  -- Contact bootstrap applies to legacy individual-peer writers only; new
  -- writers manage contacts_addresses themselves (soft reference by design).
  if new.contact_address is null then
    return new;
  end if;

  select address into _existing_address
  from public.contacts_addresses
  where organization_id = new.organization_id
    and service = new.service
    and address = new.contact_address
  order by created_at desc
  limit 1;

  if _existing_address is null then
    insert into public.contacts_addresses (
      organization_id,
      address,
      service
    ) values (
      new.organization_id,
      new.contact_address,
      new.service
    );
  end if;

  return new;
end;
$$;

create function public.notify_webhook() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_record record;
  headers jsonb;
begin
  -- loop through all matching webhooks
  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where new.organization_id = w.organization_id
      and w.table_name = tg_table_name::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
    limit 3
  loop
    -- prepare headers
    headers := case
      when webhook_record.token is not null then
        jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || webhook_record.token
        )
      else
        jsonb_build_object(
          'content-type', 'application/json'
        )
      end;

    -- send webhook notification
    perform net.http_post(
      url := webhook_record.url,
      body := jsonb_build_object(
        'data', to_jsonb(new),
        'entity', tg_table_name,
        'action', lower(tg_op)
      ),
      headers := headers
    );
  end loop;

  return new;
end;
$$;
