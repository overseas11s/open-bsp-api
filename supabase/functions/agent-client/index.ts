import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ContactRow,
  createUnsecureClient,
  type Database,
  type DataPart,
  type InternalMessage,
  isInternal,
  isToolTrace,
  type LocalMCPToolConfig,
  type MessageInsert,
  type MessageRow,
  type OutgoingMessage,
  type Part,
  type TextPart,
  type ToolInfo,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { ProtocolFactory } from "./protocols/index.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { z } from "zod";
import Ajv2020 from "ajv";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";
import { getFileMetadata } from "../_shared/media.ts";

const sanitizeLabel = (label: string) => {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "_");
};

export type AgentTool = {
  provider: "local";
  type: "function" | "custom" | "mcp" | "http" | "sql";
  label?: string;
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.JSONSchema;
  outputSchema?: z.core.JSONSchema.JSONSchema;
  // deno-lint-ignore no-explicit-any
  implementation?: any;
  // deno-lint-ignore no-explicit-any
  config?: any;
};

/**
 * Internal comms: the services where the peer is a colleague, not a contact.
 * `discord` and `teams` are in the service enum but have no ingestion yet —
 * listed so they start on the right side of the rule when they arrive.
 */
const TEAM_CHAT_SERVICES = new Set<Database["public"]["Enums"]["service"]>([
  "local",
  "slack",
  "discord",
  "teams",
]);

const MESSAGES_TIME_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days
const MESSAGES_QUANTITY_LIMIT = 50;
const RESPONSE_DELAY_SECS = 3; // 3 seconds
const MEDIA_PREPROCESSING_TIMEOUT = 30 * 1000; // 30 seconds
const MEDIA_PREPROCESSING_POLLING_INTERVAL = 5 * 1000; // 5 seconds

/**
 * timestamp vs created_at
 *
 *  - timestamp is given by the service (i.e. WhatsApp) servers.
 *  - created_at is the insertion timestamp in our database.
 *
 *  The contact might send several messages very close in time. The goal is to react
 *  once for the whole batch. Each message will trigger a function. Only one of them
 *  should go through. The selection criteria is the function corresponding to the
 *  newest message by created_at.
 *
 *  The newest message might not be the one with the latest timestamp. The order of
 *  arrival is not guaranteed. Anyway, messages are ordered by timestamp, hence the
 *  agent will get the conversation history in the correct order.
 */

/**
 * Authorship without the deprecated `direction` column.
 *
 * `sender_address` is a contact reference: set when the peer authored the row,
 * null when the account itself did. `content.tool` marks our own tool traces,
 * which are recorded but never spoken. Those two answer every question this
 * function used to ask `direction`.
 */
const fromContact = (m: { sender_address: string | null }) =>
  m.sender_address !== null;

const spokenByUs = (m: { sender_address: string | null; content: unknown }) =>
  m.sender_address === null && !isInternal(m);

function getNewestIncomingMessage(
  incoming: MessageRow,
  messages: MessageRow[],
) {
  const incomingCreatedAt = new Date(incoming.created_at);

  const sortedMessages = messages
    .filter(fromContact)
    .filter((m) => new Date(m.created_at) >= incomingCreatedAt)
    .sort((a, b) => {
      const dateA = +new Date(a.created_at);
      const dateB = +new Date(b.created_at);

      if (dateA !== dateB) {
        return dateB - dateA; // descending by created_at
      }

      // If created_at is the same, order by id descending
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

  return sortedMessages[0];
}

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  // RETRIEVE CONVERSATION + ORGANIZATION + AGENTS (via organization, one-hop join)

  const { data: conv } = await client
    .from("conversations")
    .select(`
      *,
      organizations (*, agents (*))
    `)
    .eq("id", incoming.conversation_id)
    .single()
    .throwOnError();

  if (!conv.extra) {
    conv.extra = {};
  }

  const {
    organizations: org,
    ...conversation
  } = conv;

  log.info("Agent client context", {
    conversation_id: conv.id,
    has_org: !!org,
  });

  const organization_id = org.id;

  if (!org.extra) {
    org.extra = {};
  }

  const { agents, ...organization } = org;

  // RETRIEVE CONTACT
  //
  // conversation_address is a soft reference (the FK went with the legacy
  // contact_address column), so the contact comes from its own query: on a
  // direct chat the conversation's address IS the contact's address, and a
  // group address simply matches no contacts_addresses row — same outcome as
  // the old embed returning null.

  const { data: contact_address } = await client
    .from("contacts_addresses")
    .select("*, contacts (*)")
    .eq("organization_id", conv.organization_id)
    .eq("service", conv.service)
    .eq("address", conv.conversation_address)
    .maybeSingle()
    .throwOnError();

  let contact: ContactRow | undefined;

  if (contact_address) {
    contact = contact_address.contacts || undefined;

    if (!contact_address.extra) {
      contact_address.extra = {};
    }

    if (!contact && contact_address.extra.name) {
      contact = {
        name: contact_address.extra.name,
      } as ContactRow;
    }
  }

  if (contact) {
    if (!contact.extra) {
      contact.extra = {};
    }
  }

  // NO AI IN TEAM CHAT
  //
  // Team chat is where colleagues talk to each other, and `local` is only the
  // half we host: a mirrored Slack workspace is the same conversation with
  // someone else's servers in the middle. An AI agent answering there would
  // need trigger rules this codebase does not have — who it answers, when, and
  // without replying to every message in the room.
  //
  // For `local` the insert trigger cannot even reach us (it arms on
  // sender_address, and a colleague is not a contact). For Slack it can, now
  // that its rows carry status.pending like every other inbound message — so
  // this is a rule, not a restatement.

  if (TEAM_CHAT_SERVICES.has(conv.service)) {
    log.info(`Conversation ${conv.id} is team chat. Skipping response.`);

    return new Response("ok", { headers: corsHeaders });
  }

  // AGENT SELECTION
  //
  // The oldest active AI agent in the organization — an AI agent being one
  // that is nobody's membership (no user_id) and has not been retired
  // (deleted_at). There is no per-conversation override any more: nothing
  // could write one, since members hold no UPDATE on conversations outside
  // `local`.
  //
  // Selected before the delay because the delay is now the agent's own.

  const agent = agents
    .filter((a) =>
      a.user_id === null && a.deleted_at === null &&
      a.extra?.mode !== "inactive"
    )
    .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    .at(0) as AgentRowWithExtra | undefined;

  // WAIT FOR A NEWER MESSAGE

  const delay = (agent?.extra?.response_delay_seconds ?? RESPONSE_DELAY_SECS) *
    1000;

  if (delay > 0) {
    log.info(`Waiting ${delay}ms before processing the message...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // RETRIEVE MESSAGES

  const { data: messagesMixedVersions } = await client
    .from("messages")
    .select()
    .eq("conversation_id", incoming.conversation_id)
    .gt("timestamp", new Date(+new Date() - MESSAGES_TIME_LIMIT).toISOString()) // Time constraint for the conversation.
    .lte("timestamp", new Date().toISOString()) // Scheduled messages have a future timestamp.
    .order("timestamp", { ascending: false })
    .limit(MESSAGES_QUANTITY_LIMIT) // Size constraint for the conversation.
    .throwOnError();

  // v0 is out of support: rows that predate the v1 content schema are
  // simply not part of the context window any more.
  const messages = messagesMixedVersions
    .filter((m) => m.content.version === "1") as MessageRow[];

  // Query was done in descending order to apply the limit.
  // We need the messages in chronological order, though.
  messages.reverse();

  // CHECK IF THERE IS A NEWER MESSAGE
  const newestMessage = getNewestIncomingMessage(incoming, messages);

  if (newestMessage.id !== incoming.id) {
    // Then the newest message is not the incoming one that triggered this edge function.
    log.info(
      `Newer message ${newestMessage.id} found for conversation ${conv.id}. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // SESSION RESTART if /new is found — USEFUL FOR WHATSAPP TESTING

  // content.text may be absent despite type === "text": legacy whatsapp-web
  // bridge builds emitted reactions as a TextPart with no text at all. One
  // such row in the window crashed this scan — and with it every later
  // inbound message of the conversation.
  const firstMessageIndex = messages.findLastIndex(
    (m) =>
      fromContact(m) &&
      m.content.type === "text" &&
      typeof m.content.text === "string" &&
      m.content.text.startsWith("/new"),
  );

  if (firstMessageIndex > -1) {
    const firstMessage = messages[firstMessageIndex].content as TextPart;

    firstMessage.text = firstMessage.text.replace("/new", "");

    messages.splice(0, firstMessageIndex);

    // Also, reset the conversation memory
    if (conv.extra.memory && Object.keys(conv.extra.memory).length) {
      conv.extra.memory = {};

      await client
        .from("conversations")
        .update({ extra: conv.extra })
        .eq("id", incoming.conversation_id)
        .throwOnError();
    }
  }

  log.info("Contact request", messages.at(-1)?.content);

  // The agent was chosen before the delay, above.

  if (!agent) {
    log.info(
      `No active AI agents found for conversation ${conv.id}. Skipping response.`,
    );
    return new Response("ok", { headers: corsHeaders });
  }

  // WELCOME MESSAGE
  //
  // The agent's, not the organization's — so it needs an agent, and an
  // organization without one no longer greets anyone. Still ahead of asking
  // the agent anything: it replaces the first answer rather than preceding it.

  if (
    agent.extra.welcome_message &&
    !messages.some(spokenByUs)
  ) {
    const outgoing: MessageInsert = {
      organization_id: conv.organization_id,
      conversation_id: conv.id,
      service: conv.service,
      organization_address: conv.organization_address,
      conversation_address: conv.conversation_address,
      agent_id: agent.id,
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text: agent.extra.welcome_message,
      },
    };

    log.info("Welcome message", (outgoing.content as TextPart).text);

    await client
      .from("messages")
      .insert(outgoing)
      .throwOnError();

    return new Response("ok", { headers: corsHeaders });
  }

  //---------------------------------------------------------------------------
  // Up to this point all checks passed. We can proceed with the response.
  //---------------------------------------------------------------------------

  // TYPING INDICATOR

  const indicateTyping = async (unread?: boolean) => {
    const { error: typingIndicatorError } = await client
      .from("messages")
      .update({
        status: {
          ...(unread && { read: new Date().toISOString() }),
          typing: new Date().toISOString(),
        },
      })
      .eq("id", incoming.id);

    if (typingIndicatorError) {
      log.warn(
        "Failed to update incoming message typing indicator status.",
        typingIndicatorError,
      );
    }
  };

  indicateTyping(true);

  // The typing indicator will be dismissed once an agent respond,
  // or after 25 seconds. Hence, keep it alive. Some extra delay
  // is added to avoid race conditions with the response.
  const typingInterval = setInterval(indicateTyping, 30000);

  // CONTEXT

  if (!agent.extra) {
    agent.extra = {};
  }

  const context = {
    organization,
    conversation,
    messages,
    contact,
    agent: agent as AgentRowWithExtra,
  };

  if (agent.extra.tools) {
    for (const tool of agent.extra.tools) {
      if ("label" in tool) {
        tool.label = sanitizeLabel(tool.label);
      }
    }
  }

  // REQUEST LOOP

  /**
   * agent.extra.tools
   *   - function
   *   - mcp
   *   - gemini: google_search, code_execution, url_context
   *   - openai: mcp, web_search_preview, file_search, image_generation, code_interpreter, computer_use_preview
   *   - anthropic: mcp*, bash, code_execution, computer, str_replace_based_edit_tool, web_search
   *
   * context.tools -> tools + expanded mcp tools
   */

  const mcpServers: Map<string, MCPServer> = new Map();

  let iteration = 0;
  const max_iterations = 10;
  let shouldContinue = true;

  // Basic ReAct algorithm: stop if no tool uses are found.
  while (shouldContinue) {
    iteration++;

    let response: ResponseContext = {};

    try {
      if (iteration > max_iterations) {
        throw new Error("Max LLM iterations reached!");
      }

      // CHECK FOR PENDING PREPROCESSING

      while (org.extra.media_preprocessing?.mode === "active") {
        const pendingPreprocessing = messages.filter(
          (m) =>
            m.content.type === "file" &&
            m.status.pending && // Note: not using status.preprocessing to avoid race conditions with the media preprocessor Edge Function.
            !m.status.preprocessed &&
            +new Date(m.status.pending) >
              +new Date() - MEDIA_PREPROCESSING_TIMEOUT,
        );

        if (!pendingPreprocessing.length) {
          break;
        }

        // WAIT FOR THE PREPROCESSING TO COMPLETE

        log.info(
          `Waiting ${MEDIA_PREPROCESSING_POLLING_INTERVAL}ms for pending preprocessing to complete...`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, MEDIA_PREPROCESSING_POLLING_INTERVAL)
        );

        // Note: we could check for newer messages here too, but it would bloat the code.

        // RETRIEVE PROCESSED MESSAGES

        const { data: pending_messages } = await client
          .from("messages")
          .select()
          .in(
            "id",
            pendingPreprocessing.map((m) => m.id),
          )
          .throwOnError();

        // Update the messages with the pending processing.
        for (const pm of pending_messages) {
          const index = messages.findIndex((m) => m.id === pm.id);

          if (index > -1) {
            messages[index] = pm;
          }
        }
      }

      // CHECK IF THERE IS A NEWER INCOMING MESSAGE (posterior to the incoming one)

      const { data: new_message } = await client
        .from("messages")
        .select()
        .eq("conversation_id", incoming.conversation_id)
        .not("sender_address", "is", null)
        .gt("created_at", incoming.created_at)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
        .throwOnError();

      if (new_message) {
        log.info(
          `Newer message ${new_message.id} for conversation ${conv.id} found while processing tool use messages and/or waiting for pending preprocessing. Skipping response.`,
        );

        return new Response("ok", { headers: corsHeaders });
      }

      // MCP SERVERS INITIALIZATION
      // It is here because of multi-agents, which we are not using by the time being.

      const mcpServersToInit = agent.extra.tools?.filter(
        (tool) =>
          tool.provider === "local" &&
          tool.type === "mcp" &&
          !mcpServers.has(tool.label),
      ) || [];

      const mcpServersAux = await Promise.all(
        mcpServersToInit.map((tool) =>
          initMCP(tool as LocalMCPToolConfig, context)
        ),
      );

      mcpServersAux.forEach((mcp) => {
        mcpServers.set(mcp.label, mcp);
      });

      // CURRENT ITERATION TOOLS

      /**
       * Tools to be passed the agent are gruped in two main categories:
       * 1. Local tools
       * 2. External tools
       *
       * Local tools need to be passed to the agent with their input schema.
       * External tools do not require more than their tool config as it comes.
       *
       * We have the following tool types:
       * - `ToolInfo` to tag tool use/result messages with basic tool info (specially `label` and `name`).
       * - `ToolConfig` for agents to declare their tools (`label`, `name` might be unknown for MCP tools and others).
       * - `ToolDefinition`, which as its name suggests, defines the tool (`label` is unknown at definition, only `name`).
       * - `AgentTool`, the combination of config and definition, to be passed to the agent.
       */
      const tools: AgentTool[] = [];

      for (const toolConfig of agent.extra.tools || []) {
        if (toolConfig.provider !== "local") {
          continue;
        }

        switch (toolConfig.type) {
          case "function": {
            const unlabeledTool = Toolbox.function.find(
              (t) => t.name === toolConfig.name,
            );

            if (!unlabeledTool) {
              throw new Error(`Tool ${toolConfig.name} not found.`);
            }

            tools.push(unlabeledTool);

            break;
          }
          case "mcp": {
            const unlabeledTools = mcpServers.get(toolConfig.label)!.tools;

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                provider: toolConfig.provider,
                type: toolConfig.type,
                label: toolConfig.label,
                name: unlabeledTool.name,
                description: unlabeledTool.description,
                inputSchema: unlabeledTool
                  .inputSchema as z.core.JSONSchema.JSONSchema,
                outputSchema: unlabeledTool.outputSchema as
                  | z.core.JSONSchema.JSONSchema
                  | undefined,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
          case "http":
          case "sql": {
            const unlabeledTools = Toolbox[toolConfig.type];

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                ...unlabeledTool,
                label: toolConfig.label,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
        }
      }

      // AGENT CLIENT REQUEST AND RESPONSE

      const handler = ProtocolFactory.getHandler(tools, context, client);

      const agentRequest = await handler.prepareRequest();

      const agentResponse = await handler.sendRequest(agentRequest);

      response = await handler.processResponse(agentResponse);

      if (!response.messages?.length) {
        response.messages = [];
      }

      // TOOL USES AND RESULTS

      // A tool trace is one carrying `content.tool` — the same thing the
      // database reads to call the row internal.
      const toolUses = response.messages.filter(
        (m) =>
          isToolTrace(m) &&
          m.content.tool.provider === "local" &&
          m.content.type === "text",
      ) || [];

      for (const row of toolUses) {
        // `content.tool` is the tag, not `direction`: the database derives the
        // latter from the former, and a tool trace is the only content that
        // carries it.
        let content = row.content as InternalMessage;
        const toolInfo = content.tool;

        // Only needed to please the TypeScript compiler
        if (
          !toolInfo ||
          toolInfo.provider !== "local" ||
          content.type !== "text"
        ) {
          continue;
        }

        /**
         * # Tool uses and results within parallel tool use
         *
         * Chat Completions API produces a single message with several tool choices.
         * It expects tool results as single messages.
         *
         * On the other hand, Responses API and Messages API also produce a single with several tool uses.
         * But on the contrary, they expect tool results as a single message.
         *
         * Here, the adopted policy is to adhere to the WhatsApp API, this is one message per part.
         * A tool use/result is considered a part.
         */

        let parts: (Part & ToolInfo)[] = [];

        const agentTool = tools.find(
          (t) =>
            t.provider === toolInfo.provider &&
            t.type === toolInfo.type &&
            ("label" in toolInfo ? t.label === toolInfo.label : true) &&
            t.name === toolInfo.name,
        );

        try {
          if (!agentTool) {
            throw new Error(
              `Tool ${toolInfo.name} not found between available tools.`,
            );
          }

          const ajv = new Ajv2020();
          // Strip $schema since MCP SDK (via Zod) produces draft-07 schemas,
          // but Ajv is imported as the 2020-12 build and rejects unknown drafts.
          // deno-lint-ignore no-explicit-any
          const { $schema: _, ...schema } = agentTool.inputSchema as any;

          const args = JSON.parse(content.text);

          // When JSON parsing is done, the message is converted to a data part.
          content = {
            version: "1",
            internal: true,
            task: content.task,
            tool: toolInfo,
            type: "data",
            kind: "data",
            data: args,
          };

          row.content = content;

          const valid = ajv.validate(schema, args);

          if (!valid) {
            throw new Error(
              `Tool input validation failed: ${JSON.stringify(ajv.errors)}`,
            );
          }

          switch (toolInfo.type) {
            case "custom":
            case "function": {
              const result = await agentTool.implementation(args);

              parts = [
                {
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "data",
                  kind: "data",
                  data: result,
                },
              ];

              break;
            }
            case "mcp": {
              const mcp = mcpServers.get(agentTool.label!);

              if (!mcp) {
                throw new Error(`MCP server ${agentTool.label} not found.`);
              }

              parts = await callTool(mcp, content, context, client);

              break;
            }
            case "http":
            case "sql": {
              const result = await agentTool.implementation(
                args,
                agentTool.config,
                context,
                client,
              );

              const part: DataPart & ToolInfo = {
                tool: {
                  ...toolInfo,
                  event: "result" as const,
                },
                type: "data",
                kind: "data",
                data: result,
              };

              parts = [part];

              if (result.file_uri) {
                part.artifacts = [
                  {
                    type: "file",
                    kind: "document",
                    file: await getFileMetadata(client, result.file_uri),
                  },
                ];
              }

              break;
            }
          }
        } catch (error) {
          const errorMessage = (error as Error).message || String(error);

          log.warn("Tool error", { tool: toolInfo, error });

          parts = [
            {
              tool: {
                ...toolInfo,
                is_error: true,
                event: "result" as const,
              },
              type: "text",
              kind: "text",
              text: errorMessage,
            },
          ];
        }

        // TODO: Mutating the response object is not the most recommended way to do this
        // but it will be improved soon.
        const taskId = content.task?.id || crypto.randomUUID();

        for (const part of parts) {
          const message = part.type === "file"
            ? {
              organization_id,
              service: conv.service,
              organization_address: conv.organization_address,
              conversation_address: conv.conversation_address,
              agent_id: agent.id,
              content: {
                version: "1" as const,
                task: { id: taskId },
                ...part,
              } as OutgoingMessage,
            }
            : {
              organization_id,
              service: conv.service,
              organization_address: conv.organization_address,
              conversation_address: conv.conversation_address,
              agent_id: agent.id,
              content: {
                version: "1" as const,
                internal: true as const,
                task: { id: taskId },
                ...part,
              } as InternalMessage,
            };

          response.messages.push(message);
        }
      }

      if (!toolUses.length) {
        shouldContinue = false;
      }
    } catch (error) {
      shouldContinue = false;

      log.error("Error in agent client", error as Error);

      response.messages = [
        {
          organization_id,
          service: conv.service,
          organization_address: conv.organization_address,
          conversation_address: conv.conversation_address,
          // Agent errors are record-only (extra.error_messages_direction is
          // deprecated — dispatching errors to the end user is gone; OpenBSP
          // is a communication layer and internal rows never dispatch).
          agent_id: agent.id,
          content: {
            version: "1" as const,
            // The declared record-only marker — this is the row that had no
            // other way to say it (an error carries no `tool`).
            internal: true as const,
            type: "text",
            kind: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }

    // STORE CURRENT ITERATION MESSAGES

    if (response.messages?.length) {
      log.info("Agent response", response.messages.at(-1)?.content);

      const output_messages = response.messages.map((message, index) => ({
        ...message,
        // Make sure the messages have the correct addressing
        organization_id: conv.organization_id,
        conversation_id: conv.id,
        organization_address: conv.organization_address,
        conversation_address: conv.conversation_address,
        // Disambiguate by milliseconds index to ensure the insertion order.
        timestamp: new Date(Date.now() + index).toISOString(),
      }));

      try {
        // Insert and select the inserted messages
        const { data: inserted_messages } = await client
          .from("messages")
          .insert(output_messages)
          .select()
          .order("timestamp")
          .throwOnError();

        // Append generated messages to the context
        messages.push(...inserted_messages);
      } catch (storageError) {
        log.error("Failed to store agent response", storageError as Error);
        shouldContinue = false;
      }
    }
  }

  // TODO: take care of the typing interval corner cases
  clearInterval(typingInterval);

  // STORE RESPONSE

  /*
  if (response?.conversation) {
    const { error } = await client
      .from("conversations")
      .update({
        extra: response.conversation.extra,
      })
      .eq("id", incoming.conversation_id)

    if (error) {
      log.error("Failed to update conversation extra field.", error);
    }
  }

  if (contact && response?.contact) {
    const { error } = await client
      .from("contacts")
      .update({
        extra: response.contact.extra,
      })
      .eq("id", contact.id);

    if (error) {
      log.error("Failed to update contact extra field.", error);
    }
  }
  */

  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
});
