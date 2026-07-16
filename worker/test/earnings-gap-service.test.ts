import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTradingViewEarningsGapPayload,
  computeEarningsGapEvents,
  exportEarningsGapTickers,
  loadEarningsGapsStatus,
  maybeRunScheduledEarningsGapSync,
  parseTradingViewEarningsGapRows,
  queryEarningsGaps,
  syncEarningsGaps,
  type EarningsGapEventInput,
  type EarningsGapReleaseInput,
} from "../src/earnings-gap-service";
import { isExcludedEarningsIssue } from "../src/earnings-issue-filter";
import type { Env } from "../src/types";

type StoredSync = {
  id: string;
  provider: string;
  status: string;
  mode: string | null;
  scheduledLocalDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowsSeen: number;
  rowsUpserted: number;
  updatedAt: string;
};

type StoredEvent = EarningsGapEventInput & { id: string };
type StoredBar = { ticker: string; date: string; o: number; c: number };
type StoredSurprise = {
  provider: string;
  ticker: string;
  reportDate: string;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
};

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function tvRow(input: {
  symbol: string;
  name: string;
  exchange: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  price?: number;
  avgVolume30d?: number;
  avgDollarVolume30d?: number;
  reportIso: string;
  reportTime?: -1 | 0 | 1;
  postmarketPrice?: number | null;
  postmarketVolume?: number | null;
  epsActual?: number | null;
  epsEstimate?: number | null;
  epsSurprise?: number | null;
  epsSurprisePct?: number | null;
}) {
  return {
    s: `${input.exchange}:${input.symbol}`,
    d: [
      input.name,
      input.symbol,
      input.exchange,
      "stock",
      input.sector ?? "Technology Services",
      input.industry ?? "Software",
      input.marketCap ?? 1_000_000_000,
      input.price ?? 100,
      input.avgVolume30d ?? 500_000,
      input.avgDollarVolume30d ?? 50_000_000,
      unix(input.reportIso),
      input.reportTime ?? 1,
      unix(input.reportIso),
      input.postmarketPrice ?? null,
      null,
      null,
      input.postmarketVolume ?? null,
      input.epsActual ?? null,
      input.epsEstimate ?? null,
      input.epsSurprise ?? null,
      input.epsSurprisePct ?? null,
    ],
  };
}

function release(input: Partial<EarningsGapReleaseInput> & { ticker: string; reportDate: string }): EarningsGapReleaseInput {
  return {
    provider: "tradingview",
    sourceSymbol: `NASDAQ:${input.ticker}`,
    ticker: input.ticker,
    exchange: "NASDAQ",
    companyName: input.companyName ?? input.ticker,
    sector: input.sector ?? "Technology Services",
    industry: input.industry ?? "Software",
    marketCap: input.marketCap ?? 1_000_000_000,
    price: input.price ?? 100,
    avgVolume30d: input.avgVolume30d ?? 500_000,
    avgDollarVolume30d: input.avgDollarVolume30d ?? 50_000_000,
    reportDate: input.reportDate,
    season: input.season ?? `${input.reportDate.slice(0, 4)} Q${Math.ceil(Number(input.reportDate.slice(5, 7)) / 3)}`,
    epsProvider: input.epsProvider ?? null,
    epsActual: input.epsActual ?? null,
    epsEstimate: input.epsEstimate ?? null,
    epsSurprise: input.epsSurprise ?? null,
    epsSurprisePct: input.epsSurprisePct ?? null,
    reportTimestamp: input.reportTimestamp ?? null,
    reportTime: input.reportTime ?? "after-market",
    postmarketPrice: input.postmarketPrice ?? null,
    postmarketVolume: input.postmarketVolume ?? null,
    rawJson: input.rawJson ?? null,
  };
}

function storedEvent(input: Partial<EarningsGapEventInput> & { ticker: string; reportDate: string; qualifyingGapPct?: number }): StoredEvent {
  const base = release(input);
  return {
    id: `id-${input.ticker}-${input.reportDate}`,
    ...base,
    reactionDate: input.reactionDate ?? input.reportDate,
    previousClose: input.previousClose ?? 100,
    reactionOpen: input.reactionOpen ?? 110,
    regularOpenGapPct: input.regularOpenGapPct ?? 10,
    postmarketGapPct: input.postmarketGapPct ?? null,
    qualifyingGapPct: input.qualifyingGapPct ?? 10,
    gapSource: input.gapSource ?? "regular_open",
    firstSeenAt: null,
    lastSeenAt: null,
  };
}

function createEnv(input: {
  bars?: StoredBar[];
  syncs?: StoredSync[];
  events?: StoredEvent[];
  surprises?: StoredSurprise[];
  hasSeasonColumn?: boolean;
  hasEpsColumns?: boolean;
} = {}): Env & {
  __events: StoredEvent[];
  __syncs: StoredSync[];
  __metrics: { cleanupRuns: number; dailyBarQueries: number };
  __queries: string[];
} {
  const bars = input.bars ?? [];
  const syncs = [...(input.syncs ?? [])];
  const events: StoredEvent[] = [...(input.events ?? [])];
  const surprises = [...(input.surprises ?? [])];
  const hasSeasonColumn = input.hasSeasonColumn ?? true;
  const hasEpsColumns = input.hasEpsColumns ?? true;
  const metrics = { cleanupRuns: 0, dailyBarQueries: 0 };
  const queries: string[] = [];

  const countPlaceholders = (sql: string, field: string) => {
    const match = sql.match(new RegExp(`${field} IN \\(([^)]*)\\)`));
    return match ? (match[1].match(/\?/g) ?? []).length : 0;
  };
  const applyEventFilters = (sql: string, args: unknown[]) => {
    let cursor = 0;
    let rows = events.filter((row) => !isExcludedEarningsIssue(row));
    if (sql.includes("report_date >= ?")) {
      const startDate = String(args[cursor++] ?? "1900-01-01");
      rows = rows.filter((row) => row.reportDate >= startDate);
    }
    if (sql.includes("report_date <= ?")) {
      const endDate = String(args[cursor++] ?? "9999-12-31");
      rows = rows.filter((row) => row.reportDate <= endDate);
    }
    if (sql.includes("(ticker LIKE ? OR company_name LIKE ? COLLATE NOCASE)")) {
      const tickerPrefix = String(args[cursor++] ?? "").replace(/%$/, "");
      const companyQuery = String(args[cursor++] ?? "").replace(/^%|%$/g, "").toLowerCase();
      rows = rows.filter((row) => row.ticker.startsWith(tickerPrefix) || String(row.companyName ?? "").toLowerCase().includes(companyQuery));
    }
    if (sql.includes("market_cap >= ?")) rows = rows.filter((row) => Number(row.marketCap ?? 0) >= Number(args[cursor++] ?? 0));
    if (sql.includes("market_cap <= ?")) rows = rows.filter((row) => Number(row.marketCap ?? 0) <= Number(args[cursor++] ?? 0));
    if (sql.includes("avg_dollar_volume_30d >= ?")) rows = rows.filter((row) => Number(row.avgDollarVolume30d ?? 0) >= Number(args[cursor++] ?? 0));
    if (sql.includes("qualifying_gap_pct >= ?")) rows = rows.filter((row) => row.qualifyingGapPct >= Number(args[cursor++] ?? 0));
    for (const field of ["season", "sector", "industry"] as const) {
      const count = countPlaceholders(sql, field);
      if (count > 0) {
        const values = new Set(args.slice(cursor, cursor + count).map((value) => String(value)));
        cursor += count;
        rows = rows.filter((row) => values.has(String(row[field] ?? "")));
      }
    }
    const exchangeCount = countPlaceholders(sql, "UPPER\\(exchange\\)");
    if (exchangeCount > 0) {
      const values = new Set(args.slice(cursor, cursor + exchangeCount).map((value) => String(value).toUpperCase()));
      rows = rows.filter((row) => values.has(String(row.exchange ?? "").toUpperCase()));
    } else if (sql.includes("UPPER(exchange) IN ('NASDAQ', 'NYSE', 'AMEX')")) {
      rows = rows.filter((row) => ["NASDAQ", "NYSE", "AMEX"].includes(String(row.exchange ?? "").toUpperCase()));
    }
    const sortMatch = sql.match(/ORDER BY ([a-z_]+) (ASC|DESC)/);
    if (sortMatch) {
      const [, column, direction] = sortMatch;
      const map: Record<string, keyof StoredEvent> = {
        season: "season",
        eps_surprise: "epsSurprise",
        eps_surprise_pct: "epsSurprisePct",
        qualifying_gap_pct: "qualifyingGapPct",
        report_date: "reportDate",
        ticker: "ticker",
      };
      const key = map[column] ?? "ticker";
      rows.sort((left, right) => {
        const a = left[key] ?? "";
        const b = right[key] ?? "";
        const result = typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b));
        if (result !== 0) return direction === "ASC" ? result : -result;
        const tickerResult = left.ticker.localeCompare(right.ticker);
        if (tickerResult !== 0) return tickerResult;
        const reportDateResult = right.reportDate.localeCompare(left.reportDate);
        if (reportDateResult !== 0) return reportDateResult;
        return left.id.localeCompare(right.id);
      });
    }
    return rows;
  };

  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const makeBound = (args: unknown[]) => ({
        __sql: sql,
        __args: args,
        async first<T>() {
          if (sql.includes("sqlite_master")) return { count: 1 } as T;
          if (sql.includes("pragma_table_info")) {
            const column = String(args[0] ?? "");
            if (column === "season") return { count: hasSeasonColumn ? 1 : 0 } as T;
            if (column.startsWith("eps_")) return { count: hasEpsColumns ? 1 : 0 } as T;
            return { count: 1 } as T;
          }
          if (sql.includes("FROM earnings_gap_syncs WHERE scheduled_local_date")) {
            const localDate = String(args[0] ?? "");
            return (syncs.find((row) => row.scheduledLocalDate === localDate && row.status === "ok") ?? null) as T;
          }
          if (sql.includes("SELECT COUNT(*) as count FROM earnings_gap_events")) {
            return { count: applyEventFilters(sql, args).length } as T;
          }
          if (sql.includes("MAX(report_date)")) {
            const rows = applyEventFilters(sql, args);
            return {
              total: rows.length,
              postmarket: rows.filter((row) => row.gapSource === "postmarket").length,
              regularOpen: rows.filter((row) => row.gapSource === "regular_open").length,
              both: rows.filter((row) => row.gapSource === "both").length,
              latestReportDate: rows.map((row) => row.reportDate).sort().at(-1) ?? null,
              earliestReportDate: rows.map((row) => row.reportDate).sort()[0] ?? null,
            } as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM earnings_surprise_events")) {
            const startDate = String(args.at(-2) ?? "1900-01-01");
            const endDate = String(args.at(-1) ?? "9999-12-31");
            const tickers = new Set(args.slice(0, -2).map((value) => String(value)));
            const providerRank: Record<string, number> = { tradingview: 0, fmp: 1, finnhub: 2 };
            const rows = surprises
              .filter((row) => tickers.has(row.ticker) && row.reportDate >= startDate && row.reportDate <= endDate)
              .sort((left, right) => (
                left.ticker.localeCompare(right.ticker)
                || left.reportDate.localeCompare(right.reportDate)
                || (providerRank[left.provider] ?? 3) - (providerRank[right.provider] ?? 3)
              ))
              .map((row) => ({ ...row, epsProvider: row.provider }));
            return { results: rows as T[] };
          }
          if (sql.includes("FROM daily_bars")) {
            metrics.dailyBarQueries += 1;
            const startDate = String(args.at(-2) ?? "1900-01-01");
            const endDate = String(args.at(-1) ?? "9999-12-31");
            const tickers = new Set(args.slice(0, -2).map((value) => String(value)));
            const rows = bars
              .filter((bar) => tickers.has(bar.ticker) && bar.date >= startDate && bar.date <= endDate)
              .sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date));
            return { results: rows as T[] };
          }
          if (sql.includes("FROM earnings_gap_events") && sql.includes("GROUP BY")) {
            const rawField = sql.match(/SELECT ([a-z_]+) as value/)?.[1] ?? "season";
            const field = (rawField === "gap_source" ? "gapSource" : rawField) as keyof StoredEvent;
            const counts = new Map<string, number>();
            for (const row of applyEventFilters(sql, args)) {
              const value = String(row[field] ?? "");
              if (!value) continue;
              counts.set(value, (counts.get(value) ?? 0) + 1);
            }
            const rows = Array.from(counts, ([value, count]) => ({ value, count }));
            return { results: rows as T[] };
          }
          if (sql.includes("FROM earnings_gap_events")) {
            if (sql.includes("SELECT ticker")) {
              const limit = Number(args.at(-1) ?? 100);
              return { results: applyEventFilters(sql, args.slice(0, -1)).slice(0, limit).map((row) => ({ ticker: row.ticker })) as T[] };
            }
            return { results: applyEventFilters(sql, args) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("INSERT INTO earnings_gap_syncs")) {
            const [id, provider, mode, scheduledLocalDate, windowStart, windowEnd, startedAt] = args;
            syncs.push({
              id: String(id),
              provider: String(provider),
              status: "running",
              mode: mode == null ? null : String(mode),
              scheduledLocalDate: scheduledLocalDate == null ? null : String(scheduledLocalDate),
              windowStart: windowStart == null ? null : String(windowStart),
              windowEnd: windowEnd == null ? null : String(windowEnd),
              lastStartedAt: startedAt == null ? null : String(startedAt),
              lastSuccessAt: null,
              lastError: null,
              rowsSeen: 0,
              rowsUpserted: 0,
              updatedAt: new Date().toISOString(),
            });
          }
          if (sql.includes("UPDATE earnings_gap_syncs")) {
            const [status, , successAt, error, rowsSeen, rowsUpserted, id] = args;
            const row = syncs.find((item) => item.id === id);
            if (row) {
              row.status = String(status);
              if (status === "ok") row.lastSuccessAt = String(successAt ?? "");
              row.lastError = error == null ? null : String(error);
              row.rowsSeen = Number(rowsSeen ?? 0);
              row.rowsUpserted = Number(rowsUpserted ?? 0);
              row.updatedAt = new Date().toISOString();
            }
          }
          if (sql.includes("DELETE FROM earnings_gap_events")) {
            metrics.cleanupRuns += 1;
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
      });
      return {
        bind(...args: unknown[]) {
          return makeBound(args);
        },
        async first<T>() {
          return makeBound([]).first<T>();
        },
        async all<T>() {
          return makeBound([]).all<T>();
        },
        async run() {
          return makeBound([]).run();
        },
      };
    },
    async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
      for (const statement of statements) {
        const sql = statement.__sql ?? "";
        const args = statement.__args ?? [];
        if (!sql.includes("INSERT INTO earnings_gap_events")) continue;
        const [
          id,
          provider,
          sourceSymbol,
          ticker,
          exchange,
          companyName,
          sector,
          industry,
          marketCap,
          price,
          avgVolume30d,
          avgDollarVolume30d,
          reportDate,
          season,
          epsProvider,
          epsActual,
          epsEstimate,
          epsSurprise,
          epsSurprisePct,
          reportTimestamp,
          reportTime,
          reactionDate,
          previousClose,
          reactionOpen,
          regularOpenGapPct,
          postmarketPrice,
          postmarketGapPct,
          postmarketVolume,
          qualifyingGapPct,
          gapSource,
          rawJson,
        ] = args;
        events.push({
          id: String(id),
          provider: String(provider),
          sourceSymbol: String(sourceSymbol),
          ticker: String(ticker),
          exchange: exchange == null ? null : String(exchange),
          companyName: companyName == null ? null : String(companyName),
          sector: sector == null ? null : String(sector),
          industry: industry == null ? null : String(industry),
          marketCap: marketCap == null ? null : Number(marketCap),
          price: price == null ? null : Number(price),
          avgVolume30d: avgVolume30d == null ? null : Number(avgVolume30d),
          avgDollarVolume30d: avgDollarVolume30d == null ? null : Number(avgDollarVolume30d),
          reportDate: String(reportDate),
          season: String(season),
          epsProvider: epsProvider == null ? null : String(epsProvider),
          epsActual: epsActual == null ? null : Number(epsActual),
          epsEstimate: epsEstimate == null ? null : Number(epsEstimate),
          epsSurprise: epsSurprise == null ? null : Number(epsSurprise),
          epsSurprisePct: epsSurprisePct == null ? null : Number(epsSurprisePct),
          reportTimestamp: reportTimestamp == null ? null : Number(reportTimestamp),
          reportTime: reportTime == null ? null : String(reportTime),
          reactionDate: reactionDate == null ? null : String(reactionDate),
          previousClose: previousClose == null ? null : Number(previousClose),
          reactionOpen: reactionOpen == null ? null : Number(reactionOpen),
          regularOpenGapPct: regularOpenGapPct == null ? null : Number(regularOpenGapPct),
          postmarketPrice: postmarketPrice == null ? null : Number(postmarketPrice),
          postmarketGapPct: postmarketGapPct == null ? null : Number(postmarketGapPct),
          postmarketVolume: postmarketVolume == null ? null : Number(postmarketVolume),
          qualifyingGapPct: Number(qualifyingGapPct),
          gapSource: String(gapSource) as "postmarket" | "regular_open" | "both",
          rawJson: rawJson == null ? null : String(rawJson),
          firstSeenAt: null,
          lastSeenAt: null,
        });
      }
      return [];
    },
  };

  return { DB: db as unknown as D1Database, __events: events, __syncs: syncs, __metrics: metrics, __queries: queries };
}

describe("earnings gap service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds and parses TradingView release gap payload rows", () => {
    const payload = buildTradingViewEarningsGapPayload({
      startDate: "2026-05-01",
      endDate: "2026-05-21",
      offset: 500,
      limit: 250,
    });
    expect(payload.sort).toEqual({ sortBy: "earnings_release_date", sortOrder: "desc" });
    expect(payload.range).toEqual([500, 750]);
    expect(payload.columns).toContain("postmarket_close");
    expect(payload.columns).toContain("AvgValue.Traded_30d");
    expect(payload.columns).toContain("earnings_per_share_fq");
    expect(payload.columns).toContain("earnings_per_share_forecast_fq");
    expect(payload.columns).toContain("eps_surprise_fq");
    expect(payload.columns).toContain("eps_surprise_percent_fq");

    const rows = parseTradingViewEarningsGapRows({
      data: [
        tvRow({
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NASDAQ",
          price: 100,
          avgVolume30d: 1_000_000,
          avgDollarVolume30d: 100_000_000,
          reportIso: "2026-05-21T21:00:00Z",
          reportTime: 1,
          postmarketPrice: 106,
          postmarketVolume: 900_000,
          epsActual: 1.5,
          epsEstimate: 1.2,
          epsSurprise: 0.3,
          epsSurprisePct: 25,
        }),
      ],
    });

    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      reportDate: "2026-05-21",
      season: "2026 Q2",
      reportTime: "after-market",
      postmarketPrice: 106,
      postmarketVolume: 900_000,
      avgDollarVolume30d: 100_000_000,
      epsProvider: "tradingview",
      epsActual: 1.5,
      epsEstimate: 1.2,
      epsSurprise: 0.3,
      epsSurprisePct: 25,
    });
  });

  it("skips TradingView preferred and non-common gap rows", () => {
    const rows = parseTradingViewEarningsGapRows({
      data: [
        tvRow({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
        tvRow({ symbol: "BABA", name: "Alibaba Group Holding Limited American Depositary Shares", exchange: "NYSE", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
        tvRow({ symbol: "FBIOP", name: "Fortress Biotech Inc. Series A Cumulative Redeemable Perpetual Preferred Stock", exchange: "NASDAQ", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
        tvRow({ symbol: "TDS/PU", name: "Telephone and Data Systems Depositary Shares", exchange: "NYSE", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
        tvRow({ symbol: "ABCN", name: "ABC Holdings 6.250% Senior Notes due 2030", exchange: "NYSE", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
        tvRow({ symbol: "XYZW", name: "XYZ Acquisition Corp. Warrants", exchange: "NASDAQ", reportIso: "2026-05-21T21:00:00Z", postmarketPrice: 106 }),
      ],
    });

    expect(rows.map((row) => row.ticker)).toEqual(["AAPL", "BABA"]);
  });

  it("qualifies postmarket, regular-open, and both gap sources while excluding non-positive gaps", async () => {
    const env = createEnv({
      bars: [
        { ticker: "REG", date: "2026-05-19", o: 98, c: 100 },
        { ticker: "REG", date: "2026-05-20", o: 110, c: 112 },
        { ticker: "BOTH", date: "2026-05-20", o: 88, c: 90 },
        { ticker: "BOTH", date: "2026-05-21", o: 100, c: 101 },
        { ticker: "NOPE", date: "2026-05-20", o: 101, c: 100 },
        { ticker: "NOPE", date: "2026-05-21", o: 95, c: 96 },
      ],
    });

    const rows = await computeEarningsGapEvents(env, [
      release({ ticker: "PM", reportDate: "2026-05-21", price: 100, postmarketPrice: 106 }),
      release({ ticker: "REG", reportDate: "2026-05-20", reportTime: "before-market", price: 100 }),
      release({ ticker: "BOTH", reportDate: "2026-05-21", reportTime: "before-market", price: 100, postmarketPrice: 103 }),
      release({ ticker: "NOPE", reportDate: "2026-05-21", reportTime: "before-market", price: 100, postmarketPrice: 99 }),
    ], new Date("2026-05-22T00:00:00Z"));

    const byTicker = new Map(rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("PM")?.gapSource).toBe("postmarket");
    expect(byTicker.get("PM")?.postmarketGapPct).toBeCloseTo(6);
    expect(byTicker.get("REG")?.gapSource).toBe("regular_open");
    expect(byTicker.get("REG")?.regularOpenGapPct).toBeCloseTo(10);
    expect(byTicker.get("BOTH")?.gapSource).toBe("both");
    expect(byTicker.get("BOTH")?.qualifyingGapPct).toBeCloseTo(11.111, 3);
    expect(byTicker.has("NOPE")).toBe(false);
  });

  it("runs backfills as a 90-day window split into 7-day batches", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsGaps(env, { mode: "backfill", now: new Date("2026-05-22T00:00:00Z") });
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));

    expect(result.totalWindowStart).toBe("2026-02-21");
    expect(result.totalWindowEnd).toBe("2026-05-21");
    expect(result.batchWindowStart).toBe("2026-02-21");
    expect(result.batchWindowEnd).toBe("2026-02-27");
    expect(result.windowStart).toBe("2026-02-21");
    expect(result.windowEnd).toBe("2026-02-27");
    expect(result.nextCursor).toBe("2026-02-28");
    expect(result.done).toBe(false);
    expect(env.__metrics.cleanupRuns).toBe(0);
    expect(payload.filter[0].right).toEqual([unix("2026-02-21T00:00:00Z"), unix("2026-02-27T23:59:59Z")]);
  });

  it("marks the final backfill batch done and runs retention cleanup once", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsGaps(env, {
      mode: "backfill",
      cursor: "2026-05-21",
      now: new Date("2026-05-22T00:00:00Z"),
    });

    expect(result.batchWindowStart).toBe("2026-05-21");
    expect(result.batchWindowEnd).toBe("2026-05-21");
    expect(result.nextCursor).toBeNull();
    expect(result.done).toBe(true);
    expect(env.__metrics.cleanupRuns).toBe(1);
  });

  it("keeps incremental sync as a single completed window", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsGaps(env, { mode: "incremental", now: new Date("2026-05-22T00:00:00Z") });

    expect(result.windowStart).toBe("2026-05-15");
    expect(result.windowEnd).toBe("2026-05-21");
    expect(result.batchWindowStart).toBe("2026-05-15");
    expect(result.batchWindowEnd).toBe("2026-05-21");
    expect(result.totalWindowStart).toBe("2026-05-15");
    expect(result.totalWindowEnd).toBe("2026-05-21");
    expect(result.nextCursor).toBeNull();
    expect(result.done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.__metrics.cleanupRuns).toBe(1);
  });

  it("keeps one backfill batch inside the expected provider and D1 call counts", async () => {
    const env = createEnv();
    const data = Array.from({ length: 240 }, (_, index) => tvRow({
      symbol: `B${index}`,
      name: `Batch ${index}`,
      exchange: "NASDAQ",
      reportIso: "2026-02-22T21:00:00Z",
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: data.length, data }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsGaps(env, { mode: "backfill", now: new Date("2026-05-22T00:00:00Z") });

    expect(result.rowsSeen).toBe(240);
    expect(result.rowsUpserted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.__metrics.dailyBarQueries).toBe(3);
    expect(env.__metrics.cleanupRuns).toBe(0);
  });

  it("does not run the scheduled scan before 8pm ET", async () => {
    const env = createEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await maybeRunScheduledEarningsGapSync(env, new Date("2026-05-21T23:59:00Z"));

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the scheduled scan at 8pm ET and skips duplicates for the same local date", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 1,
        data: [
          tvRow({
            symbol: "PM",
            name: "Post Market Inc.",
            exchange: "NASDAQ",
            price: 100,
            reportIso: "2026-05-21T21:00:00Z",
            postmarketPrice: 106,
          }),
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await maybeRunScheduledEarningsGapSync(env, new Date("2026-05-22T00:00:00Z"));
    const second = await maybeRunScheduledEarningsGapSync(env, new Date("2026-05-22T00:15:00Z"));

    expect(first?.rowsUpserted).toBe(1);
    expect(first?.scheduledLocalDate).toBe("2026-05-21");
    expect(env.__events).toHaveLength(1);
    expect(env.__events[0].season).toBe("2026 Q2");
    expect(env.__syncs.some((row) => row.status === "ok" && row.scheduledLocalDate === "2026-05-21")).toBe(true);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores direct TradingView EPS values and falls back to the preferred Surprises snapshot", async () => {
    const env = createEnv({
      surprises: [
        { provider: "fmp", ticker: "DIRECT", reportDate: "2026-05-21", epsActual: 9, epsEstimate: 8, epsSurprise: 1, epsSurprisePct: 12.5 },
        { provider: "finnhub", ticker: "FALL", reportDate: "2026-05-21", epsActual: 4, epsEstimate: 2, epsSurprise: 2, epsSurprisePct: 100 },
        { provider: "fmp", ticker: "FALL", reportDate: "2026-05-21", epsActual: 1, epsEstimate: 0.8, epsSurprise: 0.2, epsSurprisePct: 25 },
      ],
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 2,
        data: [
          tvRow({
            symbol: "DIRECT",
            name: "Direct EPS Inc.",
            exchange: "NASDAQ",
            price: 100,
            reportIso: "2026-05-21T21:00:00Z",
            postmarketPrice: 106,
            epsActual: 2,
            epsEstimate: 1.5,
            epsSurprise: 0.5,
            epsSurprisePct: 33.333,
          }),
          tvRow({
            symbol: "FALL",
            name: "Fallback EPS Inc.",
            exchange: "NASDAQ",
            price: 100,
            reportIso: "2026-05-21T21:00:00Z",
            postmarketPrice: 105,
          }),
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsGaps(env, { mode: "incremental", now: new Date("2026-05-22T00:00:00Z") });
    const byTicker = new Map(env.__events.map((row) => [row.ticker, row]));

    expect(result.rowsUpserted).toBe(2);
    expect(byTicker.get("DIRECT")).toMatchObject({
      epsProvider: "tradingview",
      epsActual: 2,
      epsEstimate: 1.5,
      epsSurprise: 0.5,
      epsSurprisePct: 33.333,
    });
    expect(byTicker.get("FALL")).toMatchObject({
      epsProvider: "fmp",
      epsActual: 1,
      epsEstimate: 0.8,
      epsSurprise: 0.2,
      epsSurprisePct: 25,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters, sorts, and facets gap rows by season", async () => {
    const env = createEnv({
      events: [
        storedEvent({ ticker: "A", reportDate: "2026-02-10", season: "2026 Q1", qualifyingGapPct: 5 }),
        storedEvent({ ticker: "B", reportDate: "2026-05-10", season: "2026 Q2", qualifyingGapPct: 12 }),
        storedEvent({ ticker: "C", reportDate: "2026-05-11", season: "2026 Q2", qualifyingGapPct: 8 }),
      ],
    });

    const result = await queryEarningsGaps(env, {
      startDate: "2026-01-01",
      season: "2026 Q2",
      includeOtc: true,
      sort: "season",
      sortDir: "asc",
    });

    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.ticker)).toEqual(["B", "C"]);
    expect(result.rows.every((row) => row.season === "2026 Q2")).toBe(true);
    expect(result.facets.seasons).toContainEqual({ value: "2026 Q2", count: 2 });
  });

  it("returns EPS fields and sorts gap rows by EPS percentage and difference", async () => {
    const env = createEnv({
      events: [
        storedEvent({ ticker: "LOW", reportDate: "2026-05-10", epsProvider: "fmp", epsActual: 1.1, epsEstimate: 1, epsSurprise: 0.1, epsSurprisePct: 10 }),
        storedEvent({ ticker: "HIGH", reportDate: "2026-05-11", epsProvider: "tradingview", epsActual: 1.8, epsEstimate: 1, epsSurprise: 0.8, epsSurprisePct: 80 }),
      ],
    });

    const byPct = await queryEarningsGaps(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "epsSurprisePct",
      sortDir: "desc",
    });
    const byDiff = await queryEarningsGaps(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "epsSurprise",
      sortDir: "asc",
    });

    expect(byPct.rows.map((row) => row.ticker)).toEqual(["HIGH", "LOW"]);
    expect(byPct.rows[0]).toMatchObject({ epsProvider: "tradingview", epsActual: 1.8, epsEstimate: 1, epsSurprisePct: 80 });
    expect(byDiff.rows.map((row) => row.ticker)).toEqual(["LOW", "HIGH"]);
  });

  it("uses a deterministic total order for tied gap rows and exports", async () => {
    const env = createEnv({
      events: [
        storedEvent({ ticker: "AAPL", reportDate: "2026-04-01", qualifyingGapPct: 10 }),
        storedEvent({ ticker: "AAPL", reportDate: "2026-07-01", qualifyingGapPct: 10 }),
        storedEvent({ ticker: "MSFT", reportDate: "2026-06-01", qualifyingGapPct: 10 }),
      ],
    });

    const result = await queryEarningsGaps(env, { startDate: "2026-01-01", includeOtc: true, sort: "qualifyingGapPct", sortDir: "desc" });
    const exported = await exportEarningsGapTickers(env, { startDate: "2026-01-01", includeOtc: true, sort: "qualifyingGapPct", sortDir: "desc" });

    expect(result.rows.map((row) => row.id)).toEqual([
      "id-AAPL-2026-07-01",
      "id-AAPL-2026-04-01",
      "id-MSFT-2026-06-01",
    ]);
    expect(exported).toEqual(["AAPL", "AAPL", "MSFT"]);
    expect(env.__queries.filter((sql) => sql.includes("ORDER BY qualifying_gap_pct DESC")).every((sql) => (
      sql.includes("ORDER BY qualifying_gap_pct DESC, ticker ASC, report_date DESC, id ASC")
    ))).toBe(true);
  });

  it("excludes preferred issues from gap query, export, status, and supports limit zero", async () => {
    const env = createEnv({
      events: [
        storedEvent({ ticker: "AAPL", reportDate: "2026-05-10", season: "2026 Q2", qualifyingGapPct: 7, gapSource: "postmarket", sector: "Tech" }),
        storedEvent({ ticker: "FBIOP", reportDate: "2026-05-11", season: "2026 Q2", qualifyingGapPct: 40, companyName: "Fortress Biotech Series A Cumulative Redeemable Perpetual Preferred Stock", sector: "Health" }),
        storedEvent({ ticker: "CTO/PA", reportDate: "2026-05-12", season: "2026 Q2", qualifyingGapPct: 35, companyName: "CTO Realty Growth Preferred Stock", sector: "Finance" }),
        storedEvent({ ticker: "TDS/PU", reportDate: "2026-05-13", season: "2026 Q2", qualifyingGapPct: 30, companyName: "Telephone and Data Systems Depositary Shares", sector: "Telecom" }),
        storedEvent({ ticker: "TDS/PV", reportDate: "2026-05-14", season: "2026 Q2", qualifyingGapPct: 25, companyName: "Telephone and Data Systems Depositary Shares", sector: "Telecom" }),
        storedEvent({ ticker: "SHO/PH", reportDate: "2026-05-15", season: "2026 Q2", qualifyingGapPct: 20, companyName: "Sunstone Hotel Investors Preferred Shares", sector: "Real Estate" }),
        storedEvent({ ticker: "ABCN", reportDate: "2026-05-16", season: "2026 Q2", qualifyingGapPct: 18, companyName: "ABC Holdings 6.250% Senior Notes due 2030", sector: "Finance" }),
        storedEvent({ ticker: "XYZW", reportDate: "2026-05-17", season: "2026 Q2", qualifyingGapPct: 16, companyName: "XYZ Acquisition Corp. Warrants", sector: "Finance" }),
      ],
    });

    const result = await queryEarningsGaps(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "qualifyingGapPct",
      sortDir: "desc",
      limit: 0,
    });
    const exported = await exportEarningsGapTickers(env, { startDate: "2026-01-01", includeOtc: true, limit: 0 });
    const status = await loadEarningsGapsStatus(env);

    expect(result.limit).toBe(1000);
    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.ticker)).toEqual(["AAPL"]);
    expect(result.facets.sectors).toEqual([{ value: "Tech", count: 1 }]);
    expect(exported).toEqual(["AAPL"]);
    expect(status.counts.total).toBe(1);
    expect(status.counts.postmarket).toBe(1);
    expect(status.latestRows.map((row) => row.ticker)).toEqual(["AAPL"]);
  });

  it("exports top gap tickers with filters, sorting, and export limit clamp", async () => {
    const env = createEnv({
      events: [
        storedEvent({ ticker: "AAA", reportDate: "2026-05-10", season: "2026 Q2", qualifyingGapPct: 7 }),
        storedEvent({ ticker: "BBB", reportDate: "2026-05-11", season: "2026 Q2", qualifyingGapPct: 31 }),
        storedEvent({ ticker: "CCC", reportDate: "2026-05-12", season: "2026 Q2", qualifyingGapPct: 18 }),
        ...Array.from({ length: 1005 }, (_, index) => storedEvent({
          ticker: `X${String(index).padStart(4, "0")}`,
          reportDate: "2026-05-13",
          season: "2026 Q2",
          qualifyingGapPct: -index - 1,
        })),
      ],
    });

    const topTwo = await exportEarningsGapTickers(env, {
      startDate: "2026-01-01",
      season: "2026 Q2",
      includeOtc: true,
      sort: "qualifyingGapPct",
      sortDir: "desc",
      limit: 2,
    });
    const clamped = await exportEarningsGapTickers(env, { startDate: "2026-01-01", includeOtc: true, limit: 5000 });

    expect(topTwo).toEqual(["BBB", "CCC"]);
    expect(clamped).toHaveLength(1000);
  });

  it("reports the season migration when gap tables exist without the season column", async () => {
    const env = createEnv({ hasSeasonColumn: false });

    const result = await queryEarningsGaps(env);

    expect(result.schemaReady).toBe(false);
    expect(result.warning).toContain("0054_earnings_gap_season.sql");
  });

  it("reports the EPS migration when gap tables exist without the EPS columns", async () => {
    const env = createEnv({ hasEpsColumns: false });

    const result = await queryEarningsGaps(env);

    expect(result.schemaReady).toBe(false);
    expect(result.warning).toContain("0088_earnings_gap_eps.sql");
  });

  it("uses New York time across standard-time and daylight-time offsets", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const standardEarly = await maybeRunScheduledEarningsGapSync(env, new Date("2026-01-06T00:59:00Z"));
    const standardOnTime = await maybeRunScheduledEarningsGapSync(env, new Date("2026-01-06T01:00:00Z"));
    const daylightEnv = createEnv();
    const daylightOnTime = await maybeRunScheduledEarningsGapSync(daylightEnv, new Date("2026-05-22T00:00:00Z"));

    expect(standardEarly).toBeNull();
    expect(standardOnTime?.scheduledLocalDate).toBe("2026-01-05");
    expect(daylightOnTime?.scheduledLocalDate).toBe("2026-05-21");
  });
});
