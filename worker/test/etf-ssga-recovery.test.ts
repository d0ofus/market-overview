import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSsgaHoldingsLinks, fetchSsgaFundDataConstituents, parseSsgaHoldingsFile, syncEtfConstituents } from "../src/etf";
import type { Env } from "../src/types";
import { etfHoldingsIssue, etfHoldingAssetType, prepareStoredEtfHoldings } from "../src/etf-holdings-quality";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const PAGE = "https://www.ssga.com/us/en/intermediary/etfs/state-street-communication-services-select-sector-spdr-etf-xlc";
const HOLDINGS = "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xlc.xlsx";
const NOW = new Date("2026-09-11T06:00:00Z");
// Header/column layout observed in the official XLC workbook on Sep11; row
// prices/positions are synthetic. The source date is separate from collection.
function workbook(options: { ticker?: string; date?: string | null; sheet?: string } = {}): ArrayBuffer {
  const rows = [["Fund Name:", "State Street Communication Services Select Sector SPDR ETF"],
    ["Ticker Symbol:", options.ticker ?? "XLC"],
    ["Holdings:", options.date === null ? "Unavailable" : `As of ${options.date ?? "09-Sep-2026"}`],
    ["Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"],
    ["Example A", "META", "1", "1", 60, "-", 100, "USD"],
    ["Example B", "GOOGL", "2", "2", 40, "-", 200, "USD"]];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), options.sheet ?? "holdings");
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
function page() {
  return `<a href="/library-content/products/fund-data/etfs/us/pdhist-us-en-xlc.xlsx">Fund Data</a>
    <a href="/library-content/products/fund-data/etfs/us/navhist-us-en-xlc.xlsx">NAV</a>
    <a href="${HOLDINGS}">Download All Holdings</a>`;
}
function xlsxResponse(body = workbook()) {
  return new Response(body, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
}
function actualWorkbook(): ArrayBuffer {
  const fixture = JSON.parse(readFileSync("test/fixtures/ssga-xlc-2026-09-09.json", "utf8")) as { rows: unknown[][] };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(fixture.rows), "holdings");
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
let sqlite: ReturnType<typeof createSqliteD1> | undefined;
afterEach(() => { sqlite?.dispose(); sqlite = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("SSGA official holdings recovery", () => {
  it("distinguishes the USD listed fund from an explicitly identified US-dollar balance", () => {
    const usdFund = { ticker: "USD", name: "ProShares Ultra Semiconductors ETF", weight: 5,
      source: "ssga:fund-data", asOfDate: "2026-09-09", updatedAt: NOW.toISOString() };
    const cash = { ...usdFund, name: "US DOLLAR" };
    expect(etfHoldingAssetType("XLC", usdFund)).toBe("fund");
    expect(prepareStoredEtfHoldings("XLC", [usdFund], null, NOW).rows[0]).toMatchObject({ assetType: "fund", chartEligible: true });
    expect(prepareStoredEtfHoldings("XLC", [cash], null, NOW).rows[0]).toMatchObject({ assetType: "cash", chartEligible: false });
    expect(etfHoldingAssetType("XLC", { ticker: "USD", name: null, source: "unknown" })).toBe("equity");
    expect(etfHoldingsIssue("XLC", [{ ...usdFund, ticker: "-", name: "Unknown holding", source: "unknown" }]))
      .toBe("holdings-security-identity-invalid");
  });

  it("preserves every actual reported position and permits signed weight only for verified futures", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const parsed = parseSsgaHoldingsFile("XLC", actualWorkbook(), "xlsx");
    expect(parsed.holdings).toHaveLength(27);
    const prepared = prepareStoredEtfHoldings("XLC", parsed.holdings.map(row => ({ ...row,
      source: "ssga:fund-data", asOfDate: parsed.asOfDate, updatedAt: NOW.toISOString() })), null, NOW);
    expect(prepared.holdings.status).toBe("ready");
    expect(prepared.rows.filter(row => row.chartEligible)).toHaveLength(24);
    expect(prepared.rows.filter(row => !row.chartEligible).map(row => ({ ticker: row.ticker, assetType: row.assetType, weight: row.weight })))
      .toEqual([{ ticker: "-", assetType: "money_market", weight: 0.131309 },
        { ticker: "USD", assetType: "cash", weight: 0.040195 },
        { ticker: "XASU6", assetType: "derivative", weight: -0.003524 }]);
    const future = { ticker: "XASU6", name: "S+P EMINI COM SER SEP26", weight: -0.003524, source: "ssga:fund-data" };
    expect(etfHoldingsIssue("XLC", [future])).toBeNull();
    for (const invalid of [{ ...future, source: "unknown" }, { ...future, ticker: "XASZ6" },
      { ...future, ticker: "META", name: "Meta Platforms" }, { ...future, weight: -101 }]) {
      expect(etfHoldingsIssue("XLC", [invalid])).toBe("holdings-weights-inconsistent");
    }
    expect(etfHoldingsIssue("XLC", [{ ticker: "-", name: "SSI US GOV MONEY MARKET CLASS", weight: 0.1, source: "unknown" }]))
      .toBe("holdings-security-identity-invalid");
  });

  it("preserves the reported workbook date and verifies the matching fund", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    expect(parseSsgaHoldingsFile("XLC", workbook(), "xlsx")).toMatchObject({ asOfDate: "2026-09-09",
      holdings: [{ ticker: "META", weight: 60 }, { ticker: "GOOGL", weight: 40 }] });
    expect(() => parseSsgaHoldingsFile("XLC", workbook({ ticker: "XLK" }), "xlsx")).toThrow("fund-identity-invalid");
    expect(() => parseSsgaHoldingsFile("XLC", workbook({ date: null }), "xlsx")).toThrow("effective-date-unavailable");
    expect(() => parseSsgaHoldingsFile("XLC", workbook({ date: "14-Sep-2026" }), "xlsx")).toThrow("effective-date-future");
    expect(() => parseSsgaHoldingsFile("XLC", workbook({ sheet: "Premium Discount" }), "xlsx")).toThrow("sheet-missing");
    expect(() => parseSsgaHoldingsFile("XLC", new TextEncoder().encode("<html>Blocked</html>").buffer, "xlsx")).toThrow("workbook-invalid");
  });

  it("discovers only matching official holdings files, excluding price history and other funds", () => {
    const html = page() + `<a href="/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xlk.xlsx">Wrong fund</a>
      <a href="https://example.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xlc.xlsx">Other issuer</a>
      <a href="https://www.ssga.com/library-content/products/fund-data/etfs/us/fund-data-us-en-xlc.csv">Performance</a>
      <a href="${HOLDINGS}?download=1">Duplicate</a>`;
    expect(extractSsgaHoldingsLinks(html, "XLC")).toEqual([HOLDINGS]);
  });

  it("fetches the exact linked workbook first with date/provenance and request deadlines", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(input) === PAGE) return new Response(page());
      expect(String(input)).toBe(HOLDINGS);
      return xlsxResponse();
    });
    await expect(fetchSsgaFundDataConstituents("XLC")).resolves.toMatchObject({ source: "ssga:fund-data", sourceUrl: HOLDINGS,
      coverage: "full", sourceTier: "official", asOfDate: "2026-09-09", providerRecordsCount: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect(timeout).toHaveBeenCalledWith(8_000);
  });

  it("caps one issuer attempt at five requests and stops the issuer after a rate denial", async () => {
    const links = ["holdings-daily", "fund-holdings"].flatMap(stem => ["csv", "xlsx"].map(ext =>
      `<a href="/library-content/products/fund-data/etfs/us/${stem}-us-en-xlc.${ext}">Holdings</a>`)).join("");
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input) === PAGE
      ? new Response(links) : new Response("Unavailable", { status: 503 }));
    await expect(fetchSsgaFundDataConstituents("XLC")).rejects.toThrow("SSGA holdings unavailable");
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(new Set(fetcher.mock.calls.map(([input]) => String(input))).size).toBe(5);
    fetcher.mockReset().mockResolvedValue(new Response("Blocked", { status: 403 }));
    await expect(fetchSsgaFundDataConstituents("XLC")).rejects.toThrow("cooldown-http-403");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not repeat SSGA after an undated response and retains the full cache when Yahoo is partial", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    sqlite = createSqliteD1();
    sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"
      + ["0006_etf_watchlists_and_constituents.sql", "0009_etf_watchlist_source_url.sql", "0051_etf_sync_metadata.sql"]
        .map(name => readFileSync(`migrations/${name}`, "utf8")).join("\n"));
    const env = { DB: sqlite.db } as Env;
    sqlite.script("INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,weight,as_of_date,source) VALUES('old','XLC','META',60,'2026-09-01','ssga:fund-data');"
      + "INSERT INTO etf_constituent_sync_status(etf_ticker,last_synced_at,last_full_synced_at,status,source,coverage,source_tier,records_count) VALUES('XLC','2026-09-02T12:00:00Z','2026-09-02T12:00:00Z','ok','ssga:fund-data','full','official',1);");
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input);
      if (url === PAGE) return new Response(page());
      if (url === HOLDINGS) return xlsxResponse(workbook({ date: null }));
      if (url === HOLDINGS.replace(/\.xlsx$/, ".csv")) return new Response("missing", { status: 404 });
      if (url.includes("query2.finance.yahoo.com")) return Response.json({ quoteSummary: { result: [{ topHoldings: {
        holdings: [{ symbol: "GOOGL", holdingName: "Example", holdingPercent: { raw: 0.4 } }],
      } }] } });
      throw new Error("Unexpected provider request");
    });
    await expect(syncEtfConstituents(env, "XLC")).resolves.toMatchObject({ skippedPartialOverwrite: true, asOfDate: "2026-09-01" });
    expect(fetcher.mock.calls.filter(([input]) => new URL(String(input)).hostname === "www.ssga.com")).toHaveLength(3);
    expect(await env.DB.prepare("SELECT as_of_date,constituent_ticker FROM etf_constituents WHERE etf_ticker='XLC'").first())
      .toEqual({ as_of_date: "2026-09-01", constituent_ticker: "META" });
    expect(await env.DB.prepare("SELECT status,last_full_synced_at FROM etf_constituent_sync_status WHERE etf_ticker='XLC'").first())
      .toEqual({ status: "partial", last_full_synced_at: "2026-09-02T12:00:00Z" });
  });

  it("persists all actual positions but seeds only the 24 equity securities", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    sqlite = createSqliteD1();
    sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"
      + ["0006_etf_watchlists_and_constituents.sql", "0009_etf_watchlist_source_url.sql", "0051_etf_sync_metadata.sql"]
        .map(name => readFileSync(`migrations/${name}`, "utf8")).join("\n"));
    // The watchlist migration seeds its ETF catalog. Inspect only constituent
    // identities below, so those unrelated seed rows cannot mask leakage.
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input) === PAGE
      ? new Response(page()) : xlsxResponse(actualWorkbook()));
    const env = { DB: sqlite.db } as Env;
    await expect(syncEtfConstituents(env, "XLC")).resolves.toMatchObject({ count: 27, coverage: "full", asOfDate: "2026-09-09" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count,MIN(as_of_date) AS date FROM etf_constituents WHERE etf_ticker='XLC'").first())
      .toEqual({ count: 27, date: "2026-09-09" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM symbols WHERE ticker IN ('-','USD','XASU6')").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM etf_constituents c JOIN symbols s ON s.ticker=c.constituent_ticker WHERE c.etf_ticker='XLC'").first("count")).toBe(24);
  });
});
