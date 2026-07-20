import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTradingViewEarningsSurprisePayload,
  deriveEarningsSeason,
  exportEarningsSurpriseTickers,
  loadEarningsSurprisesSnapshot,
  loadEarningsSurprisesStatus,
  parseTradingViewEarningsSurpriseRows,
  queryEarningsSurprises,
  syncEarningsSurprises,
  type EarningsSurpriseRow,
} from "../src/earnings-surprise-service";
import { isExcludedEarningsIssue } from "../src/earnings-issue-filter";
import type { Env } from "../src/types";

type StoredEvent = Omit<EarningsSurpriseRow, "qualifyingGapPct" | "regularOpenGapPct"> &
  Partial<Pick<EarningsSurpriseRow, "qualifyingGapPct" | "regularOpenGapPct">> & {
  rawJson: string | null;
};

type StoredGapEvent = {
  ticker: string;
  reportDate: string;
  calculationStatus: "complete" | "provisional" | "deferred";
  qualifyingGapPct: number;
  regularOpenGapPct: number | null;
};

type StoredSync = {
  provider: string;
  status: string;
  mode: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowsSeen: number;
  rowsUpserted: number;
  updatedAt: string;
};

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function tvRow(input: {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  industry: string;
  marketCap: number;
  epsActual: number;
  epsEstimate: number;
  epsSurprisePct: number;
  reportIso: string;
  fiscalIso: string;
  close?: number | null;
  avgVolume30d?: number | null;
  avgDollarVolume30d?: number | null;
}) {
  const epsSurprise = input.epsActual - input.epsEstimate;
  return {
    s: `${input.exchange}:${input.symbol}`,
    d: [
      input.name,
      input.symbol,
      input.exchange,
      "stock",
      input.sector,
      input.industry,
      input.marketCap,
      input.epsActual,
      input.epsEstimate,
      epsSurprise,
      input.epsSurprisePct,
      100,
      95,
      5,
      5.263157,
      unix(input.reportIso),
      input.epsSurprisePct >= 0 ? 1 : -1,
      unix(input.fiscalIso),
      input.close ?? null,
      input.avgVolume30d ?? null,
      input.avgDollarVolume30d ?? null,
    ],
  };
}

function createEnv(
  seed: StoredEvent[] = [],
  gapSeed: StoredGapEvent[] = [],
  options: { gapSchemaReady?: boolean } = {},
): Env & { __events: StoredEvent[]; __syncs: Map<string, StoredSync>; __queries: string[] } {
  const events = [...seed];
  const gapEvents = [...gapSeed];
  const gapSchemaReady = options.gapSchemaReady ?? true;
  const syncs = new Map<string, StoredSync>();
  const queries: string[] = [];

  const applyFilters = (sql: string, args: unknown[]): StoredEvent[] => {
    let cursor = 0;
    const gapJoinEnabled = sql.includes("matchedGap.gapTicker");
    let rows = events.filter((row) => !isExcludedEarningsIssue(row)).map((row) => {
      const gap = gapJoinEnabled
        ? gapEvents.find((item) => (
            item.ticker === row.ticker
            && item.reportDate === row.reportDate
            && (item.calculationStatus === "complete" || item.calculationStatus === "provisional")
          ))
        : null;
      return {
        ...row,
        qualifyingGapPct: gap?.qualifyingGapPct ?? null,
        regularOpenGapPct: gap?.regularOpenGapPct ?? null,
      };
    });
    if (sql.includes("report_date >= ?")) {
      const startDate = String(args[cursor++] ?? "1900-01-01");
      rows = rows.filter((row) => row.reportDate >= startDate);
    }
    if (sql.includes("report_date <= ?")) {
      const endDate = String(args[cursor++] ?? "9999-12-31");
      rows = rows.filter((row) => row.reportDate <= endDate);
    }
    if (sql.includes("(ticker LIKE ?")) {
      const tickerPrefix = String(args[cursor++] ?? "").replace("%", "");
      const companyLike = String(args[cursor++] ?? "").replace(/%/g, "").toLowerCase();
      rows = rows.filter((row) => row.ticker.startsWith(tickerPrefix) || String(row.companyName ?? "").toLowerCase().includes(companyLike));
    }
    if (sql.includes("season = ?")) {
      const season = String(args[cursor++] ?? "");
      rows = rows.filter((row) => row.season === season);
    }
    if (sql.includes("market_cap >= ?")) {
      const min = Number(args[cursor++] ?? 0);
      rows = rows.filter((row) => Number(row.marketCap ?? 0) >= min);
    }
    if (sql.includes("market_cap <= ?")) {
      const max = Number(args[cursor++] ?? Number.POSITIVE_INFINITY);
      rows = rows.filter((row) => Number(row.marketCap ?? 0) <= max);
    }
    if (sql.includes("eps_surprise_pct >= ?")) {
      const min = Number(args[cursor++] ?? Number.NEGATIVE_INFINITY);
      rows = rows.filter((row) => Number(row.epsSurprisePct ?? Number.NEGATIVE_INFINITY) >= min);
    }
    const applyIn = (field: "sector" | "industry" | "exchange", regex: RegExp) => {
      const match = sql.match(regex);
      if (!match) return;
      const count = (match[1].match(/\?/g) ?? []).length;
      if (count === 0) return;
      const values = args.slice(cursor, cursor + count).map((value) => String(value).toUpperCase());
      cursor += count;
      rows = rows.filter((row) => values.includes(String(row[field] ?? "").toUpperCase()));
    };
    applyIn("sector", /sector IN \(([^)]+)\)/);
    applyIn("industry", /industry IN \(([^)]+)\)/);
    applyIn("exchange", /UPPER\(exchange\) IN \(([^)]+)\)/);
    if (sql.includes("UPPER(exchange) IN ('NASDAQ', 'NYSE', 'AMEX')")) {
      rows = rows.filter((row) => ["NASDAQ", "NYSE", "AMEX"].includes(String(row.exchange ?? "").toUpperCase()));
    }
    if (/(?:WHERE|AND)\s+eps_surprise_pct > 0/.test(sql)) rows = rows.filter((row) => Number(row.epsSurprisePct ?? 0) > 0);
    if (/(?:WHERE|AND)\s+eps_surprise_pct < 0/.test(sql)) rows = rows.filter((row) => Number(row.epsSurprisePct ?? 0) < 0);
    const sortMatch = sql.match(/ORDER BY ([A-Za-z0-9_.]+) (ASC|DESC)/);
    if (sortMatch) {
      const [, column, direction] = sortMatch;
      const map: Record<string, keyof StoredEvent> = {
        report_date: "reportDate",
        ticker: "ticker",
        eps_surprise_pct: "epsSurprisePct",
        market_cap: "marketCap",
        "matchedGap.qualifyingGapPct": "qualifyingGapPct",
        "matchedGap.regularOpenGapPct": "regularOpenGapPct",
      };
      const key = map[column] ?? "ticker";
      rows.sort((left, right) => {
        const a = left[key] ?? null;
        const b = right[key] ?? null;
        const result = a == null && b == null
          ? 0
          : a == null
            ? direction === "ASC" ? -1 : 1
            : b == null
              ? direction === "ASC" ? 1 : -1
              : typeof a === "number" && typeof b === "number"
                ? direction === "ASC" ? a - b : b - a
                : direction === "ASC"
                  ? String(a).localeCompare(String(b))
                  : String(b).localeCompare(String(a));
        if (result !== 0) return result;
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
          if (sql.includes("sqlite_master")) {
            const tableName = String(args[0] ?? "");
            return { count: tableName === "earnings_gap_events" && !gapSchemaReady ? 0 : 1 } as T;
          }
          if (sql.includes("pragma_table_info")) {
            return { count: sql.includes("earnings_gap_events") && !gapSchemaReady ? 0 : 1 } as T;
          }
          if (sql.includes("SELECT COUNT(*) as count FROM earnings_surprise_events")) {
            return { count: applyFilters(sql, args).length } as T;
          }
          if (sql.includes("MAX(report_date)")) {
            const rows = applyFilters(sql, args);
            return {
              total: rows.length,
              positive: rows.filter((row) => Number(row.epsSurprisePct ?? 0) > 0).length,
              negative: rows.filter((row) => Number(row.epsSurprisePct ?? 0) < 0).length,
              latestReportDate: rows.map((row) => row.reportDate).sort().at(-1) ?? null,
              earliestReportDate: rows.map((row) => row.reportDate).sort()[0] ?? null,
            } as T;
          }
          if (sql.includes("last_success_at as lastSuccessAt")) {
            return { lastSuccessAt: syncs.get(String(args[0]))?.lastSuccessAt ?? null } as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM earnings_surprise_syncs")) return { results: Array.from(syncs.values()) as T[] };
          if (sql.includes("GROUP BY")) {
            const field = (sql.match(/SELECT ([a-z_]+) as value/)?.[1] ?? "season") as keyof StoredEvent;
            const counts = new Map<string, number>();
            for (const row of applyFilters(sql, args)) {
              const value = String(row[field] ?? "");
              if (!value) continue;
              counts.set(value, (counts.get(value) ?? 0) + 1);
            }
            return { results: Array.from(counts.entries()).map(([value, count]) => ({ value, count })) as T[] };
          }
          if (sql.includes("FROM earnings_surprise_events")) {
            if (sql.trimStart().startsWith("SELECT ticker")) {
              const limit = Number(args.at(-1) ?? 100);
              return { results: applyFilters(sql, args.slice(0, -1)).slice(0, limit).map((row) => ({ ticker: row.ticker })) as T[] };
            }
            if (sql.includes("LIMIT ? OFFSET ?")) {
              const limit = Number(args.at(-2) ?? 100);
              const offset = Number(args.at(-1) ?? 0);
              return { results: applyFilters(sql, args.slice(0, -2)).slice(offset, offset + limit) as T[] };
            }
            return { results: applyFilters(sql, args) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("INSERT INTO earnings_surprise_syncs")) {
            const [provider, status, mode, windowStart, windowEnd, startedAt, successAt, error, rowsSeen, rowsUpserted] = args;
            const existing = syncs.get(String(provider));
            syncs.set(String(provider), {
              provider: String(provider),
              status: String(status),
              mode: mode == null ? null : String(mode),
              windowStart: windowStart == null ? null : String(windowStart),
              windowEnd: windowEnd == null ? null : String(windowEnd),
              lastStartedAt: startedAt == null ? existing?.lastStartedAt ?? null : String(startedAt),
              lastSuccessAt: status === "ok" ? String(successAt ?? "") : existing?.lastSuccessAt ?? null,
              lastError: error == null ? null : String(error),
              rowsSeen: Number(rowsSeen ?? 0),
              rowsUpserted: Number(rowsUpserted ?? 0),
              updatedAt: new Date().toISOString(),
            });
          }
          if (sql.includes("DELETE FROM earnings_surprise_events")) {
            const cutoff = String(args[0] ?? "");
            const before = events.length;
            for (let index = events.length - 1; index >= 0; index -= 1) {
              if (events[index].reportDate < cutoff) events.splice(index, 1);
            }
            return { meta: { changes: before - events.length } };
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
        if (!sql.includes("INSERT INTO earnings_surprise_events")) continue;
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
          avgDollarVolume30d,
          reportDate,
          reportTimestamp,
          reportTime,
          fiscalPeriodEnd,
          season,
          epsActual,
          epsEstimate,
          epsSurprise,
          epsSurprisePct,
          revenueActual,
          revenueEstimate,
          revenueSurprise,
          revenueSurprisePct,
          rawJson,
          firstSeenAt,
          lastSeenAt,
        ] = args;
        const uniqueIndex = events.findIndex((row) => row.ticker === ticker && row.reportDate === reportDate && row.fiscalPeriodEnd === fiscalPeriodEnd);
        const row = {
          id: String(id),
          provider: String(provider),
          sourceSymbol: String(sourceSymbol),
          ticker: String(ticker),
          exchange: exchange == null ? null : String(exchange),
          companyName: companyName == null ? null : String(companyName),
          sector: sector == null ? null : String(sector),
          industry: industry == null ? null : String(industry),
          marketCap: marketCap == null ? null : Number(marketCap),
          avgDollarVolume30d: avgDollarVolume30d == null ? null : Number(avgDollarVolume30d),
          reportDate: String(reportDate),
          reportTimestamp: reportTimestamp == null ? null : Number(reportTimestamp),
          reportTime: reportTime == null ? null : String(reportTime),
          fiscalPeriodEnd: fiscalPeriodEnd == null ? null : String(fiscalPeriodEnd),
          season: String(season),
          epsActual: epsActual == null ? null : Number(epsActual),
          epsEstimate: epsEstimate == null ? null : Number(epsEstimate),
          epsSurprise: epsSurprise == null ? null : Number(epsSurprise),
          epsSurprisePct: epsSurprisePct == null ? null : Number(epsSurprisePct),
          revenueActual: revenueActual == null ? null : Number(revenueActual),
          revenueEstimate: revenueEstimate == null ? null : Number(revenueEstimate),
          revenueSurprise: revenueSurprise == null ? null : Number(revenueSurprise),
          revenueSurprisePct: revenueSurprisePct == null ? null : Number(revenueSurprisePct),
          qualifyingGapPct: null,
          regularOpenGapPct: null,
          rawJson: rawJson == null ? null : String(rawJson),
          firstSeenAt: firstSeenAt == null ? null : String(firstSeenAt),
          lastSeenAt: lastSeenAt == null ? null : String(lastSeenAt),
        } satisfies StoredEvent;
        if (uniqueIndex >= 0) {
          events[uniqueIndex] = { ...events[uniqueIndex], ...row, firstSeenAt: events[uniqueIndex].firstSeenAt };
        } else {
          events.push(row);
        }
      }
      return [];
    },
  };
  return { DB: db as unknown as D1Database, __events: events, __syncs: syncs, __queries: queries };
}

describe("earnings surprise service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds TradingView positive and negative payloads", () => {
    const positive = buildTradingViewEarningsSurprisePayload({
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      side: "positive",
      offset: 500,
      limit: 250,
    });
    expect(positive.sort).toEqual({ sortBy: "eps_surprise_percent_fq", sortOrder: "desc" });
    expect(positive.range).toEqual([500, 750]);
    expect(positive.filter).toContainEqual({ left: "eps_surprise_percent_fq", operation: "greater", right: 0 });
    expect(positive.columns.slice(-3)).toEqual(["close", "average_volume_30d_calc", "AvgValue.Traded_30d"]);

    const negative = buildTradingViewEarningsSurprisePayload({
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      side: "negative",
    });
    expect(negative.sort.sortOrder).toBe("asc");
    expect(negative.filter).toContainEqual({ left: "eps_surprise_percent_fq", operation: "less", right: 0 });
  });

  it("parses TradingView earnings surprise rows and derives season", () => {
    const rows = parseTradingViewEarningsSurpriseRows({
      data: [
        tvRow({
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NASDAQ",
          sector: "Electronic Technology",
          industry: "Telecommunications Equipment",
          marketCap: 3_000_000_000_000,
          epsActual: 2.01,
          epsEstimate: 1.95,
          epsSurprisePct: 3.08,
          reportIso: "2026-05-01T20:30:00Z",
          fiscalIso: "2026-03-31T00:00:00Z",
          close: 200,
          avgVolume30d: 50_000_000,
          avgDollarVolume30d: 10_500_000_000,
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      exchange: "NASDAQ",
      reportDate: "2026-05-01",
      fiscalPeriodEnd: "2026-03-31",
      season: "2026 Q1",
      epsActual: 2.01,
      epsSurprisePct: 3.08,
      revenueSurprisePct: 5.263157,
      avgDollarVolume30d: 10_500_000_000,
    });
    expect(deriveEarningsSeason(null, "2026-05-20")).toBe("2026 Q2");
  });

  it("derives TradingView dollar volume from close and average volume when the direct field is null", () => {
    const [derived] = parseTradingViewEarningsSurpriseRows({
      data: [tvRow({
        symbol: "MSFT",
        name: "Microsoft",
        exchange: "NASDAQ",
        sector: "Tech",
        industry: "Software",
        marketCap: 3_000_000_000_000,
        epsActual: 3,
        epsEstimate: 2.5,
        epsSurprisePct: 20,
        reportIso: "2026-05-02T20:30:00Z",
        fiscalIso: "2026-03-31T00:00:00Z",
        close: 450,
        avgVolume30d: 20_000_000,
      })],
    });
    expect(derived.avgDollarVolume30d).toBe(9_000_000_000);
  });

  it("skips TradingView preferred and non-common issue rows", () => {
    const rows = parseTradingViewEarningsSurpriseRows({
      data: [
        tvRow({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", sector: "Tech", industry: "Hardware", marketCap: 3_000_000_000_000, epsActual: 2, epsEstimate: 1.8, epsSurprisePct: 11.1, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
        tvRow({ symbol: "BABA", name: "Alibaba Group Holding Limited American Depositary Shares", exchange: "NYSE", sector: "Retail", industry: "Internet Retail", marketCap: 180_000_000_000, epsActual: 2, epsEstimate: 1.8, epsSurprisePct: 11.1, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
        tvRow({ symbol: "FBIOP", name: "Fortress Biotech Inc. 9.375% Series A Cumulative Redeemable Perpetual Preferred Stock", exchange: "NASDAQ", sector: "Health Technology", industry: "Biotechnology", marketCap: 20_000_000, epsActual: 1, epsEstimate: 0.9, epsSurprisePct: 11.11, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
        tvRow({ symbol: "CTO/PA", name: "CTO Realty Growth Inc. Series A Preferred Stock", exchange: "NYSE", sector: "Finance", industry: "REITs", marketCap: 50_000_000, epsActual: 1, epsEstimate: 0.9, epsSurprisePct: 11.11, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
        tvRow({ symbol: "ABCN", name: "ABC Holdings 6.250% Senior Notes due 2030", exchange: "NYSE", sector: "Finance", industry: "Finance", marketCap: 50_000_000, epsActual: 1, epsEstimate: 0.9, epsSurprisePct: 11.11, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
        tvRow({ symbol: "XYZW", name: "XYZ Acquisition Corp. Warrants", exchange: "NASDAQ", sector: "Finance", industry: "SPAC", marketCap: 50_000_000, epsActual: 1, epsEstimate: 0.9, epsSurprisePct: 11.11, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
      ],
    });

    expect(rows.map((row) => row.ticker)).toEqual(["AAPL", "BABA"]);
  });

  it("syncs positive and negative TradingView rows idempotently", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sort?: { sortOrder?: string } };
      const positive = body.sort?.sortOrder === "desc";
      return {
        ok: true,
        json: async () => ({
          totalCount: positive ? 2 : 1,
          data: positive
            ? [
                tvRow({ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", sector: "Tech", industry: "Hardware", marketCap: 3_000_000_000_000, epsActual: 2, epsEstimate: 1.8, epsSurprisePct: 11.1, reportIso: "2026-05-01T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
                tvRow({ symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ", sector: "Tech", industry: "Software", marketCap: 2_900_000_000_000, epsActual: 3, epsEstimate: 2.5, epsSurprisePct: 20, reportIso: "2026-05-02T20:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
              ]
            : [
                tvRow({ symbol: "LOW", name: "Low Inc.", exchange: "NYSE", sector: "Retail", industry: "Home Improvement", marketCap: 80_000_000_000, epsActual: 1, epsEstimate: 1.2, epsSurprisePct: -16.7, reportIso: "2026-05-03T13:30:00Z", fiscalIso: "2026-03-31T00:00:00Z" }),
              ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncEarningsSurprises(env, { mode: "backfill", now: new Date("2026-05-20T12:00:00Z") });
    const second = await syncEarningsSurprises(env, { mode: "backfill", now: new Date("2026-05-20T12:00:00Z") });

    expect(first.rowsSeen).toBe(3);
    expect(second.rowsSeen).toBe(3);
    expect(env.__events.map((row) => row.ticker).sort()).toEqual(["AAPL", "LOW", "MSFT"]);
    expect(env.__events).toHaveLength(3);
    expect(env.__syncs.get("tradingview")?.status).toBe("ok");
  });

  it("falls back to FMP when TradingView fails", async () => {
    const env = createEnv();
    env.FMP_API_KEY = "fmp-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("scanner.tradingview.com")) {
        return { ok: false, text: async () => "blocked" };
      }
      return {
        ok: true,
        json: async () => [
          { symbol: "FMPA", date: "2026-05-01", eps: 1.2, epsEstimated: 1.0, name: "FMP Alpha" },
        ],
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncEarningsSurprises(env, { mode: "incremental", now: new Date("2026-05-20T12:00:00Z") });

    expect(result.provider).toBe("fmp");
    expect(env.__events).toHaveLength(1);
    expect(env.__events[0].ticker).toBe("FMPA");
    expect(env.__events[0].epsSurprisePct).toBeCloseTo(20);
    expect(env.__events[0].avgDollarVolume30d).toBeNull();
  });

  it("queries filters, sorting, pagination, and facets", async () => {
    const env = createEnv([
      { id: "1", provider: "tradingview", sourceSymbol: "NASDAQ:AAPL", ticker: "AAPL", exchange: "NASDAQ", companyName: "Apple Inc.", sector: "Tech", industry: "Hardware", marketCap: 3_000_000_000_000, avgDollarVolume30d: 12_000_000_000, reportDate: "2026-05-01", reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: 2, epsEstimate: 1.8, epsSurprise: 0.2, epsSurprisePct: 11.1, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null },
      { id: "2", provider: "tradingview", sourceSymbol: "NYSE:LOW", ticker: "LOW", exchange: "NYSE", companyName: "Low Inc.", sector: "Retail", industry: "Home Improvement", marketCap: 80_000_000_000, avgDollarVolume30d: null, reportDate: "2026-05-03", reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: 1, epsEstimate: 1.2, epsSurprise: -0.2, epsSurprisePct: -16.7, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null },
      { id: "3", provider: "tradingview", sourceSymbol: "OTC:OTCM", ticker: "OTCM", exchange: "OTC", companyName: "OTC Markets", sector: "Finance", industry: "Financial Publishing", marketCap: 700_000_000, avgDollarVolume30d: null, reportDate: "2026-05-04", reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: 1, epsEstimate: 0.9, epsSurprise: 0.1, epsSurprisePct: 11.11, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null },
    ]);

    const result = await queryEarningsSurprises(env, {
      startDate: "2026-01-01",
      season: "2026 Q1",
      surpriseSide: "positive",
      minMarketCap: 1_000_000_000,
      minEpsSurprisePct: 10,
      sort: "marketCap",
      sortDir: "desc",
      includeOtc: false,
    });

    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.ticker)).toEqual(["AAPL"]);
    expect(result.rows[0].avgDollarVolume30d).toBe(12_000_000_000);
    expect(result.facets.seasons).toContainEqual({ value: "2026 Q1", count: 1 });
  });

  it("enriches Surprise rows from visible gap snapshots without duplicating repeated events", async () => {
    const base = {
      provider: "tradingview",
      exchange: "NASDAQ",
      companyName: "Company",
      sector: "Tech",
      industry: "Software",
      marketCap: 1_000_000_000,
      avgDollarVolume30d: null,
      reportTimestamp: null,
      reportTime: null,
      season: "2026 Q2",
      epsActual: null,
      epsEstimate: null,
      epsSurprise: null,
      epsSurprisePct: 10,
      revenueActual: null,
      revenueEstimate: null,
      revenueSurprise: null,
      revenueSurprisePct: null,
      firstSeenAt: null,
      lastSeenAt: null,
      rawJson: null,
    };
    const env = createEnv([
      { ...base, id: "aaa-q1", sourceSymbol: "NASDAQ:AAA", ticker: "AAA", reportDate: "2026-07-16", fiscalPeriodEnd: "2026-03-31" },
      { ...base, id: "aaa-q2", sourceSymbol: "NASDAQ:AAA", ticker: "AAA", reportDate: "2026-07-16", fiscalPeriodEnd: "2026-06-30" },
      { ...base, id: "bbb", sourceSymbol: "NASDAQ:BBB", ticker: "BBB", reportDate: "2026-07-16", fiscalPeriodEnd: "2026-06-30" },
      { ...base, id: "ccc", sourceSymbol: "NASDAQ:CCC", ticker: "CCC", reportDate: "2026-07-16", fiscalPeriodEnd: "2026-06-30" },
      { ...base, id: "ddd", sourceSymbol: "NASDAQ:DDD", ticker: "DDD", reportDate: "2026-07-16", fiscalPeriodEnd: "2026-06-30" },
    ], [
      { ticker: "AAA", reportDate: "2026-07-16", calculationStatus: "complete", qualifyingGapPct: 12.5, regularOpenGapPct: 9.25 },
      { ticker: "BBB", reportDate: "2026-07-16", calculationStatus: "provisional", qualifyingGapPct: 4.5, regularOpenGapPct: null },
      { ticker: "CCC", reportDate: "2026-07-16", calculationStatus: "deferred", qualifyingGapPct: 20, regularOpenGapPct: 18 },
    ]);

    const snapshot = await loadEarningsSurprisesSnapshot(env, { startDate: "2026-01-01", includeOtc: true });
    const sorted = await queryEarningsSurprises(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "qualifyingGapPct",
      sortDir: "desc",
    });
    const status = await loadEarningsSurprisesStatus(env);
    const exported = await exportEarningsSurpriseTickers(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "regularOpenGapPct",
      sortDir: "desc",
    });

    expect(snapshot.total).toBe(5);
    expect(snapshot.rows.filter((row) => row.ticker === "AAA")).toHaveLength(2);
    expect(snapshot.rows.find((row) => row.ticker === "AAA")).toMatchObject({
      qualifyingGapPct: 12.5,
      regularOpenGapPct: 9.25,
    });
    expect(snapshot.rows.find((row) => row.ticker === "BBB")).toMatchObject({
      qualifyingGapPct: 4.5,
      regularOpenGapPct: null,
    });
    expect(snapshot.rows.find((row) => row.ticker === "CCC")).toMatchObject({
      qualifyingGapPct: null,
      regularOpenGapPct: null,
    });
    expect(snapshot.rows.find((row) => row.ticker === "DDD")).toMatchObject({
      qualifyingGapPct: null,
      regularOpenGapPct: null,
    });
    expect(sorted.rows.map((row) => row.ticker)).toEqual(["AAA", "AAA", "BBB", "CCC", "DDD"]);
    expect(status.latestRows.find((row) => row.ticker === "AAA")?.qualifyingGapPct).toBe(12.5);
    expect(exported).toEqual(["AAA", "AAA", "BBB", "CCC", "DDD"]);
  });

  it("keeps Surprises available with null gap fields when the gap schema is unavailable", async () => {
    const env = createEnv([{
      id: "1",
      provider: "tradingview",
      sourceSymbol: "NASDAQ:AAA",
      ticker: "AAA",
      exchange: "NASDAQ",
      companyName: "Company",
      sector: "Tech",
      industry: "Software",
      marketCap: 1_000_000_000,
      avgDollarVolume30d: null,
      reportDate: "2026-07-16",
      reportTimestamp: null,
      reportTime: null,
      fiscalPeriodEnd: "2026-06-30",
      season: "2026 Q2",
      epsActual: 1,
      epsEstimate: 0.9,
      epsSurprise: 0.1,
      epsSurprisePct: 11.1,
      revenueActual: null,
      revenueEstimate: null,
      revenueSurprise: null,
      revenueSurprisePct: null,
      firstSeenAt: null,
      lastSeenAt: null,
      rawJson: null,
    }], [
      { ticker: "AAA", reportDate: "2026-07-16", calculationStatus: "complete", qualifyingGapPct: 12.5, regularOpenGapPct: 9.25 },
    ], { gapSchemaReady: false });

    const result = await loadEarningsSurprisesSnapshot(env, {
      startDate: "2026-01-01",
      includeOtc: true,
    });

    expect(result.schemaReady).toBe(true);
    expect(result.rows[0]).toMatchObject({ qualifyingGapPct: null, regularOpenGapPct: null });
    expect(env.__queries.some((sql) => sql.includes("LEFT JOIN") && sql.includes("earnings_gap_events"))).toBe(false);
  });

  it("loads one unpaginated filtered snapshot and derives its facets", async () => {
    const base = { provider: "tradingview", exchange: "NASDAQ", companyName: "Company", industry: "Software", marketCap: 1_000_000_000, avgDollarVolume30d: null, reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q2", epsActual: null, epsEstimate: null, epsSurprise: null, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null };
    const env = createEnv([
      { ...base, id: "old", sourceSymbol: "NASDAQ:AAA", ticker: "AAA", sector: "Tech", reportDate: "2026-05-01", epsSurprisePct: 5 },
      { ...base, id: "new", sourceSymbol: "NASDAQ:BBB", ticker: "BBB", sector: "Tech", reportDate: "2026-05-03", epsSurprisePct: 10 },
      { ...base, id: "excluded", sourceSymbol: "NASDAQ:CCC", ticker: "CCC", sector: "Retail", reportDate: "2026-05-04", epsSurprisePct: -2 },
    ]);

    const result = await loadEarningsSurprisesSnapshot(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      surpriseSide: "positive",
    });

    expect(result.total).toBe(2);
    expect(result.rows.map((item) => item.id)).toEqual(["new", "old"]);
    expect(result.facets.sectors).toEqual([{ value: "Tech", count: 2 }]);
    const snapshotQueries = env.__queries.filter((sql) => sql.includes("FROM earnings_surprise_events"));
    expect(snapshotQueries).toHaveLength(1);
    expect(snapshotQueries[0]).not.toContain("LIMIT ? OFFSET ?");
    expect(snapshotQueries[0]).not.toContain("GROUP BY");
  });

  it("defaults public queries and exports to newest report date first", async () => {
    const base = { provider: "tradingview", exchange: "NASDAQ", companyName: "Company", sector: "Tech", industry: "Software", marketCap: 1_000_000_000, avgDollarVolume30d: null, reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q2", epsActual: null, epsEstimate: null, epsSurprise: null, epsSurprisePct: 1, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null };
    const env = createEnv([
      { ...base, id: "old", sourceSymbol: "NASDAQ:AAA", ticker: "AAA", reportDate: "2026-05-01" },
      { ...base, id: "new", sourceSymbol: "NASDAQ:BBB", ticker: "BBB", reportDate: "2026-05-03" },
    ]);

    const result = await queryEarningsSurprises(env, { startDate: "2026-01-01", includeOtc: true });
    const exported = await exportEarningsSurpriseTickers(env, { startDate: "2026-01-01", includeOtc: true });

    expect(result.rows.map((item) => item.id)).toEqual(["new", "old"]);
    expect(exported).toEqual(["BBB", "AAA"]);
    expect(env.__queries.filter((sql) => sql.includes("ORDER BY report_date DESC"))).toHaveLength(2);
  });

  it("loads status latest rows without recursively querying counts and facets", async () => {
    const env = createEnv([]);
    await loadEarningsSurprisesStatus(env);

    expect(env.__queries.some((sql) => sql.includes("GROUP BY"))).toBe(false);
    expect(env.__queries.some((sql) => sql.includes("LIMIT ? OFFSET ?"))).toBe(false);
    expect(env.__queries.some((sql) => sql.includes("ORDER BY report_date DESC, ticker ASC, id ASC") && sql.includes("LIMIT 12"))).toBe(true);
  });

  it("uses a deterministic total order for tied surprise rows and exports", async () => {
    const base = { provider: "tradingview", exchange: "NASDAQ", companyName: "Company", sector: "Tech", industry: "Software", marketCap: 1_000_000_000, avgDollarVolume30d: null, reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: null, epsEstimate: null, epsSurprise: null, epsSurprisePct: 10, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null };
    const env = createEnv([
      { ...base, id: "a-old", sourceSymbol: "NASDAQ:AAPL", ticker: "AAPL", reportDate: "2026-04-01" },
      { ...base, id: "a-new", sourceSymbol: "NASDAQ:AAPL", ticker: "AAPL", reportDate: "2026-07-01" },
      { ...base, id: "m", sourceSymbol: "NASDAQ:MSFT", ticker: "MSFT", reportDate: "2026-06-01" },
    ]);

    const result = await queryEarningsSurprises(env, { includeOtc: true, sort: "epsSurprisePct", sortDir: "desc" });
    const exported = await exportEarningsSurpriseTickers(env, { includeOtc: true, sort: "epsSurprisePct", sortDir: "desc" });

    expect(result.rows.map((row) => row.id)).toEqual(["a-new", "a-old", "m"]);
    expect(exported).toEqual(["AAPL", "AAPL", "MSFT"]);
    expect(env.__queries.filter((sql) => sql.includes("ORDER BY eps_surprise_pct DESC")).every((sql) => (
      sql.includes("ORDER BY eps_surprise_pct DESC, ticker ASC, report_date DESC, id ASC")
    ))).toBe(true);
  });

  it("excludes preferred issues from query, export, status, and supports limit zero", async () => {
    const base = { provider: "tradingview", exchange: "NASDAQ", companyName: "Company", sector: "Tech", industry: "Software", marketCap: 1_000_000_000, avgDollarVolume30d: null, reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: null, epsEstimate: null, epsSurprise: null, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null };
    const env = createEnv([
      { ...base, id: "1", sourceSymbol: "NASDAQ:AAPL", ticker: "AAPL", reportDate: "2026-05-01", epsSurprisePct: 5 },
      { ...base, id: "2", sourceSymbol: "NASDAQ:FBIOP", ticker: "FBIOP", companyName: "Fortress Biotech Series A Cumulative Redeemable Perpetual Preferred Stock", reportDate: "2026-05-02", epsSurprisePct: 50 },
      { ...base, id: "3", sourceSymbol: "NYSE:CTO/PA", ticker: "CTO/PA", companyName: "CTO Realty Growth Preferred Stock", reportDate: "2026-05-03", epsSurprisePct: 40 },
      { ...base, id: "4", sourceSymbol: "NYSE:TDS/PU", ticker: "TDS/PU", companyName: "Telephone and Data Systems Depositary Shares", reportDate: "2026-05-04", epsSurprisePct: 30 },
      { ...base, id: "5", sourceSymbol: "NYSE:TDS/PV", ticker: "TDS/PV", companyName: "Telephone and Data Systems Depositary Shares", reportDate: "2026-05-05", epsSurprisePct: 20 },
      { ...base, id: "6", sourceSymbol: "NYSE:SHO/PH", ticker: "SHO/PH", companyName: "Sunstone Hotel Investors Preferred Shares", reportDate: "2026-05-06", epsSurprisePct: 10 },
    ]);

    const result = await queryEarningsSurprises(env, {
      startDate: "2026-01-01",
      includeOtc: true,
      sort: "epsSurprisePct",
      sortDir: "desc",
      limit: 0,
    });
    const exported = await exportEarningsSurpriseTickers(env, { startDate: "2026-01-01", includeOtc: true, limit: 0 });
    const status = await loadEarningsSurprisesStatus(env);

    expect(result.limit).toBe(1000);
    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.ticker)).toEqual(["AAPL"]);
    expect(result.facets.sectors).toEqual([{ value: "Tech", count: 1 }]);
    expect(exported).toEqual(["AAPL"]);
    expect(status.counts.total).toBe(1);
    expect(status.counts.positive).toBe(1);
    expect(status.latestRows.map((row) => row.ticker)).toEqual(["AAPL"]);
  });

  it("exports top surprise tickers with filters, sorting, and export limit clamp", async () => {
    const base = { provider: "tradingview", exchange: "NASDAQ", companyName: "Company", sector: "Tech", industry: "Software", marketCap: 1_000_000_000, avgDollarVolume30d: null, reportTimestamp: null, reportTime: null, fiscalPeriodEnd: "2026-03-31", season: "2026 Q1", epsActual: null, epsEstimate: null, epsSurprise: null, revenueActual: null, revenueEstimate: null, revenueSurprise: null, revenueSurprisePct: null, firstSeenAt: null, lastSeenAt: null, rawJson: null };
    const env = createEnv([
      { ...base, id: "1", sourceSymbol: "NASDAQ:AAA", ticker: "AAA", reportDate: "2026-05-01", epsSurprisePct: 5 },
      { ...base, id: "2", sourceSymbol: "NASDAQ:BBB", ticker: "BBB", reportDate: "2026-05-02", epsSurprisePct: 25 },
      { ...base, id: "3", sourceSymbol: "NASDAQ:CCC", ticker: "CCC", reportDate: "2026-05-03", epsSurprisePct: 15 },
      ...Array.from({ length: 1005 }, (_, index) => ({
        ...base,
        id: `extra-${index}`,
        sourceSymbol: `NASDAQ:X${index}`,
        ticker: `X${String(index).padStart(4, "0")}`,
        reportDate: "2026-05-04",
        epsSurprisePct: -index - 1,
      })),
    ]);

    const topTwo = await exportEarningsSurpriseTickers(env, {
      startDate: "2026-01-01",
      surpriseSide: "positive",
      sort: "epsSurprisePct",
      sortDir: "desc",
      limit: 2,
    });
    const clamped = await exportEarningsSurpriseTickers(env, { startDate: "2026-01-01", includeOtc: true, limit: 5000 });
    const minFiltered = await exportEarningsSurpriseTickers(env, {
      startDate: "2026-01-01",
      minEpsSurprisePct: 10,
      sort: "epsSurprisePct",
      sortDir: "desc",
      limit: 10,
    });

    expect(topTwo).toEqual(["BBB", "CCC"]);
    expect(clamped).toHaveLength(1000);
    expect(minFiltered).toEqual(["BBB", "CCC"]);
  });
});
