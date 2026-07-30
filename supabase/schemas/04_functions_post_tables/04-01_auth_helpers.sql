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
    -- Aliased because the parameter is also called `role`: a bare `role` here
    -- would resolve to it, and every caller would come back an owner.
    --
    -- No invitation clause: an agents row is a member, full stop. It used to
    -- also have to exclude rows whose invitation was still pending, and every
    -- helper that forgot to was a hole. Invitations are their own table now.
    return query select a.organization_id from public.agents a
    where
      a.user_id = auth.uid()
    -- A deleted agent is a former member: this is what makes marking the row
    -- revoke access rather than merely rename it.
    and a.deleted_at is null
    and (
      case a.role
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    -- Authenticated but lacking the requested role: return the empty set so RLS
    -- subqueries can fall through to other OR-combined policies (e.g. a member
    -- editing themselves while an owner-only policy is also evaluated).
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

-- WITH CHECK sees the proposed row and nothing else, so "this column may not
-- change" cannot be written as a policy expression — it needs the stored row
-- to compare against. That is all these two do: re-read the row by id under
-- SECURITY DEFINER (also avoiding RLS recursion on agents) and confirm the
-- columns the caller is not allowed to move still hold their old values.
--
-- Identity: which organization the row belongs to, which person it names, and
-- whether it is an AI agent. None of the three is editable by anyone through
-- the API — an agent that could change organization_id would be a tenant
-- escape, and one that could change user_id would be an impersonation.
create function public.agent_identity_unchanged(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      and user_id is not distinct from p_user_id
      and organization_id = p_organization_id
      and ai = p_ai
  );
end;
$$;

-- Identity plus role, for the two callers who may edit an agent but not
-- promote anyone: a member editing themselves, and an admin editing a
-- colleague. Granting a role is an owner's privilege, so owners get the
-- function above instead.
create function public.agent_identity_and_role_unchanged(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean,
  p_role public.role
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      and user_id is not distinct from p_user_id
      and organization_id = p_organization_id
      and ai = p_ai
      and role = p_role
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
