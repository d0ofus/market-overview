# Lean Market-Data Freshness Implementation Plan

## Outcome

Fix recurring `/overview` and `/breadth` freshness failures without changing the visible functionality or replacing the repository's existing job systems. Provider work must run in bounded scheduled or manual-refresh jobs; price-dependent GET routes must read stored, last-ready data.

No production deployment, remote migration, data deletion, push, or production feature-flag change is part of this implementation.

## Design constraints

- Keep the existing D1 bindings. `MARKET_DATA_DB` is the canonical daily-bar store; do not add an archive database.
- Extend the existing post-close, scan, pattern, RS, scheduler, and provider-usage state machines.
- Keep legacy `DB.daily_bars` available during shadow comparison and rollback.
- Use additive migrations and move the new freshness schemas out of request-time DDL.
- Preserve existing public response fields; any freshness, generation, or hydration fields are optional additions.
- Do not refactor unrelated 13F, alerts, research, fundamentals, or social-alert workflows.

## Canonical bars and coverage

- Use Alpaca IEX snapshots for live observations and completed SIP daily bars after the Basic plan's historical delay.
- Store split-adjusted bars with provider/feed provenance. Yahoo remains a source-specific repair path and never overwrites Alpaca rows.
- Process the exact completed session before history repair: overview/benchmarks, S&P 500, other valid breadth universes, then other active consumers.
- Backfill older and internal gaps even when a ticker already has a newer row.
- Verify earliest session, latest session, expected count, and internal gaps before marking history complete.
- Use conditional UPSERTs and run retention through maintenance, not per ticker refresh.
- Retain about 320 sessions for overview/breadth-only symbols and about 550 sessions for deeper consumers.

Add `bar_coverage` and short-lived `daily_market_features` tables to `MARKET_DATA_DB`. Persist calendar sessions, including early closes, when the provider calendar is available; retain the existing holiday calculation as fallback.

## Universes and breadth

- Stage versioned memberships and promote an active pointer only after validation.
- Accept S&P 500 at 480-525 members, NASDAQ at 2,500-5,000, NYSE at 1,500-3,500, overall market at 4,000-8,000, and the Russell proxy at 1,800-2,100 equity holdings.
- Reject changes above 5% for S&P 500 or 15% for other universes unless explicitly approved through authenticated admin behavior.
- Use validated IWM holdings as the operational Russell proxy; never promote the current 24-member result.
- Compute the current session's breadth inputs once per ticker and aggregate all universes from those feature rows.
- Require 98% coverage for S&P 500 and 95% for other universes. A failed attempt records readiness and never deletes or replaces the last-ready breadth row.
- Preserve the existing formulas, public shapes, and 450-session published history.

## Overview publication

- Store overview rows under an immutable generation ID.
- Validate all critical tickers and at least 95% current/history coverage before promotion.
- Atomically mark the generation ready and move an `overview_snapshot_pointer`; readers load only that generation.
- Publish an 80%-coverage partial generation only for first bootstrap when no last-ready generation exists and every critical ticker is present.
- Remove the mutable `overview_current_data` overlay from request-time dashboard reads.
- Refresh every 15 minutes from 04:00 through 16:15 America/New_York and publish the final close generation by 16:30 ET.

## Scheduling, provider limits, and GET behavior

- Retain three cron lanes. Run the market lane every five minutes; keep the core/scans and reports lanes staggered at 15 minutes.
- Each invocation leases idempotent work, processes at most four batches of at most 80 tickers, saves its cursor, and lets a later invocation resume.
- Extend provider usage with persistent minute buckets. Initial limits: Alpaca 160 requests/minute, TradingView 6/minute and 400/day, Yahoo one concurrent repair and 250/day.
- Honor `Retry-After`; otherwise retry with jittered exponential backoff up to three attempts. Use 8-second snapshot and 15-second history timeouts.
- Track actual D1 rows read/written for scheduled pipelines. Normal work stops at 70,000 writes or 4 million reads per UTC day; hard stops are 90,000 and 4.5 million. Warn at 400 MB and stop noncritical writes at 450 MB.
- Make dashboard/status, breadth, gappers, sector/peer metrics, ticker history, correlation, pattern charts, and overview FedWatch stored-read paths.
- Add resumable `refresh_jobs`; authenticated manual refresh returns HTTP 202 with a job ID and the web client polls for completion.

## Implementation phases

1. Add migrations, repair canonical ingestion and coverage, split live/history feed configuration, record actual usage, and add focused regression tests.
2. Add safe universe versions, validated Russell membership, daily breadth features, last-ready publication, and shadow comparison.
3. Add immutable overview generations, move scheduling to the market lane, make price-dependent GETs stored reads, and add asynchronous manual refresh polling.
4. Migrate remaining legacy price readers, add a completed pattern-run pointer and scanner-cache retention, shadow-read for ten trading sessions, then prepare a separately approved legacy cleanup.

## Definition of done

- Older/internal gaps backfill and incomplete history cannot be marked complete.
- Invalid universes and low-coverage breadth cannot replace ready data.
- Overview promotion is atomic and provider outages serve last-ready data.
- Selected price-data GET tests fail if a provider is called or D1 is written.
- Manual refresh jobs are idempotent, leased, resumable, and recover from expiration.
- Worker/web tests, both TypeScript typechecks, and relevant builds pass.
- `docs/market-data-freshness-rollout.md` documents remote migrations, canary order, monitoring, rollback, and later legacy cleanup.
