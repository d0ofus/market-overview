import { describe, expect, it } from "vitest";
import { loadDatabaseCapacity, sampleDatabaseCapacity } from "../src/database-capacity-service";
import worker from "../src/index";
import type { Env } from "../src/types";
import { assertMarketDataCapacity } from "../src/market-data-db";

function fakeDb(sizeAfter: number | Error, inserts: unknown[][] = []): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async all<T>() {
          if (sizeAfter instanceof Error) throw sizeAfter;
          return { results: [{ ok: 1 }] as T[], meta: { size_after: sizeAfter } };
        },
        async run() {
          if (sql.includes("capacity_health_samples")) inserts.push(bound);
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return await Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
}

describe("database capacity health", () => {
  it.each([
    { size: 500_000_000, level: "ok" },
    { size: 1_750_000_000, level: "warning" },
    { size: 1_900_000_000, level: "critical" },
    { size: 2_000_000_000, level: "halt" },
  ])("applies the Paid policy consistently to recent prices, archive health and native writers at $size", async ({ size, level }) => {
    const env = { DB: fakeDb(20_000_000), MARKET_DATA_DB: fakeDb(size), MARKET_HISTORY_DB: fakeDb(size),
      OPS_DB: fakeDb(10_000_000), EOD_BUDGET_PROFILE: "paid",
      MARKET_DATA_WARN_BYTES: "350000000", MARKET_DATA_HALT_BYTES: "425000000" } as Env;
    const statuses = await loadDatabaseCapacity(env);
    for (const database of ["market", "history"]) {
      expect(statuses.find(row => row.database === database)).toMatchObject({ level, haltBytes: 2_000_000_000 });
    }
    if (level === "halt") await expect(assertMarketDataCapacity(env)).rejects.toThrow("capacity halt");
    else await expect(assertMarketDataCapacity(env)).resolves.toBeUndefined();
  });

  it.each([
    { size: 30_000_000, level: "ok", status: 200 },
    { size: 351_000_000, level: "warning", status: 200 },
    { size: 401_000_000, level: "critical", status: 503 },
    { size: 426_000_000, level: "halt", status: 503 },
  ])("exposes archive $level diagnostics without changing HTTP $status", async ({ size, level, status }) => {
    const env = {
      DB: fakeDb(20_000_000), MARKET_DATA_DB: fakeDb(30_000_000), OPS_DB: fakeDb(10_000_000),
      MARKET_HISTORY_DB: fakeDb(size), MARKET_PIPELINE_MODE: "canary", EOD_RUNNER_MODE: "disabled",
    } as Env;
    const response = await worker.fetch(new Request("https://example.com/api/health"), env, {} as ExecutionContext);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      ok: status === 200,
      pipelineMode: "canary",
      databases: { history: { database: "history", sizeBytes: size, level, ok: true } },
    });
  });

  it("identifies archive connectivity failure in the existing unhealthy response", async () => {
    const env = {
      DB: fakeDb(20_000_000), MARKET_DATA_DB: fakeDb(30_000_000), OPS_DB: fakeDb(10_000_000),
      MARKET_HISTORY_DB: fakeDb(new Error("Provider error containing private details")),
    } as Env;
    const response = await worker.fetch(new Request("https://example.com/api/health"), env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: false, databases: {
      history: { database: "history", ok: false, sizeBytes: null, level: "unavailable", errorCode: "storage-unavailable" },
    } });
    expect(JSON.stringify(payload)).not.toContain("private details");
  });

  it("preserves the original database response when no archive is bound", async () => {
    const env = {
      DB: fakeDb(20_000_000), MARKET_DATA_DB: fakeDb(30_000_000), OPS_DB: fakeDb(10_000_000),
    } as Env;
    const response = await worker.fetch(new Request("https://example.com/api/health"), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const payload = await response.json() as { databases: Record<string, unknown> };
    expect(Object.keys(payload.databases)).toEqual(["core", "market", "ops"]);
  });

  it("includes the archive in reserved capacity sampling when it is bound",async () => {
    const inserts:unknown[][]=[];
    const env={DB:fakeDb(20_000_000),MARKET_DATA_DB:fakeDb(30_000_000),OPS_DB:fakeDb(10_000_000,inserts),
      MARKET_HISTORY_DB:fakeDb(351_000_000)} as Env;
    const statuses=await sampleDatabaseCapacity(env,new Date("2026-09-08T00:05:00Z"));
    expect(statuses.find((row) => row.database==="history")).toMatchObject({sizeBytes:351_000_000,level:"warning"});
    expect(inserts.map((row) => row[1])).toEqual(["core","market","ops","history"]);
  });
  it("applies separate warning, critical, and halt thresholds", async () => {
    const env = {
      DB: fakeDb(351_000_000),
      MARKET_DATA_DB: fakeDb(401_000_000),
      MARKET_DATA_DB_REQUIRED: "true",
      OPS_DB: fakeDb(101_000_000),
      OPS_DB_REQUIRED: "true",
    } as Env;

    const statuses = await loadDatabaseCapacity(env);
    expect(statuses.map((status) => [status.database, status.level])).toEqual([
      ["core", "warning"],
      ["market", "critical"],
      ["ops", "warning"],
    ]);
  });

  it("records one sanitized sample per database in OPS_DB", async () => {
    const inserts: unknown[][] = [];
    const opsDb = fakeDb(10_000_000, inserts);
    const env = {
      DB: fakeDb(20_000_000),
      MARKET_DATA_DB: fakeDb(30_000_000),
      MARKET_DATA_DB_REQUIRED: "true",
      OPS_DB: opsDb,
      OPS_DB_REQUIRED: "true",
    } as Env;

    const statuses = await sampleDatabaseCapacity(env, new Date("2026-08-27T00:05:00Z"));
    expect(statuses).toHaveLength(3);
    expect(inserts).toHaveLength(3);
    expect(inserts.map((row) => row[1])).toEqual(["core", "market", "ops"]);
  });
});
