# Changelog

## v1

- `messages.direction` and `contact_address` (conversations, messages) are
  deprecated; superseded by `conversation_address` and `sender_address`.
- `group_address` was absorbed by `conversation_address` (conversations,
  messages); use `conversations.type` to distinguish between direct, multiple,
  group, channel.
- `conversations.status` is dropped — filtering on it 400s.
- Accounts are keyed `(organization_id, service, address)`: add `service` to
  lookups.
- `conversations` is read-only outside `local` service.
- Deleting an agent sets `deleted_at` instead of removing the row.
- `agents.extra.role` is now the `agents.role` column; AI agents keep their
  free-text persona in `extra.role`.
- Invitations moved to `public.invitations`, keyed by email; answer them with
  the `accept_invitation` / `reject_invitation` RPCs. Inserting an agent with a
  `user_id` is refused — people join by accepting.
