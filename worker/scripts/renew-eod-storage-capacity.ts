/** Automated physical capacity renewal only. No provider requests, production
 * price writes, source freeze, pruning, code approval or Worker deployment. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { resolveEodRunnerCodeRevision } from "../src/eod-runner-revision";
import { loadEodInputs } from "../src/eod-runner";
import { assertEodCutover } from "../src/eod-rollout-service";
import { loadStorageHistoryMaintenanceApproval, refreshStorageHistoryMaintenanceEvidence } from "../src/eod-storage-history-capacity";
import { inspectStorageCapacityRenewal, captureStorageCapacityInputs, assertStorageCapacityCapture, assertStorageCapacityRevisions,
  claimStorageCapacityRenewal, progressStorageCapacityRenewal, finishStorageCapacityRenewal,
  storeRenewedStorageHistoryMaintenanceApproval, loadStorageCapacityRenewalStatus, type StorageCapacityRenewalStatus } from "../src/eod-storage-capacity-renewal";
import { verifyStorageAcceptedPublications, collectStoragePublicationGrowthSamples, verifyStorageConsumerBatch,
  storagePublicationGrowthReserve, validateStorageCapacityAnalysis, type StorageConsumerCheckpoint, type StorageConsumerEvidence,
  type StorageAcceptanceCapture } from "../src/market-storage-acceptance";
import { eodHash } from "../src/eod-publication-service";
import { classifyStorageFailure } from "../src/market-storage-failure";
import { captureCapacityDatabase, flattenCapacityHistory } from "./eod-capacity-capture";
import { createCapacityLocalSqlite } from "./eod-capacity-local-sqlite";
import type { Env } from "../src/types";

const required = (name: string): string => { const value = process.env[name]?.trim(); if (!value) throw new Error(`eod-capacity-renewal-missing-${name.toLowerCase().replaceAll("_", "-")}`); return value; };
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
async function main(): Promise<void> {
  const codeRevision = resolveEodRunnerCodeRevision({ actualRevision: git("rev-parse", "HEAD"), productionRevision: required("EOD_PRODUCTION_CODE_REVISION"),
    codeRevision: process.env.EOD_CODE_REVISION, githubSha: process.env.GITHUB_SHA });
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("eod-capacity-renewal-clean-checkout-required");
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN");
  const core = required("EOD_CORE_DATABASE_ID"), market = required("EOD_MARKET_DATABASE_ID"), history = required("EOD_HISTORY_DATABASE_ID"), ops = required("EOD_OPS_DATABASE_ID");
  const allowedDatabaseIds = [core, market, history, ops];
  if (new Set(allowedDatabaseIds).size !== 4) throw new Error("eod-capacity-renewal-database-identity-conflict");
  const profile = resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE);
  const rawOps = createEodD1Database({ accountId, token, databaseId: ops, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `history-capacity-renewal:${codeRevision}`, { profile, writeCredit: 200,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ profile, accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps }) });
  const db = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds, admission });
  const env: Env = { DB: db(core), MARKET_DATA_DB: db(market), MARKET_HISTORY_DB: db(history), OPS_DB: db(ops),
    EOD_RUNNER_MODE: process.env.EOD_RUNNER_MODE === "active" ? "active" : "shadow", EOD_READ_ENABLED: "true",
    EOD_CODE_REVISION: codeRevision, EOD_BUDGET_PROFILE: profile.name, ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" };
  let status: StorageCapacityRenewalStatus | null = null, directory: string | null = null;
  const deadline = Date.now() + 70 * 60_000;
  const assertDeadline = () => { if (Date.now() >= deadline) throw new Error("eod-capacity-renewal-time-slice-exhausted"); };
  // Reserve a final admitted diagnostic write while there is quota. Exhaustion
  // must not erase the visible reason or encourage repeated quota retries.
  const settlement = await admission([{ sql: "UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?", params: [] }]);
  let terminalUsed = false;
  const terminal = createEodD1Database({ accountId, token, databaseId: ops, allowedDatabaseIds, admission: async (queries) => {
    if (terminalUsed || queries.length !== 1 || !/^UPDATE eod_rollout_evidence SET /i.test(queries[0].sql)) throw new Error("eod-capacity-renewal-terminal-already-used");
    terminalUsed = true; return settlement;
  } });
  try {
    const due = await inspectStorageCapacityRenewal(env);
    if (!due.needed) {
      // A pointer promotion can commit before its HTTP response/status write
      // arrives. Resolve that exact attempt from its immutable proof, then run
      // the real current sample; never leave a successful renewal failed forever.
      const priorStatus = await loadStorageCapacityRenewalStatus(env), accepted = await loadStorageHistoryMaintenanceApproval(env, codeRevision);
      const renewal = accepted ? (accepted.proof as unknown as { renewal?: { attemptId?: string; previousProofHash?: string } }).renewal : null;
      if (priorStatus && priorStatus.status !== "completed" && renewal?.attemptId === priorStatus.attemptId
        && renewal.previousProofHash === priorStatus.previousProofHash && accepted) {
        status = priorStatus;
        await refreshStorageHistoryMaintenanceEvidence(env, { tickers: accepted.proof.tickers, codeRevision });
        await finishStorageCapacityRenewal(terminal, status, { proofHash: accepted.proofHash });
        console.log(JSON.stringify({ status: "completed", reason: "recovered-committed-approval" })); return;
      }
      console.log(JSON.stringify({ status: "not-due", reason: due.reason, remainingSessions: due.remainingSessions })); return;
    }
    status = await claimStorageCapacityRenewal(env.OPS_DB!, due);
    if (!status) { console.log(JSON.stringify({ status: "deferred", reason: "lease-or-cooldown" })); return; }
    const progress = async (stage: string, value: Record<string, number | string> = {}) => {
      assertDeadline(); await progressStorageCapacityRenewal(env.OPS_DB!, status!, stage, value);
      console.log(JSON.stringify({ status: "running", stage, ...value }));
    };
    if (!await env.OPS_DB!.prepare("SELECT 1 AS present FROM eod_rollout_evidence WHERE id=?").bind(`active:${codeRevision}`).first()) {
      throw new Error("eod-capacity-renewal-approved-code-required");
    }
    await assertEodCutover(env, codeRevision);
    const previous = await loadStorageHistoryMaintenanceApproval(env, codeRevision);
    if (!previous || previous.proof.identity.targetDatabaseId !== market || previous.proof.identity.historyDatabaseId !== history) {
      throw new Error("eod-capacity-renewal-canonical-database-mismatch");
    }
    const capture = await captureStorageCapacityInputs(env, due);
    const identity = { ...previous.proof.identity, codeRevision, sessionDate: capture.sessionDate };
    const inputs = await loadEodInputs(env, capture.sessionDate), tickers = [...inputs.tickers].sort();
    const publications = await verifyStorageAcceptedPublications({ env, identity, runId: capture.runId, tickers, expectedSession: capture.sessionDate });
    const assertCurrent = async () => {
      assertDeadline();
      assertStorageCapacityCapture(capture, await captureStorageCapacityInputs(env, due));
      if (git("rev-parse", "HEAD") !== codeRevision || git("status", "--porcelain", "--untracked-files=normal")) throw new Error("eod-capacity-renewal-checkout-changed");
    };
    const assertRevisions = async () => { assertDeadline(); await assertStorageCapacityRevisions(env, capture); };
    directory = mkdtempSync(join(tmpdir(), "market-eod-capacity-renewal-"));
    const marketFile = join(directory, "market.sqlite"), historyFile = join(directory, "history.sqlite"), referenceFile = join(directory, "reference.sqlite");
    await progress("capture-market");
    await captureCapacityDatabase({ db: env.MARKET_DATA_DB!, kind: "market", file: marketFile, assertCurrent: assertRevisions,
      progress: (value) => progress("capture-market", value) });
    await assertCurrent();
    await progress("capture-history");
    await captureCapacityDatabase({ db: env.MARKET_HISTORY_DB!, kind: "history", file: historyFile, assertCurrent: assertRevisions,
      progress: (value) => progress("capture-history", value) });
    await assertCurrent();
    const localMarket = createCapacityLocalSqlite(marketFile), localHistory = createCapacityLocalSqlite(historyFile), reference = createCapacityLocalSqlite(referenceFile);
    let consumers: StorageConsumerEvidence | null = null;
    const consumerCapture: StorageAcceptanceCapture = { identity, captureHash: await eodHash(capture),
      sourceCapture: capture.market, targetCapture: capture.market, historyCapture: capture.history };
    try {
      await progress("reference-history");
      await flattenCapacityHistory({ market: localMarket, history: localHistory, reference,
        progress: (rows) => progress("reference-history", { rows }) });
      let checkpoint: StorageConsumerCheckpoint | undefined;
      while (!consumers) {
        assertDeadline();
        const result = await verifyStorageConsumerBatch({
          sourceEnv: { ...env, DB: reference.db, MARKET_DATA_DB: reference.db, MARKET_HISTORY_DB: undefined },
          targetEnv: { ...env, DB: localMarket.db, MARKET_DATA_DB: localMarket.db, MARKET_HISTORY_DB: localHistory.db },
          capture: consumerCapture, tickers, calendarDates: inputs.calendarDates, checkpoint, maxTickers: 10,
          // These local databases are read-only for the entire consumer phase.
          // Remote clocks/population are checked periodically and at promotion.
          assertCapture: async () => { assertDeadline(); },
        });
        checkpoint = result.checkpoint; consumers = result.evidence;
        if (checkpoint.nextTicker % 100 === 0 || consumers) {
          await assertRevisions(); await progress("consumer-parity", { completed: checkpoint.nextTicker, total: tickers.length, outputHash: checkpoint.outputHash });
        }
      }
    } finally { await Promise.all([localMarket.close(), localHistory.close(), reference.close()]); }
    await assertCurrent();
    const samples = await collectStoragePublicationGrowthSamples(env, publications, capture.market.schemaHash);
    const sampleFile = join(directory, "publication-samples.json"), tickerFile = join(directory, "tickers.json"), growthFile = join(directory, "growth.json"), analysisFile = join(directory, "analysis.json");
    writeFileSync(sampleFile, JSON.stringify(samples)); writeFileSync(tickerFile, JSON.stringify({ tickers }));
    const python = (name: string, args: string[]) => {
      assertDeadline();
      try { execFileSync("python", [resolve("worker/scripts", name), ...args], { timeout: Math.max(1, deadline - Date.now()),
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 }); }
      catch { throw new Error(`eod-capacity-renewal-${name.startsWith("measure") ? "publication-growth" : "full-layout"}-measurement-failed`); }
    };
    await progress("publication-growth");
    python("measure-eod-publication-growth.py", ["--schema-sqlite", marketFile, "--samples-json", sampleFile, "--output", growthFile]);
    const publicationGrowth: unknown = JSON.parse(readFileSync(growthFile, "utf8"));
    const reserve = storagePublicationGrowthReserve(publicationGrowth, { codeRevision, tickerHash: capture.populationHash, schemaHash: capture.market.schemaHash });
    await progress("physical-model", { publicationGrowthReserveBytes: reserve });
    python("analyze-eod-storage.py", ["--source-sqlite", marketFile, "--history-sqlite", historyFile, "--tickers-json", tickerFile,
      "--session-date", capture.sessionDate, "--publication-growth-reserve-bytes", String(reserve), "--output", analysisFile]);
    const analysis = JSON.parse(readFileSync(analysisFile, "utf8")) as { source: { snapshotSha256: string } };
    await assertCurrent(); await progress("validate-live-capacity");
    const capacity = await validateStorageCapacityAnalysis({ analysis, publicationGrowth, identity, tickers, sourceSchemaHash: capture.market.schemaHash,
      sourceSnapshotSha256: analysis.source.snapshotSha256, target: env.MARKET_DATA_DB!, history: env.MARKET_HISTORY_DB!, publications,
      hotSessions: previous.proof.model.hotSessions });
    // Every final read/write remains admitted against the current UTC and
    // rolling allowance. Flush settles and closes admission only in finally.
    await assertCurrent();
    const approved = await storeRenewedStorageHistoryMaintenanceApproval(env, { previous, status, capture, consumerCapture,
      consumers: consumers!, publications, capacity, analysis, tickers, assertCapture: assertCurrent });
    await progress("sample-current-capacity", { proofHash: approved.proofHash });
    await refreshStorageHistoryMaintenanceEvidence(env, { tickers, codeRevision });
    await finishStorageCapacityRenewal(terminal, status, { proofHash: approved.proofHash });
    console.log(JSON.stringify({ status: "completed", hotSessions: capacity.hotSessions, forecastSessions: capacity.forecastSessions,
      tickerCount: tickers.length, projectedMarketBytes: capacity.projectedMarketBytes, projectedHistoryBytes: capacity.projectedHistoryBytes }));
  } catch (error) {
    const classified = classifyStorageFailure(error);
    const raw = error instanceof Error ? error.message : "measurement-failed";
    const reason = /^eod-capacity-renewal-[a-z0-9-]{1,125}$/.test(raw) ? raw : classified.code;
    if (status && !terminalUsed) await finishStorageCapacityRenewal(terminal, status, { error: reason, quota: classified.quota });
    console.error(JSON.stringify({ status: "failed", stage: status?.stage ?? "admission", reason })); process.exitCode = 1;
  } finally {
    try { if (!terminalUsed) await settlement({ rowsRead: 0, rowsWritten: 0, sizeAfter: 0 }); }
    finally {
      await admission.flush();
      // Only the exact generated OS-temporary directory is removable. These
      // artifacts are measurement inputs; durable market history stays in D1.
      if (directory) {
        const base = resolve(tmpdir()), target = resolve(directory);
        if (target.startsWith(base + (base.includes("\\") ? "\\" : "/")) && target.split(/[\\/]/).at(-1)!.startsWith("market-eod-capacity-renewal-")) rmSync(target, { recursive: true, force: true });
      }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ status: "failed", reason: "eod-capacity-renewal-start-or-settlement-failed" })); process.exitCode = 1; });
}
