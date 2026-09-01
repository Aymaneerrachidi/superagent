/** Structured logging with mandatory redaction. */
import { redactObject, redact } from "@/lib/security/redact";

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redactObject(fields) as Record<string, unknown>),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", event, fields);
  },
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
  /** Never log a raw provider error — always route it through here. */
  redactError: (err: unknown) => redact(err),
};
