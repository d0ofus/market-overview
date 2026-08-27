import { describe, expect, it } from "vitest";
import { loadDatabaseCapacity, sampleDatabaseCapacity } from "../src/database-capacity-service";
import type { Env } from "../src/types";

function fakeDb(sizeAfter: number, inserts: unknown[][] = []): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async all<T>() {
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
