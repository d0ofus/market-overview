import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { loadStorageMigration } from "../src/market-storage-control";
import { startStorageMigrationOnce, storageStartHistoryFenceSchemaMatches, type StorageStartDatabase } from "../src/market-storage-start";
import { storageStartSnapshotHash } from "./storage-start-snapshot";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`storage-start-missing-setting:${name}`); return value; };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  if (process.env.EOD_STORAGE_START_APPROVED !== "true") throw new Error("storage-start-explicit-opt-in-required");
  const codeRevision = required("EOD_STORAGE_EXPECTED_COMMIT"), accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const token = required("CLOUDFLARE_EOD_D1_TOKEN"), controlToken = required("CLOUDFLARE_API_TOKEN");
  const source = process.env.EOD_STORAGE_SOURCE_DATABASE_ID?.trim() || required("EOD_MARKET_DATABASE_ID");
  if (source !== required("EOD_MARKET_DATABASE_ID")) throw new Error("storage-start-canonical-source-already-changed");
  const history = required("EOD_HISTORY_DATABASE_ID"), ops = required("EOD_OPS_DATABASE_ID");
  const repository = process.env.EOD_GITHUB_REPOSITORY || "d0ofus/market-overview";
  const workerName = process.env.EOD_WORKER_NAME || "market-command-worker";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("storage-start-remote-identity-invalid");
  const files = new Map<string, string>();
  const readEvidence = (name: string) => {
    const file = resolve(required(name)), text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (Buffer.byteLength(text) > 2_000_000) throw new Error("storage-start-evidence-too-large");
    files.set(file, digest(readFileSync(file, "utf8"))); return JSON.parse(text) as unknown;
  };
  const analysis = readEvidence("EOD_STORAGE_ANALYSIS_PATH");
  const snapshotSource = readEvidence("EOD_STORAGE_SNAPSHOT_IDENTITY_PATH") as { accountId: string; sourceDatabaseId: string; runId: string; frozenInputHash: string };
  const frozen = readEvidence("EOD_STORAGE_FROZEN_INPUT_PATH") as { tickers: string[]; calendarDates: string[] };
  if (!snapshotSource || digest(readFileSync(required("EOD_STORAGE_FROZEN_INPUT_PATH"), "utf8")) !== snapshotSource.frozenInputHash
    || !Array.isArray(frozen?.calendarDates) || !Array.isArray(frozen?.tickers)) throw new Error("storage-start-frozen-input-changed");
  const sessionDate = object(analysis)?.sessionDate;
  if (typeof sessionDate !== "string" || frozen.calendarDates.at(-1) !== sessionDate) throw new Error("storage-start-session-mismatch");
  const snapshotFile = required("STORAGE_SNAPSHOT_PATH");
  if (storageStartSnapshotHash(snapshotFile, resolve(root, "worker/tmp")) !== object(object(analysis)?.source)?.snapshotSha256) {
    throw new Error("storage-start-snapshot-checksum-mismatch");
  }
  const migrationId = process.env.EOD_STORAGE_MIGRATION_ID || `market-storage:${sessionDate}:${codeRevision.slice(0, 12)}`;
  const targetName = `market-prices-eod-${sessionDate}-${codeRevision.slice(0, 12)}`;
  let targetId: string | null = null;
  const command = (exe: string, args: string[], category: string, env: NodeJS.ProcessEnv = process.env, cwd = root) => {
    try { return execFileSync(exe, args, { cwd, env, encoding: "utf8", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16_000_000 }).trim(); }
    catch (error) {
      const stderr = error && typeof error === "object" ? (error as { stderr?: unknown }).stderr : null;
      if (/quota|budget-exhausted|capacity-exceeded/i.test(String(stderr ?? ""))) throw new Error("storage-start-resource-budget");
      throw new Error(`storage-start-${category}-failed`);
    }
  };
  const gh = (args: string[]) => command("gh", args, "github");
  const ghJson = (path: string) => JSON.parse(gh(["api", path])) as unknown;
  const request = async (path: string, init: RequestInit = {}) => {
    let response: Response;
    try { response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, {
      ...init, headers: { Authorization: `Bearer ${controlToken}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    }); } catch { throw new Error("storage-start-cloudflare-unavailable"); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("storage-start-cloudflare-unavailable"); }
    let body: Record<string, unknown> | null;
    try { body = object(await response.json()); } catch { body = null; }
    if (!body || body.success !== true || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))) {
      throw new Error("storage-start-cloudflare-invalid-response");
    }
    return body;
  };
  const allowedDatabaseIds = [source, history, ops];
  const rawOps = createEodD1Database({ accountId, token, databaseId: ops, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `storage-start:${migrationId}`, { writeCredit: 500,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ accountId,
      token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps }),
  });
  const database = (databaseId: string, reviewedDdl?: string[]) => createEodD1Database({ accountId, token, databaseId,
    allowedDatabaseIds, admission, reviewedDdl });
  const opsDb = database(ops), sourceDb = database(source);
  const sourceBindings = async (expectedMigration: string | null) => {
    const path = `workers/scripts/${workerName}`;
    const active = async () => {
      const deployments = object((await request(`${path}/deployments`)).result)?.deployments;
      const deployment = Array.isArray(deployments) ? object(deployments[0]) : null;
      const versions = deployment?.versions;
      const version = Array.isArray(versions) ? object(versions[0]) : null;
      if (!deployment || typeof deployment.id !== "string" || deployment.strategy !== "percentage"
        || !Array.isArray(versions) || versions.length !== 1 || version?.percentage !== 100
        || typeof version.version_id !== "string" || !/^[a-f0-9-]{36}$/.test(version.version_id)) {
        throw new Error("storage-start-source-worker-deployment-ambiguous");
      }
      return { deploymentId: deployment.id, versionId: version.version_id };
    };
    const selected = await active();
    const version = object((await request(`${path}/versions/${selected.versionId}`)).result);
    const bindings = object(version?.resources)?.bindings;
    if (version?.id !== selected.versionId || !Array.isArray(bindings) || bindings.some((row) => !object(row))) {
      throw new Error("storage-start-source-worker-bindings-invalid");
    }
    const binding = (name: string, optional = false) => {
      const rows = bindings.map(object).filter((row) => row?.name === name);
      if (!rows.length && optional) return null;
      if (rows.length !== 1) throw new Error("storage-start-source-worker-binding-ambiguous"); return rows[0]!;
    };
    for (const [name, expected] of [["MARKET_DATA_DB", source], ["MARKET_HISTORY_DB", history], ["OPS_DB", ops]]) {
      const row = binding(name)!;
      if (row.type !== "d1" || (row.id && row.database_id && row.id !== row.database_id)
        || (row.id ?? row.database_id) !== expected) throw new Error("storage-start-source-worker-database-mismatch");
    }
    for (const [name, expected] of [["EOD_RUNNER_MODE", "shadow"], ["EOD_READ_ENABLED", "false"]]) {
      const row = binding(name)!;
      if (row.type !== "plain_text" || row.text !== expected) throw new Error("storage-start-source-worker-mode-mismatch");
    }
    const coordinator = binding("EOD_STORAGE_MIGRATION_ID", true);
    if (coordinator && (coordinator.type !== "plain_text" || coordinator.text !== migrationId)) throw new Error("storage-start-another-coordinator-active");
    if (expectedMigration && coordinator?.text !== expectedMigration) throw new Error("storage-start-coordinator-deployment-not-active");
    const confirmed = await active();
    if (confirmed.deploymentId !== selected.deploymentId || confirmed.versionId !== selected.versionId) throw new Error("storage-start-source-worker-deployment-changed");
    return coordinator ? String(coordinator.text) : null;
  };
  const migrationCommand = (action: string) => {
    if (!targetId) throw new Error("storage-start-target-required");
    command(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "worker/scripts/market-storage-runner.ts"), action],
      `migration-${action}`, { ...process.env, EOD_MARKET_DATABASE_ID: source, EOD_STORAGE_SOURCE_DATABASE_ID: source,
        EOD_STORAGE_TARGET_DATABASE_ID: targetId, EOD_STORAGE_MIGRATION_ID: migrationId, EOD_STORAGE_SESSION_DATE: sessionDate });
  };
  const config = readFileSync(resolve(root, "worker/wrangler.toml"), "utf8");
  const configHash = digest(config);
  const value = (text: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
  if (value(config, "name") !== workerName || value(config, "EOD_RUNNER_MODE") !== "shadow"
    || value(config, "EOD_READ_ENABLED") !== "false") throw new Error("storage-start-local-worker-config-mismatch");
  for (const [name, expected] of [["MARKET_DATA_DB", source], ["MARKET_HISTORY_DB", history], ["OPS_DB", ops]]) {
    const blocks = config.split("[[d1_databases]]").slice(1).map((block) => block.split(/^\[/m)[0]!)
      .filter((block) => value(block, "binding") === name);
    if (blocks.length !== 1 || value(blocks[0]!, "database_id") !== expected) throw new Error("storage-start-local-binding-mismatch");
  }
  try {
    const result = await startStorageMigrationOnce({ accountId, sourceDatabaseId: source, historyDatabaseId: history,
      opsDatabaseId: ops, migrationId, targetName, sessionDate, codeRevision, analysis, tickers: frozen.tickers, snapshotSource }, {
      assertCheckout: async () => {
        if (command("git", ["rev-parse", "HEAD"], "checkout") !== codeRevision
          || command("git", ["branch", "--show-current"], "checkout") !== "main"
          || command("git", ["status", "--porcelain", "--untracked-files=no"], "checkout")) throw new Error("storage-start-checkout-changed");
        for (const [file, expected] of files) if (digest(readFileSync(file, "utf8")) !== expected) throw new Error("storage-start-evidence-changed");
        if (digest(readFileSync(resolve(root, "worker/wrangler.toml"), "utf8")) !== configHash) throw new Error("storage-start-worker-config-changed");
      },
      inspectSource: async () => {
        const coordinatorMigrationId = await sourceBindings(null);
        const fence = await sourceDb.prepare("SELECT status,migration_id,code_revision FROM market_storage_fence WHERE id='default'")
          .first<{ status: string; migration_id: string | null; code_revision: string | null }>();
        if (!fence || (fence.status !== "open" && (fence.migration_id !== migrationId || fence.code_revision !== codeRevision))) {
          throw new Error("storage-start-source-fence-conflict");
        }
        return { coordinatorMigrationId, schemaHash: (await prepareStorageSourceFence(sourceDb)).schemaHash };
      },
      listDatabases: async () => {
        // Free accounts fit one bounded page. Reject truncated/unknown inventory.
        const body = await request("d1/database?per_page=100&page=1"), info = object(body.result_info);
        if (!Array.isArray(body.result) || body.result.length >= 100 || info?.total_count !== body.result.length || info.page !== 1) {
          throw new Error("storage-start-account-inventory-incomplete");
        }
        return body.result.map((value) => {
          const row = object(value);
          if (!row || typeof row.uuid !== "string" || typeof row.name !== "string" || typeof row.file_size !== "number") {
            throw new Error("storage-start-account-inventory-invalid");
          }
          return { id: row.uuid, name: row.name, bytes: row.file_size };
        });
      },
      verifyGitHub: async () => {
        const remote = object(ghJson(`repos/${repository}/git/ref/heads/main`));
        if (object(remote?.object)?.sha !== codeRevision) throw new Error("storage-start-github-main-revision-mismatch");
        const body = object(ghJson(`repos/${repository}/environments/market-eod/variables?per_page=100`));
        if (!Array.isArray(body?.variables) || body.total_count !== body.variables.length) throw new Error("storage-start-github-variables-incomplete");
        const vars = new Map(body.variables.map((row) => { const item = object(row); return [String(item?.name), String(item?.value)]; }));
        for (const [name, expected] of [["CLOUDFLARE_ACCOUNT_ID", accountId], ["EOD_MARKET_DATABASE_ID", source],
          ["EOD_HISTORY_DATABASE_ID", history], ["EOD_OPS_DATABASE_ID", ops]]) if (vars.get(name) !== expected) throw new Error("storage-start-github-canonical-bindings-mismatch");
        if ((vars.has("EOD_STORAGE_SOURCE_DATABASE_ID") && vars.get("EOD_STORAGE_SOURCE_DATABASE_ID") !== source)
          || (vars.has("EOD_RUNNER_MODE") && vars.get("EOD_RUNNER_MODE") !== "shadow")) throw new Error("storage-start-github-mode-or-source-conflict");
        return { targetDatabaseId: vars.get("EOD_STORAGE_TARGET_DATABASE_ID") || null, codeRevision: vars.get("EOD_STORAGE_CODE_REVISION") || null };
      },
      createDatabase: async (name) => {
        const row = object((await request("d1/database", { method: "POST", body: JSON.stringify({ name }) })).result);
        if (!row || typeof row.uuid !== "string" || row.name !== name) throw new Error("storage-start-created-target-invalid");
        return { id: row.uuid, name, bytes: typeof row.file_size === "number" ? row.file_size : 0 } satisfies StorageStartDatabase;
      },
      loadRun: (id) => loadStorageMigration(opsDb, id),
      assertEmptyTarget: async (id) => {
        targetId = id; if (!allowedDatabaseIds.includes(id)) allowedDatabaseIds.push(id);
        const rows = await database(id).prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' LIMIT 1").all();
        if (rows.results.length) throw new Error("storage-start-existing-target-not-empty");
      },
      createRun: async (identity) => { targetId = identity.targetDatabaseId; migrationCommand("create"); },
      initializeHistory: async () => {
        const text = readFileSync(resolve(root, "worker/history-migrations/0002_market_storage_fence.sql"), "utf8");
        const ddl = text.replace(/^--.*$/gm, "").split(";").map((sql) => sql.trim()).filter(Boolean);
        if (ddl.length !== 2 || !ddl[0]!.startsWith("CREATE TABLE IF NOT EXISTS market_storage_fence")
          || ddl[1] !== "INSERT INTO market_storage_fence(id) VALUES('default') ON CONFLICT(id) DO NOTHING") throw new Error("storage-start-history-migration-unreviewed");
        const createLedger = "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";
        const statements = [ddl[0]!, ddl[1]!, createLedger].map((sql) => `${sql} /* storage-reviewed-ddl */`);
        const historyDb = database(history, statements);
        const existing = await historyDb.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='market_storage_fence'").first<{ sql: string }>();
        if (existing) {
          if (!storageStartHistoryFenceSchemaMatches(existing.sql, ddl[0]!)) throw new Error("storage-start-history-fence-schema-changed");
          const state = await historyDb.prepare("SELECT status FROM market_storage_fence WHERE id='default'").first<{ status: string }>();
          if (state?.status !== "open") throw new Error("storage-start-history-fence-not-open");
        }
        await historyDb.batch([...statements.map((sql) => historyDb.prepare(sql)), historyDb.prepare(
          "INSERT INTO d1_migrations(name) VALUES('0002_market_storage_fence.sql') ON CONFLICT(name) DO NOTHING")]);
        const fence = await historyDb.prepare("SELECT status FROM market_storage_fence WHERE id='default'").first<{ status: string }>();
        if (fence?.status !== "open") throw new Error("storage-start-history-fence-not-open");
        if (!await historyDb.prepare("SELECT name FROM d1_migrations WHERE name='0002_market_storage_fence.sql'").first()) throw new Error("storage-start-history-migration-ledger-missing");
      },
      authorizeRun: async (identity) => { targetId = identity.targetDatabaseId; migrationCommand("authorize"); },
      configureGitHub: async (sourceDatabaseId, targetDatabaseId, revision) => {
        for (const [name, value] of [["EOD_STORAGE_SOURCE_DATABASE_ID", sourceDatabaseId], ["EOD_STORAGE_TARGET_DATABASE_ID", targetDatabaseId],
          ["EOD_STORAGE_CODE_REVISION", revision]]) gh(["variable", "set", name, "--env", "market-eod", "--repo", repository, "--body", value]);
      },
      deployCoordinator: async (id) => {
        const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
        command(process.execPath, [wrangler, "whoami"], "wrangler-auth", process.env, resolve(root, "worker"));
        command(process.execPath, [wrangler, "deploy", "--keep-vars", "--var", `EOD_STORAGE_MIGRATION_ID:${id}`,
          "--var", `EOD_CODE_REVISION:${codeRevision}`],
          "coordinator-deploy", process.env, resolve(root, "worker"));
      },
      verifyCoordinator: async (id) => { await sourceBindings(id); },
      dispatch: async (id) => { gh(["workflow", "run", "eod-storage-migration.yml", "--ref", "main", "--repo", repository, "-f", `migration_id=${id}`]); },
      journal: async (status, detail) => {
        writeFileSync(resolve(root, "worker/tmp/storage-start-once.json"), JSON.stringify({ status, ...detail, codeRevision, updatedAt: new Date().toISOString(), diagnosticOnly: true }));
      },
    });
    console.log(JSON.stringify(result));
  } finally { await admission.flush(); }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const reason = /^storage-(?:start|preflight)-[a-z-]+(?::[A-Z_]+)?$/.test(message) ? message
    : /quota|budget|capacity/i.test(message) ? "storage-start-resource-budget" : "storage-start-stopped";
  console.error(JSON.stringify({ status: "paused", reason, publicCutover: false })); process.exitCode = 1;
});
