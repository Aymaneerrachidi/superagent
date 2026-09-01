/**
 * Secret redaction for logs and error paths.
 *
 * Anything that could carry a credential passes through here before it reaches
 * a log line, an API response or the browser.
 */
import { env } from "@/lib/env";

const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|api|key|token|secret|bearer)[-_a-z0-9]*\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /\beyJ[A-Za-z0-9._\-]{20,}/g, // JWT-shaped values
];

function secretValues(): string[] {
  return [env.base44ApiKey, env.sessionSecret, env.accessCode, env.base44BaseUrl, env.base44AgentId].filter(
    (v) => typeof v === "string" && v.length >= 8,
  );
}

export function redact(input: unknown): string {
  let text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}`
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return String(input);
            }
          })();

  for (const secret of secretValues()) {
    if (secret && text.includes(secret)) text = text.split(secret).join("[redacted]");
  }
  for (const re of PATTERNS) text = text.replace(re, "[redacted]");
  // Strip credentials embedded in any URL scheme, including database URLs.
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  return text.slice(0, 2000);
}

/** Deep-redacts an object for structured logging. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactObject(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|api[_-]?key|password|authorization|cookie)/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return redact(String(value));
}
