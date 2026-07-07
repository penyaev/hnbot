/**
 * Conversational search agent: answer natural-language questions about recent HN
 * stories using a `search_stories` tool over the local FTS5 corpus. Claude drives
 * the search (multiple queries as needed), then answers grounded in the results,
 * citing stories by [[id]] which we expand into real links (never hallucinated).
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { getStoryLinks, searchStories } from "./db.js";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_stories",
  description:
    "Full-text search a local archive of notable Hacker News stories (titles + one-paragraph summaries). Returns matching stories ranked by relevance. Call it multiple times with different keywords or synonyms to improve recall. Use the `days` filter for questions about what's recent/lately/these days.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to search for — a company, project, technology, or topic.",
      },
      days: {
        type: "integer",
        description: "Optional: only return stories from the last N days (for recency-scoped questions).",
      },
      limit: { type: "integer", description: "Max results (default 8, max 15)." },
    },
    required: ["query"],
  },
};

const SYSTEM = `You answer questions about recent Hacker News stories. You have a search_stories tool over a local archive of notable HN stories, each with a one-paragraph summary.

- Always search before answering. If the first search is thin, search again with different keywords or synonyms. Use the days filter for "recent"/"lately"/"these days" questions.
- Ground every factual claim in the retrieved stories — do not assert what happened from outside knowledge. If the archive has nothing relevant, say so plainly (the archive only covers notable stories, so niche items may be missing).
- Cite each story you reference by appending its id in double brackets exactly as given, e.g. "... shipped a rewrite [[48546294]]". Never write URLs yourself; cite only ids returned by the tool.
- Be concise and conversational: a few sentences, or a short bulleted list when covering several stories. No preamble.`;

function domainOf(url: string | null): string {
  if (!url) return "news.ycombinator.com";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Execute one search_stories tool call and return the JSON string result. */
function runSearch(input: Record<string, unknown>): string {
  const query = typeof input.query === "string" ? input.query : "";
  const days = typeof input.days === "number" ? input.days : undefined;
  const limit = Math.min(Math.max(Number(input.limit) || config.ask.searchLimit, 1), 15);
  const now = Math.floor(Date.now() / 1000);
  const results = searchStories(query, days, limit).map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
    comments: r.descendants ?? 0,
    ageDays: Math.round((now - r.time) / 86400),
    domain: domainOf(r.url),
    summary: r.summary ? r.summary.slice(0, 600) : null,
  }));
  return JSON.stringify({ count: results.length, results });
}

export interface AskResult {
  answer: string;
  usedIds: number[];
}

/** Replace [[id]] markers with real Markdown links; drop ids not in the corpus. */
function expandCitations(text: string): AskResult {
  const ids = new Set<number>();
  for (const m of text.matchAll(/\[\[(\d+)\]\]/g)) ids.add(Number(m[1]));
  const links = getStoryLinks([...ids]);
  const answer = text
    .replace(/\[\[(\d+)\]\]/g, (_m, n: string) => {
      const url = links.get(Number(n));
      return url ? `([link](${url}))` : "";
    })
    .replace(/ *\(\s*\)/g, "")
    .trim();
  return { answer, usedIds: [...links.keys()] };
}

/** Answer a natural-language question about the corpus. */
export async function ask(question: string): Promise<AskResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  let final = "";

  for (let i = 0; i < config.ask.maxIterations; i++) {
    const resp = await anthropic().messages.create({
      model: config.ask.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [SEARCH_TOOL],
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === "tool_use" && block.name === "search_stories") {
          let out: string;
          try {
            out = runSearch(block.input as Record<string, unknown>);
          } catch (e) {
            out = JSON.stringify({ error: (e as Error).message });
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    final = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    break;
  }

  if (!final) {
    final = "I couldn't find anything relevant in the archive for that — try rephrasing or a broader topic.";
  }
  return expandCitations(final);
}
