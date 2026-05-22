import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTradingViewEarningsGapPayload,
  computeEarningsGapEvents,
  maybeRunScheduledEarningsGapSync,
  parseTradingViewEarningsGapRows,
  queryEarningsGaps,
  syncEarningsGaps,
  type EarningsGapEventInput,
  type EarningsGapReleaseInput,
} from "../src/earnings-gap-service";
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

function createEnv(input: { bars?: StoredBar[]; syncs?: StoredSync[]; events?: StoredEvent[]; hasSeasonColumn?: boolean } = {}): Env & {
  __events: StoredEvent[];
  __syncs: StoredSync[];
  __metrics: { cleanupRuns: number; dailyBarQueries: number };
} {
  const bars = input.bars ?? [];
  const syncs = [...(input.syncs ?? [])];
  const events: StoredEvent[] = [...(input.events ?? [])];
  const hasSeasonColumn = input.hasSeasonColumn ?? true;
  const metrics = { cleanupRuns: 0, dailyBarQueries: 0 };

  const countPlaceholders = (sql: string, field: string) => {
    const match = sql.match(new RegExp(`${field} IN \\(([^)]*)\\)`));
    return match ? (match[1].match(/\?/g) ?? []).length : 0;
  };
  const applyEventFilters = (sql: string, args: unknown[]) => {
    let cursor = 0;
    let rows = [...events];
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
    if (sql.includes("ORDER BY season ASC")) rows.sort((left, right) => left.season.localeCompare(right.season) || left.ticker.localeCompare(right.ticker));
    return rows;
  };

  const db = {
    prepare(sql: string) {
      const makeBound = (args: unknown[]) => ({
        __sql: sql,
        __args: args,
        async first<T>() {
          if (sql.includes("sqlite_master")) return { count: 1 } as T;
          if (sql.includes("pragma_table_info")) return { count: hasSeasonColumn ? 1 : 0 } as T;
          if (sql.includes("FROM earnings_gap_syncs WHERE scheduled_local_date")) {
            const localDate = String(args[0] ?? "");
            return (syncs.find((row) => row.scheduledLocalDate === localDate && row.status === "ok") ?? null) as T;
          }
          if (sql.includes("SELECT COUNT(*) as count FROM earnings_gap_events")) {
            return { count: applyEventFilters(sql, args).length } as T;
          }
          return null as T;
        },
        async all<T>() {
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

  return { DB: db as unknown as D1Database, __events: events, __syncs: syncs, __metrics: metrics };
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
    });
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

  it("reports the season migration when gap tables exist without the season column", async () => {
    const env = createEnv({ hasSeasonColumn: false });

    const result = await queryEarningsGaps(env);

    expect(result.schemaReady).toBe(false);
    expect(result.warning).toContain("0054_earnings_gap_season.sql");
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
