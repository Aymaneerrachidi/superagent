/**
 * The only module that talks to Base44.
 *
 *   POST {base}/conversations                 -> conversation id
 *   POST {base}/conversations/{id}/messages   -> the CA, and nothing else
 *   GET  {base}/conversations/{id}   (polled)  -> narration, then the report
 *
 * Two properties of the live API drive the design:
 *
 *  - The key maps to ONE permanent conversation. It cannot be created, cleared
 *    or deleted (every such route 404s), and it is shared, so the reply is
 *    located by its position after our own message rather than by "newest
 *    assistant message".
 *  - That conversation is already megabytes. Size limits therefore apply to the
 *    extracted report, never to the transport envelope.
 *
 * The message sent is the validated mint and nothing more. The Superagent is
 * already configured with its research rules and output format; restating them
 * on every request only adds work, and therefore latency.
 *
 * The API key is read here and nowhere else, on the server only.
 */
import "server-only";
import { env } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { redact } from "@/lib/security/redact";
import { normalizeBase44Payload } from "@/lib/base44/normalize";
import { reportSchema, computeMissingSections } from "@/lib/report/schema";
import type {
  Base44Adapter,
  Base44Request,
  Base44Result,
  Base44FailureCode,
  Base44Timings,
} from "@/lib/base44/types";

/** Backstop against an unbounded response, not a report size limit. */
const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

/** Poll cadence. Each response carries the whole conversation, so unhurried. */
const POLL_MS = 4_000;

function emptyTimings(): Base44Timings {
  return {
    requestSentAt: null,
    firstProgressAt: null,
    completedAt: null,
    conversationId: null,
    messageId: null,
    polls: 0,
  };
}

function fail(
  code: Base44FailureCode,
  detail: string,
  retryable: boolean,
  timings: Base44Timings,
  httpStatus?: number,
): Base44Result {
  return { ok: false, code, detail: redact(detail), retryable, timings, ...(httpStatus ? { httpStatus } : {}) };
}

/** Base44 authenticates with a plain `api_key` header. */
function authHeaders(): Record<string, string> {
  const name = env.base44AuthHeader || "api_key";
  const value = env.base44AuthScheme ? `${env.base44AuthScheme} ${env.base44ApiKey}` : env.base44ApiKey;
  return { [name]: value, accept: "application/json" };
}

const base = () => env.base44BaseUrl.replace(/\/+$/, "");

type Json = Record<string, unknown>;
type Message = { id?: string; role?: string; content?: unknown };
type CallResult = { ok: true; data: unknown } | { ok: false; status: number; text: string };

async function call(
  method: "GET" | "POST",
  path: string,
  body: Json | undefined,
  signal: AbortSignal,
): Promise<CallResult> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 300) };
  if (Buffer.byteLength(text, "utf8") > MAX_CONVERSATION_BYTES) {
    return { ok: false, status: 413, text: "conversation payload too large" };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}

function messagesOf(conversation: unknown): Message[] {
  const c = conversation as Json | null;
  return c && Array.isArray(c.messages) ? (c.messages as Message[]) : [];
}

/** Content arrives as a string, or as parts carrying `text`. */
function contentOf(message: Message): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        part && typeof part === "object" && typeof (part as Json).text === "string"
          ? ((part as Json).text as string)
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * Assistant messages that answer our question, oldest first.
 *
 * The conversation is capped (it holds the most recent ~200 messages and drops
 * older ones), so message *indexes* are not stable across polls. Identity is:
 *
 *  1. Positional, when our own message is still present: everything after it.
 *  2. Otherwise, any assistant message whose id was not there before we posted.
 *
 * An earlier version subtracted a baseline count instead, which silently
 * scanned past the end of a capped array and found the reply never.
 */
function newAssistantReplies(
  conversation: unknown,
  anchorId: string | null,
  idsBefore: ReadonlySet<string>,
) {
  const messages = messagesOf(conversation);
  const collect = (from: number) => {
    const out: { id: string; text: string }[] = [];
    for (let i = from; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const text = contentOf(m);
      if (text.trim()) out.push({ id: m.id ?? `i${i}`, text });
    }
    return out;
  };

  if (anchorId) {
    const at = messages.findIndex((m) => m.id === anchorId);
    if (at >= 0) return collect(at + 1);
  }

  // Our message is gone or was never identified: anything unseen is new.
  const out: { id: string; text: string }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const id = m.id ?? `i${i}`;
    if (idsBefore.has(id)) continue;
    const text = contentOf(m);
    if (text.trim()) out.push({ id, text });
  }
  return out;
}

/**
 * Builds a readable report out of the agent's narration.
 *
 * Used only when a run is cut short -- a configured deadline, or a cancel.
 * What the agent established beats nothing, provided it is marked partial.
 */
function partialReportFrom(progress: string[], mint: string) {
  const parsed = reportSchema.safeParse({
    answer: progress[progress.length - 1] ?? "",
    token: { mint },
    narrative: progress.join("\n\n").slice(0, 2500),
  });
  if (!parsed.success) return null;
  const report = parsed.data;
  report.missingSections = computeMissingSections(report);
  return report;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sleeps up to `ms`, returning early if the webhook reports activity. Checked
 * on a short tick so a webhook cuts the wait without needing a real event bus.
 */
async function waitForChange(
  ms: number,
  conversationId: string,
  since: number,
  hasActivity: ((id: string, since: number) => boolean) | undefined,
): Promise<void> {
  if (!hasActivity) {
    await sleep(ms);
    return;
  }
  const step = 400;
  for (let waited = 0; waited < ms; waited += step) {
    await sleep(Math.min(step, ms - waited));
    if (hasActivity(conversationId, since)) return;
  }
}

export class LiveBase44Adapter implements Base44Adapter {
  readonly mode = "live" as const;

  async analyze(req: Base44Request): Promise<Base44Result> {
    const timings = emptyTimings();
    if (!env.base44BaseUrl || !env.base44ApiKey) {
      return fail("not_configured", "Base44 credentials are not configured", false, timings);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    // A budget of 0 means no hard stop here; the caller decides when to stop.
    const budgetMs = env.base44TimeoutMs;
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
    const timer = budgetMs > 0 ? setTimeout(() => controller.abort(), budgetMs) : null;

    const seen = new Set<string>();
    const progress: string[] = [];

    const salvage = (): Base44Result | null => {
      if (progress.length === 0) return null;
      const partial = partialReportFrom(progress, req.mint);
      if (!partial) return null;
      timings.completedAt = Date.now();
      return { ok: true, report: partial, partial: true, timings };
    };

    try {
      // 1. The conversation. The API returns the existing one for this key.
      // The body is required: this endpoint 422s on an empty POST.
      const created = await call("POST", "/conversations", { metadata: { job_id: req.jobId } }, controller.signal);
      if (!created.ok) {
        log.warn("base44_http_error", { step: "conversation", status: created.status, body: created.text });
        if (created.status === 401 || created.status === 403) {
          return fail("auth_failed", `Upstream rejected credentials (${created.status})`, false, timings, created.status);
        }
        return fail("upstream_error", `Conversation request returned ${created.status}`, false, timings, created.status);
      }

      const conversationId =
        typeof (created.data as Json)?.id === "string" ? ((created.data as Json).id as string) : null;
      if (!conversationId) return fail("malformed_response", "No conversation id returned", false, timings);
      timings.conversationId = conversationId;

      const convPath = `/conversations/${encodeURIComponent(conversationId)}`;

      // 2. Record which messages already exist. Ids, not a count: the
      //    conversation is capped, so counts do not survive new messages.
      const idsBefore = new Set<string>();
      const before = await call("GET", convPath, undefined, controller.signal);
      if (before.ok) {
        messagesOf(before.data).forEach((m, i) => idsBefore.add(m.id ?? `i${i}`));
      }

      // 3. Send the contract address, and nothing else.
      timings.requestSentAt = Date.now();
      const sent = await call(
        "POST",
        `${convPath}${env.base44MessagePath}`,
        { role: "user", content: req.mint },
        controller.signal,
      );
      if (!sent.ok) {
        log.warn("base44_http_error", { step: "add_message", status: sent.status, body: sent.text });
        return fail("upstream_error", `Add message returned ${sent.status}`, false, timings, sent.status);
      }
      const anchorId = typeof (sent.data as Json)?.id === "string" ? ((sent.data as Json).id as string) : null;
      timings.messageId = anchorId;

      log.info("base44_request_sent", {
        jobId: req.jobId,
        base44_conversation_id: conversationId,
        base44_message_id: anchorId,
        base44_request_sent_at: new Date(timings.requestSentAt).toISOString(),
        knownMessages: idsBefore.size,
      });

      // 4. Poll. Narration surfaces as it lands; a parseable report ends the run.
      while (Date.now() < deadline && !controller.signal.aborted) {
        const sleptFrom = Date.now();
        await waitForChange(POLL_MS, conversationId, sleptFrom, req.hasActivity);
        timings.polls += 1;

        const polled = await call("GET", convPath, undefined, controller.signal);
        if (!polled.ok) {
          log.warn("base44_poll_error", { status: polled.status });
          continue;
        }

        for (const reply of newAssistantReplies(polled.data, anchorId, idsBefore)) {
          if (seen.has(reply.id)) continue;
          seen.add(reply.id);

          const normalized = normalizeBase44Payload(reply.text, {
            mint: req.mint,
            maxBytes: env.base44MaxReportBytes,
          });
          if (normalized.ok) {
            timings.completedAt = Date.now();
            log.info("base44_completed", {
              jobId: req.jobId,
              base44_message_id: anchorId,
              base44_completed_at: new Date(timings.completedAt).toISOString(),
              durationSeconds: Math.round((timings.completedAt - (timings.requestSentAt ?? 0)) / 1000),
              polls: timings.polls,
              progressEvents: progress.length,
            });
            // The agent reports its own completeness.
            return { ok: true, report: normalized.report, partial: normalized.partial, timings };
          }

          // Not a report: the agent is narrating its work.
          timings.firstProgressAt ??= Date.now();
          progress.push(reply.text);
          req.onProgress?.({ at: Date.now(), text: reply.text });
        }
      }

      // 5. Only reached when a deadline was configured. Salvage what exists.
      const partial = salvage();
      if (partial) {
        log.warn("base44_partial", { jobId: req.jobId, progressEvents: progress.length, polls: timings.polls });
        return partial;
      }

      log.warn("base44_timeout", { jobId: req.jobId, polls: timings.polls, budgetMs });
      return fail("timeout", `No reply after ${timings.polls} polls`, false, timings);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return salvage() ?? fail("timeout", "Cancelled before a reply arrived", false, timings);
      }
      return fail("upstream_error", `Upstream request failed: ${log.redactError(err)}`, true, timings);
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}
