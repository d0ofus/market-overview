import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { expectedEodSession } from "../src/eod-coordinator";
import { loadEodInputs } from "../src/eod-runner";
import { loadStorageMigration, loadStorageMigrationCheckpoint, storageMigrationIdentity } from "../src/market-storage-control";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { loadStorageValidationPlan } from "../src/market-storage-population-plan";
import { loadStorageHistoryIndexAmendment } from "../src/market-storage-history-index-recovery";
import { loadStorageCapacityCaptureReuse } from "../src/market-storage-capacity-execution";
import { createStorageWorkflowQuiescence } from "../src/market-storage-github-revocation";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { verifyStorageExpansionBaseline } from "../src/market-storage-population-expansion";
import { loadStoragePlanConsumerProof } from "../src/market-storage-consumer-composite";
import { promoteStoragePopulationExpansion } from "../src/market-storage-population-promotion";
import { storageHash } from "../src/market-storage-pages";
import { pacedEodRestFetch } from "../src/eod-rest-request-limiter";
import { captureCapacityDatabase } from "./eod-capacity-capture";
import { captureStoragePopulationDelta, runStoragePopulationDeltaProof, loadStorageExpansionHistoryReceipt,
  storeStorageExpansionHistoryReceipt, type StorageExpansionHistoryReceipt } from "./eod-population-expansion-operator";
import type { Env } from "../src/types";
import { prepareStorageExpansionArchiveContext } from "./storage-current-archive-context";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error("storage-expansion-setting-missing"); return value; };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function read(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 8_000_000) throw new Error("storage-expansion-local-artifact-too-large");
  return JSON.parse(text) as unknown;
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function immutableLocal(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  if (existsSync(path)) { if (readFileSync(path, "utf8") !== text) throw new Error("storage-expansion-local-artifact-conflict"); }
  else writeFileSync(path, text, { flag: "wx" });
}

/** Explicit operator command; no cron, provider, publication or binding writes.
 * A complete current archive capture is required. The old local history file
 * used for preliminary sizing cannot substitute for the durable archive proof. */
async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("storage-expansion-command-invalid");
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN"), id = required("EOD_STORAGE_MIGRATION_ID");
  const sourceId = required("EOD_STORAGE_SOURCE_DATABASE_ID"), targetId = required("EOD_STORAGE_TARGET_DATABASE_ID"),
    historyId = required("EOD_HISTORY_DATABASE_ID"), opsId = required("EOD_OPS_DATABASE_ID"), coreId = required("EOD_CORE_DATABASE_ID");
  const expectedPlanHash = required("EOD_STORAGE_PREVIOUS_PLAN_HASH"), sourceSnapshot = resolve(process.env.STORAGE_SNAPSHOT_PATH?.trim() || required("EOD_STORAGE_SNAPSHOT_PATH"));
  const snapshotSource = read(resolve(required("EOD_STORAGE_SNAPSHOT_IDENTITY_PATH"))) as { accountId: string; sourceDatabaseId: string; runId: string };
  const directoryRoot = resolve(required("EOD_STORAGE_EXPANSION_DIRECTORY")), repository = process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  const profile = resolveEodBudgetProfile(required("EOD_BUDGET_PROFILE")), ids = [sourceId, targetId, historyId, opsId, coreId];
  if (new Set(ids).size !== ids.length || !/^[a-f0-9]{64}$/.test(expectedPlanHash) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("storage-expansion-identity-invalid");
  mkdirSync(directoryRoot, { recursive: true });
  const command = (exe: string, args: string[], timeout = 30_000) => {
    try { return execFileSync(exe, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout,
      env: { ...process.env, TMPDIR: directoryRoot, TEMP: directoryRoot, TMP: directoryRoot },
      maxBuffer: 32_000_000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new Error("storage-expansion-control-or-measurement-failed"); }
  };
  const git = (...args: string[]) => command("git", args).trim();
  const gh = (path: string) => object(JSON.parse(command("gh", ["api", path]))) ?? {};
  const codeRevision = git("rev-parse", "HEAD");
  const assertReviewedCheckout = async () => {
    if (!/^[a-f0-9]{40}$/.test(codeRevision) || git("rev-parse", "HEAD") !== codeRevision || git("branch", "--show-current") !== "main"
      || git("status", "--porcelain") || object(gh(`repos/${repository}/git/ref/heads/main`).object)?.sha !== codeRevision) {
      throw new Error("storage-expansion-clean-pushed-main-required");
    }
  };
  await assertReviewedCheckout();
  const rawOps = createEodD1Database({ accountId, token, databaseId: opsId, allowedDatabaseIds: ids });
  const admission = createEodAdmission(rawOps, `population-expansion:${id}`, { profile, writeCredit: 200,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ accountId,
      token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps, profile }) });
  const db = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds: ids, admission });
  const ops = db(opsId), source = db(sourceId), target = db(targetId), history = db(historyId);
  const env: Env = { DB: db(coreId), MARKET_DATA_DB: target, MARKET_HISTORY_DB: history, OPS_DB: ops,
    EOD_CODE_REVISION: codeRevision, EOD_BUDGET_PROFILE: profile.name, EOD_RUNNER_MODE: "active",
    EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "false", ALPACA_DAILY_FEED: "sip" };
  try {
    const run = await loadStorageMigration(ops, id);
    if (!run || run.source_database_id !== sourceId || run.target_database_id !== targetId || run.history_database_id !== historyId) throw new Error("storage-expansion-migration-identity-conflict");
    await assertStorageExecutionRevision(ops, run, codeRevision);
    const vars = gh(`repos/${repository}/environments/market-eod/variables?per_page=100`);
    if (!Array.isArray(vars.variables) || vars.total_count !== vars.variables.length) throw new Error("storage-expansion-github-variables-incomplete");
    const variable = new Map(vars.variables.map(value => { const row = object(value); return [String(row?.name), String(row?.value)]; }));
    for (const [name, value] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: accountId, EOD_STORAGE_CODE_REVISION: run.code_revision,
      EOD_STORAGE_EXECUTION_REVISION: codeRevision, EOD_STORAGE_SOURCE_DATABASE_ID: sourceId, EOD_STORAGE_TARGET_DATABASE_ID: targetId,
      EOD_HISTORY_DATABASE_ID: historyId, EOD_OPS_DATABASE_ID: opsId, EOD_CORE_DATABASE_ID: coreId, EOD_BUDGET_PROFILE: profile.name })) {
      if (variable.get(name) !== value) throw new Error("storage-expansion-github-identity-conflict");
    }
    const previous = await loadStorageValidationPlan(ops, run);
    const capacityReuse = await loadStorageCapacityCaptureReuse(ops, run, previous);
    // A lost promotion response is recoverable without creating another delta.
    if (previous.predecessorPlanHash === expectedPlanHash && previous.populationExpansionHash) {
      const proof = await loadStoragePlanConsumerProof(ops, run, previous);
      if (proof.version !== 2) throw new Error("storage-expansion-replay-composite-required");
      const sizingText = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
        .bind(`storage-population-sizing:${previous.planHash}`).first<string>("evidence_json");
      if (!sizingText) throw new Error("storage-expansion-replay-sizing-required");
      const sizing = JSON.parse(sizingText) as { prepared: Awaited<ReturnType<typeof prepareStoragePreflight>> };
      const denyNewWork = async (): Promise<never> => { throw new Error("storage-expansion-replay-receipt-required"); };
      const replay = await promoteStoragePopulationExpansion({ env, source, migrationId: id, expectedPlanHash,
        deltaCapture: proof.delta.capture, deltaEvidence: proof.delta.evidence, preparedSizing: sizing.prepared,
        assertReviewedCheckout, assertNoWorkflowWriters: denyNewWork, assertDeltaCapture: denyNewWork, measurePhysical: denyNewWork });
      if (replay.status !== "already-promoted") throw new Error("storage-expansion-replay-receipt-required");
      const nextInputsHash = await storageHash(previous.inputs), directory = resolve(directoryRoot,
        `${expectedPlanHash}-${nextInputsHash}-${proof.delta.capture.captureHash}`);
      const receipt = capacityReuse?.receipt ?? await loadStorageExpansionHistoryReceipt(ops, { migrationId: id, codeRevision, previousPlanHash: expectedPlanHash,
        nextInputsHash, captureHash: proof.delta.capture.captureHash, historyDatabaseId: historyId });
      if (capacityReuse && (capacityReuse.continuation.planHash!==expectedPlanHash||capacityReuse.continuation.nextInputsHash!==nextInputsHash
        ||capacityReuse.continuation.capture.captureHash!==proof.delta.capture.captureHash)) throw new Error("storage-expansion-capacity-reuse-conflict");
      if (!receipt || (!capacityReuse && receipt.directory !== directory) || await fileHash(resolve(receipt.directory, receipt.file)) !== receipt.fileHash) {
        throw new Error("storage-expansion-replay-history-artifact-required");
      }
      console.log(JSON.stringify({ status: "population-expansion-already-approved", planHash: previous.planHash,
        expansionHash: previous.populationExpansionHash, tickerCount: previous.tickers.length, consumerProofHash: proof.evidenceHash,
        promotionReceiptHash: replay.receipt.evidenceHash, historyReceiptHash: receipt.evidenceHash,
        historySnapshotPath: resolve(receipt.directory, receipt.file), historySnapshotHash: receipt.fileHash, historyCaptureDate: receipt.capturedAt,
        analysisPath: resolve(directory, "storage-analysis.json"), productionAcceptance: false })); return;
    }
    if (previous.planHash !== expectedPlanHash) throw new Error("storage-expansion-selected-plan-changed");
    if (run.status !== "awaiting-evidence" || run.stage !== "bootstrap" || run.error_code !== "storage-population-expansion-required"
      || run.lease_token !== null || run.lease_until !== null || run.dispatch_token !== null) throw new Error("storage-expansion-completed-population-pause-required");
    const quiescence = createStorageWorkflowQuiescence({ ops, repository, migration: storageMigrationIdentity(run),
      fromRevision: codeRevision, codeRevision, readGitHub: async path => gh(path), assertRevokedRunClaimFence: async () => {
        const runner = command("git", ["show", `${codeRevision}:worker/scripts/market-storage-runner.ts`]);
        const control = command("git", ["show", `${codeRevision}:worker/src/market-storage-control.ts`]);
        if (!runner.includes("await assertStorageExecutionRevision(meteredOps,existing,codeRevision)")
          || !control.includes("storageGitHubRevocationKey(options.githubRunId)")
          || !control.includes("AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?))")) throw new Error("storage-expansion-revoked-run-fence-required");
      } });
    const assertNoWorkflowWriters = async () => {
      await quiescence();
      const stamp = new Date().toISOString();
      if (await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
        OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
          OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))` ).bind(stamp, stamp).first()) throw new Error("storage-expansion-writer-present");
      const owner = await loadStorageMigrationCheckpoint(ops, id, "bootstrap:owner");
      const complete = await loadStorageMigrationCheckpoint(ops, id, "bootstrap:complete");
      if (!owner || owner.inputHash !== expectedPlanHash
        || await storageHash(owner.payload) !== await storageHash({ runId: `eod:active:${previous.sessionDate}:daily`, sessionDate: previous.sessionDate, targetDatabaseId: targetId })
        || (complete && (complete.inputHash !== expectedPlanHash || await storageHash(owner.payload) !== await storageHash(complete.payload)))) throw new Error("storage-expansion-completed-bootstrap-required");
      const row = await ops.prepare("SELECT status,lease_token,lease_until,dispatch_token,input_json FROM eod_runs WHERE id=?")
        .bind(`eod:active:${previous.sessionDate}:daily`).first<{ status: string; lease_token: string | null; lease_until: string | null; dispatch_token: string | null; input_json: string }>();
      if (!row || row.status !== "completed" || row.lease_token !== null || row.lease_until !== null || row.dispatch_token !== null
        || await storageHash(JSON.parse(row.input_json)) !== await storageHash(previous.inputs)) throw new Error("storage-expansion-completed-run-required");
    };
    await assertNoWorkflowWriters();
    const session = await expectedEodSession(env);
    if (!session || session <= previous.sessionDate) throw new Error("storage-expansion-later-session-required");
    const nextInputs = await loadEodInputs(env, session), nextHash = await storageHash(nextInputs), oldSet = new Set(previous.tickers);
    const addedTickers = nextInputs.tickers.filter(ticker => !oldSet.has(ticker)).sort();
    if (!addedTickers.length || addedTickers.length > 100 || previous.tickers.some(ticker => !nextInputs.tickers.includes(ticker))
      || await storageHash(nextInputs.config) !== await storageHash(previous.inputs.config)) throw new Error("storage-expansion-append-only-population-required");
    const amendment = await loadStorageHistoryIndexAmendment(ops, run, previous);
    if (!amendment) throw new Error("storage-expansion-history-amendment-required");
    const captureInput = { source, target, history, run, previousPlan: previous, amendment };
    const captured = await captureStoragePopulationDelta(captureInput);
    if (capacityReuse && (capacityReuse.continuation.planHash!==previous.planHash||capacityReuse.continuation.nextInputsHash!==nextHash
      ||capacityReuse.continuation.inputClock!==captured.inputClock
      ||await storageHash(capacityReuse.continuation.capture)!==await storageHash(captured.capture))) throw new Error("storage-expansion-capacity-reuse-changed");
    const assertDeltaCapture = async () => {
      if (await storageHash(await captureStoragePopulationDelta(captureInput)) !== await storageHash(captured)) throw new Error("storage-expansion-capture-changed");
    };
    const assertCurrent = async () => {
      await assertReviewedCheckout(); await assertNoWorkflowWriters(); await assertDeltaCapture();
      if (await expectedEodSession(env) !== session || await storageHash(await loadEodInputs(env, session)) !== nextHash) throw new Error("storage-expansion-current-inputs-changed");
    };
    const baseline = await verifyStorageExpansionBaseline(ops, run, addedTickers);
    const directory = resolve(directoryRoot, `${expectedPlanHash}-${nextHash}-${captured.capture.captureHash}`);
    mkdirSync(directory, { recursive: true });
    immutableLocal(resolve(directory, "selection.json"), { version: 1, migrationId: id, codeRevision, previousPlanHash: expectedPlanHash,
      sessionDate: session, nextInputsHash: nextHash, tickers: [...nextInputs.tickers].sort(), addedTickers, captured });
    const delta = capacityReuse ? {complete:true,evidence:capacityReuse.delta.evidence} : await runStoragePopulationDeltaProof({ ops, run, previousPlan: previous, nextInputsHash: nextHash,
      sourceEnv: { ...env, DB: source, MARKET_DATA_DB: source, MARKET_HISTORY_DB: undefined }, targetEnv: env,
      capture: captured.capture, addedTickers, assertCapture: assertDeltaCapture, assertQuiescence: assertNoWorkflowWriters });
    if (!delta.complete || !delta.evidence) throw new Error("storage-expansion-delta-incomplete");
    console.log(JSON.stringify({ status: "delta-readers-verified", addedTickers: addedTickers.length, inheritedTickers: previous.tickers.length,
      baselinePointers: baseline.pointerRows, baselineBlocks: baseline.blockRows, baselineHash: baseline.baselineHash,
      deltaEvidenceHash: delta.evidence.evidenceHash, actualMissingSourceHistories: delta.evidence.history.missing }));
    const receiptPath = resolve(directory, "history-capture.json");
    const historyIdentity = { migrationId: id, codeRevision, previousPlanHash: expectedPlanHash,
      nextInputsHash: nextHash, captureHash: captured.capture.captureHash, historyDatabaseId: historyId };
    let historyFile: string, receipt: StorageExpansionHistoryReceipt;
    const savedReceipt = capacityReuse?.receipt ?? await loadStorageExpansionHistoryReceipt(ops, historyIdentity);
    if (savedReceipt) {
      receipt = savedReceipt;
      historyFile = resolve(receipt.directory, receipt.file);
      if ((!capacityReuse && receipt.directory !== directory) || receipt.captureHash !== captured.capture.captureHash
        || await fileHash(historyFile) !== receipt.fileHash) throw new Error("storage-expansion-history-artifact-changed");
      immutableLocal(receiptPath, receipt);
      await assertCurrent();
    } else {
      // Incomplete captures are retained for diagnosis. A bounded new attempt
      // starts afresh; this does not claim byte-level snapshot resumption.
      const attempt = [1, 2, 3, 4].find(value => !existsSync(resolve(directory, `history-${value}.sqlite`)));
      if (!attempt) throw new Error("storage-expansion-history-capture-attempts-exhausted");
      historyFile = resolve(directory, `history-${attempt}.sqlite`);
      await assertCurrent();
      const result = await captureCapacityDatabase({ db: history, kind: "history", file: historyFile, assertCurrent: assertDeltaCapture,
        progress: async value => { console.log(JSON.stringify({ status: "capturing-current-history", table: value.table, rows: value.rows })); } });
      await assertCurrent();
      receipt = await storeStorageExpansionHistoryReceipt(ops, historyIdentity, { directory, file: `history-${attempt}.sqlite`, ...result,
        fileHash: await fileHash(historyFile), capturedAt: new Date().toISOString() });
      immutableLocal(receiptPath, receipt);
    }
    const tickerPath = resolve(directory, "tickers.json"), analysisPath = resolve(directory, "storage-analysis.json"), sizingPath = resolve(directory, "prepared-sizing.json");
    immutableLocal(tickerPath, { tickers: [...nextInputs.tickers].sort() });
    const currentArchive=await prepareStorageExpansionArchiveContext({ops,target,run,plan:previous,inputs:nextInputs,historyFile,sourceFile:sourceSnapshot,temporaryRoot:directoryRoot});
    const archiveContextPath=resolve(directory,"current-archive-context.json");
    if(currentArchive)immutableLocal(archiveContextPath,currentArchive);
    if (!existsSync(analysisPath)) {
      await assertCurrent();
      command("python", [resolve(root, "worker/scripts/analyze-eod-storage.py"), "--source-sqlite", sourceSnapshot,
        "--history-sqlite", historyFile, "--tickers-json", tickerPath, "--session-date", run.session_date,
        ...(currentArchive?["--current-archive-context-json",archiveContextPath]:[]), "--output", analysisPath], 45 * 60_000);
      await assertCurrent();
    }
    const analysis = read(analysisPath), copy = (await loadStorageMigrationCheckpoint(ops, id, "verification:complete"))?.payload as { prices?: { sourceRows?: number } };
    if (object(object(analysis)?.source)?.snapshotSha256 !== previous.sourceSnapshotHash
      || (currentArchive ? object(object(analysis)?.archive)?.verifiedCopySourceRows !== copy?.prices?.sourceRows
        || await storageHash(object(object(object(analysis)?.archive)?.currentArchiveForecast)?.context)!==await storageHash(currentArchive)
        : object(object(analysis)?.archive)?.sourceRows !== copy?.prices?.sourceRows)) throw new Error("storage-expansion-original-source-model-mismatch");
    let preparedSizing = await prepareStoragePreflight({ analysis, identity: storageMigrationIdentity(run), tickers: [...nextInputs.tickers].sort(),
      snapshotSource, accountId, sourceSchemaHash: previous.capture.sourceCapture.schemaHash, hotSessions: 90,
      ...(currentArchive?{executionRevision:codeRevision}:{}) });
    if (existsSync(sizingPath)) {
      const saved = read(sizingPath) as typeof preparedSizing;
      if (await storageHash(saved.evidence) !== saved.hash || saved.evidence.analysisHash !== preparedSizing.evidence.analysisHash
        || saved.evidence.sourceSnapshotHash !== previous.sourceSnapshotHash || saved.evidence.tickerHash !== preparedSizing.evidence.tickerHash) throw new Error("storage-expansion-sizing-artifact-changed");
      preparedSizing = saved;
    } else immutableLocal(sizingPath, preparedSizing);
    const measurePhysical = async () => {
      const values: number[] = [];
      for (const databaseId of [targetId, historyId]) {
        const response = await pacedEodRestFetch(accountId, token, fetch, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
          () => ({ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }));
        if (!response.ok) throw new Error("storage-expansion-capacity-read-failed");
        const body = object(await response.json()), result = object(body?.result);
        if (body?.success !== true || result?.uuid !== databaseId || !Number.isSafeInteger(result.file_size) || Number(result.file_size) <= 0) throw new Error("storage-expansion-capacity-identity-invalid");
        values.push(Number(result.file_size));
      }
      return { targetBytes: values[0], historyBytes: values[1], measuredAt: new Date().toISOString() };
    };
    await assertCurrent();
    const result = await promoteStoragePopulationExpansion({ env, source, migrationId: id, expectedPlanHash,
      deltaCapture: captured.capture, deltaEvidence: delta.evidence, preparedSizing, assertReviewedCheckout,
      assertNoWorkflowWriters, assertDeltaCapture, measurePhysical });
    console.log(JSON.stringify({ status: "population-expansion-approved", migrationId: id, previousPlanHash: expectedPlanHash,
      planHash: result.plan.planHash, expansionHash: result.receipt.expansionHash, tickerCount: nextInputs.tickers.length,
      addedTickerCount: addedTickers.length, inheritedProofRedated: false, deltaProofDate: delta.evidence.completedAt,
      historyCaptureDate: receipt.capturedAt, sizingHash: preparedSizing.hash, hotSessions: 90,
      historySnapshotPath: historyFile, historySnapshotHash: receipt.fileHash, analysisPath,
      historyReceiptHash: receipt.evidenceHash, promotionReceiptHash: result.receipt.evidenceHash,
      publicationReserveBytes: preparedSizing.evidence.planningReserveBytes, publicationReserveKind: "explicit-preflight-planning-reserve",
      productionAcceptance: false, remaining: ["new-session-bootstrap", "actual-seven-scope-publications-and-growth", "live-runtime-and-final-capacity"] }));
  } finally { await admission.flush(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(JSON.stringify({ status: "population-expansion-not-approved", reason:
    /^(storage-[a-z-]+|eod-(?:account|rolling|resource|daily|budget|capacity)[a-z-]*)$/.test(message) ? message : "storage-expansion-verification-failed" }));
  process.exitCode = 1;
});
