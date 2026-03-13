import { describe, expect, it } from "vitest";
import {
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
});
