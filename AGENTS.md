# Repository Guide

Scope: this file applies to the whole repository.

## Repo Layout

- `web/` - Next.js App Router frontend using TypeScript, React 19, Tailwind, lucide icons, Recharts, and lightweight-charts.
  - `web/app/` contains routes, layouts, route handlers, and page-level UI.
  - `web/components/` contains dashboard and admin UI components.
  - `web/components/admin/` contains reusable admin surfaces and controls.
  - `web/lib/api.ts` centralizes Worker API calls and many frontend response types.
  - `web/types/` contains shared frontend types.
- `worker/` - Cloudflare Worker backend using Hono, TypeScript, D1, scheduled cron jobs, and Vitest.
  - `worker/src/index.ts` is the main router, scheduled handler entry, and integration point for most services.
  - `worker/src/*-service.ts` files contain domain services for overview, scans, alerts, research, earnings, options, peer groups, and scheduled reports.
  - `worker/src/validation.ts` contains Zod request schemas. Keep API validation changes here close to the routes that use them.
  - `worker/src/types.ts` contains shared Worker types and environment bindings.
  - `worker/test/` contains Vitest coverage for Worker services, APIs, security helpers, cron behavior, and domain calculations.
  - `worker/migrations/` contains the main D1 schema history.
  - `worker/fundamentals-migrations/`, `worker/scanner-cache-migrations/`, `worker/pattern-migrations/`, and `worker/perplexity-cache-migrations/` target separate D1 databases.
  - `worker/scripts/` contains one-off maintenance/bootstrap scripts.
- `ibkr-bridge/` - private local FastAPI bridge for read-only IBKR option chains and historical BID_ASK spread probes.
  - `ibkr-bridge/app/` contains FastAPI app code, config, schemas, metrics, and the IBKR client.
  - `ibkr-bridge/scripts/` contains PowerShell setup, health-check, tunnel, Windows task, and secret helper scripts.
  - `ibkr-bridge/tests/` contains pytest tests using fake clients, so tests do not require IB Gateway.
- `python-scans-service/` - small Scweet-backed social alerts helper plus pytest tests.
- `api/social-alerts-scweet.py` - Python API entrypoint for the Scweet social alerts path.
- `scripts/` - root utility scripts, currently including TradingView stock-field generation.
- Root docs: `README.md`, `TODO.md`, `PEER_GROUPS.md`, and `USEFUL.md`.
- Generated/local state such as `node_modules/`, `.pytest_cache/`, `.vercel/`, `worker/.wrangler/`, `worker/tmp/`, logs, and virtualenvs should not be treated as source.

## Install Commands

- Install Node workspace dependencies:
  ```powershell
  npm install
  ```
- Set up the IBKR bridge Python environment:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File ibkr-bridge/scripts/setup-venv.ps1
  ```
- Install the root Scweet helper dependency when working on `python-scans-service/`:
  ```powershell
  python -m pip install -r requirements.txt
  ```

## Build, Test, Lint, And Typecheck

- Build both Node workspaces:
  ```powershell
  npm run build
  ```
- Build only the Worker:
  ```powershell
  npm run build -w worker
  ```
- Build only the web app:
  ```powershell
  npm run build -w web
  ```
- Run the default test suite. Root `test` currently runs Worker tests only:
  ```powershell
  npm run test
  ```
- Run Worker Vitest tests:
  ```powershell
  npm run test -w worker
  ```
- Run web library tests:
  ```powershell
  npm run test -w web
  ```
- Run IBKR bridge tests:
  ```powershell
  npm run test:ibkr-bridge
  ```
- Run the Scweet helper tests after installing pytest in the active Python environment:
  ```powershell
  python -m pytest python-scans-service
  ```
- Typecheck the web app:
  ```powershell
  npx tsc --noEmit -p web/tsconfig.json
  ```
- Typecheck the Worker:
  ```powershell
  npx tsc --noEmit -p worker/tsconfig.json
  ```
- Linting: no dedicated lint script or lint config is currently present. Do not report lint as passing unless a lint tool has been added or configured.

## Run Locally

- Start both app surfaces from the repo root:
  ```powershell
  npm run dev
  ```
- `npm run dev` runs `npm run seed` first, then starts:
  - Worker: `http://127.0.0.1:8787`
  - Web: `http://127.0.0.1:3000`
- The seed path applies many local D1 migrations and deletes/reseeds many local tables. Treat it as a local data reset, not a harmless startup command.
- To avoid reseeding while iterating, run the two dev servers separately in separate terminals:
  ```powershell
  npm run dev -w worker
  npm run dev -w web
  ```
- Web local env is expected in `web/.env.local`, with at least:
  ```text
  NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787
  ADMIN_PASSWORD=<shared admin page password>
  ADMIN_SESSION_SECRET=<random session signing secret>
  ADMIN_SECRET=<same secret as Worker ADMIN_SECRET>
  ```
- Worker local secrets normally live in `worker/.dev.vars`. The README references `worker/.dev.vars.example`, but that example file is not currently present in the repo.
- Run the IBKR bridge locally from `ibkr-bridge/` after creating `.env` from `ibkr-bridge/.env.example`:
  ```powershell
  ibkr-bridge/scripts/start-bridge.ps1
  ```
- Check the bridge:
  ```powershell
  ibkr-bridge/scripts/check-bridge.ps1 -BridgeToken "<IBKR_BRIDGE_TOKEN>"
  ```

## Coding Conventions

- TypeScript is strict in both `web/tsconfig.json` and `worker/tsconfig.json`; preserve typed boundaries and avoid `any` unless there is a narrow compatibility reason.
- Use double quotes, semicolons, ESM imports, and 2-space indentation in TypeScript and TSX.
- Keep Worker request/response validation in Zod schemas in `worker/src/validation.ts`, then use the inferred/validated shapes in route and service code.
- Keep domain logic in service modules rather than growing `worker/src/index.ts` further when adding new behavior.
- For D1 access, follow the existing prepared-statement and typed row-mapping style. Prefer idempotent writes and explicit null handling.
- Put Worker tests near the affected behavior in `worker/test/*.test.ts`; use Vitest fake inputs/mocks instead of live providers.
- In the web app, centralize API URL construction and response shaping through `web/lib/api.ts` unless a Next route handler has a specific server-only reason.
- Prefer existing design tokens/classes from `web/app/globals.css` and existing admin/dashboard components. Keep dashboard UI dense, scan-friendly, and table-oriented.
- Use lucide icons where the existing UI uses icons. Avoid introducing a new icon system.
- Python bridge code uses type hints, Pydantic models, explicit auth checks, and blocking IBKR calls wrapped off the async loop. Keep public bridge endpoints read-only.
- Never expose admin or bridge secrets through `NEXT_PUBLIC_*`. Browser-visible env vars must be assumed public.

## Risky Areas

- D1 migrations and seed scripts: ordering, duplicate migration numbers, destructive deletes, and cross-database bindings can break local or remote data. Verify the exact target database before running `wrangler d1 execute --remote`.
- `worker/src/index.ts`: it is a large integration file for routes, scheduled jobs, email handling, and service wiring. Small changes can affect many surfaces.
- Scheduled jobs and cron budget code: `worker/wrangler.toml`, `worker/src/worker-schedule-service.ts`, `worker/src/cron-jobs-service.ts`, `worker/src/scheduled-budget.ts`, and scheduled report services can trigger provider spend or repeated writes.
- Provider integrations and usage metering: Alpaca, Yahoo, Brave, Gemini, Anthropic, Perplexity, SEC, Finnhub, FMP, Alpha Vantage, TradingView embed assumptions, and IBKR each have rate limits, data freshness quirks, or credentials.
- Admin authentication and proxying: `worker/src/auth.ts`, web admin auth libraries, and `web/app/api/admin/[...path]/route.ts` protect sensitive actions. Fail closed for new admin-only behavior.
- Research and Research Lab flows: these combine storage, external model calls, streaming/progress state, retry logic, and budget controls.
- Relative strength, scans, pattern scanner, and watchlist compiler/review: these are data-heavy workflows with cache tables, long-running jobs, and user-curated state.
- Options/IBKR bridge: the bridge is intentionally read-only and localhost-first. Do not add trading or account-mutation behavior.
- Social alerts Scweet path: depends on third-party/private scraping behavior and token health. Keep graceful degradation and error classification.
- Time zones and market sessions: app defaults mix Australia/Melbourne scheduling with US market dates. Be explicit about timezone assumptions in tests.

## Definition Of Done

- Bug fixes:
  - Reproduce or explain the failing behavior.
  - Add or update a focused regression test where practical.
  - Keep the fix scoped to the broken behavior.
  - Run the relevant test suite and typecheck for the touched workspace.
  - Note any unrun checks or live-provider assumptions.
- Refactors:
  - Preserve public API shapes, database schemas, route behavior, and UI behavior unless the change explicitly requires otherwise.
  - Keep or improve test coverage before moving logic across modules.
  - Avoid mixing refactors with feature work or unrelated formatting churn.
  - Run tests covering both the old and moved logic, plus typecheck for affected workspaces.
- Performance work:
  - State the bottleneck and expected improvement.
  - Prefer bounded batching, explicit timeouts, cache reuse, and provider budget awareness.
  - Add measurements, diagnostics, or tests that guard the new behavior.
  - Verify correctness under partial provider failure, stale data, and empty-result cases.

## PR Review Checklist

- Commands: were relevant tests, builds, and typechecks run, and are missing lint commands honestly called out?
- Scope: are unrelated code, generated files, logs, local state, and formatting churn avoided?
- Security: are admin, Worker, bridge, and provider secrets kept server-side and out of logs/browser bundles?
- Auth: do new admin or mutation routes require the same auth model as adjacent routes?
- Data safety: do migrations target the correct D1 database, preserve existing data, and include idempotent or backfill-safe behavior?
- API contracts: do Worker response changes match frontend types, parser code, and tests?
- Scheduling: could cron changes cause duplicate runs, provider overuse, or writes outside intended market/session windows?
- Provider failure: does the code handle timeouts, rate limits, stale data, missing credentials, and partial responses?
- UI: does the frontend remain responsive, dense, readable, and consistent with existing dashboard/admin components?
- Tests: are regression tests close to the changed behavior and free of live-provider requirements unless explicitly marked?
- Observability: are errors and diagnostics actionable without leaking sensitive values?
- Deployment: do Cloudflare Worker, Vercel web, and local bridge assumptions remain documented when env vars or bindings change?
