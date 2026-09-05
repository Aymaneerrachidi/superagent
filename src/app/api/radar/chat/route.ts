import { NextResponse } from "next/server";
import { hasAccess } from "@/lib/access";
import { chatWithRadar, RadarError } from "@/lib/radar/client";
import { checkRadarLimit, radarCaller } from "@/lib/radar/limit";
import { RADAR_SESSION_COOKIE, radarConversationFrom, radarCookieOptions, radarSessionValue } from "@/lib/radar/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!hasAccess(req)) return NextResponse.json({ error: "Enter the passphrase to continue." }, { status: 401 });
  const limit = checkRadarLimit(`chat:${radarCaller(req)}`, 10, 60_000);
  if (!limit.ok) return NextResponse.json({ error: "Too many messages. Try again shortly.", code: "rate_limit", retryAfter: limit.retryAfter }, { status: 429 });
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > 8_192) return NextResponse.json({ error: "Keep the message under 2,000 characters." }, { status: 400 });
  let message = "";
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === "string") message = body.message.trim();
  } catch { return NextResponse.json({ error: "That request was not valid." }, { status: 400 }); }
  if (!message || message.length > 2_000) return NextResponse.json({ error: "Enter a message under 2,000 characters." }, { status: 400 });
  try {
    const result = await chatWithRadar(radarConversationFrom(req), message);
    const response = NextResponse.json({ reply: result.reply, mode: result.mode }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(RADAR_SESSION_COOKIE, radarSessionValue(result.conversationId), radarCookieOptions);
    return response;
  } catch (error) {
    const code = error instanceof RadarError ? error.code : "upstream";
    const status = code === "timeout" ? 504 : code === "rate_limit" ? 429 : code === "not_configured" ? 503 : 502;
    const messageText = code === "timeout" ? "Runner Radar took too long. Try again." : code === "not_configured" ? "Runner Radar is not configured yet." : "Runner Radar is unavailable. Try again.";
    return NextResponse.json({ error: messageText, code }, { status, headers: { "cache-control": "no-store" } });
  }
}
