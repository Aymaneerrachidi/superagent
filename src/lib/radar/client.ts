import "server-only";
import { env, radarConfigured } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { stripUnsafeChars } from "@/lib/security/text";
import { parseRadarFeed, type RadarFeed } from "@/lib/radar/schema";
import { radarFixture } from "@/lib/radar/fixture";

export const RADAR_FEED_PROMPT = "Return the latest Early Runner Radar results as strict JSON only. Use this exact root shape: {generated_at, verified_runners, quarantined_candidates}. For every item include chain_id (solana, base, bnb, or robinhood), contract_address, name, symbol, state, score (0-100), confidence (0-1), liquidity_usd, market_cap_usd, volume_5m, volume_15m, price_change_5m_pct, price_change_15m_pct, safety_status, reason_codes, observed_at, data_freshness (live, fresh, stale, or unknown), and evidence_links as direct public http(s) URLs. Use null for unavailable numeric values. Never treat missing, stale, or conflicting safety data as verified. Put Robinhood candidates without sellability verification in quarantined_candidates and include the exact missing-safety reason.";

type Message = { id?: string; role?: string; content?: unknown };
type Json = Record<string, unknown>;
type Call = { ok: true; data: unknown } | { ok: false; status: number };

export class RadarError extends Error {
  constructor(public readonly code: "not_configured" | "auth" | "rate_limit" | "timeout" | "upstream" | "invalid_response") {
    super(code);
  }
}

const base = () => env.radarBaseUrl.replace(/\/+$/, "");
const headers = () => ({ api_key: env.radarApiKey, accept: "application/json" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messagesOf(raw: unknown): Message[] {
  if (Array.isArray(raw)) return raw as Message[];
  return raw && typeof raw === "object" && Array.isArray((raw as Json).messages) ? (raw as Json).messages as Message[] : [];
}

function contentOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (message.content && typeof message.content === "object" && !Array.isArray(message.content)) return JSON.stringify(message.content);
  if (Array.isArray(message.content)) return message.content.map((part) => part && typeof part === "object" && typeof (part as Json).text === "string" ? (part as Json).text : "").join("");
  return "";
}

async function call(method: "GET" | "POST", path: string, body: Json | undefined, signal: AbortSignal, retryGet = true): Promise<Call> {
  const attempts = method === "GET" && retryGet ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(base() + path, {
        method, signal, cache: "no-store",
        headers: { ...headers(), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) { await sleep(300 * 2 ** attempt); continue; }
        return { ok: false, status: response.status };
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) return { ok: false, status: 413 };
      try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (attempt + 1 >= attempts) throw error;
      await sleep(300 * 2 ** attempt);
    }
  }
  return { ok: false, status: 502 };
}

async function ensureConversation(candidate: string | null, signal: AbortSignal): Promise<string> {
  const configured = candidate || env.radarConversationId;
  if (configured && /^[A-Za-z0-9_-]{8,128}$/.test(configured)) {
    const existing = await call("GET", `/conversations/${encodeURIComponent(configured)}`, undefined, signal);
    if (existing.ok) return configured;
  }
  const created = await call("POST", "/conversations", { metadata: { channel: "early-runner-radar" } }, signal, false);
  if (!created.ok) {
    if (created.status === 401 || created.status === 403) throw new RadarError("auth");
    throw new RadarError("upstream");
  }
  const id = created.data && typeof created.data === "object" ? (created.data as Json).id : null;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new RadarError("invalid_response");
  return id;
}

async function sendAndPoll<T>(conversationId: string, prompt: string, signal: AbortSignal, select: (replies: string[]) => T | null): Promise<T> {
  const path = `/conversations/${encodeURIComponent(conversationId)}`;
  const before = await call("GET", path, undefined, signal);
  const known = new Set(before.ok ? messagesOf(before.data).map((message, index) => message.id ?? `i${index}`) : []);
  const sent = await call("POST", `${path}/messages`, { role: "user", content: prompt }, signal, false);
  if (!sent.ok) {
    if (sent.status === 401 || sent.status === 403) throw new RadarError("auth");
    if (sent.status === 429) throw new RadarError("rate_limit");
    throw new RadarError("upstream");
  }
  for (;;) {
    await sleep(2_000);
    const conversation = await call("GET", path, undefined, signal);
    if (!conversation.ok) continue;
    const replies = messagesOf(conversation.data).flatMap((message, index) => {
      const id = message.id ?? `i${index}`;
      const content = contentOf(message).trim();
      return message.role === "assistant" && !known.has(id) && content ? [content] : [];
    });
    const selected = select(replies);
    if (selected !== null) return selected;
  }
}

async function run<T>(conversationId: string | null, prompt: string, select: (replies: string[]) => T | null): Promise<{ value: T; conversationId: string }> {
  if (!radarConfigured()) throw new RadarError("not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(env.radarTimeoutMs, 280_000));
  try {
    const id = await ensureConversation(conversationId, controller.signal);
    const value = await sendAndPoll(id, prompt, controller.signal, select);
    return { value, conversationId: id };
  } catch (error) {
    if (error instanceof RadarError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new RadarError("timeout");
    log.warn("radar_upstream_error", { detail: log.redactError(error) });
    throw new RadarError("upstream");
  } finally { clearTimeout(timer); }
}

export async function fetchRadarFeed(conversationId: string | null): Promise<{ feed: RadarFeed; conversationId: string | null; mode: "live" | "fixture" }> {
  if (!radarConfigured() && !env.isProduction) return { feed: radarFixture(), conversationId, mode: "fixture" };
  const result = await run(conversationId, RADAR_FEED_PROMPT, (replies) => {
    for (const reply of replies) { try { return parseRadarFeed(reply); } catch { /* checked below */ } }
    if (replies.length > 0) throw new RadarError("invalid_response");
    return null;
  });
  return { feed: result.value, conversationId: result.conversationId, mode: "live" };
}

export async function chatWithRadar(conversationId: string | null, message: string): Promise<{ reply: string; conversationId: string; mode: "live" }> {
  const result = await run(conversationId, message, (replies) => replies[replies.length - 1] ?? null);
  return { reply: stripUnsafeChars(result.value).slice(0, 12_000), conversationId: result.conversationId, mode: "live" };
}
