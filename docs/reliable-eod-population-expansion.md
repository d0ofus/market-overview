# Append-only population recovery

This operator path admits a later, independently verified membership union after the older private bootstrap has completed. It does not recopy the original database or rerun the completed original population's consumer proof. It permits 1–100 additions, zero removals, unchanged Overview configuration and methodology, five publishable current memberships, and one expansion in this migration lineage. Other changes remain an explicit recovery gate.

The existing reviewed R17→R18 execution approval must run first, at a released bootstrap time slice. The cloud job then finishes the original session. When the next session needs a larger union, the pipeline records `storage-population-expansion-required` and releases its lease. The operator requires that exact pause, the completed old `eod_runs` row, its matching owner, and all seven accepted old publications. `bootstrap:complete` can legitimately be absent at this rollover boundary.

Run the following from a clean, reviewed and pushed `main` checkout:

```powershell
npx tsx worker/scripts/expand-storage-population.ts
```

Required environment values:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Exact account containing the approved migration |
| `CLOUDFLARE_EOD_D1_TOKEN` | Server-side credential for the existing admitted D1 adapter |
| `CLOUDFLARE_EOD_ANALYTICS_TOKEN` | Optional separate analytics credential; otherwise use the D1 token |
| `EOD_BUDGET_PROFILE` | The actual account profile; existing daily and rolling limits remain enforced |
| `EOD_STORAGE_MIGRATION_ID` | Existing immutable migration ID |
| `EOD_STORAGE_SOURCE_DATABASE_ID` | Original frozen source |
| `EOD_STORAGE_TARGET_DATABASE_ID` | Private populated target |
| `EOD_HISTORY_DATABASE_ID` | Actual live archive |
| `EOD_OPS_DATABASE_ID` | Actual control database |
| `EOD_CORE_DATABASE_ID` | Actual catalog/configuration database |
| `EOD_STORAGE_PREVIOUS_PLAN_HASH` | Exact selected plan before expansion |
| `STORAGE_SNAPSHOT_PATH` | Original source SQLite capacity-model input; `EOD_STORAGE_SNAPSHOT_PATH` is also accepted |
| `EOD_STORAGE_SNAPSHOT_IDENTITY_PATH` | Original source snapshot account/database/run identity JSON |
| `EOD_STORAGE_EXPANSION_DIRECTORY` | Private local scratch directory with sufficient room for archive capture and both full SQLite models |
| `EOD_GITHUB_REPOSITORY` | Optional repository override; defaults to `d0ofus/market-overview` |

All five database IDs and the execution revision are checked against durable records and the GitHub `market-eod` environment. The CLI checks all potentially active workflow writers, including the existing exact-run revocation protocol. It does not disable workflows, dispatch jobs, fetch provider prices, release fences, change bindings or write application data. Its remote writes are admission accounting, new immutable operator evidence, and the guarded final plan/pause transition.

The operator performs these checks:

1. Read the actual current union from Core and target membership versions. Retain the original logical population and calculate only the added set.
2. Authenticate the original history baseline's complete block and pointer checkpoint chains against the whole-copy proof. An added ticker present anywhere in that original archive requires a different independently captured reference; this path refuses it.
3. Observe original source freeze and actual current target/history schemas, guards, revisions and input clock. Run all ten unchanged historical reader contracts for the additions against the frozen source and current target/archive, using the original historical calendar. Missing source histories remain explicitly missing.
4. Persist immutable delta pages in Ops. A retry resumes their exact hashes and original completion date if the capture and current input identity are unchanged. It never rewrites the original consumer proof or its dates.
5. Capture the complete current archive, including unpointed immutable revisions and both pointer foreign-key indexes, into a new private local SQLite file. The older local history file is not accepted as this capture. The original source SQLite file remains a historical capacity-model input: its modeled hash and source row count must match the selected plan and independently verified whole-copy evidence. It is never relabelled a frozen production snapshot.
6. Run the real SQLite capacity oracle over the full new population, retaining 90 hot sessions and the existing archive layout. Require live target/history sizes to fit the separately measured projections and the 350 MB storage limits. The explicit 64 MB publication planning reserve is provisional capacity headroom, not a claim that the expanded session has already published.
7. Promote the new plan and composite consumer evidence in the guarded Ops transaction. The old owner, run, feature checkpoints and accepted publication bytes remain unchanged. The existing pipeline subsequently archives that completed owner and claims the later session.

Local artifacts are scoped to the prior plan, exact next inputs and current capture hash. `selection.json`, immutable delta evidence in Ops, `history-capture.json`, `storage-analysis.json` and `prepared-sizing.json` expose what was actually checked. The history receipt is also immutable in Ops and binds the migration, execution, previous plan, current inputs, actual capture and local file SHA. An unbacked local receipt cannot substitute. History capture is a bounded restart rather than byte-level resumption: interrupted partial files are retained, and at most four fresh local capture files are allocated for that unchanged selection. Quota exhaustion stops admission; retry after the recorded quota reset, without raising limits or repeatedly retrying an exhausted allowance. A changed capture receives new separately dated evidence.

After authenticated promotion or its read-only lost-acknowledgement replay, use the returned `historySnapshotPath`, `historySnapshotHash`, `historyReceiptHash` and capture date for the local controller handoff. Verify the file SHA against the stored capture receipt, then update only `historySnapshotPath` in the ignored `worker/tmp/storage-recovery-config.json`. Keep the original source snapshot and identity paths. The final analyzer must use this verified current-history input; it does not discover the new path automatically. If the ignored local controller status remains paused, archive that diagnostic only after its code revision matches the reviewed expansion executor and its exact blocker is `storage-population-expansion-required`; preserve unrelated pauses. The durable promotion and the existing pipeline control the next run. Do not clear or replace migration, EOD or publication records to resume the controller.

The success response remains `productionAcceptance: false`. After the expanded session's writer completes, the ordinary final acceptance must verify its actual seven publications, actual publication growth, current measured database sizes, runtime telemetry and account budgets. The inherited reader proof retains its original date, the delta proof retains its actual later date, and neither is advertised as fresh verification of the entire old population.
