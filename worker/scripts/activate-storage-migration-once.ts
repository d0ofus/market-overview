import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration, loadStorageMigrationCheckpoint, storageMigrationIdentity, type StorageMigrationIdentity } from "../src/market-storage-control";
import { activateStorageMigrationOnce, validateStorageActivationState } from "../src/market-storage-activate-once";
import { inspectStorageActivationDeployment, type StorageWorkerBinding } from "../src/market-storage-activation-inspect";
import { verifyStoragePublicBindings } from "../src/market-storage-activation";
import { loadStoragePreflight } from "../src/market-storage-pipeline";
import { assertStorageSourceFrozen } from "../src/market-storage-fence";
import { verifyStorageAcceptedPublications, type StoragePublicationEvidence } from "../src/market-storage-acceptance";
import { expectedEodSession } from "../src/eod-coordinator";
import { storageHash } from "../src/market-storage-pages";
import { buildStorageActivationConfig } from "./storage-activation-config";
import type { Env } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`storage-activate-missing-setting:${name}`); return value; };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function main(): Promise<void> {
  if (process.env.EOD_STORAGE_ACTIVATE_APPROVED !== "true") throw new Error("storage-activate-explicit-opt-in-required");
  const codeRevision = required("EOD_STORAGE_EXPECTED_COMMIT"), accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const token = required("CLOUDFLARE_EOD_D1_TOKEN"), controlToken = required("CLOUDFLARE_API_TOKEN");
  // Unlike START, activation requires the immutable original-source variable;
  // the canonical market variable is expected to change during this command.
  const source = required("EOD_STORAGE_SOURCE_DATABASE_ID"), target = required("EOD_STORAGE_TARGET_DATABASE_ID");
  const history = required("EOD_HISTORY_DATABASE_ID"), ops = required("EOD_OPS_DATABASE_ID"), id = required("EOD_STORAGE_MIGRATION_ID");
  const repository = process.env.EOD_GITHUB_REPOSITORY || "d0ofus/market-overview";
  const workerName = process.env.EOD_WORKER_NAME || "market-command-worker";
  if (!/^[a-f0-9]{40}$/.test(codeRevision) || !/^[a-f0-9]{32}$/.test(accountId)
    || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)
    || ![source, target, history, ops].every((value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
    || new Set([source, target, history, ops]).size !== 4) throw new Error("storage-activate-identity-invalid");
  const command = (exe: string, args: string[], category: string, env = process.env, cwd = root) => {
    try { return execFileSync(exe, args, { cwd, env, encoding: "utf8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16_000_000 }).trim(); }
    catch (error) {
      const stderr = error && typeof error === "object" ? (error as { stderr?: unknown }).stderr : null;
      if (/quota|budget-exhausted|capacity-exceeded/i.test(String(stderr ?? ""))) throw new Error("storage-activate-resource-budget");
      throw new Error(`storage-activate-${category}-failed`);
    }
  };
  const gh = (args: string[]) => command("gh", args, "github");
  const githubJson = (path: string) => JSON.parse(gh(["api", path])) as unknown;
  const workerDirectory = resolve(root, "worker"), trackedConfigFile = resolve(workerDirectory, "wrangler.toml");
  const trackedConfig = readFileSync(trackedConfigFile, "utf8"), configHash = digest(trackedConfig);
  const assertCheckout = async () => {
    if (command("git", ["rev-parse", "HEAD"], "checkout") !== codeRevision
      || command("git", ["branch", "--show-current"], "checkout") !== "main"
      || command("git", ["status", "--porcelain", "--untracked-files=no"], "checkout")
      || digest(readFileSync(trackedConfigFile, "utf8")) !== configHash) throw new Error("storage-activate-checkout-changed");
  };
  await assertCheckout();
  const request = async (path: string) => {
    let response: Response;
    try { response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, {
      headers: { Authorization: `Bearer ${controlToken}` }, signal: AbortSignal.timeout(15_000),
    }); } catch { throw new Error("storage-activate-cloudflare-unavailable"); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("storage-activate-cloudflare-unavailable"); }
    let body: Record<string, unknown> | null;
    try { body = object(await response.json()); } catch { body = null; }
    if (!body || body.success !== true || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))) {
      throw new Error("storage-activate-cloudflare-invalid-response");
    }
    return body.result;
  };
  const allowedDatabaseIds = [source, target, history, ops];
  const rawOps = createEodD1Database({ accountId, token, databaseId: ops, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `storage-activate:${id}`, { writeCredit: 500,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps }),
  });
  const database = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds, admission });
  const opsDb = database(ops), sourceDb = database(source), targetDb = database(target), historyDb = database(history);
  try {
    const initial = await loadStorageMigration(opsDb, id);
    if (!initial || initial.source_database_id !== source || initial.target_database_id !== target || initial.history_database_id !== history
      || initial.code_revision !== codeRevision || (process.env.EOD_STORAGE_SESSION_DATE && process.env.EOD_STORAGE_SESSION_DATE !== initial.session_date)) {
      throw new Error("storage-activate-durable-identity-conflict");
    }
    const identity: StorageMigrationIdentity = storageMigrationIdentity(initial), input = { identity, opsDatabaseId: ops };
    const env: Env = { DB: targetDb, MARKET_DATA_DB: targetDb, MARKET_HISTORY_DB: historyDb, OPS_DB: opsDb,
      EOD_CODE_REVISION: codeRevision, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "false" };
    const targetDetails = object(await request(`d1/database/${target}`));
    if (targetDetails?.uuid !== target || typeof targetDetails.name !== "string") throw new Error("storage-activate-target-database-unverified");
    const generated = buildStorageActivationConfig({ trackedToml: trackedConfig, workerDirectory, workerName, accountId,
      identity, opsDatabaseId: ops, targetDatabaseName: targetDetails.name });
    const configFile = resolve(workerDirectory, "tmp", `storage-activation-${codeRevision}.jsonc`);
    const core = (generated.config.d1_databases as Array<Record<string, unknown>>).find((row) => row.binding === "DB")?.database_id;
    if (typeof core !== "string" || [source, target, history, ops].includes(core)) throw new Error("storage-activate-core-binding-invalid");
    let preservedBindings: string | null = null;
    const normalBindings = (bindings: StorageWorkerBinding[]) => JSON.stringify(bindings.filter((row) => row.type !== "plain_text")
      .map((row) => row.type === "d1" ? { name: row.name, type: row.type,
        id: row.name === "MARKET_DATA_DB" ? "canonical-market" : row.id ?? row.database_id } : row)
      .sort((a, b) => a.name.localeCompare(b.name)));
    const inspectServing = async () => {
      const serving = await inspectStorageActivationDeployment({ accountId, token: controlToken, workerName, identity, opsDatabaseId: ops });
      const d1Config = generated.config.d1_databases as Array<Record<string, unknown>>;
      for (const row of serving.bindings.filter((binding) => binding.type === "d1")) {
        const expected = d1Config.find((binding) => binding.binding === row.name);
        if (!expected || (row.name !== "MARKET_DATA_DB" && expected.database_id !== (row.id ?? row.database_id))) throw new Error("storage-activate-auxiliary-binding-drift");
      }
      const configuredProducers = object(generated.config.queues)?.producers;
      const producers = Array.isArray(configuredProducers) ? configuredProducers.map((row) => [object(row)?.binding, object(row)?.queue])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : [];
      const actualProducers = serving.bindings.filter((row) => row.type === "queue").map((row) => [row.name, row.queue_name])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (JSON.stringify(producers) !== JSON.stringify(actualProducers)
        || serving.bindings.some((row) => !["plain_text", "secret_text", "d1", "queue"].includes(row.type))) throw new Error("storage-activate-unreviewed-production-binding");
      const signature = normalBindings(serving.bindings);
      if (preservedBindings !== null && preservedBindings !== signature) throw new Error("storage-activate-preserved-binding-changed");
      preservedBindings = signature;
      const schedules = object(await request(`workers/scripts/${workerName}/schedules`))?.schedules;
      const crons = object(generated.config.triggers)?.crons;
      if (!Array.isArray(schedules) || !Array.isArray(crons)
        || JSON.stringify(schedules.map((row) => object(row)?.cron).sort()) !== JSON.stringify([...crons].sort())) {
        throw new Error("storage-activate-cron-configuration-drift");
      }
      return serving;
    };
    const verifyGitHub = async (): Promise<{ marketDatabaseId: string; mode: "shadow" | "active" }> => {
      if (object(object(githubJson(`repos/${repository}/git/ref/heads/main`))?.object)?.sha !== codeRevision) throw new Error("storage-activate-github-main-revision-mismatch");
      const response = object(githubJson(`repos/${repository}/environments/market-eod/variables?per_page=100`));
      if (!Array.isArray(response?.variables) || response.total_count !== response.variables.length) throw new Error("storage-activate-github-variables-incomplete");
      const vars = new Map(response.variables.map((row) => { const value = object(row); return [String(value?.name), String(value?.value)]; }));
      for (const [name, expected] of [["CLOUDFLARE_ACCOUNT_ID", accountId], ["EOD_STORAGE_SOURCE_DATABASE_ID", source],
        ["EOD_STORAGE_TARGET_DATABASE_ID", target], ["EOD_STORAGE_CODE_REVISION", codeRevision],
        ["EOD_HISTORY_DATABASE_ID", history], ["EOD_OPS_DATABASE_ID", ops], ["EOD_CORE_DATABASE_ID", core]]) {
        if (vars.get(name) !== expected) throw new Error("storage-activate-github-immutable-identity-conflict");
      }
      const mode = vars.get("EOD_RUNNER_MODE") ?? "shadow";
      if (mode !== "shadow" && mode !== "active") throw new Error("storage-activate-github-mode-invalid");
      return { marketDatabaseId: vars.get("EOD_MARKET_DATABASE_ID") ?? "", mode };
    };
    const readEvidence = async (key: string) => {
      const row = await opsDb.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json");
      return row === null ? null : JSON.parse(row) as unknown;
    };
    const result = await activateStorageMigrationOnce(input, {
      assertCheckout,
      loadState: async () => {
        const run = await loadStorageMigration(opsDb, id);
        if (!run) throw new Error("storage-activate-run-missing");
        const progress = object(JSON.parse(run.progress_json)), latestProofHash = progress?.cutoverProofHash;
        if (typeof latestProofHash !== "string" || !/^[a-f0-9]{64}$/.test(latestProofHash)) throw new Error("storage-activate-storage-proof-reference-invalid");
        const state = await validateStorageActivationState(input, run, await readEvidence(`active:${codeRevision}`),
          await readEvidence(`storage-cutover-proof:${latestProofHash}`), await readEvidence("monitoring:public-activation"));
        if (run.status !== "completed" && await opsDb.prepare("SELECT id FROM eod_runs WHERE lease_until>? LIMIT 1").bind(new Date().toISOString()).first()) {
          throw new Error("storage-activate-eod-live-lease");
        }
        return state;
      },
      verifyPublications: async (state) => {
        const frozen = await assertStorageSourceFrozen(sourceDb, identity, state.run.source_schema_hash!);
        if (frozen.revision !== state.run.source_revision) throw new Error("storage-activate-source-capture-changed");
        const preflight = await loadStoragePreflight(opsDb, state.run);
        const bootstrap = await loadStorageMigrationCheckpoint(opsDb, id, "bootstrap:complete"), owner = object(bootstrap?.payload);
        const currentOwner = await loadStorageMigrationCheckpoint(opsDb, id, "bootstrap:owner");
        if (!owner || owner.targetDatabaseId !== target || typeof owner.runId !== "string"
          || await storageHash(currentOwner?.payload) !== await storageHash(owner)) throw new Error("storage-activate-bootstrap-owner-mismatch");
        const expectedSession = await expectedEodSession(env);
        if (!expectedSession) throw new Error("storage-activate-calendar-unavailable");
        const actual = await verifyStorageAcceptedPublications({ env, identity, runId: owner.runId, tickers: preflight.tickers, expectedSession });
        const accepted = JSON.parse(state.run.progress_json).publications as StoragePublicationEvidence;
        const stable = ({ checkedAt: _checkedAt, evidenceHash: _evidenceHash, ...value }: StoragePublicationEvidence) => value;
        if (await storageHash(stable(actual)) !== await storageHash(stable(accepted))) throw new Error("storage-activate-accepted-publications-changed");
      },
      inspectServing, verifyGitHub,
      setGitHubVariable: async (name, value) => { gh(["variable", "set", name, "--env", "market-eod", "--repo", repository, "--body", value]); },
      authenticate: async () => {
        const identityOutput = command(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "whoami"], "authentication", process.env, workerDirectory);
        if (!identityOutput.includes(accountId)) throw new Error("storage-activate-authenticated-account-mismatch");
      },
      deployTarget: async (expectedSource) => {
        await assertCheckout(); await verifyGitHub();
        const current = await inspectServing();
        if (current.side !== "source" || current.versionId !== expectedSource.versionId || current.deploymentId !== expectedSource.deploymentId) {
          throw new Error("storage-activate-predeploy-version-changed");
        }
        mkdirSync(dirname(configFile), { recursive: true }); writeFileSync(configFile, generated.text);
        command(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", configFile,
          "--name", workerName, "--keep-vars"], "deployment", process.env, workerDirectory);
      },
      verifyPublicTarget: async () => {
        const github = await verifyGitHub();
        await verifyStoragePublicBindings({ accountId, token: controlToken, workerName, identity, opsDatabaseId: ops,
          githubMarketDatabaseId: github.marketDatabaseId, githubRunnerMode: github.mode });
        const serving = await inspectServing();
        if (serving.side !== "target") throw new Error("storage-activate-target-not-serving");
      },
      complete: async () => {
        command(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(workerDirectory, "scripts/market-storage-runner.ts"), "complete"],
          "completion", { ...process.env, EOD_MARKET_DATABASE_ID: target, EOD_STORAGE_SOURCE_DATABASE_ID: source,
            EOD_STORAGE_TARGET_DATABASE_ID: target, EOD_CORE_DATABASE_ID: core, EOD_STORAGE_SESSION_DATE: identity.sessionDate });
      },
      journal: async (stage) => {
        mkdirSync(resolve(workerDirectory, "tmp"), { recursive: true });
        writeFileSync(resolve(workerDirectory, "tmp/storage-activation-once.json"), JSON.stringify({ version: 1, id, stage,
          targetDatabaseId: target, codeRevision, observedAt: new Date().toISOString() }));
      },
    });
    console.log(JSON.stringify({ id, ...result, monitoring: "three-trading-sessions-required", sourcePreserved: true, pruneEnabled: false }));
  } finally { await admission.flush(); }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "storage-activate-failed";
  console.error(JSON.stringify({ status: "stopped", reason: /^storage-[a-z0-9:-]+$/.test(message) ? message : "storage-activate-failed",
    recovery: "inspect-current-bindings-and-retry-same-approved-revision", automaticRollback: false })); process.exitCode = 1;
});
