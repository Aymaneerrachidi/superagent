/**
 * Access state and passphrase submission.
 *
 * GET  reports whether a passphrase is needed and whether this browser has it.
 * POST exchanges the passphrase for an HttpOnly cookie.
 */
import { NextResponse } from "next/server";
import { ACCESS_COOKIE, accessOpen, accessToken, codeMatches, hasAccess } from "@/lib/access";
import { base44Mode } from "@/lib/base44";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json(
    {
      needsCode: !accessOpen(),
      unlocked: hasAccess(req),
      // Shown in the UI so mock data is never mistaken for real research.
      mode: base44Mode(),
      enabled: env.analysisEnabled,
      // Bumped when poller behaviour changes, so a stale build is visible
      // from the browser rather than only from the server log.
      build: "identity-matching",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let code = "";
  try {
    const body = (await req.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code;
  } catch {
    /* empty body is simply a failed attempt */
  }

  if (!codeMatches(code)) {
    return NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  }

  // Set on the response rather than via next/headers, so the handler works
  // anywhere a Request is passed to it.
  const res = NextResponse.json({ unlocked: true });
  res.cookies.set(ACCESS_COOKIE, accessToken(), {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
