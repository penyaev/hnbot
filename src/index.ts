/**
 * HN Digest Bot — HTTP API + scheduler bootstrap.
 *
 * Endpoints:
 *   GET  /health                         (public)
 *   GET  /top?n=&days=&feed=             (auth) top stories, dedup per feed
 *   GET  /summary?days=&limit=&fresh=    (auth) LLM trend summary
 *   POST /ingest                         (auth) trigger a poll now
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config, telegramEnabled } from "./config.js";
import { storyCount, summaryCount } from "./db.js";
import { requireAuth } from "./auth.js";
import { poll } from "./ingest.js";
import { summarizePending } from "./storySummary.js";
import { getTopStories, resolveFeed } from "./topStories.js";
import { getSummary } from "./summary.js";
import { ask } from "./ask.js";
import { startScheduler } from "./scheduler.js";
import { handleUpdate, registerWebhook, webhookSecret } from "./telegram.js";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    storyCount: storyCount(),
    summaryCount: summaryCount(),
    windowDays: config.windowDays,
  }),
);

// Telegram webhook — registered before the authenticated router so the latter's
// wildcard auth middleware doesn't intercept it. Authenticated instead via the
// secret_token header Telegram echoes back.
app.post("/telegram/webhook", async (c) => {
  if (!telegramEnabled) return c.text("ok");
  if (c.req.header("x-telegram-bot-api-secret-token") !== webhookSecret) {
    return c.json({ error: "forbidden" }, 403);
  }
  const update = await c.req.json().catch(() => null);
  // Respond 200 immediately; process asynchronously so Telegram doesn't retry.
  if (update) void handleUpdate(update).catch((e) => console.error("[telegram] update failed:", e));
  return c.text("ok");
});

const api = new Hono();
api.use("*", requireAuth);

api.get("/top", (c) => {
  const q = c.req.query();
  const n = Math.min(Math.max(Number.parseInt(q.n ?? "10", 10) || 10, 1), 100);
  const days = q.days ? Math.max(Number.parseInt(q.days, 10) || config.windowDays, 1) : undefined;

  let feed: string;
  try {
    feed = resolveFeed(q.feed);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  const result = getTopStories({ n, days, feed });
  return c.json(result);
});

api.get("/summary", async (c) => {
  const q = c.req.query();
  const days = q.days ? Math.max(Number.parseInt(q.days, 10) || config.summaryDays, 1) : undefined;
  const limit = q.limit
    ? Math.min(Math.max(Number.parseInt(q.limit, 10) || config.summaryLimit, 1), 200)
    : undefined;
  const noCache = q.fresh === "1" || q.fresh === "true";

  try {
    const result = await getSummary({ days, limit, noCache });
    return c.json(result);
  } catch (e) {
    console.error("summary failed:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

api.get("/ask", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "missing query param: q" }, 400);
  try {
    const result = await ask(q);
    return c.json({ question: q, ...result });
  } catch (e) {
    console.error("ask failed:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

api.post("/ingest", async (c) => {
  try {
    const result = await poll();
    const summarized = await summarizePending();
    return c.json({
      ok: true,
      ...result,
      summarized,
      storyCount: storyCount(),
      summaryCount: summaryCount(),
    });
  } catch (e) {
    console.error("manual ingest failed:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.route("/", api);

startScheduler();
void registerWebhook();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[hnbot] listening on :${info.port} (db=${config.dbPath})`);
});
