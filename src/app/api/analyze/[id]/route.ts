/** GET /api/analyze/:id — poll a running analysis. */
import { NextResponse } from "next/server";
import { hasAccess } from "@/lib/access";
import { getJob, publicJob } from "@/lib/jobs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!hasAccess(req)) {
    return NextResponse.json({ error: "Enter the passphrase to continue." }, { status: 401 });
  }

  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "That analysis has expired." }, { status: 404 });
  }

  return NextResponse.json(publicJob(job), { headers: { "cache-control": "no-store" } });
}
