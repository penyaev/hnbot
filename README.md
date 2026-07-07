# hnbot

A personal Hacker News digest service. Two capabilities, both on demand:

1. **Top stories** — a sliding window of the past `WINDOW_DAYS`, ranked by peak score,
   returning `N` per call and never repeating ones already delivered. Call it once a day
   and you walk down the week's best stories without duplicates.
2. **Summary** — a Claude-generated overview of themes and trends across the past M days.

A background scheduler polls the [HN API](https://github.com/HackerNews/API) every couple
of hours and keeps a rolling window in SQLite. It's a single always-on Node service —
designed to deploy to Railway for ~$5/mo and forget about it.

> **Status:** deployed on Railway (project `hnbot`, region `sfo`), persisting to a volume
> mounted at `/data`. The scheduler keeps itself current with no manual action.

## How it works

- **Ingestion** (`src/ingest.ts`): polls `beststories` + `topstories`, fetches each item
  with bounded concurrency, and upserts into SQLite keeping the **peak** score seen
  (HN scores climb for ~24h then plateau).
- **Per-story summaries** (`src/storySummary.ts` + `src/article.ts`): after each poll, any
  story at/above `SUMMARY_MIN_SCORE` that lacks a summary gets one — we fetch the article
  text and the top HN comments and ask `STORY_SUMMARY_MODEL` for a single-paragraph
  summary, stored on the story. This builds a durable **history corpus** (kept forever,
  even after the story leaves the window) that feeds the digest and a future search feature.
- **Top stories** (`src/topStories.ts`): selects window stories not yet delivered to the
  feed, ranked by score, records them as delivered. Dedup state is server-side, keyed by
  a feed name.
- **Digest** (`src/summary.ts`): "summarizes the summaries" — feeds the stored per-story
  paragraphs for the top window stories to `SUMMARY_MODEL` (Sonnet 4.6) and returns a
  Markdown digest with inline source links (cached per calendar day). Expensive
  article-reading happens once per story, not per digest.

## API

All endpoints except `/health` require `Authorization: Bearer $API_TOKEN`.

| Method | Path       | Auth |
|--------|------------|------|
| GET    | `/health`  | no   |
| GET    | `/top`     | yes  |
| GET    | `/summary` | yes  |
| POST   | `/ingest`  | yes  |

### `GET /health`

Liveness probe (used by Railway). No params. Returns `{ ok, storyCount, summaryCount,
windowDays }`. `storyCount` is all rows in the store (recent window + retained summarized
history); `summaryCount` is how many have a per-story summary.

### `GET /top`

The deduplicated top-stories feed.

| Param  | Type   | Default        | Meaning |
|--------|--------|----------------|---------|
| `n`    | int    | `10`           | How many stories to return. Clamped to `1..100`. |
| `days` | int    | `WINDOW_DAYS` (7) | Window length: only consider stories submitted in the last this-many days. Min `1`. Can be smaller than the configured window (e.g. `days=2` for "just the last couple days") but not usefully larger than what's been ingested. |
| `feed` | string | `"default"`    | Which dedup feed to draw from. Must match `^[A-Za-z0-9_-]{1,64}$` or the call returns `400`. |

**How `feed` works:** dedup state is server-side, keyed by this name. Each call records
the stories it returns against the feed and excludes anything already returned to that feed
within the window. So calling once a day with the same `feed` walks you down the window's
best stories with no repeats — the client stores nothing. Use distinct feed names for
distinct consumers (e.g. `daily` for you, `telegram` for a future bot) so they don't eat
each other's stories. A brand-new feed name starts with an empty history.

Returns `{ feed, stories: [{ id, title, url, by, score, descendants, time, ageHours, hnUrl }] }`,
ranked by peak score (highest first). `score` is the highest score observed while polling;
`time` is the HN submission time (unix seconds); `ageHours` is hours since submission;
`hnUrl` links to the HN discussion.

### `GET /summary`

LLM-generated digest of themes and trends over the recent window.

| Param   | Type   | Default          | Meaning |
|---------|--------|------------------|---------|
| `days`  | int    | `SUMMARY_DAYS` (3) | Look-back window: summarize stories submitted in the last this-many days. Min `1`. |
| `limit` | int    | `SUMMARY_LIMIT` (40) | How many top stories (by score) to feed the model. Clamped to `1..200`. Higher = broader coverage but more tokens. |
| `fresh` | bool   | `false`          | `1`/`true` bypasses the cache and forces a new LLM call. |

Returns `{ summary, model, days, basedOn: [{ id, title, score, descendants, domain, hnUrl }] }`,
where `summary` is Markdown and `basedOn` is the exact story set the summary was built from.
Results are cached per `(calendar-day, days, limit)` to avoid re-billing identical requests;
use `fresh=1` to refresh mid-day.

### `POST /ingest`

Triggers an HN poll immediately, followed by a bounded per-story summarization pass (the
scheduler also does both every `POLL_CRON`). No params. Returns `{ ok, fetched, upserted,
summarized: { attempted, summarized }, storyCount, summaryCount }`. Useful right after a
fresh deploy to populate the window and start building summaries without waiting.

## Local development

```sh
cp .env.example .env        # set ANTHROPIC_API_KEY and API_TOKEN
npm install
npm run dev                 # tsx watch, DB at ./hnbot.db
```

Then:

```sh
export TOKEN=dev-token      # whatever you set as API_TOKEN
curl -XPOST localhost:8080/ingest -H "Authorization: Bearer $TOKEN"
curl "localhost:8080/top?n=5&feed=daily" -H "Authorization: Bearer $TOKEN"
curl "localhost:8080/summary?days=3" -H "Authorization: Bearer $TOKEN"
```

Calling `/top?feed=daily` again yields the next 5 stories, never the same ones.

## Deploy to Railway

Deployed via the Railway CLI from local files (the included `Dockerfile` + `railway.json`
are used automatically):

```sh
railway login
railway init --name hnbot
railway add --service hnbot --variables "API_TOKEN=..." --variables "DB_PATH=/data/hnbot.db"
railway volume add -m /data          # SQLite lives here, persists across redeploys
railway variables --set "ANTHROPIC_API_KEY=sk-ant-..."
railway up                           # build Dockerfile remotely + deploy
railway domain                       # assign a public URL
```

Healthcheck path is `/health`; start command is `node dist/index.js`. The Hobby plan
(~$5/mo, includes $5 of usage) comfortably covers one small service plus a tiny SQLite
volume. Summaries on Sonnet 4.6 over ~40 titles cost a fraction of a cent each.

### Shipping changes

The service is connected to the GitHub repo (`penyaev/hnbot`, branch `master`), so **`git
push` triggers a build and redeploy automatically**. `railway up` still works for pushing
local changes without committing. Env vars live in Railway and persist across deploys.

## Telegram bot

An optional delivery layer, built into the same service. Sends the top stories every
morning and a trends summary twice a week, with a **More stories** button to pull the next
batch on demand. It calls the in-process feed/summary logic directly (no HTTP hop) and uses
a per-chat dedup feed (`tg-<chatId>`), so each subscriber walks their own no-repeat stream.

**Setup:**

1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Set it on the service (triggers a redeploy): `railway variables --set "TELEGRAM_BOT_TOKEN=..."`
3. (Recommended) lock the bot to yourself: message the bot once, note the user id it
   echoes, then `railway variables --set "TELEGRAM_ALLOWED_USER_IDS=<your-id>"`.
4. Message the bot `/start`.

On boot the service registers a Telegram webhook at `${PUBLIC_URL}/telegram/webhook`
(authenticated by a secret derived from the bot token). `PUBLIC_URL` defaults to Railway's
public domain.

**Commands:** `/start` (subscribe), `/top` (top stories now), `/trends` (summary now),
`/stop` (unsubscribe). The schedule sends at `TELEGRAM_DAILY_CRON` (daily) and
`TELEGRAM_SUMMARY_CRON` (trends), both in `TELEGRAM_TZ`.

## Configuration

See `.env.example`. Core knobs: `WINDOW_DAYS`, `SUMMARY_DAYS`, `SUMMARY_LIMIT`,
`SUMMARY_MODEL`, `POLL_CRON`, `CLEANUP_CRON`, `FETCH_CONCURRENCY`. Per-story summaries:
`STORY_SUMMARY_MODEL`, `SUMMARY_MIN_SCORE`, `STORY_SUMMARY_MAX_PER_POLL`,
`STORY_SUMMARY_CONCURRENCY`, `ARTICLE_MAX_CHARS`, `COMMENTS_PER_STORY`. Telegram:
`TELEGRAM_BOT_TOKEN`, `PUBLIC_URL`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_STORIES`,
`TELEGRAM_TZ`, `TELEGRAM_DAILY_CRON`, `TELEGRAM_SUMMARY_CRON`.
