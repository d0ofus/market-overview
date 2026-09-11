# Optional listing evidence and the existing bootstrap

The R18 → R19 code continuation is restricted to the reviewed R18 commit `bf65b3c86430ebf904cdc905fb9ccd2a0d492997` and the exact reviewed listing implementation. It accepts only a released, due `storage-run-time-slice-complete` boundary in the private bootstrap's prices or publication stage. Provider failures, quota deferrals, incomplete publications, active writers and an existing `listingEvidence` property are rejected.

The continuation keeps the frozen daily inputs, full EOD run row, every encoded feature checkpoint, accepted publications, price/history rows, provider counters and accounting state unchanged. It records a new immutable code/plan link and changes the bootstrap owner's plan-hash reference; the owner payload and timestamp, original consumer proof, source capture, index amendment and sizing measurement dates are preserved. A paged comparison checks every feature checkpoint in the same atomic approval transaction under D1's parameter and payload limits. A lost response reuses the original approved record.

After reviewing, testing, committing and pushing the exact patch to `main`, use the existing operator environment with these required values:

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EOD_D1_TOKEN`, and `EOD_BUDGET_PROFILE=paid`.
- `EOD_STORAGE_MIGRATION_ID`, `EOD_STORAGE_SOURCE_DATABASE_ID`, `EOD_STORAGE_TARGET_DATABASE_ID`, `EOD_HISTORY_DATABASE_ID`, and `EOD_OPS_DATABASE_ID`.
- `EOD_STORAGE_PREVIOUS_EXECUTION_REVISION=bf65b3c86430ebf904cdc905fb9ccd2a0d492997` and the exact current `EOD_STORAGE_PREVIOUS_PLAN_HASH`.

Run `npx tsx worker/scripts/continue-storage-listing-execution.ts` from the clean, pushed `main` checkout after the workflow stops at the planned boundary. The CLI independently verifies GitHub main, ancestry, database identities, the stored execution, reviewed source hashes, and workflow quiescence. It pins GitHub's storage executor only after atomic approval, verifies that pin, then restores the original migration retry timestamp. The ordinary EOD daily and rolling account reservations remain in force. No source copy or consumer parity is rerun by code approval.

Register listing evidence separately with its actual verification date and eligible session. A record first known on September 11 must not appear in September 10's frozen input. Register future-session evidence only when no affected unfinished run owns it; the completed September 10 row and its input clock remain unchanged. The independently measured September 11 population expansion can then freeze the new evidence alongside actual current membership. The inherited 6,319-symbol consumer proof remains separately dated; new members still require their own reader parity and full-population sizing.

The same reviewed patch corrects the runtime candidate's readiness predicate to match the real control record: `status=awaiting-evidence`, `stage=bootstrap`, and `error_code=storage-final-acceptance-required`. Other bootstrap pauses remain ineligible. This does not change a stored migration stage or grant publication approval.

The code continuation is not production acceptance. Final acceptance still requires the current session's accepted publications, measured current archive/publication capacity, runtime evidence, and all existing technical checks.
