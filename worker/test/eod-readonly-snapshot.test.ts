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

class MalformedStoredSnapshotDb extends ReadOnlySnapshotDb {
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
          return {
            id: "snapshot-1",
            asOfDate: "2026-06-12",
            generatedAt: "2026-06-12T22:00:00.000Z",
            providerLabel: "Alpaca snapshots + stored daily bars",
            expectedAsOfDate: "2026-06-12",
            freshnessStatus: "fresh",
            freshnessCurrentCount: 1,
            freshnessEligibleCount: 1,
            freshnessCoveragePct: 100,
            freshnessCriticalMissingJson: "[]",
            freshnessMinBarDate: "2026-06-12",
            freshnessMaxBarDate: "2026-06-12",
            freshnessWarning: null,
            quoteOverlayRequestedCount: 1,
            quoteOverlayReturnedCount: 1,
            quoteOverlayError: null,
            quoteOverlayMissingSampleJson: "[]",
          } as T;
        }
        return null as T;
      },
      all: async <T>() => {
        if (sql.includes("FROM dashboard_groups")) {
          return {
            results: [{
              id: "g-sector-etf",
              sectionId: "sec-equities",
              title: "Sector ETFs",
              sort_order: 1,
              dataType: "equities",
              rankingWindowDefault: "1D",
              showSparkline: 1,
              pinTop10: 0,
            }] as T[],
          };
        }
        if (sql.includes("FROM dashboard_sections")) {
          return {
            results: [{
              id: "sec-equities",
              title: "02 Equities Overview",
              description: "Equities overview",
              isCollapsible: 1,
              defaultCollapsed: 0,
              sort_order: 1,
            }] as T[],
          };
        }
        if (sql.includes("FROM dashboard_items")) {
          return {
            results: [{
              id: "item-spy",
              groupId: "g-sector-etf",
              sort_order: 1,
              ticker: "SPY",
              displayName: "SPY",
              enabled: 1,
              tagsJson: "[]",
              holdingsJson: null,
            }] as T[],
          };
        }
        if (sql.includes("FROM dashboard_columns")) {
          return { results: [{ groupId: "g-sector-etf", columnsJson: JSON.stringify(["ticker", "name", "price", "1D"]) }] as T[] };
        }
        if (sql.includes("FROM snapshot_rows")) {
          return {
            results: [{
              sectionId: "sec-equities",
              groupId: "g-sector-etf",
              ticker: "SPY",
              displayName: "SPY",
              price: 500,
              change1d: 1.25,
              change1w: 2,
              change5d: 2,
              change21d: 4,
              ytd: 10,
              pctFrom52wHigh: -1,
              sparklineJson: "not-json",
              rankKey: 1.25,
              holdingsJson: "{not-json",
              barDate: "2026-06-12",
              quotePrice: null,
              quotePrevClose: null,
              quoteChange1d: null,
              quoteSource: null,
              quoteFetchedAt: null,
              quoteFreshnessStatus: null,
              quoteFreshnessReason: null,
              barFreshnessStatus: null,
              barFreshnessReason: null,
            }] as T[],
          };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        throw new Error("Stored snapshot load should not write to D1.");
      },
    };
    return statement;
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
      warning: "No stored overview snapshot is available. Use Refresh Overview Data to generate one.",
      asOfDate: null,
      generatedAt: null,
      providerLabel: null,
      expectedAsOfDate: expect.any(String),
      freshnessStatus: "stale",
      freshnessCoveragePct: 0,
      freshnessCurrentCount: 0,
      freshnessEligibleCount: 0,
      freshnessCriticalMissingTickers: [],
      freshnessMinBarDate: null,
      freshnessMaxBarDate: null,
      freshnessWarning: "No stored overview snapshot is available. Use Refresh Overview Data to generate one.",
      quoteOverlayRequestedCount: null,
      quoteOverlayReturnedCount: null,
      quoteOverlayError: null,
      quoteOverlayMissingSample: [],
      config: null,
      sections: [],
    });
    expect(db.statements.some((sql) => sql.includes("daily_bars"))).toBe(false);
    expect(db.statements.some((sql) => sql.includes("snapshot_rows"))).toBe(false);
  });

  it("falls back safely when stored snapshot JSON is malformed", async () => {
    const db = new MalformedStoredSnapshotDb();

    const snapshot = await loadSnapshot(createEnv(db), "default", "2026-06-12", { allowComputeOnMissing: false });
    const row = snapshot.sections[0]?.groups[0]?.rows[0];

    expect(snapshot.status).toBeUndefined();
    expect(row?.ticker).toBe("SPY");
    expect(row?.sparkline).toEqual([]);
    expect(row?.holdings).toBeNull();
    expect(row?.change3m).toBeNull();
    expect(row?.change6m).toBeNull();
    expect(snapshot.freshnessWarning).toContain("Snapshot derived metrics are unavailable");
    expect(db.statements.some((sql) => sql.includes("daily_bars"))).toBe(false);
  });
});
