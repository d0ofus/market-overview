# Automatic capacity renewal

The production capacity approval has a finite forecast. Its daily physical-size sample does not extend that forecast or make a changed shared ticker population valid. `eod-storage-capacity-renewal.yml` runs independently of price ingestion and uses the same `market-eod-writer` concurrency group.

The runner checks the actual last closed New York exchange session, including holidays, early closes and daylight saving. It measures again when five or fewer forecast sessions remain, when the forecast has expired, or when the configured Overview, verified breadth memberships and active catalog change the combined population. Until public activation and an approved production revision exist, the workflow remains inactive. A successful no-op does not refresh the original measurement date.

Run the same operation manually with the workflow's **Run workflow** action. Its command is:

```powershell
node --import tsx worker/scripts/renew-eod-storage-capacity.ts
```

The workflow supplies the production code pin, canonical market/history/Ops/core database IDs, paid or free budget profile and existing D1/analytics secrets. No Alpaca key, production admin secret, new database or deployment permission is needed. The checkout must match the approved production pin and remain clean. Renewal cannot approve a different application revision, change the 90-session layout, enable pruning or deploy a Worker.

Each measurement follows these steps:

1. Claim a durable Ops lease; resolve current inputs and the exact completed, accepted seven-scope publication set. A changed population must first have matching accepted publications.
2. Verify the market and archive write guards and record their monotonic revisions, the price input clock and current population hash. Read the complete reviewed schemas and data through bounded, admitted D1 requests into temporary SQLite files. Preserve every retained archive revision, orphan and instrument. No production table is frozen, deleted or rewritten.
3. Construct a separate full-history SQLite reference by decoding pointed immutable blocks directly and overlaying canonical hot observations. Run all ten actual reader/output contracts over the full population, including MAX, 520 OHLCV, 1,330 closes, coverage, scans and both pages. Gaps and missing members remain present. The reference does not use the reader under test to construct its expected rows.
4. Use the existing real-schema Python measurement tools to populate both hot-layout models and measure actual accepted-publication growth. The selected layout remains 90 sessions with at least ten sweep sessions, the bounded Yahoo archive reserve and a new 20-session publication forecast. Both databases must retain the existing strict 350 MB headroom gate.
5. Recheck current physical sizes, input clock, full population and schemas. Every query and control write remains subject to the configured account-wide and EOD budgets. Store a new immutable proof, verify its readback and promote the small Ops approval pointer through an ownership/previous-proof CAS. Sample current capacity before reporting completion.

The new proof records the actual capture, full-population reader evidence and measurement dates. It links the prior immutable proof and its original dated reader evidence. It does not edit or redate migration acceptance or code approval.

Admin capacity status exposes the renewal stage, last update, sanitized failure and retry eligibility. The full progress record is `history-capacity-renewal:<production SHA>` in Ops. An expired running lease is reported as interrupted; a committed approval with a lost final response is recognized on retry. Quota failures become eligible after the next UTC reset; other failures have a bounded cooldown and wait for a scheduled or manual opportunity. The old accepted proof stays available, but expired or mismatched capacity continues to block pruning.

Temporary SQLite files are measurement inputs, not production history. They are not uploaded to Actions artifacts or cache. Durable leases, phases, counts and hashes survive a runner interruption; the next attempt recaptures the data rather than resuming an unavailable local file. A changing capture is rejected, and uncoordinated ancillary writes to the market database can require another attempt. The entire attempt is bounded to 70 minutes and must be measured on the actual populated deployment; repeated time or quota failures remain visible and require reducing admitted capture cost or adjusting the execution window. Moving computation to GitHub does not remove D1 quotas.
