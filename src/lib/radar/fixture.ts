import type { RadarFeed } from "@/lib/radar/schema";

export function radarFixture(now = new Date()): RadarFeed {
  const observed = now.toISOString();
  return {
    generated_at: observed,
    verified_runners: [
      {
        chain_id: "base", contract_address: "0x4200000000000000000000000000000000000006",
        name: "Example Base Runner", symbol: "BASEX", state: "accelerating", score: 87, confidence: 0.84,
        liquidity_usd: 248000, market_cap_usd: 2900000, volume_5m: 91000, volume_15m: 214000,
        price_change_5m_pct: 18.4, price_change_15m_pct: 43.1, safety_status: "verified",
        reason_codes: [], observed_at: observed, data_freshness: "fresh",
        evidence_links: ["https://dexscreener.com/"],
      },
    ],
    quarantined_candidates: [
      {
        chain_id: "robinhood", contract_address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
        name: "Example Robinhood Candidate", symbol: "RHEX", state: "watch", score: 71, confidence: 0.58,
        liquidity_usd: 94000, market_cap_usd: 1500000, volume_5m: 42000, volume_15m: 103000,
        price_change_5m_pct: 9.2, price_change_15m_pct: 28.6, safety_status: "unknown",
        reason_codes: ["Sellability verification unavailable"], observed_at: observed, data_freshness: "fresh",
        evidence_links: ["https://robinhoodchain.blockscout.com/"],
      },
    ],
  };
}
