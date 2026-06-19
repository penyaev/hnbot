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

  telegram: {
    /** BotFather token. When empty, all Telegram features are disabled. */
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

    /**
     * Public base URL of this service (no trailing slash), used to register the
     * Telegram webhook, e.g. https://hnbot-production.up.railway.app.
     * Falls back to Railway's injected RAILWAY_PUBLIC_DOMAIN if present.
     */
    publicUrl:
      process.env.PUBLIC_URL ??
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : ""),

    /**
     * Allowlist of Telegram numeric user IDs permitted to use the bot.
     * Empty = open (anyone who messages the bot can subscribe) — set this for a
     * private bot.
     */
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),

    /** Stories per Telegram message (daily send and each "More stories" tap). */
    stories: int("TELEGRAM_STORIES", 8),

    /** IANA timezone for the Telegram send schedule. */
    tz: str("TELEGRAM_TZ", "Europe/Berlin"),

    /** Cron for the daily top-stories send (in TELEGRAM_TZ). Default 08:00 daily. */
    dailyCron: str("TELEGRAM_DAILY_CRON", "0 8 * * *"),

    /** Cron for the trends summary send (in TELEGRAM_TZ). Default 08:00 Tue & Fri. */
    summaryCron: str("TELEGRAM_SUMMARY_CRON", "0 8 * * 2,5"),
  },
} as const;

/** True when a bot token is configured. */
export const telegramEnabled = config.telegram.botToken !== "";

export type Config = typeof config;
