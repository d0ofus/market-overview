import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileWatchlistSet,
  duplicateWatchlistSet,
  filterWatchlistCandidatesBySections,
  parseWatchlistSourceSections,
  resolveExportFileName,
  shouldRunScheduledWatchlistCompile,
  tickersToSingleColumnCsv,
  tickersToTxt,
} from "../src/watchlist-compiler-service";

type MockStatement = {
  query: string;
  args: unknown[];
  bind: (...args: unknown[]) => MockStatement;
  first: () => Promise<any>;
  all: () => Promise<{ results: any[] }>;
  run: () => Promise<Record<string, never>>;
};

type CompileSourceRow = {
  id: string;
  setId: string;
  sourceName: string | null;
  sourceUrl: string;
  sourceSections: string | null;
  sortOrder: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
};

function createCompileEnv(sources: CompileSourceRow[]) {
  let batchStatements: MockStatement[] = [];
  const setRows = [{
    id: "set-a",
    scanDefinitionId: "scan-a",
    name: "Momentum",
    slug: "momentum",
    isActive: 1,
    compileDaily: 0,
    dailyCompileTimeLocal: null,
    dailyCompileTimezone: null,
    createdAt: "",
    updatedAt: "",
    sourceCount: sources.filter((source) => source.isActive).length,
  }];

  const makeStatement = (query: string, args: unknown[] = []): MockStatement => ({
    query,
    args,
    bind: (...nextArgs: unknown[]) => makeStatement(query, nextArgs),
    async first() {
      return null;
    },
    async all() {
      if (query.includes("JOIN (SELECT scan_id")) return { results: [] };
      if (query.includes("FROM tv_watchlist_sets s")) return { results: setRows };
      if (query.includes("FROM tv_watchlist_sources WHERE set_id = ?")) return { results: sources };
      return { results: [] };
    },
    async run() {
      return {};
    },
  });

  return {
    env: {
      DB: {
        prepare(query: string) {
          return makeStatement(query);
        },
        async batch(statements: MockStatement[]) {
          batchStatements = statements;
          return [];
        },
      },
    } as any,
    getBatchStatements: () => batchStatements,
  };
}

function compileSource(input: Partial<CompileSourceRow> & { id: string; sourceUrl: string }): CompileSourceRow {
  return {
    setId: "set-a",
    sourceName: null,
    sourceSections: null,
    sortOrder: 1,
    isActive: 1,
    createdAt: "",
    updatedAt: "",
    ...input,
  };
}

function scanRowStatements(statements: MockStatement[]) {
  return statements.filter((statement) => statement.query.includes("INSERT OR IGNORE INTO scan_run_rows"));
}

describe("watchlist compiler service helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders TradingView-friendly txt and csv exports", () => {
    expect(tickersToTxt(["AAPL", "MSFT", "PLTR"])).toBe("AAPL\nMSFT\nPLTR");
    expect(tickersToSingleColumnCsv(["AAPL", "MSFT"])).toBe("ticker\nAAPL\nMSFT");
  });

  it("uses browser-supplied date suffixes in export file names", () => {
    expect(resolveExportFileName({
      slug: "growth-watchlists",
      mode: "unique",
      extension: "txt",
      dateSuffix: "2026-03-13",
    })).toBe("growth-watchlists-2026-03-13.txt");
  });

  it("uses saved set names for compiled watchlist export file names", () => {
    expect(resolveExportFileName({
      slug: "growth-watchlists",
      setName: "Growth Watchlists",
      mode: "compiled",
      extension: "txt",
      dateSuffix: "2026-03-13",
    })).toBe("WatchlistComp-Growth Watchlists_03_13.txt");
  });

  it("runs a scheduled compile only once per local day inside the configured window", () => {
    const now = new Date("2026-03-13T00:20:00.000Z");

    expect(shouldRunScheduledWatchlistCompile({
      compileDaily: true,
      dailyCompileTimeLocal: "11:15",
      dailyCompileTimezone: "Australia/Sydney",
      latestRunIngestedAt: null,
      now,
    })).toBe(true);

    expect(shouldRunScheduledWatchlistCompile({
      compileDaily: true,
      dailyCompileTimeLocal: "11:15",
      dailyCompileTimezone: "Australia/Sydney",
      latestRunIngestedAt: "2026-03-13T00:10:00.000Z",
      now,
    })).toBe(false);
  });

  it("parses source section filters from textarea-style input", () => {
    expect(parseWatchlistSourceSections("FOCUS LIST - READY FOR EXECUTION\n###FOCUS LIST - CLOSE TO READY\n\n")).toEqual([
      "FOCUS LIST - READY FOR EXECUTION",
      "FOCUS LIST - CLOSE TO READY",
    ]);
  });

  it("keeps only candidates from the requested TradingView section", () => {
    const rows = filterWatchlistCandidatesBySections([
      { ticker: "ADEA", rankLabel: "LIVE ORDERS", raw: { section: "LIVE ORDERS" } },
      { ticker: "LUNR", rankLabel: "FOCUS LIST - READY FOR EXECUTION", raw: { section: "FOCUS LIST - READY FOR EXECUTION" } },
      { ticker: "TPL", rankLabel: "FOCUS LIST - READY FOR EXECUTION", raw: { section: "FOCUS LIST - READY FOR EXECUTION" } },
      { ticker: "GCT", rankLabel: "FOCUS LIST - CLOSE TO READY", raw: { section: "FOCUS LIST - CLOSE TO READY" } },
    ], "FOCUS LIST - READY FOR EXECUTION");

    expect(rows.map((row) => row.ticker)).toEqual(["LUNR", "TPL"]);
  });

  it("normalizes hashes and invisible formatting characters in section labels", () => {
    const rows = filterWatchlistCandidatesBySections([
      { ticker: "AAOI", rankLabel: "IN-PLAY: INDIVIDUAL/SECTORS", raw: { section: "###\u2064IN-PLAY: INDIVIDUAL/SECTORS" } },
    ], "###IN-PLAY: INDIVIDUAL/SECTORS");

    expect(rows.map((row) => row.ticker)).toEqual(["AAOI"]);
  });

  it("enriches compiled watchlist rows with TradingView Screener metrics", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/watchlists/111/")) {
        return new Response(
          `<html><script>{"list":{"symbols":["NASDAQ:AAPL","NYSE:PLTR"]}}</script></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (value === "https://scanner.tradingview.com/america/scan") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { symbols?: { tickers?: string[] } };
        const data = (body.symbols?.tickers ?? [])
          .map((symbol) => {
            if (symbol === "NASDAQ:AAPL") return { s: symbol, d: ["Apple Inc.", 180.25, 1.23, 55_000_000, 2_800_000_000_000, "NASDAQ", "stock"] };
            if (symbol === "NYSE:PLTR") return { s: symbol, d: ["Palantir Technologies Inc.", 22.5, -0.75, 80_000_000, 50_000_000_000, "NYSE", "stock"] };
            return null;
          })
          .filter(Boolean);
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch: ${value}`);
    });

    const { env, getBatchStatements } = createCompileEnv([
      compileSource({ id: "source-a", sourceName: "Ready", sourceUrl: "https://www.tradingview.com/watchlists/111/" }),
    ]);

    const result = await compileWatchlistSet(env, "set-a");
    const rowStatements = scanRowStatements(getBatchStatements());
    const aapl = rowStatements.find((statement) => statement.args[3] === "AAPL");
    const pltr = rowStatements.find((statement) => statement.args[3] === "PLTR");
    const runInsert = getBatchStatements().find((statement) => statement.query.includes("INSERT INTO scan_runs"));

    expect(result.run.status).toBe("ok");
    expect(rowStatements).toHaveLength(2);
    expect(aapl?.args.slice(3, 13)).toEqual(["AAPL", "Apple Inc.", "NASDAQ", "watchlist:0:NASDAQ:AAPL", 1, null, 180.25, 1.23, 55_000_000, 2_800_000_000_000]);
    expect(pltr?.args.slice(3, 13)).toEqual(["PLTR", "Palantir Technologies Inc.", "NYSE", "watchlist:1:NYSE:PLTR", 2, null, 22.5, -0.75, 80_000_000, 50_000_000_000]);
    expect(String(runInsert?.args[9] ?? "")).toContain("__metrics__");
    expect(String(runInsert?.args[9] ?? "")).toContain("TradingView Screener");
  });

  it("stores watchlist rows when TradingView metrics enrichment fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/watchlists/111/")) {
        return new Response(
          `<html><script>{"list":{"symbols":["NASDAQ:AAPL"]}}</script></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (value === "https://scanner.tradingview.com/america/scan") {
        return new Response("metrics unavailable", { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${value}`);
    });

    const { env, getBatchStatements } = createCompileEnv([
      compileSource({ id: "source-a", sourceUrl: "https://www.tradingview.com/watchlists/111/" }),
    ]);

    const result = await compileWatchlistSet(env, "set-a");
    const rowStatements = scanRowStatements(getBatchStatements());
    const runInsert = getBatchStatements().find((statement) => statement.query.includes("INSERT INTO scan_runs"));

    expect(result.run.status).toBe("ok");
    expect(result.run.error).toBeNull();
    expect(rowStatements).toHaveLength(1);
    expect(rowStatements[0]?.args.slice(3, 13)).toEqual(["AAPL", null, "NASDAQ", "watchlist:0:NASDAQ:AAPL", 1, null, null, null, null, null]);
    expect(String(runInsert?.args[9] ?? "")).toContain("TradingView metrics request failed (503)");
  });

  it("shares TradingView metrics across duplicate source occurrences while preserving each source", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/watchlists/111/")) {
        return new Response(
          `<html><script>{"list":{"symbols":["NASDAQ:AAPL"]}}</script></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (value.includes("/watchlists/222/")) {
        return new Response(
          `<html><script>{"list":{"symbols":["NYSE:AAPL"]}}</script></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (value === "https://scanner.tradingview.com/america/scan") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { symbols?: { tickers?: string[] } };
        const data = (body.symbols?.tickers ?? []).includes("NASDAQ:AAPL")
          ? [{ s: "NASDAQ:AAPL", d: ["Apple Inc.", 180.25, 1.23, 55_000_000, 2_800_000_000_000, "NASDAQ", "stock"] }]
          : [];
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch: ${value}`);
    });

    const { env, getBatchStatements } = createCompileEnv([
      compileSource({ id: "source-a", sourceName: "Ready", sourceUrl: "https://www.tradingview.com/watchlists/111/", sortOrder: 1 }),
      compileSource({ id: "source-b", sourceName: "Close", sourceUrl: "https://www.tradingview.com/watchlists/222/", sortOrder: 2 }),
    ]);

    await compileWatchlistSet(env, "set-a");
    const rowStatements = scanRowStatements(getBatchStatements());
    const rawSources = rowStatements.map((statement) => JSON.parse(String(statement.args[13])) as { sourceId: string; sourceUrl: string });

    expect(rowStatements).toHaveLength(2);
    expect(rowStatements.map((statement) => statement.args[3])).toEqual(["AAPL", "AAPL"]);
    expect(rowStatements.map((statement) => statement.args[4])).toEqual(["Apple Inc.", "Apple Inc."]);
    expect(rowStatements.map((statement) => statement.args[9])).toEqual([180.25, 180.25]);
    expect(rawSources).toEqual([
      expect.objectContaining({ sourceId: "source-a", sourceUrl: "https://www.tradingview.com/watchlists/111/" }),
      expect.objectContaining({ sourceId: "source-b", sourceUrl: "https://www.tradingview.com/watchlists/222/" }),
    ]);
  });

  it("duplicates sets with fresh ids, unique copy naming, copied sources, and no run history", async () => {
    const setRows = [
      {
        id: "set-a",
        scanDefinitionId: "scan-a",
        name: "Momentum",
        slug: "momentum",
        isActive: 1,
        compileDaily: 1,
        dailyCompileTimeLocal: "08:15",
        dailyCompileTimezone: "Australia/Sydney",
      },
      { id: "set-b", name: "Momentum Copy", slug: "momentum-copy" },
      { id: "set-c", name: "Momentum Copy 2", slug: "momentum-copy-2" },
    ];
    const sourceRows = [
      {
        id: "source-a",
        setId: "set-a",
        sourceName: "Ready",
        sourceUrl: "https://www.tradingview.com/watchlists/111/",
        sourceSections: "FOCUS LIST - READY",
        sortOrder: 10,
        isActive: 1,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "source-b",
        setId: "set-a",
        sourceName: null,
        sourceUrl: "https://www.tradingview.com/watchlists/222/",
        sourceSections: null,
        sortOrder: 20,
        isActive: 0,
        createdAt: "",
        updatedAt: "",
      },
    ];
    let batchStatements: MockStatement[] = [];

    const makeStatement = (query: string, args: unknown[] = []): MockStatement => ({
      query,
      args,
      bind: (...nextArgs: unknown[]) => makeStatement(query, nextArgs),
      async first() {
        if (query.includes("FROM tv_watchlist_sets WHERE id = ?")) return setRows[0];
        return null;
      },
      async all() {
        if (query.includes("SELECT name, slug FROM tv_watchlist_sets")) return { results: setRows };
        if (query.includes("FROM tv_watchlist_sources WHERE set_id = ?")) return { results: sourceRows };
        return { results: [] };
      },
      async run() {
        return {};
      },
    });

    const env = {
      DB: {
        prepare(query: string) {
          return makeStatement(query);
        },
        async batch(statements: MockStatement[]) {
          batchStatements = statements;
          return [];
        },
      },
    } as any;

    const duplicated = await duplicateWatchlistSet(env, "set-a");
    const scanDefinitionInsert = batchStatements.find((statement) => statement.query.includes("INSERT INTO scan_definitions"));
    const setInsert = batchStatements.find((statement) => statement.query.includes("INSERT INTO tv_watchlist_sets"));
    const sourceInserts = batchStatements.filter((statement) => statement.query.includes("INSERT INTO tv_watchlist_sources"));

    expect(duplicated.id).not.toBe("set-a");
    expect(scanDefinitionInsert?.args[0]).not.toBe("scan-a");
    expect(scanDefinitionInsert?.args[1]).toBe("Momentum Copy 3");
    expect(scanDefinitionInsert?.args[3]).toBe("watchlist-set:momentum-copy-3");

    expect(setInsert?.args).toEqual([
      duplicated.id,
      scanDefinitionInsert?.args[0],
      "Momentum Copy 3",
      "momentum-copy-3",
      1,
      1,
      "08:15",
      "Australia/Sydney",
    ]);

    expect(sourceInserts).toHaveLength(2);
    expect(sourceInserts[0]?.args.slice(1)).toEqual([
      duplicated.id,
      "Ready",
      "https://www.tradingview.com/watchlists/111/",
      "FOCUS LIST - READY",
      10,
      1,
    ]);
    expect(sourceInserts[1]?.args.slice(1)).toEqual([
      duplicated.id,
      null,
      "https://www.tradingview.com/watchlists/222/",
      null,
      20,
      0,
    ]);
    expect(sourceInserts[0]?.args[0]).not.toBe("source-a");
    expect(sourceInserts[1]?.args[0]).not.toBe("source-b");
    expect(batchStatements.some((statement) => /scan_runs|scan_run_rows/.test(statement.query))).toBe(false);
  });
});
