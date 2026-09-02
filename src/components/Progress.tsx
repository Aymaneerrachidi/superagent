"use client";

/**
 * Live progress.
 *
 * Shows what the agent is actually saying, as it says it. The six stage labels
 * are advanced by real narration arriving, not by a timer, so a slow step looks
 * slow instead of pretending to move.
 */
import { useEffect, useRef } from "react";
import { STAGES } from "@/lib/jobs/types";

const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(" ");

export type Progress = { at: number; text: string };

export function ProgressPanel({
  progress,
  stage,
  elapsed,
  startedAt,
}: {
  progress: Progress[];
  stage: string;
  elapsed: number;
  startedAt: number | null;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  const count = progress.length;

  // Keep the newest line in view as the agent talks.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [count]);

  const stageIndex = Math.max(0, STAGES.findIndex((s) => s.key === stage));
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="rise rounded-2xl border border-line bg-ink-2">
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
        <span className="flex items-center gap-2.5">
          <span className="breathe size-1.5 rounded-full bg-fact" aria-hidden="true" />
          <span className="eyebrow">Researching</span>
        </span>
        <span className="tnum text-[0.6875rem] text-paper-3">
          {mm}:{ss}
        </span>
      </div>

      {/* Stage rail: six dots, advanced by real narration. */}
      <div className="flex gap-1 px-5 pt-4" aria-hidden="true">
        {STAGES.map((s, i) => (
          <span
            key={s.key}
            title={s.label}
            className={cx(
              "h-0.5 flex-1 rounded-full transition-colors duration-500",
              i < stageIndex ? "bg-fact" : i === stageIndex ? "bg-fact/50" : "bg-line",
            )}
          />
        ))}
      </div>
      <p className="px-5 pt-2 text-[0.75rem] text-paper-3">
        {STAGES[stageIndex]?.label ?? "Working"}
      </p>

      {/* The agent's own words. */}
      <ol
        className="max-h-[22rem] space-y-3 overflow-y-auto px-5 py-4"
        aria-live="polite"
        aria-atomic="false"
      >
        {progress.length === 0 ? (
          <li className="text-[0.8125rem] text-paper-3 italic">
            Waiting for the agent to start reporting back…
          </li>
        ) : (
          progress.map((p, i) => {
            const secs = startedAt ? Math.max(0, Math.round((p.at - startedAt) / 1000)) : null;
            const latest = i === progress.length - 1;
            return (
              <li
                key={`${p.at}-${i}`}
                ref={latest ? endRef : undefined}
                className="rise flex gap-3"
              >
                <span className="tnum w-10 shrink-0 pt-0.5 text-[0.625rem] text-paper-3">
                  {secs === null ? "" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}
                </span>
                <p
                  className={cx(
                    "text-[0.8125rem] leading-relaxed",
                    latest ? "text-paper" : "text-paper-2",
                  )}
                >
                  {p.text}
                </p>
              </li>
            );
          })
        )}
      </ol>

      <p className="border-t border-line px-5 py-3 text-[0.7rem] text-paper-3">
        This keeps running if you switch tabs. If it takes too long, you get whatever the agent
        established so far rather than nothing.
      </p>
    </div>
  );
}
