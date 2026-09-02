/**
 * Server-only configuration.
 *
 * Every field is a getter, read at access time, so a restart is not required
 * for a changed value to take effect. Nothing here may be imported from a
 * Client Component, and no Base44 value has a NEXT_PUBLIC_ counterpart.
 */
import "server-only";

const str = (name: string, fallback = "") => process.env[name] || fallback;

const int = (name: string, fallback: number) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const bool = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : /^(1|true|yes|on)$/i.test(raw.trim());
};

export const env = {
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },

  /** Shared passphrase for the closed beta. One code, a handful of people. */
  get accessCode() {
    return str("ACCESS_CODE");
  },
  /** Signs the access cookie so the cookie never contains the code itself. */
  get sessionSecret() {
    return str("SESSION_SECRET");
  },

  // ---- Base44 (server-only) ----
  get base44BaseUrl() {
    return str("BASE44_SUPERAGENT_BASE_URL");
  },
  get base44ApiKey() {
    return str("BASE44_SUPERAGENT_API_KEY");
  },
  get base44AgentId() {
    return str("BASE44_SUPERAGENT_ID");
  },
  /** Defaults to `api_key: <key>`. Use `authorization` + `Bearer` for a bearer deployment. */
  get base44AuthHeader() {
    return str("BASE44_AUTH_HEADER", "api_key");
  },
  get base44AuthScheme() {
    return str("BASE44_AUTH_SCHEME");
  },
  /**
   * Path appended to /conversations/{id} to post a message. Configurable
   * because the exact segment is not in Base44's public docs.
   */
  /** Optional. Enables the message.completed webhook when set. */
  get base44WebhookSecret() {
    return str("BASE44_WEBHOOK_SECRET");
  },
  get base44MessagePath() {
    const p = str("BASE44_MESSAGE_PATH", "/messages");
    return p.startsWith("/") ? p : `/${p}`;
  },
  /**
   * How long to wait for the Superagent, in milliseconds.
   *
   * 0 means no limit: poll until the agent answers. That is the default,
   * because a wait that eventually finishes is always better than discarding
   * research that was already paid for. Set a value only where the host
   * enforces its own ceiling (see the README on serverless).
   */
  get base44TimeoutMs() {
    return int("BASE44_TIMEOUT_MS", 0);
  },
  get base44MaxReportBytes() {
    return int("BASE44_MAX_REPORT_BYTES", 256_000);
  },
  get base44MaxRetries() {
    return int("BASE44_MAX_RETRIES", 2);
  },
  get base44ForceMock() {
    return bool("BASE44_FORCE_MOCK", false);
  },

  // ---- Spend guard ----
  /** Kill switch. Refuses new analyses before any upstream call. */
  get analysisEnabled() {
    return bool("ANALYSIS_ENABLED", true);
  },
  get cooldownSeconds() {
    return int("COOLDOWN_SECONDS", 20);
  },
  get maxPerDay() {
    return int("MAX_ANALYSES_PER_DAY", 50);
  },
  /** Reuse a completed report for the same address for this long. */
  get cacheTtlSeconds() {
    return int("CACHE_TTL_SECONDS", 300);
  },
  /**
   * When to stop waiting and show whatever the agent established. Not a
   * failure: the partial output is rendered and labelled as such.
   */
  get partialAfterSeconds() {
    return int("PARTIAL_AFTER_SECONDS", 480);
  },
} as const;

/** True when real credentials exist. Otherwise the deterministic mock runs. */
export function base44Configured(): boolean {
  return !env.base44ForceMock && env.base44BaseUrl.length > 0 && env.base44ApiKey.length > 0;
}

/**
 * Misconfiguration that must stop a production deploy.
 *
 * ACCESS_CODE is optional — leaving it blank means the app is open, which is a
 * valid choice. But a passphrase that is set must be long enough to be worth
 * having, and it needs a secret to sign its cookie with.
 */
export function configProblems(): string[] {
  if (!env.isProduction) return [];
  const problems: string[] = [];
  if (env.accessCode.length > 0) {
    if (env.accessCode.length < 4) problems.push("ACCESS_CODE must be at least 4 characters");
    if (env.sessionSecret.length < 32) {
      problems.push("SESSION_SECRET must be at least 32 characters when ACCESS_CODE is set");
    }
  }
  return problems;
}
