import { describe, expect, it } from "vitest";
import { loadSnapshot } from "../src/eod";

function createEnv() {
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
      description: "Macro risk regime and cross-asset leadership",
      isCollapsible: 1,
      defaultCollapsed: 0,
      sort_order: 1,
    },
  ];
  const groups = [
    {
      id: "g-us-index",
      sectionId: "sec-macro",
      title: "US Index Futures",
      sort_order: 1,
      dataType: "macro",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-crypto",
      sectionId: "sec-macro",
      title: "Crypto Proxies",
      sort_order: 2,
      dataType: "macro",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-metals-energy",
      sectionId: "sec-macro",
      title: "Metals & Energy",
      sort_order: 3,
      dataType: "macro",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
  ];
  const items = [
    {
      id: "item-spy",
      groupId: "g-us-index",
      sort_order: 1,
      ticker: "SPY",
      displayName: "SPDR S&P 500 ETF",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-bito",
      groupId: "g-crypto",
      sort_order: 1,
      ticker: "BITO",
      displayName: "ProShares Bitcoin Strategy ETF",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-gld",
      groupId: "g-metals-energy",
      sort_order: 1,
      ticker: "GLD",
      displayName: "SPDR Gold Shares",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-uso",
      groupId: "g-metals-energy",
      sort_order: 2,
      ticker: "USO",
      displayName: "United States Oil Fund",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
  ];
  const columns = [
    {
      groupId: "g-us-index",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-crypto",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline", "relativeStrength30dVsSpy"]),
    },
    {
      groupId: "g-metals-energy",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
  ];
  const symbolRows = [
    { ticker: "SPY", name: "SPDR S&P 500 ETF" },
    { ticker: "BITO", name: "ProShares Bitcoin Strategy ETF" },
    { ticker: "GLD", name: "SPDR Gold Shares" },
    { ticker: "USO", name: "United States Oil Fund" },
  ];
  const snapshotMeta = {
    id: "snap-1",
    asOfDate: "2025-01-07",
    generatedAt: "2025-01-08T00:00:00.000Z",
    providerLabel: "Stored Daily Bars",
  };
  const snapshotRows = [
    {
      sectionId: "sec-macro",
      groupId: "g-us-index",
      ticker: "SPY",
      displayName: "SPDR S&P 500 ETF",
      price: 12,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([10, 10.5, 11, 12]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-crypto",
      ticker: "BITO",
      displayName: "ProShares Bitcoin Strategy ETF",
      price: 24,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([20, 21, 22, 24]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-metals-energy",
      ticker: "GLD",
      displayName: "SPDR Gold Shares",
      price: 36,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([30, 31.5, 33, 36]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-metals-energy",
      ticker: "USO",
      displayName: "United States Oil Fund",
      price: 18,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([15, 15.75, 16.5, 18]),
      rankKey: 20,
      holdingsJson: null,
    },
  ];
  const dailyBars = [
    { ticker: "BITO", date: "2025-01-02", c: 20, volume: 1000 },
    { ticker: "BITO", date: "2025-01-03", c: 21, volume: 1100 },
    { ticker: "BITO", date: "2025-01-06", c: 22, volume: 1200 },
    { ticker: "BITO", date: "2025-01-07", c: 24, volume: 1300 },
    { ticker: "GLD", date: "2025-01-02", c: 30, volume: 1400 },
    { ticker: "GLD", date: "2025-01-03", c: 31.5, volume: 1500 },
    { ticker: "GLD", date: "2025-01-06", c: 33, volume: 1600 },
    { ticker: "GLD", date: "2025-01-07", c: 36, volume: 1700 },
    { ticker: "SPY", date: "2025-01-02", c: 10, volume: 2000 },
    { ticker: "SPY", date: "2025-01-03", c: 10.5, volume: 2100 },
    { ticker: "SPY", date: "2025-01-06", c: 11, volume: 2200 },
    { ticker: "SPY", date: "2025-01-07", c: 12, volume: 2300 },
    { ticker: "USO", date: "2025-01-02", c: 15, volume: 2400 },
    { ticker: "USO", date: "2025-01-03", c: 15.75, volume: 2500 },
    { ticker: "USO", date: "2025-01-06", c: 16.5, volume: 2600 },
    { ticker: "USO", date: "2025-01-07", c: 18, volume: 2700 },
  ];

  const db = {
    prepare(sql: string) {
      const runAll = async <T>(args: unknown[]) => {
        if (sql.includes("FROM dashboard_groups")) {
          return { results: groups as T[] };
        }
        if (sql.includes("FROM dashboard_sections WHERE config_id = ?")) {
          return { results: sections as T[] };
        }
        if (sql.includes("FROM dashboard_items ORDER BY sort_order ASC")) {
          return { results: items as T[] };
        }
        if (sql.includes("SELECT ticker, name FROM symbols WHERE ticker IN")) {
          const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
          return {
            results: symbolRows.filter((row) => requested.has(row.ticker.toUpperCase())) as T[],
          };
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
          return {
            results: dailyBars.filter((row) => requested.has(row.ticker.toUpperCase())) as T[],
          };
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
              if (sql.includes("FROM dashboard_configs WHERE id = ?")) {
                return dashboardConfig as T;
              }
              if (sql.includes("FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC LIMIT 1")) {
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

describe("loadSnapshot relative strength pilot", () => {
  it("populates crypto and metals-energy rows with RS 30d vs SPY and leaves non-enabled rows empty", async () => {
    const snapshot = await loadSnapshot(createEnv() as never);
    const macroSection = snapshot.sections[0];
    const cryptoGroup = macroSection.groups.find((group) => group.id === "g-crypto");
    const indexGroup = macroSection.groups.find((group) => group.id === "g-us-index");
    const metalsGroup = macroSection.groups.find((group) => group.id === "g-metals-energy");
    const bitoRow = cryptoGroup?.rows.find((row) => row.ticker === "BITO");
    const gldRow = metalsGroup?.rows.find((row) => row.ticker === "GLD");
    const usoRow = metalsGroup?.rows.find((row) => row.ticker === "USO");
    const spyRow = indexGroup?.rows.find((row) => row.ticker === "SPY");

    expect(cryptoGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(metalsGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(bitoRow?.relativeStrength30dVsSpy).toEqual([2, 2, 2, 2]);
    expect(gldRow?.relativeStrength30dVsSpy).toEqual([3, 3, 3, 3]);
    expect(usoRow?.relativeStrength30dVsSpy).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(spyRow?.relativeStrength30dVsSpy).toBeNull();
  });
});
