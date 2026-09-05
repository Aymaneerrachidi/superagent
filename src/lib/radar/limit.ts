import "server-only";

const buckets = new Map<string, number[]>();

export function radarCaller(req: Request): string {
  return req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "anonymous";
}

export function checkRadarLimit(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - (recent[0] as number))) / 1000)) };
  }
  recent.push(now);
  buckets.set(key, recent);
  return { ok: true };
}

export function resetRadarLimitsForTests(): void {
  buckets.clear();
}
