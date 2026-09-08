# Shared D1 budget audit and earnings lookup fix

Read-only Cloudflare GraphQL inspection on 8 September 2026 identified a shared-account issue outside the new Overview/Breadth batch. The `d1QueriesAdaptiveGroups` dataset ranks existing earnings HTTP reads above the price-page queries. No production D1 table scan or write was performed for this inspection.

| Core database query, 1–8 September | Query-insights executions | Query-insights rows read |
| --- | ---: | ---: |
| Earnings surprise status aggregate | 32 | 670,421,035 |
| Earnings surprise snapshot listing with gap enrichment | 36 | 187,040,520 |
| Earnings gap ticker export | 3 | 5,902,707 |

These adaptive query-insights values are useful for ranking expensive SQL. They do **not** reconcile to the separately aggregated `d1AnalyticsAdaptiveGroups` account totals, and must not be presented as exact billed counts or summed into a quota ledger. The same expensive SQL appears on September 1, 2 and 7, before this audit; it is not attributable to the September 8 inspection. GraphQL does not identify the requesting user. See [Cloudflare D1 metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

The first query comes from `loadEarningsSurprisesStatus` in `worker/src/earnings-surprise-service.ts`; the second comes from `loadEarningsSurprisesSnapshot`. The earnings page calls these on mount and explicit reload, and reloads the snapshot when filters change. They are existing Cloudflare HTTP workflows, not the new GitHub EOD batch. Moving Overview/Breadth work alone would not remove their shared D1 quota impact.

Both use `earningsCatalogEligibilitySql` in `worker/src/earnings-issue-filter.ts`. Its correlated predicate compares `UPPER(catalog_symbol.ticker)` to the earnings ticker. SQLite cannot use the ordinary ticker primary key for this expression and scans the symbols catalog for each candidate earnings event. Existing eligibility semantics include mixed-case matching, active/manual catalog entries, null metadata handling and an empty-active-catalog fallback.

Core migration `0102_earnings_catalog_lookup.sql` adds `symbols(UPPER(ticker))` as a non-unique expression index. It changes no records, filters, result ordering, providers or workflow ownership. The real-SQLite regression checks the full generated eligibility predicate: the plan changes from `SCAN catalog_symbol` to `SEARCH catalog_symbol USING INDEX idx_symbols_upper_ticker (<expr>=?)`, with identical results for the cases above. Replaying the migration is safe.

A local synthetic case with 1,000 earnings rows and 10,000 symbols used approximately 66,531,000 SQLite virtual-machine steps before the index and 35,000 afterward (3.41 seconds versus 0.001 seconds on the audit machine). This establishes the eliminated repeated scan, not a production timing or billing guarantee. Remaining earnings-row scans and gap joins still need measurement after rollout.

Apply the index within the shared write allowance: building it writes roughly one index entry per existing symbol, and subsequent symbol changes maintain that entry. No production migration has been applied by this implementation. After rollout, verify the production query plan and compare authoritative daily account usage with the new indexed-query insights. Preserve other Cloudflare workflows; do not infer account quota headroom from the EOD runner's own counters alone.
