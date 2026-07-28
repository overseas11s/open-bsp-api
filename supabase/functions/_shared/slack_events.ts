// Slack Events API payloads, grounded in the official `@slack/types`
// definitions. `import type` is erased at compile time, so none of this
// reaches the deployed bundle — it exists so the COMPILER decides which
// fields each event has, instead of a human reading docs from memory.
//
// Why this file exists: the webhook used to model every event as one flat
// type with every field optional. That made two wrong readings type-check
// cleanly — taking `channel_type` off the top level of a reaction (it lives
// under `item`), and feeding a member_joined `channel_type` into the
// message-event mapper (different vocabulary entirely). A discriminated
// union makes both of those compile errors.
import type {
  AppUninstalledEvent,
  ChannelArchiveEvent,
  ChannelRenameEvent,
  ChannelUnarchiveEvent,
  MemberJoinedChannelEvent,
  MemberLeftChannelEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  TokensRevokedEvent,
  UserChangeEvent,
} from "@slack/types";

/**
 * Message events — the ONE payload here not taken from `@slack/types`, on
 * purpose. Everything else in this file is the official type; this is a flat
 * view whose fields and optionality mirror the official `GenericMessageEvent`
 * / `MessageChangedEvent` / `MessageDeletedEvent` / `FileShareMessageEvent`.
 *
 * Why not the official `MessageEvent`: it is an 18-member union keyed on
 * `subtype` (4 shapes we handle, 14 system subtypes we skip), and adopting it
 * would restructure onMessage rather than just retype it.
 *   - The fields onMessage reads live on different members — `user` only on
 *     the generic shape, `deleted_ts`/`previous_message` only on deleted,
 *     `message` only on changed. It reads channel/user BEFORE branching on
 *     subtype, so the control flow would have to invert to branch-then-read.
 *   - The skip test is negative ("any subtype that isn't file_share or
 *     thread_broadcast"). TS narrows unions on positive discriminant
 *     comparisons only, so `Array.includes` narrows nothing — it would become
 *     a switch hand-enumerating every subtype.
 *   - `GenericMessageEvent` declares `subtype: undefined` as a REQUIRED
 *     property of literal type undefined, so normalizing (`subtype ?? "…"`)
 *     and switching on the result loses narrowing.
 *   - `previous_message: MessageEvent` makes the union recursive.
 * The payoff is small: every field read here is guarded by `if (!x) return`,
 * and the bugs grounding actually caught were in the other events, where the
 * official types cost nothing. If revisited, narrow just MessageDeletedEvent
 * and MessageChangedEvent and leave the generic path flat.
 *
 * `channel_type` here is the MESSAGE vocabulary — Slack splits message
 * delivery into four subscriptions (message.channels/.groups/.im/.mpim) and
 * reports which one delivered this event. Other events use a different
 * vocabulary or omit it; they resolve via conversations.info instead.
 */
export type SlackMessageEvent = {
  type: "message";
  subtype?: string;
  channel: string;
  channel_type?: "channel" | "group" | "im" | "mpim";
  user?: string;
  /** Present on app-authored messages; identifies the app, not a workspace user. */
  bot_id?: string;
  /** Display name for a bot_message that carries no `user`. */
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts: string;
  event_ts?: string;
  thread_ts?: string;
  hidden?: boolean;
  deleted_ts?: string;
  files?: SlackFile[];
  message?: { ts?: string; text?: string; user?: string };
  previous_message?: { ts?: string };
};

export type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
};

/**
 * The events this app subscribes to. Anything outside this union is ignored
 * by handleEvent, so adding a subscription means adding it here first — the
 * compiler then demands a handler.
 */
export type SubscribedEvent =
  | SlackMessageEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | MemberJoinedChannelEvent
  | MemberLeftChannelEvent
  | ChannelRenameEvent
  | ChannelArchiveEvent
  | ChannelUnarchiveEvent
  | UserChangeEvent
  | TokensRevokedEvent
  | AppUninstalledEvent;

/** Outer Events API envelope (url_verification handshake or event_callback). */
export type SlackEnvelope = {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event_context?: string;
  authorizations?: Array<{ user_id: string; is_bot?: boolean }>;
  /**
   * Typed as the subscribed union so each handler receives its exact shape.
   * Slack can still deliver an unsubscribed type; handleEvent's `default`
   * branch is the single place that copes with that.
   */
  event?: SubscribedEvent;
};

/** How OpenBSP records it, on conversations.extra.channel_type. */
export type ChannelType = "im" | "mpim" | "private_channel" | "public_channel";

/**
 * Authoritative classification, from a channel object (conversations.info,
 * users.conversations). The only source that always distinguishes public
 * from private — shared by the webhook and the management sync so the two
 * ingestion paths can never disagree.
 */
export function channelTypeFromChannel(channel: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}): ChannelType {
  return channel.is_im
    ? "im"
    : channel.is_mpim
    ? "mpim"
    : channel.is_private
    ? "private_channel"
    : "public_channel";
}

/**
 * MESSAGE-event vocabulary → ours. Message events always carry channel_type,
 * so this is the one path that needs no extra API call. Returns undefined for
 * anything unrecognized rather than guessing — everything else (reactions,
 * member_joined/left) skips this and asks conversations.info directly, since
 * their channel_type is either absent or ambiguous (`C` covers public AND
 * private channels created after March 2021).
 */
export function channelTypeFromMessageEvent(
  channel_type: SlackMessageEvent["channel_type"],
): ChannelType | undefined {
  switch (channel_type) {
    case "channel":
      return "public_channel";
    case "group":
      return "private_channel";
    case "im":
      return "im";
    case "mpim":
      return "mpim";
    default:
      return undefined;
  }
}
