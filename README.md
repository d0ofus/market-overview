# Market Command Centre (EOD-first)

Production-oriented monorepo for a swing-trading research dashboard with:
- `web/`: Next.js App Router + TypeScript + Tailwind
- `worker/`: Cloudflare Worker + D1 + Cron EOD pipeline

This is a research tool only. It is not investment advice.

## Features

- EOD-first workflow with daily scheduled snapshot computation
- Curated dashboard structure:
  - `01 Macro Overview`
  - `02 Equities Overview`
  - `03 Market Breadth & Sentiment`
  - `04 Position Sizing Calculator`
- New research modules:
  - `13F Tracker` (major hedge fund holdings snapshots)
  - `Key Sector Tracker` (trend list + calendar + narratives + linked stocks)
  - `Alerts` (TradingView email-ingested alerts, session/date filtering, chart modes, and top news per ticker/day)
- Top status bar: last updated timestamp, auto-refresh label, timezone, provider label
- Ranked tables with configurable ranking windows (`1D`, `5D`, `1W`, `YTD`, `52W`)
- Per-row trend sparklines (last ~60 closes)
- Breadth panel with summary cards + time series chart
- Ticker deep dive page + optional TradingView embed widget (no scraping)
- Admin builder UI for no-code customization:
  - add/remove sections
  - add/remove groups
  - add/remove/reorder tickers
  - reorder groups/items
  - choose ranking window, visible columns, sparkline toggle

## Architecture

- Storage: Cloudflare D1
  - `symbols`, `daily_bars`
  - config tables (`dashboard_*`)
  - snapshot tables (`snapshots_meta`, `snapshot_rows`, `breadth_snapshots`)
- Worker:
  - `GET /api/dashboard`
  - `GET /api/status`
  - `GET /api/breadth`
  - `GET /api/ticker/:ticker`
  - `GET /api/alerts`
  - `GET /api/alerts/unique-tickers`
  - `POST /api/admin/alerts/ingest-email` (internal ingestion endpoint for normalized inbound email payloads)
  - `POST /api/admin/alerts/reconcile` (optional mailbox reconciliation + retention cleanup)
  - Admin endpoints under `/api/admin/*` with Bearer auth
  - `scheduled()` cron handler for EOD run
- Web:
  - Sidebar navigation
  - Home (overview), breadth page, tools page, 13F tracker, sector tracker, admin page

## Data Provider

Provider interface (worker) is pluggable:
- `getDailyBars(tickers[], startDate, endDate)`
- `getQuoteSnapshot(tickers[])` (optional)

Current V1 defaults to Alpaca delayed IEX daily bars (API key + secret required), with stored/seeded bars fallback if refresh fails.  
CSV fallback upload endpoint is available:
- `POST /api/admin/upload-bars`

## Local Development

Prereqs:
- Node 20+
- npm
- Wrangler (`npm` dependency in `worker/`)

1. Install dependencies:
```bash
npm install
```

2. Configure local worker env:
```bash
copy worker\\.dev.vars.example worker\\.dev.vars
```

3. Start both apps:
```bash
npm run dev
```

`npm run dev` runs seed first, then:
- Worker on `http://127.0.0.1:8787`
- Web on `http://127.0.0.1:3000`

## Environment Variables

Worker (`worker/wrangler.toml` vars and secrets):
- `ADMIN_SECRET` (secret; required for admin auth in non-dev)
- `DATA_PROVIDER` (`alpaca`, `stooq`, `synthetic`, `csv`)
- `ALPACA_FEED` (`iex` default, optional)
- `APP_TIMEZONE` (default `Australia/Melbourne`)
- `TRADINGVIEW_WIDGET_ENABLED` (`true`/`false`)
- `ALERTS_RECONCILE_ENABLED` (`true`/`false`; default `false`)
- `ALERTS_MAILBOX_SYNC_URL` (optional mailbox sync endpoint for reconciliation)
- `ALERTS_MAILBOX_SYNC_TOKEN` (optional bearer token for mailbox sync endpoint)
- `ALERTS_ENABLE_YFINANCE_FALLBACK` (`true`/`false`; fallback only when higher-priority news providers are insufficient/unavailable)
- `ALERTS_EMAIL_ALLOWED_FROM` (comma-separated sender allowlist for direct inbound email handling; default `tradingview.com`)
- `IBKR_NEWS_ENABLED` (`true`/`false`; adapter-ready interface, default `false`)
- `IBKR_NEWS_ENDPOINT` (optional phase-2 IBKR adapter endpoint)
- `IBKR_NEWS_TOKEN` (optional phase-2 IBKR adapter token)

Worker secrets for Alpaca:
- `ALPACA_API_KEY`
- `ALPACA_API_SECRET`

Web (`web/.env.local`):
- `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787`
- `NEXT_PUBLIC_ADMIN_SECRET=<same-admin-secret-for-dev-testing>`

## D1 Schema + Seed

- Schema: `worker/migrations/0001_init.sql`
- Seed: `worker/migrations/0002_seed.sql`
- Tracker schema + sample seed: `worker/migrations/0003_trackers.sql`
- Alerts schema: `worker/migrations/0008_alerts_email_ingestion.sql`

Seed script:
```bash
npm run seed -w worker
```

## EOD Job

Cron configured in `worker/wrangler.toml`:
- `*/15 * * * 1-5` (worker wakes every 15 minutes on weekdays; runtime checks execute at configured local refresh time)

Manual run:
```bash
curl -X POST "http://127.0.0.1:8787/api/admin/run-eod?date=2026-02-27" \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

Idempotent storage is handled via unique keys and upserts.

## Deploy (Cloudflare)

1. Create D1 DB and set binding:
```bash
wrangler d1 create market_command
```

2. Update `worker/wrangler.toml` with real `database_id`.

3. Apply migrations:
```bash
wrangler d1 execute market_command --remote --file=worker/migrations/0001_init.sql
wrangler d1 execute market_command --remote --file=worker/migrations/0002_seed.sql
wrangler d1 execute market_command --remote --file=worker/migrations/0003_trackers.sql
wrangler d1 execute market_command --remote --file=worker/migrations/0005_market_leaders_timezone.sql
wrangler d1 execute market_command --remote --file=worker/migrations/0007_config_refresh_local_time.sql
wrangler d1 execute market_command --remote --file=worker/migrations/0008_alerts_email_ingestion.sql
```

4. Set worker secrets:
```bash
wrangler secret put ADMIN_SECRET
wrangler secret put ALPACA_API_KEY
wrangler secret put ALPACA_API_SECRET
```

5. Deploy worker:
```bash
npm run build -w worker
wrangler deploy --config worker/wrangler.toml
```

6. Deploy web to Cloudflare Pages:
- Build command: `npm run build -w web`
- Output: `.next` (Next.js on Pages with adapter as needed)
- Set `NEXT_PUBLIC_API_BASE` to Worker URL

## Tests

Worker tests:
- metrics computations
- sparkline/ranking behavior
- breadth computations
- config payload validation

Run:
```bash
npm run test -w worker
```

## Compliance Notes

- TradingView usage is embed-widget only. No TradingView scraping.
- Designed as low-cost/free-first (D1 + Worker + Alpaca free IEX delayed feed path).
- Include provider keys for production-quality refresh (Alpaca recommended in this repo).

## Alerts Email Ingestion Notes

- Core ingestion is email-only, not TradingView webhooks.
- Worker supports direct Cloudflare Email Worker ingestion via native `email()` handler.
- Recommended production path is event-driven mailbox routing directly to this worker (no polling needed).
- Alternate fallback path is posting normalized payloads to:
  - `POST /api/admin/alerts/ingest-email`
- Payload shape supports one or many normalized emails:
  - `{ "email": { ... } }` or `{ "emails": [{ ... }, ...] }`
- Persisted records:
  - raw email intake (`tv_alert_emails`)
  - normalized alerts (`tv_alerts`)
  - deduplicated ticker/day news (`ticker_news`)
- News enrichment provider order:
  - Alpaca first
  - IBKR adapter interface (phase-2 ready)
  - Yahoo/yfinance-style fallback only when higher-priority providers are unavailable/insufficient
- Retention:
  - automated 30-day cleanup for raw emails, alerts, and news
