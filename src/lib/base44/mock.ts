/**
 * Deterministic mock Superagent.
 *
 * Runs whenever Base44 credentials are absent, so the app is fully usable
 * without them. Output is a pure function of the mint, and it travels the same
 * normalization and validation path as a live response.
 */
import { normalizeBase44Payload } from "@/lib/base44/normalize";
import type { Base44Adapter, Base44Request, Base44Result } from "@/lib/base44/types";

function seeded(mint: string) {
  let h = 2166136261;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}

function payload(mint: string) {
  const rnd = seeded(mint);
  const symbol = mint.slice(0, 4).toUpperCase();
  const move = Math.round((rnd() * 380 - 30) * 10) / 10;
  const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
  const dir = move >= 0 ? "up" : "down";
  const usd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}k` : `$${Math.round(n)}`;

  return {
    answer:
      `${symbol} is up ${pct(move)} in 24h on a single thin pool. The move traces to a burst of ` +
      `social attention roughly three hours before the largest volume candle — not to any verified ` +
      `product, listing or partnership news.`,
    token: {
      name: `Mock Token ${symbol}`,
      symbol,
      mint,
      pool: "Raydium CLMM · SOL pair",
    },
    metrics: [
      { label: "24h", value: pct(move), direction: dir },
      { label: "1h", value: pct(move / 7), direction: dir },
      { label: "Volume", value: usd(120_000 + rnd() * 3_900_000), direction: "up" },
      { label: "Liquidity", value: usd(40_000 + rnd() * 860_000), direction: "flat" },
      { label: "Market cap", value: usd(300_000 + rnd() * 19_000_000), direction: "up" },
      { label: "Holders", value: `${Math.round(800 + rnd() * 9000)}`, direction: "up" },
    ],
    marketSummary:
      `Volume concentrated into a 90-minute window rather than building steadily. Trade count rose ` +
      `faster than unique buyers, which usually means the same wallets cycling rather than broad new demand.`,
    catalysts: [
      {
        title: "A mid-size account posted the ticker",
        summary:
          "An account with roughly 180k followers posted about the token three hours before the largest " +
          "volume candle. Mentions rose about 12x against the prior 24h baseline.",
        confidence: 0.78,
        label: "INFERENCE",
        sourceIds: ["s1", "s2"],
      },
      {
        title: "Liquidity was added shortly before the move",
        summary:
          "An on-chain transaction added liquidity to the primary pool about four hours ago, reducing " +
          "slippage for larger buys that followed.",
        confidence: 0.64,
        label: "FACT",
        sourceIds: ["s3"],
      },
      {
        title: "Several wallets bought from a shared funding source",
        summary:
          "A cluster of wallets funded from the same address bought within a short window. Intent cannot " +
          "be established from on-chain data alone.",
        confidence: 0.33,
        label: "UNKNOWN",
        sourceIds: ["s4"],
      },
    ],
    narrative:
      "The story attached to this token is momentum itself — there is no product claim, roadmap or " +
      "partnership behind it. Mentions cluster among a small set of accounts that post together rather " +
      "than spreading organically.\n\n" +
      "The deployer wallet still holds a position and has not sold in the observed window, though it has " +
      "launched other tokens before. Top holders outside the pool control roughly a third of supply.",
    risks: [
      {
        title: "Holder concentration",
        severity: "high",
        detail:
          "Top ten non-pool wallets hold about 31% of supply. Any one of them can exit into thin liquidity " +
          "and move the price sharply.",
        label: "FACT",
        sourceIds: ["s4"],
      },
      {
        title: "Liquidity is thin against market cap",
        severity: "high",
        detail: "The pool is small relative to the implied valuation, so slippage on the way out is significant.",
        label: "FACT",
        sourceIds: ["s3"],
      },
      {
        title: "No fundamental catalyst",
        severity: "medium",
        detail: "No verifiable product, listing or partnership news was found for this window.",
        label: "INFERENCE",
        sourceIds: ["s1", "s2"],
      },
      {
        title: "Mint and freeze authority unconfirmed",
        severity: "unknown",
        detail: "Authority status could not be confirmed from the sources available in this run.",
        label: "UNKNOWN",
        sourceIds: [],
      },
    ],
    bottomLine:
      `This move is attention-driven, not news-driven. The evidence points to a social post preceding the ` +
      `largest candle, on one small pool with concentrated holders. Nothing here establishes a reason for ` +
      `the price to hold once attention moves on.`,
    sources: [
      { id: "s1", title: "Social post referencing the ticker", url: "https://x.com/example/status/1", publisher: "X" },
      { id: "s2", title: "Mention volume time series", url: "https://example.com/mentions", publisher: "Social index" },
      { id: "s3", title: "Pair and trade history", url: `https://dexscreener.com/solana/${mint}`, publisher: "DEX Screener" },
      { id: "s4", title: "Holder distribution and transfers", url: `https://solscan.io/token/${mint}`, publisher: "Solscan" },
      { id: "s5", title: "Mint account state", url: `https://solscan.io/account/${mint}`, publisher: "Solscan" },
    ],
    snapshotAt: new Date().toISOString(),
    missingSections: [],
  };
}

export class MockBase44Adapter implements Base44Adapter {
  readonly mode = "mock" as const;

  constructor(private readonly delayMs = Number.parseInt(process.env.MOCK_DELAY_MS ?? "2600", 10)) {}

  async analyze(req: Base44Request): Promise<Base44Result> {
    const requestSentAt = Date.now();
    // Narrate like the live agent so the progress UI is exercised identically.
    const steps = [
      "Validating the mint and selecting the primary pool.",
      "Pulling the point-in-time market snapshot.",
      "Researching narrative and social mentions around the move.",
      "Checking creator history and wallet clustering.",
      "Cross-checking each claim against its source.",
    ];
    for (const text of steps) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs / steps.length));
      req.onProgress?.({ at: Date.now(), text });
    }

    const normalized = normalizeBase44Payload(payload(req.mint), {
      mint: req.mint,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const timings = {
      requestSentAt,
      firstProgressAt: requestSentAt,
      completedAt: Date.now(),
      conversationId: "mock_conversation",
      messageId: `mock_${req.jobId}`,
      polls: 0,
    };
    if (!normalized.ok) {
      return { ok: false, code: normalized.code, detail: normalized.detail, retryable: false, timings };
    }
    return { ok: true, report: normalized.report, partial: false, timings };
  }
}
