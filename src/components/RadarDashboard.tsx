"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RadarChain, RadarFeed, Runner } from "@/lib/radar/schema";
import { safeHref } from "@/lib/security/text";
import { SafeText } from "@/components/SafeText";

const CHAINS: { id: "all" | RadarChain; label: string }[] = [
  { id: "all", label: "All chains" }, { id: "solana", label: "Solana" },
  { id: "base", label: "Base" }, { id: "bnb", label: "BNB" }, { id: "robinhood", label: "Robinhood" },
];

const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
const pct = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
const chainName = (chain: RadarChain) => CHAINS.find((item) => item.id === chain)?.label ?? chain;
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function RunnerCard({ runner, quarantined }: { runner: Runner; quarantined: boolean }) {
  const [copied, setCopied] = useState(false);
  const stale = runner.data_freshness === "stale" || runner.data_freshness === "unknown" || Date.now() - new Date(runner.observed_at).getTime() > 10 * 60_000;
  return (
    <article className="rounded-xl border border-line bg-ink-3/55 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-paper"><SafeText>{runner.symbol}</SafeText></h3>
            <span className="rounded bg-line px-1.5 py-0.5 font-mono text-[0.6rem] uppercase text-paper-2">{chainName(runner.chain_id)}</span>
            <span className={`rounded px-1.5 py-0.5 font-mono text-[0.6rem] uppercase ${stale ? "bg-alert/10 text-alert" : "bg-rise/10 text-rise"}`}>{stale ? "Stale" : runner.data_freshness}</span>
          </div>
          <p className="mt-1 text-sm text-paper-2"><SafeText>{runner.name}</SafeText></p>
        </div>
        <div className="text-right">
          <div className="tnum text-xl text-paper">{runner.score === null ? "—" : Math.round(runner.score)}</div>
          <div className="eyebrow">score</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-y border-line py-4 sm:grid-cols-4 lg:grid-cols-7">
        {[
          ["State", runner.state], ["Confidence", runner.confidence === null ? "—" : `${Math.round(runner.confidence * 100)}%`],
          ["Liquidity", money(runner.liquidity_usd)], ["Market cap", money(runner.market_cap_usd)],
          ["Volume 5m", money(runner.volume_5m)], ["5m", pct(runner.price_change_5m_pct)], ["15m", pct(runner.price_change_15m_pct)],
        ].map(([label, value]) => <div key={label}><div className="eyebrow">{label}</div><div className="tnum mt-1 text-[0.78rem] text-paper"><SafeText>{String(value)}</SafeText></div></div>)}
      </div>

      {quarantined && (
        <div className="mt-4 rounded-lg border border-alert/25 bg-alert/[0.06] px-3 py-2.5">
          <div className="eyebrow text-alert">Why it is unverified</div>
          <ul className="mt-1.5 space-y-1 text-[0.8rem] text-paper-2">
            {runner.reason_codes.map((reason) => <li key={reason}><SafeText>{reason}</SafeText></li>)}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={async () => { await navigator.clipboard.writeText(runner.contract_address); setCopied(true); setTimeout(() => setCopied(false), 1400); }} className="min-h-11 rounded-lg border border-line px-3 font-mono text-[0.68rem] text-paper-2 hover:border-line-2 hover:text-paper" aria-label={`Copy ${runner.symbol} contract address`}>
          {copied ? "Copied" : shortAddress(runner.contract_address)}
        </button>
        <div className="flex flex-wrap items-center gap-3 text-[0.7rem] text-paper-3">
          <time dateTime={runner.observed_at}>{new Date(runner.observed_at).toLocaleString()}</time>
          {runner.evidence_links.map((url, index) => {
            const href = safeHref(url);
            return href ? <a key={href} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-fact underline decoration-fact/30 underline-offset-2 hover:decoration-fact">Evidence {index + 1}</a> : null;
          })}
        </div>
      </div>
    </article>
  );
}

function Section({ title, note, runners, quarantined }: { title: string; note: string; runners: Runner[]; quarantined: boolean }) {
  return (
    <section className="rounded-2xl border border-line bg-ink-2 p-4 sm:p-6">
      <header className="mb-5 flex items-end justify-between gap-4">
        <div><h2 className="font-display text-2xl text-paper">{title}</h2><p className="mt-1 text-[0.78rem] text-paper-3">{note}</p></div>
        <span className="tnum text-sm text-paper-2">{runners.length}</span>
      </header>
      {runners.length ? <div className="space-y-3">{runners.map((runner) => <RunnerCard key={`${runner.chain_id}:${runner.contract_address}`} runner={runner} quarantined={quarantined} />)}</div> : <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center text-sm text-paper-3">No candidates in this view.</div>}
    </section>
  );
}

export function RadarDashboard() {
  const [feed, setFeed] = useState<RadarFeed | null>(null);
  const [filter, setFilter] = useState<"all" | RadarChain>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ cached: boolean; mode: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/radar/feed", { cache: "no-store" });
      const data = await response.json() as { feed?: RadarFeed; error?: string; cached?: boolean; mode?: string };
      if (!response.ok || !data.feed) throw new Error(data.error || "Unable to load the radar feed.");
      setFeed(data.feed); setMeta({ cached: Boolean(data.cached), mode: data.mode || "live" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the radar feed."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => ({
    verified: feed?.verified_runners.filter((runner) => filter === "all" || runner.chain_id === filter) ?? [],
    quarantined: feed?.quarantined_candidates.filter((runner) => filter === "all" || runner.chain_id === filter) ?? [],
  }), [feed, filter]);

  return (
    <div className="rise pb-8">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="eyebrow text-fact">Agent 02 · read only</p><h1 className="mt-2 font-display text-4xl text-paper sm:text-5xl">Early Runner Radar</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-paper-2">Acceleration signals across Solana, Base, BNB Chain, and Robinhood Chain. Verify every source before acting.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-xl bg-paper px-5 text-sm font-medium text-ink disabled:cursor-wait disabled:opacity-50">{loading ? "Refreshing" : "Refresh feed"}</button>
      </div>

      <div className="mb-5 flex flex-wrap gap-2" aria-label="Filter by chain">{CHAINS.map((chain) => <button key={chain.id} type="button" aria-pressed={filter === chain.id} onClick={() => setFilter(chain.id)} className={`min-h-11 rounded-lg border px-3 text-[0.75rem] transition-colors ${filter === chain.id ? "border-fact/50 bg-fact/10 text-fact" : "border-line text-paper-2 hover:border-line-2"}`}>{chain.label}</button>)}</div>

      {meta && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ink-2 px-4 py-3 text-[0.68rem] text-paper-3"><span className={meta.mode === "fixture" ? "text-fact" : "text-rise"}>{meta.mode === "fixture" ? "Sample data" : "Live feed"}</span><span>{meta.cached ? "Cached under 5 minutes" : "Fresh request"}</span>{feed && <time dateTime={feed.generated_at}>Generated {new Date(feed.generated_at).toLocaleString()}</time>}</div>}

      {loading && !feed && <div aria-live="polite" className="space-y-3"><div className="h-36 animate-pulse rounded-2xl border border-line bg-ink-2" /><div className="h-36 animate-pulse rounded-2xl border border-line bg-ink-2" /><p className="text-center text-sm text-paper-3">Scanning current acceleration signals…</p></div>}
      {error && <div role="alert" className="rounded-2xl border border-alert/30 bg-alert/[0.07] p-5 text-sm text-alert"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-lg border border-alert/40 px-4">Try again</button></div>}
      {feed && <div className="space-y-4"><Section title="Verified runners" note="Fresh safety checks and direct evidence." runners={visible.verified} quarantined={false} /><Section title="Quarantined / unverified" note="Visible for research, never presented as safe." runners={visible.quarantined} quarantined /></div>}
    </div>
  );
}
