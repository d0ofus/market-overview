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
    {
      id: "g-global",
      sectionId: "sec-macro",
      title: "Global Indices",
      sort_order: 4,
      dataType: "macro",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-country",
      sectionId: "sec-macro",
      title: "Country ETFs",
      sort_order: 5,
      dataType: "equities",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-market-leaders",
      sectionId: "sec-macro",
      title: "Market Leaders (FAANG)",
      sort_order: 6,
      dataType: "equities",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-thematic",
      sectionId: "sec-macro",
      title: "Industry/Thematic ETFs",
      sort_order: 7,
      dataType: "equities",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-sector-etf",
      sectionId: "sec-macro",
      title: "Sector ETFs",
      sort_order: 8,
      dataType: "equities",
      rankingWindowDefault: "1W",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-sector-etf-eqwt",
      sectionId: "sec-macro",
      title: "Sector ETFs (Equal Weight)",
      sort_order: 9,
      dataType: "equities",
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
    {
      id: "item-ewj",
      groupId: "g-global",
      sort_order: 1,
      ticker: "EWJ",
      displayName: "iShares MSCI Japan ETF",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-eem",
      groupId: "g-country",
      sort_order: 1,
      ticker: "EEM",
      displayName: "iShares MSCI Emerging Markets ETF",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-meta",
      groupId: "g-market-leaders",
      sort_order: 1,
      ticker: "META",
      displayName: "Meta Platforms Inc",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-smh",
      groupId: "g-thematic",
      sort_order: 1,
      ticker: "SMH",
      displayName: "VanEck Semiconductor ETF",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-xlk",
      groupId: "g-sector-etf",
      sort_order: 1,
      ticker: "XLK",
      displayName: "Technology Select Sector SPDR",
      enabled: 1,
      tagsJson: "[]",
      holdingsJson: null,
    },
    {
      id: "item-ryt",
      groupId: "g-sector-etf-eqwt",
      sort_order: 1,
      ticker: "RYT",
      displayName: "Invesco S&P 500 Equal Weight Technology ETF",
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
    {
      groupId: "g-global",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-country",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-market-leaders",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-thematic",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-sector-etf",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
    {
      groupId: "g-sector-etf-eqwt",
      columnsJson: JSON.stringify(["ticker", "name", "price", "sparkline"]),
    },
  ];
  const symbolRows = [
    { ticker: "SPY", name: "SPDR S&P 500 ETF" },
    { ticker: "BITO", name: "ProShares Bitcoin Strategy ETF" },
    { ticker: "GLD", name: "SPDR Gold Shares" },
    { ticker: "USO", name: "United States Oil Fund" },
    { ticker: "EWJ", name: "iShares MSCI Japan ETF" },
    { ticker: "EEM", name: "iShares MSCI Emerging Markets ETF" },
    { ticker: "META", name: "Meta Platforms Inc" },
    { ticker: "SMH", name: "VanEck Semiconductor ETF" },
    { ticker: "XLK", name: "Technology Select Sector SPDR" },
    { ticker: "RYT", name: "Invesco S&P 500 Equal Weight Technology ETF" },
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
    {
      sectionId: "sec-macro",
      groupId: "g-global",
      ticker: "EWJ",
      displayName: "iShares MSCI Japan ETF",
      price: 48,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([40, 42, 44, 48]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-country",
      ticker: "EEM",
      displayName: "iShares MSCI Emerging Markets ETF",
      price: 30,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([25, 26.25, 27.5, 30]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-market-leaders",
      ticker: "META",
      displayName: "Meta Platforms Inc",
      price: 60,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([50, 52.5, 55, 60]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-thematic",
      ticker: "SMH",
      displayName: "VanEck Semiconductor ETF",
      price: 42,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([35, 36.75, 38.5, 42]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-sector-etf",
      ticker: "XLK",
      displayName: "Technology Select Sector SPDR",
      price: 54,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([45, 47.25, 49.5, 54]),
      rankKey: 20,
      holdingsJson: null,
    },
    {
      sectionId: "sec-macro",
      groupId: "g-sector-etf-eqwt",
      ticker: "RYT",
      displayName: "Invesco S&P 500 Equal Weight Technology ETF",
      price: 66,
      change1d: 9.09,
      change1w: 20,
      change5d: 20,
      change21d: 20,
      ytd: 20,
      pctFrom52wHigh: 0,
      sparklineJson: JSON.stringify([55, 57.75, 60.5, 66]),
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
    { ticker: "EWJ", date: "2025-01-02", c: 40, volume: 1800 },
    { ticker: "EWJ", date: "2025-01-03", c: 42, volume: 1900 },
    { ticker: "EWJ", date: "2025-01-06", c: 44, volume: 1950 },
    { ticker: "EWJ", date: "2025-01-07", c: 48, volume: 1975 },
    { ticker: "EEM", date: "2025-01-02", c: 25, volume: 1980 },
    { ticker: "EEM", date: "2025-01-03", c: 26.25, volume: 1985 },
    { ticker: "EEM", date: "2025-01-06", c: 27.5, volume: 1990 },
    { ticker: "EEM", date: "2025-01-07", c: 30, volume: 1995 },
    { ticker: "META", date: "2025-01-02", c: 50, volume: 2001 },
    { ticker: "META", date: "2025-01-03", c: 52.5, volume: 2002 },
    { ticker: "META", date: "2025-01-06", c: 55, volume: 2003 },
    { ticker: "META", date: "2025-01-07", c: 60, volume: 2004 },
    { ticker: "SPY", date: "2025-01-02", c: 10, volume: 2000 },
    { ticker: "SPY", date: "2025-01-03", c: 10.5, volume: 2100 },
    { ticker: "SPY", date: "2025-01-06", c: 11, volume: 2200 },
    { ticker: "SPY", date: "2025-01-07", c: 12, volume: 2300 },
    { ticker: "SMH", date: "2025-01-02", c: 35, volume: 2301 },
    { ticker: "SMH", date: "2025-01-03", c: 36.75, volume: 2302 },
    { ticker: "SMH", date: "2025-01-06", c: 38.5, volume: 2303 },
    { ticker: "SMH", date: "2025-01-07", c: 42, volume: 2304 },
    { ticker: "XLK", date: "2025-01-02", c: 45, volume: 2305 },
    { ticker: "XLK", date: "2025-01-03", c: 47.25, volume: 2306 },
    { ticker: "XLK", date: "2025-01-06", c: 49.5, volume: 2307 },
    { ticker: "XLK", date: "2025-01-07", c: 54, volume: 2308 },
    { ticker: "USO", date: "2025-01-02", c: 15, volume: 2400 },
    { ticker: "USO", date: "2025-01-03", c: 15.75, volume: 2500 },
    { ticker: "USO", date: "2025-01-06", c: 16.5, volume: 2600 },
    { ticker: "USO", date: "2025-01-07", c: 18, volume: 2700 },
    { ticker: "RYT", date: "2025-01-02", c: 55, volume: 2701 },
    { ticker: "RYT", date: "2025-01-03", c: 57.75, volume: 2702 },
    { ticker: "RYT", date: "2025-01-06", c: 60.5, volume: 2703 },
    { ticker: "RYT", date: "2025-01-07", c: 66, volume: 2704 },
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
  it("populates configured overview groups with RS 30d vs SPY and leaves non-enabled rows empty", async () => {
    const snapshot = await loadSnapshot(createEnv() as never);
    const macroSection = snapshot.sections[0];
    const cryptoGroup = macroSection.groups.find((group) => group.id === "g-crypto");
    const indexGroup = macroSection.groups.find((group) => group.id === "g-us-index");
    const metalsGroup = macroSection.groups.find((group) => group.id === "g-metals-energy");
    const globalGroup = macroSection.groups.find((group) => group.id === "g-global");
    const countryGroup = macroSection.groups.find((group) => group.id === "g-country");
    const marketLeadersGroup = macroSection.groups.find((group) => group.id === "g-market-leaders");
    const thematicGroup = macroSection.groups.find((group) => group.id === "g-thematic");
    const sectorGroup = macroSection.groups.find((group) => group.id === "g-sector-etf");
    const sectorEqGroup = macroSection.groups.find((group) => group.id === "g-sector-etf-eqwt");
    const bitoRow = cryptoGroup?.rows.find((row) => row.ticker === "BITO");
    const gldRow = metalsGroup?.rows.find((row) => row.ticker === "GLD");
    const usoRow = metalsGroup?.rows.find((row) => row.ticker === "USO");
    const ewjRow = globalGroup?.rows.find((row) => row.ticker === "EWJ");
    const eemRow = countryGroup?.rows.find((row) => row.ticker === "EEM");
    const metaRow = marketLeadersGroup?.rows.find((row) => row.ticker === "META");
    const smhRow = thematicGroup?.rows.find((row) => row.ticker === "SMH");
    const xlkRow = sectorGroup?.rows.find((row) => row.ticker === "XLK");
    const rytRow = sectorEqGroup?.rows.find((row) => row.ticker === "RYT");
    const spyRow = indexGroup?.rows.find((row) => row.ticker === "SPY");

    expect(cryptoGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(metalsGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(globalGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(countryGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(marketLeadersGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(thematicGroup?.columns).toContain("relativeStrength30dVsSpy");
    expect(sectorGroup?.columns).toEqual(["ticker", "name", "sparkline", "relativeStrength30dVsSpy", "price", "1D", "1W", "3M", "6M", "YTD"]);
    expect(sectorEqGroup?.columns).toEqual(["ticker", "name", "sparkline", "relativeStrength30dVsSpy", "price", "1D", "1W", "3M", "6M", "YTD"]);
    expect(bitoRow?.relativeStrength30dVsSpy).toEqual([2, 2, 2, 2]);
    expect(gldRow?.relativeStrength30dVsSpy).toEqual([3, 3, 3, 3]);
    expect(usoRow?.relativeStrength30dVsSpy).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(ewjRow?.relativeStrength30dVsSpy).toEqual([4, 4, 4, 4]);
    expect(eemRow?.relativeStrength30dVsSpy).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(metaRow?.relativeStrength30dVsSpy).toEqual([5, 5, 5, 5]);
    expect(smhRow?.relativeStrength30dVsSpy).toEqual([3.5, 3.5, 3.5, 3.5]);
    expect(xlkRow?.relativeStrength30dVsSpy).toEqual([4.5, 4.5, 4.5, 4.5]);
    expect(rytRow?.relativeStrength30dVsSpy).toEqual([5.5, 5.5, 5.5, 5.5]);
    expect(spyRow?.relativeStrength30dVsSpy).toBeNull();
  });
});
