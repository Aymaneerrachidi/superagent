import { describe, expect, it, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { parseRadarFeed, radarFeedSchema } from "@/lib/radar/schema";
import { radarFixture } from "@/lib/radar/fixture";
import { RunnerCard } from "@/components/RadarDashboard";
import { checkRadarLimit, resetRadarLimitsForTests } from "@/lib/radar/limit";
import { RADAR_SESSION_COOKIE, radarConversationFrom, radarSessionValue } from "@/lib/radar/session";
import { GET as radarFeed, resetRadarFeedCacheForTests } from "@/app/api/radar/feed/route";

describe("Early Runner Radar", () => {
  beforeEach(() => {
    delete process.env.ACCESS_CODE;
    delete process.env.BASE44_AGENT_API_BASE;
    delete process.env.BASE44_AGENT_API_KEY;
    resetRadarLimitsForTests();
    resetRadarFeedCacheForTests();
  });

  it("rejects malformed agent output instead of guessing", () => {
    expect(() => parseRadarFeed("```json\n{}\n```")).toThrow();
    expect(() => parseRadarFeed(JSON.stringify({ verified_runners: [] }))).toThrow();
  });

  it("keeps identical EVM addresses isolated by chain", () => {
    const feed = radarFixture();
    const runner = feed.verified_runners[0]!;
    const sameAddress = { ...runner, chain_id: "bnb" as const };
    expect(radarFeedSchema.safeParse({ ...feed, verified_runners: [runner, sameAddress] }).success).toBe(true);
    expect(radarFeedSchema.safeParse({ ...feed, verified_runners: [runner, { ...runner }] }).success).toBe(false);
  });

  it("rejects stale or missing safety data from the verified bucket", () => {
    const feed = radarFixture();
    const runner = feed.verified_runners[0]!;
    expect(radarFeedSchema.safeParse({ ...feed, verified_runners: [{ ...runner, data_freshness: "stale" }] }).success).toBe(false);
    expect(radarFeedSchema.safeParse({ ...feed, verified_runners: [{ ...runner, safety_status: "unknown" }] }).success).toBe(false);
    expect(radarFeedSchema.safeParse({ ...feed, verified_runners: [{ ...runner, score: null }] }).success).toBe(false);
  });

  it("keeps unavailable scores explicit for quarantined candidates", () => {
    const feed = radarFixture();
    const candidate = { ...feed.quarantined_candidates[0]!, score: null, confidence: null };
    expect(radarFeedSchema.safeParse({ ...feed, quarantined_candidates: [candidate] }).success).toBe(true);
    const html = renderToStaticMarkup(createElement(RunnerCard, { runner: candidate, quarantined: true }));
    expect(html).toContain("—");
  });

  it("keeps Robinhood candidates visible with the exact quarantine reason and evidence", () => {
    const runner = radarFixture().quarantined_candidates[0]!;
    const html = renderToStaticMarkup(createElement(RunnerCard, { runner, quarantined: true }));
    expect(html).toContain("Sellability verification unavailable");
    expect(html).toContain("Evidence 1");
    expect(html).toContain("robinhoodchain.blockscout.com");
    expect(html).not.toContain("guaranteed");
  });

  it("accepts an empty feed", () => {
    const now = new Date().toISOString();
    expect(radarFeedSchema.parse({ generated_at: now, verified_runners: [], quarantined_candidates: [] })).toBeTruthy();
  });

  it("signs and reuses a conversation without exposing it to client JavaScript", () => {
    const id = "6a9c66e6180e3a2446e99db4";
    const value = radarSessionValue(id);
    const req = new Request("https://app.test/api/radar/feed", { headers: { cookie: `${RADAR_SESSION_COOKIE}=${encodeURIComponent(value)}` } });
    expect(radarConversationFrom(req)).toBe(id);
    const tampered = new Request("https://app.test", { headers: { cookie: `${RADAR_SESSION_COOKIE}=${encodeURIComponent(value + "x")}` } });
    expect(radarConversationFrom(tampered)).toBeNull();
  });

  it("rate limits expensive refreshes", () => {
    expect(checkRadarLimit("test", 2, 60_000).ok).toBe(true);
    expect(checkRadarLimit("test", 2, 60_000).ok).toBe(true);
    expect(checkRadarLimit("test", 2, 60_000).ok).toBe(false);
  });

  it("never returns the API key in a feed response", async () => {
    process.env.BASE44_AGENT_API_KEY = "radar_secret_value_for_test";
    delete process.env.BASE44_AGENT_API_BASE;
    const response = await radarFeed(new Request("https://app.test/api/radar/feed"));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("radar_secret_value_for_test");
  });

  it("ships no wallet or trading actions in the Radar client", () => {
    const source = readFileSync("src/components/RadarDashboard.tsx", "utf8").toLowerCase();
    for (const action of ["connect wallet", "swap token", "sign transaction", "purchase token", "buy token"]) {
      expect(source).not.toContain(action);
    }
    expect(source).not.toContain("base44_agent_api_key");
  });
});
