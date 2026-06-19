/**
 * Central configuration, parsed from environment variables with sane defaults.
 * See .env.example for the full list.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  return n;
}

export const config = {
  /** HTTP port to listen on. */
  port: int("PORT", 8080),

  /** Path to the SQLite database file. On Railway, point this at a mounted volume. */
  dbPath: str("DB_PATH", "./hnbot.db"),

  /** Shared secret required (as a Bearer token) on the authenticated endpoints. */
  apiToken: str("API_TOKEN", "dev-token"),

  /** Anthropic API key for summaries. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  /** Sliding-window length (days) for the top-stories feed. */
  windowDays: int("WINDOW_DAYS", 7),

  /** Default look-back (days) for summaries. */
  summaryDays: int("SUMMARY_DAYS", 3),

  /** Default number of top stories fed into a summary. */
  summaryLimit: int("SUMMARY_LIMIT", 40),

  /** Claude model used for summaries. */
  summaryModel: str("SUMMARY_MODEL", "claude-sonnet-4-6"),

  /** Cron expression for the HN poll job. Default: every 2 hours. */
  pollCron: str("POLL_CRON", "0 */2 * * *"),

  /** Cron expression for the daily cleanup job. Default: 03:17 every day. */
  cleanupCron: str("CLEANUP_CRON", "17 3 * * *"),

  /** Concurrency limit when fetching individual HN items. */
  fetchConcurrency: int("FETCH_CONCURRENCY", 15),
} as const;

export type Config = typeof config;
