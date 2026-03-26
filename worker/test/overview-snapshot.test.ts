import { describe, expect, it } from "vitest";
import { isOverviewSnapshotStale } from "../src/overview-snapshot";

type FakeDbState = {
  snapshotId?: string | null;
  equalWeightRows?: Array<{ ticker: string; displayName: string | null }>;
  sparklineRows?: Array<{ groupId: string; ticker: string; sparklineJson: string | null }>;
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
              return null as T;
            },
            async all<T>() {
              if (sql.includes("FROM snapshot_rows") && sql.includes("display_name as displayName")) {
                return { results: (state.equalWeightRows ?? []) as T[] };
              }
              if (sql.includes("FROM snapshot_rows sr") && sql.includes("sparkline_json as sparklineJson")) {
                return { results: (state.sparklineRows ?? []) as T[] };
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
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
      ],
    }) as never);

    expect(stale).toBe(true);
  });

  it("keeps snapshot fresh when a ticker has fewer than 90 sparkline points", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1)) },
      ],
    }) as never);

    expect(stale).toBe(false);
  });

  it("keeps snapshot fresh when a newer ticker has very short sparkline history", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 21 }, (_, i) => i + 1)) },
      ],
    }) as never);

    expect(stale).toBe(false);
  });

  it("keeps snapshot fresh when any other sparkline-enabled overview group is short", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-global", ticker: "EWJ", sparklineJson: JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1)) },
      ],
    }) as never);

    expect(stale).toBe(false);
  });

  it("marks snapshot stale when a sparkline-enabled overview row is missing sparkline data", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-crypto", ticker: "MSTR", sparklineJson: null },
      ],
    }) as never);

    expect(stale).toBe(true);
  });

  it("keeps snapshot fresh when equal-weight names match and sparkline length is 90", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-global", ticker: "EWJ", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-crypto", ticker: "MSTR", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-us-index", ticker: "NQ1!", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
        { groupId: "g-sector-etf", ticker: "XLE", sparklineJson: JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)) },
      ],
    }) as never);

    expect(stale).toBe(false);
  });
});
