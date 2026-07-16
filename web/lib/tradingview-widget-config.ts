export type TradingViewInitialRange = "1M" | "3M" | "6M" | "12M";
export type TradingViewEarningsEvents = "off" | "markers" | "markers-and-breaks";

type TradingViewOverrideValue = boolean | number | string;

export function buildTradingViewEarningsEventConfig(
  earningsEvents: TradingViewEarningsEvents,
  range: TradingViewInitialRange,
): {
  range: TradingViewInitialRange;
  overrides: Record<string, TradingViewOverrideValue>;
} {
  if (earningsEvents === "off") {
    return { range, overrides: {} };
  }
  return {
    range,
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": earningsEvents === "markers-and-breaks",
    },
  };
}
