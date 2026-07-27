// Slack event handlers. All writes are idempotent (external_id upserts, PK
// upserts) so Slack's up-to-3 retries need no dedup store.
//
// Mapping rules (see slack-management/index.ts header for the address model):
//   - conversation_address = channel id (D…/G…/C…), anchored to the team.
//   - sender_address = the Slack user id; agent_id set when the sender is a
//     linked member. All mirrored rows are direction 'incoming' (sender ≠ the
//     workspace anchor) and carry a final status (delivered) — never
//     status.pending, so neither the dispatcher nor agent-client fires.
//   - Sends made through OpenBSP come back as message events too; the
//     external_id upsert merges them into the dispatcher's row, and when the
//     echo lands first commitDispatchedMessage folds the duplicate.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import type {
  IncomingMessage,
  IncomingStatus,
  MessageInsert,
} from "../_shared/supabase.ts";
import { MAX_STORAGE_UPLOAD_SIZE, uploadToStorage } from "../_shared/media.ts";
import {
  eventAuthorizations,
  type SlackUser,
  usersInfo,
} from "../_shared/slack.ts";
import { slackToMarkdown } from "../_shared/markdown.ts";
import { emojiFromShortcode } from "../_shared/emoji.ts";

export type SlackEnvelope = {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event_context?: string;
  authorizations?: Array<{ user_id: string; is_bot?: boolean }>;
  event?: SlackEvent;
};

type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
};

/** Loose union — only the fields the handlers read. */
type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  channel?: string | { id: string; name?: string };
  channel_type?: "im" | "mpim" | "group" | "channel";
  text?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  deleted_ts?: string;
  hidden?: boolean;
  bot_id?: string;
  files?: SlackFile[];
  message?: { ts?: string; text?: string; user?: string };
  previous_message?: { ts?: string };
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  tokens?: { oauth?: string[]; bot?: string[] };
};

const tsToIso = (ts: string) => new Date(parseFloat(ts) * 1000).toISOString();

const externalId = (team: string, channel: string, ts: string) =>
  `${team}:${channel}:${ts}`;

export async function handleEvent(
  client: SupabaseClient,
  organization_id: string,
  envelope: SlackEnvelope,
): Promise<void> {
  const team = envelope.team_id!;
  const event = envelope.event;
  if (!event) return;

  const ctx: Ctx = { client, organization_id, team, envelope };

  switch (event.type) {
    case "message":
      return await onMessage(ctx, event);
    case "reaction_added":
    case "reaction_removed":
      return await onReaction(ctx, event);
    case "member_joined_channel":
      return await onMemberJoined(ctx, event);
    case "member_left_channel":
      return await onMemberLeft(ctx, event);
    case "channel_rename":
      return await onChannelRename(ctx, event);
    case "channel_archive":
    case "channel_unarchive":
      return await onChannelArchive(ctx, event);
    case "user_change":
      return await onUserChange(ctx, event);
    case "tokens_revoked":
      return await onTokensRevoked(ctx, event);
    case "app_uninstalled":
      return await onAppUninstalled(ctx);
    default:
      log.info(`Ignoring Slack event type ${event.type}`);
  }
}

type Ctx = {
  client: SupabaseClient;
  organization_id: string;
  team: string;
  envelope: SlackEnvelope;
};

/** Personal address row of a linked member, or null. */
async function linkedAgent(
  ctx: Ctx,
  slackUser: string,
): Promise<{ agent_id: string; address: string } | null> {
  const address = `${ctx.team}:${slackUser}`;

  const { data } = await ctx.client
    .from("organizations_addresses")
    .select("agent_id")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("address", address)
    .not("agent_id", "is", null)
    .maybeSingle()
    .throwOnError();

  return data?.agent_id ? { agent_id: data.agent_id, address } : null;
}

/** Any connected member's token — for reads that need a workspace token
 * (users.info, file downloads); Slack scopes them per-user but directory and
 * shared-file reads are equivalent across members. */
async function anyWorkspaceToken(ctx: Ctx): Promise<string | null> {
  const { data } = await ctx.client
    .from("organizations_addresses")
    .select("extra->>access_token")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("status", "connected")
    .like("address", `${ctx.team}:%`)
    .not("extra->>access_token", "is", null)
    .limit(1)
    .maybeSingle()
    .throwOnError();

  return data?.access_token ?? null;
}

/**
 * Finds the conversation for a channel; creates it (plus its audience) on
 * first contact — e.g. a DM opened after the members' initial sync. The
 * audience comes from apps.event.authorizations.list (all installs this
 * event applies to), falling back to the envelope's partial list.
 */
async function ensureConversation(
  ctx: Ctx,
  channel: string,
  channel_type?: SlackEvent["channel_type"],
): Promise<string> {
  const { data: existing } = await ctx.client
    .from("conversations")
    .select("id")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("conversation_address", channel)
    .eq("service", "slack")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();

  if (existing) return existing.id;

  const { data: created } = await ctx.client
    .from("conversations")
    .insert({
      organization_id: ctx.organization_id,
      service: "slack" as const,
      organization_address: ctx.team,
      conversation_address: channel,
      extra: channel_type ? { channel_type: mapChannelType(channel_type) } : {},
    })
    .select("id")
    .single()
    .throwOnError();

  const authorizations =
    (await eventAuthorizations(ctx.envelope.event_context ?? "")) ??
      ctx.envelope.authorizations ?? [];

  for (const auth of authorizations) {
    if (auth.is_bot || !auth.user_id) continue;

    const linked = await linkedAgent(ctx, auth.user_id);
    if (!linked) continue;

    await ctx.client
      .from("conversations_agents")
      .upsert({
        organization_id: ctx.organization_id,
        organization_address: linked.address,
        conversation_id: created.id,
        agent_id: linked.agent_id,
      }, { onConflict: "conversation_id,agent_id" })
      .throwOnError();
  }

  return created.id;
}

function mapChannelType(
  channel_type: NonNullable<SlackEvent["channel_type"]>,
): string {
  switch (channel_type) {
    case "im":
      return "im";
    case "mpim":
      return "mpim";
    case "group":
      return "private_channel";
    default:
      return "public_channel";
  }
}

/** Makes sure an unlinked sender exists in the directory (joined after the
 * members' sync); fetches the profile lazily with any workspace token. */
async function ensureContact(ctx: Ctx, slackUser: string): Promise<void> {
  const { data } = await ctx.client
    .from("contacts_addresses")
    .select("address")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("address", slackUser)
    .maybeSingle()
    .throwOnError();

  if (data) return;

  const token = await anyWorkspaceToken(ctx);
  const profile: SlackUser | null = token
    ? await usersInfo(token, slackUser)
    : null;

  await ctx.client
    .from("contacts_addresses")
    .upsert({
      organization_id: ctx.organization_id,
      service: "slack" as const,
      address: slackUser,
      extra: {
        synced: {
          action: "add",
          name: profile?.profile?.display_name ||
            profile?.profile?.real_name || profile?.name || slackUser,
        },
        team_id: ctx.team,
        picture: profile?.profile?.image_192,
      },
    }, { onConflict: "organization_id,service,address" })
    .throwOnError();
}

// Regular messages, file shares, thread broadcasts, edits and deletions.
async function onMessage(ctx: Ctx, event: SlackEvent): Promise<void> {
  const channel = event.channel as string;

  if (event.subtype === "message_changed") {
    if (!event.message?.ts) return;

    await ctx.client
      .from("messages")
      .update({
        content: { text: slackToMarkdown(event.message.text ?? "") },
        status: { edited: tsToIso(event.event_ts ?? event.message.ts) },
      })
      .eq("external_id", externalId(ctx.team, channel, event.message.ts))
      .throwOnError();
    return;
  }

  if (event.subtype === "message_deleted") {
    if (!event.deleted_ts) return;

    await ctx.client
      .from("messages")
      .update({
        status: { deleted: tsToIso(event.event_ts ?? event.deleted_ts) },
      })
      .eq("external_id", externalId(ctx.team, channel, event.deleted_ts))
      .throwOnError();
    return;
  }

  // Everything else: only plain messages, file shares and thread broadcasts.
  // Bot chatter and system subtypes (channel_join, …) are not mirrored.
  if (
    (event.subtype && !["file_share", "thread_broadcast"].includes(
      event.subtype,
    )) || event.bot_id || !event.user || !event.ts
  ) {
    return;
  }

  const conversation_id = await ensureConversation(
    ctx,
    channel,
    event.channel_type,
  );

  const linked = await linkedAgent(ctx, event.user);
  if (!linked) await ensureContact(ctx, event.user);

  const base = {
    organization_id: ctx.organization_id,
    conversation_id,
    service: "slack" as const,
    organization_address: ctx.team,
    conversation_address: channel,
    sender_address: event.user,
    agent_id: linked?.agent_id,
    direction: "incoming" as const,
    thread_id: event.thread_ts,
    timestamp: tsToIso(event.ts),
    status: {
      delivered: tsToIso(event.event_ts ?? event.ts),
    } as IncomingStatus,
  };

  const rows: MessageInsert[] = [];

  const files = event.files ?? [];

  if (files.length === 0) {
    rows.push({
      ...base,
      external_id: externalId(ctx.team, channel, event.ts),
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text: slackToMarkdown(event.text ?? ""),
      } as IncomingMessage,
    });
  } else {
    const token = await anyWorkspaceToken(ctx);

    for (const [index, file] of files.entries()) {
      const uri = await downloadFile(ctx, token, file);
      // One row per file; Slack's message text is the caption of the first.
      rows.push({
        ...base,
        external_id: index === 0
          ? externalId(ctx.team, channel, event.ts)
          : `${externalId(ctx.team, channel, event.ts)}:f${index}`,
        content: uri
          ? {
            version: "1",
            type: "file",
            kind: kindFromMime(file.mimetype ?? ""),
            file: {
              mime_type: file.mimetype ?? "application/octet-stream",
              uri,
              name: file.name,
              size: file.size ?? 0,
            },
            ...(index === 0 && event.text
              ? { text: slackToMarkdown(event.text) }
              : {}),
          } as IncomingMessage
          // Download failed/oversized/no token: keep the message with a
          // placeholder so the timeline stays complete.
          : {
            version: "1",
            type: "data",
            kind: "media_placeholder",
            data: {},
            ...(index === 0 && event.text
              ? { text: slackToMarkdown(event.text) }
              : {}),
          } as IncomingMessage,
      });
    }
  }

  await ctx.client
    .from("messages")
    .upsert(rows, { onConflict: "external_id" })
    .throwOnError();
}

async function downloadFile(
  ctx: Ctx,
  token: string | null,
  file: SlackFile,
): Promise<string | null> {
  if (!token || !file.url_private) return null;

  if ((file.size ?? 0) > MAX_STORAGE_UPLOAD_SIZE) {
    log.warn(`Slack file ${file.id} exceeds storage limit, skipping`);
    return null;
  }

  try {
    const response = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      log.warn(`Slack file download failed (${response.status})`, file.id);
      return null;
    }

    const blob = await response.blob();
    return await uploadToStorage(
      ctx.client,
      ctx.organization_id,
      blob,
      file.name,
    );
  } catch (error) {
    log.warn(`Slack file download failed`, { file: file.id, error });
    return null;
  }
}

function kindFromMime(mime: string): "image" | "audio" | "video" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// Reactions are data parts (multi-user, add/remove) referencing the reacted
// message via re_message_id — see ReactionPart in message_types.ts.
async function onReaction(ctx: Ctx, event: SlackEvent): Promise<void> {
  if (event.item?.type !== "message") return;
  const { channel, ts } = event.item;
  if (!channel || !ts || !event.user || !event.reaction) return;

  const conversation_id = await ensureConversation(ctx, channel);
  const linked = await linkedAgent(ctx, event.user);

  await ctx.client
    .from("messages")
    .upsert({
      organization_id: ctx.organization_id,
      conversation_id,
      service: "slack" as const,
      organization_address: ctx.team,
      conversation_address: channel,
      sender_address: event.user,
      agent_id: linked?.agent_id,
      direction: "incoming" as const,
      external_id: externalId(ctx.team, channel, event.event_ts ?? ts),
      timestamp: tsToIso(event.event_ts ?? ts),
      status: { delivered: tsToIso(event.event_ts ?? ts) } as IncomingStatus,
      content: {
        version: "1",
        type: "data",
        kind: "reaction",
        // Convention: text is the display form — the Unicode emoji when
        // mappable (`:name:` fallback for custom workspace emoji), empty on
        // removal (WhatsApp's removal convention); data carries the full
        // triple.
        text: event.type === "reaction_added"
          ? emojiFromShortcode(event.reaction) ?? `:${event.reaction}:`
          : "",
        data: {
          action: event.type === "reaction_added" ? "added" : "removed",
          name: event.reaction,
          unicode: emojiFromShortcode(event.reaction),
        },
        re_message_id: externalId(ctx.team, channel, ts),
      } as IncomingMessage,
    }, { onConflict: "external_id" })
    .throwOnError();
}

async function onMemberJoined(ctx: Ctx, event: SlackEvent): Promise<void> {
  const channel = event.channel as string;
  if (!event.user || !channel) return;

  const linked = await linkedAgent(ctx, event.user);
  if (!linked) return;

  const conversation_id = await ensureConversation(
    ctx,
    channel,
    event.channel_type,
  );

  await ctx.client
    .from("conversations_agents")
    .upsert({
      organization_id: ctx.organization_id,
      organization_address: linked.address,
      conversation_id,
      agent_id: linked.agent_id,
    }, { onConflict: "conversation_id,agent_id" })
    .throwOnError();
}

async function onMemberLeft(ctx: Ctx, event: SlackEvent): Promise<void> {
  const channel = event.channel as string;
  if (!event.user || !channel) return;

  const linked = await linkedAgent(ctx, event.user);
  if (!linked) return;

  const { data: conversation } = await ctx.client
    .from("conversations")
    .select("id")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("conversation_address", channel)
    .eq("service", "slack")
    .maybeSingle()
    .throwOnError();

  if (!conversation) return;

  await ctx.client
    .from("conversations_agents")
    .delete()
    .eq("conversation_id", conversation.id)
    .eq("agent_id", linked.agent_id)
    .throwOnError();
}

async function onChannelRename(ctx: Ctx, event: SlackEvent): Promise<void> {
  const channel = event.channel as { id: string; name?: string };
  if (!channel?.id) return;

  await ctx.client
    .from("conversations")
    .update({ name: channel.name })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("organization_address", ctx.team)
    .eq("conversation_address", channel.id)
    .throwOnError();
}

async function onChannelArchive(ctx: Ctx, event: SlackEvent): Promise<void> {
  const channel = typeof event.channel === "string"
    ? event.channel
    : event.channel?.id;
  if (!channel) return;

  await ctx.client
    .from("conversations")
    .update({
      status: event.type === "channel_archive" ? "archived" : "active",
    })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("organization_address", ctx.team)
    .eq("conversation_address", channel)
    .throwOnError();
}

async function onUserChange(ctx: Ctx, event: SlackEvent): Promise<void> {
  const user = event.user as unknown as SlackUser;
  if (!user?.id || user.is_bot) return;

  await ctx.client
    .from("contacts_addresses")
    .upsert({
      organization_id: ctx.organization_id,
      service: "slack" as const,
      address: user.id,
      extra: {
        synced: {
          action: "add",
          name: user.profile?.display_name || user.profile?.real_name ||
            user.name,
        },
        team_id: ctx.team,
        picture: user.profile?.image_192,
      },
    }, { onConflict: "organization_id,service,address" })
    .throwOnError();
}

// A member revoked the app from the Slack side: flip their connection to
// disconnected (same semantics as DELETE /connect — everything else stays).
async function onTokensRevoked(ctx: Ctx, event: SlackEvent): Promise<void> {
  for (const user of event.tokens?.oauth ?? []) {
    await ctx.client
      .from("organizations_addresses")
      .update({
        status: "disconnected",
        extra: { access_token: null, refresh_token: null },
      })
      .eq("organization_id", ctx.organization_id)
      .eq("service", "slack")
      .eq("address", `${ctx.team}:${user}`)
      .throwOnError();
  }
}

async function onAppUninstalled(ctx: Ctx): Promise<void> {
  // Anchor + every personal connection of this workspace.
  await ctx.client
    .from("organizations_addresses")
    .update({ status: "disconnected" })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .or(`address.eq.${ctx.team},address.like.${ctx.team}:%`)
    .throwOnError();

  await ctx.client
    .from("organizations_addresses")
    .update({ extra: { access_token: null, refresh_token: null } })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .like("address", `${ctx.team}:%`)
    .throwOnError();
}
