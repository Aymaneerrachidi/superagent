import { NextResponse } from "next/server";
import { hasAccess } from "@/lib/access";
import { fetchRadarFeed, RadarError } from "@/lib/radar/client";
import { checkRadarLimit, radarCaller } from "@/lib/radar/limit";
import { RADAR_SESSION_COOKIE, radarConversationFrom, radarCookieOptions, radarSessionValue } from "@/lib/radar/session";
import type { RadarFeed } from "@/lib/radar/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

let cached: { feed: RadarFeed; at: number; mode: "live" | "fixture" } | null = null;
const CACHE_MS = 5 * 60_000;

const errorResponse = (error: unknown) => {
  const code = error instanceof RadarError ? error.code : "upstream";
  const map: Record<string, [string, number]> = {
    not_configured: ["Runner Radar is not configured yet.", 503],
    auth: ["Runner Radar credentials were rejected.", 502],
    rate_limit: ["Runner Radar is busy. Try again shortly.", 429],
    timeout: ["Runner Radar took too long. Try again.", 504],
    invalid_response: ["Runner Radar returned an invalid feed.", 502],
    upstream: ["Runner Radar is unavailable. Try again.", 502],
  };
  const [message, status] = map[code] ?? map.upstream as [string, number];
  return NextResponse.json({ error: message, code }, { status, headers: { "cache-control": "no-store" } });
};

export async function GET(req: Request) {
  if (!hasAccess(req)) return NextResponse.json({ error: "Enter the passphrase to continue." }, { status: 401 });
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return NextResponse.json({ feed: cached.feed, cached: true, mode: cached.mode }, { headers: { "cache-control": "private, no-store" } });
  }
  const limit = checkRadarLimit(`feed:${radarCaller(req)}`, 5, 5 * 60_000);
  if (!limit.ok) return NextResponse.json({ error: "Too many refreshes. Try again shortly.", code: "rate_limit", retryAfter: limit.retryAfter }, { status: 429, headers: { "retry-after": String(limit.retryAfter) } });
  try {
    const result = await fetchRadarFeed(radarConversationFrom(req));
    cached = { feed: result.feed, at: now, mode: result.mode };
    const response = NextResponse.json({ feed: result.feed, cached: false, mode: result.mode }, { headers: { "cache-control": "private, no-store" } });
    if (result.conversationId) response.cookies.set(RADAR_SESSION_COOKIE, radarSessionValue(result.conversationId), radarCookieOptions);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export function resetRadarFeedCacheForTests(): void { cached = null; }
