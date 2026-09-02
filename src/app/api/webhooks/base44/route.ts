/**
 * POST /api/webhooks/base44 — message.completed from the Superagent.
 *
 * Optional. Polling already finishes every run; this only removes the up-to-4s
 * gap between the agent finishing and the next poll noticing. Configure it in
 * the Superagent's Developer panel with a public URL, and set
 * BASE44_WEBHOOK_SECRET if you enable HMAC signing.
 *
 * Every field is treated as hostile: the signature is verified against the raw
 * bytes, event ids are single-use, and nothing in the payload can name a job.
 * It only nudges the poller for a conversation we already started.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { noteConversationActivity } from "@/lib/jobs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;
const seenEvents = new Map<string, number>();

/** Single-use event ids, with an hour of memory. */
function alreadyProcessed(id: string): boolean {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, at] of seenEvents) if (at < cutoff) seenEvents.delete(k);
  if (seenEvents.has(id)) return true;
  seenEvents.set(id, Date.now());
  return false;
}

function signatureValid(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=")).filter((kv): kv is [string, string] => kv.length === 2),
  );
  const provided = parts.v1 ?? (/^[a-f0-9]{64}$/i.test(header.trim()) ? header.trim() : null);
  if (!provided) return false;

  if (parts.t) {
    const ts = Number.parseInt(parts.t, 10);
    // Bounds how long a captured signature stays usable.
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  }

  const expected = createHmac("sha256", secret).update(parts.t ? `${parts.t}.${raw}` : raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
    return Response.json({ error: "too large" }, { status: 413 });
  }

  // Unsigned webhooks are refused. Without a secret there is no way to tell
  // this apart from anyone else posting to the endpoint.
  if (!env.base44WebhookSecret) {
    log.warn("webhook_secret_missing");
    return Response.json({ error: "not configured" }, { status: 403 });
  }
  const signature =
    req.headers.get("x-base44-signature") ??
    req.headers.get("x-signature") ??
    req.headers.get("x-webhook-signature");
  if (!signatureValid(raw, signature, env.base44WebhookSecret)) {
    log.warn("webhook_signature_rejected");
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    event = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const eventId =
    (typeof event.event_id === "string" && event.event_id) ||
    (typeof event.id === "string" && event.id) ||
    null;
  if (!eventId) return Response.json({ error: "invalid" }, { status: 400 });
  if (alreadyProcessed(eventId)) return Response.json({ received: true, duplicate: true });

  const type = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  const conversationId =
    (typeof event.conversation_id === "string" && event.conversation_id) ||
    (typeof event.conversationId === "string" && event.conversationId) ||
    null;

  log.info("webhook_received", { type, conversationId });

  // The payload never carries a job id we would trust. It only tells the
  // poller that this conversation has something new, so it checks immediately.
  if (conversationId && (type === "message.completed" || type === "message.created")) {
    noteConversationActivity(conversationId);
  }

  return Response.json({ received: true });
}
