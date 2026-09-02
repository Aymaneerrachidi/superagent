/**
 * Normalizes the Superagent's reply into the report contract.
 *
 * The agent has its own richer vocabulary — `drivers` rather than catalysts,
 * `movement` rather than market, `narrative` as a structured object — so the
 * mapping is written against what it actually emits, with generic fallbacks for
 * anything that arrives in a plainer shape.
 *
 * The payload is untrusted: size is checked before parsing, every field is
 * coerced, and anything unrecognized is dropped rather than passed through.
 */
import { reportSchema, computeMissingSections, type Report } from "@/lib/report/schema";

export type NormalizeResult =
  | { ok: true; report: Report; partial: boolean }
  | { ok: false; code: "oversized_response" | "malformed_response"; detail: string };

export function byteSize(value: unknown): number {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return Buffer.byteLength(s ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Some Superagent configurations return a finished human-readable Markdown
 * report instead of JSON. Recognize only the full report template (not ordinary
 * narration) and map its named sections onto the same canonical contract.
 */
function markdownReport(raw: unknown, mint: string): Json | null {
  if (typeof raw !== "string" || raw.length < 500) return null;
  const text = raw.trim();
  const required = [/^#\s+WHY IS .+ MOVING\?/im, /^##\s+10-SECOND ANSWER\s*$/im, /^##\s+BOTTOM LINE\s*$/im];
  if (!required.every((pattern) => pattern.test(text))) return null;

  const sections = new Map<string, string>();
  let current = "HEADER";
  const chunks = new Map<string, string[]>();
  chunks.set(current, []);
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      current = heading[1].trim().toUpperCase();
      chunks.set(current, []);
    } else {
      chunks.get(current)?.push(line);
    }
  }
  for (const [name, lines] of chunks) sections.set(name, lines.join("\n").trim());

  const answer = sections.get("10-SECOND ANSWER") ?? "";
  const bottomLine = sections.get("BOTTOM LINE") ?? "";
  if (!answer || !bottomLine) return null;

  const header = sections.get("HEADER") ?? "";
  const tokenLine = /\*\*Token:\*\*\s*([^\n]+)/i.exec(header)?.[1]?.trim() ?? "";
  const tokenMatch = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(tokenLine);
  const chain = /\*\*Chain:\*\*\s*([^\n]+)/i.exec(header)?.[1]?.trim();
  const snapshotRaw = /\*\*Snapshot:\*\*\s*([^\n]+)/i.exec(header)?.[1]?.trim();
  let snapshotAt: string | undefined;
  if (snapshotRaw) {
    const parsed = new Date(snapshotRaw.replace(/\s+UTC$/i, "Z").replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) snapshotAt = parsed.toISOString();
  }

  const story = [sections.get("THE STORY"), sections.get("SOCIAL MOMENTUM"), sections.get("WALLET ACTIVITY")]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const why = sections.get("WHY IT MOVED") ?? "";
  const riskText = sections.get("RISKS") ?? "";
  const sourcesText = sections.get("SOURCES") ?? "";

  const sources: Json[] = [];
  const seenUrls = new Set<string>();
  const linkPattern = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of sourcesText.matchAll(linkPattern)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({ id: `s${sources.length + 1}`, title, url });
    if (sources.length >= 60) break;
  }

  return {
    status: "completed",
    answer,
    token: {
      name: tokenMatch?.[1]?.trim() || null,
      symbol: tokenMatch?.[2]?.trim() || null,
      mint,
      pool: chain || null,
    },
    marketSummary: sections.get("KEY NUMBERS") ?? "",
    catalysts: why
      ? [{ title: "Why it moved", summary: why, confidence: 0, label: "UNKNOWN", sourceIds: [] }]
      : [],
    narrative: story,
    risks: riskText
      ? [{ title: "Reported risks", severity: "unknown", detail: riskText, label: "UNKNOWN", sourceIds: [] }]
      : [],
    bottomLine,
    sources,
    ...(snapshotAt ? { snapshotAt } : {}),
  };
}

// --- formatting for the market strip ---------------------------------------

function usd(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${Math.round(n / 1_000)}k`;
  // Sub-dollar prices need their significant digits, not two decimals.
  if (a < 1) return `$${n.toPrecision(3)}`;
  return `$${n.toFixed(2)}`;
}

function pct(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${n > 0 ? "+" : ""}${n.toFixed(n >= 100 || n <= -100 ? 0 : 2)}%`;
}

function dir(n: unknown): "up" | "down" | "flat" {
  if (typeof n !== "number" || !Number.isFinite(n)) return "flat";
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

/** Unwraps envelopes down to the report object itself. */
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
    const o = raw as Json;
    // A report-shaped object stops the unwrapping.
    for (const key of ["summary", "answer", "drivers", "catalysts", "bottom_line", "bottomLine"]) {
      if (key in o) return o;
    }
    const inner = pick(o, "report", "data", "result", "output", "response", "content", "message");
    return inner !== undefined ? unwrap(inner, depth + 1) : o;
  }

  return raw;
}

/**
 * The market strip.
 *
 * A plain `metrics` array is used as-is; otherwise the strip is derived from
 * whichever `movement` figures are present. Both shapes occur, so both are
 * handled rather than assuming the one the live agent happens to send today.
 */
function metricsFrom(o: Json, movement: Json): { label: string; value: string; direction: string }[] {
  const given = arr(o.metrics);
  if (given.length > 0) {
    return given.slice(0, 8).map((raw) => {
      const m = obj(raw);
      const value = m.value;
      return {
        label: str(pick(m, "label", "name")),
        value: typeof value === "number" ? (usd(value) ?? String(value)) : str(value),
        direction: str(m.direction) || "flat",
      };
    });
  }
  return derivedMetrics(movement);
}

/** The strip derived from the agent's `movement` object. */
function derivedMetrics(movement: Json): { label: string; value: string; direction: string }[] {
  const out: { label: string; value: string; direction: string }[] = [];
  const add = (label: string, value: string | null, direction: string) => {
    if (value !== null && out.length < 8) out.push({ label, value, direction });
  };

  add("24h", pct(movement.price_change_24h_pct), dir(movement.price_change_24h_pct));
  add("6h", pct(movement.price_change_6h_pct), dir(movement.price_change_6h_pct));
  add("1h", pct(movement.price_change_1h_pct), dir(movement.price_change_1h_pct));
  add("Price", usd(movement.price_usd), "flat");
  add("Market cap", usd(movement.market_cap_usd), "flat");
  add("Liquidity", usd(movement.liquidity_usd), "flat");
  add("Volume 24h", usd(movement.volume_24h_usd), "up");
  add("From 24h high", pct(movement.drawdown_from_24h_high_pct), dir(movement.drawdown_from_24h_high_pct));
  return out;
}

/** Prose describing the move, including the inflection the agent identified. */
function marketSummaryFrom(movement: Json): string {
  const parts: string[] = [];
  const classification = str(movement.classification);
  if (classification) parts.push(classification.replace(/_/g, " ").toLowerCase());

  const inflection = obj(movement.main_inflection);
  const at = str(inflection.time_utc);
  const change = pct(inflection.change_pct);
  const vol = usd(inflection.candle_volume_usd);
  if (at && change) {
    parts.push(
      `The main inflection was at ${at}: ${change} on a single candle${vol ? ` with ${vol} of volume` : ""}.`,
    );
  }
  return parts.join(". ").replace(/\.\./g, ".");
}

/**
 * Folds the narrative into prose.
 *
 * The agent sends a structured object plus separate social, wallet and creator
 * sections; a simpler reply may send a plain string. Both are accepted.
 */
function narrativeFrom(o: Json): string {
  const parts: string[] = [];
  if (typeof o.narrative === "string" && o.narrative.trim()) parts.push(o.narrative);
  const n = obj(o.narrative);

  const categories = arr(n.categories).filter((c) => typeof c === "string");
  if (categories.length) parts.push(`**Category:** ${categories.join(", ")}`);
  for (const key of ["origin", "lore", "token_connection", "maturity"]) {
    const v = str(n[key]);
    if (v) parts.push(v);
  }

  const social = arr(o.social);
  if (social.length) {
    const lines = social.slice(0, 8).map((raw) => {
      const s = obj(raw);
      const who = str(s.account) || "account";
      const when = str(s.published_at);
      const what = str(s.event) || str(s.classification);
      return `- ${who}${when ? ` (${when})` : ""}: ${what}`;
    });
    parts.push(`**Socials**\n${lines.join("\n")}`);
  }

  const wallets = arr(o.wallet_activity);
  if (wallets.length) {
    const lines = wallets.slice(0, 8).map((raw) => `- ${str(obj(raw).finding)}`).filter((l) => l.length > 2);
    if (lines.length) parts.push(`**Wallets**\n${lines.join("\n")}`);
  }

  const creator = obj(o.creator_activity);
  const creatorBits = Object.entries(creator)
    .filter(([k, v]) => typeof v === "string" && v && !["label", "status"].includes(k))
    .slice(0, 6)
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${String(v)}`);
  if (creatorBits.length) parts.push(`**Creator**\n${creatorBits.join("\n")}`);

  const limitations = arr(o.limitations).filter((l) => typeof l === "string");
  if (limitations.length) {
    parts.push(`**Limitations**\n${limitations.slice(0, 6).map((l) => `- ${l}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

/** Maps the agent's reply onto the report contract. */
function toCanonical(body: unknown, mint: string): Json {
  const o = obj(body);
  const token = obj(pick(o, "token", "tokenIdentity", "token_identity", "identity"));
  const movement = obj(pick(o, "movement", "market", "marketMovement", "market_movement"));

  // `drivers` is what this agent calls its ranked catalysts.
  const rawDrivers = arr(pick(o, "drivers", "catalysts", "rankedCatalysts", "ranked_catalysts"));
  const catalysts = rawDrivers.map((raw) => {
    const d = obj(raw);
    const confidence = pick(d, "confidence", "confidenceScore", "confidence_score", "score");
    return {
      title: str(pick(d, "title", "name")),
      // The agent puts its reasoning in `evidence`.
      summary: str(pick(d, "evidence", "summary", "detail", "description")),
      confidence: typeof confidence === "number" ? (confidence > 1 ? confidence / 100 : confidence) : 0,
      label: pick(d, "label", "classification") ?? "UNKNOWN",
      sourceIds: pick(d, "source_ids", "sourceIds", "sources") ?? [],
    };
  });

  const risks = arr(pick(o, "risks", "riskFactors", "risk_factors")).map((raw) => {
    const r = obj(raw);
    return {
      title: str(pick(r, "title", "name")),
      severity: str(pick(r, "severity", "level")).toLowerCase() || "unknown",
      detail: str(pick(r, "detail", "description", "summary")),
      label: pick(r, "label") ?? "UNKNOWN",
      sourceIds: pick(r, "source_ids", "sourceIds") ?? [],
    };
  });

  const sources = arr(pick(o, "sources", "sourceLedger", "source_ledger", "citations")).map((raw, i) => {
    const s = obj(raw);
    return {
      id: str(s.id) || `s${i + 1}`,
      title: str(pick(s, "title", "name")) || str(s.url) || "Source",
      url: s.url,
      publisher: pick(s, "publisher", "source"),
    };
  });

  return {
    answer: pick(o, "summary", "answer", "tenSecondAnswer", "ten_second_answer", "tldr") ?? "",
    token: {
      name: pick(token, "name") ?? null,
      symbol: pick(token, "symbol", "ticker") ?? null,
      mint,
      pool: pick(token, "primary_pool", "pool", "primaryPool", "dex") ?? null,
    },
    metrics: metricsFrom(o, movement),
    marketSummary:
      marketSummaryFrom(movement) ||
      str(pick(movement, "summary", "detail")) ||
      str(pick(o, "marketSummary", "market_summary")),
    catalysts,
    narrative: narrativeFrom(o),
    risks,
    bottomLine: pick(o, "bottom_line", "bottomLine", "conclusion") ?? "",
    sources,
    snapshotAt: pick(o, "snapshot_at", "snapshotAt", "generatedAt") ?? new Date().toISOString(),
    missingSections: [],
  };
}

export function normalizeBase44Payload(
  raw: unknown,
  opts: { mint: string; maxBytes: number },
): NormalizeResult {
  if (byteSize(raw) > opts.maxBytes) {
    return { ok: false, code: "oversized_response", detail: "Upstream response exceeded the size limit" };
  }

  const body = markdownReport(raw, opts.mint) ?? unwrap(raw);
  if (body === null || body === undefined || typeof body !== "object") {
    return { ok: false, code: "malformed_response", detail: "Upstream response was not a report object" };
  }

  const source = obj(body);
  // The agent reports its own completeness; a run still in progress is not a
  // report yet, so it is left to the poller rather than rendered.
  const status = str(source.status).toLowerCase();
  if (status && status !== "completed" && status !== "partial" && status !== "success") {
    return { ok: false, code: "malformed_response", detail: `Upstream status is "${status}"` };
  }

  const parsed = reportSchema.safeParse(toCanonical(source, opts.mint));
  if (!parsed.success) {
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

  return { ok: true, report, partial: source.partial === true || status === "partial" };
}
