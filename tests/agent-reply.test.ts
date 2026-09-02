/**
 * Regression test against the Superagent's real output schema.
 *
 * The fixture is a genuine reply (trimmed, structurally intact). It guards the
 * mapping, which is the thing that has actually broken: the agent speaks its own
 * vocabulary — `drivers`, `movement`, a structured `narrative` — and a report
 * that parses but comes back empty is worse than one that fails loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeBase44Payload } from "@/lib/base44/normalize";
import { reportSchema } from "@/lib/report/schema";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/agent-reply.json"), "utf8");

function parse(input: string | object = fixture) {
  return normalizeBase44Payload(input, { mint: MINT, maxBytes: 256_000 });
}

describe("real Superagent reply", () => {
  it("fills every section of the report", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.report;
    // Each of these was silently empty before the mapping was written.
    expect(r.answer.length).toBeGreaterThan(50);
    expect(r.metrics.length).toBeGreaterThan(0);
    expect(r.catalysts.length).toBeGreaterThan(0);
    expect(r.narrative.length).toBeGreaterThan(200);
    expect(r.risks.length).toBeGreaterThan(0);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.bottomLine.length).toBeGreaterThan(0);
    expect(r.missingSections).toEqual([]);
  });

  it("maps `drivers` onto catalysts, with evidence as the summary", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const c of result.report.catalysts) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(["FACT", "INFERENCE", "UNKNOWN"]).toContain(c.label);
    }
  });

  it("builds the market strip from `movement`", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const labels = result.report.metrics.map((m) => m.label);
    expect(labels).toContain("24h");
    expect(labels).toContain("Liquidity");
    // Percentages keep their sign, money is abbreviated.
    const day = result.report.metrics.find((m) => m.label === "24h");
    expect(day?.value).toMatch(/^[+-]?\d/);
    expect(day?.direction).toBe("up");
  });

  it("keeps the mint authoritative from our own validation", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.token?.mint).toBe(MINT);
  });

  it("treats a run still in progress as not a report", () => {
    const result = parse({ status: "running", summary: "working on it" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("running");
  });

  it("carries the agent's own partial flag", () => {
    const done = parse();
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.partial).toBe(false);

    const incomplete = parse({ ...JSON.parse(fixture), partial: true });
    expect(incomplete.ok).toBe(true);
    if (incomplete.ok) expect(incomplete.partial).toBe(true);
  });

  it("truncates an over-long field instead of discarding the report", () => {
    const parsed = reportSchema.safeParse({ answer: "x".repeat(5000) });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.answer.length).toBeLessThanOrEqual(1200);
      expect(parsed.data.answer.endsWith("…")).toBe(true);
    }
  });

  it("still rejects a reply that is not a report at all", () => {
    const result = parse("I could not find that token, sorry.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });

  it("names the offending field when validation fails", () => {
    const result = parse({ summary: "ok", sources: [{ title: "bad", url: "javascript:alert(1)" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("sources");
  });
});
