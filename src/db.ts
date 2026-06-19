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
  `);
}

// Run migration at module load, before any other module prepares statements
// against these tables (ESM evaluates this dependency before its importers' bodies).
migrate();

export function storyCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM stories").get() as { c: number };
  return row.c;
}
