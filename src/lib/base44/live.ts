/**
 * The only module that talks to Base44.
 *
 * The API key is read here and nowhere else, on the server only. Failures are
 * classified so a bad key is never retried and a transient blip is.
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

/**
 * Defaults to the header `api_key: <key>`. Set BASE44_AUTH_HEADER=authorization
 * and BASE44_AUTH_SCHEME=Bearer for a bearer-token deployment.
 */
function authHeaders(): Record<string, string> {
  const name = env.base44AuthHeader || "api_key";
  const value = env.base44AuthScheme ? `${env.base44AuthScheme} ${env.base44ApiKey}` : env.base44ApiKey;
  return { [name]: value };
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(req: Base44Request): Promise<Base44Result> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), env.base44TimeoutMs);

  try {
    // The configured URL is used exactly as given. Appending or trimming a path
    // segment here is how you get a 404 against an endpoint that was correct.
    const res = await fetch(env.base44BaseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...authHeaders() },
      // The mint is sent as a structured field. User text never becomes an instruction.
      body: JSON.stringify({
        ...(env.base44AgentId ? { agent_id: env.base44AgentId } : {}),
        input: { chain: "solana", token_mint: req.mint },
        metadata: { job_id: req.jobId },
        response_format: "json",
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      // Never retried: a bad key will not fix itself and each attempt costs.
      return fail("auth_failed", `Upstream rejected credentials (${res.status})`, false, res.status);
    }
    if (!res.ok) {
      // The body often explains the real problem; it goes to the log (redacted),
      // never to the browser.
      const preview = (await res.text().catch(() => "")).slice(0, 300);
      log.warn("base44_http_error", { status: res.status, body: preview });
      return fail("upstream_error", `Upstream returned ${res.status}`, RETRYABLE.has(res.status), res.status);
    }

    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > env.base44MaxReportBytes) {
      return fail("oversized_response", "Upstream response exceeded the size limit", false);
    }

    const text = await res.text();
    if (byteSize(text) > env.base44MaxReportBytes) {
      return fail("oversized_response", "Upstream response exceeded the size limit", false);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    const normalized = normalizeBase44Payload(payload, {
      mint: req.mint,
      maxBytes: env.base44MaxReportBytes,
    });
    if (!normalized.ok) return fail(normalized.code, normalized.detail, false);
    return { ok: true, report: normalized.report };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (aborted) return fail("timeout", "Upstream did not respond in time", false);
    return fail("upstream_error", `Upstream request failed: ${log.redactError(err)}`, true);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

export class LiveBase44Adapter implements Base44Adapter {
  readonly mode = "live" as const;

  async analyze(req: Base44Request): Promise<Base44Result> {
    if (!env.base44BaseUrl || !env.base44ApiKey) {
      return fail("not_configured", "Base44 credentials are not configured", false);
    }

    const maxAttempts = Math.max(1, env.base44MaxRetries + 1);
    let last: Base44Result | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await sleep(Math.min(8_000, 500 * 2 ** (i - 1)) + Math.floor(Math.random() * 250));
      const result = await attempt(req);
      if (result.ok) return result;
      last = result;
      if (!result.retryable) return result;
      log.warn("base44_retry", { attempt: i, code: result.code });
    }

    return last ?? fail("upstream_error", "Upstream request failed", false);
  }
}
