import { describe, expect, it } from "vitest";
import { loadSnapshot } from "../src/eod";

function isoDateAt(offset: number): string {
  const date = new Date(Date.UTC(2024, 0, 1 + offset));
  return date.toISOString().slice(0, 10);
}

function makeDailyBars(ticker: string, values: number[]) {
  return values.map((value, index) => ({
    ticker,
    date: isoDateAt(index),
    c: value,
    volume: 1000 + index,
  }));
}

function createEnv() {
  const asOfDate = isoDateAt(219);
  const dashboardConfig = {
    id: "default",
    name: "Default Swing Dashboard",
    timezone: "Australia/Melbourne",
    eodRunLocalTime: "08:15",
    eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
  };
  const sections = [
    {
      id: "sec-macro",
      title: "01 Macro Overview",
      description: "Macro overview",
      isCollapsible: 1,
      defaultCollapsed: 0,
      sort_order: 1,
    },
  ];
  const groups = [
    {
      id: "g-crypto",
      sectionId: "sec-macro",
      title: "Crypto Proxies",
      sort_order: 1,
      dataType: "macro",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
  ];
  const items = [
    { id: "item-bito", groupId: "g-crypto", sort_order: 1, ticker: "BITO", displayName: "ProShares Bitcoin Strategy ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-ibit", groupId: "g-crypto", sort_order: 2, ticker: "IBIT", displayName: "iShares Bitcoin Trust", enabled: 1, tagsJson: "[]", holdingsJson: null },
  ];
  const columns = [
    { groupId: "g-crypto", columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]) },
  ];
  const symbolRows = [
    { ticker: "BITO", name: "ProShares Bitcoin Strategy ETF" },
    { ticker: "IBIT", name: "iShares Bitcoin Trust" },
    { ticker: "SPY", name: "SPDR S&P 500 ETF" },
  ];
  const snapshotMeta = {
    id: "snap-sma",
    asOfDate,
    generatedAt: "2025-01-08T00:00:00.000Z",
    providerLabel: "Stored Daily Bars",
  };
  const snapshotRows = [
    {
      sectionId: "sec-macro",
      groupId: "g-crypto",
      ticker: "BITO",
      displayName: "ProShares Bitcoin Strategy ETF",
      price: 120,
      change1d: 20,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([100, 100, 100, 120]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-crypto",
      ticker: "IBIT",
      displayName: "iShares Bitcoin Trust",
      price: 80,
      change1d: -20,
      change1w: -20,
      change5d: -20,
      change21d: -20,
      ytd: -20,
      pctFrom52wHigh: -20,
      sparklineJson: JSON.stringify([100, 100, 100, 80]),
      rankKey: -20,
      holdingsJson: null,
    },
  ];

  const bitoBars = makeDailyBars("BITO", [...Array.from({ length: 219 }, () => 100), 120]);
  const ibitBars = makeDailyBars("IBIT", [...Array.from({ length: 219 }, () => 100), 80]);
  const spyBars = makeDailyBars("SPY", Array.from({ length: 220 }, () => 100));
  const dailyBars = [...bitoBars, ...ibitBars, ...spyBars];

  const db = {
    prepare(sql: string) {
      const runAll = async <T>(args: unknown[]) => {
        if (sql.includes("FROM dashboard_groups")) return { results: groups as T[] };
        if (sql.includes("FROM dashboard_sections WHERE config_id = ?")) return { results: sections as T[] };
        if (sql.includes("FROM dashboard_items ORDER BY sort_order ASC")) return { results: items as T[] };
        if (sql.includes("SELECT ticker, name FROM symbols WHERE ticker IN")) {
          const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
          return { results: symbolRows.filter((row) => requested.has(row.ticker.toUpperCase())) as T[] };
        }
        if (sql.includes("SELECT group_id as groupId, columns_json as columnsJson FROM dashboard_columns")) {
          return { results: columns as T[] };
        }
        if (sql.includes("FROM snapshot_rows WHERE snapshot_id = ? ORDER BY rank_key DESC")) {
          return { results: snapshotRows as T[] };
        }
        if (sql.includes("FROM daily_bars") && sql.includes("ORDER BY ticker, date")) {
          const tickerArgs = (args as string[]).filter((value) => /^[A-Z!.\-]+$/.test(String(value)));
          const requested = new Set(tickerArgs.map((value) => value.toUpperCase()));
          return { results: dailyBars.filter((row) => requested.has(row.ticker.toUpperCase())) as T[] };
        }
        return { results: [] as T[] };
      };
      return {
        async all<T>() {
          return runAll<T>([]);
        },
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM dashboard_configs WHERE id = ?")) return dashboardConfig as T;
              if (sql.includes("FROM snapshots_meta WHERE config_id = ?") && sql.includes("ORDER BY as_of_date DESC, generated_at DESC LIMIT 1")) {
                return snapshotMeta as T;
              }
              return null as T;
            },
            async all<T>() {
              return runAll<T>(args);
            },
          };
        },
      };
    },
  };

  return { DB: db as unknown as D1Database };
}

describe("loadSnapshot SMA status pilot", () => {
  it("computes non-persisted 20SMA, 50SMA, and 200SMA flags from daily bars", async () => {
    const snapshot = await loadSnapshot(createEnv() as never);
    const cryptoGroup = snapshot.sections[0]?.groups.find((group) => group.id === "g-crypto");
    const bitoRow = cryptoGroup?.rows.find((row) => row.ticker === "BITO");
    const ibitRow = cryptoGroup?.rows.find((row) => row.ticker === "IBIT");

    expect(cryptoGroup?.columns).toEqual(["ticker", "name", "price", "1D", "1W", "3M", "6M", "YTD", "sparkline", "relativeStrength30dVsSpy", "20SMA", "50SMA", "200SMA"]);
    expect(bitoRow?.above20Sma).toBe(true);
    expect(bitoRow?.above50Sma).toBe(true);
    expect(bitoRow?.above200Sma).toBe(true);
    expect(ibitRow?.above20Sma).toBe(false);
    expect(ibitRow?.above50Sma).toBe(false);
    expect(ibitRow?.above200Sma).toBe(false);
  });
});
