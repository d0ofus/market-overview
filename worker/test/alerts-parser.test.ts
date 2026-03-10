import { describe, expect, it } from "vitest";
import { extractTickerSymbol, parseTradingViewAlertEmail } from "../src/alerts-parser";

describe("alerts parser", () => {
  it("extracts ticker/metadata from labeled plain text", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "TradingView Alert - NASDAQ:AAPL Buy Signal",
      from: "noreply@tradingview.com",
      receivedAt: "2026-03-02T14:45:00Z",
      text: "Ticker: NASDAQ:AAPL\nStrategy: Opening Breakout\nSignal: Buy",
    });
    expect(parsed?.ticker).toBe("AAPL");
    expect(parsed?.strategyName).toBe("Opening Breakout");
    expect(parsed?.alertType?.toLowerCase()).toBe("buy");
  });

  it("parses structured JSON body", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "TV Alert",
      text: '{"symbol":"TSLA","strategy":"Momentum","action":"SELL"}',
    });
    expect(parsed?.ticker).toBe("TSLA");
    expect(parsed?.strategyName).toBe("Momentum");
    expect(parsed?.alertType).toBe("SELL");
  });

  it("extracts ticker candidates from mixed text", () => {
    const ticker = extractTickerSymbol("Alert fired for $NVDA crossing above VWAP");
    expect(ticker).toBe("NVDA");
  });

  it("prefers trading symbol over exchange token in TradingView crypto emails", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "Alert: BTCUSDT Greater Than 60,572.94",
      from: "TradingView <noreply@tradingview.com>",
      text: "Your BTCUSDT alert was triggered. Open chart https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT",
    });
    expect(parsed?.ticker).toBe("BTCUSDT");
  });

  it("extracts the ticker instead of the exchange prefix from TradingView chart links", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "Alert: IPI Greater Than 38.63",
      from: "TradingView <noreply@tradingview.com>",
      text: "Your IPI alert was triggered. IPI Greater Than 38.63. Open chart https://www.tradingview.com/chart/?symbol=BATS:IPI",
    });
    expect(parsed?.ticker).toBe("IPI");
    expect(parsed?.messageBody).toContain("IPI Greater Than 38.63");
  });

  it("parses exchange-qualified non-US chart links without dropping the ticker", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "Alert: CBA Greater Than 140.56",
      from: "TradingView <noreply@tradingview.com>",
      text: "Your CBA alert was triggered. CBA Greater Than 140.56. Open chart https://www.tradingview.com/chart/?symbol=ASX:CBA",
    });
    expect(parsed?.ticker).toBe("CBA");
    expect(parsed?.messageBody).toContain("ASX:CBA");
  });

  it("ignores exchange-only metadata when the body contains the real ticker", () => {
    const parsed = parseTradingViewAlertEmail({
      subject: "Alert: CBA Greater Than 140.56",
      from: "TradingView <noreply@tradingview.com>",
      text: 'symbol: ASX\nYour CBA alert was triggered. CBA Greater Than 140.56. Open chart https://www.tradingview.com/chart/?symbol=ASX:CBA',
    });
    expect(parsed?.ticker).toBe("CBA");
  });
});

