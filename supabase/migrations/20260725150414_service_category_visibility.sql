drop policy "members can manage their orgs conversations" on "public"."conversations";

drop policy "members can create their orgs messages" on "public"."messages";

drop policy "members can read their orgs messages" on "public"."messages";

alter table "public"."organizations_addresses" drop constraint "organizations_addresses_visibility_check";

drop function if exists "public"."is_conversation_visible"(conv_id uuid, conv_org uuid, conv_addr text);

alter table "public"."organizations_addresses" drop column "visibility";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.is_conversation_visible(conv_id uuid, conv_org uuid, conv_addr text, conv_service public.service)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    (
      conv_service not in ('slack', 'discord', 'teams')
      and exists (
        select 1 from public.organizations_addresses oa
        where oa.organization_id = conv_org
          and oa.address = conv_addr
          and oa.agent_id is null
      )
    )
    or exists (
      select 1
      from public.organizations_addresses oa
      join public.agents a on a.id = oa.agent_id
      where oa.organization_id = conv_org
        and oa.address = conv_addr
        and a.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.conversations_agents ca
      join public.agents a on a.id = ca.agent_id
      where ca.conversation_id = conv_id
        and a.user_id = auth.uid()
    );
$function$
;


  create policy "members can manage their orgs conversations"
  on "public"."conversations"
  as permissive
  for all
  to authenticated, anon
using (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND public.is_conversation_visible(id, organization_id, organization_address, service)));



  create policy "members can create their orgs messages"
  on "public"."messages"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND public.is_conversation_visible(conversation_id, organization_id, organization_address, service)));



  create policy "members can read their orgs messages"
  on "public"."messages"
  as permissive
  for select
  to authenticated, anon
using (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND public.is_conversation_visible(conversation_id, organization_id, organization_address, service)));



