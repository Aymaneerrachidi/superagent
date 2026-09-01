/**
 * Regression test against a real Superagent reply.
 *
 * The fixture is a genuine response from the live agent (trimmed, but with its
 * structure, key names and source URLs intact). It guards the two things that
 * actually broke in practice: the reply shape the agent produces, and the
 * assumption that a long field should fail the whole report.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeBase44Payload } from "@/lib/base44/normalize";
import { reportSchema } from "@/lib/report/schema";

const MINT = "EEpng77ZPn9FbgbT4xsRjwuxNCcMBYq3HTwEscyTpump";
const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/agent-reply.json"), "utf8");

describe("real Superagent reply", () => {
  it("parses a fenced JSON reply into a complete report", () => {
    const result = normalizeBase44Payload(fixture, { mint: MINT, maxBytes: 256_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.report;
    expect(report.answer.length).toBeGreaterThan(50);
    expect(report.token?.symbol).toBeTruthy();
    expect(report.metrics.length).toBeGreaterThan(0);
    expect(report.catalysts.length).toBeGreaterThan(0);
    expect(report.risks.length).toBeGreaterThan(0);
    expect(report.sources.length).toBeGreaterThan(0);
    expect(report.bottomLine.length).toBeGreaterThan(0);
    // Every section present, so nothing is reported as partial.
    expect(report.missingSections).toEqual([]);
  });

  it("keeps the mint authoritative from our own validation", () => {
    const result = normalizeBase44Payload(fixture, { mint: MINT, maxBytes: 256_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.token?.mint).toBe(MINT);
  });

  it("preserves the evidence labels the agent assigned", () => {
    const result = normalizeBase44Payload(fixture, { mint: MINT, maxBytes: 256_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const c of result.report.catalysts) {
      expect(["FACT", "INFERENCE", "UNKNOWN"]).toContain(c.label);
    }
  });

  it("rescales a 0-100 confidence to 0-1", () => {
    const result = normalizeBase44Payload(fixture, { mint: MINT, maxBytes: 256_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const c of result.report.catalysts) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("truncates an over-long field instead of discarding the report", () => {
    // The live agent writes a longer answer than the cap; that must not cost
    // the user their whole analysis.
    const parsed = reportSchema.safeParse({ answer: "x".repeat(5000) });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.answer.length).toBeLessThanOrEqual(1200);
      expect(parsed.data.answer.endsWith("…")).toBe(true);
    }
  });

  it("still rejects a structurally wrong reply", () => {
    const result = normalizeBase44Payload("I could not find that token, sorry.", {
      mint: MINT,
      maxBytes: 256_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });

  it("names the offending field when validation fails", () => {
    const result = normalizeBase44Payload(
      { answer: "ok", sources: [{ title: "bad", url: "javascript:alert(1)" }] },
      { mint: MINT, maxBytes: 256_000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("sources");
  });
});
