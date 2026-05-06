import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPatternFeatureSnapshot,
  cancelPatternRun,
  continuePatternRun,
  extractPatternFeatures,
  listPatternCandidatesForReview,
  pausePatternRun,
  resumePatternRun,
  scorePatternSnapshot,
  type PatternDailyBar,
  type PatternLabel,
  type PatternModelVersion,
  type PatternRun,
} from "../src/pattern-scanner-service";
import type { Env } from "../src/types";

const refreshDailyBarsIncrementalMock = vi.hoisted(() => vi.fn());

vi.mock("../src/daily-bars", () => ({
  refreshDailyBarsIncremental: refreshDailyBarsIncrementalMock,
}));

vi.mock("../src/provider", () => ({
  getProvider: vi.fn(() => ({
    label: "Mock Provider",
    getDailyBars: vi.fn(),
  })),
}));

function makeBars(ticker: string, count: number, startClose = 50): PatternDailyBar[] {
  const start = new Date("2025-01-02T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const close = startClose + index * 0.3 + Math.sin(index / 6) * 1.5;
    return {
      ticker,
      date: date.toISOString().slice(0, 10),
      o: close - 0.2,
      h: close + 0.8,
      l: close - 0.9,
      c: close,
      volume: 1_000_000 + (index % 20) * 10_000,
    };
  });
}

function labelFromSnapshot(
  id: string,
  snapshot: NonNullable<ReturnType<typeof buildPatternFeatureSnapshot>>,
  label: "approved" | "rejected",
  status: PatternLabel["status"] = "active",
): PatternLabel {
  return {
    id,
    profileId: "default",
    ticker: snapshot.ticker,
    setupDate: snapshot.setupDate,
    label,
    status,
    source: "test",
    contextWindowBars: snapshot.contextWindowBars,
    patternWindowBars: snapshot.patternWindowBars,
    patternStartDate: snapshot.patternStartDate,
    patternEndDate: snapshot.patternEndDate,
    selectedBarCount: snapshot.selectedBarCount,
    selectionMode: snapshot.selectionMode,
    tags: [],
    notes: null,
    featureVersion: snapshot.featureVersion,
    featureJson: snapshot.featureJson,
    shapeJson: snapshot.shapeJson,
    windowHash: snapshot.windowHash,
    createdAt: snapshot.setupDate,
    updatedAt: snapshot.setupDate,
  };
}

function makePatternHydrationEnv(bars: PatternDailyBar[]): Env {
  const bindResult = (sql: string, args: unknown[]) => ({
    async first<T>() {
      return null as T;
    },
    async all<T>() {
      if (sql.includes("MAX(date) as latestBarDate")) {
        const endDate = String(args.at(-1));
        const startDate = String(args.at(-2));
        const tickers = args.slice(0, -2).map((value) => String(value).toUpperCase());
        const rows = tickers.map((ticker) => {
          const tickerBars = bars.filter((bar) => bar.ticker === ticker && bar.date >= startDate && bar.date <= endDate);
          if (tickerBars.length === 0) return null;
          return {
            ticker,
            latestBarDate: tickerBars.map((bar) => bar.date).sort().at(-1) ?? null,
            barCount: tickerBars.length,
          };
        }).filter(Boolean);
        return { results: rows as T[] };
      }
      if (sql.includes("ROW_NUMBER() OVER")) {
        const endDate = String(args.at(-2));
        const limit = Number(args.at(-1));
        const tickers = args.slice(0, -2).map((value) => String(value).toUpperCase());
        const rows = tickers.flatMap((ticker) => (
          bars
            .filter((bar) => bar.ticker === ticker && bar.date <= endDate)
            .sort((left, right) => right.date.localeCompare(left.date))
            .slice(0, limit)
            .sort((left, right) => left.date.localeCompare(right.date))
        )).sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date));
        return { results: rows as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      return {};
    },
  });
  const db = {
    prepare(sql: string) {
      return {
        ...bindResult(sql, []),
        bind(...args: unknown[]) {
          return bindResult(sql, args);
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;

  const patternDb = {
    prepare(sql: string) {
      return {
        ...bindResult(sql, []),
        bind(...args: unknown[]) {
          return bindResult(sql, args);
        },
      };
    },
  } as unknown as D1Database;

  return { DB: db, PATTERN_DB: patternDb };
}

function makeRunControlEnv(initial: PatternRun): Env & { __run: PatternRun; __latestDeletes: string[] } {
  const run = { ...initial };
  const latestDeletes: string[] = [];
  const row = () => ({
    ...run,
    autoContinue: run.autoContinue ? 1 : 0,
  });
  const applyRunPatch = (sql: string, args: unknown[]) => {
    let index = 0;
    if (sql.includes("status = ?")) run.status = args[index++] as PatternRun["status"];
    if (sql.includes("phase = ?")) run.phase = args[index++] as string;
    if (sql.includes("processed_count = ?")) run.processedCount = Number(args[index++]);
    if (sql.includes("matched_count = ?")) run.matchedCount = Number(args[index++]);
    if (sql.includes("cursor_offset = ?")) run.cursorOffset = Number(args[index++]);
    if (sql.includes("auto_continue = ?")) run.autoContinue = Number(args[index++]) === 1;
    if (sql.includes("last_advanced_at = ?")) run.lastAdvancedAt = args[index++] as string | null;
    if (sql.includes("lease_owner = ?")) run.leaseOwner = args[index++] as string | null;
    if (sql.includes("lease_expires_at = ?")) run.leaseExpiresAt = args[index++] as string | null;
    if (sql.includes("completed_at = ?")) run.completedAt = args[index++] as string | null;
    if (sql.includes("error = ?")) run.error = args[index++] as string | null;
    if (sql.includes("warning = ?")) run.warning = args[index++] as string | null;
    run.updatedAt = "2026-05-05T10:00:00.000Z";
  };
  const bindResult = (sql: string, args: unknown[]) => ({
    async first<T>() {
      if (sql.includes("FROM pattern_runs") && sql.includes("WHERE id = ?")) return row() as T;
      return null as T;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
    async run() {
      if (sql.startsWith("UPDATE pattern_runs SET")) applyRunPatch(sql, args);
      if (sql.startsWith("DELETE FROM pattern_scores_latest")) latestDeletes.push(String(args[0] ?? ""));
      return { meta: { changes: 1 } };
    },
  });
  const db = {
    prepare(sql: string) {
      return {
        ...bindResult(sql, []),
        bind(...args: unknown[]) {
          return bindResult(sql, args);
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;

  return { DB: db, PATTERN_DB: db, __run: run, __latestDeletes: latestDeletes } as Env & { __run: PatternRun; __latestDeletes: string[] };
}

function makeRun(overrides: Partial<PatternRun> = {}): PatternRun {
  return {
    id: "run-1",
    profileId: "default",
    tradingDate: "2026-05-05",
    status: "running",
    phase: "waiting_for_next_batch",
    totalCount: 957,
    processedCount: 120,
    matchedCount: 8,
    cursorOffset: 120,
    autoContinue: true,
    lastAdvancedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: "2026-05-05T09:00:00.000Z",
    updatedAt: "2026-05-05T09:10:00.000Z",
    completedAt: null,
    error: null,
    warning: null,
    ...overrides,
  };
}

type CandidateFixture = {
  id: string;
  ticker: string;
  score: number;
  reviewed?: boolean;
};

function makePatternCandidateEnv(candidates: CandidateFixture[]) {
  const profile = {
    id: "default",
    name: "Default",
    description: "Default",
    benchmarkTickersJson: "[\"SPY\"]",
    prefilterConfigJson: JSON.stringify({ minPrice: 3, minDollarVolume20d: 5_000_000, minBars: 260 }),
    activeModelId: null,
    settingsJson: JSON.stringify({
      contextWindowBars: 260,
      patternWindowBars: 40,
      candidateLimit: 100,
      matchScoreThreshold: 0.6,
      selectedResamplePoints: 64,
      candidatePatternLengths: [20, 40, 60],
    }),
    createdAt: "2026-05-05T00:00:00Z",
    updatedAt: "2026-05-05T00:00:00Z",
  };
  const run = {
    id: "run-1",
    profileId: "default",
    tradingDate: "2026-05-05",
    status: "completed",
    phase: "completed",
    totalCount: 4,
    processedCount: 4,
    matchedCount: 2,
    cursorOffset: 4,
    startedAt: "2026-05-05T21:00:00Z",
    updatedAt: "2026-05-05T21:05:00Z",
    completedAt: "2026-05-05T21:05:00Z",
    error: null,
    warning: null,
  };
  const filteredCandidates = (args: unknown[], sql: string) => {
    const hasScoreFilter = /score >= \?/.test(sql);
    const hasReviewFilter = /NOT EXISTS/.test(sql);
    const threshold = hasScoreFilter ? Number(args[1]) : 0;
    return candidates
      .filter((candidate) => !hasScoreFilter || candidate.score >= threshold)
      .filter((candidate) => !hasReviewFilter || !candidate.reviewed);
  };
  const db = {
    prepare(sql: string) {
      return {
        __sql: sql,
        __args: [] as unknown[],
        bind(...args: unknown[]) {
          return {
            __sql: sql,
            __args: args,
            async first() {
              if (sql.includes("FROM pattern_profiles")) return profile;
              if (sql.includes("FROM pattern_runs")) return run;
              if (sql.includes("COUNT(*)") && sql.includes("pattern_review_events")) {
                return { count: filteredCandidates(args, sql).filter((candidate) => candidate.reviewed).length };
              }
              if (sql.includes("COUNT(*)") && sql.includes("FROM pattern_run_candidates")) {
                return { count: filteredCandidates(args, sql).length };
              }
              throw new Error(`Unhandled first query: ${sql}`);
            },
            async all() {
              if (sql.includes("FROM pattern_run_candidates")) {
                const rows = filteredCandidates(args.slice(1), sql)
                  .sort((left, right) => right.score - left.score || left.ticker.localeCompare(right.ticker))
                  .map((candidate, index) => ({
                    id: candidate.id,
                    runId: "run-1",
                    profileId: "default",
                    ticker: candidate.ticker,
                    rank: index + 1,
                    score: candidate.score,
                    reasonsJson: JSON.stringify({
                      score: candidate.score,
                      mode: "heuristic",
                      approvedSimilarity: null,
                      rejectedSimilarity: null,
                      scalarSimilarity: null,
                      shapeSimilarity: null,
                      activeLearningPriority: 0,
                      heuristicScore: candidate.score,
                      positiveContributions: [],
                      negativeContributions: [],
                      summary: [],
                    }),
                    nearestApprovedJson: "[]",
                    nearestRejectedJson: "[]",
                    featureJson: "{}",
                    shapeJson: "{}",
                    sourceMetadataJson: "{}",
                    createdAt: "2026-05-05T21:05:00Z",
                    tradingDate: "2026-05-05",
                  }));
                return { results: rows };
              }
              throw new Error(`Unhandled all query: ${sql}`);
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
  return { PATTERN_DB: db as unknown as D1Database };
}

describe("pattern scanner service", () => {
  beforeEach(() => {
    refreshDailyBarsIncrementalMock.mockReset();
  });

  it("extracts deterministic fixed-length features without future bars", () => {
    const tickerBars = makeBars("TEST", 120, 30);
    const benchmarkBars = makeBars("SPY", 120, 100);
    const setupDate = tickerBars[90].date;
    const withFuture = buildPatternFeatureSnapshot({
      ticker: "TEST",
      setupDate,
      tickerBars,
      benchmarkBars,
      benchmarkTicker: "SPY",
    });
    const withoutFuture = buildPatternFeatureSnapshot({
      ticker: "TEST",
      setupDate,
      tickerBars: tickerBars.slice(0, 91),
      benchmarkBars: benchmarkBars.slice(0, 91),
      benchmarkTicker: "SPY",
    });

    expect(withFuture).not.toBeNull();
    expect(withoutFuture).not.toBeNull();
    expect(withFuture?.windowHash).toBe(withoutFuture?.windowHash);
    expect(withFuture?.featureJson).toEqual(withoutFuture?.featureJson);
    expect(withFuture?.shapeJson.price_path_40d).toHaveLength(40);
    expect(withFuture?.shapeJson.relative_strength_path_60d).toHaveLength(60);
    expect(withFuture?.shapeJson.selected_price_path_64).toHaveLength(64);
    expect(withFuture?.sourceMetadata.latestBarDate).toBe(setupDate);
  });

  it("uses a chart-selected date range for pattern-sensitive features", () => {
    const tickerBars = makeBars("RANGE", 140, 40);
    const benchmarkBars = makeBars("SPY", 140, 100);
    const setupDate = tickerBars[110].date;
    const startDate = tickerBars[82].date;
    const snapshot = buildPatternFeatureSnapshot({
      ticker: "RANGE",
      setupDate,
      patternStartDate: startDate,
      patternEndDate: setupDate,
      selectionMode: "chart_range",
      tickerBars,
      benchmarkBars,
      benchmarkTicker: "SPY",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.patternStartDate).toBe(startDate);
    expect(snapshot?.patternEndDate).toBe(setupDate);
    expect(snapshot?.selectedBarCount).toBe(29);
    expect(snapshot?.featureJson.base_length_bars).toBe(29);
    expect(snapshot?.shapeJson.selected_price_path_64).toHaveLength(64);
    expect(snapshot?.sourceMetadata.latestBarDate).toBe(setupDate);
  });

  it("returns null when stored bars are insufficient", () => {
    const snapshot = buildPatternFeatureSnapshot({
      ticker: "THIN",
      setupDate: "2025-02-15",
      tickerBars: makeBars("THIN", 20, 10),
      benchmarkBars: makeBars("SPY", 80, 100),
      benchmarkTicker: "SPY",
    });

    expect(snapshot).toBeNull();
  });

  it("hydrates missing stored bars before extracting selected pattern features", async () => {
    const bars: PatternDailyBar[] = [];
    const tickerBars = makeBars("HYDR", 90, 30);
    const benchmarkBars = makeBars("SPY", 90, 100);
    const setupDate = tickerBars[79].date;
    const env = makePatternHydrationEnv(bars);
    refreshDailyBarsIncrementalMock.mockImplementation(async (_env: Env, input: { tickers: string[]; startDate: string; endDate: string }) => {
      const fetched = [...tickerBars, ...benchmarkBars].filter((bar) => (
        input.tickers.includes(bar.ticker) && bar.date >= input.startDate && bar.date <= input.endDate
      ));
      bars.push(...fetched);
      return {
        requestedTickers: input.tickers.length,
        fetchedRows: fetched.length,
        writtenRows: fetched.length,
        skippedCurrentTickers: 0,
      };
    });

    const snapshot = await extractPatternFeatures(env, {
      ticker: "HYDR",
      setupDate,
      contextWindowBars: 80,
      patternWindowBars: 40,
    });

    expect(refreshDailyBarsIncrementalMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tickers: ["HYDR", "SPY"],
        endDate: setupDate,
        replaceExisting: true,
      }),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.sourceMetadata.barCount).toBe(80);
    expect(snapshot?.sourceMetadata.latestBarDate).toBe(setupDate);
  });

  it("scores with model mode when enough active labels are present", () => {
    const approvedSnapshots = [0, 1, 2].map((offset) => buildPatternFeatureSnapshot({
      ticker: `APP${offset}`,
      setupDate: "2025-04-20",
      tickerBars: makeBars(`APP${offset}`, 120, 50 + offset),
      benchmarkBars: makeBars("SPY", 120, 100),
      benchmarkTicker: "SPY",
    })!);
    const rejectedSnapshots = [0, 1, 2].map((offset) => buildPatternFeatureSnapshot({
      ticker: `REJ${offset}`,
      setupDate: "2025-04-20",
      tickerBars: makeBars(`REJ${offset}`, 120, 20 - offset),
      benchmarkBars: makeBars("SPY", 120, 100),
      benchmarkTicker: "SPY",
    })!);
    const labels = [
      ...approvedSnapshots.map((snapshot, index) => labelFromSnapshot(`a-${index}`, snapshot, "approved")),
      ...rejectedSnapshots.map((snapshot, index) => labelFromSnapshot(`r-${index}`, snapshot, "rejected")),
    ];
    const model: PatternModelVersion = {
      id: "model-1",
      profileId: "default",
      modelType: "similarity_v1",
      featureVersion: "v1",
      approvedCount: 3,
      rejectedCount: 3,
      active: true,
      createdAt: "2025-04-20",
      metrics: {
        enoughLabels: true,
        approvedCount: 3,
        rejectedCount: 3,
        totalActiveLabels: 6,
        chronologicalAccuracy: null,
        precisionAt25: null,
        precisionAt50: null,
        validationWindowSize: 0,
      },
      featureSummary: { scalarStats: {}, topWeightedFeatures: [] },
      model: {
        modelType: "similarity_v1",
        featureVersion: "v1",
        enoughLabels: true,
        scalarKeys: ["prior_runup_60d_pct", "close_vs_50sma_pct", "base_depth_pct"],
        shapeKeys: ["price_path_40d"],
        scalarNormalization: {
          prior_runup_60d_pct: { mean: 0, std: 20 },
          close_vs_50sma_pct: { mean: 0, std: 10 },
          base_depth_pct: { mean: 20, std: 10 },
        },
        approvedScalarCentroid: {
          prior_runup_60d_pct: 1,
          close_vs_50sma_pct: 1,
          base_depth_pct: 0,
        },
        rejectedScalarCentroid: {
          prior_runup_60d_pct: -1,
          close_vs_50sma_pct: -1,
          base_depth_pct: 1,
        },
        approvedShapeCentroid: { price_path_40d: approvedSnapshots[0].shapeJson.price_path_40d },
        rejectedShapeCentroid: { price_path_40d: rejectedSnapshots[0].shapeJson.price_path_40d },
        featureWeights: {},
        tagWeights: {},
        nearestReferences: { approved: [], rejected: [] },
      },
    };

    const score = scorePatternSnapshot(approvedSnapshots[0], labels, model);

    expect(score.mode).toBe("model");
    expect(score.score).toBeGreaterThan(0.5);
    expect(score.positiveContributions.length).toBeGreaterThan(0);
  });

  it("pauses a running pattern scan without deleting partial progress", async () => {
    const env = makeRunControlEnv(makeRun());

    const paused = await pausePatternRun(env, "run-1");

    expect(paused?.status).toBe("paused");
    expect(paused?.phase).toBe("paused");
    expect(paused?.autoContinue).toBe(false);
    expect(paused?.processedCount).toBe(120);
  });

  it("resumes a paused pattern scan with auto continuation", async () => {
    const env = makeRunControlEnv(makeRun({ status: "paused", phase: "paused", autoContinue: false, warning: "Paused by user." }));

    const resumed = await resumePatternRun(env, "run-1");

    expect(resumed?.status).toBe("running");
    expect(resumed?.phase).toBe("waiting_for_next_batch");
    expect(resumed?.autoContinue).toBe(true);
    expect(resumed?.warning).toBeNull();
  });

  it("continues a stalled running pattern scan", async () => {
    const env = makeRunControlEnv(makeRun({ autoContinue: false }));

    const continued = await continuePatternRun(env, "run-1");

    expect(continued?.status).toBe("running");
    expect(continued?.phase).toBe("waiting_for_next_batch");
    expect(continued?.autoContinue).toBe(true);
  });

  it("cancels a running pattern scan and removes it from latest candidates", async () => {
    const env = makeRunControlEnv(makeRun());

    const cancelled = await cancelPatternRun(env, "run-1");

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.phase).toBe("cancelled");
    expect(cancelled?.autoContinue).toBe(false);
    expect(cancelled?.completedAt).not.toBeNull();
    expect(env.__latestDeletes).toEqual(["run-1"]);
  });

  it("lists matched candidates in descending score order", async () => {
    const env = makePatternCandidateEnv([
      { id: "c-low", ticker: "LOW", score: 0.52 },
      { id: "c-top", ticker: "TOP", score: 0.91 },
      { id: "c-mid", ticker: "MID", score: 0.72 },
    ]);

    const result = await listPatternCandidatesForReview(env as any, {
      profileId: "default",
      scope: "matched",
      reviewed: "include",
      limit: 10,
    });

    expect(result.matchScoreThreshold).toBe(0.6);
    expect(result.totalCandidateCount).toBe(2);
    expect(result.rows.map((row) => row.ticker)).toEqual(["TOP", "MID"]);
  });

  it("excludes reviewed candidates when requested", async () => {
    const env = makePatternCandidateEnv([
      { id: "c-top", ticker: "TOP", score: 0.91, reviewed: true },
      { id: "c-mid", ticker: "MID", score: 0.72 },
      { id: "c-low", ticker: "LOW", score: 0.52 },
    ]);

    const result = await listPatternCandidatesForReview(env as any, {
      profileId: "default",
      scope: "matched",
      reviewed: "exclude",
      limit: 10,
    });

    expect(result.totalCandidateCount).toBe(2);
    expect(result.reviewedHiddenCount).toBe(1);
    expect(result.rows.map((row) => row.ticker)).toEqual(["MID"]);
  });
});
