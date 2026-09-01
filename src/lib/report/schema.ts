/**
 * The report contract.
 *
 * Base44 output is untrusted external data. It is parsed with this schema:
 * unknown keys are dropped, strings are length-bounded and stripped of control
 * characters and markup, and every URL must be http(s).
 */
import { z } from "zod";
import { stripUnsafeChars, neutralizeMarkup, safeHref } from "@/lib/security/text";

export const EVIDENCE_LABELS = ["FACT", "INFERENCE", "UNKNOWN"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

const label = z.enum(EVIDENCE_LABELS).catch("UNKNOWN");

const text = (max: number) =>
  z
    .string()
    .transform((s) => neutralizeMarkup(stripUnsafeChars(s)).trim())
    .pipe(z.string().max(max));

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((u) => safeHref(u) !== null, "Only http and https links are allowed");

export const sourceSchema = z.object({
  id: text(64).optional(),
  title: text(300),
  url: httpUrl,
  publisher: text(160).optional(),
});

export const catalystSchema = z.object({
  title: text(200),
  summary: text(1500),
  confidence: z.number().min(0).max(1).catch(0),
  label,
  sourceIds: z.array(text(64)).max(20).default([]),
});

export const metricSchema = z.object({
  label: text(60),
  value: text(60),
  direction: z.enum(["up", "down", "flat", "unknown"]).catch("unknown"),
});

export const riskSchema = z.object({
  title: text(200),
  severity: z.enum(["low", "medium", "high", "critical", "unknown"]).catch("unknown"),
  detail: text(1200),
  label,
  sourceIds: z.array(text(64)).max(20).default([]),
});

export const reportSchema = z.object({
  /** The one-line verdict. */
  answer: text(600).default(""),
  token: z
    .object({
      name: text(120).nullable().optional(),
      symbol: text(40).nullable().optional(),
      mint: text(64),
      pool: text(120).nullable().optional(),
    })
    .nullable()
    .optional(),
  metrics: z.array(metricSchema).max(8).default([]),
  marketSummary: text(1200).default(""),
  catalysts: z.array(catalystSchema).max(8).default([]),
  /** Merged narrative, socials, creator and wallet findings. */
  narrative: text(2500).default(""),
  risks: z.array(riskSchema).max(10).default([]),
  bottomLine: text(1200).default(""),
  sources: z.array(sourceSchema).max(60).default([]),
  snapshotAt: text(64).optional(),
  /** Sections the Superagent could not complete. */
  missingSections: z.array(text(60)).max(12).default([]),
});

export type Report = z.infer<typeof reportSchema>;
export type Catalyst = z.infer<typeof catalystSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Metric = z.infer<typeof metricSchema>;

/** Names the sections that came back empty, so the UI can say so plainly. */
export function computeMissingSections(report: Report): string[] {
  const missing = new Set(report.missingSections);
  if (!report.answer) missing.add("verdict");
  if (report.metrics.length === 0 && !report.marketSummary) missing.add("market");
  if (report.catalysts.length === 0) missing.add("catalysts");
  if (!report.narrative) missing.add("narrative");
  if (report.risks.length === 0) missing.add("risks");
  if (report.sources.length === 0) missing.add("sources");
  return [...missing];
}

/** The evidence mix across the whole report, used by the ledger bar. */
export function evidenceMix(report: Report): Record<EvidenceLabel, number> {
  const mix: Record<EvidenceLabel, number> = { FACT: 0, INFERENCE: 0, UNKNOWN: 0 };
  for (const c of report.catalysts) mix[c.label] += 1;
  for (const r of report.risks) mix[r.label] += 1;
  return mix;
}
