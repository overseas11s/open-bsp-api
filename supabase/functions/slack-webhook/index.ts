// Slack Events API endpoint (single URL for every installed workspace).
//
// Request handling contract with Slack:
//   1. Authenticate via the v0 HMAC signature (signing secret, ±5 min
//      timestamp) — no bearer tokens; this URL is public.
//   2. Answer the url_verification handshake.
//   3. Ack within 3 seconds: respond 200 immediately and process the event
//      after the response via EdgeRuntime.waitUntil. Slack retries up to 3×
//      on failure; processing is idempotent (external_id upserts), so
//      retries are harmless and need no dedup store.
//
// Tenant resolution: team_id → the workspace anchor row (service 'slack',
// address = T…) → organization_id. One workspace = one org (enforced at
// connect time).
import * as log from "../_shared/logger.ts";
import { createUnsecureClient } from "../_shared/supabase.ts";
import { handleEvent, type SlackEnvelope } from "./events.ts";

const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";

const encoder = new TextEncoder();

async function verifySignature(req: Request, body: string): Promise<boolean> {
  if (!SIGNING_SECRET) {
    log.error("SLACK_SIGNING_SECRET is not configured");
    return false;
  }

  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!timestamp || !signature) return false;

  // Replay window
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`),
  );

  const expected = "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();

  if (!(await verifySignature(req, body))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const envelope = JSON.parse(body) as SlackEnvelope;

  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }

  if (envelope.type !== "event_callback") {
    log.warn(`Unhandled Slack envelope type ${envelope.type}`);
    return new Response();
  }

  const client = createUnsecureClient();

  // Resolve the tenant before acking — an unknown workspace is a hard 404
  // (stops Slack retrying a workspace we don't serve).
  const { data: anchor } = await client
    .from("organizations_addresses")
    .select("organization_id, extra")
    .eq("service", "slack")
    .eq("address", envelope.team_id ?? "")
    .maybeSingle()
    .throwOnError();

  if (!anchor) {
    log.warn("Slack event for unknown workspace", { team: envelope.team_id });
    return new Response("Unknown workspace", { status: 404 });
  }

  // The bot's own Slack user id, stored on the anchor when a bot install
  // granted one. Null in user-only workspaces — then nothing is ever
  // bot-reachable and every conversation stays member-gated.
  const bot_user_id =
    (anchor.extra as { bot_user_id?: string } | null)?.bot_user_id ?? null;

  const work = handleEvent(
    client,
    anchor.organization_id,
    envelope,
    bot_user_id,
  )
    .catch(
      (error) => {
        log.error(`Slack event processing failed (${envelope.event?.type})`, {
          error: error instanceof Error ? error.message : error,
          event_id: envelope.event_id,
          team: envelope.team_id,
        });
      },
    );

  // Ack now, work after the response. waitUntil exists on the deployed edge
  // runtime; fall back to inline awaiting when it doesn't (local tooling).
  const runtime = globalThis as unknown as {
    EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
  };

  if (runtime.EdgeRuntime?.waitUntil) {
    runtime.EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return new Response();
});
