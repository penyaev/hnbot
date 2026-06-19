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

// Run migration at module load, before any other module prepares statements
// against these tables (ESM evaluates this dependency before its importers' bodies).
migrate();

export function storyCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM stories").get() as { c: number };
  return row.c;
}
