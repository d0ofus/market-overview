import { afterEach, describe, expect, it, vi } from "vitest";
import { overviewPayload } from "../src/eod-runner";
import { computeEodTickerMetrics, EOD_METRICS_VERSION, type EodMetricBar } from "../src/eod-metrics";
import { loadEodOverview } from "../src/eod-publication-service";
import { summarizeVerifiedOverview } from "../src/factual-market-report";
import type { Env, SnapshotReadyResponse } from "../src/types";

function fixture(session = "2026-11-27") {
  const calendar: string[] = [];
  for (let date = new Date("2025-09-01T00:00:00Z"); date.toISOString().slice(0, 10) <= session; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    if (![0, 6].includes(date.getUTCDay()) && day !== "2026-11-26") calendar.push(day);
  }
  const item = (ticker: string) => ({ id: ticker, ticker, enabled: true, displayName: ticker, holdings: null, tags: [], order: 0,
    isEtfUniverseManaged: false, etfUniverseListType: null, etfUniverseFundName: null });
  const group = (id: string, title: string, tickers: string[]) => ({ id, title, order: 0, dataType: "equities", rankingWindowDefault: "1D" as const,
    showSparkline: true, pinTop10: true, columns: ["ticker", "price", "1D", "20SMA", "sparkline", "relativeStrength30dVsSpy"], items: tickers.map(item) });
  const inputs: Parameters<typeof overviewPayload>[0] = {
    tickers: ["SPY", "ABC"], memberships: [], calendarDates: calendar, methodologyVersion: EOD_METRICS_VERSION,
    config: { id: "default", name: "Fixture", timezone: "America/New_York", eodRunLocalTime: "16:20", eodRunTimeLabel: "After close",
      sections: [{ id: "equities", title: "Equities Overview", description: null, isCollapsible: false, defaultCollapsed: false, order: 0,
        groups: [group("indices", "US Index Futures", ["SPY"]), group("sectors", "Sector ETFs", ["ABC", ...Array.from({ length: 10 }, (_, i) => `S${i}`)]), group("duplicate", "Other", ["SPY"])] }] },
  };
  const gap = calendar.at(-10)!;
  const metric = (ticker: string, missing: string | null) => computeEodTickerMetrics({ ticker, targetSession: session, calendarDates: calendar,
    bars: calendar.filter((date) => date !== missing).map((sessionDate, i): EodMetricBar => ({ ticker, sessionDate, close: 100 + i / 10,
      high: 101 + i / 10, low: 99 + i / 10, reportedVolume: 1000, sourceProvider: "alpaca", sourceFeed: "sip", priceBasis: "split" })) });
  return { inputs, gap, features: new Map([["SPY", metric("SPY", null)], ["ABC", metric("ABC", gap)]]), session };
}

function readEnv(snapshot: SnapshotReadyResponse, completed: string | null) {
  const reads: Array<{ sql: string; args: unknown[] }> = [];
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    const statement = { bind(...values: unknown[]) { args = values; return statement; }, async first() {
      reads.push({ sql, args });
      if (sql.includes("COUNT(*)")) return { count: 1 };
      if (sql.includes("market_calendar_sessions")) return completed ? { date: completed } : null;
      return { id: "published-generation", payload: JSON.stringify(snapshot) };
    } };
    return statement;
  } };
  return { env: { EOD_READ_ENABLED: "true", MARKET_DATA_DB: db } as unknown as Env, reads };
}

describe("EOD Overview publication/UI contract", () => {
  afterEach(() => vi.useRealTimers());
  it("retains a dated provider failure for configured unavailable instruments",async () => {
    const input=fixture();
    const snapshot=overviewPayload(input.inputs,input.features,input.session,{S0:"yahoo-security-identity-mismatch"});
    const {env}=readEnv(snapshot,input.session);
    const loaded=await loadEodOverview(env);
    const missing=loaded!.sections[0]!.groups[1]!.rows.find((row) => row.ticker==="S0")!;
    expect(missing.price).toBeNull();
    expect(missing.currentData?.reason).toContain("yahoo-security-identity-mismatch");
    expect(missing.currentData?.reason).toContain(input.session);
  });
  it("supplies exact field provenance, all eleven sectors and date-aligned gaps", () => {
    const input = fixture();
    const snapshot = overviewPayload(input.inputs, input.features, input.session);
    const sector = snapshot.sections[0]!.groups[1]!;
    const abc = sector.rows[0]!;
    expect(sector.rows).toHaveLength(11);
    expect(sector.pinTop10).toBe(false);
    expect(snapshot.freshnessCurrentCount).toBe(2);
    expect(snapshot.freshnessEligibleCount).toBe(12);
    expect(abc.currentData?.fieldSources.price).toBe("alpaca:split-daily-bars");
    expect(abc.currentData?.fieldSources.change1d).toBeTruthy();
    expect(abc.above20Sma).toBeNull();
    expect(abc.currentData?.fieldSources.above20Sma).toBeUndefined();
    expect(abc.quoteFetchedAt).toBeNull();
    expect(abc.currentData?.fetchedAt).toBeNull();
    expect(abc.sparkline?.[abc.sparklineDates!.indexOf(input.gap)]).toBeNull();
    expect(abc.relativeStrength30dVsSpy?.[abc.relativeStrength30dDates!.indexOf(input.gap)]).toBeNull();
    expect(abc.historyData?.seriesStatus).toBe("fallback");
    expect(summarizeVerifiedOverview(snapshot, input.session)).toContain(`ABC: close ${abc.price!.toFixed(2)}`);
    expect(sector.rows[1]!.price).toBeNull();
    expect(sector.rows[1]!.currentData?.fieldSources).toEqual({});
  });
  it("rejects a zero-price candidate without suppressing partially verified rows", () => {
    const input = fixture();
    expect(() => overviewPayload(input.inputs, new Map(), input.session)).toThrow("overview-no-verified-prices");
    expect(overviewPayload(input.inputs, input.features, input.session).servingState).toBe("degraded");
  });
  it("uses the cached actual exchange close for early-close freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T18:30:00Z"));
    const input = fixture();
    const { env, reads } = readEnv(overviewPayload(input.inputs, input.features, input.session), "2026-11-27");
    const result = await loadEodOverview(env);
    expect(result?.expectedAsOfDate).toBe("2026-11-27");
    expect(result?.servingState).toBe("degraded");
    expect(result?.sections[0]!.groups[0]!.rows[0]!.quoteFreshnessStatus).toBe("fresh");
    expect(reads.find((read) => read.sql.includes("close_at<="))?.args)
      .toEqual(["2026-11-27", "2026-11-27", "13:30", "2026-11-27", "2026-11-27"]);
  });
  it("marks dated fallback rows stale instead of retaining publication-time fresh flags", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T18:30:00Z"));
    const input = fixture("2026-11-25");
    const original = overviewPayload(input.inputs, input.features, input.session);
    const { env } = readEnv(original, "2026-11-27");
    const result = await loadEodOverview(env);
    const spy = result?.sections[0]!.groups[0]!.rows[0]!;
    expect(result).toMatchObject({ servingState: "stale_fallback", freshnessCurrentCount: 0, staleTradingSessions: 1 });
    expect(spy).toMatchObject({ quoteFreshnessStatus: "stale", barDate: "2026-11-25", price: original.sections[0]!.groups[0]!.rows[0]!.price });
    expect(spy?.currentData).toMatchObject({ status: "stale", sessionDate: "2026-11-25" });
    expect(spy?.historyData?.seriesStatus).toBe("stale");
  });

  it("never labels a same-day publication current when calendar coverage is missing or expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T18:30:00Z"));
    const input = fixture();
    const { env, reads } = readEnv(overviewPayload(input.inputs, input.features, input.session), null);
    const result = await loadEodOverview(env);
    expect(result).toMatchObject({ expectedAsOfDate: null, servingState: "stale_fallback", freshnessStatus: "stale",
      freshnessCurrentCount: 0, freshnessCoveragePct: 0 });
    expect(result?.staleTradingSessions).toBeUndefined();
    expect(result?.freshnessWarning).toContain("could not be verified");
    const spy = result?.sections[0]!.groups[0]!.rows[0]!;
    expect(spy?.quoteFreshnessStatus).toBe("stale");
    expect(spy?.currentData?.status).toBe("stale");
    expect(reads.find((read) => read.sql.includes("market_calendar_sessions"))?.sql).toContain("covered_end>=?");
    expect(reads).toHaveLength(2);
  });
});
