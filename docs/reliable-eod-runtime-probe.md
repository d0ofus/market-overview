# Bounded candidate runtime evidence

The runtime gate uses real Cloudflare invocation CPU and actual D1 statement metadata. A locally edited evidence file, wall time, a GraphQL percentile, or average subrequests per request cannot satisfy it. The deployed version API must match the code revision and **all four** core, recent-price, archive and Ops bindings. Production measurements while `EOD_READ_ENABLED=false` cannot qualify the replacement readers.

The collector reads Cloudflare's [version API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/) and [Workers Logs query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/). The latter currently requires Workers Observability Write permission even for a query. Workers Logs are available on the free plan with a daily event limit and short retention; collect and accept the evidence promptly. Consult the [current Workers Logs limits](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Prepare an isolated candidate

Only measure after the target contains the verified full population and accepted bootstrap publications. Keep the production binding unchanged until the other migration gates pass. Quota exhaustion defers probes too: their requests, counter and evidence writes use the shared EOD admission ledger.

Create `worker/tmp/runtime-candidate.toml` from the reviewed `worker/wrangler.toml`. Change `name` to a distinct candidate Worker name, and set `main = "../src/index.ts"`. Remove **all** `queues` tables, `triggers` tables, production routes and email routes. Keep the reviewed database bindings and other runtime settings, replacing only `MARKET_DATA_DB` with the verified target database ID/name. Confirm `MARKET_HISTORY_DB`, `OPS_DB` and `DB` IDs against the migration and production configuration. When a copied config is located in `tmp`, remove migration-directory fields (this candidate does not run migrations), or correct their relative paths before deploying.

Add to its existing `[vars]` table:

```toml
EOD_RUNTIME_CANDIDATE_ONLY = "true"
EOD_RUNTIME_PROBE_ID = "unique-bounded-probe-id"
EOD_RUNTIME_PROBE_UNTIL = "<UTC ISO timestamp within the next 24 hours>"
EOD_RUNTIME_TARGET_DATABASE_ID = "<verified target UUID>"
EOD_CODE_REVISION = "<exact committed 40-character Git SHA>"
EOD_READ_ENABLED = "true"
ADMIN_AUTH_FAIL_CLOSED = "true"
```

Keep the intended EOD coordinator mode/settings; do not disable its body to obtain a small CPU number. Add top-level tables:

```toml
[version_metadata]
binding = "EOD_VERSION_METADATA"

[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = true
```

Review the generated file and run `npx wrangler deploy --dry-run --config tmp/runtime-candidate.toml` from `worker`. Deploy that distinct Worker with the same command without `--dry-run`; install its `ADMIN_SECRET` through `wrangler secret put ADMIN_SECRET --config tmp/runtime-candidate.toml`. Supply any approved coordinator/provider secrets through the secret interface. Do not place secrets in the config or command arguments.

The candidate rejects every unapproved fetch, even after expiry. Scheduled and email handlers are inert in candidate-only mode; queue messages fail closed without acknowledgment, which is why queue bindings **must** be omitted. Normal production behavior is unchanged when the candidate flag is absent.

## Execute and collect

Record the candidate deployment's actual version UUID. Set a start timestamp immediately before the samples and an end timestamp after completion. Send two or more authenticated GET requests to each exact path, with no query string:

- `/api/dashboard` (default complete Overview).
- `/api/breadth/dashboard` (default 120-session history).

Send at least one authenticated POST to `/api/admin/eod/runtime-probe/coordinator`. This invokes the actual EOD coordinator at the current time, including its durable work scheduling; it does not accept an arbitrary job or simulated timestamp. Choose an actual EOD update/recovery window with representative outstanding work, not an idle time used to evade the workload. It is an HTTP-triggered measurement of the coordinator body; it does not claim to measure the entire unrelated scheduled-job lane.

Every request needs both `Authorization: Bearer <candidate ADMIN_SECRET>` and `x-eod-runtime-probe: <probe ID>`. There are at most **24 admitted samples** per probe/version configuration, shared across routes. Changing an existing probe's identity conflicts rather than resetting its counter; use a new ID for a new reviewed measurement. The final structured log includes observation overhead, quota control, and telemetry writes. The stored Ops sample deliberately remains `complete:false` because the INSERT cannot store its own eventual duration. Only the final log plus the runtime invocation event supplies complete measurement.

In the collector shell set the following environment variables (credentials must already be secret environment values):

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
EOD_RUNTIME_PROBE_ID
EOD_RUNTIME_WORKER_NAME
EOD_RUNTIME_WORKER_VERSION
EOD_CODE_REVISION
EOD_RUNTIME_TARGET_DATABASE_ID
EOD_RUNTIME_HISTORY_DATABASE_ID
EOD_RUNTIME_OPS_DATABASE_ID
EOD_RUNTIME_CORE_DATABASE_ID
EOD_RUNTIME_FROM                 # ISO UTC beginning of the sample window
EOD_RUNTIME_TO                   # ISO UTC end of the sample window
EOD_RUNTIME_EVIDENCE_PATH        # new local JSON file; never overwrite an artifact
```

Run from `worker`:

```powershell
npx tsx scripts/eod-runtime-collector.ts
```

The collector makes two bounded control-plane requests and no D1 queries. It retrieves at most 2,000 raw log events. Missing count metadata, truncation, missing CPU, failed invocations, incompatible version/bindings, incomplete D1 metadata or missing route coverage leave the gate incomplete; narrow the window and collect again after log delivery. It never infers an absent coordinator CPU as zero. It only writes sanitized samples and measurements, never raw logs, SQL, parameters, returned prices, request headers or credentials.

Acceptance must call `collectRuntimeEvidence` against the authenticated Cloudflare API for the saved identity/window, then `validateRuntimeEvidence` and compare those measurements with the cutover proof. The standalone artifact is reviewable output, not a trusted attestation. Bind the resulting evidence hash and version to the accepted migration proof. Remove or expire the probe after collection; do not enable probes on routine public page traffic.
