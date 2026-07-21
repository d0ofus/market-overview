import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOldOverviewSnapshots } from "../src/eod";

type SnapshotMetaRow = {
  id: string;
  config_id: string;
  as_of_date: string;
  generated_at: string;
};

type SnapshotRow = {
  snapshot_id: string;
  ticker: string;
};

type OverviewGenerationRow = {
  id: string;
  as_of_date: string;
  generated_at: string;
};

function createEnv(state: {
  snapshotsMeta: SnapshotMetaRow[];
  snapshotRows: SnapshotRow[];
  overviewGenerations?: OverviewGenerationRow[];
  pointedGenerationIds?: string[];
}) {
  state.overviewGenerations ??= [];
  state.pointedGenerationIds ??= [];
  function execute(sql: string, boundArgs: unknown[]) {
    const normalizedSql = sql.replace(/\s+/g, " ").trim();
    return {
      async all<T>() {
        if (sql.includes("SELECT sm.id as id") && sql.includes("FROM snapshots_meta sm")) {
          const cutoffDate = String(boundArgs[0] ?? "");
          const latestByConfig = new Map<string, string>();
          for (const row of state.snapshotsMeta) {
            const current = latestByConfig.get(row.config_id);
            if (!current || row.as_of_date > current) {
              latestByConfig.set(row.config_id, row.as_of_date);
            }
          }
          const results = state.snapshotsMeta
            .filter((row) => (
              row.as_of_date < cutoffDate
              && latestByConfig.get(row.config_id) !== row.as_of_date
              && !state.pointedGenerationIds!.includes(row.id)
            ))
            .sort((left, right) => left.generated_at.localeCompare(right.generated_at))
            .map((row) => ({ id: row.id })) as T[];
          return { results };
        }
        if (sql.includes("SELECT g.id as id") && sql.includes("FROM overview_generations g")) {
          const cutoffDate = String(boundArgs[0] ?? "");
          const snapshotIds = new Set(state.snapshotsMeta.map((row) => row.id));
          const pointedIds = new Set(state.pointedGenerationIds);
          const results = state.overviewGenerations!
            .filter((row) => row.as_of_date < cutoffDate && !snapshotIds.has(row.id) && !pointedIds.has(row.id))
            .sort((left, right) => left.generated_at.localeCompare(right.generated_at))
            .map((row) => ({ id: row.id })) as T[];
          return { results };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        if (normalizedSql.includes("SELECT COUNT(*) as count FROM snapshot_rows WHERE snapshot_id NOT IN")) {
          const snapshotIds = new Set([
            ...state.snapshotsMeta.map((row) => row.id),
            ...state.overviewGenerations!.map((row) => row.id),
          ]);
          return {
            count: state.snapshotRows.filter((row) => !snapshotIds.has(row.snapshot_id)).length,
          } as T;
        }
        if (normalizedSql.includes("SELECT COUNT(*) as count FROM snapshot_rows")) {
          const snapshotIds = new Set(boundArgs.map((value) => String(value)));
          return {
            count: state.snapshotRows.filter((row) => snapshotIds.has(row.snapshot_id)).length,
          } as T;
        }
        return null as T;
      },
      async run() {
        if (normalizedSql.includes("DELETE FROM snapshot_rows WHERE snapshot_id NOT IN")) {
          const snapshotIds = new Set([
            ...state.snapshotsMeta.map((row) => row.id),
            ...state.overviewGenerations!.map((row) => row.id),
          ]);
          state.snapshotRows = state.snapshotRows.filter((row) => snapshotIds.has(row.snapshot_id));
          return { success: true };
        }
        if (sql.includes("DELETE FROM snapshot_rows")) {
          const snapshotIds = new Set(boundArgs.map((value) => String(value)));
          state.snapshotRows = state.snapshotRows.filter((row) => !snapshotIds.has(row.snapshot_id));
          return { success: true };
        }
        if (sql.includes("DELETE FROM snapshots_meta")) {
          const snapshotIds = new Set(boundArgs.map((value) => String(value)));
          state.snapshotsMeta = state.snapshotsMeta.filter((row) => !snapshotIds.has(row.id));
          return { success: true };
        }
        if (sql.includes("DELETE FROM overview_generations")) {
          const snapshotIds = new Set(boundArgs.map((value) => String(value)));
          const pointedIds = new Set(state.pointedGenerationIds);
          state.overviewGenerations = state.overviewGenerations!.filter(
            (row) => !snapshotIds.has(row.id) || pointedIds.has(row.id),
          );
          return { success: true };
        }
        return { success: true };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      const base = execute(sql, []);
      return {
        ...base,
        bind(...args: unknown[]) {
          return execute(sql, args);
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const statement of statements) {
        await statement.run();
      }
      return [];
    },
  };

  return {
    DB: db as unknown as D1Database,
    state,
  };
}

describe("cleanupOldOverviewSnapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes only stale overview snapshots while preserving latest-per-config rows", async () => {
    const env = createEnv({
      snapshotsMeta: [
        { id: "a-old", config_id: "default", as_of_date: "2026-03-20", generated_at: "2026-03-20T00:00:00.000Z" },
        { id: "a-mid", config_id: "default", as_of_date: "2026-04-05", generated_at: "2026-04-05T00:00:00.000Z" },
        { id: "a-latest", config_id: "default", as_of_date: "2026-04-20", generated_at: "2026-04-20T00:00:00.000Z" },
        { id: "b-latest-old", config_id: "alt", as_of_date: "2026-03-10", generated_at: "2026-03-10T00:00:00.000Z" },
        { id: "c-recent", config_id: "swing", as_of_date: "2026-04-12", generated_at: "2026-04-12T00:00:00.000Z" },
        { id: "c-latest", config_id: "swing", as_of_date: "2026-04-18", generated_at: "2026-04-18T00:00:00.000Z" },
      ],
      snapshotRows: [
        { snapshot_id: "a-old", ticker: "SPY" },
        { snapshot_id: "a-old", ticker: "QQQ" },
        { snapshot_id: "a-mid", ticker: "IWM" },
        { snapshot_id: "a-latest", ticker: "DIA" },
        { snapshot_id: "b-latest-old", ticker: "XLF" },
        { snapshot_id: "c-recent", ticker: "XLE" },
        { snapshot_id: "c-latest", ticker: "XLK" },
        { snapshot_id: "orphan-1", ticker: "TLT" },
        { snapshot_id: "orphan-2", ticker: "GLD" },
      ],
    });

    const result = await cleanupOldOverviewSnapshots(env as never);

    expect(result).toEqual({
      cutoffDate: "2026-04-08",
      deletedSnapshots: 2,
      deletedRows: 5,
      deletedOrphanRows: 2,
    });
    expect(env.state.snapshotsMeta.map((row) => row.id)).toEqual(["a-latest", "b-latest-old", "c-recent", "c-latest"]);
    expect(env.state.snapshotRows.map((row) => row.snapshot_id)).toEqual(["a-latest", "b-latest-old", "c-recent", "c-latest"]);
  });

  it("does nothing when there are no stale snapshots eligible for deletion", async () => {
    const env = createEnv({
      snapshotsMeta: [
        { id: "default-latest", config_id: "default", as_of_date: "2026-04-20", generated_at: "2026-04-20T00:00:00.000Z" },
        { id: "alt-latest", config_id: "alt", as_of_date: "2026-03-10", generated_at: "2026-03-10T00:00:00.000Z" },
      ],
      snapshotRows: [
        { snapshot_id: "default-latest", ticker: "SPY" },
        { snapshot_id: "alt-latest", ticker: "QQQ" },
      ],
    });

    const result = await cleanupOldOverviewSnapshots(env as never);

    expect(result).toEqual({
      cutoffDate: "2026-04-08",
      deletedSnapshots: 0,
      deletedRows: 0,
      deletedOrphanRows: 0,
    });
    expect(env.state.snapshotsMeta).toHaveLength(2);
    expect(env.state.snapshotRows).toHaveLength(2);
  });

  it("prunes superseded immutable generations but preserves the pointer and recent rows", async () => {
    const env = createEnv({
      snapshotsMeta: [],
      overviewGenerations: [
        { id: "stale-superseded", as_of_date: "2026-03-20", generated_at: "2026-03-20T20:00:00Z" },
        { id: "stale-pointed", as_of_date: "2026-03-20", generated_at: "2026-03-20T21:00:00Z" },
        { id: "recent", as_of_date: "2026-04-20", generated_at: "2026-04-20T20:00:00Z" },
      ],
      pointedGenerationIds: ["stale-pointed"],
      snapshotRows: [
        { snapshot_id: "stale-superseded", ticker: "SPY" },
        { snapshot_id: "stale-pointed", ticker: "QQQ" },
        { snapshot_id: "recent", ticker: "IWM" },
      ],
    });

    const result = await cleanupOldOverviewSnapshots(env as never);

    expect(result).toEqual({
      cutoffDate: "2026-04-08",
      deletedSnapshots: 1,
      deletedRows: 1,
      deletedOrphanRows: 0,
    });
    expect(env.state.overviewGenerations!.map((row) => row.id)).toEqual(["stale-pointed", "recent"]);
    expect(env.state.snapshotRows.map((row) => row.snapshot_id)).toEqual(["stale-pointed", "recent"]);
  });

  it("preserves a pointed last-ready snapshot after an explicit rollback", async () => {
    const env = createEnv({
      snapshotsMeta: [
        { id: "rollback-target", config_id: "default", as_of_date: "2026-03-20", generated_at: "2026-03-20T20:00:00Z" },
        { id: "newer", config_id: "default", as_of_date: "2026-04-20", generated_at: "2026-04-20T20:00:00Z" },
      ],
      overviewGenerations: [
        { id: "rollback-target", as_of_date: "2026-03-20", generated_at: "2026-03-20T20:00:00Z" },
        { id: "newer", as_of_date: "2026-04-20", generated_at: "2026-04-20T20:00:00Z" },
      ],
      pointedGenerationIds: ["rollback-target"],
      snapshotRows: [
        { snapshot_id: "rollback-target", ticker: "SPY" },
        { snapshot_id: "newer", ticker: "QQQ" },
      ],
    });

    const result = await cleanupOldOverviewSnapshots(env as never);

    expect(result.deletedSnapshots).toBe(0);
    expect(env.state.snapshotsMeta.map((row) => row.id)).toEqual(["rollback-target", "newer"]);
    expect(env.state.snapshotRows.map((row) => row.snapshot_id)).toEqual(["rollback-target", "newer"]);
  });
});
