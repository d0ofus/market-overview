import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration, storageExecutionIdentity } from "../src/market-storage-control";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { validateStorageActivationState } from "../src/market-storage-activate-once";
import { loadStorageValidationPlan } from "../src/market-storage-population-plan";
import { assertStorageAcceptedValidationPlan } from "../src/market-storage-validation-consumers";
import { verifyStoragePublicBindings } from "../src/market-storage-activation";
import { validateProductionConfigDelta, deriveProductionConfigProof } from "../src/eod-production-config-transition";
import { collectEodCurrentHealth, isEodCurrentHealthReady } from "../src/eod-current-health";
import { assertEodCutover } from "../src/eod-rollout-service";
import { eodHash } from "../src/eod-publication-service";
import { storageHistoryConfigurationReference, initializeStorageHistoryConfigurationStatus } from "../src/eod-storage-history-capacity";
import type { Env } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function fail(reason: string): never { throw new Error(`storage-config-transition-${reason}`); }
const required = (name: string): string => { const value = process.env[name]?.trim(); if (!value) fail("setting-missing"); return value; };
async function main(): Promise<void> {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN"), controlToken = required("CLOUDFLARE_API_TOKEN");
  const target = required("EOD_MARKET_DATABASE_ID"), history = required("EOD_HISTORY_DATABASE_ID"), opsId = required("EOD_OPS_DATABASE_ID"), migrationId = required("EOD_STORAGE_MIGRATION_ID");
  const repository = process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview", workerName = process.env.EOD_WORKER_NAME ?? "market-command-worker";
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)
    || ![target, history, opsId].every((id) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    || new Set([target, history, opsId]).size !== 3) fail("identity-invalid");
  const command = (exe: string, args: string[]) => {
    try { return execFileSync(exe, args, { cwd: root, encoding: "utf8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 8_000_000 }); }
    catch { return fail("control-command-failed"); }
  };
  const git = (...args: string[]) => command("git", args).trim();
  const revision = git("rev-parse", "HEAD"), configPath = resolve(root, "worker/wrangler.toml"), candidateToml = readFileSync(configPath, "utf8");
  const assertCheckout = () => {
    if (!/^[a-f0-9]{40}$/.test(revision) || git("rev-parse", "HEAD") !== revision || git("branch", "--show-current") !== "main"
      || git("status", "--porcelain") || readFileSync(configPath, "utf8") !== candidateToml) fail("clean-main-required");
  };
  const github = () => {
    const ref = object(JSON.parse(command("gh", ["api", `repos/${repository}/git/ref/heads/main`])));
    if (object(ref?.object)?.sha !== revision) fail("github-main-mismatch");
    const values = object(JSON.parse(command("gh", ["api", `repos/${repository}/environments/market-eod/variables?per_page=100`])));
    if (!Array.isArray(values?.variables) || values.total_count !== values.variables.length) fail("github-variables-incomplete");
    const rows = values.variables.map((value) => { const row = object(value);
      if (typeof row?.name !== "string" || typeof row.value !== "string") fail("github-variables-invalid");
      return [row.name, row.value] as const; });
    if (new Set(rows.map(([name]) => name)).size !== rows.length) fail("github-variables-invalid");
    return new Map(rows);
  };
  const inventory = async () => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100&page=1`, {
      headers: { Authorization: `Bearer ${controlToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); fail("capacity-control-unavailable"); }
    const body = object(await response.json()), info = object(body?.result_info);
    if (body?.success !== true || !Array.isArray(body.result) || body.result.length > 10 || info?.total_count !== body.result.length || info.page !== 1) fail("capacity-inventory-incomplete");
    const rows = body.result.map((value) => { const row = object(value);
      if (typeof row?.uuid !== "string" || typeof row.name !== "string" || typeof row.file_size !== "number"
        || !Number.isSafeInteger(row.file_size) || row.file_size < 0) fail("capacity-inventory-invalid");
      return { id: row.uuid, name: row.name, bytes: row.file_size }; });
    if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.reduce((sum, row) => sum + row.bytes, 0) >= 5_000_000_000) fail("account-capacity-exceeded");
    const market = rows.find((row) => row.id === target), archive = rows.find((row) => row.id === history);
    if (!market || !archive || !rows.some((row) => row.id === opsId)) fail("capacity-database-missing");
    return { market, archive };
  };
  assertCheckout(); const initialGithub = github();
  const allowedDatabaseIds = [target, history, opsId];
  const rawOps = createEodD1Database({ accountId, token, databaseId: opsId, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `config-transition:${revision}`, { profile: resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), writeCredit: 100,
    reconcileAccountUsage: () => reconcileEodAccountUsage({profile:resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps }) });
  const database = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds, admission });
  const ops = database(opsId), marketDb = database(target), historyDb = database(history);
  const evidence = async (id: string): Promise<unknown> => {
    const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
    return text ? JSON.parse(text) as unknown : null;
  };
  try {
    const migration = await loadStorageMigration(ops, migrationId);
    if (!migration || migration.status !== "completed" || migration.target_database_id !== target || migration.history_database_id !== history
      || !migration.completed_at || !Number.isFinite(Date.parse(migration.completed_at)) || Date.parse(migration.completed_at) > Date.now()) fail("completed-migration-required");
    const identity = storageExecutionIdentity(migration), progress = object(JSON.parse(migration.progress_json));
    if (typeof progress?.cutoverProofHash !== "string" || !/^[a-f0-9]{64}$/.test(progress.cutoverProofHash)) fail("source-proof-reference-invalid");
    const sourceApproval = await evidence(`active:${identity.codeRevision}`), sourceProof = object(await evidence(`storage-cutover-proof:${progress.cutoverProofHash}`));
    const executionApproval = await assertStorageExecutionRevision(ops,migration,identity.codeRevision);
    const validationPlan = await loadStorageValidationPlan(ops, migration);
    await validateStorageActivationState({ identity, opsDatabaseId: opsId, executionApproval, validationPlan }, migration, sourceApproval, sourceProof, await evidence("monitoring:public-activation"));
    const assertGithub = () => {
      const vars = github();
      for (const [name, value] of [["CLOUDFLARE_ACCOUNT_ID", accountId], ["EOD_MARKET_DATABASE_ID", target], ["EOD_HISTORY_DATABASE_ID", history],
        ["EOD_OPS_DATABASE_ID", opsId], ["EOD_STORAGE_SOURCE_DATABASE_ID", identity.sourceDatabaseId], ["EOD_STORAGE_TARGET_DATABASE_ID", target],
        ["EOD_STORAGE_CODE_REVISION", migration.code_revision], ["EOD_RUNNER_MODE", "active"]]) {
        if (vars.get(name) !== value || initialGithub.get(name) !== value) fail("github-canonical-identity-mismatch");
      }
    };
    assertGithub();
    if ((initialGithub.get("EOD_STORAGE_EXECUTION_REVISION") ?? migration.code_revision) !== identity.codeRevision) fail("github-execution-revision-mismatch");
    const changedFiles = command("git", ["diff", "--no-ext-diff", "--name-only", "--no-renames", "-z", identity.codeRevision, revision, "--"]).split("\0").filter(Boolean);
    const approvedToml = command("git", ["show", `${identity.codeRevision}:worker/wrangler.toml`]);
    const capacities = await inventory();
    const delta = await validateProductionConfigDelta({ identity, nextRevision: revision, changedFiles, approvedToml, candidateToml, targetDatabaseName: capacities.market.name });
    const serving = async () => {
      const input = { accountId, token: controlToken, workerName, identity, opsDatabaseId: opsId, githubMarketDatabaseId: target, githubRunnerMode: "active" };
      try { return await verifyStoragePublicBindings(input); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "storage-activation-public-bindings-mismatch") throw error;
        return verifyStoragePublicBindings({ ...input, identity: { ...identity, codeRevision: revision } });
      }
    };
    const actual = await serving();
    const env: Env = { EOD_BUDGET_PROFILE:process.env.EOD_BUDGET_PROFILE, DB: marketDb, MARKET_DATA_DB: marketDb, MARKET_HISTORY_DB: historyDb, OPS_DB: ops,
      EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_CODE_REVISION: actual.codeRevision, EOD_STORAGE_MIGRATION_ID: migrationId };
    const assertNoLease = async () => {
      if (await ops.prepare("SELECT id FROM eod_runs WHERE lease_until>? LIMIT 1").bind(new Date().toISOString()).first()) fail("active-writer-retry-required");
    };
    await assertNoLease();
    const health = await collectEodCurrentHealth(env);
    if (!isEodCurrentHealthReady(health)) fail("current-publication-or-quota-health-required");
    const proof = deriveProductionConfigProof({ sourceProof: sourceProof?.proof, identity, nextRevision: revision,
      expectedSession: health.expectedSession!, targetBytes: capacities.market.bytes, historyBytes: capacities.archive.bytes });
    const pointers = await marketDb.prepare("SELECT scope,publication_id,session_date FROM eod_publication_pointers").all<{ scope: string; publication_id: string; session_date: string }>();
    if (proof.scopes.some((scope) => !pointers.results.some((row) => row.scope === scope.scope && row.publication_id === scope.publicationId && row.session_date === scope.sessionDate))) fail("accepted-publications-changed");
    assertCheckout(); assertGithub(); await assertNoLease();
    const confirmed = await serving();
    if (confirmed.versionId !== actual.versionId || confirmed.deploymentId !== actual.deploymentId) fail("serving-version-changed");
    await assertStorageAcceptedValidationPlan(await loadStorageValidationPlan(ops, migration), progress, sourceProof);
    // This executes full existing acceptance validation and immutably creates
    // active:<new SHA>. No approval hash or measured timestamp is copied forward.
    const historyReference = await storageHistoryConfigurationReference(env, { sourceRevision: identity.codeRevision, nextRevision: revision, proof });
    await assertEodCutover({ ...env, EOD_CODE_REVISION: revision }, revision, proof);
    const record = { version: 1, policy: "canonical-config-only-v1", migrationId, activationCodeRevision: identity.codeRevision,
      codeRevision: revision, validationPlanHash: validationPlan.planHash,
      sourceProofHash: progress.cutoverProofHash, proofHash: await eodHash(proof), ...delta, ...historyReference };
    const key = `config-transition:${revision}`, previous = await evidence(key);
    if (previous && await eodHash(previous) !== await eodHash(record)) fail("lineage-conflict");
    await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(key, JSON.stringify(record), new Date().toISOString()).run();
    if (await eodHash(await evidence(key)) !== await eodHash(record)) fail("lineage-write-conflict");
    await initializeStorageHistoryConfigurationStatus({ ...env, EOD_CODE_REVISION: revision });
    console.log(JSON.stringify({ status: "approved", codeRevision: revision, activationCodeRevision: identity.codeRevision,
      migrationId, targetDatabaseId: target, next: "deploy-canonical-config-then-record-production-configuration" }));
  } finally { await admission.flush(); }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const reason = /^(?:storage-config-transition|eod-cutover-proof)-[a-z-]+$/.test(message) ? message
    : /quota|budget/i.test(message) ? "storage-config-transition-quota-deferred" : "storage-config-transition-verification-failed";
  console.error(JSON.stringify({ status: "not-approved", reason })); process.exitCode = 1;
});
