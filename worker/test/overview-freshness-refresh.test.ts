import { describe, expect, it } from "vitest";
import {
  computeAndStoreSnapshot,
  computeOverviewFreshnessDiagnostics,
  isOverviewFreshnessSufficientForScheduledSnapshot,
  refreshAndStoreOverviewSnapshot,
} from "../src/eod";
import type { Env } from "../src/types";

type DailyBarSeed = Record<string, string[]>;

class OverviewFreshnessDb {
  snapshotWrites = 0;
  snapshotRowWrites = 0;
  snapshotRowBarDates: Array<string | null> = [];
  queries: Array<{ sql: string; args: unknown[] }> = [];
  snapshotRows: Array<{
    ticker: string;
    price: number | null;
    change1d: number | null;
    change3m: number | null;
    change6m: number | null;
    above20Sma: number | null;
    above50Sma: number | null;
    above200Sma: number | null;
    rankKey: number | null;
    relativeStrength30dVsSpyJson: string | null;
  }> = [];
  readonly dailyBars: DailyBarSeed;

  private readonly config = {
    id: "default",
    name: "Default Swing Dashboard",
    timezone: "Australia/Melbourne",
    eodRunLocalTime: "08:15",
    eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
  };

  private readonly sections = [
    {
      id: "sec-macro",
      title: "01 Macro Overview",
      description: "Macro overview",
      isCollapsible: 1,
      defaultCollapsed: 0,
      sort_order: 1,
    },
    {
      id: "sec-equities",
      title: "02 Equities Overview",
      description: "Equities overview",
      isCollapsible: 1,
      defaultCollapsed: 0,
      sort_order: 2,
    },
  ];

  private readonly groups = [
    {
      id: "g-us-index",
      sectionId: "sec-macro",
      title: "US Index Futures",
      sort_order: 1,
      dataType: "macro",
      rankingWindowDefault: "1D",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-sector-etf",
      sectionId: "sec-equities",
      title: "Sector ETFs",
      sort_order: 1,
      dataType: "equities",
      rankingWindowDefault: "1D",
      showSparkline: 1,
      pinTop10: 0,
    },
    {
      id: "g-thematic",
      sectionId: "sec-equities",
      title: "Industry/Thematic ETFs",
      sort_order: 2,
      dataType: "equities",
      rankingWindowDefault: "1D",
      showSparkline: 1,
      pinTop10: 0,
    },
  ];

  private readonly items = [
    { id: "item-spy", groupId: "g-us-index", sort_order: 1, ticker: "SPY", displayName: "SPDR S&P 500 ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-qqq", groupId: "g-us-index", sort_order: 2, ticker: "QQQ", displayName: "Invesco QQQ Trust", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-dia", groupId: "g-us-index", sort_order: 3, ticker: "DIA", displayName: "SPDR Dow Jones Industrial Average ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-iwm", groupId: "g-us-index", sort_order: 4, ticker: "IWM", displayName: "iShares Russell 2000 ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-xlf", groupId: "g-sector-etf", sort_order: 1, ticker: "XLF", displayName: "Financial Select Sector SPDR Fund", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-xlk", groupId: "g-thematic", sort_order: 1, ticker: "XLK", displayName: "Technology Select Sector SPDR Fund", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-xbi", groupId: "g-thematic", sort_order: 2, ticker: "XBI", displayName: "SPDR S&P Biotech ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-smh", groupId: "g-thematic", sort_order: 3, ticker: "SMH", displayName: "VanEck Semiconductor ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-ibit", groupId: "g-thematic", sort_order: 4, ticker: "IBIT", displayName: "iShares Bitcoin Trust", enabled: 1, tagsJson: "[]", holdingsJson: null },
    { id: "item-arkk", groupId: "g-thematic", sort_order: 5, ticker: "ARKK", displayName: "ARK Innovation ETF", enabled: 1, tagsJson: "[]", holdingsJson: null },
  ];

  constructor(dailyBars: DailyBarSeed) {
    this.dailyBars = dailyBars;
  }

  prepare(sql: string) {
    const db = this;
    const statement = {
      bind(...args: unknown[]) {
        return boundStatement(sql, args, db);
      },
      async first<T>() {
        return boundStatement(sql, [], db).first<T>();
      },
      async all<T>() {
        return boundStatement(sql, [], db).all<T>();
      },
      async run() {
        return boundStatement(sql, [], db).run();
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return [];
  }

  rowsForSql<T>(sql: string, args: unknown[]): T[] {
    this.queries.push({ sql, args });
    if (sql.includes("SELECT ticker, date, c") && sql.includes("FROM alpaca_daily_bars")) {
      const hasLowerBound = sql.includes("date >= ?");
      const startDate = hasLowerBound ? String(args.at(-2)) : null;
      const cutoff = String(args.at(-1) ?? args[0]);
      const requestedTickers = new Set(
        (hasLowerBound ? args.slice(1, -2) : args.slice(1, -1))
          .map((value) => String(value).toUpperCase()),
      );
      return this.items
        .filter((item) => requestedTickers.size === 0 || requestedTickers.has(item.ticker.toUpperCase()))
        .flatMap((item, itemIndex) =>
          (this.dailyBars[item.ticker.toUpperCase()] ?? [])
          .filter((date) => (!startDate || date >= startDate) && date <= cutoff)
          .sort()
          .map((date, dateIndex) => ({
            ticker: item.ticker,
            date,
            c: 100 + itemIndex * 10 + dateIndex,
          })),
      ) as T[];
    }
    if (sql.includes("dashboard_groups")) return this.groups as T[];
    if (sql.includes("FROM dashboard_sections WHERE config_id = ?")) return this.sections as T[];
    if (sql.includes("dashboard_items")) return this.items as T[];
    if (sql.includes("dashboard_columns")) {
      return this.groups.map((group) => ({ groupId: group.id, columnsJson: JSON.stringify(["ticker", "name", "price", "1D"]) })) as T[];
    }
    if (sql.includes("symbols") && sql.includes("ticker, name")) {
      return this.items.map((item) => ({ ticker: item.ticker, name: item.displayName })) as T[];
    }
    if (sql.includes("FROM etf_watchlists")) return [];
    if (sql.includes("MAX(date) as lastDate") && sql.includes("FROM alpaca_daily_bars")) {
      const cutoff = sql.includes("date <= ?") ? String(args.at(-1)) : null;
      const tickers = args.slice(1, -1)
        .map((value) => String(value).toUpperCase())
        .filter((value) => this.dailyBars[value]);
      return tickers.flatMap((ticker) => {
        const dates = (this.dailyBars[ticker] ?? []).filter((date) => !cutoff || date <= cutoff).sort();
        const lastDate = dates.at(-1);
        return lastDate ? [{ ticker, lastDate }] : [];
      }) as T[];
    }
    if (sql.includes("SELECT DISTINCT ticker") && sql.includes("FROM alpaca_daily_bars")) {
      const date = String(args.at(-1));
      const tickers = args
        .slice(1, -1)
        .map((value) => String(value).toUpperCase())
        .filter((ticker) => (this.dailyBars[ticker] ?? []).includes(date));
      return tickers.map((ticker) => ({ ticker })) as T[];
    }
    return [];
  }

  firstForSql<T>(sql: string): T | null {
    if (sql.includes("FROM dashboard_configs WHERE id = ?")) return this.config as T;
    return null;
  }

  runSql(sql: string, args: unknown[]) {
    if (sql.includes("INSERT INTO snapshots_meta")) this.snapshotWrites += 1;
    if (sql.includes("INSERT OR REPLACE INTO snapshot_rows")) {
      this.snapshotRowWrites += 1;
      this.snapshotRows.push({
        ticker: String(args[3]),
        price: args[5] == null ? null : Number(args[5]),
        change1d: args[6] == null ? null : Number(args[6]),
        change3m: args[9] == null ? null : Number(args[9]),
        change6m: args[10] == null ? null : Number(args[10]),
        above20Sma: args[27] == null ? null : Number(args[27]),
        above50Sma: args[28] == null ? null : Number(args[28]),
        above200Sma: args[29] == null ? null : Number(args[29]),
        rankKey: args[15] == null ? null : Number(args[15]),
        relativeStrength30dVsSpyJson: args[30] == null ? null : String(args[30]),
      });
      this.snapshotRowBarDates.push(args[17] == null ? null : String(args[17]));
    }
    return { meta: { rows_written: 1 } };
  }
}

function boundStatement(sql: string, args: unknown[], db: OverviewFreshnessDb) {
  return {
    async first<T>() {
      return db.firstForSql<T>(sql);
    },
    async all<T>() {
      return { results: db.rowsForSql<T>(sql, args) };
    },
    async run() {
      return db.runSql(sql, args);
    },
  };
}

function createEnv(db: OverviewFreshnessDb): Env {
  return {
    DB: db as unknown as D1Database,
    DATA_PROVIDER: "synthetic",
    APP_TIMEZONE: "Australia/Melbourne",
    OVERVIEW_CURRENT_V2_ENABLED: "false",
  } as Env;
}

describe("overview freshness refresh", () => {
  it("keeps scheduled repair active for low-coverage partial snapshots", () => {
    expect(isOverviewFreshnessSufficientForScheduledSnapshot("fresh", 16)).toBe(true);
    expect(isOverviewFreshnessSufficientForScheduledSnapshot("partial", 95)).toBe(false);
    expect(isOverviewFreshnessSufficientForScheduledSnapshot("partial", 16)).toBe(false);
    expect(isOverviewFreshnessSufficientForScheduledSnapshot("stale", 100)).toBe(false);
  });

  it("writes a fail-closed snapshot when critical ticker bars are stale", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2026-06-05"],
      QQQ: ["2026-06-05"],
      DIA: ["2026-06-05"],
      IWM: ["2026-06-05"],
      XLF: ["2026-06-05"],
      XLK: ["2026-06-05"],
      XBI: ["2026-06-05"],
      SMH: ["2026-06-05"],
      IBIT: ["2026-06-05"],
      ARKK: ["2026-06-05"],
    });

    const result = await refreshAndStoreOverviewSnapshot(createEnv(db), "2026-06-12");

    expect(result.freshness).toMatchObject({
      expectedAsOfDate: "2026-06-12",
      status: "stale",
      currentCount: 0,
      eligibleCount: 10,
      minBarDate: "2026-06-05",
      maxBarDate: "2026-06-05",
    });
    expect(result.freshness.criticalMissingTickers).toEqual(["DIA", "IWM", "QQQ", "SPY", "XLF"]);
    expect(result.freshness.warning).toContain("SPY (US Index Futures) last updated 2026-06-05");
    expect(db.snapshotWrites).toBe(1);
    expect(db.snapshotRows.every((row) => row.price == null && row.change1d == null)).toBe(true);
  });

  it("marks representative freshness partial when critical tickers are current and broad coverage is below the warning threshold", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2026-06-12"],
      QQQ: ["2026-06-12"],
      DIA: ["2026-06-12"],
      IWM: ["2026-06-12"],
      XLF: ["2026-06-12"],
      XLK: ["2026-06-05"],
      XBI: ["2026-06-05"],
      SMH: ["2026-06-05"],
      IBIT: ["2026-06-05"],
      ARKK: ["2026-06-05"],
    });

    const diagnostics = await computeOverviewFreshnessDiagnostics(createEnv(db), "2026-06-12");

    expect(diagnostics.status).toBe("partial");
    expect(diagnostics.coveragePct).toBe(50);
    expect(diagnostics.criticalMissingTickers).toEqual([]);
  });

  it("does not fall back to stored scalar metrics when exact-session current data is missing", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2026-06-05", "2026-06-12"],
      QQQ: ["2026-06-05", "2026-06-12"],
      DIA: ["2026-06-05", "2026-06-12"],
      IWM: ["2026-06-05", "2026-06-12"],
      XLF: ["2026-06-05", "2026-06-12"],
      XLK: ["2026-06-05", "2026-06-12"],
      XBI: ["2026-06-05", "2026-06-12"],
      SMH: ["2026-06-05", "2026-06-12"],
      IBIT: ["2026-06-05", "2026-06-12"],
      ARKK: ["2026-06-05", "2026-06-12"],
    });

    await computeAndStoreSnapshot(createEnv(db), "2026-06-12", "default", {
      includeBreadth: false,
      freshnessDiagnostics: {
        expectedAsOfDate: "2026-06-12",
        status: "fresh",
        eligibleCount: 10,
        currentCount: 10,
        staleCount: 0,
        coveragePct: 100,
        criticalMissingTickers: [],
        minBarDate: "2026-06-12",
        maxBarDate: "2026-06-12",
        warning: null,
      },
    });

    const spyRow = db.snapshotRows.find((row) => row.ticker === "SPY");
    expect(spyRow).toEqual(expect.objectContaining({
      price: null,
      change1d: null,
      rankKey: null,
    }));
    const xlfRow = db.snapshotRows.find((row) => row.ticker === "XLF");
    expect(xlfRow?.change3m).toBeNull();
    expect(xlfRow?.change6m).toBeNull();
    expect(xlfRow?.above20Sma).toBeNull();
    expect(xlfRow?.relativeStrength30dVsSpyJson).toContain("[");
  });

  it("loads snapshot history with explicit tickers and a lower date bound", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2025-01-02", "2026-06-05", "2026-06-12"],
      QQQ: ["2026-06-05", "2026-06-12"],
      DIA: ["2026-06-05", "2026-06-12"],
      IWM: ["2026-06-05", "2026-06-12"],
      XLF: ["2026-06-05", "2026-06-12"],
      XLK: ["2026-06-05", "2026-06-12"],
      XBI: ["2026-06-05", "2026-06-12"],
      SMH: ["2026-06-05", "2026-06-12"],
      IBIT: ["2026-06-05", "2026-06-12"],
      ARKK: ["2026-06-05", "2026-06-12"],
    });

    await computeAndStoreSnapshot(createEnv(db), "2026-06-12", "default", {
      includeBreadth: false,
    });

    const barQuery = db.queries.find((query) =>
      query.sql.includes("SELECT ticker, date, c")
        && query.sql.includes("FROM alpaca_daily_bars")
        && query.sql.includes("date >= ?"),
    );
    expect(barQuery?.sql).toContain("ticker IN");
    expect(barQuery?.sql).toContain("date <= ?");
    expect(barQuery?.sql).not.toContain("SELECT ticker FROM dashboard_items");
    expect(barQuery?.args).toContain("SPY");
    expect(barQuery?.args).toContain("2025-04-18");
    expect(barQuery?.args.at(-1)).toBe("2026-06-12");
    expect(db.snapshotRows.find((row) => row.ticker === "SPY")?.price).not.toBe(100);
  });

  it("writes a stale snapshot in best-effort mode instead of throwing a freshness error", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2026-06-05"],
      QQQ: ["2026-06-05"],
      DIA: ["2026-06-05"],
      IWM: ["2026-06-05"],
      XLF: ["2026-06-05"],
      XLK: ["2026-06-05"],
      XBI: ["2026-06-05"],
      SMH: ["2026-06-05"],
      IBIT: ["2026-06-05"],
      ARKK: ["2026-06-05"],
    });

    const result = await refreshAndStoreOverviewSnapshot(createEnv(db), "2026-06-12", "default", { requireFreshness: false });

    expect(result.freshness.status).toBe("stale");
    expect(db.snapshotWrites).toBe(1);
    expect(db.snapshotRowWrites).toBe(10);
  });

  it("writes a partial snapshot when critical tickers are fresh and non-critical overview rows are stale", async () => {
    const db = new OverviewFreshnessDb({
      SPY: ["2026-06-05", "2026-06-12"],
      QQQ: ["2026-06-05", "2026-06-12"],
      DIA: ["2026-06-05", "2026-06-12"],
      IWM: ["2026-06-05", "2026-06-12"],
      XLF: ["2026-06-05", "2026-06-12"],
      XLK: ["2026-06-05"],
      XBI: ["2026-06-05"],
      SMH: ["2026-06-05"],
      IBIT: ["2026-06-05"],
      ARKK: ["2026-06-05"],
    });

    const result = await refreshAndStoreOverviewSnapshot(createEnv(db), "2026-06-12");

    expect(result.freshness.status).toBe("partial");
    expect(result.freshness.currentCount).toBe(5);
    expect(result.freshness.eligibleCount).toBe(10);
    expect(db.snapshotWrites).toBe(1);
    expect(db.snapshotRowWrites).toBe(10);
    expect(db.snapshotRowBarDates).toContain("2026-06-12");
    expect(db.snapshotRowBarDates).toContain("2026-06-05");
  });
});
