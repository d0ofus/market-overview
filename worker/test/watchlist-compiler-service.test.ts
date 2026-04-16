import { describe, expect, it } from "vitest";
import {
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
});
