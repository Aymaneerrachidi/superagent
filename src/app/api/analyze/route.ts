/**
 * POST /api/analyze — start an analysis.
 *
 * The browser never reaches Base44. It talks to this route, which validates the
 * address, applies the spend guard, and calls the adapter server-side.
 */
import { NextResponse } from "next/server";
import { hasAccess } from "@/lib/access";
import { validateSolanaAddress, ADDRESS_MESSAGES, MAX_INPUT_LENGTH } from "@/lib/solana/address";
import { startAnalysis, publicJob } from "@/lib/jobs/store";
import { ACCESS_COOKIE } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Vercel caps how long a function may run. The research call continues after
 * this response is sent, so the ceiling has to cover it. 800s is the Fluid
 * Compute maximum; locally this value is ignored.
 */
export const maxDuration = 800;

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

  const started = startAnalysis(check.address, callerKey(req));
  if (!started.ok) return no(started.message, 429, started.retryAfter);

  return NextResponse.json(publicJob(started.job), {
    status: 202,
    headers: { "cache-control": "no-store" },
  });
}
