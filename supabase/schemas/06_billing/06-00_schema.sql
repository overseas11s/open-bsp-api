create schema if not exists billing;

grant usage on schema billing to anon, authenticated, service_role;
grant select on all tables in schema billing to anon, authenticated, service_role;
grant insert, update on all tables in schema billing to service_role;
alter default privileges in schema billing grant select on tables to anon, authenticated, service_role;
alter default privileges in schema billing grant insert, update on tables to service_role;

-- `on all functions in schema` expands to the functions that exist at the
-- moment it runs, and none do yet. Function privileges are therefore set in
-- 06-40_grants.sql, after 06-30 has created them.
