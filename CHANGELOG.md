# Changelog

## v1

- `messages.direction` and `contact_address` (conversations, messages) are
  deprecated; superseded by `conversation_address` and `sender_address`.
  Record-only rows (tool traces, errors, notes) declare `content.internal: true`
  instead of `direction: "internal"`.
- `group_address` was absorbed by `conversation_address` (conversations,
  messages); use `conversations.type` to distinguish between direct, multiple,
  group, channel.
- `conversations.status` is dropped — filtering on it 400s.
- Accounts are keyed `(organization_id, service, address)`: add `service` to
  lookups.
- `conversations` is read-only outside `local` service.
- Deleting an agent sets `deleted_at` instead of removing the row.
- Invitations moved to `public.invitations`, keyed by email; answer them with
  the `accept_invitation` / `reject_invitation` RPCs. Inserting an agent with a
  `user_id` is refused — people join by accepting.
