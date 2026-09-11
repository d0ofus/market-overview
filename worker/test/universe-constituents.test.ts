import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractIsharesHoldingsCsvUrl,
  parseIsharesHoldingsCsv,
  parseIsharesHoldingsCsvDetailed,
  parseNasdaqTradedActiveEquities,
  parseNasdaqTradedCommonStocks,
  parseNasdaqTraderFileCreationDate,
  parseSp500Csv,
  loadSp500Universe,
  loadRussell2000Universe,
} from "../src/universe-constituents";

afterEach(() => vi.unstubAllGlobals());

describe("universe constituent parsers", () => {
  it("applies NasdaqTrader common-stock filters", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|AAPL|Apple Inc. Common Stock|Q|Q|N|100|N|N|AAPL|AAPL|N",
      "Y|SPY|SPDR S&P 500 ETF Trust|P||Y|100|N||SPY|SPY|N",
      "Y|ABCD.W|ABCD Warrant|Q|Q|N|100|N||ABCD.W|ABCD.W|N",
      "Y|XYZ|XYZ Preferred Shares|N||N|100|N||XYZ|XYZ|N",
      "File Creation Time: 0304202618:00",
    ].join("\n");

    const rows = parseNasdaqTradedCommonStocks(sample);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      symbol: "AAPL",
      securityName: "Apple Inc. Common Stock",
      listingExchange: "Q",
    });
    expect(parseNasdaqTraderFileCreationDate(sample)).toBe("2026-03-04");
  });

  it("retains the five actual common-share par-value rows while honoring ETF/test and non-common security flags", () => {
    const common = [
      ["AVD","American Vanguard Corporation Common Stock ($0.10 Par Value)"],
      ["CMRE","Costamare Inc. Common Stock $0.0001 par value"],
      ["FVRR","Fiverr International Ltd. Ordinary Shares, no par value"],
      ["GDOT","Green Dot Corporation Class A Common Stock, $0.001 par value"],
      ["SB","Safe Bulkers, Inc Common Stock ($0.001 par value)"],
    ];
    const sample = [...common.map(([ticker,name])=>`Y|${ticker}|${name}|N||N|100|N||${ticker}|${ticker}|N`),
      "Y|PREF|Example Preferred Shares $0.01 par value|N||N|100|N||PREF|PREF|N",
      "Y|WAR|Example Warrants to buy Common Stock par value|N||N|100|N||WAR|WAR|N",
      "Y|ETF|Example Common Stock ETF|N||Y|100|N||ETF|ETF|N",
      "Y|TEST|Example Common Stock no par value|N||N|100|Y||TEST|TEST|N"].join("\n");
    expect(parseNasdaqTradedCommonStocks(sample).map(row=>row.symbol)).toEqual(common.map(([ticker])=>ticker));
  });

  it("fails closed when NasdaqTrader File Creation Time is absent or malformed", () => {
    expect(parseNasdaqTraderFileCreationDate("Nasdaq Traded|Symbol\nY|AAPL")).toBeNull();
    expect(parseNasdaqTraderFileCreationDate("File Creation Time: tomorrow")).toBeNull();
  });

  it("keeps active listed equities for provider resolution without the common-stock name blacklist", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|CLDT|Chatham Lodging Trust Common Shares of Beneficial Interest|N||N|100|N||CLDT|CLDT|N",
      "Y|SPY|SPDR S&P 500 ETF Trust|P||Y|100|N||SPY|SPY|N",
      "File Creation Time: 0304202618:00",
    ].join("\n");

    expect(parseNasdaqTradedCommonStocks(sample).map((row) => row.symbol)).toEqual(["CLDT"]);
    expect(parseNasdaqTradedActiveEquities(sample).map((row) => row.symbol)).toEqual(["CLDT"]);
  });

  it("parses S&P 500 csv symbols", () => {
    const csv = [
      "Symbol,Security,GICS Sector",
      "AAPL,Apple Inc.,Information Technology",
      "BRK.B,Berkshire Hathaway,Financials",
      "\"BF.B\",\"Brown-Forman\",Consumer Staples",
    ].join("\n");

    const symbols = parseSp500Csv(csv);
    expect(symbols).toEqual(["AAPL", "BF.B", "BRK.B"]);
  });

  it("retains class shares and beneficial-interest common shares without retaining warrants", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|BRK.B|Berkshire Hathaway Class B Common Stock|N||N|100|N||BRK.B|BRK.B|N",
      "Y|CLDT|Chatham Lodging Trust Common Shares of Beneficial Interest|N||N|100|N||CLDT|CLDT|N",
      "Y|ABCD.W|ABCD Warrant|Q||N|100|N||ABCD.W|ABCD.W|N",
      "File Creation Time: 0908202618:00",
    ].join("\n");
    expect(parseNasdaqTradedCommonStocks(sample).map((row) => row.symbol)).toEqual(["BRK.B", "CLDT"]);
  });

  it("does not remove S&P constituents missing from a secondary directory", async () => {
    const tickers = ["BRK.B", "BF.B", ...Array.from({ length: 498 }, (_, index) => `T${index}`)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`Symbol,Security\n${tickers.map((ticker) => `${ticker},Company`).join("\n")}`)));
    const result = await loadSp500Universe(new Set(tickers.slice(2)));
    expect(result.tickers).toHaveLength(500);
    expect(result.tickers).toContain("BRK.B");
    expect(result.tickers).toContain("BF.B");
  });

  it("discovers an alternate IWM export after an HTTP200 malformed primary payload", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>Temporarily unavailable</html>"))
      .mockResolvedValueOnce(new Response('<a href="/us/products/239710/alternate-holdings.csv">Holdings</a>'))
      .mockResolvedValueOnce(new Response("iShares Russell 2000 ETF\nFund Holdings as of,Sep 04, 2026\nTicker,Name,Asset Class\nAAA,Company,Equity"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadRussell2000Universe();
    expect(result.tickers).toEqual(["AAA"]);
    expect(result.sourceUrl).toContain("alternate-holdings.csv");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps valid IWM holdings absent from the secondary directory in the coverage population", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "iShares Russell 2000 ETF\nFund Holdings as of,Sep 04, 2026\nTicker,Name,Asset Class\nAAA,Company,Equity\nBRK-B,Berkshire,Equity",
    )));
    const result = await loadRussell2000Universe(new Set(["BRK.B"]));
    expect(result.tickers).toEqual(["AAA", "BRK.B"]);
    expect(result.unresolvedTickers).toContain("AAA");
    expect(result.memberMetadata.AAA?.sourceTicker).toBe("AAA");
  });

  it("parses the iShares IWM holdings export used as the Russell proxy", () => {
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 20, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value",
      "AA,ALCOA CORP,Materials,Equity,100",
      "BRK.B,BERKSHIRE HATHAWAY,Financials,Equity,200",
      "USD,USD CASH,Cash and/or Derivatives,Cash,50",
      "FUT1,RUSSELL FUTURE,Cash and/or Derivatives,Futures,25",
    ].join("\n");
    expect(parseIsharesHoldingsCsv(csv)).toEqual(["AA", "BRK.B"]);
  });

  it("preserves IWM provenance and retains unpriced listed equities", () => {
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 20, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Quantity,Price,Exchange",
      "AA,ALCOA CORP,Materials,Equity,100,0.10,10,10.00,NYSE",
      "AA,ALCOA CORP DUPLICATE,Materials,Equity,100,0.10,10,10.00,NYSE",
      "INH,INHIBRX INC CVR,Health Care,Equity,5,0.00,5,1.00,NO MARKET (E.G. UNLISTED)",
      "PDLI,PDL BIOPHARMA INC,Health Care,Equity,0.12,0.00,11853,0.00,NASDAQ",
      "BAD/ID,BAD IDENTIFIER,Health Care,Equity,10,0.00,10,1.00,NASDAQ",
      ",MISSING IDENTIFIER,Health Care,Equity,10,0.00,10,1.00,NASDAQ",
      "USD,USD CASH,Cash and/or Derivatives,Cash,50,0.05,50,1.00,-",
    ].join("\n");

    expect(parseIsharesHoldingsCsvDetailed(csv)).toMatchObject({
      sourceAsOfDate: "2026-07-20",
      sourceEquityCount: 6,
      duplicateTickerCount: 1,
      blankTickerCount: 1,
      tickers: ["AA", "PDLI"],
      excludedCount: 4,
      holdings: [{ sourceTicker: "AA", issuerName: "ALCOA CORP", exchange: "NYSE", assetClass: "Equity" },
        { sourceTicker: "PDLI", issuerName: "PDL BIOPHARMA INC", exchange: "NASDAQ", assetClass: "Equity" }],
      invalidSourceIdentifiers: ["(blank row 9)", "BAD/ID"],
      duplicateSourceIdentifiers: ["AA"],
      excludedSourceIdentifiers: ["non-market:INH"],
    });
  });

  it("maps the four live issuer class-share aliases while preserving source identifiers and unpriced equities", async () => {
    const csv=["iShares Russell 2000 ETF",'Fund Holdings as of,"Sep 09, 2026"',
      "Ticker,Name,Asset Class,Price,Exchange",
      "BH A,BIGLARI HOLDINGS INC CLASS A,Equity,1808.74,NYSE",
      "CRD A,CRAWFORD CLASS A,Equity,12.79,NYSE",
      "GEF B,GREIF INC CLASS B,Equity,107.04,NYSE",
      "MOG A,MOOG INC CLASS A,Equity,367.51,NYSE",
      "CVI,CVR ENERGY INC,Equity,0.00,NYSE",
      "PDLI,PDL BIOPHARMA INC,Equity,-,NASDAQ",
      "CVRIGHT,EXAMPLE INC CVR,Equity,1.00,NYSE",
      "USD,USD CASH,Cash,1.00,-"].join("\n");
    expect(parseIsharesHoldingsCsvDetailed(csv)).toMatchObject({sourceAsOfDate:"2026-09-09",sourceEquityCount:7,
      tickers:["BH.A","CRD.A","CVI","GEF.B","MOG.A","PDLI"],invalidSourceIdentifiers:[],excludedSourceIdentifiers:["residual:CVRIGHT"]});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(csv)));
    const result=await loadRussell2000Universe(new Set(["BH.A","CRD.A","CVI","GEF.B","MOG.A"]));
    expect(result.memberMetadata["MOG.A"]).toMatchObject({sourceTicker:"MOG A",canonicalTicker:"MOG.A",issuerName:"MOOG INC CLASS A"});
    expect(result.tickers).toContain("PDLI");expect(result.unresolvedTickers).toContain("PDLI");
    expect(result.normalizedMemberCount).toBe(6);
    expect(parseIsharesHoldingsCsvDetailed(csv.replace("MOOG INC CLASS A","UNEXPLAINED SECURITY")).invalidSourceIdentifiers).toEqual(["MOG A"]);
  });

  it("accepts a production-shaped IWM membership and discovers only same-origin CSV links", () => {
    const rows = Array.from({ length: 1_964 }, (_, index) =>
      `R${String(index).padStart(4, "0")},Russell Member ${index},Industrials,Equity,100,0.05,10,10.00,NASDAQ`
    );
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 29, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Quantity,Price,Exchange",
      ...rows,
    ].join("\n");
    const parsed = parseIsharesHoldingsCsvDetailed(csv);
    expect(parsed.sourceAsOfDate).toBe("2026-07-29");
    expect(parsed.sourceEquityCount).toBe(1_964);
    expect(parsed.tickers).toHaveLength(1_964);

    expect(extractIsharesHoldingsCsvUrl('<a class="holdings-csv-link" href="/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv">Download</a>'))
      .toBe("https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv");
    expect(extractIsharesHoldingsCsvUrl('<a href="https://evil.example/holdings.csv">Download</a>')).toBeNull();
  });

  it("excludes issuer-marked unlisted placeholder rows before ticker validation while retaining raw diagnostics", async () => {
    // Exact relevant row values from the official Sep04 holdings CSV, fetched
    // Sep09: https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv
    const csv = [
      "iShares Russell 2000 ETF",
      'Fund Holdings as of,"Sep 04, 2026"',
      "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date",
      'UMBF,UMB FINANCIAL,Financials,Equity,"274,657,792.80",0.34,"274,657,792.80","1,910,530.00",143.76,United States,NASDAQ,USD,1.00,USD,-',
      'ADRO,CHINOOK THERAPEUTICS INC,Health Care,Equity,"223,817.75",0.00,"223,817.75","1,316,575.00",0.17,United States,NO MARKET (E.G. UNLISTED),USD,1.00,USD,-',
      'ADRO,CHINOOK THERAPEUTICS INC CVR,Health Care,Equity,"138,892.89",0.00,"138,892.89","272,339.00",0.51,United States,NO MARKET (E.G. UNLISTED),USD,1.00,USD,-',
      '-,ARCELLX INC CVR,Health Care,Equity,"65,585.87",0.00,"65,585.87","936,941.00",0.07,United States,NO MARKET (E.G. UNLISTED),USD,1.00,USD,-',
      '-,OMNIAB INC $12.50 VESTING Prvt,Health Care,Equity,1.31,0.00,1.31,"130,676.00",0.00,United States,NO MARKET (E.G. UNLISTED),USD,1.00,USD,-',
      '-,OMNIAB INC $15.00 VESTING Prvt,Health Care,Equity,1.31,0.00,1.31,"130,676.00",0.00,United States,NO MARKET (E.G. UNLISTED),USD,1.00,USD,-',
    ].join("\n");
    expect(parseIsharesHoldingsCsvDetailed(csv)).toMatchObject({
      sourceEquityCount: 6, duplicateTickerCount: 3, blankTickerCount: 0,
      tickers: ["UMBF"], excludedCount: 5, invalidSourceIdentifiers: [],
      duplicateSourceIdentifiers: ["-", "ADRO"], excludedSourceIdentifiers: ["non-market:-", "non-market:ADRO"],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csv)));
    expect(await loadRussell2000Universe()).toMatchObject({
      tickers: ["UMBF"], sourceMemberCount: 6, normalizedMemberCount: 1, unresolvedCount: 5,
      unresolvedTickers: ["duplicate:-", "duplicate:ADRO", "non-market:-", "non-market:ADRO"],
    });
  });

  it.each(["1.00", "0.00"])("still rejects a listed placeholder identifier with price %s", async (price) => {
    const csv = [
      "iShares Russell 2000 ETF", 'Fund Holdings as of,"Sep 04, 2026"',
      "Ticker,Name,Asset Class,Price,Exchange", "UMBF,UMB FINANCIAL,Equity,143.76,NASDAQ",
      `-,UNRESOLVED LISTED EQUITY,Equity,${price},NASDAQ`,
    ].join("\n");
    expect(parseIsharesHoldingsCsvDetailed(csv)).toMatchObject({
      sourceEquityCount: 2, tickers: ["UMBF"], invalidSourceIdentifiers: ["-"], excludedSourceIdentifiers: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csv)));
    await expect(loadRussell2000Universe()).rejects.toThrow("invalid identifiers: 1");
  });
});
