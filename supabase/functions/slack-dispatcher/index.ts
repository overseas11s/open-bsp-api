// Outgoing Slack dispatch. Triggered by dispatcher_edge_function() when a
// message row lands with sender_address = organization_address (the workspace
// anchor) and status.pending.
//
// The wire identity is the MEMBER, not the workspace: the row carries
// agent_id = the sending member, and their xoxp user token (personal address
// row T…:U…) is what talks to Slack — chat.postMessage with a user token
// posts genuinely as the user.
//
// external_id is stamped as `${team}:${channel}:${ts}` — the same format the
// webhook uses — so the echo Slack sends back merges into this row (or, if
// the echo lands first, commitDispatchedMessage folds the duplicate).
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type OutgoingMessage,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "../_shared/db_types.ts";
import { commitDispatchedMessage } from "../_shared/dispatch.ts";
import { downloadFromStorage } from "../_shared/media.ts";
import { markdownToSlack } from "../_shared/markdown.ts";
import { oauthRefresh, slackApi, SlackError } from "../_shared/slack.ts";
import { shortcodeFromEmoji } from "../_shared/emoji.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Transient Slack errors worth retrying (the retry cron re-fires pending
 * messages when we respond 500). HTTP 429 is already retried inside slackApi;
 * `ratelimited` covers the give-up case.
 */
const RETRYABLE_SLACK_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
]);

/** Token is dead — also flip the connection so the UI prompts a reconnect. */
const TOKEN_ERRORS = new Set([
  "token_revoked",
  "token_expired",
  "invalid_auth",
  "account_inactive",
]);

class PermanentError extends Error {}

type Connection = {
  address: string;
  extra: {
    access_token?: string | null;
    refresh_token?: string | null;
    expires_at?: string;
  };
};

/** The sending member's personal connection for this workspace. */
async function getConnection(
  client: SupabaseClient,
  message: MessageRow,
): Promise<Connection> {
  if (!message.agent_id) {
    throw new PermanentError(
      "Outgoing Slack messages require agent_id (the sending member)",
    );
  }

  const { data } = await client
    .from("organizations_addresses")
    .select("address, status, extra")
    .eq("organization_id", message.organization_id)
    .eq("service", "slack")
    .eq("agent_id", message.agent_id)
    .like("address", `${message.organization_address}:%`)
    .maybeSingle()
    .throwOnError();

  if (!data || data.status !== "connected" || !data.extra?.access_token) {
    throw new PermanentError(
      `Agent ${message.agent_id} has no connected Slack account for workspace ${message.organization_address}`,
    );
  }

  return data as Connection;
}

/** Refreshes a rotated token when it is (about to be) expired. */
async function ensureFreshToken(
  client: SupabaseClient,
  organization_id: string,
  connection: Connection,
): Promise<string> {
  const { access_token, refresh_token, expires_at } = connection.extra;

  const expiringSoon = expires_at &&
    new Date(expires_at).getTime() - Date.now() < 60 * 1000;

  if (!expiringSoon || !refresh_token) return access_token!;

  const access = await oauthRefresh(refresh_token);
  const authed = access.authed_user;

  if (!authed?.access_token) {
    throw new SlackError("Refresh response missing access_token", {
      cause: access,
    });
  }

  await client
    .from("organizations_addresses")
    .update({
      extra: {
        access_token: authed.access_token,
        refresh_token: authed.refresh_token ?? refresh_token,
        expires_at: authed.expires_in
          ? new Date(Date.now() + authed.expires_in * 1000).toISOString()
          : undefined,
      },
    })
    .eq("organization_id", organization_id)
    .eq("service", "slack")
    .eq("address", connection.address)
    .throwOnError();

  return authed.access_token;
}

/**
 * Sends the message; returns the Slack ts of the posted message when there is
 * one to track (text posts). Reactions and file uploads yield none — their
 * echoes arrive as webhook rows instead.
 */
async function send(
  client: SupabaseClient,
  token: string,
  message: MessageRow,
): Promise<string | undefined> {
  const content = message.content as OutgoingMessage;
  const channel = message.conversation_address!;

  switch (content.kind) {
    case "text": {
      const payload = await slackApi("chat.postMessage", token, {
        channel,
        text: markdownToSlack(content.text),
        ...(message.thread_id ? { thread_ts: message.thread_id } : {}),
      });

      return payload.ts as string;
    }

    case "reaction": {
      if (!content.re_message_id) {
        throw new PermanentError(
          "Cannot send a Slack reaction without re_message_id",
        );
      }

      // Reactions are data-only: {action, name, unicode}. The wire name
      // resolves from data.name, else from data.unicode mapped back through
      // the shortcode table.
      const data = (content as {
        data?: {
          action?: "added" | "removed";
          name?: string;
          unicode?: string;
        };
      }).data;

      if (!data?.action) {
        throw new PermanentError("Slack reactions require data.action");
      }

      const name = data.name ??
        (data.unicode ? shortcodeFromEmoji(data.unicode) : undefined);
      const action = data.action;

      if (!name) {
        throw new PermanentError(
          "Slack reactions need the emoji name (data.name or data.unicode)",
        );
      }

      // external ids are `${team}:${channel}:${ts}`; the reactions API wants
      // the bare ts.
      const timestamp = content.re_message_id.split(":").pop()!;

      await slackApi(
        action === "added" ? "reactions.add" : "reactions.remove",
        token,
        { channel, timestamp, name },
      );

      return undefined;
    }

    case "audio":
    case "image":
    case "video":
    case "document":
    case "file":
    case "media": {
      const blob = await downloadFromStorage(client, content.file.uri);
      const filename = content.file.name ?? "file";

      const upload = await slackApi("files.getUploadURLExternal", token, {
        filename,
        length: String(blob.size),
      });

      const uploadResponse = await fetch(upload.upload_url as string, {
        method: "POST",
        body: blob,
      });

      if (!uploadResponse.ok) {
        throw new SlackError(
          `Slack file upload failed (${uploadResponse.status})`,
          { cause: await uploadResponse.text() },
        );
      }

      // Upload-then-reference, the same shape as WhatsApp's media flow:
      // complete the upload WITHOUT a channel (sharing via
      // files.completeUploadExternal's channel_id posts asynchronously and
      // returns no ts), then post a regular message whose <permalink| >
      // reference shares and unfurls the file. chat.postMessage returns the
      // ts synchronously, so the echo merges into this row like any text
      // send.
      const completed = await slackApi("files.completeUploadExternal", token, {
        files: JSON.stringify([{ id: upload.file_id, title: filename }]),
      });

      const permalink = (completed.files as Array<{ permalink?: string }>)?.[0]
        ?.permalink;

      if (!permalink) {
        throw new SlackError("completeUploadExternal returned no permalink", {
          cause: completed,
        });
      }

      const caption = content.text ? `${markdownToSlack(content.text)}\n` : "";

      const payload = await slackApi("chat.postMessage", token, {
        channel,
        text: `${caption}<${permalink}| >`,
        ...(message.thread_id ? { thread_ts: message.thread_id } : {}),
      });

      return payload.ts as string;
    }

    default:
      throw new PermanentError(
        `Cannot send content of type ${content.type} and kind ${content.kind} to Slack`,
      );
  }
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();
  const message = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  log.info(`Dispatching message ${message.id}`, message);

  // Read receipts / typing indicators have no Slack Web API for user tokens —
  // the mark-as-read trigger can also never fire for Slack rows (they carry
  // no status.pending), so this is belt and suspenders.
  if (message.sender_address !== message.organization_address) {
    return new Response();
  }

  try {
    const connection = await getConnection(client, message);
    const accessToken = await ensureFreshToken(
      client,
      message.organization_id,
      connection,
    );

    const ts = await send(client, accessToken, message);

    await commitDispatchedMessage({
      client,
      messageId: message.id,
      externalId: ts
        ? `${message.organization_address}:${message.conversation_address}:${ts}`
        : undefined,
      status: { accepted: new Date().toISOString() },
    });
  } catch (error) {
    const slackCode = error instanceof SlackError
      ? (error.cause as { error?: string } | undefined)?.error
      : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetail: Json = error instanceof SlackError
      ? (error.cause as Json)
      : errorMessage;

    if (slackCode && TOKEN_ERRORS.has(slackCode)) {
      // Dead token: fail the message and flip the connection so the UI
      // prompts a reconnect (same semantics as tokens_revoked).
      log.error("Dispatch failed (token error)", {
        message_id: message.id,
        code: slackCode,
      });

      await client
        .from("organizations_addresses")
        .update({ status: "disconnected" })
        .eq("organization_id", message.organization_id)
        .eq("service", "slack")
        .eq("agent_id", message.agent_id!)
        .like("address", `${message.organization_address}:%`)
        .throwOnError();
    }

    const isRetryable = slackCode
      ? RETRYABLE_SLACK_ERRORS.has(slackCode)
      : !(error instanceof PermanentError) && !slackCode;

    if (isRetryable && !(slackCode && TOKEN_ERRORS.has(slackCode))) {
      // Transient: surface the error but keep status.pending so the retry
      // cron re-fires; rethrow so this invocation returns 500.
      log.warn("Dispatch failed (transient, will retry)", {
        message_id: message.id,
        code: slackCode,
        error: errorMessage,
      });

      await client
        .from("messages")
        .update({ status: { errors: [errorDetail] } })
        .eq("id", message.id)
        .throwOnError();

      throw error;
    }

    log.error("Dispatch failed (permanent)", {
      message_id: message.id,
      code: slackCode,
      error: errorMessage,
    });

    await client
      .from("messages")
      .update({
        status: {
          failed: new Date().toISOString(),
          errors: [errorDetail],
        },
      })
      .eq("id", message.id)
      .throwOnError();
  }

  return new Response();
});
