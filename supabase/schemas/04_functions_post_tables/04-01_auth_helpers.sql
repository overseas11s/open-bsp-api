create function public.get_authorized_orgs(role public.role default 'member') returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  req_level int;
  api_key text;
  org_id uuid;
begin
  req_level := case role::text
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  -- First, try JWT authentication via auth.uid()
  if auth.uid() is not null then
    return query select organization_id from public.agents
    where
      user_id = auth.uid()
    -- A deleted agent is a former member: this is what makes marking the row
    -- revoke access rather than merely rename it.
    and deleted_at is null
    and (
      extra->'invitation' is null
      or extra->'invitation'->>'status' = 'accepted'
    )
    and (
      case (extra->>'role')
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    -- Authenticated but lacking the requested role: return the empty set so RLS
    -- subqueries can fall through to other OR-combined policies (e.g. a member
    -- accepting their own invitation while an owner-only policy is also evaluated).
    -- Raising here would short-circuit the whole RLS evaluation.
    -- raise exception using
    --   errcode = '42501',
    --   message = format('insufficient permissions, %s role required', role::text);
    return;
  end if;

  -- Fallback to API key authentication
  api_key := current_setting('request.headers', true)::json->>'api-key';

  if api_key is not null then
    select a.organization_id into org_id
    from public.api_keys a
    where a.key = api_key
    and (
      case (a.role::text)
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if org_id is not null then
      return next org_id;
    end if;
    -- Same reasoning as the JWT branch: invalid key or insufficient role returns
    -- the empty set, not a raise. Validate api-key existence at the request edge
    -- (e.g. a pre-request hook) if you want loud failure for missing/invalid keys.
    -- raise exception using
    --   errcode = '42501',
    --   message = format('invalid api key or insufficient permissions, %s role required', role::text);
    return;
  end if;

  raise exception using
    errcode = '42501',
    message = 'authentication required',
    hint = 'use api-key header or jwt authentication';
end;
$$;

-- Check if agent immutable fields match the original (for UPDATE policies)
create function public.agent_update_by_owner_rules(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean,
  p_extra jsonb
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      -- updating user_id is not allowed
      and user_id is not distinct from p_user_id
      -- prevent from smuggling into another org
      and organization_id = p_organization_id
      -- once created, ai/human cannot be changed
      and ai = p_ai
      -- sent invitations can only be updated by the receiver
      and extra->'invitation' is not distinct from p_extra->'invitation'
  );
end;
$$;

-- Check if org and role are unchanged (for member self-update)
create function public.member_self_update_rules(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean,
  p_extra jsonb
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      -- updating user_id is not allowed
      and user_id = p_user_id
      -- prevent member from smuggling into another org
      and organization_id = p_organization_id
      -- cannot change to ai
      and ai = p_ai
      -- only owners can change update members role
      and extra->>'role' = p_extra->>'role'
  );
end;
$$;

-- Check if organization name is unchanged (for admin updates)
create function public.org_update_by_admin_rules(
  p_id uuid,
  p_name text
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.organizations
    where id = p_id
      -- name cannot be changed by admins
      and name = p_name
  );
end;
$$;

-- Check if contact address fields are unchanged (for contact_id updates)
create function public.contact_address_update_rules(
  p_organization_id uuid,
  p_service public.service,
  p_address text,
  p_extra jsonb,
  p_status text
) returns boolean
language plpgsql
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.contacts_addresses
    where organization_id = p_organization_id
      and address = p_address
      and service = p_service
      and status = p_status
      and extra is not distinct from p_extra
  );
end;
$$;
-- The caller's own agent rows, across every org they belong to. A user has at
-- most one agent per organization (agents_organization_id_user_id_key), so
-- this is "which agent am I here". Set-returning for the same reason as the
-- visibility helpers: `agent_id in (select …)` is an InitPlan evaluated once.
--
-- Empty for API keys — they authenticate without auth.uid() and are nobody in
-- particular, so no policy branch that means "my own row" can ever match one.
create function public.get_own_agents() returns setof uuid
language sql
stable
security definer
set search_path to ''
as $$
  select a.id from public.agents a
  where a.user_id = auth.uid() and a.deleted_at is null;
$$;
