/**
 * Deterministic mock Superagent.
 *
 * Runs whenever Base44 credentials are absent, so the app is fully usable
 * without them. Output is a pure function of the mint and — importantly — uses
 * the *live agent's* vocabulary (`summary`, `movement`, `drivers`, a structured
 * `narrative`), so development exercises the same mapping as production. A mock
 * that speaks a friendlier dialect than the real service hides mapping bugs,
 * which is exactly what happened here once already.
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
  const change24 = Math.round((rnd() * 320 - 40) * 100) / 100;
  const now = new Date();
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  return {
    status: "completed",
    token: { name: `Mock Token ${symbol}`, symbol, mint, primary_pool: "PumpSwap · SOL pair" },
    snapshot_at: now.toISOString(),
    movement: {
      classification: "24H_PUMP_WITH_SHORT_TERM_PULLBACK",
      price_usd: 0.0031 + rnd() * 0.004,
      market_cap_usd: 300_000 + rnd() * 19_000_000,
      liquidity_usd: 40_000 + rnd() * 860_000,
      volume_24h_usd: 500_000 + rnd() * 9_000_000,
      price_change_1h_pct: Math.round((rnd() * 40 - 20) * 100) / 100,
      price_change_6h_pct: Math.round((rnd() * 80 - 20) * 100) / 100,
      price_change_24h_pct: change24,
      drawdown_from_24h_high_pct: -Math.round(rnd() * 60 * 100) / 100,
      main_inflection: {
        time_utc: iso(190),
        change_pct: Math.round(rnd() * 40 * 100) / 100,
        candle_volume_usd: 120_000 + rnd() * 300_000,
        label: "FACT",
        source_ids: ["s3"],
      },
    },
    summary:
      `FACT: ${symbol} is up ${change24.toFixed(2)}% over 24 hours on a single thin pool. ` +
      `INFERENCE: the move traces to a burst of social attention roughly three hours before the ` +
      `largest volume candle, not to any verified product, listing or partnership news.`,
    drivers: [
      {
        rank: 1,
        title: "A mid-size account posted the ticker",
        classification: "POSSIBLE INITIAL TRIGGER",
        label: "INFERENCE",
        confidence: 0.78,
        evidence:
          "An account with roughly 180k followers posted about the token three hours before the " +
          "largest volume candle. Mentions rose about 12x against the prior 24h baseline.",
        source_ids: ["s1", "s2"],
      },
      {
        rank: 2,
        title: "Liquidity was added shortly before the move",
        classification: "SUPPORTING CONDITION",
        label: "FACT",
        confidence: 0.64,
        evidence:
          "An on-chain transaction added liquidity to the primary pool about four hours ago, " +
          "reducing slippage for the larger buys that followed.",
        source_ids: ["s3"],
      },
      {
        rank: 3,
        title: "Several wallets bought from a shared funding source",
        classification: "UNRESOLVED",
        label: "UNKNOWN",
        confidence: 0.33,
        evidence:
          "A cluster of wallets funded from the same address bought within a short window. " +
          "Intent cannot be established from on-chain data alone.",
        source_ids: ["s4"],
      },
    ],
    narrative: {
      categories: ["ATTENTION / MOMENTUM"],
      origin: "FACT: the token launched on pump.fun with no product claim attached to it.",
      lore:
        "INFERENCE: the story is momentum itself. Mentions cluster among a small set of accounts " +
        "that post together rather than spreading organically.",
      token_connection: "FACT: metadata and the launch post both reference the supplied mint.",
    },
    social: [
      {
        account: "@example_trader",
        published_at: iso(190),
        event: "Posted the ticker to ~180k followers",
        label: "FACT",
        url: "https://x.com/example_trader/status/1",
      },
      {
        account: "t.me/examplecall",
        published_at: iso(170),
        event: "Relayed the call to a paid group",
        label: "INFERENCE",
        url: "https://t.me/examplecall",
      },
    ],
    wallet_activity: [
      {
        finding:
          "The ten largest non-market holders control roughly 31% of supply, excluding recognised " +
          "liquidity-pool accounts.",
        retrieved_at: iso(4),
        label: "FACT",
        source_ids: ["s4"],
      },
    ],
    creator_activity: {
      status: "PARTIAL",
      pump_fun_creator: `${mint.slice(0, 6)}CreatorMock${mint.slice(-4)}`,
      note: "The deployer still holds a position and has not sold in the observed window.",
      label: "INFERENCE",
    },
    risks: [
      {
        title: "Holder concentration",
        severity: "high",
        label: "FACT",
        detail: "A small number of wallets can exit into thin liquidity and move the price sharply.",
        source_ids: ["s4"],
      },
      {
        title: "Liquidity is thin against market cap",
        severity: "high",
        label: "FACT",
        detail: "The pool is small relative to the implied valuation, so slippage on exit is significant.",
        source_ids: ["s3"],
      },
      {
        title: "No fundamental catalyst",
        severity: "medium",
        label: "INFERENCE",
        detail: "No verifiable product, listing or partnership news was found for this window.",
        source_ids: ["s1", "s2"],
      },
      {
        title: "Mint and freeze authority unconfirmed",
        severity: "unknown",
        label: "UNKNOWN",
        detail: "Authority status could not be confirmed from the sources available in this run.",
        source_ids: [],
      },
    ],
    bottom_line:
      `INFERENCE: the move in ${symbol} is attention-driven, not news-driven. The strongest evidence ` +
      `points to a social post preceding the largest volume candle, on one small pool with concentrated ` +
      `holders. Nothing here establishes a reason for the price to hold once attention moves on.`,
    sources: [
      { id: "s1", title: "Social post referencing the ticker", url: "https://x.com/example_trader/status/1", publisher: "X" },
      { id: "s2", title: "Mention volume time series", url: "https://example.com/mentions", publisher: "Social index" },
      { id: "s3", title: "Pair and trade history", url: `https://dexscreener.com/solana/${mint}`, publisher: "DEX Screener" },
      { id: "s4", title: "Holder distribution and transfers", url: `https://solscan.io/token/${mint}`, publisher: "Solscan" },
      { id: "s5", title: "Mint account state", url: `https://solscan.io/account/${mint}`, publisher: "Solscan" },
    ],
    limitations: ["Intent behind clustered buying could not be established."],
    partial: false,
  };
}

export class MockBase44Adapter implements Base44Adapter {
  readonly mode = "mock" as const;

  constructor(private readonly delayMs = Number.parseInt(process.env.MOCK_DELAY_MS ?? "2600", 10)) {}

  async analyze(req: Base44Request): Promise<Base44Result> {
    const requestSentAt = Date.now();
    // The live agent posts one line and then works quietly, so the mock does
    // the same rather than implying richer streaming than actually happens.
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(1200, this.delayMs / 2)));
    req.onProgress?.({ at: Date.now(), text: "Research started. Expected completion: 3-8 minutes." });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));

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
    return { ok: true, report: normalized.report, partial: normalized.partial, timings };
  }
}
