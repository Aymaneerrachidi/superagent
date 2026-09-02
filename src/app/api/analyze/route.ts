/**
 * POST /api/analyze — start an analysis.
 *
 * The browser never reaches Base44. It talks to this route, which validates the
 * address, applies the spend guard, and calls the adapter server-side.
 */
import { after, NextResponse } from "next/server";
import { hasAccess } from "@/lib/access";
import { validateSolanaAddress, ADDRESS_MESSAGES, MAX_INPUT_LENGTH } from "@/lib/solana/address";
import { startAnalysis, publicJob } from "@/lib/jobs/store";
import { ACCESS_COOKIE } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby accepts at most 300 seconds. `after()` below keeps the Base44
// work attached to the invocation after the 202 response has been sent.
export const maxDuration = 300;

const no = (message: string, status: number, retryAfter?: number) =>
  NextResponse.json(
    { error: message, ...(retryAfter ? { retryAfter } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );

/** A coarse key used only to space out requests. Not an identity. */
function callerKey(req: Request): string {
  const cookie = req.headers.get("cookie") ?? "";
  const match = new RegExp(`${ACCESS_COOKIE}=([^;]+)`).exec(cookie);
  return match?.[1]?.slice(0, 32) ?? "anon";
}

export async function POST(req: Request) {
  if (!hasAccess(req)) return no("Enter the passphrase to continue.", 401);

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > 2048) return no("That request was too large.", 400);

  let address = "";
  try {
    const body = JSON.parse(raw || "{}") as { address?: unknown };
    if (typeof body.address === "string") address = body.address;
  } catch {
    return no("That request wasn't valid.", 400);
  }
  if (address.length > MAX_INPUT_LENGTH * 4) return no(ADDRESS_MESSAGES.too_long, 400);

  const check = validateSolanaAddress(address);
  if (!check.ok) return no(ADDRESS_MESSAGES[check.code], 400);

  // `after` maps to the platform's waitUntil primitive. Without it, an
  // un-awaited promise may be abandoned as soon as this handler returns,
  // leaving an in-memory job stuck in "running". Unit tests call the handler
  // outside a Next request scope, so they intentionally use the immediate
  // scheduler retained by startAnalysis.
  const schedule = process.env.NODE_ENV === "test" ? undefined : after;
  const started = startAnalysis(check.address, callerKey(req), schedule);
  if (!started.ok) return no(started.message, 429, started.retryAfter);

  return NextResponse.json(publicJob(started.job), {
    status: 202,
    headers: { "cache-control": "no-store" },
  });
}
