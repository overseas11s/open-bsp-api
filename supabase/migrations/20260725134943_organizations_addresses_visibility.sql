alter table "public"."organizations_addresses" add column "visibility" text not null default 'shared'::text;

alter table "public"."organizations_addresses" add constraint "organizations_addresses_visibility_check" CHECK ((visibility = ANY (ARRAY['shared'::text, 'membership'::text]))) not valid;

alter table "public"."organizations_addresses" validate constraint "organizations_addresses_visibility_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.is_conversation_visible(conv_id uuid, conv_org uuid, conv_addr text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    exists (
      select 1 from public.organizations_addresses oa
      where oa.organization_id = conv_org
        and oa.address = conv_addr
        and oa.visibility = 'shared'
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


