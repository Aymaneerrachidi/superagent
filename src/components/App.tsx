"use client";

/** Paste a contract address, watch it work, read the report. That is the app. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Report } from "@/lib/report/schema";
import { validateContractAddress, MAX_INPUT_LENGTH, ADDRESS_MESSAGES } from "@/lib/solana/address";
import { ReportView } from "@/components/Report";
import { ProgressPanel, type Progress } from "@/components/Progress";
import { RadarDashboard } from "@/components/RadarDashboard";

const EXAMPLE = "EEpng77ZPn9FbgbT4xsRjwuxNCcMBYq3HTwEscyTpump";
const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(" ");

type Access = { needsCode: boolean; unlocked: boolean; mode: "live" | "mock"; enabled: boolean };
type Job = {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  address: string;
  cached: boolean;
  snapshotAt: string | null;
  report: Report | null;
  error: string | null;
  errorCode: string | null;
  partial: boolean;
  progress: Progress[];
  timing: { caReceivedAt: number; requestSentAt: number | null; completedAt: number | null; elapsedMs: number };
};

export function App() {
  const [view, setView] = useState<"research" | "radar">("research");
  const [access, setAccess] = useState<Access | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  const [address, setAddress] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  const loadAccess = useCallback(async () => {
    try {
      const res = await fetch("/api/access", { cache: "no-store" });
      if (res.ok) setAccess((await res.json()) as Access);
    } catch {
      /* the page still renders without it */
    }
  }, []);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  // A deep research run takes minutes, so the wait is shown honestly.
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const check = validateContractAddress(address);
  const locked = access?.needsCode === true && access.unlocked === false;
  const canSubmit = check.ok && !busy && !locked && access?.enabled !== false;

  async function submit() {
    if (!check.ok) {
      setError(ADDRESS_MESSAGES[check.code]);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setJob(null);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.trim() }),
      });
      const raw = await res.text();
      let data: Job & { error?: string };
      try {
        data = JSON.parse(raw) as Job & { error?: string };
      } catch {
        setError(
          res.ok
            ? "The research service returned an unreadable response."
            : "The server ended the research request before returning a report. Try again.",
        );
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "That didn't go through.");
        setBusy(false);
        if (res.status === 401) void loadAccess();
        return;
      }
      setJob(data);
      if (data.status === "error") {
        setError(data.error ?? "That analysis didn't finish.");
        setErrorCode(data.errorCode ?? null);
      } else if (data.status !== "done") {
        setError("The research service ended without returning a report.");
      }
      setBusy(false);
    } catch {
      setError("Network problem. Try again.");
      setBusy(false);
    }
  }

  async function unlock() {
    setCodeError(null);
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      setCode("");
      await loadAccess();
      inputRef.current?.focus();
    } else {
      setCodeError("That passphrase didn't match.");
    }
  }

  async function copyReport() {
    if (!job?.report) return;
    await navigator.clipboard.writeText(asText(job.report, job.snapshotAt));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  // With nothing to show yet, the input is the whole page, so it sits centred
  // rather than stranded under a band of empty space.
  const idle = view === "research" && !job && !busy;

  return (
    <main className={cx("relative mx-auto flex min-h-dvh w-full flex-col px-5 sm:px-6", view === "radar" && !locked ? "max-w-[78rem]" : "max-w-[46rem]")}>
      <div className="bloom" aria-hidden="true" />

      <div className={cx("relative flex flex-1 flex-col pb-16", idle && "justify-center")}>
        {/* ---- Wordmark ---- */}
        <header className={cx("flex items-center justify-between gap-4", idle ? "absolute inset-x-0 top-8 sm:top-10" : "pt-8 pb-14 sm:pt-10")}>
          <span className="font-display text-[1.0625rem] tracking-[-0.01em] text-paper">
            Why Is This Pumping?
          </span>
          {!locked && <div className="flex items-center gap-2">
            <nav className="flex items-center gap-1 rounded-xl border border-line bg-ink-2 p-1" aria-label="Agents">
              <button type="button" onClick={() => setView("research")} aria-current={view === "research" ? "page" : undefined} className={cx("min-h-9 rounded-lg px-3 text-[0.7rem] transition-colors", view === "research" ? "bg-paper text-ink" : "text-paper-2 hover:text-paper")}>Token research</button>
              <button type="button" onClick={() => setView("radar")} aria-current={view === "radar" ? "page" : undefined} className={cx("min-h-9 rounded-lg px-3 text-[0.7rem] transition-colors", view === "radar" ? "bg-paper text-ink" : "text-paper-2 hover:text-paper")}>Runner radar</button>
            </nav>
            {view === "research" && access?.mode === "mock" && <span className="hidden rounded bg-fact/10 px-2 py-1 font-mono text-[0.5625rem] tracking-[0.1em] text-fact uppercase sm:block">Sample</span>}
          </div>}
        </header>

        {/* ---- Passphrase, only when one is configured ---- */}
        {locked ? (
          <section className="rounded-2xl border border-line bg-ink-2 p-6 sm:p-8">
            <h1 className="font-display text-2xl tracking-[-0.01em] text-paper">Private beta</h1>
            <p className="mt-2 mb-6 text-[0.875rem] text-paper-2">Enter the passphrase to continue.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlock()}
                placeholder="Passphrase"
                aria-label="Passphrase"
                autoComplete="current-password"
                className="h-11 flex-1 rounded-xl border border-line bg-ink px-3.5 text-[0.875rem] text-paper placeholder:text-paper-3 focus:border-fact/50"
              />
              <button
                type="button"
                onClick={() => void unlock()}
                className="h-11 rounded-xl bg-paper px-5 text-[0.875rem] font-medium text-ink transition-opacity hover:opacity-90"
              >
                Enter
              </button>
            </div>
            {codeError && <p className="mt-3 text-[0.8125rem] text-alert">{codeError}</p>}
          </section>
        ) : view === "radar" ? (
          <RadarDashboard />
        ) : (
          <>
            {/* ---- The one thing this page does ---- */}
            <h1 className="max-w-[36rem] font-display text-[2.5rem] leading-[1.06] tracking-[-0.02em] text-paper sm:text-[3.25rem]">
              See why it&rsquo;s moving.
            </h1>
            <p className="mt-4 max-w-[34rem] text-[0.9375rem] leading-relaxed text-paper-2">
              Paste a Solana, Base, BNB Chain, or Robinhood Chain contract. Get market cap,
              catalysts, wallet activity, risks, and sources.
            </p>

            <form
              className="mt-8"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit) void submit();
              }}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <input
                    ref={inputRef}
                    value={address}
                    onChange={(e) => {
                      setAddress(e.target.value.slice(0, MAX_INPUT_LENGTH * 2));
                      if (error) setError(null);
                    }}
                    placeholder="Contract address"
                    aria-label="Solana, Base, BNB Chain, or Robinhood Chain contract address"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-invalid={address.length > 0 && !check.ok}
                    className={cx(
                      "h-12 w-full rounded-xl border bg-ink-2 px-4 font-mono text-[0.8125rem] text-paper transition-colors",
                      "placeholder:font-sans placeholder:text-[0.875rem] placeholder:text-paper-3",
                      address.length > 0 && !check.ok
                        ? "border-alert/50"
                        : "border-line hover:border-line-2 focus:border-fact/50",
                    )}
                  />
                  {check.ok && (
                    <span className="absolute top-1/2 right-3.5 -translate-y-1/2 text-rise" aria-hidden="true">
                      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    </span>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className={cx(
                    "h-12 shrink-0 rounded-xl px-6 text-[0.875rem] font-medium transition-all",
                    canSubmit
                      ? "bg-paper text-ink hover:opacity-90 active:scale-[0.985]"
                      : "cursor-not-allowed bg-ink-3 text-paper-3",
                  )}
                >
                  {busy ? "Researching" : "Analyze"}
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAddress(EXAMPLE);
                  setError(null);
                  inputRef.current?.focus();
                }}
                className="mt-3 font-mono text-[0.6875rem] break-all text-paper-3 transition-colors hover:text-fact"
              >
                Try {EXAMPLE}
              </button>

              {error && (
                <div role="alert" className="mt-4 rounded-xl border border-alert/30 bg-alert/[0.07] px-4 py-2.5 text-[0.8125rem] text-alert">
                  {error}
                  {errorCode && (
                    <span className="ml-2 font-mono text-[0.6875rem] opacity-60">({errorCode})</span>
                  )}
                </div>
              )}
              {access?.enabled === false && (
                <p className="mt-4 rounded-xl border border-unknown/30 bg-unknown/[0.06] px-4 py-2.5 text-[0.8125rem] text-paper-2">
                  Analyses are paused right now.
                </p>
              )}
            </form>
          </>
        )}

        {/* ---- Progress: the agent thinking out loud ---- */}
        {view === "research" && busy && (!job || job.status === "running") && (
          <div className="mt-10">
            <ProgressPanel
              progress={job?.progress ?? []}
              stage={job?.stage ?? "verifying_token"}
              elapsed={elapsed}
              startedAt={job?.timing?.caReceivedAt ?? null}
            />
          </div>
        )}

        {/* ---- Report ---- */}
        {view === "research" && job?.status === "done" && job.report && (
          <div className="rise mt-10">
            {job.partial && (
              <p className="mb-4 rounded-xl border border-fact/30 bg-fact/[0.07] px-4 py-3 text-[0.8125rem] text-fact">
                Partial report. Run it again for the full result.
              </p>
            )}
            <ReportView
              report={job.report}
              snapshotAt={job.snapshotAt}
              cached={job.cached}
              actions={
                <button
                  type="button"
                  onClick={() => void copyReport()}
                  className="rounded-lg bg-ink-3 px-2.5 py-1 text-[0.6875rem] text-paper-2 transition-colors hover:bg-line hover:text-paper"
                >
                  {copied ? "Copied" : "Copy report"}
                </button>
              }
            />
            <button
              type="button"
              onClick={() => {
                setJob(null);
                setAddress("");
                inputRef.current?.focus();
              }}
              className="mt-6 rounded-xl border border-line px-4 py-2 text-[0.8125rem] text-paper-2 transition-colors hover:border-line-2 hover:text-paper"
            >
              Analyze another
            </button>
          </div>
        )}

      </div>

      <footer className="relative border-t border-line py-5 text-[0.6875rem] leading-relaxed text-paper-3">
        Research only. Verify the sources before you act.
      </footer>
    </main>
  );
}

/** Plain-text export for the clipboard. */
function asText(report: Report, snapshotAt: string | null): string {
  const out: string[] = [
    `WHY IS THIS PUMPING? — ${report.token?.symbol ?? ""} ${report.token?.mint ?? ""}`.trim(),
    `Snapshot: ${snapshotAt ?? report.snapshotAt ?? "unknown"}`,
    "",
    report.answer,
    "",
  ];
  if (report.metrics.length) {
    out.push("MARKET", report.metrics.map((m) => `${m.label}: ${m.value}`).join("  |  "), report.marketSummary, "");
  }
  if (report.catalysts.length) {
    out.push("WHY IT MOVED");
    for (const c of report.catalysts) {
      out.push(`- [${c.label} ${Math.round(c.confidence * 100)}%] ${c.title}`, `  ${c.summary}`);
    }
    out.push("");
  }
  if (report.narrative) out.push("NARRATIVE AND WALLETS", report.narrative, "");
  if (report.risks.length) {
    out.push("RISKS");
    for (const r of report.risks) out.push(`- [${r.severity.toUpperCase()}/${r.label}] ${r.title}: ${r.detail}`);
    out.push("");
  }
  if (report.bottomLine) out.push("BOTTOM LINE", report.bottomLine, "");
  if (report.sources.length) {
    out.push("SOURCES");
    report.sources.forEach((s, i) => out.push(`${i + 1}. ${s.title} — ${s.url}`));
    out.push("");
  }
  out.push("Research, not financial advice.");
  return out.join("\n");
}
