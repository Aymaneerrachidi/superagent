/**
 * Optional passphrase gate.
 *
 * Leave ACCESS_CODE unset and the app is simply open — the right default for a
 * personal project. Set it and visitors are asked for the passphrase once.
 *
 * The cookie holds an HMAC of the code rather than the code itself, so rotating
 * ACCESS_CODE invalidates every existing cookie.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const ACCESS_COOKIE = "witp_access";

function token(): string {
  const secret = env.sessionSecret || "dev-insecure-secret";
  return createHmac("sha256", secret).update(`access:${env.accessCode}`).digest("hex");
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when no passphrase is configured, so the app is open to anyone. */
export function accessOpen(): boolean {
  return env.accessCode.length === 0;
}

/** True when the supplied passphrase matches. */
export function codeMatches(supplied: unknown): boolean {
  const code = typeof supplied === "string" ? supplied.trim() : "";
  if (!code) return false;
  return equal(code, env.accessCode);
}

/** The value to store in the cookie once the passphrase checks out. */
export function accessToken(): string {
  return token();
}

/** True when the request carries a valid access cookie. */
export function hasAccess(req: Request): boolean {
  if (accessOpen()) return true;
  const header = req.headers.get("cookie");
  if (!header) return false;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE) return equal(decodeURIComponent(rest.join("=")), token());
  }
  return false;
}
