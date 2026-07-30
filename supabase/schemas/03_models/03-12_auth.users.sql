-- The AFTER INSERT trigger that used to live here
-- (lookup_agents_by_email_after_insert_on_auth_users) is gone with the
-- invitation-as-agent-row model: an invitation is now a row in
-- public.invitations keyed by email, and the auth identity behind that email
-- is resolved once, at acceptance, from the JWT. Nothing needs guessing it in
-- advance any more.
create trigger prevent_owner_user_deletion
before delete
on auth.users
for each row
execute function public.prevent_owner_user_deletion();
