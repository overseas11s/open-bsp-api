// Minimal Slack Web API client for the management function. Only the methods
// the OAuth/connect/sync flows need — the webhook/dispatcher get their own.
import * as log from "../_shared/logger.ts";

const CLIENT_ID = Deno.env.get("SLACK_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SLACK_CLIENT_SECRET") ?? "";

/**
 * User scopes requested on install. The app acts as the member (xoxp token,
 * no bot token): their DMs, group DMs and channels. Keep this list in sync
 * with the app manifest — Slack rejects tokens whose grant is narrower than
 * what an API call needs, and marketplace review audits every entry.
 */
export const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "chat:write",
  "users:read",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

export class SlackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SlackError";
  }
}

export type OauthAccess = {
  ok: boolean;
  error?: string;
  app_id?: string;
  team?: { id: string; name: string };
  enterprise?: { id: string; name: string } | null;
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
    /** Present when token rotation is enabled for the app */
    refresh_token?: string;
    expires_in?: number;
  };
};

export type SlackUser = {
  id: string;
  name: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    real_name?: string;
    display_name?: string;
    image_192?: string;
  };
};

export type SlackChannel = {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  /** im only: the counterpart user id */
  user?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
};

type SlackEnvelope = {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
};

/**
 * Calls a Slack Web API method (form-encoded, as Slack prefers for GET-style
 * methods). Throws SlackError on `ok: false`; retries once on HTTP 429
 * honoring Retry-After.
 */
export async function slackApi(
  method: string,
  token: string | null,
  params: Record<string, string> = {},
  attempt = 0,
): Promise<SlackEnvelope> {
  const body = new URLSearchParams(params);

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

  if (response.status === 429 && attempt < 2) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
    log.warn(`Slack ${method} rate limited, retrying in ${retryAfter}s`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return await slackApi(method, token, params, attempt + 1);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    throw new SlackError(`Slack ${method} failed: ${payload.error}`, {
      cause: payload,
    });
  }

  return payload as SlackEnvelope;
}

/**
 * Iterates a cursor-paginated Slack method, yielding the items under `key`
 * page by page. `maxPages` bounds runaway workspaces; callers log truncation.
 */
export async function* slackPaginate<T>(
  method: string,
  token: string,
  key: string,
  params: Record<string, string> = {},
  maxPages = 25,
): AsyncGenerator<T[], void, unknown> {
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const payload = await slackApi(method, token, {
      ...params,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    yield (payload[key] ?? []) as T[];

    cursor = payload.response_metadata?.next_cursor || undefined;
    if (!cursor) return;
  }

  log.warn(`Slack ${method} pagination truncated after ${maxPages} pages`);
}

/** Exchanges an OAuth code (initial install). */
export async function oauthAccess(
  code: string,
  redirect_uri: string,
): Promise<OauthAccess> {
  return await slackApi("oauth.v2.access", null, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri,
  }) as OauthAccess;
}

/** Refreshes a rotated user token. */
export async function oauthRefresh(
  refresh_token: string,
): Promise<OauthAccess> {
  return await slackApi("oauth.v2.access", null, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
  }) as OauthAccess;
}

export function buildAuthorizeUrl(
  redirect_uri: string,
  state?: string,
): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("user_scope", USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirect_uri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Fetches a single user's profile (any workspace user token works). */
export async function usersInfo(
  token: string,
  user: string,
): Promise<SlackUser | null> {
  try {
    const payload = await slackApi("users.info", token, { user });
    return (payload.user ?? null) as SlackUser | null;
  } catch (error) {
    log.warn(`Slack users.info failed for ${user}`, error);
    return null;
  }
}

/**
 * Full list of installations an event applies to. The event payload itself
 * carries at most one authorization; this API (app-level xapp token) returns
 * them all. Falls back to null when no app token is configured — callers then
 * use the payload's partial list.
 */
export async function eventAuthorizations(
  event_context: string,
): Promise<Array<{ user_id: string; is_bot?: boolean }> | null> {
  const appToken = Deno.env.get("SLACK_APP_TOKEN");
  if (!appToken) return null;

  try {
    const payload = await slackApi(
      "apps.event.authorizations.list",
      appToken,
      { event_context },
    );
    return (payload.authorizations ?? []) as Array<
      { user_id: string; is_bot?: boolean }
    >;
  } catch (error) {
    log.warn("apps.event.authorizations.list failed", error);
    return null;
  }
}
