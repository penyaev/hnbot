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
- **Top stories** (`src/topStories.ts`): selects window stories not yet delivered to the
  feed, ranked by score, records them as delivered, and returns an opaque `nextCursor`.
  Dedup state is server-side, keyed by a feed name; the cursor is a handle to that feed.
- **Summary** (`src/summary.ts`): feeds the top stories' titles + score/comment signal to
  `claude-sonnet-4-6` and returns a Markdown digest (cached per calendar day).

## API

| Method | Path       | Auth | Notes |
|--------|------------|------|-------|
| GET    | `/health`  | no   | `{ ok, storyCount, windowDays }` |
| GET    | `/top`     | yes  | `?n=10&days=7&feed=default&cursor=...` |
| GET    | `/summary` | yes  | `?days=3&limit=40&fresh=1` (`fresh=1` bypasses the daily cache) |
| POST   | `/ingest`  | yes  | trigger a poll immediately |

Authenticated endpoints require `Authorization: Bearer $API_TOKEN`.

`/top` returns `{ stories: [{ id, title, url, by, score, descendants, time, ageHours, hnUrl }], nextCursor, feed }`.
Pass `nextCursor` back on the next call to continue the same feed without repeats. Omit it
(optionally with `feed=NAME`) to start/continue a named feed; default feed is `"default"`.

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
curl "localhost:8080/top?n=5" -H "Authorization: Bearer $TOKEN"
curl "localhost:8080/summary?days=3" -H "Authorization: Bearer $TOKEN"
```

Calling `/top` again with the returned `nextCursor` yields the next 5 stories, never the
same ones.

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

The service is **not** connected to GitHub, so `git push` does **not** redeploy. To ship
local changes, run `railway up` again. To enable push-to-deploy instead, connect the
service to the GitHub repo in the Railway dashboard (Settings → Source) — pushes to the
default branch then trigger a build.

## Configuration

See `.env.example`. Key knobs: `WINDOW_DAYS`, `SUMMARY_DAYS`, `SUMMARY_LIMIT`,
`SUMMARY_MODEL`, `POLL_CRON`, `CLEANUP_CRON`, `FETCH_CONCURRENCY`.

## Roadmap

A delivery layer (Telegram/Slack) will be a thin client of `/top` and `/summary` on a
schedule — no change to this core.
