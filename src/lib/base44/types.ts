/** Typed boundary between the app and the Base44 Superagent. */
import type { Report } from "@/lib/report/schema";

export type Base44FailureCode =
  | "not_configured"
  | "auth_failed"
  | "timeout"
  | "oversized_response"
  | "malformed_response"
  | "upstream_error";

export type Base44Request = {
  /** Validated Solana mint. Never raw user text. */
  mint: string;
  jobId: string;
  signal?: AbortSignal;
};

export type Base44Result =
  | { ok: true; report: Report }
  | { ok: false; code: Base44FailureCode; detail: string; retryable: boolean; httpStatus?: number };

export interface Base44Adapter {
  readonly mode: "live" | "mock";
  analyze(req: Base44Request): Promise<Base44Result>;
}
