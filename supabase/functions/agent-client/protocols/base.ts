import type {
  AgentRow,
  AIAgentExtra,
  ConversationRow,
  MessageInsert,
  MessageRow,
  OrganizationRow,
} from "../../_shared/supabase.ts";

// The peer as the protocol handlers care about it: a display name resolved
// from the conversation's contacts_addresses row (or the author agent on a
// local DM).
export interface ContactInfo {
  name?: string;
}

export type AgentRowWithExtra = Omit<AgentRow, "extra"> & {
  extra: AIAgentExtra;
};

export interface RequestContext {
  organization: OrganizationRow;
  conversation: ConversationRow;
  messages: MessageRow[];
  contact?: ContactInfo;
  agent: AgentRowWithExtra;
}

export interface ResponseContext {
  organization?: OrganizationRow;
  conversation?: ConversationRow;
  messages?: MessageInsert[];
  agent?: AgentRowWithExtra;
}

export function contextHeaders(
  context: RequestContext,
): Record<string, string> {
  return {
    "organization-id": context.organization.id,
    "organization-address": context.conversation.organization_address,
    "conversation-id": context.conversation.id,
    "agent-id": context.agent.id,
    // Header name kept for the agent APIs that already read it; the value is
    // the conversation's address, which says the same thing for a direct chat
    // and something truthful for a group.
    ...(context.conversation.address &&
      { "contact-address": context.conversation.address }),
  };
}

export interface AgentProtocolHandler<Request = unknown, Response = unknown> {
  prepareRequest(): Promise<Request>;

  sendRequest(request: Request): Promise<Response>;

  processResponse(response: Response): Promise<ResponseContext>;
}
