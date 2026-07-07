/**
 * Poll the HN API and upsert stories into the sliding-window store.
 * Score is stored as the PEAK observed value, since HN scores climb for ~24h
 * and then plateau — peak score is the best measure of "how big it got".
 */
import pLimit from "p-limit";
import { config } from "./config.js";
import { db } from "./db.js";
import { bestStoryIds, getItem, topStoryIds, type HnItem } from "./hn.js";

const upsertStmt = db.prepare(`
  INSERT INTO stories (id, title, url, by, score, descendants, time, first_seen, last_updated)
  VALUES (@id, @title, @url, @by, @score, @descendants, @time, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    title        = excluded.title,
    url          = excluded.url,
    by           = excluded.by,
    score        = MAX(stories.score, excluded.score),
    descendants  = excluded.descendants,
    last_updated = excluded.last_updated
`);

function isUsable(item: HnItem | null): item is HnItem & { title: string; time: number } {
  return (
    item != null &&
    item.type === "story" &&
    !item.dead &&
    !item.deleted &&
    typeof item.title === "string" &&
    typeof item.time === "number"
  );
}

export interface IngestResult {
  fetched: number;
  upserted: number;
}

/** Run one ingestion pass. Returns counts; logs but does not throw on per-item errors. */
export async function poll(): Promise<IngestResult> {
  const [best, top] = await Promise.all([
    bestStoryIds().catch((e) => {
      console.error("beststories fetch failed:", e);
      return [] as number[];
    }),
    topStoryIds().catch((e) => {
      console.error("topstories fetch failed:", e);
      return [] as number[];
    }),
  ]);

  const ids = Array.from(new Set([...best, ...top]));
  const limit = pLimit(config.fetchConcurrency);
  const now = Math.floor(Date.now() / 1000);
  let upserted = 0;

  const upsertMany = db.transaction((items: HnItem[]) => {
    for (const item of items) {
      upsertStmt.run({
        id: item.id,
        title: item.title!,
        url: item.url ?? null,
        by: item.by ?? null,
        score: item.score ?? 0,
        descendants: item.descendants ?? 0,
        time: item.time!,
        now,
      });
      upserted++;
    }
  });

  const items: HnItem[] = [];
  await Promise.all(
    ids.map((id) =>
      limit(async () => {
        try {
          const item = await getItem(id);
          if (isUsable(item)) items.push(item);
        } catch (e) {
          console.error(`item ${id} fetch failed:`, e);
        }
      }),
    ),
  );

  if (items.length > 0) upsertMany(items);

  console.log(`[ingest] fetched ${ids.length} ids, upserted ${upserted} stories`);
  return { fetched: ids.length, upserted };
}

/**
 * Prune aged-out rows and reclaim disk.
 *
 * Retention: summarized stories are KEPT forever — they're the history corpus
 * that feeds the digest and (later) search. Only un-summarized stories are
 * pruned once they leave the window, along with aged-out delivery records (an
 * aged-out story can never re-enter — `time` only moves further into the past).
 * Deletes alone don't shrink the SQLite file or bound the WAL, so we
 * checkpoint+truncate the WAL and VACUUM to give pages back to the filesystem.
 */
export function cleanup(): {
  storiesDeleted: number;
  deliveriesDeleted: number;
  pageCount: number;
} {
  const cutoff = Math.floor(Date.now() / 1000) - config.windowDays * 86400;
  const s = db
    .prepare("DELETE FROM stories WHERE time < ? AND summary IS NULL")
    .run(cutoff);
  const d = db.prepare("DELETE FROM deliveries WHERE delivered_at < ?").run(cutoff);

  // Flush + truncate the WAL so it doesn't accumulate, then reclaim free pages.
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");

  const pageCount = (db.pragma("page_count", { simple: true }) as number) ?? 0;
  const pageSize = (db.pragma("page_size", { simple: true }) as number) ?? 0;
  console.log(
    `[cleanup] removed ${s.changes} stories, ${d.changes} delivery records ` +
      `(cutoff ${cutoff}); db ~${Math.round((pageCount * pageSize) / 1024)} KiB`,
  );
  return { storiesDeleted: s.changes, deliveriesDeleted: d.changes, pageCount };
}
