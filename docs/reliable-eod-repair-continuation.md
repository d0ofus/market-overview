# Incomplete price-repair recovery

The R19 → R20 continuation admits only the reviewed patch descending from
`e1ca6b5579b5faa6c3c80a6a423be34c36ac1903`. It requires the actual released
`awaiting-evidence` / `bootstrap` / `storage-copy-verification-failed` migration
pause and the matching daily run's `adjustment-repair-incomplete` error. A
planned slice, provider timeout, quota pause, active writer or other failure
cannot use this approval.

Approval preserves every existing price, archive block, repair fence, encoded
feature checkpoint, accepted publication, EOD run field and budget counter.
It records the actual failed boundary and pending repair manifest, authenticates
the original copy/consumer/index/sizing evidence, and adds an immutable execution
and plan link. The only mutable references changed are the selected plan,
bootstrap-owner plan hash and execution pin. The owner payload and timestamp
remain unchanged. The complete feature manifest is compared in the same atomic
Ops transaction using bounded parameters and pages.

After the exact patch is tested, committed and pushed to `main`, retain the
existing operator database/account environment and set:

```powershell
$env:EOD_STORAGE_PREVIOUS_EXECUTION_REVISION = "e1ca6b5579b5faa6c3c80a6a423be34c36ac1903"
$env:EOD_STORAGE_PREVIOUS_PLAN_HASH = "<exact current selected plan hash>"
$env:EOD_STORAGE_REPAIR_TICKER = "BNRG"
$env:EOD_BUDGET_PROFILE = "paid"
npx tsx worker/scripts/continue-storage-repair-execution.ts
```

The existing required variables are `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_EOD_D1_TOKEN`, `EOD_STORAGE_MIGRATION_ID`,
`EOD_STORAGE_SOURCE_DATABASE_ID`, `EOD_STORAGE_TARGET_DATABASE_ID`,
`EOD_HISTORY_DATABASE_ID` and `EOD_OPS_DATABASE_ID`. The command requires a clean,
pushed `main` checkout and independently checks GitHub workflow quiescence and
the current execution/database identities. The selected repair ticker must be
in the failed chunk and have an actual pending SIP repair.

After atomic approval, the command pins and verifies GitHub's storage executor,
then queues recovery using the unchanged EOD retry due time. It never rewrites
the EOD failure as a planned yield. A lost response reuses the original immutable
approval; it does not create a new measurement date. Ordinary account admission,
provider budgets and execution leases continue to apply.

The resumed business code quarantines an incomplete security with explicit null
metrics and unavailable catalog evidence. The pending repair and stored bars
remain available for a later coherent repair. Healthy scopes may publish only
through their existing coverage gates. Admission itself publishes nothing.

The lineage loader retains separately dated original consumer proof and supports
a later independently measured population expansion. Final acceptance still
requires current publications, authenticated unavailable evidence, physical
capacity and runtime measurements. This continuation is not a cutover or a
waiver of those checks.
