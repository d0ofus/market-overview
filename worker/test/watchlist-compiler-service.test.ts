import { describe, expect, it } from "vitest";
import {
  duplicateWatchlistSet,
  filterWatchlistCandidatesBySections,
  parseWatchlistSourceSections,
  resolveExportFileName,
  shouldRunScheduledWatchlistCompile,
  tickersToSingleColumnCsv,
  tickersToTxt,
} from "../src/watchlist-compiler-service";

describe("watchlist compiler service helpers", () => {
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

  it("duplicates sets with fresh ids, unique copy naming, copied sources, and no run history", async () => {
    type MockStatement = {
      query: string;
      args: unknown[];
      bind: (...args: unknown[]) => MockStatement;
      first: () => Promise<any>;
      all: () => Promise<{ results: any[] }>;
      run: () => Promise<Record<string, never>>;
    };

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
