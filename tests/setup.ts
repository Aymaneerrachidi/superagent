/**
 * Test environment.
 *
 * Runs against an in-process PostgreSQL (PGlite), so transactions, ON CONFLICT
 * and FOR UPDATE behave exactly as they do in production. No mocking of the
 * database layer.
 */
// NODE_ENV is typed readonly; the test runner needs it set before any import.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = "";
process.env.HASH_SECRET = "test-hash-secret-that-is-long-enough-000000";
process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough-0000";
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_DEV_LOGIN_ENABLED = "true";
process.env.CAPTCHA_REQUIRED = "true";
process.env.SOLANA_VERIFY_ENABLED = "true";
process.env.MOCK_BASE44_DELAY_MS = "0";
process.env.ANALYSIS_ENABLED = "true";
process.env.RESEARCH_VERSION = "v1";
process.env.BASE44_WEBHOOK_SECRET = "test-webhook-secret";
process.env.ADMIN_EMAILS = "admin@dev.local";
