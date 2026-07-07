/**
 * Thin client for the official Hacker News Firebase API.
 * https://github.com/HackerNews/API
 */

const BASE = "https://hacker-news.firebaseio.com/v0";

export interface HnItem {
  id: number;
  type?: string; // "story" | "comment" | "job" | "poll" | ...
  title?: string;
  url?: string;
  text?: string; // HTML body for self/Ask/Show posts and comments
  by?: string;
  score?: number;
  descendants?: number;
  kids?: number[]; // child comment ids, in HN's ranked order
  time?: number; // unix seconds
  dead?: boolean;
  deleted?: boolean;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) {
    throw new Error(`HN API ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Up to 200 highest-scoring current stories — the primary "what's big" source. */
export function bestStoryIds(signal?: AbortSignal): Promise<number[]> {
  return getJson<number[]>("/beststories.json", signal);
}

/** Up to 500 current front-page story ids — catches fast risers before they peak. */
export function topStoryIds(signal?: AbortSignal): Promise<number[]> {
  return getJson<number[]>("/topstories.json", signal);
}

/** Fetch a single item. Returns null if the API yields null (unknown/expired id). */
export async function getItem(id: number, signal?: AbortSignal): Promise<HnItem | null> {
  return getJson<HnItem | null>(`/item/${id}.json`, signal);
}
