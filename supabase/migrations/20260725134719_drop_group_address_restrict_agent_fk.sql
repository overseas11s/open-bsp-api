drop policy "members can read their own conversation memberships" on "public"."conversations_agents";

alter table "public"."organizations_addresses" drop constraint "organizations_addresses_agent_id_fkey";

drop index if exists "public"."conversations_group_address_idx";

alter table "public"."conversations" drop column "group_address";

alter table "public"."messages" drop column "group_address";

alter table "public"."organizations_addresses" add constraint "organizations_addresses_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE RESTRICT not valid;

alter table "public"."organizations_addresses" validate constraint "organizations_addresses_agent_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.before_insert_on_conversations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Transition compat (direction → sender_address, contact_address →
  -- conversation_address): legacy writers still send direction +
  -- contact_address; new writers send sender_address/conversation_address
  -- only. Derive whichever side is missing so both stay consistent until
  -- direction and contact_address are dropped.
  if new.conversation_address is null then
    new.conversation_address := new.contact_address;
  end if;

  if new.sender_address is null and new.direction is not null then
    new.sender_address := case new.direction
      when 'outgoing'::public.direction then new.organization_address
      when 'incoming'::public.direction then new.contact_address
      else null -- internal
    end;
  elsif new.direction is null then
    new.direction := case
      when new.sender_address is null then 'internal'::public.direction
      when new.sender_address = new.organization_address then 'outgoing'::public.direction
      else 'incoming'::public.direction
    end;
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
$function$
;


  create policy "members can read memberships of visible conversations"
  on "public"."conversations_agents"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE (c.id = conversations_agents.conversation_id))));



