import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractInvescoDownloadLinksFromHtml,
  parseAdvisorSharesDelimitedRows,
  parseCoinSharesHoldingsHtml,
  parseFlexibleDelimitedRows,
  parseGlobalXDelimitedRows,
  parseHtmlHoldingsRows,
  syncEtfConstituents,
} from "../src/etf";
import type { Env } from "../src/types";

describe("ETF constituent parsers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Global X full holdings csv rows", () => {
    const csv = [
      "Fund Holdings as of 2026-03-09",
      'Ticker,Name,Sector,Weightings,Shares,Market Value',
      'CCJ US,Cameco Corp,Energy,24.77%,100,1000',
      'NXE CN,NexGen Energy Ltd,Energy,7.35%,100,1000',
      'URNM US,Sprott Uranium Miners ETF,Energy,5.10%,100,1000',
    ].join("\n");

    expect(parseGlobalXDelimitedRows(csv)).toEqual([
      { ticker: "CCJ", name: "Cameco Corp", weight: 24.77 },
      { ticker: "NXE", name: "NexGen Energy Ltd", weight: 7.35 },
      { ticker: "URNM", name: "Sprott Uranium Miners ETF", weight: 5.1 },
    ]);
  });

  it("normalizes slash and numeric-style Global X symbols", () => {
    const csv = [
      "Holdings",
      'Symbol,Security Name,Weightings',
      'BRK/B US,Berkshire Hathaway Inc Class B,3.20%',
      '388 HK,Hong Kong Exchanges & Clearing Ltd,2.10%',
    ].join("\n");

    expect(parseGlobalXDelimitedRows(csv)).toEqual([
      { ticker: "BRK.B", name: "Berkshire Hathaway Inc Class B", weight: 3.2 },
      { ticker: "388", name: "Hong Kong Exchanges & Clearing Ltd", weight: 2.1 },
    ]);
  });

  it("extracts Invesco export-data style download links", () => {
    const html = [
      '<html><body>',
      '<a href="/us/en/financial-products/etfs/holdings/main/holdings/0?audienceType=Investor&ticker=KBWB">Export Data</a>',
      '<a href="/us/en/financial-products/etfs/invesco-kb-w-bank-etf.html">KBWB</a>',
      "</body></html>",
    ].join("");

    expect(extractInvescoDownloadLinksFromHtml(html)).toContain(
      "/us/en/financial-products/etfs/holdings/main/holdings/0?audienceType=Investor&ticker=KBWB",
    );
  });

  it("rejects generic HTML rows that are not constituent holdings", () => {
    const html = [
      "<table>",
      "<tr><td>1 Year</td><td>18.42%</td></tr>",
      "<tr><td>Information Technology</td><td>42.10%</td></tr>",
      '<tr><td><a href="/quote/MSFT">Microsoft</a></td><td>MSFT</td><td>6.25%</td></tr>',
      '<tr><td><a href="/quote/1234">Numeric impostor</a></td><td>1234</td><td>3.00%</td></tr>',
      "</table>",
    ].join("");

    expect(parseHtmlHoldingsRows(html, "TEST")).toEqual([
      { ticker: "MSFT", name: "Microsoft", weight: 6.25 },
    ]);
  });

  it("filters AdvisorShares multi-fund CSV rows by account symbol", () => {
    const csv = [
      "Account Symbol,Stock Ticker,Security Description,Portfolio Weight %",
      "MSOS,GTBIF,Green Thumb Industries Inc,17.50%",
      "YOLO,TLRY,Tilray Brands Inc,4.20%",
      "MSOS,CURLF,Curaleaf Holdings Inc,12.30%",
    ].join("\n");

    expect(parseAdvisorSharesDelimitedRows(csv, "MSOS")).toEqual([
      { ticker: "GTBIF", name: "Green Thumb Industries Inc", weight: 17.5 },
      { ticker: "CURLF", name: "Curaleaf Holdings Inc", weight: 12.3 },
    ]);
  });

  it("parses ARK-style flexible CSV rows", () => {
    const csv = [
      "date,fund,company,ticker,cusip,shares,market value($),weight(%)",
      "2026-05-18,ARKK,Tesla Inc,TSLA,88160R101,100,1000,9.50",
      "2026-05-18,ARKK,Roku Inc,ROKU,77543R102,100,1000,5.25",
    ].join("\n");

    expect(parseFlexibleDelimitedRows(csv)).toEqual([
      { ticker: "TSLA", name: "Tesla Inc", weight: 9.5 },
      { ticker: "ROKU", name: "Roku Inc", weight: 5.25 },
    ]);
  });

  it("parses CoinShares fund-holdings HTML without reading performance sections", () => {
    const html = [
      "<section><h2>Fund Holdings</h2>",
      "<div>Bitfarms Ltd BITF 100,000 250,000</div>",
      "<div>CleanSpark Inc CLSK 50,000 125,000</div>",
      "<h2>Performance</h2>",
      "<div>1 Year RETURN 20 30</div>",
      "</section>",
    ].join("");

    expect(parseCoinSharesHoldingsHtml(html)).toEqual([
      { ticker: "BITF", name: "Bitfarms Ltd", weight: null },
      { ticker: "CLSK", name: "CleanSpark Inc", weight: null },
    ]);
  });

  it("does not overwrite a full official cache with a partial fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      quoteSummary: {
        result: [{
          topHoldings: {
            holdings: [
              { symbol: "AAPL", holdingName: "Apple Inc", holdingPercent: { raw: 0.25 } },
            ],
          },
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const batch = vi.fn(async () => []);
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const makeStatement = (args: unknown[] = []) => ({
            bind(...nextArgs: unknown[]) {
              return makeStatement(nextArgs);
            },
            async first<T>() {
              if (sql.includes("COUNT(*) as count FROM etf_constituents")) {
                return { count: 30 } as T;
              }
              if (sql.includes("source_url as sourceUrl") && sql.includes("etf_watchlists")) {
                return { sourceUrl: null, fundName: null } as T;
              }
              if (sql.includes("COALESCE((SELECT fund_name")) {
                return { fundName: null } as T;
              }
              if (sql.includes("FROM etf_constituent_sync_status")) {
                return {
                  recordsCount: 30,
                  source: "official:test-provider",
                  sourceUrl: "https://example.com/full.csv",
                  sourceTier: "official",
                  coverage: "full",
                  lastSyncedAt: "2026-05-18T00:00:00.000Z",
                  lastFullSyncedAt: "2026-05-18T00:00:00.000Z",
                  lastPartialSyncedAt: null,
                } as T;
              }
              return null as T;
            },
            async run() {
              runs.push({ sql, args });
              return {};
            },
          });
          return makeStatement();
        },
        batch,
      },
    } as unknown as Env;

    const result = await syncEtfConstituents(env, "TESTF");

    expect(result).toMatchObject({
      count: 30,
      source: "official:test-provider",
      sourceTier: "official",
      coverage: "full",
      skippedPartialOverwrite: true,
    });
    expect(batch).not.toHaveBeenCalled();
    expect(runs[0]?.args).toContain("official:test-provider");
    expect(runs[0]?.args).toContain(1);
  });
});
