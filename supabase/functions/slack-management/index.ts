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
// Outgoing Slack messages are inserted with sender_address = the anchor
// (organization_address) + agent_id = the sending member; the dispatcher
// resolves the member's token via agent_id. This keeps the schema rule
// "sender = organization_address → dispatch" intact even though the actual
// wire identity is the member.
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
  oauthAccess,
  oauthRefresh,
  slackApi,
  SlackError,
} from "./slack.ts";
import { syncConnection } from "./sync.ts";

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
    .eq("ai", false)
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

  if (!redirect_uri) {
    throw new HTTPException(400, {
      message: "Missing 'redirect_uri' query param",
    });
  }

  return c.json({ url: buildAuthorizeUrl(redirect_uri, state) });
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

  if (!team?.id || !authed?.id || !authed.access_token) {
    throw new HTTPException(502, {
      message: "Slack OAuth response missing team or user token",
      cause: access as Json,
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

  // Workspace anchor (shared, ownerless) — conversations reference it.
  await client
    .from("organizations_addresses")
    .upsert({
      organization_id,
      service: "slack" as const,
      address: team.id,
      status: "connected",
      extra: { team_name: team.name, enterprise_id: access.enterprise?.id },
    })
    .throwOnError();

  // The member's personal identity + token.
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
        access_token: authed.access_token,
        refresh_token: authed.refresh_token,
        expires_at: authed.expires_in
          ? new Date(Date.now() + authed.expires_in * 1000).toISOString()
          : undefined,
        scopes: authed.scope,
      },
    })
    .throwOnError();

  log.info("Slack connected", { organization_id, address, agent: agent.id });

  // Initial sync inline: directory + the member's conversations. On failure
  // the connection stays usable; the UI can retry via POST /sync.
  try {
    const summary = await syncConnection(client, {
      organization_id,
      agent_id: agent.id,
      team_id: team.id,
      token: authed.access_token,
      slack_user_id: authed.id,
    });

    return c.json({ address, team_id: team.id, sync: summary });
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

    return c.json({ address, team_id: team.id, sync: null });
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

// Disconnect the calling member: revoke the token, mark the personal address
// disconnected, drop their visibility rows. Conversations and messages stay
// (org data already witnessed); the workspace anchor stays too, so other
// members' connections keep working.
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

  const client = createUnsecureClient();

  // merge_update merges extra, so nulling the token keys is how they get
  // cleared without touching team_id/slack_user_id.
  await client
    .from("organizations_addresses")
    .update({
      status: "disconnected",
      extra: { access_token: null, refresh_token: null },
    })
    .eq("organization_id", organization_id!)
    .eq("service", "slack")
    .eq("address", connection.address)
    .throwOnError();

  // Drop only the member's SLACK visibility rows — other services may share
  // conversations_agents. PostgREST cannot filter a delete through a joined
  // table, so fetch the ids first and delete in chunks.
  const { data: memberships } = await client
    .from("conversations_agents")
    .select("conversation_id, conversations!inner(service)")
    .eq("organization_id", organization_id!)
    .eq("agent_id", agent.id)
    .eq("conversations.service", "slack")
    .throwOnError();

  const ids = (memberships ?? []).map((m) => m.conversation_id);

  for (let i = 0; i < ids.length; i += 100) {
    await client
      .from("conversations_agents")
      .delete()
      .eq("agent_id", agent.id)
      .in("conversation_id", ids.slice(i, i + 100))
      .throwOnError();
  }

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
    const extra = connection.extra as {
      refresh_token: string;
      expires_at?: string;
    };

    // Refresh only when expiring within 12h (Slack tokens live ~12h; the
    // cron runs more often than that once rotation is on).
    if (
      extra.expires_at &&
      new Date(extra.expires_at).getTime() - Date.now() > 12 * 60 * 60 * 1000
    ) {
      summary.skipped++;
      continue;
    }

    try {
      const access = await oauthRefresh(extra.refresh_token);
      const authed = access.authed_user;

      if (!authed?.access_token) {
        throw new SlackError("Refresh response missing access_token", {
          cause: access,
        });
      }

      // merge_update keeps the untouched extra keys.
      await client
        .from("organizations_addresses")
        .update({
          extra: {
            access_token: authed.access_token,
            refresh_token: authed.refresh_token ?? extra.refresh_token,
            expires_at: authed.expires_in
              ? new Date(Date.now() + authed.expires_in * 1000).toISOString()
              : undefined,
          },
        })
        .eq("organization_id", connection.organization_id)
        .eq("service", "slack")
        .eq("address", connection.address)
        .throwOnError();

      summary.refreshed++;
    } catch (error) {
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
