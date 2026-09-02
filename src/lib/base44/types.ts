/** Typed boundary between the app and the Base44 Superagent. */
import type { Report } from "@/lib/report/schema";

export type Base44FailureCode =
  | "not_configured"
  | "auth_failed"
  | "timeout"
  | "oversized_response"
  | "malformed_response"
  | "upstream_error";

/** A progress line the agent posted while working. */
export type ProgressEvent = { at: number; text: string };

export type Base44Request = {
  /** Validated Solana mint. This is the entire message sent to the agent. */
  mint: string;
  jobId: string;
  signal?: AbortSignal;
  /** Called as the agent narrates, so the UI can show its thinking live. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Optional webhook hint. Returns true when the conversation has changed since
   * `since`, letting the poller skip the rest of its interval. Advisory only:
   * polling remains correct without it.
   */
  hasActivity?: (conversationId: string, since: number) => boolean;
};

/** Timings for the latency breakdown, in epoch milliseconds. */
export type Base44Timings = {
  requestSentAt: number | null;
  firstProgressAt: number | null;
  completedAt: number | null;
  conversationId: string | null;
  messageId: string | null;
  polls: number;
};

export type Base44Result =
  | {
      ok: true;
      report: Report;
      /** True when returned on the deadline without a finished report. */
      partial: boolean;
      timings: Base44Timings;
    }
  | {
      ok: false;
      code: Base44FailureCode;
      detail: string;
      retryable: boolean;
      httpStatus?: number;
      timings?: Base44Timings;
    };

export interface Base44Adapter {
  readonly mode: "live" | "mock";
  analyze(req: Base44Request): Promise<Base44Result>;
}
