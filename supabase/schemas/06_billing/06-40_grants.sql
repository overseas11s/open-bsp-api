-- Execute privileges on billing functions. Last file in the schema because
-- `on all functions in schema` is a snapshot of what exists when it runs, so it
-- has to follow 06-30_functions.sql.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, the role every other
-- role inherits from — including `anon` and `authenticated`. The billing schema
-- is exposed to PostgREST (the UI reads products, usage, subscriptions,
-- tiers_products and plans_products from it), so that default puts every
-- function behind /rest/v1/rpc/<name> for any signed-in user — update_usage,
-- for one, takes a negative quantity.
--
-- Nothing legitimate uses it. A trigger checks EXECUTE when it is created, not
-- when it fires, so the check_/update_ functions still run for an insert by any
-- role; the RPC callers (agent-client and media-preprocessor call check_limit)
-- hold service_role.
--
-- A billing function added later is born executable by PUBLIC again, and
-- `alter default privileges in schema billing` cannot prevent that: the
-- per-schema form only adds privileges on top of the built-in default and never
-- subtracts PUBLIC's EXECUTE, which lives at the global level. Revoking it
-- there would reach every schema, so instead a migration that adds a billing
-- function re-runs this revoke.
revoke execute on all functions in schema billing from public;

grant execute on all functions in schema billing to service_role;
