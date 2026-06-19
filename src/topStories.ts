/**
 * Top-stories feed: a sliding window of the past N days, ranked by peak score,
 * excluding anything already delivered to the same feed within the window.
 *
 * Dedup state lives server-side in the `deliveries` table, keyed by feed name.
 * Calling once/day with the same `feed` walks you down the week's best stories
 * with no repeats — the client stores nothing. Re-ranking the current window on
 * every call means a fresh high-scoring story still surfaces promptly, ahead of
 * older undelivered ones. Use distinct feed names for distinct consumers.
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
  feed: string;
}

const FEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve and validate which feed a request targets: an explicit feed name, or
 * "default". Throws on an invalid feed name.
 */
export function resolveFeed(feed?: string): string {
  if (feed) {
    if (!FEED_RE.test(feed)) throw new Error("invalid feed name");
    return feed;
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

  return { stories, feed: opts.feed };
}
