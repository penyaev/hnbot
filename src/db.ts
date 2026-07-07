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

  migrateFts();
}

/**
 * Full-text search index over stories (title + summary), for the ask/search agent.
 * External-content FTS5 table synced to `stories` via triggers; backfilled once
 * on first creation. Must run after the summary column exists (triggers reference it).
 */
function migrateFts(): void {
  // Was the FTS table already present? (Can't use `count(*) FROM stories_fts` to
  // detect an empty index — for an external-content table that reads through to
  // the content table and returns the story count, not the index term count.)
  const ftsExisted = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stories_fts'")
    .get();

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts USING fts5(
      title, summary, content='stories', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS stories_fts_ai AFTER INSERT ON stories BEGIN
      INSERT INTO stories_fts(rowid, title, summary)
      VALUES (new.id, new.title, coalesce(new.summary, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS stories_fts_ad AFTER DELETE ON stories BEGIN
      INSERT INTO stories_fts(stories_fts, rowid, title, summary)
      VALUES ('delete', old.id, old.title, coalesce(old.summary, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS stories_fts_au AFTER UPDATE OF title, summary ON stories BEGIN
      INSERT INTO stories_fts(stories_fts, rowid, title, summary)
      VALUES ('delete', old.id, old.title, coalesce(old.summary, ''));
      INSERT INTO stories_fts(rowid, title, summary)
      VALUES (new.id, new.title, coalesce(new.summary, ''));
    END;
  `);

  // On first creation, build the index from the existing content rows. The
  // 'rebuild' command is the canonical way to (re)populate an external-content
  // FTS5 index (a manual INSERT..SELECT can leave the term index out of sync).
  // No-op on a brand-new empty DB; on an existing DB it indexes prior stories.
  // Once the table exists, the sync triggers keep it current, so we skip this.
  if (!ftsExisted) {
    db.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild')");
  }
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

/** How many notable stories are still awaiting a summary (backlog size). */
export function countStoriesToSummarize(minScore: number, maxAttempts: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM stories WHERE score >= ? AND summary IS NULL AND summary_attempts < ?",
      )
      .get(minScore, maxAttempts) as { c: number }
  ).c;
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

/** Build a safe FTS5 MATCH expression from free text: quoted terms joined with OR (for recall). */
function ftsMatch(query: string): string | null {
  const terms = Array.from(
    new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2)),
  ).slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Full-text search the corpus (title + summary), BM25-ranked. Optional recency window (days). */
export function searchStories(query: string, days: number | undefined, limit: number): StoryRow[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const params: Record<string, unknown> = { match, limit };
  let where = "stories_fts MATCH @match";
  if (days && days > 0) {
    where += " AND s.time >= @cutoff";
    params.cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  }
  return db
    .prepare(
      `SELECT s.* FROM stories_fts f JOIN stories s ON s.id = f.rowid
       WHERE ${where} ORDER BY bm25(stories_fts) LIMIT @limit`,
    )
    .all(params) as StoryRow[];
}

/** Map of story id → source link (article URL, falling back to the HN discussion). */
export function getStoryLinks(ids: number[]): Map<number, string> {
  const links = new Map<number, string>();
  if (ids.length === 0) return links;
  const rows = db
    .prepare(`SELECT id, url FROM stories WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: number; url: string | null }[];
  for (const r of rows) {
    links.set(r.id, r.url ?? `https://news.ycombinator.com/item?id=${r.id}`);
  }
  return links;
}

// Run migration at module load, before any other module prepares statements
// against these tables (ESM evaluates this dependency before its importers' bodies).
migrate();

export function storyCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM stories").get() as { c: number };
  return row.c;
}
