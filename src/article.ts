/**
 * Content fetching for per-story summaries: article body text (best-effort HTML
 * extraction) and top HN comments (via the API — reliable, no scraping).
 */
import pLimit from "p-limit";
import { config } from "./config.js";
import { getItem } from "./hn.js";

/** Safely decode a numeric HTML entity code point (returns "" on invalid values). */
function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/**
 * Keep prose-like lines and drop navigation/menu chrome (short single-word links,
 * language switchers, etc.). Falls back to the full text if filtering is too
 * aggressive (e.g. a page rendered as one big block with few line breaks).
 */
export function densify(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter((l) => l.split(/\s+/).length >= 6 || /[.!?:]$/.test(l));
  return (kept.length >= 3 ? kept : lines).join("\n");
}

/** Strip HTML to readable-ish plain text. Crude but dependency-free and good enough for a summary. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Fetch an article URL and return truncated plain text, or null on any failure
 * (timeout, non-HTML, error). Never throws.
 */
export async function fetchArticleText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.storySummary.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "hnbot/1.0 (+https://github.com/penyaev/hnbot)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("html")) return null; // skip PDFs, images, etc.
    const html = await res.text();
    const text = densify(htmlToText(html));
    return text.length > 0 ? text.slice(0, config.storySummary.articleMaxChars) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the top N HN comments for a story from its `kids`, as plain text. */
export async function fetchTopComments(kids: number[] | undefined, n: number): Promise<string[]> {
  if (!kids || kids.length === 0 || n <= 0) return [];
  const limit = pLimit(5);
  const ids = kids.slice(0, n);
  const results = await Promise.all(
    ids.map((id) =>
      limit(async () => {
        try {
          const item = await getItem(id);
          if (!item || item.dead || item.deleted || !item.text) return null;
          const text = htmlToText(item.text);
          return text.length > 0 ? `${item.by ?? "anon"}: ${text}` : null;
        } catch {
          return null;
        }
      }),
    ),
  );
  return results.filter((x): x is string => x !== null);
}
