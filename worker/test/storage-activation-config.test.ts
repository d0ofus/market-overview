import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { buildStorageActivationConfig } from "../scripts/storage-activation-config";

const workerDirectory = resolve(import.meta.dirname, ".."), trackedToml = readFileSync(resolve(workerDirectory, "wrangler.toml"), "utf8");
const original = parse(trackedToml) as Record<string, unknown>;
const dbs = original.d1_databases as Array<{ binding: string; database_id: string }>;
const database = (name: string) => dbs.find((row) => row.binding === name)!.database_id;
const input = { trackedToml, workerDirectory, workerName: String(original.name), accountId: "a".repeat(32), targetDatabaseName: "market-prices-eod-test",
  identity: { id: "market-storage:test", sourceDatabaseId: database("MARKET_DATA_DB"), targetDatabaseId: "10000000-0000-4000-8000-000000000002",
    historyDatabaseId: database("MARKET_HISTORY_DB"), codeRevision: "b".repeat(40), sessionDate: "2026-09-08" }, opsDatabaseId: database("OPS_DB") };
describe("exact production activation configuration", () => {
  it("preserves full queues, cron, Worker name, auxiliary DBs and settings", () => {
    const { config, text } = buildStorageActivationConfig(input);
    expect(JSON.parse(text)).toEqual(config); expect(config.name).toBe(original.name);
    expect(config.queues).toEqual(original.queues); expect(config.triggers).toEqual(original.triggers);
    expect(config.compatibility_date).toEqual(original.compatibility_date);
    expect(config.vars).toEqual({ ...(original.vars as Record<string, string>), EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true",
      EOD_ARCHIVE_PRUNE_ENABLED: "false", EOD_CODE_REVISION: input.identity.codeRevision, EOD_STORAGE_MIGRATION_ID: input.identity.id });
    const actual = config.d1_databases as Array<Record<string, unknown>>;
    expect(actual.find((row) => row.binding === "MARKET_DATA_DB")).toMatchObject({ database_id: input.identity.targetDatabaseId, database_name: input.targetDatabaseName });
    for (const row of actual.filter((row) => row.binding !== "MARKET_DATA_DB")) expect(row.database_id).toBe(database(String(row.binding)));
    expect(readFileSync(resolve(workerDirectory, "wrangler.toml"), "utf8")).toBe(trackedToml);
  });
  it("rebases entry point and every migration directory for a temporary config", () => {
    const { config } = buildStorageActivationConfig(input);
    expect(config.main).toBe(resolve(workerDirectory, String(original.main)).replace(/\\/g, "/"));
    for (const row of config.d1_databases as Array<Record<string, unknown>>) {
      if (row.migrations_dir) expect(String(row.migrations_dir)).toMatch(/(?:^[A-Z]:\/|^\/).*migrations$/i);
    }
  });
  it("fails closed on a changed Worker, source bindings, modes, duplicate TOML or unreviewed path configuration", () => {
    for (const changed of [trackedToml.replace(`name = "${original.name}"`, 'name = "other-worker"'),
      trackedToml.replace(database("MARKET_DATA_DB"), input.identity.targetDatabaseId),
      trackedToml.replace('EOD_READ_ENABLED = "false"', 'EOD_READ_ENABLED = "true"'),
      `main = "other.ts"\n${trackedToml}`, `[build]\ncwd = "../other"\n${trackedToml}`]) {
      expect(() => buildStorageActivationConfig({ ...input, trackedToml: changed })).toThrow();
    }
  });
});
