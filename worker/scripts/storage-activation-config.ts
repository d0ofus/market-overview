import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import type { StorageMigrationIdentity } from "../src/market-storage-control";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Generates an isolated JSONC config from the complete reviewed production
 * TOML. Source files remain unchanged; no secrets are read or written here. */
export function buildStorageActivationConfig(input: {
  trackedToml: string; workerDirectory: string; workerName: string; accountId: string;
  identity: StorageMigrationIdentity; opsDatabaseId: string; targetDatabaseName: string;
}): { text: string; config: Record<string, unknown> } {
  const config = parse(input.trackedToml) as Record<string, unknown>;
  const allowed = new Set(["name", "main", "compatibility_date", "compatibility_flags", "account_id", "vars", "queues", "d1_databases",
    "triggers", "observability", "limits", "placement", "workers_dev", "preview_urls", "routes", "route", "logpush", "send_metrics"]);
  if (Object.keys(config).some((key) => !allowed.has(key)) || config.name !== input.workerName
    || (config.account_id !== undefined && config.account_id !== input.accountId)
    || !/^[a-f0-9]{32}$/.test(input.accountId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.targetDatabaseName)
    || typeof config.main !== "string" || !config.main || !isAbsolute(input.workerDirectory)) throw new Error("storage-activate-config-unreviewed");
  const vars = record(config.vars);
  if (!vars || vars.EOD_RUNNER_MODE !== "shadow" || vars.EOD_READ_ENABLED !== "false" || vars.EOD_ARCHIVE_PRUNE_ENABLED !== "false") {
    throw new Error("storage-activate-config-source-mode-mismatch");
  }
  if (!Array.isArray(config.d1_databases)) throw new Error("storage-activate-config-databases-missing");
  const databases = config.d1_databases.map(record);
  if (databases.some((row) => !row) || new Set(databases.map((row) => row!.binding)).size !== databases.length) throw new Error("storage-activate-config-databases-ambiguous");
  for (const [binding, expected] of [["MARKET_DATA_DB", input.identity.sourceDatabaseId], ["MARKET_HISTORY_DB", input.identity.historyDatabaseId], ["OPS_DB", input.opsDatabaseId]]) {
    const row = databases.find((value) => value!.binding === binding);
    if (!row || row.database_id !== expected) throw new Error("storage-activate-config-source-binding-mismatch");
  }
  config.account_id = input.accountId;
  config.main = resolve(input.workerDirectory, config.main).replace(/\\/g, "/");
  for (const row of databases) {
    if (row!.migrations_dir !== undefined) {
      if (typeof row!.migrations_dir !== "string" || !row!.migrations_dir) throw new Error("storage-activate-config-migrations-path-invalid");
      row!.migrations_dir = resolve(input.workerDirectory, row!.migrations_dir as string).replace(/\\/g, "/");
    }
    if (row!.binding === "MARKET_DATA_DB") {
      row!.database_id = input.identity.targetDatabaseId; row!.database_name = input.targetDatabaseName;
    }
  }
  Object.assign(vars, { EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "false",
    EOD_CODE_REVISION: input.identity.codeRevision, EOD_STORAGE_MIGRATION_ID: input.identity.id });
  // Queue producers/consumers, cron expressions, auxiliary DBs and all other
  // reviewed runtime options survive the TOML -> JSON transformation intact.
  return { text: JSON.stringify(config, null, 2) + "\n", config };
}
