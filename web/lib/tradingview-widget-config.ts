export type TradingViewEarningsEvents = "off" | "markers" | "markers-and-breaks";

type TradingViewOverrideValue = boolean | number | string;

export function buildTradingViewSizingConfig(): { autosize: true } {
  return { autosize: true };
}

export function buildTradingViewTimingConfig(): { interval: "D" } {
  return { interval: "D" };
}

export function buildTradingViewEarningsEventConfig(
  earningsEvents: TradingViewEarningsEvents,
): {
  overrides: Record<string, TradingViewOverrideValue>;
} {
  if (earningsEvents === "off") {
    return { overrides: {} };
  }
  return {
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": earningsEvents === "markers-and-breaks",
    },
  };
}
