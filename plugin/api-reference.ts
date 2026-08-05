/**
 * Curated API reference for the OpenBSP query tool.
 *
 * Registered as MCP resource `openbsp://api-reference`.
 * Source: openapi.json definitions + PostgREST docs + Edge Function endpoints.
 */

export const API_REFERENCE = `# OpenBSP API Reference

## PostgREST Query Syntax

All \`/rest/v1/\` endpoints use [PostgREST](https://postgrest.org) syntax.

### Filtering

| Operator | Example | Meaning |
|----------|---------|---------|
| eq | \`?name=eq.John\` | equals |
| neq | \`?status=neq.active\` | not equals |
| gt, gte, lt, lte | \`?created_at=gt.2025-01-01\` | comparisons |
| like | \`?name=like.*john*\` | SQL LIKE (case-sensitive) |
| ilike | \`?name=ilike.*john*\` | SQL ILIKE (case-insensitive) |
| in | \`?status=in.(active,pending)\` | in set |
| is | \`?extra=is.null\` | is null / is not null |

### Selecting columns

\`?select=name,address\` — only return these columns.

### Embedding relations (joins)

\`?select=*,contacts_addresses(*)\` — embed related table via FK.
\`?select=*,messages(id,content,sender_address)\` — embed with column selection.

### Ordering

\`?order=created_at.desc\` — sort descending.
\`?order=name.asc,created_at.desc\` — multi-column sort.

### Pagination

\`?limit=10&offset=20\` — limit and offset.
Or use the \`Range\` header: \`Range: 0-9\` (first 10 rows).

### Insert (POST)

\`POST /rest/v1/contacts\` with JSON body. Add \`Prefer: return=representation\` header to get the created row back.

### Update (PATCH)

\`PATCH /rest/v1/contacts?id=eq.<uuid>\` with JSON body of fields to update. Always include filter to avoid updating all rows. Add \`Prefer: return=representation\` to get updated rows.

### Delete (DELETE)

\`DELETE /rest/v1/contacts?id=eq.<uuid>\`. Always include filter.

### Counting

Add header \`Prefer: count=exact\` to get a total count in the response Content-Range header.

### Single row

Add header \`Accept: application/vnd.pgrst.object+json\` to get a single object instead of an array (404 if not found).

---

## Table Schemas

All tables are scoped by \`organization_id\` via Row Level Security (RLS).

### organizations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| name | text | required |
| extra | jsonb | org settings (response_delay_seconds, welcome_message, etc.) |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### contacts
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| name | text | |
| extra | jsonb | |
| status | text | default: active |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### contacts_addresses
| Column | Type | Notes |
|--------|------|-------|
| organization_id | uuid | PK, FK → organizations.id |
| service | service | PK (whatsapp, etc.) |
| address | text | PK (phone number ID) |
| contact_id | uuid | FK → contacts.id |
| extra | jsonb | |
| status | text | default: active |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### conversations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| service | service | whatsapp, etc. |
| organization_address | text | |
| name | text | |
| extra | jsonb | |
| address | text | the peer: individual or group/channel address |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### messages
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| conversation_id | uuid | FK → conversations.id |
| service | service | |
| organization_address | text | |
| content | jsonb | message content (see content structure below) |
| status | jsonb | delivery status |
| agent_id | uuid | FK → agents.id |
| external_id | text | provider message ID |
| conversation_address | text | the peer: individual or group/channel address |
| sender_address | text | the contact who authored it (ties to contacts_addresses); null = the account itself spoke (sends, echoes, internal) |
| timestamp | timestamptz | default: now() |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

**Message content structure:**
\`\`\`json
{
  "version": "1",
  "type": "text",
  "kind": "text",
  "text": "Hello!"
}
\`\`\`

Types: text, file, data. Kinds vary by type (text: text/reaction/caption; file: audio/image/video/document/sticker; data: location/contacts).

### organizations_addresses
| Column | Type | Notes |
|--------|------|-------|
| organization_id | uuid | PK, FK → organizations.id |
| service | service | PK |
| address | text | PK (phone number ID) |
| extra | jsonb | phone_number, verified_name, waba_id, etc. |
| status | text | default: connected |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### agents
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| user_id | uuid | FK → auth.users; null = an AI agent |
| name | text | required |
| role | role | owner, admin, member (default: member) |
| extra | jsonb | AI config (model, api_url, instructions, tools, etc.) |
| picture | text | |
| deleted_at | timestamptz | set when the agent left; null = active |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### webhooks
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| table_name | webhook_table | messages, conversations, contacts |
| operations | webhook_operation[] | INSERT, UPDATE, DELETE |
| url | varchar | |
| token | varchar | |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### invitations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| email | text | required; the invitation key |
| role | role | default: member |
| status | text | pending, accepted, rejected, revoked |
| invited_by | uuid | FK → agents.id |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### api_keys
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| name | text | required |
| key | text | required |
| role | role | default: member |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

---

## RPC Functions

| Path | Description |
|------|-------------|
| /rest/v1/rpc/get_authorized_orgs | Get organizations the current user has access to |
| /rest/v1/rpc/accept_invitation | Accept an invitation (body: {"invitation_id": "<uuid>"}); returns the agent id |
| /rest/v1/rpc/reject_invitation | Reject an invitation (body: {"invitation_id": "<uuid>"}) |

---

## Edge Function Endpoints

### WhatsApp Management

| Path | Method | Description |
|------|--------|-------------|
| /functions/v1/whatsapp-management/signup | POST | Initiate WhatsApp Embedded Signup |
| /functions/v1/whatsapp-management/templates | GET | List WhatsApp message templates |
| /functions/v1/whatsapp-management/templates | POST | Create a WhatsApp message template |

---

## Example Queries

**List contacts (first 10):**
\`GET /rest/v1/contacts?select=id,name,status&limit=10&order=name.asc\`

**Search contacts by name:**
\`GET /rest/v1/contacts?name=ilike.*john*&select=id,name\`

**Get a contact with their addresses:**
\`GET /rest/v1/contacts?id=eq.<uuid>&select=*,contacts_addresses(*)\`

**Recent conversations:**
\`GET /rest/v1/conversations?select=id,address,updated_at,name&order=updated_at.desc&limit=10\`

**Messages in a conversation:**
\`GET /rest/v1/messages?conversation_id=eq.<uuid>&select=id,sender_address,content,timestamp&order=timestamp.asc\`

**Recent incoming messages:** (authored by a contact, i.e. sender_address set)
\`GET /rest/v1/messages?sender_address=not.is.null&select=id,sender_address,content,timestamp&order=timestamp.desc&limit=20\`

**List WhatsApp accounts:**
\`GET /rest/v1/organizations_addresses?service=eq.whatsapp&select=address,status,extra\`

**List AI agents:** (an agent with no user is an AI agent)
\`GET /rest/v1/agents?user_id=is.null&deleted_at=is.null&select=id,name,extra\`

**Create a contact:**
\`POST /rest/v1/contacts\` with body \`{"name": "John Doe"}\` and header \`Prefer: return=representation\`
(organization_id is set automatically by RLS)

**Send a message (via insert):**
\`POST /rest/v1/messages\` with body:
\`\`\`json
{
  "organization_address": "<org_phone_number_id>",
  "conversation_address": "<contact_phone>",
  "service": "whatsapp",
  "content": {"version": "1", "type": "text", "kind": "text", "text": "Hello!"}
}
\`\`\`
Note: The \`reply\` tool is easier for sending WhatsApp messages when the channel is active.
`;
