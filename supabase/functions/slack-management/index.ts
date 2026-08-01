// Management for the 'slack' service. Unlike whatsapp/instagram this is a
// PER-MEMBER connection: the app acts as the logged-in user (xoxp user token),
// so any member may connect — but only for themselves, and only via a user
// JWT (API keys are org-scoped and cannot own a personal connection).
//
// Address rows per workspace:
//   - anchor:   address = team id (T…), agent_id null. Conversations hang off
//     this row, so they are stored once per workspace, not per member.
//   - personal: address = `${team}:${user}` (T…:U…), agent_id = the member's
//     agent. Holds the user token in extra. One per connected member.
//
// Outgoing Slack messages are inserted with sender_address null (the account
// spoke) + agent_id = the sending member; the dispatcher resolves the
// member's token via agent_id. The echo later fills sender_address with the
// member's Slack user id (fill-once in preserve_message_direction), which is
// when other members' UIs can attribute the message — clients should prefer
// not to render unechoed (sender null) rows in Slack conversations to avoid
// mis-attributing them as their own.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { type User } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { Json } from "../_shared/db_types.ts";
import { createClient, createUnsecureClient } from "../_shared/supabase.ts";
import {
  buildAuthorizeUrl,
  type ConnectMode,
  ensureFreshToken,
  oauthAccess,
  slackApi,
  type SlackConnection,
  SlackError,
} from "../_shared/slack.ts";
import { syncBotConnection, syncConnection } from "./sync.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// authorize-url only composes the public OAuth URL (client_id + scopes);
// refresh-tokens authenticates with the service-role key (cron).
const PUBLIC_SUFFIXES = ["/authorize-url", "/refresh-tokens"];

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: User;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    log.error(
      `${c.req.method} ${c.req.path} → ${err.status}: ${err.message}`,
      err.cause,
    );
    return Response.json(
      { message: err.message, cause: err.cause as Json },
      { status: err.status },
    );
  }

  if (err instanceof SlackError) {
    log.error(err.message, err.cause);
    return Response.json(
      { message: err.message, cause: err.cause as Json },
      { status: 502 },
    );
  }

  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
  return Response.json({ message: "Internal Server Error" }, { status: 500 });
});

// Validate the user JWT (skipped for the public routes above). No API-key
// branch on purpose — see the header comment.
app.use("*", async (c, next) => {
  if (PUBLIC_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix))) {
    await next();
    return;
  }

  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  const client = createClient(c.req.raw);
  // Pass the token explicitly: parameterless getUser() looks for a local
  // session (AuthSessionMissingError in an edge function).
  const { data: { user }, error: userError } = await client.auth.getUser(
    token,
  );

  if (userError || !user) {
    throw new HTTPException(401, { message: "Invalid JWT", cause: userError });
  }

  c.set("user", user);
  c.set("supabase", client);

  await next();
});

/**
 * Resolves the caller's own (human) agent in the organization. Any role may
 * connect Slack — the connection is theirs, not the org's.
 */
async function getOwnAgent(
  c: Context<AppEnv>,
  organization_id: string | undefined,
): Promise<{ id: string; organization_id: string }> {
  if (!organization_id) {
    throw new HTTPException(400, { message: "organization_id is required" });
  }

  const user = c.get("user");

  const { data: agent, error } = await c.get("supabase")
    .from("agents")
    .select("id, organization_id")
    .eq("user_id", user.id)
    .eq("organization_id", organization_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !agent) {
    throw new HTTPException(403, {
      message: `Not a member of organization ${organization_id}`,
      cause: error,
    });
  }

  return agent;
}

/** The caller's personal Slack address row, or 404. */
async function getOwnConnection(agent_id: string, organization_id: string) {
  const { data, error } = await createUnsecureClient()
    .from("organizations_addresses")
    .select()
    .eq("organization_id", organization_id)
    .eq("service", "slack")
    .eq("agent_id", agent_id)
    .maybeSingle();

  if (error || !data) {
    throw new HTTPException(404, {
      message: "No Slack connection for this member",
      cause: error,
    });
  }

  return data;
}

// Authorize URL helper — centralizes client_id + scopes for the frontend.
app.get("/slack-management/authorize-url", (c) => {
  const redirect_uri = c.req.query("redirect_uri");
  const state = c.req.query("state");
  const mode = (c.req.query("mode") ?? "user") as ConnectMode;

  if (!redirect_uri) {
    throw new HTTPException(400, {
      message: "Missing 'redirect_uri' query param",
    });
  }

  if (!["user", "bot", "both"].includes(mode)) {
    throw new HTTPException(400, {
      message: `Invalid 'mode' ${mode}; expected user, bot or both`,
    });
  }

  return c.json({ url: buildAuthorizeUrl(redirect_uri, state, mode) });
});

// Connect the calling member's Slack account (OAuth code exchange).
app.post("/slack-management/connect", async (c) => {
  const { organization_id, code, redirect_uri } = await c.req.json<{
    organization_id: string;
    code: string;
    redirect_uri: string;
  }>();

  if (!code || !redirect_uri) {
    throw new HTTPException(400, {
      message: "code and redirect_uri are required",
    });
  }

  const agent = await getOwnAgent(c, organization_id);

  const access = await oauthAccess(code, redirect_uri);
  const team = access.team;
  const authed = access.authed_user;

  // Which grant came back is decided by the authorize URL's mode: a bot token
  // arrives at the top level, the member's under authed_user. Either alone is
  // a valid install; neither is not.
  const bot_token = access.access_token;
  const user_token = authed?.access_token;

  if (!team?.id || (!bot_token && !user_token)) {
    throw new HTTPException(502, {
      message: "Slack OAuth response missing team, and bot and user tokens",
      // The official response type has no index signature; widen for logging.
      cause: access as unknown as Json,
    });
  }

  if (user_token && !authed?.id) {
    throw new HTTPException(502, {
      message: "Slack OAuth returned a user token without a user id",
      cause: access as unknown as Json,
    });
  }

  const client = createUnsecureClient();

  // One workspace belongs to one organization: the webhook resolves the
  // tenant by team id alone, so a second org connecting the same workspace
  // would be ambiguous.
  const { data: foreignAnchor } = await client
    .from("organizations_addresses")
    .select("organization_id")
    .eq("service", "slack")
    .eq("address", team.id)
    .neq("organization_id", organization_id)
    .maybeSingle()
    .throwOnError();

  if (foreignAnchor) {
    throw new HTTPException(409, {
      message:
        `Slack workspace ${team.id} is already connected to another organization`,
    });
  }

  // Workspace anchor (ownerless) — conversations reference it. Slack is an
  // intra-org service, so ownerless does NOT mean org-wide: visibility is
  // membership-based per is_conversation_visible. The bot token lives here
  // because a bot is workspace-wide and singular, unlike the per-member user
  // tokens below. set_extra merges, so a user-only reconnect leaves an
  // existing bot token intact and vice versa.
  await client
    .from("organizations_addresses")
    .upsert({
      organization_id,
      service: "slack" as const,
      address: team.id,
      status: "connected",
      extra: {
        team_name: team.name,
        enterprise_id: access.enterprise?.id,
        ...(bot_token
          ? {
            access_token: bot_token,
            bot_user_id: access.bot_user_id,
            bot_scopes: access.scope,
            // Bot tokens rotate too when rotation is enabled; store the
            // refresh side so ensureFreshToken can renew the anchor exactly
            // as it does a member's personal row.
            refresh_token: access.refresh_token,
            expires_at: access.expires_in
              ? new Date(Date.now() + access.expires_in * 1000).toISOString()
              : undefined,
          }
          : {}),
      },
    })
    .throwOnError();

  // A bot install is the shared-inbox connection: enumerate what the bot is
  // already in and clear `private` on those, so channels it was added to
  // before this install are reachable immediately rather than waiting for the
  // next member_joined_channel. Non-fatal — the webhook converges anyway.
  let bot_sync = null;

  if (bot_token) {
    try {
      bot_sync = await syncBotConnection(client, {
        organization_id,
        team_id: team.id,
        token: bot_token,
      });
    } catch (error) {
      log.error("Slack bot sync failed", error);
    }
  }

  // The member's personal identity + token — only when user scopes were
  // granted. A bot-only install has no member connection of its own.
  if (!user_token || !authed?.id) {
    log.info("Slack bot connected", { organization_id, team_id: team.id });

    return c.json({
      address: null,
      team_id: team.id,
      bot: true,
      sync: null,
      bot_sync,
    });
  }

  const address = `${team.id}:${authed.id}`;

  await client
    .from("organizations_addresses")
    .upsert({
      organization_id,
      service: "slack" as const,
      address,
      agent_id: agent.id,
      status: "connected",
      extra: {
        team_id: team.id,
        slack_user_id: authed.id,
        access_token: user_token,
        refresh_token: authed.refresh_token,
        expires_at: authed.expires_in
          ? new Date(Date.now() + authed.expires_in * 1000).toISOString()
          : undefined,
        scopes: authed.scope,
      },
    })
    .throwOnError();

  log.info("Slack connected", {
    organization_id,
    address,
    agent: agent.id,
    bot: Boolean(bot_token),
  });

  // Initial sync inline: directory + the member's conversations. On failure
  // the connection stays usable; the UI can retry via POST /sync.
  try {
    const summary = await syncConnection(client, {
      organization_id,
      agent_id: agent.id,
      team_id: team.id,
      token: user_token,
      slack_user_id: authed.id,
    });

    return c.json({
      address,
      team_id: team.id,
      bot: Boolean(bot_token),
      sync: summary,
      bot_sync,
    });
  } catch (error) {
    log.error("Slack initial sync failed", error);

    await client
      .from("logs")
      .insert({
        organization_id,
        organization_address: team.id,
        category: "sync",
        service: "slack",
        level: "error",
        message: "Slack initial sync failed; retry via POST /sync",
        metadata:
          (error instanceof SlackError ? error.cause : String(error)) as Json,
      })
      .throwOnError();

    return c.json({
      address,
      team_id: team.id,
      bot: Boolean(bot_token),
      sync: null,
      bot_sync,
    });
  }
});

// Re-run the sync for the calling member.
app.post("/slack-management/sync", async (c) => {
  const { organization_id } = await c.req.json<{ organization_id: string }>();

  const agent = await getOwnAgent(c, organization_id);
  const connection = await getOwnConnection(agent.id, organization_id);

  const extra = connection.extra as {
    team_id: string;
    slack_user_id: string;
    access_token: string;
  };

  const summary = await syncConnection(createUnsecureClient(), {
    organization_id,
    agent_id: agent.id,
    team_id: extra.team_id,
    token: extra.access_token,
    slack_user_id: extra.slack_user_id,
  });

  return c.json({ sync: summary });
});

// Disconnect the calling member: revoke the token, mark their personal
// address disconnected and clear the secrets. Everything else stays as is —
// visibility rows included, so the member keeps seeing their history (frozen
// until reconnect). Actually DELETING the personal address row is the
// stronger, separate operation (offboarding): the FK cascade then drops
// their visibility rows.
app.delete("/slack-management/connect", async (c) => {
  const organization_id = c.req.query("organization_id");

  const agent = await getOwnAgent(c, organization_id!);
  const connection = await getOwnConnection(agent.id, organization_id!);

  const extra = connection.extra as { access_token?: string };

  if (extra.access_token) {
    try {
      await slackApi("auth.revoke", extra.access_token);
    } catch (error) {
      // Already revoked/expired tokens are fine — proceed with local cleanup.
      log.warn("Slack auth.revoke failed", error);
    }
  }

  // merge_update merges extra, so nulling the token keys clears them without
  // touching team_id/slack_user_id.
  await createUnsecureClient()
    .from("organizations_addresses")
    .update({
      status: "disconnected",
      extra: { access_token: null, refresh_token: null },
    })
    .eq("organization_id", organization_id!)
    .eq("service", "slack")
    .eq("address", connection.address)
    .throwOnError();

  return c.json({});
});

// Token rotation (daily cron with the service-role key). No-op for
// non-rotated tokens (no refresh_token stored).
app.post("/slack-management/refresh-tokens", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const client = createUnsecureClient();

  const { data: connections } = await client
    .from("organizations_addresses")
    .select()
    .eq("service", "slack")
    .eq("status", "connected")
    .not("extra->>refresh_token", "is", null)
    .throwOnError();

  const summary = { refreshed: 0, failed: 0, skipped: 0 };

  for (const connection of connections ?? []) {
    const extra = connection.extra as SlackConnection["extra"];

    // Refresh only when expiring within 12h (Slack tokens live ~12h; the
    // cron runs every 4h).
    if (
      extra.expires_at &&
      new Date(extra.expires_at).getTime() - Date.now() > 12 * 60 * 60 * 1000
    ) {
      summary.skipped++;
      continue;
    }

    try {
      await ensureFreshToken(
        client,
        connection.organization_id,
        connection as SlackConnection,
        12 * 60 * 60 * 1000,
      );
      summary.refreshed++;
    } catch (error) {
      // A dead refresh token already flipped the connection to disconnected
      // inside ensureFreshToken, so the UI prompts a reconnect.
      log.error(
        `Slack token refresh failed for ${connection.address}`,
        error instanceof SlackError ? error.cause : error,
      );
      summary.failed++;
    }
  }

  return c.json(summary);
});

Deno.serve(app.fetch);
