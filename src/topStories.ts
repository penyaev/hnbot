/**
 * Top-stories feed: a sliding window of the past N days, ranked by peak score,
 * excluding anything already delivered to the same feed within the window.
 *
 * Dedup state lives server-side in the `deliveries` table, keyed by feed name.
 * The cursor is an opaque handle to a feed: calling once/day with the returned
 * cursor walks down the week's best stories with no repeats. Re-ranking the
 * current window on every call means a fresh high-scoring story still surfaces
 * promptly, ahead of older undelivered ones.
 */
import { db, type StoryRow } from "./db.js";
import { config } from "./config.js";

export interface TopStory {
  id: number;
  title: string;
  url: string | null;
  by: string | null;
  score: number;
  descendants: number | null;
  time: number;
  ageHours: number;
  hnUrl: string;
}

export interface TopResult {
  stories: TopStory[];
  nextCursor: string;
  feed: string;
}

interface CursorPayload {
  feed: string;
  issuedAt: number;
}

const FEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeCursor(feed: string): string {
  const payload: CursorPayload = { feed, issuedAt: Math.floor(Date.now() / 1000) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode a cursor to its feed name, or null if malformed. */
export function decodeCursor(cursor: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (payload && typeof payload.feed === "string" && FEED_RE.test(payload.feed)) {
      return payload.feed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve which feed a request targets. A valid cursor wins; otherwise an
 * explicit feed name; otherwise "default". Throws on an invalid explicit feed.
 */
export function resolveFeed(opts: { cursor?: string; feed?: string }): string {
  if (opts.cursor) {
    const fromCursor = decodeCursor(opts.cursor);
    if (fromCursor) return fromCursor;
    throw new Error("invalid cursor");
  }
  if (opts.feed) {
    if (!FEED_RE.test(opts.feed)) throw new Error("invalid feed name");
    return opts.feed;
  }
  return "default";
}

const selectStmt = db.prepare(`
  SELECT s.*
  FROM stories s
  WHERE s.time >= @cutoff
    AND NOT EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.feed = @feed AND d.story_id = s.id
    )
  ORDER BY s.score DESC, s.time DESC
  LIMIT @n
`);

const recordStmt = db.prepare(`
  INSERT INTO deliveries (feed, story_id, delivered_at)
  VALUES (@feed, @id, @now)
  ON CONFLICT(feed, story_id) DO NOTHING
`);

export interface TopOptions {
  n: number;
  days?: number;
  feed: string;
  /** When true (default), records returned stories as delivered. */
  record?: boolean;
}

export function getTopStories(opts: TopOptions): TopResult {
  const days = opts.days ?? config.windowDays;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - days * 86400;

  const rows = selectStmt.all({ cutoff, feed: opts.feed, n: opts.n }) as StoryRow[];

  if (opts.record !== false && rows.length > 0) {
    const recordMany = db.transaction((ids: number[]) => {
      for (const id of ids) recordStmt.run({ feed: opts.feed, id, now });
    });
    recordMany(rows.map((r) => r.id));
  }

  const stories: TopStory[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    by: r.by,
    score: r.score,
    descendants: r.descendants,
    time: r.time,
    ageHours: Math.round(((now - r.time) / 3600) * 10) / 10,
    hnUrl: `https://news.ycombinator.com/item?id=${r.id}`,
  }));

  return { stories, nextCursor: encodeCursor(opts.feed), feed: opts.feed };
}
