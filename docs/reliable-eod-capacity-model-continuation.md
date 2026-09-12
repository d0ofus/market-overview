# Completed-owner capacity model continuation

This command is a narrowly reviewed executor change after a completed private bootstrap reaches an append-only population expansion pause. It does not approve new capacity or start ingestion.

The predecessor is `e52602a8a610711bff18426793b54623aadfdffa`. The actual legacy analyzer output must exceed the unchanged 350 MB archive bound using its original `2 × measured archive + 4 MiB` formula. Missing, incomplete, modified, future-dated or otherwise failed artifacts do not authorize this transition.

Run `npx tsx worker/scripts/continue-storage-capacity-execution.ts` only from the reviewed, clean, pushed `main` checkout. In addition to the existing Paid account, source, target, history and Ops settings, supply:

- `EOD_CORE_DATABASE_ID` for current frozen input validation.
- `EOD_STORAGE_PREVIOUS_EXECUTION_REVISION` with the exact predecessor above.
- `EOD_STORAGE_PREVIOUS_PLAN_HASH` with the actually selected completed-owner plan.
- `EOD_STORAGE_FAILED_ANALYSIS_PATH` pointing to the original receipt directory's `storage-analysis.json`.
- `EOD_STORAGE_SNAPSHOT_PATH` pointing to the original local capacity-estimate snapshot. This file is not the durable frozen-copy proof.

The earlier local capacity snapshot has its own row count and hash; the later independently verified frozen copy has its own row count and capture. The actual 618-row difference is retained explicitly rather than treated as data loss or silently overwritten.

The command authenticates the original archive receipt and file checksum, complete delta reader pages, immutable source capture, current target/history revisions and input clock, current next-session inputs, seven accepted publications, and the completed EOD row. It also requires GitHub workflow quiescence, no live database writer, and ordinary Paid/account admission. It never clears provider, quota, repair or retry state.

One bounded atomic Ops batch inserts a new execution approval, explicit continuation, plan wrapper and inherited sizing wrapper. It changes only the selected plan, executor pin and bootstrap owner's control input hash. The original owner and `bootstrap-history:<session>` record are retained in full in the immutable continuation, including their original payloads and timestamps. The ordinary later rollover may update its history control reference; this does not imply that old prices or reader proofs were produced by the new executor.

After verifying the GitHub execution pin, the command restores `awaiting-evidence / bootstrap / storage-population-expansion-required`. The corrected analyzer must still produce new measured capacity evidence and the existing population promotion must still pass. A failing replacement forecast leaves the migration paused.

The expansion operator resolves the original archive receipt and completed delta through this authenticated continuation. It reuses their original identities, file, hashes and dates, and writes revised analysis in the new plan's directory. It does not re-transfer the archive, re-run inherited consumer proofs or rewrite old failed analysis.

The replacement forecast is a separately dated report. The original failed full-population 520-session forecast and subsequent diagnostic models remain preserved; none is renamed as the later bounded forecast. The full-population daily 260-session calculation path remains unchanged. Deep-history work shares durable UTC-week admission across automatic maintenance and explicit deep requests, bounded by four unique securities and 2,500 requested or rechecked date observations. Complete 520/1,400-session requests remain deferred when they cannot fit; their depth is not silently shortened. The model must cover those enforced limits, including 1,400-session work for admitted securities and all UTC weeks intersected by its authoritative future-session grid.

After this model is actually accepted, the live archive monitor retains its fixed measured peak and finite horizon. It checks the greater of that approved projection or current physical bytes plus the original failure/transient reserves. Realized growth is counted once; population, retention, input revisions, the 350 MB ceiling and expiry checks remain mandatory. The older cold-source monitor keeps its existing calculation.

The model revision must also supply authenticated current-archive evidence for final acceptance and subsequent capacity renewal. No limit reduction, dropped history, invented current observation or automatic activation is part of this protocol.
