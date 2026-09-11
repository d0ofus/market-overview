import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration, storageMigrationIdentity, storageExecutionRevision } from "../src/market-storage-control";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { verifyStoragePublicBindings } from "../src/market-storage-activation";
import { storeEodProductionConfiguration, validateEodProductionConfiguration } from "../src/eod-production-configuration";
import { loadApprovedStorageHotSessions } from "../src/eod-storage-history-capacity";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error("storage-production-config-setting-missing"); return value; };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
async function main(): Promise<void> {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN"), controlToken = required("CLOUDFLARE_API_TOKEN");
  const marketDatabaseId = required("EOD_MARKET_DATABASE_ID"), historyDatabaseId = required("EOD_HISTORY_DATABASE_ID"), opsDatabaseId = required("EOD_OPS_DATABASE_ID");
  const migrationId = required("EOD_STORAGE_MIGRATION_ID"), repository = process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  const workerName = process.env.EOD_WORKER_NAME ?? "market-command-worker";
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[\w.-]+\/[\w.-]+$/.test(repository)
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("storage-production-config-identity-invalid");
  const command = (exe: string, args: string[]) => {
    try { return execFileSync(exe, args, { cwd: root, encoding: "utf8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 2_000_000 }).trim(); }
    catch { throw new Error("storage-production-config-control-command-failed"); }
  };
  const codeRevision = command("git", ["rev-parse", "HEAD"]), configPath = resolve(root, "worker/wrangler.toml");
  const configText = readFileSync(configPath, "utf8"), trackedConfig = parse(configText);
  const assertCheckout = () => {
    if (!/^[a-f0-9]{40}$/.test(codeRevision) || command("git", ["rev-parse", "HEAD"]) !== codeRevision
      || command("git", ["branch", "--show-current"]) !== "main" || command("git", ["status", "--porcelain", "--untracked-files=no"])
      || readFileSync(configPath, "utf8") !== configText) throw new Error("storage-production-config-checkout-not-clean-main");
  };
  const github = () => {
    const ref = object(JSON.parse(command("gh", ["api", `repos/${repository}/git/ref/heads/main`])));
    const result = object(JSON.parse(command("gh", ["api", `repos/${repository}/environments/market-eod/variables?per_page=100`])));
    if (!Array.isArray(result?.variables) || result.total_count !== result.variables.length) throw new Error("storage-production-config-github-variables-incomplete");
    const entries = result.variables.map((row) => { const item = object(row);
      if (typeof item?.name !== "string" || typeof item.value !== "string") throw new Error("storage-production-config-github-variables-invalid");
      return [item.name, item.value] as const; });
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error("storage-production-config-github-variables-invalid");
    return { githubMainRevision: String(object(ref?.object)?.sha ?? ""), githubVariables: new Map(entries) };
  };
  assertCheckout();
  const initialGithub = github();
  if (initialGithub.githubMainRevision !== codeRevision) throw new Error("storage-production-config-github-main-mismatch");
  const allowedDatabaseIds = [marketDatabaseId, historyDatabaseId, opsDatabaseId];
  const rawOps = createEodD1Database({ accountId, token, databaseId: opsDatabaseId, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `production-configuration:${codeRevision}`, { profile: resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), writeCredit: 100,
    reconcileAccountUsage: () => reconcileEodAccountUsage({profile:resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps }) });
  const ops = createEodD1Database({ accountId, token, databaseId: opsDatabaseId, allowedDatabaseIds, admission });
  const readEvidence = async (id: string) => { const row = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(id).first<string>("evidence_json"); return row ? JSON.parse(row) as unknown : null; };
  try {
    const migration = await loadStorageMigration(ops, migrationId);
    if (!migration || migration.status !== "completed") throw new Error("storage-production-config-completed-migration-required");
    await assertStorageExecutionRevision(ops,migration,storageExecutionRevision(migration));
    const activation = await readEvidence("monitoring:public-activation"), codeApproval = await readEvidence(`active:${codeRevision}`);
    const readBinding = (observed: ReturnType<typeof github>) => verifyStoragePublicBindings({ accountId, token: controlToken, workerName,
      identity: { ...storageMigrationIdentity(migration), codeRevision }, opsDatabaseId,
      githubMarketDatabaseId: observed.githubVariables.get("EOD_MARKET_DATABASE_ID") ?? "",
      githubRunnerMode: observed.githubVariables.get("EOD_RUNNER_MODE") ?? "", expectedArchivePruneEnabled: true });
    let binding = await readBinding(initialGithub);
    // The serving verifier reads deployment -> immutable version -> deployment.
    // Re-read GitHub and the local checkout immediately before the admitted write.
    assertCheckout();
    let finalGithub = github();
    if (await loadApprovedStorageHotSessions({ DB: ops, OPS_DB: ops, EOD_CODE_REVISION: codeRevision }) !== 90) {
      throw new Error("storage-production-config-ninety-session-approval-required");
    }
    const validate = () => validateEodProductionConfiguration({ accountId, workerName, codeRevision, migrationId,
      marketDatabaseId, historyDatabaseId, opsDatabaseId, trackedConfig, ...finalGithub, migration, activation, codeApproval, binding });
    try { await validate(); }
    catch (error) {
      // This specific final validator result is emitted only after every other
      // actual config, serving-version and approval check passes. Never replace
      // observed GitHub values in a local map to manufacture a completed proof.
      if (!(error instanceof Error) || error.message !== "storage-production-config-github-activation-pending") throw error;
      assertCheckout();
      command("gh", ["variable", "set", "EOD_PRODUCTION_CODE_REVISION", "--env", "market-eod", "--repo", repository, "--body", codeRevision]);
      command("gh", ["variable", "set", "EOD_ARCHIVE_PRUNE_ENABLED", "--env", "market-eod", "--repo", repository, "--body", "true"]);
      finalGithub = github(); binding = await readBinding(finalGithub);
    }
    assertCheckout();
    const record = await validate();
    const stored = await storeEodProductionConfiguration(ops, record);
    console.log(JSON.stringify({ status: "recorded", ...stored }));
  } finally { await admission.flush(); }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const reason = /^storage-production-config-[a-z-]+$/.test(message) ? message
    : /quota|budget/i.test(message) ? "storage-production-config-quota-deferred" : "storage-production-config-verification-failed";
  console.error(JSON.stringify({ status: "not-recorded", reason })); process.exitCode = 1;
});
