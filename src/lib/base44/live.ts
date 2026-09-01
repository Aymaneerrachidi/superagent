/**
 * The only module that talks to Base44.
 *
 * Superagents are conversational, so this adapter:
 *
 *   POST {base}/conversations                 -> conversation id
 *   POST {base}/conversations/{id}/messages   -> post the question, keep its id
 *   GET  {base}/conversations/{id}   (polled)  -> read the reply that follows it
 *
 * Two properties of the live API drive the design here:
 *
 *  - The API returns ONE persistent conversation per key. It is shared and it
 *    grows without bound, so the reply is located by its position after our own
 *    message rather than by "newest assistant message" — otherwise a second
 *    person analysing at the same time could be handed our answer, or we theirs.
 *  - That conversation payload is already megabytes. Size limits therefore apply
 *    to the extracted report, never to the transport envelope.
 *
 * The API key is read here and nowhere else, on the server only.
 */
import "server-only";
import { env } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { redact } from "@/lib/security/redact";
import { normalizeBase44Payload } from "@/lib/base44/normalize";
import type { Base44Adapter, Base44Request, Base44Result, Base44FailureCode } from "@/lib/base44/types";

/**
 * Ceiling on a conversation payload. Generous: it holds the entire history, not
 * a report, and exists only to stop an unbounded response exhausting memory.
 */
const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

function fail(
  code: Base44FailureCode,
  detail: string,
  retryable: boolean,
  httpStatus?: number,
): Base44Result {
  return { ok: false, code, detail: redact(detail), retryable, ...(httpStatus ? { httpStatus } : {}) };
}

/** Base44 authenticates with a plain `api_key` header. */
function authHeaders(): Record<string, string> {
  const name = env.base44AuthHeader || "api_key";
  const value = env.base44AuthScheme ? `${env.base44AuthScheme} ${env.base44ApiKey}` : env.base44ApiKey;
  return { [name]: value, accept: "application/json" };
}

const base = () => env.base44BaseUrl.replace(/\/+$/, "");

/**
 * The question put to the Superagent.
 *
 * The mint is already validated as a 32-byte Base58 key, so interpolating it
 * cannot inject instructions.
 */
function buildPrompt(mint: string): string {
  return [
    `Analyze the Solana token with contract address ${mint}.`,
    "",
    "Reply with ONLY a JSON object inside a ```json code fence, with these keys:",
    '- "answer": one paragraph explaining why it is moving',
    '- "token": { "name", "symbol", "pool" }',
    '- "metrics": [{ "label", "value", "direction": "up"|"down"|"flat" }]',
    '- "marketSummary": string',
    '- "catalysts": [{ "title", "summary", "confidence": 0-1, "label": "FACT"|"INFERENCE"|"UNKNOWN", "sourceIds": [] }]',
    '- "narrative": string covering socials, creator and wallet activity',
    '- "risks": [{ "title", "severity": "low"|"medium"|"high"|"critical"|"unknown", "detail", "label", "sourceIds": [] }]',
    '- "bottomLine": string',
    '- "sources": [{ "id": "s1", "title", "url", "publisher" }]',
    "",
    "Label every claim FACT (verified against a source), INFERENCE (reasoned) or",
    "UNKNOWN (could not establish). Cite sources by id. Do not invent sources.",
  ].join("\n");
}

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

/** Message content arrives as a string, or as parts carrying `text`. */
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
 * Assistant messages posted after our own question, oldest first.
 *
 * The agent narrates its progress ("I'm validating the exact mint...") before
 * delivering the report, so there is no single "the reply" message. The caller
 * tries each candidate and keeps waiting until one parses.
 */
function repliesAfterAnchor(
  conversation: unknown,
  anchorId: string | null,
  baselineCount: number,
): string[] {
  const messages = messagesOf(conversation);

  let start = -1;
  if (anchorId) start = messages.findIndex((m) => m.id === anchorId);
  // Without an anchor, anything beyond the pre-existing count is new.
  if (start < 0) start = baselineCount - 1;

  const out: string[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = contentOf(m);
    if (content.trim()) out.push(content);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveBase44Adapter implements Base44Adapter {
  readonly mode = "live" as const;

  async analyze(req: Base44Request): Promise<Base44Result> {
    if (!env.base44BaseUrl || !env.base44ApiKey) {
      return fail("not_configured", "Base44 credentials are not configured", false);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = Date.now() + env.base44TimeoutMs;
    const timer = setTimeout(() => controller.abort(), env.base44TimeoutMs);

    try {
      // 1. Get the conversation. The API returns the existing one for this key.
      const created = await call("POST", "/conversations", { metadata: { job_id: req.jobId } }, controller.signal);
      if (!created.ok) {
        log.warn("base44_http_error", { step: "conversation", status: created.status, body: created.text });
        if (created.status === 401 || created.status === 403) {
          return fail("auth_failed", `Upstream rejected credentials (${created.status})`, false, created.status);
        }
        return fail("upstream_error", `Conversation request returned ${created.status}`, false, created.status);
      }

      const conversationId = typeof (created.data as Json)?.id === "string" ? ((created.data as Json).id as string) : null;
      if (!conversationId) return fail("malformed_response", "No conversation id returned", false);

      const convPath = `/conversations/${encodeURIComponent(conversationId)}`;

      // 2. Record how much history already exists. The create response omits
      //    messages, so this needs its own read.
      let baselineCount = 0;
      const before = await call("GET", convPath, undefined, controller.signal);
      if (before.ok) baselineCount = messagesOf(before.data).length;

      // 3. Post the question and keep the id of our own message.
      const sent = await call(
        "POST",
        `${convPath}${env.base44MessagePath}`,
        { role: "user", content: buildPrompt(req.mint) },
        controller.signal,
      );
      if (!sent.ok) {
        log.warn("base44_http_error", { step: "add_message", status: sent.status, body: sent.text });
        return fail("upstream_error", `Add message returned ${sent.status}`, false, sent.status);
      }
      const anchorId = typeof (sent.data as Json)?.id === "string" ? ((sent.data as Json).id as string) : null;
      log.info("base44_question_sent", { jobId: req.jobId, anchored: anchorId !== null, baselineCount });

      // 4. Poll until a reply parses into a report.
      //
      //    Intermediate progress messages are expected and are not failures:
      //    an unparseable message means the agent is still working, so polling
      //    continues. Only at the deadline, having seen assistant output that
      //    never became a report, is that reported as a malformed reply.
      let delay = 3_000;
      let sawContent = false;
      let lastPreview = "";

      while (Date.now() < deadline) {
        await sleep(delay);
        delay = Math.min(10_000, Math.round(delay * 1.25));

        const polled = await call("GET", convPath, undefined, controller.signal);
        if (!polled.ok) {
          log.warn("base44_poll_error", { status: polled.status });
          continue;
        }

        const candidates = repliesAfterAnchor(polled.data, anchorId, baselineCount);
        // Newest first: the report is the last thing the agent says.
        for (const content of [...candidates].reverse()) {
          sawContent = true;
          lastPreview = content.slice(0, 200);
          const normalized = normalizeBase44Payload(content, {
            mint: req.mint,
            maxBytes: env.base44MaxReportBytes,
          });
          if (normalized.ok) return { ok: true, report: normalized.report };
        }
      }

      if (sawContent) {
        log.warn("base44_never_parsed", { jobId: req.jobId, preview: lastPreview });
        return fail(
          "malformed_response",
          "The agent replied but never produced a parseable report",
          false,
        );
      }
      return fail("timeout", "Upstream did not reply in time", false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return fail("timeout", "Upstream did not respond in time", false);
      }
      return fail("upstream_error", `Upstream request failed: ${log.redactError(err)}`, true);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}
