import { describe, expect, it } from "vitest";
import { extractLsegConstituentFileUrl, parseNasdaqTradedCommonStocks, parseSp500Csv } from "../src/universe-constituents";

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

  it("extracts Russell constituent file url from LSEG metadata json", () => {
    const payload = JSON.stringify({
      data: [
        { Index_Name: "FTSE 100", Constituent_file_url: "https://example.com/ftse100.csv" },
        {
          Index_Name: "Russell 2000 Index",
          Constituent_file_url:
            "https://www.lseg.com/content/dam/ftse-russell/en_us/documents/constituents/ftse-us-russell-2000-index.csv",
        },
      ],
    });

    const url = extractLsegConstituentFileUrl(payload, /russell\s+2000/i);
    expect(url).toBe("https://www.lseg.com/content/dam/ftse-russell/en_us/documents/constituents/ftse-us-russell-2000-index.csv");
  });
});
