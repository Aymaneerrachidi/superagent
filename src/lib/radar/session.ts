import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const RADAR_SESSION_COOKIE = "witp_radar";

const sign = (id: string) => createHmac("sha256", env.sessionSecret || "dev-insecure-secret").update(`radar:${id}`).digest("base64url");

export function radarSessionValue(id: string): string {
  return `${id}.${sign(id)}`;
}

export function radarConversationFrom(req: Request): string | null {
  const raw = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${RADAR_SESSION_COOKIE}=`))?.slice(RADAR_SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const value = decodeURIComponent(raw);
  const split = value.lastIndexOf(".");
  if (split < 1) return null;
  const id = value.slice(0, split);
  const supplied = Buffer.from(value.slice(split + 1));
  const expected = Buffer.from(sign(id));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
}

export const radarCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.isProduction,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};
