import { z } from "zod";
import { safeHref, stripUnsafeChars } from "@/lib/security/text";

export const radarChains = ["solana", "base", "bnb", "robinhood"] as const;
export type RadarChain = (typeof radarChains)[number];

const chainSchema = z
  .enum(["solana", "base", "bnb", "bsc", "bnb-smart-chain", "robinhood", "robinhood-chain"])
  .transform((chain): RadarChain => {
    if (chain === "bsc" || chain === "bnb-smart-chain") return "bnb";
    if (chain === "robinhood-chain") return "robinhood";
    return chain;
  });

const boundedText = (max: number) => z.string().min(1).max(max).transform((s) => stripUnsafeChars(s).trim());
const amount = z.number().finite().nonnegative().nullable();
const change = z.number().finite().nullable();
const evidenceLink = z.string().max(2048).refine((url) => safeHref(url) !== null, "Unsafe evidence URL");

export const runnerSchema = z.object({
  chain_id: chainSchema,
  contract_address: boundedText(64),
  name: boundedText(120),
  symbol: boundedText(40),
  state: boundedText(80),
  score: z.number().finite().min(0).max(100),
  confidence: z.number().finite().min(0).max(1),
  liquidity_usd: amount,
  market_cap_usd: amount,
  volume_5m: amount,
  volume_15m: amount,
  price_change_5m_pct: change,
  price_change_15m_pct: change,
  safety_status: z.enum(["verified", "quarantined", "unverified", "unknown"]),
  reason_codes: z.array(boundedText(120)).max(20),
  observed_at: z.string().datetime({ offset: true }),
  data_freshness: z.enum(["live", "fresh", "stale", "unknown"]),
  evidence_links: z.array(evidenceLink).max(20),
}).strict().superRefine((runner, ctx) => {
  const address = runner.contract_address;
  const valid = runner.chain_id === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : /^0x[0-9a-fA-F]{40}$/.test(address);
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract_address"], message: "Address does not match chain" });
});

export const radarFeedSchema = z.object({
  generated_at: z.string().datetime({ offset: true }),
  verified_runners: z.array(runnerSchema).max(100),
  quarantined_candidates: z.array(runnerSchema).max(100),
}).strict().superRefine((feed, ctx) => {
  const seen = new Set<string>();
  for (const [bucket, runners] of [
    ["verified_runners", feed.verified_runners],
    ["quarantined_candidates", feed.quarantined_candidates],
  ] as const) {
    runners.forEach((runner, index) => {
      const key = `${runner.chain_id}:${runner.contract_address.toLowerCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bucket, index], message: "Duplicate chain and contract" });
      seen.add(key);
      if (bucket === "verified_runners") {
        if (runner.safety_status !== "verified") ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bucket, index, "safety_status"], message: "Verified runners require verified safety" });
        if (runner.data_freshness === "stale" || runner.data_freshness === "unknown") ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bucket, index, "data_freshness"], message: "Stale data cannot be verified" });
        if (runner.evidence_links.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bucket, index, "evidence_links"], message: "Verified runners require evidence" });
      } else if (runner.reason_codes.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bucket, index, "reason_codes"], message: "Quarantined candidates require a reason" });
      }
    });
  }
});

export type Runner = z.infer<typeof runnerSchema>;
export type RadarFeed = z.infer<typeof radarFeedSchema>;

export function parseRadarFeed(raw: unknown): RadarFeed {
  let value = raw;
  if (typeof raw === "string") value = JSON.parse(raw.trim());
  return radarFeedSchema.parse(value);
}
