# Changelog

## v1

- `messages.direction` and `contact_address` (conversations, messages) are
  dropped; superseded by `conversations.address`,
  `messages.conversation_address` and `sender_address` (incoming =
  `sender_address` set, outgoing = null).
- `group_address` was absorbed by the peer address (`conversations.address`,
  `messages.conversation_address`); use `conversations.type` to distinguish
  between direct, group, channel.
- `conversations.status` is dropped.
- Accounts are keyed `(organization_id, service, address)`: add `service` to
  lookups.
- `conversations` is read-only outside `local` service.
- Deleting an agent sets `deleted_at` instead of removing the row.
- Invitations moved to `public.invitations`, keyed by email; answer them with
  the `accept_invitation` / `reject_invitation` RPCs. Inserting an agent with a
  `user_id` is refused; people join by accepting.
