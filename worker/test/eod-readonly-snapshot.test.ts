import { describe, expect, it } from "vitest";
import { loadSnapshot } from "../src/eod";
import type { Env } from "../src/types";

class ReadOnlySnapshotDb {
  statements: string[] = [];

  prepare(sql: string) {
    this.statements.push(sql);
    const statement = {
      bind: (..._args: unknown[]) => statement,
      first: async <T>() => {
        if (sql.includes("FROM dashboard_configs")) {
          return {
            id: "default",
            name: "Default Swing Dashboard",
            timezone: "Australia/Melbourne",
            eodRunLocalTime: "08:15",
            eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
          } as T;
        }
        if (sql.includes("FROM snapshots_meta")) {
          return null as T;
        }
        return null as T;
      },
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => {
        throw new Error("Read-only snapshot load should not write to D1.");
      },
    };
    return statement;
  }

  async batch() {
    throw new Error("Read-only snapshot load should not batch writes.");
  }
}

function createEnv(db: ReadOnlySnapshotDb): Env {
  return {
    DB: db,
    APP_TIMEZONE: "Australia/Melbourne",
    DATA_PROVIDER: "alpaca",
    ALPACA_FEED: "iex",
  } as unknown as Env;
}

describe("loadSnapshot read-only mode", () => {
  it("returns an empty response instead of computing when no stored snapshot exists", async () => {
    const db = new ReadOnlySnapshotDb();

    const snapshot = await loadSnapshot(createEnv(db), "default", undefined, { allowComputeOnMissing: false });

    expect(snapshot).toEqual({
      status: "empty",
      warning: "No stored overview snapshot is available. Use Admin refresh to generate one.",
      asOfDate: null,
      generatedAt: null,
      providerLabel: null,
      config: null,
      sections: [],
    });
    expect(db.statements.some((sql) => sql.includes("daily_bars"))).toBe(false);
    expect(db.statements.some((sql) => sql.includes("snapshot_rows"))).toBe(false);
  });
});
