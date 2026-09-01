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

export type Job = {
  id: string;
  address: string;
  status: JobStatus;
  stage: StageKey;
  startedAt: number;
  finishedAt: number | null;
  report: Report | null;
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
  for (const [id, job] of jobs) if (job.startedAt < cutoff) jobs.delete(id);
  for (const [key, entry] of cache) {
    if (entry.at < Date.now() - env.cacheTtlSeconds * 1000) cache.delete(key);
  }
}

export type StartResult =
  | { ok: true; job: Job }
  | { ok: false; message: string; retryAfter?: number };

/**
 * Starts an analysis, or returns a cached report.
 *
 * `who` is a coarse caller key (the access cookie, or "anon"). It only spaces
 * out requests; it is not an identity and nothing is stored against it.
 */
export function startAnalysis(address: string, who: string): StartResult {
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
    error: null,
    errorCode: null,
    cached: false,
    snapshotAt: null,
  };
  jobs.set(job.id, job);
  void run(job);
  return { ok: true, job };
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

/** Advances the visible stage while the single upstream call is in flight. */
function scheduleStages(job: Job): NodeJS.Timeout[] {
  const plan: [StageKey, number][] = [
    ["checking_market", 1_200],
    ["researching_narrative", 4_000],
    ["checking_wallets", 9_000],
    ["verifying_evidence", 15_000],
  ];
  return plan.map(([stage, delay]) =>
    setTimeout(() => {
      if (job.status === "running") job.stage = stage;
    }, delay),
  );
}

async function run(job: Job): Promise<void> {
  const timers = scheduleStages(job);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.base44TimeoutMs);

  try {
    const result = await getBase44Adapter().analyze({
      mint: job.address,
      jobId: job.id,
      signal: controller.signal,
    });

    if (!result.ok) {
      // The provider's own words never reach the browser.
      const waited = Math.round((Date.now() - job.startedAt) / 1000);
      log.warn("analysis_failed", {
        code: result.code,
        detail: result.detail,
        status: result.httpStatus,
        waitedSeconds: waited,
      });
      job.status = "error";
      // The elapsed time makes a failure self-diagnosing: one at 60s points at a
      // stale build or a wrong budget, one at the full budget means the agent
      // really did run that long.
      job.errorCode = `${result.code}:${waited}s`;
      job.error =
        result.code === "timeout"
          ? `Research ran ${Math.floor(waited / 60)}m ${waited % 60}s without finishing. Try again.`
          : result.code === "not_configured"
            ? "The research service isn't connected yet."
            : result.code === "auth_failed"
              ? "The research service rejected our credentials."
              : result.code === "malformed_response"
                ? "The research service replied in an unexpected format."
                : result.code === "oversized_response"
                  ? "The research service returned too much data."
                  : "Couldn't finish that analysis. Try again shortly.";
      return;
    }

    const report = result.report;
    report.missingSections = computeMissingSections(report);
    const snapshotAt = report.snapshotAt || new Date().toISOString();

    job.stage = "building_report";
    job.report = report;
    job.snapshotAt = snapshotAt;
    job.status = "done";
    cache.set(job.address, { report, snapshotAt, at: Date.now() });
  } catch (err) {
    log.error("analysis_crashed", { error: log.redactError(err) });
    job.status = "error";
    job.errorCode = "internal_error";
    job.error = "Something went wrong on our side.";
  } finally {
    clearTimeout(timeout);
    for (const t of timers) clearTimeout(t);
    job.finishedAt = Date.now();
  }
}

/** Shape sent to the browser. Deliberately excludes internal fields. */
export function publicJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    address: job.address,
    cached: job.cached,
    snapshotAt: job.snapshotAt,
    report: job.report,
    error: job.error,
    errorCode: job.errorCode,
  };
}
