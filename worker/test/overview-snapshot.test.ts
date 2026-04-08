import { describe, expect, it } from "vitest";
import { isOverviewSnapshotStale } from "../src/overview-snapshot";

type FakeDbState = {
  snapshotId?: string | null;
  asOfDate?: string | null;
  equalWeightRows?: Array<{ ticker: string; displayName: string | null }>;
  thematicWatchlistRows?: Array<{ ticker: string; fundName: string | null }>;
  thematicSnapshotRows?: Array<{ ticker: string; displayName: string | null }>;
  sparklineRows?: Array<{ groupId: string; ticker: string; sparklineJson: string | null }>;
  barSeries?: Record<string, Array<{ date: string; c: number }>>;
};

function createEnv(state: FakeDbState) {
  function createStatement(sql: string) {
    const execute = {
      async first<T>() {
        if (sql.includes("FROM snapshots_meta")) {
          return (state.snapshotId ? { id: state.snapshotId, asOfDate: state.asOfDate ?? "2026-02-27" } : null) as T;
        }
        return null as T;
      },
      async all<T>() {
        if (sql.includes("JOIN dashboard_groups dg") && sql.includes("dg.title IN")) {
          return { results: (state.thematicSnapshotRows ?? []) as T[] };
        }
        if (sql.includes("FROM snapshot_rows") && sql.includes("display_name as displayName")) {
          return { results: (state.equalWeightRows ?? []) as T[] };
        }
        if (sql.includes("FROM etf_watchlists") && sql.includes("fund_name as fundName")) {
          return { results: (state.thematicWatchlistRows ?? []) as T[] };
        }
        if (sql.includes("FROM snapshot_rows sr") && sql.includes("sparkline_json as sparklineJson")) {
          return { results: (state.sparklineRows ?? []) as T[] };
        }
        if (sql.includes("FROM daily_bars") && sql.includes("ORDER BY ticker, date")) {
          return {
            results: Object.entries(state.barSeries ?? {}).flatMap(([ticker, rows]) =>
              rows.map((row) => ({ ticker, date: row.date, c: row.c })),
            ) as T[],
          };
        }
        return { results: [] as T[] };
      },
    };

    return {
      ...execute,
      bind(..._args: unknown[]) {
        return execute;
      },
    };
  }

  const db = {
    prepare(sql: string) {
      return createStatement(sql);
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
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 90 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, c: i + 1 })),
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
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1)) },
      ],
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(true);
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
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 21 }, (_, i) => ({ date: `2026-02-${String(i + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(false);
  });

  it("marks snapshot stale when any other mature sparkline-enabled overview group is short", async () => {
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
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        EWJ: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(true);
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
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        MSTR: Array.from({ length: 45 }, (_, i) => ({ date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("marks snapshot stale when a short-history ticker is not using all available bars", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-crypto", ticker: "MSTR", sparklineJson: JSON.stringify(Array.from({ length: 21 }, (_, i) => i + 1)) },
      ],
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        MSTR: Array.from({ length: 45 }, (_, i) => ({ date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(true);
  });

  it("keeps snapshot fresh when equal-weight names match and sparkline length is 90", async () => {
    const last90 = Array.from({ length: 90 }, (_, i) => i + 212);
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-market-leaders", ticker: "AAPL", sparklineJson: JSON.stringify(last90) },
        { groupId: "g-global", ticker: "EWJ", sparklineJson: JSON.stringify(last90) },
        { groupId: "g-crypto", ticker: "MSTR", sparklineJson: JSON.stringify(last90) },
        { groupId: "g-us-index", ticker: "NQ1!", sparklineJson: JSON.stringify(last90) },
        { groupId: "g-sector-etf", ticker: "XLE", sparklineJson: JSON.stringify(last90) },
      ],
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        AAPL: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        EWJ: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        MSTR: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        "NQ1!": Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
        XLE: Array.from({ length: 301 }, (_, i) => ({ date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, c: i + 1 })),
      },
    }) as never);

    expect(stale).toBe(false);
  });

  it("marks snapshot stale when the saved sparkline still contains an isolated corrupt bar", async () => {
    const clean = [591.7, 597.64, 602.92, 606.33];
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      sparklineRows: [
        { groupId: "g-us-index", ticker: "SPY", sparklineJson: JSON.stringify([591.7, 597.64, 482.1648070476866, 602.92, 606.33]) },
      ],
      thematicWatchlistRows: [],
      thematicSnapshotRows: [],
      barSeries: {
        SPY: [
          { date: "2025-01-16", c: 591.7 },
          { date: "2025-01-17", c: 597.64 },
          { date: "2025-01-20", c: 482.1648070476866 },
          { date: "2025-01-21", c: 602.92 },
          { date: "2025-01-22", c: 606.33 },
        ],
      },
    }) as never);

    expect(clean).toEqual([591.7, 597.64, 602.92, 606.33]);
    expect(stale).toBe(true);
  });

  it("marks snapshot stale when thematic ETF membership no longer matches the industry watchlist", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      thematicWatchlistRows: [
        { ticker: "XBI", fundName: "SPDR S&P Biotech ETF" },
      ],
      thematicSnapshotRows: [
        { ticker: "NWX", displayName: "Network-1 ETF" },
        { ticker: "XBI", displayName: "SPDR S&P Biotech ETF" },
      ],
      sparklineRows: [],
      barSeries: {},
    }) as never);

    expect(stale).toBe(true);
  });

  it("keeps snapshot fresh when thematic ETF snapshot rows match the industry watchlist", async () => {
    const stale = await isOverviewSnapshotStale(createEnv({
      snapshotId: "snap-1",
      equalWeightRows: [
        {
          ticker: "RSPS",
          displayName: "Consumer Staples Invesco S&P 500 Equal Weight ETF",
        },
      ],
      thematicWatchlistRows: [
        { ticker: "IHI", fundName: "iShares U.S. Medical Devices ETF" },
        { ticker: "XBI", fundName: "SPDR S&P Biotech ETF" },
      ],
      thematicSnapshotRows: [
        { ticker: "XBI", displayName: "SPDR S&P Biotech ETF" },
        { ticker: "IHI", displayName: "iShares U.S. Medical Devices ETF" },
      ],
      sparklineRows: [],
      barSeries: {},
    }) as never);

    expect(stale).toBe(false);
  });
});
