/**
 * Normalizes whatever shape the Superagent returns into the report contract.
 *
 * Size is checked before parsing, then every field is coerced. Anything
 * unrecognized is dropped rather than passed through, and nothing here is ever
 * treated as an instruction.
 */
import { reportSchema, computeMissingSections, type Report } from "@/lib/report/schema";

export type NormalizeResult =
  | { ok: true; report: Report }
  | { ok: false; code: "oversized_response" | "malformed_response"; detail: string };

export function byteSize(value: unknown): number {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return Buffer.byteLength(s ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Unwraps the common envelope shapes down to the report object itself. */
function unwrap(raw: unknown, depth = 0): unknown {
  if (depth > 5) return raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    const candidate = fenced?.[1]?.trim() ?? trimmed;
    if (candidate.startsWith("{")) {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ("answer" in obj || "catalysts" in obj || "bottomLine" in obj || "bottom_line" in obj) return obj;
    const inner = pick(obj, "report", "data", "result", "output", "response", "content", "message");
    return inner !== undefined ? unwrap(inner, depth + 1) : obj;
  }

  return raw;
}

/** Accepts both camelCase and snake_case keys from the upstream. */
function toCanonical(body: unknown, mint: string): Record<string, unknown> {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const token = pick(o, "token", "tokenIdentity", "token_identity", "identity");
  const tokenObj = (token && typeof token === "object" ? token : {}) as Record<string, unknown>;

  // Market data may arrive nested or flat.
  const market = pick(o, "market", "marketMovement", "market_movement");
  const marketObj = (market && typeof market === "object" ? market : {}) as Record<string, unknown>;

  const rawCatalysts = pick(o, "catalysts", "rankedCatalysts", "ranked_catalysts") ?? [];
  const rawSources = pick(o, "sources", "sourceLedger", "source_ledger", "citations") ?? [];

  // Social, wallet and creator findings collapse into one narrative field.
  const narrativeParts = [
    pick(o, "narrative"),
    pick(o, "social", "socialAnalysis", "social_analysis"),
    pick(o, "wallets", "walletActivity", "wallet_activity"),
    pick(o, "creator", "creatorActivity", "creator_activity"),
  ]
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        const s = pick(p, "summary", "narrative", "detail", "text");
        return typeof s === "string" ? s : "";
      }
      return "";
    })
    .filter(Boolean);

  return {
    answer: pick(o, "answer", "tenSecondAnswer", "ten_second_answer", "summary", "tldr") ?? "",
    token: {
      name: pick(tokenObj, "name") ?? null,
      symbol: pick(tokenObj, "symbol", "ticker") ?? null,
      mint,
      pool: pick(tokenObj, "pool", "primaryPool", "primary_pool", "dex") ?? null,
    },
    metrics: pick(marketObj, "metrics") ?? pick(o, "metrics") ?? [],
    marketSummary:
      pick(marketObj, "summary", "detail") ?? pick(o, "marketSummary", "market_summary") ?? "",
    catalysts: Array.isArray(rawCatalysts)
      ? rawCatalysts.map((c) => {
          const cc = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
          const conf = pick(cc, "confidence", "confidenceScore", "confidence_score");
          return {
            ...cc,
            // Accept 0-100 confidence and rescale to 0-1.
            confidence: typeof conf === "number" ? (conf > 1 ? conf / 100 : conf) : 0,
            sourceIds: pick(cc, "sourceIds", "source_ids", "sources") ?? [],
          };
        })
      : [],
    narrative: narrativeParts.join("\n\n"),
    risks: pick(o, "risks", "riskFactors", "risk_factors") ?? [],
    bottomLine: pick(o, "bottomLine", "bottom_line", "conclusion") ?? "",
    sources: Array.isArray(rawSources)
      ? rawSources.map((s, i) => {
          const ss = (s && typeof s === "object" ? s : { url: s }) as Record<string, unknown>;
          return {
            ...ss,
            id: typeof ss.id === "string" ? ss.id : `s${i + 1}`,
            title: typeof ss.title === "string" && ss.title ? ss.title : String(ss.url ?? "Source"),
          };
        })
      : [],
    snapshotAt: pick(o, "snapshotAt", "snapshot_at", "generatedAt") ?? new Date().toISOString(),
    missingSections: pick(o, "missingSections", "missing_sections") ?? [],
  };
}

export function normalizeBase44Payload(
  raw: unknown,
  opts: { mint: string; maxBytes: number },
): NormalizeResult {
  if (byteSize(raw) > opts.maxBytes) {
    return { ok: false, code: "oversized_response", detail: "Upstream response exceeded the size limit" };
  }

  const body = unwrap(raw);
  if (body === null || body === undefined || typeof body !== "object") {
    return { ok: false, code: "malformed_response", detail: "Upstream response was not a report object" };
  }

  const parsed = reportSchema.safeParse(toCanonical(body, opts.mint));
  if (!parsed.success) {
    // Naming the offending fields makes an upstream format change diagnosable
    // from the server log without dumping the payload.
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      code: "malformed_response",
      detail: `Report failed schema validation (${parsed.error.issues.length}): ${where}`,
    };
  }

  const report = parsed.data;
  // The mint is authoritative from our own validation, not from the upstream.
  if (report.token) report.token.mint = opts.mint;
  report.missingSections = computeMissingSections(report);

  if (byteSize(report) > opts.maxBytes) {
    return { ok: false, code: "oversized_response", detail: "Normalized report exceeded the size limit" };
  }

  return { ok: true, report };
}
