/**
 * LLM summary of HN trends over the past M days, via Claude Sonnet 4.6.
 * Operates on story titles + light metadata (score, comments, domain) — cheap,
 * and enough signal for a "what's been happening" overview.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { db, type StoryRow } from "./db.js";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

const SYSTEM_PROMPT = `You are a concise tech-news analyst. You are given the top Hacker News stories from the past few days, each with its score (points), comment count, and a source link. Produce a brief, skimmable digest in Markdown with these sections:

## TL;DR
2-4 sentences on the single biggest things that happened.

## Themes & trends
Group the stories into a handful of themes (e.g. AI, security, dev tools, business, science). For each theme, one short paragraph or a few bullets describing what's going on. Fold related stories together rather than listing them one by one.

## Notable stories
5-8 bullets for the standout individual stories, each: the headline as a short phrase, why it matters in a clause, and the score/comment signal in parentheses.

SOURCE LINKS (important): whenever you reference a specific story — in ANY section, including the TL;DR and themes — append a Markdown link to its source immediately after the mention, like "... a supply-chain nightmare ([link](https://example.com/...))". Use ONLY the exact URL given for that story in the list below; never invent, guess, or modify a URL, and never link to a story that isn't in the list. Every bullet in "Notable stories" must include its link.

Be factual and grounded in the titles provided — do not invent details not implied by a title. Keep the whole thing tight; a busy reader should get the picture in under a minute.`;

function domainOf(url: string | null): string {
  if (!url) return "news.ycombinator.com";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface SummaryStory {
  id: number;
  title: string;
  score: number;
  descendants: number | null;
  domain: string;
  /** Source link the model cites: the article URL, falling back to the HN discussion. */
  link: string;
  hnUrl: string;
}

export interface SummaryResult {
  summary: string;
  model: string;
  days: number;
  basedOn: SummaryStory[];
}

// Cache one summary per (days, limit, calendar day) to avoid re-billing repeat calls.
const cache = new Map<string, SummaryResult>();

function gatherStories(days: number, limit: number): StoryRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return db
    .prepare(
      "SELECT * FROM stories WHERE time >= ? ORDER BY score DESC, time DESC LIMIT ?",
    )
    .all(cutoff, limit) as StoryRow[];
}

export interface SummaryOptions {
  days?: number;
  limit?: number;
  noCache?: boolean;
}

export async function getSummary(opts: SummaryOptions = {}): Promise<SummaryResult> {
  const days = opts.days ?? config.summaryDays;
  const limit = opts.limit ?? config.summaryLimit;
  const dayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = `${dayKey}:${days}:${limit}`;

  if (!opts.noCache && cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const rows = gatherStories(days, limit);
  const basedOn: SummaryStory[] = rows.map((r) => {
    const hnUrl = `https://news.ycombinator.com/item?id=${r.id}`;
    return {
      id: r.id,
      title: r.title,
      score: r.score,
      descendants: r.descendants,
      domain: domainOf(r.url),
      link: r.url ?? hnUrl,
      hnUrl,
    };
  });

  if (basedOn.length === 0) {
    const empty: SummaryResult = {
      summary: "_No stories in the window yet — run an ingest first._",
      model: config.summaryModel,
      days,
      basedOn,
    };
    return empty;
  }

  const list = basedOn
    .map(
      (s, i) =>
        `${i + 1}. ${s.title} — ${s.score} pts, ${s.descendants ?? 0} comments — ${s.domain} — ${s.link}`,
    )
    .join("\n");

  const userPrompt = `Top Hacker News stories from the past ${days} day(s):\n\n${list}`;

  const message = await anthropic().messages.create({
    model: config.summaryModel,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const summary = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const result: SummaryResult = { summary, model: config.summaryModel, days, basedOn };
  if (!opts.noCache) cache.set(cacheKey, result);
  return result;
}
