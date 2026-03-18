import { describe, expect, it } from "vitest";
import { isOverviewSnapshotStale } from "../src/overview-snapshot";

type FakeDbState = {
  snapshotId?: string | null;
  equalWeightRows?: Array<{ ticker: string; displayName: string | null }>;
  sparklineRows?: Record<string, { sparklineJson: string | null } | undefined>;
};

function createEnv(state: FakeDbState) {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM snapshots_meta")) {
                return (state.snapshotId ? { id: state.snapshotId } : null) as T;
              }
              if (sql.includes("FROM snapshot_rows") && sql.includes("sparkline_json")) {
                const [, groupId, ticker] = args as [string, string, string];
                return (state.sparklineRows?.[`${groupId}|${ticker}`] ?? null) as T;
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes("FROM snapshot_rows") && sql.includes("display_name as displayName")) {
                return { results: (state.equalWeightRows ?? []) as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  return { DB: db as unknown as D1Database } as { DB: D1Database };
}

describe("overview snapshot staleness", () => {
  it("marks snapshot stale when equal-weight names use the old format", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Invesco S&P 500 Equal Weight Consumer Staples ETF",
        },
      ],
      sparklineRows: {
        "g-market-leaders|AAPL": { sparklineJson: JSON.stringify(Array.from({ length: 63 }, (_, i) => i + 1)) },
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("marks snapshot stale when a mature ticker still has a 60-point sparkline", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: {
        "g-market-leaders|AAPL": { sparklineJson: JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1)) },
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("marks snapshot stale when a mature ticker has fewer than 63 sparkline points", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: {
        "g-market-leaders|AAPL": { sparklineJson: JSON.stringify(Array.from({ length: 21 }, (_, i) => i + 1)) },
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("falls back to the US index group when the market leaders sparkline is missing", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: {
        "g-us-index|SPY": { sparklineJson: JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1)) },
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("keeps snapshot fresh when equal-weight names match and sparkline length is 63", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: {
        "g-market-leaders|AAPL": { sparklineJson: JSON.stringify(Array.from({ length: 63 }, (_, i) => i + 1)) },
      },
    }) as never);

    expect(stale).toBe(false);
  });
});
