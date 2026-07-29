/**
 * The shape of a channel, in one vocabulary every service maps onto — the
 * `type` column on conversations.
 *
 *   direct     1:1                WhatsApp/Instagram DM, Slack im, a local DM
 *   multiple   ad-hoc N           Slack mpim, Teams group chat, a local one
 *   group      private N          WhatsApp group, Slack/Teams private channel
 *   channel    public N           Slack public channel, a local one
 *   broadcast  one-to-many        WhatsApp broadcast list
 *
 * Two axes are folded into this single one on purpose. `direct` and `multiple`
 * are defined by their roster and cannot be joined or left; `group` and
 * `channel` are named containers with a membership that changes, and differ
 * only in who may see them. `broadcast` is nobody's room at all — it fans out
 * to individual chats on the receiving side.
 *
 * Slack's four kinds map on exactly, so nothing is lost by not storing Slack's
 * own vocabulary: private_channel is `group`, the same shape as a WhatsApp
 * group, and public_channel is the only `channel`.
 */
export type ConversationType =
  | "direct"
  | "multiple"
  | "group"
  | "channel"
  | "broadcast";
