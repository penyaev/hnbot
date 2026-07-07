/**
 * SQLite connection + schema. One database, two tables:
 *   stories     — the sliding-window store, keyed by HN item id, tracking PEAK score.
 *   deliveries  — per-feed record of which stories have already been returned.
 */
import Database from "better-sqlite3";
import { config } from "./config.js";

export interface StoryRow {
  id: number;
  title: string;
  url: string | null;
  by: string | null;
  score: number;
  descendants: number | null;
  time: number; // HN submission time, unix seconds
  first_seen: number;
  last_updated: number;
  summary: string | null;
  summary_model: string | null;
  summarized_at: number | null;
  summary_attempts: number;
}

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id           INTEGER PRIMARY KEY,
      title        TEXT NOT NULL,
      url          TEXT,
      by           TEXT,
      score        INTEGER NOT NULL,
      descendants  INTEGER,
      time         INTEGER NOT NULL,
      first_seen   INTEGER NOT NULL,
      last_updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stories_time_score ON stories(time, score);

    CREATE TABLE IF NOT EXISTS deliveries (
      feed         TEXT NOT NULL,
      story_id     INTEGER NOT NULL,
      delivered_at INTEGER NOT NULL,
      PRIMARY KEY (feed, story_id)
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_at ON deliveries(delivered_at);

    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id    TEXT PRIMARY KEY,
      user_id    TEXT,
      username   TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Per-story summary columns, added idempotently so existing databases upgrade in place.
  addColumn("stories", "summary", "TEXT");
  addColumn("stories", "summary_model", "TEXT");
  addColumn("stories", "summarized_at", "INTEGER");
  addColumn("stories", "summary_attempts", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_stories_summarized ON stories(summarized_at)");
}

/** ALTER TABLE ADD COLUMN only if the column doesn't already exist. */
function addColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function addSubscriber(chatId: string, userId: string, username: string | null): void {
  db.prepare(
    `INSERT INTO subscribers (chat_id, user_id, username, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, username = excluded.username`,
  ).run(chatId, userId, username, Math.floor(Date.now() / 1000));
}

export function removeSubscriber(chatId: string): boolean {
  return db.prepare("DELETE FROM subscribers WHERE chat_id = ?").run(chatId).changes > 0;
}

export function listSubscriberChatIds(): string[] {
  return (db.prepare("SELECT chat_id FROM subscribers").all() as { chat_id: string }[]).map(
    (r) => r.chat_id,
  );
}

/** Notable stories still missing a summary (and not exhausted on attempts), highest score first. */
export function listStoriesToSummarize(minScore: number, maxAttempts: number, limit: number): StoryRow[] {
  return db
    .prepare(
      `SELECT * FROM stories
       WHERE score >= ? AND summary IS NULL AND summary_attempts < ?
       ORDER BY score DESC LIMIT ?`,
    )
    .all(minScore, maxAttempts, limit) as StoryRow[];
}

export function saveStorySummary(id: number, summary: string, model: string): void {
  db.prepare(
    `UPDATE stories
     SET summary = ?, summary_model = ?, summarized_at = ?, summary_attempts = summary_attempts + 1
     WHERE id = ?`,
  ).run(summary, model, Math.floor(Date.now() / 1000), id);
}

export function markSummaryAttempt(id: number): void {
  db.prepare("UPDATE stories SET summary_attempts = summary_attempts + 1 WHERE id = ?").run(id);
}

export function summaryCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM stories WHERE summary IS NOT NULL").get() as {
    c: number;
  }).c;
}

// Run migration at module load, before any other module prepares statements
// against these tables (ESM evaluates this dependency before its importers' bodies).
migrate();

export function storyCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM stories").get() as { c: number };
  return row.c;
}
