# Archive-first market database compatibility

The replacement market database may contain only the latest session initially. The verified archive supplies earlier bars; 260/90 sessions are maximum hot retention windows that grow naturally, not minimum bootstrap populations.

The old binding remains canonical throughout transfer. Binding cutover requires `EOD_READ_ENABLED=true`, complete accepted latest overview/breadth publications, a complete matching catalog including compatibility metadata, and measured reader/capacity evidence. A copied database or passing unit test alone does not authorize cutover.

| Consumer | History after a one-session hot bootstrap |
| --- | --- |
| Overview and breadth pages | Immutable accepted publications; no recalculation from the one-row hot population on page reads |
| Legacy overview stored metrics | `overview-current-data.ts` reads the same provider/adjustment range through the shared archive reader |
| Legacy snapshot sparkline consistency | `overview-snapshot.ts` compares the full trailing 90 merged observations |
| ETF holding quotes | Compact catalog prices and exact prior observed date, compared with the preceding cached exchange session; missing/repair-fenced rows remain null |
| Sector/industry ETF 1D stats | Compact catalog when EOD reads are enabled; bounded merged-history fallback preserves legacy read behavior |
| Sector trending | Additive catalog compatibility tuples preserve the prior observed-bar five-day return and >6-row/date-window requirement; no full-universe archive decompression in HTTP |
| Pattern full-universe prefilter and scan/RS coverage | Compact catalog preserves full retained counts, first/latest dates, price and liquidity thresholds |
| Pattern selected candidates and historical setup/label inputs | Existing shared range/count archive readers retain 520/MAX history |
| Relative-strength/VCP calculations, RS state and precompute benchmark | Existing shared range/count archive readers |
| Daily market features | Existing shared archive reader retains the full calculation lookback and correction fence |
| Correlation and earnings gap analysis | Existing shared archive range/count readers |
| Watchlist factors and review preparation | Existing shared archive range/count/coverage readers |
| Daily-bar incremental refresh planning | Latest dates merge hot indexed seeks with verified archive manifests, without reading compressed payloads |
| Exact-date refresh checks and overview audit | Indexed hot checks first; only missing tickers use the verified archive range reader, so an archived date no longer triggers an unnecessary fetch |
| Admin provider-check stored-bar diagnostic | Shared trailing-bar reader, including archive-only securities |

Remaining direct `alpaca_daily_bars` queries either write or repair the hot store, measure/prune hot retention, inspect schema, or belong to legacy branches that cannot be used for binding cutover with EOD reads disabled. Their table counts describe hot rows, not total retained history.

The base catalog remains schema version 1 with ten-slot tuples. Its additive `compatibility` object contains version 1 tuples `[ticker, previousDate, trend5d, trendWindowStartDate]`. The builder computes these once from the same canonical SIP history. A missing supplement is not a zero return: sector ranking reports unavailable until rebuilt, while holding 1D returns remain null without exact predecessor evidence. Old feature checkpoints lacking compatibility data must not be reused for the required bootstrap publication. The active-writer cutover guard requires unique supplement tuples for the complete frozen population and validates their count/date semantics; an old ten-tuple catalog alone cannot pass.

Bootstrap source revisions must describe the seeded market and archived inputs together. Seed writes fire normal revision triggers; copying a catalog before final revision preservation can invalidate it. All retained catalog payloads and future supplements contribute to the capacity forecast; this pass does not expire older catalogs needed by paused historical runs.

Local regression evidence lives in `worker/test/archive-only-market-compat.test.ts` and exercises real migrated SQLite plus verified compressed archive blocks:

- 520 observations and MAX history with only one hot row; identical legacy overview metrics and 90-point snapshot comparison.
- An archive-only security and requested date cause no provider fetch or hot insertion.
- The 6,000-symbol hot-present exact-date path uses six Market queries and no Archive queries; incremental refresh remains below 50 queries without reading archive payloads.
- All 105 requested holding prices and returns come from bounded catalog/calendar queries, including an exceptional closure, unknown symbol and pending repair.
- Sector ranking preserves complete/incomplete observed windows and rejects missing compatibility metadata.

The existing catalog suite additionally checks a 6,000-security prefilter, revision/correction handling and exact-session requirements. These are correctness/query-shape checks, not production Worker CPU or account quota measurements. Production acceptance still requires the independently measured rollout evidence.
