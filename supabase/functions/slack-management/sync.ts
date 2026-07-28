// Initial/periodic sync of a member's Slack connection: workspace directory →
// contacts_addresses, the member's conversations → conversations (anchored to
// the workspace address) + conversations_agents (their visibility rows).
//
// No history backfill here — the webhook fills messages forward from install
// time. Other members' visibility comes from their own installs/syncs and
// from membership events on the webhook, never from this member's token.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  type SlackChannel,
  slackPaginate,
  type SlackUser,
} from "../_shared/slack.ts";
import {
  type ChannelType,
  channelTypeFromChannel,
} from "../_shared/slack_events.ts";

export type SyncSummary = {
  users: number;
  conversations: number;
};

export async function syncConnection(
  client: SupabaseClient,
  {
    organization_id,
    agent_id,
    team_id,
    token,
    slack_user_id,
  }: {
    organization_id: string;
    agent_id: string;
    team_id: string;
    token: string;
    slack_user_id: string;
  },
): Promise<SyncSummary> {
  const summary: SyncSummary = { users: 0, conversations: 0 };

  // Workspace directory → contacts. The extra.synced mechanism lets the
  // manage_contact_on_address_sync trigger create/link public.contacts rows,
  // same as the whatsapp-web bridge. Slack user ids are workspace-scoped;
  // contacts/conversations use bare ids (U…/C…) — only organization address
  // rows are team-qualified (T…:U…).
  const usersById = new Map<string, SlackUser>();

  for await (
    const users of slackPaginate("users.list", token, "members")
  ) {
    const rows = users
      // `id` is optional in Slack's schema, and it keys contacts_addresses —
      // narrow rather than assert, so an id-less member is skipped instead of
      // upserting an undefined address.
      .filter((u): u is SlackUser & { id: string } =>
        Boolean(u.id) && !u.deleted && !u.is_bot && u.id !== "USLACKBOT"
      )
      .map((u) => {
        usersById.set(u.id, u);

        return {
          organization_id,
          service: "slack" as const,
          address: u.id,
          extra: {
            synced: {
              action: "add",
              name: u.profile?.display_name || u.profile?.real_name || u.name,
            },
            team_id,
            picture: u.profile?.image_192,
          },
        };
      });

    if (rows.length > 0) {
      await client
        .from("contacts_addresses")
        .upsert(rows, { onConflict: "organization_id,service,address" })
        .throwOnError();

      summary.users += rows.length;
    }
  }

  // The member's conversations → conversation rows + visibility. Everything
  // the member is in gets mirrored (DMs, group DMs, private and public
  // channels) — noise control is per-member state in conversations_agents,
  // not an ingestion gate.
  for await (
    const channels of slackPaginate(
      "users.conversations",
      token,
      "channels",
      {
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: "true",
        user: slack_user_id,
      },
    )
  ) {
    for (const channel of channels) {
      const conversation_id = await ensureConversation(client, {
        organization_id,
        team_id,
        channel,
        usersById,
      });

      // organization_address = the member's personal address, so deleting
      // their connection row cascades exactly these visibility rows.
      await client
        .from("conversations_agents")
        .upsert(
          {
            organization_id,
            organization_address: `${team_id}:${slack_user_id}`,
            conversation_id,
            agent_id,
          },
          { onConflict: "conversation_id,agent_id" },
        )
        .throwOnError();

      summary.conversations += 1;
    }
  }

  log.info("Slack sync completed", { organization_id, agent_id, ...summary });

  return summary;
}

/**
 * Finds or creates the conversation for a Slack channel. Conversations are
 * anchored to the workspace address (team id) and keyed by
 * conversation_address = channel id; no unique constraint backs this yet, so
 * a webhook/sync race can in theory duplicate — the same lookup-then-insert
 * the message trigger uses, acceptable for now.
 */
async function ensureConversation(
  client: SupabaseClient,
  {
    organization_id,
    team_id,
    channel,
    usersById,
  }: {
    organization_id: string;
    team_id: string;
    channel: SlackChannel;
    usersById: Map<string, SlackUser>;
  },
): Promise<string> {
  const { data: existing } = await client
    .from("conversations")
    .select("id")
    .eq("organization_id", organization_id)
    .eq("organization_address", team_id)
    .eq("conversation_address", channel.id)
    .eq("service", "slack")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();

  const channel_type = channelTypeFromChannel(channel);

  // DMs are titled by the counterpart; channels by their Slack name.
  const counterpart = channel.user ? usersById.get(channel.user) : undefined;
  const name = channel.is_im
    ? counterpart?.profile?.display_name || counterpart?.profile?.real_name ||
      counterpart?.name || channel.user
    : channel.name;

  const extra = {
    topic: channel.topic?.value || undefined,
    purpose: channel.purpose?.value || undefined,
    user: channel.user,
  };

  if (existing) {
    // Keep name/metadata fresh (channel renames, topic changes). extra is
    // merged by the set_extra trigger.
    await client
      .from("conversations")
      .update({ name, extra })
      .eq("id", existing.id)
      .throwOnError();

    await setChannelType(client, organization_id, existing.id, channel_type);

    return existing.id;
  }

  const { data: created } = await client
    .from("conversations")
    .insert({
      organization_id,
      service: "slack" as const,
      organization_address: team_id,
      conversation_address: channel.id,
      name,
      extra,
    })
    .select("id")
    .single()
    .throwOnError();

  await setChannelType(client, organization_id, created.id, channel_type);

  return created.id;
}

/**
 * channel_type lives on conversations_system, not conversations.extra:
 * authenticated AND anon hold UPDATE on conversations, so anything
 * visibility depends on must sit in a table only the service role can write.
 * Here the value is always authoritative — users.conversations returns
 * is_im/is_mpim/is_private — so it overwrites rather than backfills.
 *
 * The row must exist even when nothing else needs recording: `private`
 * defaults to true, and without the row the conversation inherits the
 * ownerless workspace anchor and would be visible org-wide. `private` is
 * never passed here, so a re-sync cannot undo the bot path's decision.
 */
async function setChannelType(
  client: SupabaseClient,
  organization_id: string,
  conversation_id: string,
  channel_type: ChannelType,
): Promise<void> {
  await client
    .from("conversations_system")
    .upsert({
      conversation_id,
      organization_id,
      channel_type,
    }, { onConflict: "conversation_id" })
    .throwOnError();
}
