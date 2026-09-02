/**
 * The report.
 *
 * Every string here comes from the validated schema and renders as a React text
 * node or through the safe markdown AST — never as an HTML string. Source URLs
 * are re-checked against the http(s) allow-list at render time.
 */
import type { Report, Source, EvidenceLabel } from "@/lib/report/schema";
import { evidenceMix } from "@/lib/report/schema";
import { cleanVisibleText, safeHref } from "@/lib/security/text";
import { SafeMarkdown, SafeText } from "@/components/SafeText";

const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(" ");

/* Evidence colours. The one idea the whole design is built around. */
const TONE: Record<EvidenceLabel, { text: string; bg: string; rail: string; dot: string }> = {
  FACT: { text: "text-fact", bg: "bg-fact/10", rail: "bg-fact", dot: "bg-fact" },
  INFERENCE: { text: "text-inference", bg: "bg-inference/10", rail: "bg-inference", dot: "bg-inference" },
  UNKNOWN: { text: "text-unknown", bg: "bg-unknown/10", rail: "bg-unknown", dot: "bg-unknown" },
};

const TONE_TITLE: Record<EvidenceLabel, string> = {
  FACT: "Verified against a cited source",
  INFERENCE: "Reasoned from evidence, not directly stated",
  UNKNOWN: "Could not be established",
};

function Tag({ label }: { label: EvidenceLabel }) {
  return (
    <span
      title={TONE_TITLE[label]}
      className={cx(
        "shrink-0 rounded px-1.5 py-px font-mono text-[0.5625rem] font-medium tracking-[0.1em]",
        TONE[label].bg,
        TONE[label].text,
      )}
    >
      {label}
    </span>
  );
}

function Card({
  title,
  children,
  aside,
  className,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-2xl border border-line bg-ink-2 p-5 sm:p-6", className)}>
      <header className="mb-4 flex items-center justify-between gap-4">
        <h2 className="eyebrow">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Numbered, clickable references back into the ledger. */
function Refs({ ids, sources }: { ids: string[]; sources: Source[] }) {
  const refs = ids
    .map((id) => sources.findIndex((s) => s.id === id))
    .filter((i) => i >= 0)
    .map((i) => ({ n: i + 1, source: sources[i] as Source }));
  if (refs.length === 0) return null;

  return (
    <span className="ml-1 inline-flex gap-1 align-middle">
      {refs.map(({ n, source }) => (
        <a
          key={n}
          href={`#src-${n}`}
          title={cleanVisibleText(source.title)}
          className="tnum rounded bg-ink-3 px-1 text-[0.5625rem] text-paper-3 transition-colors hover:bg-fact/15 hover:text-fact"
        >
          {n}
        </a>
      ))}
    </span>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export function ReportView({
  report,
  snapshotAt,
  cached,
  actions,
}: {
  report: Report;
  snapshotAt: string | null;
  cached: boolean;
  actions?: React.ReactNode;
}) {
  const sources = report.sources;
  const mix = evidenceMix(report);
  const total = mix.FACT + mix.INFERENCE + mix.UNKNOWN;

  return (
    <div className="space-y-4">
      {/* ---- Verdict. The serif appears here and nowhere else. ---- */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-ink-2 p-6 sm:p-8">
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          {report.token?.symbol && (
            <span className="font-mono text-sm font-medium text-paper">$<SafeText>{report.token.symbol}</SafeText></span>
          )}
          {report.token?.name && <span className="text-sm text-paper-2"><SafeText>{report.token.name}</SafeText></span>}
          {report.token?.pool && (
            <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-paper-3">
              <SafeText>{report.token.pool}</SafeText>
            </span>
          )}
        </div>

        <SafeMarkdown className="font-display text-[1.5rem] leading-[1.3] tracking-[-0.01em] text-paper sm:text-[1.75rem]">
          {report.answer || "No verdict was produced for this run."}
        </SafeMarkdown>

        {/* The evidence ledger: how much of this report is fact vs. guess. */}
        {total > 0 && (
          <div className="mt-7 border-t border-line pt-5">
            <div className="mb-2.5 flex h-1 gap-0.5 overflow-hidden rounded-full">
              {(["FACT", "INFERENCE", "UNKNOWN"] as const).map((k) =>
                mix[k] > 0 ? (
                  <div key={k} className={TONE[k].rail} style={{ flexGrow: mix[k] }} />
                ) : null,
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(["FACT", "INFERENCE", "UNKNOWN"] as const).map((k) => (
                <span key={k} className="flex items-center gap-1.5 text-[0.6875rem] text-paper-3">
                  <span className={cx("size-1.5 rounded-full", TONE[k].dot)} aria-hidden="true" />
                  <span className="tnum">{mix[k]}</span>
                  <span className="lowercase">{k.toLowerCase()}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---- Snapshot bar ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-ink-2/60 px-5 py-3">
        <span className="flex items-center gap-2 text-[0.6875rem] text-paper-3">
          <span
            className={cx("size-1.5 rounded-full", cached ? "bg-unknown" : "bg-rise")}
            aria-hidden="true"
          />
          {cached ? "Cached snapshot" : "Fresh"}
          <span className="tnum">{timeAgo(snapshotAt)}</span>
        </span>
        {actions}
      </div>

      {report.missingSections.length > 0 && (
        <p className="rounded-2xl border border-unknown/25 bg-unknown/[0.06] px-5 py-3 text-[0.8125rem] text-paper-2">
          <span className="text-paper">Partial report.</span> Missing: <SafeText>{report.missingSections.join(", ")}</SafeText>.
        </p>
      )}

      {/* ---- Market ---- */}
      {(report.metrics.length > 0 || report.marketSummary) && (
        <Card title="Market">
          {report.metrics.length > 0 && (
            <div className="mb-5 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-6">
              {report.metrics.map((m, i) => (
                <div key={i} className="bg-ink-3 px-3 py-3">
                  <div className="truncate font-mono text-[0.5625rem] tracking-[0.1em] text-paper-3 uppercase">
                    <SafeText>{m.label}</SafeText>
                  </div>
                  <div
                    className={cx(
                      "tnum mt-1.5 text-[0.9375rem] font-medium",
                      m.direction === "up" && "text-rise",
                      m.direction === "down" && "text-alert",
                      (m.direction === "flat" || m.direction === "unknown") && "text-paper",
                    )}
                  >
                    <SafeText>{m.value}</SafeText>
                  </div>
                </div>
              ))}
            </div>
          )}
          <SafeMarkdown className="prose">{report.marketSummary}</SafeMarkdown>
        </Card>
      )}

      {/* ---- Catalysts. The rail encodes the evidence label. ---- */}
      {report.catalysts.length > 0 && (
        <Card title="Why it moved" aside={<span className="tnum text-[0.6875rem] text-paper-3">{report.catalysts.length}</span>}>
          <ol className="space-y-4">
            {report.catalysts.map((c, i) => (
              <li
                key={i}
                className="relative overflow-hidden rounded-xl border border-line bg-ink-3/60 py-4 pr-4 pl-5 transition-colors hover:border-line-2"
              >
                <span
                  className={cx("absolute inset-y-0 left-0 w-[3px]", TONE[c.label].rail)}
                  aria-hidden="true"
                />
                <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
                  <span className="tnum text-[0.6875rem] text-paper-3">{i + 1}.</span>
                  <h3 className="text-[0.9375rem] leading-snug font-medium text-paper"><SafeText>{c.title}</SafeText></h3>
                  <Tag label={c.label} />
                  <span
                    className="tnum ml-auto text-[0.6875rem] text-paper-3"
                    title="How confident the research is in this explanation"
                  >
                    {Math.round(c.confidence * 100)}%
                  </span>
                </div>
                <SafeMarkdown className="prose prose-points text-[0.875rem]">{c.summary}</SafeMarkdown>
                <Refs ids={c.sourceIds} sources={sources} />
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* ---- Narrative, socials, creator and wallets ---- */}
      {report.narrative && (
        <Card title="Narrative and wallets">
          <SafeMarkdown className="prose">{report.narrative}</SafeMarkdown>
        </Card>
      )}

      {/* ---- Risks ---- */}
      {report.risks.length > 0 && (
        <Card title="Risks" aside={<span className="tnum text-[0.6875rem] text-paper-3">{report.risks.length}</span>}>
          <ul className="space-y-4">
            {report.risks.map((r, i) => (
              <li key={i} className="rounded-xl border border-line bg-ink-3/60 p-4">
                <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
                  {/* An "unknown" severity would just repeat the UNKNOWN evidence tag. */}
                  {r.severity !== "unknown" && (
                    <span
                      className={cx(
                        "shrink-0 rounded px-1.5 py-px font-mono text-[0.5625rem] tracking-[0.1em] uppercase",
                        r.severity === "critical" || r.severity === "high"
                          ? "bg-alert/12 text-alert"
                          : r.severity === "medium"
                            ? "bg-fact/12 text-fact"
                            : "bg-unknown/12 text-unknown",
                      )}
                    >
                      {r.severity}
                    </span>
                  )}
                  <h3 className="text-[0.9375rem] font-medium text-paper"><SafeText>{r.title}</SafeText></h3>
                  <Tag label={r.label} />
                </div>
                <SafeMarkdown className="prose prose-points text-[0.875rem]">{r.detail}</SafeMarkdown>
                <Refs ids={r.sourceIds} sources={sources} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---- Bottom line ---- */}
      {report.bottomLine && (
        <Card title="Bottom line">
          <SafeMarkdown className="prose text-[0.9375rem]">{report.bottomLine}</SafeMarkdown>
        </Card>
      )}

      {/* ---- Sources ---- */}
      {sources.length > 0 && (
        <Card title="Sources" aside={<span className="tnum text-[0.6875rem] text-paper-3">{sources.length}</span>}>
          <ol className="divide-y divide-line">
            {sources.map((s, i) => {
              const href = safeHref(s.url);
              return (
                <li key={i} id={`src-${i + 1}`} className="flex scroll-mt-6 gap-3 py-3">
                  <span className="tnum w-5 shrink-0 pt-px text-[0.6875rem] text-paper-3">{i + 1}</span>
                  <div className="min-w-0">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer nofollow ugc"
                        className="text-[0.875rem] text-paper transition-colors hover:text-fact"
                      >
                        <SafeText>{s.title}</SafeText>
                      </a>
                    ) : (
                      // A link that failed the http(s) check renders as inert text.
                      <span className="text-[0.875rem] text-paper-3"><SafeText>{s.title}</SafeText> (unsafe link removed)</span>
                    )}
                    <div className="mt-0.5 font-mono text-[0.625rem] text-paper-3">
                      <SafeText>{s.publisher ?? (href ? new URL(href).hostname : "")}</SafeText>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
