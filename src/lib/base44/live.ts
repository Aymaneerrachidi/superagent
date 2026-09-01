/**
 * The only module that talks to Base44.
 *
 * Superagents are conversational, not request/response: you create a
 * conversation, post a message, and the assistant's reply arrives on the
 * conversation some time later. So this adapter does:
 *
 *   POST {base}/conversations                       -> conversation id
 *   POST {base}/conversations/{id}/messages         -> post the question
 *   GET  {base}/conversations/{id}   (polled)       -> wait for the reply
 *
 * The API key is read here and nowhere else, on the server only.
 */
import "server-only";
import { env } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { redact } from "@/lib/security/redact";
import { normalizeBase44Payload, byteSize } from "@/lib/base44/normalize";
import type { Base44Adapter, Base44Request, Base44Result, Base44FailureCode } from "@/lib/base44/types";

function fail(
  code: Base44FailureCode,
  detail: string,
  retryable: boolean,
  httpStatus?: number,
): Base44Result {
  return { ok: false, code, detail: redact(detail), retryable, ...(httpStatus ? { httpStatus } : {}) };
}

/** Base44 authenticates with a plain `api_key` header. Overridable if that changes. */
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
 * cannot inject instructions. Asking for JSON keeps the reply parseable; the
 * normalizer falls back gracefully when the agent answers in prose instead.
 */
function buildPrompt(mint: string): string {
  return [
    `Analyze the Solana token with contract address ${mint}.`,
    "",
    "Return ONLY a JSON object inside a ```json code fence, with these keys:",
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

async function call(
  method: "GET" | "POST",
  path: string,
  body: Json | undefined,
  signal: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; text: string }> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 300) };
  if (byteSize(text) > env.base44MaxReportBytes * 4) {
    return { ok: false, status: 413, text: "response too large" };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}

type Message = { id?: string; role?: string; content?: unknown };

function messagesOf(conversation: unknown): Message[] {
  const c = conversation as Json | null;
  const list = c && Array.isArray(c.messages) ? (c.messages as Message[]) : [];
  return list;
}

/** The newest assistant message carrying non-empty content. */
function latestAssistantContent(conversation: unknown, knownIds: Set<string>): string | null {
  const messages = messagesOf(conversation);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (m.id && knownIds.has(m.id)) continue;
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((part) =>
                part && typeof part === "object" && typeof (part as Json).text === "string"
                  ? ((part as Json).text as string)
                  : "",
              )
              .join("")
          : "";
    if (content.trim()) return content;
  }
  return null;
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
      // 1. Open a conversation.
      const created = await call("POST", "/conversations", { metadata: { job_id: req.jobId } }, controller.signal);
      if (!created.ok) {
        log.warn("base44_http_error", { step: "create_conversation", status: created.status, body: created.text });
        if (created.status === 401 || created.status === 403) {
          return fail("auth_failed", `Upstream rejected credentials (${created.status})`, false, created.status);
        }
        return fail("upstream_error", `Create conversation returned ${created.status}`, false, created.status);
      }

      const conv = created.data as Json;
      const conversationId = typeof conv?.id === "string" ? conv.id : null;
      if (!conversationId) return fail("malformed_response", "No conversation id returned", false);

      // Messages already present are not answers to our question.
      const priorIds = new Set(
        messagesOf(conv)
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string"),
      );

      // 2. Post the question.
      const sent = await call(
        "POST",
        `/conversations/${encodeURIComponent(conversationId)}${env.base44MessagePath}`,
        { role: "user", content: buildPrompt(req.mint) },
        controller.signal,
      );
      if (!sent.ok) {
        log.warn("base44_http_error", { step: "add_message", status: sent.status, body: sent.text });
        return fail("upstream_error", `Add message returned ${sent.status}`, false, sent.status);
      }

      // 3. Poll until the assistant replies.
      let delay = 2_000;
      while (Date.now() < deadline) {
        await sleep(delay);
        delay = Math.min(6_000, Math.round(delay * 1.3));

        const polled = await call(
          "GET",
          `/conversations/${encodeURIComponent(conversationId)}`,
          undefined,
          controller.signal,
        );
        if (!polled.ok) {
          // A transient poll failure is not fatal; the work continues upstream.
          log.warn("base44_poll_error", { status: polled.status });
          continue;
        }

        const content = latestAssistantContent(polled.data, priorIds);
        if (!content) continue;

        const normalized = normalizeBase44Payload(content, {
          mint: req.mint,
          maxBytes: env.base44MaxReportBytes,
        });
        if (!normalized.ok) {
          log.warn("base44_unparseable_reply", { code: normalized.code, preview: content.slice(0, 200) });
          return fail(normalized.code, normalized.detail, false);
        }
        return { ok: true, report: normalized.report };
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
