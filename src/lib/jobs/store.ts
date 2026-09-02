/**
 * In-memory jobs, cache and spend guard.
 *
 * No database. For a handful of people on a single instance a Map is the right
 * amount of machinery — jobs are short-lived and a restart losing them costs
 * nothing. The guard exists for one reason: an accidental loop or a shared link
 * should not quietly run up a Base44 bill.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { log } from "@/lib/security/logger";
import { getBase44Adapter } from "@/lib/base44";
import type { Report } from "@/lib/report/schema";
import { computeMissingSections } from "@/lib/report/schema";
import type { StageKey } from "@/lib/jobs/types";

export type JobStatus = "running" | "done" | "error";

/** One line of the agent narration, as it arrived. */
export type Progress = { at: number; text: string };

export type Job = {
  id: string;
  address: string;
  status: JobStatus;
  stage: StageKey;
  startedAt: number;
  finishedAt: number | null;
  report: Report | null;
  /** True when the report is what the agent had at the deadline. */
  partial: boolean;
  /** The agent thinking, streamed to the UI as it happens. */
  progress: Progress[];
  /** Latency breakdown. Epoch milliseconds. */
  timing: {
    caReceivedAt: number;
    requestSentAt: number | null;
    firstProgressAt: number | null;
    completedAt: number | null;
    renderedAt: number | null;
  };
  base44: { conversationId: string | null; messageId: string | null };
  /** Already-friendly message. Never carries provider text. */
  error: string | null;
  /** Coarse failure category, safe to show. Helps you diagnose without leaking. */
  errorCode: string | null;
  cached: boolean;
  snapshotAt: string | null;
};

type CacheEntry = { report: Report; snapshotAt: string; at: number };

const jobs = new Map<string, Job>();
const cache = new Map<string, CacheEntry>();
const lastRunAt = new Map<string, number>();
let dayStamp = new Date().toDateString();
let dayCount = 0;

/** Drops jobs older than an hour so the map cannot grow without bound. */
function sweep() {
  const cutoff = Date.now() - 3_600_000;
  // Finished jobs are dropped after an hour. A running one is never dropped:
  // it has no deadline, and deleting it would strand work already paid for.
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.startedAt < cutoff) jobs.delete(id);
  }
  for (const [key, entry] of cache) {
    if (entry.at < Date.now() - env.cacheTtlSeconds * 1000) cache.delete(key);
  }
}

export type StartResult =
  | { ok: true; job: Job }
  | { ok: false; message: string; retryAfter?: number };

/** Lets a route attach long-running work to its host's request lifecycle. */
export type JobScheduler = (task: () => Promise<void>) => void;

/**
 * Runs an analysis to completion inside the current request.
 *
 * Serverless route handlers cannot hand an in-memory job to a later polling
 * request reliably: that request may execute in a different function instance.
 * Keeping the work and result in one invocation removes that dependency while
 * retaining the same spend guard, cache, normalization and logging paths.
 */
export async function startAnalysisAndWait(address: string, who: string): Promise<StartResult> {
  let task: (() => Promise<void>) | undefined;
  const started = startAnalysis(address, who, (scheduled) => {
    task = scheduled;
  });

  if (!started.ok || started.job.status !== "running") return started;

  if (task) {
    await task();
  } else {
    // Another request in this same process already owns the run. Wait on the
    // shared job object rather than buying the same report twice.
    while (started.job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return started;
}

/**
 * Starts an analysis, or returns a cached report.
 *
 * `who` is a coarse caller key (the access cookie, or "anon"). It only spaces
 * out requests; it is not an identity and nothing is stored against it.
 */
export function startAnalysis(address: string, who: string, schedule?: JobScheduler): StartResult {
  sweep();

  if (!env.analysisEnabled) {
    return { ok: false, message: "Analyses are paused right now. Check back shortly." };
  }

  // A completed report for the same address is reused rather than re-bought.
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < env.cacheTtlSeconds * 1000) {
    const job: Job = {
      id: randomUUID(),
      address,
      status: "done",
      stage: "building_report",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      report: hit.report,
      partial: false,
      progress: [],
      timing: {
        caReceivedAt: Date.now(),
        requestSentAt: null,
        firstProgressAt: null,
        completedAt: Date.now(),
        renderedAt: null,
      },
      base44: { conversationId: null, messageId: null },
      error: null,
      errorCode: null,
      cached: true,
      snapshotAt: hit.snapshotAt,
    };
    jobs.set(job.id, job);
    return { ok: true, job };
  }

  // One analysis at a time per caller: a second click returns the first job.
  for (const job of jobs.values()) {
    if (job.status === "running" && job.address === address) return { ok: true, job };
  }

  const now = Date.now();
  const last = lastRunAt.get(who) ?? 0;
  const waited = (now - last) / 1000;
  if (waited < env.cooldownSeconds) {
    return {
      ok: false,
      message: "Give it a few seconds before running another one.",
      retryAfter: Math.ceil(env.cooldownSeconds - waited),
    };
  }

  const today = new Date().toDateString();
  if (today !== dayStamp) {
    dayStamp = today;
    dayCount = 0;
  }
  if (dayCount >= env.maxPerDay) {
    return { ok: false, message: "Daily analysis limit reached. It resets at midnight." };
  }

  dayCount += 1;
  lastRunAt.set(who, now);

  const job: Job = {
    id: randomUUID(),
    address,
    status: "running",
    stage: "verifying_token",
    startedAt: now,
    finishedAt: null,
    report: null,
    partial: false,
    progress: [],
    timing: {
      caReceivedAt: now,
      requestSentAt: null,
      firstProgressAt: null,
      completedAt: null,
      renderedAt: null,
    },
    base44: { conversationId: null, messageId: null },
    error: null,
    errorCode: null,
    cached: false,
    snapshotAt: null,
  };
  jobs.set(job.id, job);
  if (schedule) schedule(() => run(job));
  else void run(job);
  return { ok: true, job };
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

/** Maps how far the agent has narrated onto the visible stage list. */
function stageForProgress(count: number): StageKey {
  const order: StageKey[] = [
    "verifying_token",
    "checking_market",
    "researching_narrative",
    "checking_wallets",
    "verifying_evidence",
    "building_report",
  ];
  return order[Math.min(count, order.length - 1)] as StageKey;
}

async function run(job: Job): Promise<void> {
  const controller = new AbortController();
  // No deadline by default. If PARTIAL_AFTER_SECONDS is set, the run stops
  // there and renders what the agent established rather than nothing.
  const partialAt =
    env.partialAfterSeconds > 0
      ? setTimeout(() => controller.abort(), env.partialAfterSeconds * 1000)
      : null;

  try {
    const result = await getBase44Adapter().analyze({
      mint: job.address,
      jobId: job.id,
      signal: controller.signal,
      hasActivity: (conversationId, since) => consumeConversationActivity(conversationId, since),
      onProgress: (event) => {
        job.progress.push(event);
        job.timing.firstProgressAt ??= event.at;
        job.stage = stageForProgress(job.progress.length);
        log.info("base44_progress", {
          jobId: job.id,
          n: job.progress.length,
          elapsedSeconds: Math.round((event.at - job.timing.caReceivedAt) / 1000),
        });
      },
    });

    job.base44 = {
      conversationId: result.timings?.conversationId ?? null,
      messageId: result.timings?.messageId ?? null,
    };
    job.timing.requestSentAt = result.timings?.requestSentAt ?? null;

    if (!result.ok) {
      const waited = Math.round((Date.now() - job.startedAt) / 1000);
      log.warn("analysis_failed", {
        jobId: job.id,
        code: result.code,
        detail: result.detail,
        status: result.httpStatus,
        waitedSeconds: waited,
      });
      job.status = "error";
      // Status first, then elapsed: together they say which call failed and
      // whether it failed instantly or after real work.
      job.errorCode = result.httpStatus
        ? `${result.code}:${result.httpStatus}:${waited}s`
        : `${result.code}:${waited}s`;
      job.error =
        result.code === "timeout"
          ? `Research ran ${Math.floor(waited / 60)}m ${waited % 60}s without finishing. Try again.`
          : result.code === "not_configured"
            ? "The research service is not connected yet."
            : result.code === "auth_failed"
              ? "The research service rejected our credentials."
              : result.code === "malformed_response"
                ? "The research service replied in an unexpected format."
                : result.code === "oversized_response"
                  ? "The research service returned too much data."
                  : "Could not finish that analysis. Try again shortly.";
      return;
    }

    const report = result.report;
    report.missingSections = computeMissingSections(report);
    const snapshotAt = report.snapshotAt || new Date().toISOString();

    job.stage = "building_report";
    job.report = report;
    job.partial = result.partial;
    job.snapshotAt = snapshotAt;
    job.timing.completedAt = result.timings?.completedAt ?? Date.now();
    job.status = "done";

    // A partial report is never cached: it would serve an unfinished answer to
    // everyone else for the whole cache window.
    if (!result.partial) cache.set(job.address, { report, snapshotAt, at: Date.now() });

    const t = job.timing;
    log.info("analysis_completed", {
      jobId: job.id,
      partial: result.partial,
      ca_received_at: new Date(t.caReceivedAt).toISOString(),
      base44_request_sent_at: t.requestSentAt ? new Date(t.requestSentAt).toISOString() : null,
      base44_message_id: job.base44.messageId,
      base44_completed_at: t.completedAt ? new Date(t.completedAt).toISOString() : null,
      // Where the time actually went.
      queueMs: t.requestSentAt ? t.requestSentAt - t.caReceivedAt : null,
      base44Ms: t.requestSentAt && t.completedAt ? t.completedAt - t.requestSentAt : null,
      totalMs: t.completedAt ? t.completedAt - t.caReceivedAt : null,
      progressEvents: job.progress.length,
    });
  } catch (err) {
    log.error("analysis_crashed", { jobId: job.id, error: log.redactError(err) });
    job.status = "error";
    job.errorCode = "internal_error";
    job.error = "Something went wrong on our side.";
  } finally {
    if (partialAt) clearTimeout(partialAt);
    job.finishedAt = Date.now();
  }
}

/** Shape sent to the browser. Deliberately excludes internal fields. */
export function publicJob(job: Job) {
  // Stamped on the first read of a finished job: the moment the browser could
  // render it, which closes the latency picture.
  if (job.status === "done" && job.timing.renderedAt === null) {
    job.timing.renderedAt = Date.now();
    log.info("website_rendered", {
      jobId: job.id,
      website_rendered_at: new Date(job.timing.renderedAt).toISOString(),
      handoffMs: job.timing.completedAt ? job.timing.renderedAt - job.timing.completedAt : null,
      totalMs: job.timing.renderedAt - job.timing.caReceivedAt,
    });
  }

  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    address: job.address,
    cached: job.cached,
    partial: job.partial,
    snapshotAt: job.snapshotAt,
    report: job.report,
    error: job.error,
    errorCode: job.errorCode,
    progress: job.progress,
    // Surfaced so the wait is never an opaque spinner.
    timing: {
      caReceivedAt: job.timing.caReceivedAt,
      requestSentAt: job.timing.requestSentAt,
      completedAt: job.timing.completedAt,
      elapsedMs: (job.timing.completedAt ?? Date.now()) - job.timing.caReceivedAt,
    },
  };
}

/**
 * Webhook hint: this conversation has new activity.
 *
 * Recorded so a waiting poll can check straight away instead of sleeping out
 * its interval. Deliberately advisory — the poller is correct on its own, and
 * the webhook is an optional latency optimisation, never a source of truth.
 */
const conversationActivity = new Map<string, number>();

export function noteConversationActivity(conversationId: string): void {
  conversationActivity.set(conversationId, Date.now());
}

export function consumeConversationActivity(conversationId: string, since: number): boolean {
  const at = conversationActivity.get(conversationId);
  if (at === undefined || at <= since) return false;
  conversationActivity.delete(conversationId);
  return true;
}
