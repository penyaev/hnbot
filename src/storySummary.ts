/**
 * Per-story summarization: for each notable story, read the article + top HN
 * comments and store a single-paragraph summary. This builds a durable corpus
 * (history + future search) and is what the twice-weekly digest synthesizes,
 * so the expensive content-reading happens once per story, not per digest.
 */
import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import { config } from "./config.js";
import {
  listStoriesToSummarize,
  markSummaryAttempt,
  saveStorySummary,
  type StoryRow,
} from "./db.js";
import { getItem } from "./hn.js";
import { fetchArticleText, fetchTopComments, htmlToText } from "./article.js";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

const SYSTEM_PROMPT = `You write a single tight paragraph (3-5 sentences) summarizing a Hacker News story for someone deciding whether to read further. Cover what it's actually about and why it matters; if the community discussion adds a notable angle, caveat, or disagreement, work that in briefly. Be concrete and factual — rely only on the article text and comments provided, and don't speculate beyond them. No preamble, no headings, no bullet points, no "This article…" throat-clearing — just the paragraph.`;

/** Build a summary for one story. Returns the paragraph, or null if there was too little to work with. */
export async function summarizeStory(story: StoryRow): Promise<string | null> {
  // Re-fetch the live item for its comment ids and (for self-posts) body text.
  const item = await getItem(story.id).catch(() => null);

  const articleText = story.url
    ? await fetchArticleText(story.url)
    : item?.text
      ? htmlToText(item.text)
      : null;
  const comments = await fetchTopComments(item?.kids, config.storySummary.comments);

  // Nothing to summarize from — let the caller record a failed attempt and move on.
  if (!articleText && comments.length === 0) return null;

  const parts: string[] = [
    `Title: ${story.title}`,
    story.url ? `URL: ${story.url}` : `(Hacker News text post)`,
    `Score: ${story.score} points, ${story.descendants ?? 0} comments`,
  ];
  if (articleText) parts.push(`\nArticle content:\n${articleText}`);
  if (comments.length > 0) {
    const clipped = comments.map((c) => c.slice(0, 800));
    parts.push(`\nTop comments:\n${clipped.map((c) => `- ${c}`).join("\n")}`);
  }

  const message = await anthropic().messages.create({
    model: config.storySummary.model,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n") }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

export interface SummarizeResult {
  attempted: number;
  summarized: number;
}

/** Summarize a bounded batch of notable, not-yet-summarized stories. */
export async function summarizePending(): Promise<SummarizeResult> {
  if (!config.anthropicApiKey) {
    return { attempted: 0, summarized: 0 };
  }
  const pending = listStoriesToSummarize(
    config.storySummary.minScore,
    config.storySummary.maxAttempts,
    config.storySummary.maxPerPoll,
  );
  if (pending.length === 0) return { attempted: 0, summarized: 0 };

  const limit = pLimit(config.storySummary.concurrency);
  let summarized = 0;

  await Promise.all(
    pending.map((story) =>
      limit(async () => {
        try {
          const summary = await summarizeStory(story);
          if (summary) {
            saveStorySummary(story.id, summary, config.storySummary.model);
            summarized++;
          } else {
            markSummaryAttempt(story.id); // nothing to summarize; count the attempt
          }
        } catch (e) {
          console.error(`[storySummary] story ${story.id} failed:`, e);
          markSummaryAttempt(story.id);
        }
      }),
    ),
  );

  console.log(`[storySummary] attempted ${pending.length}, summarized ${summarized}`);
  return { attempted: pending.length, summarized };
}
