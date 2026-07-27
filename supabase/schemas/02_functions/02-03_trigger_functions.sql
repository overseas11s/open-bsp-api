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
      and id <> old.id;

    if owner_count = 0 then
      raise exception 'Cannot delete the last owner of an organization';
    end if;
  end if;

  return old;
end;
$$;

create function public.before_insert_on_messages() returns trigger
language plpgsql
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

  -- Look up conversation_id from conversation table. Conversations are keyed
  -- by conversation_address (the peer — individual or group/channel; the
  -- per-message author lives on messages.sender_address). Local-service
  -- messages have no peer, hence `is not distinct from`.
  select id into new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and conversation_address is not distinct from new.conversation_address
    and service = new.service
    and status = 'active'
  order by created_at desc
  limit 1;

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

create function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _existing_address text;
begin
  -- Transition compat: derive conversation_address from the legacy column.
  if new.conversation_address is null then
    new.conversation_address := new.contact_address;
  end if;

  -- Conversations with external services must have a peer
  if new.service <> 'local' and new.conversation_address is null then
    raise exception 'Conversations with external services require a conversation_address';
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

create function public.pause_conversation_on_human_message() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  agent_is_ai boolean;
begin
  -- Check if message is from a human (null agent_id or agent with ai = false)
  if new.agent_id is not null then
    select ai into agent_is_ai
    from public.agents
    where id = new.agent_id;

    -- If agent exists and is AI, don't pause
    if agent_is_ai = true then
      return new;
    end if;
  end if;

  update public.conversations
  set extra = jsonb_build_object('paused', now())
  where id = new.conversation_id;

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
