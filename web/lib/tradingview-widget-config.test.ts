import assert from "node:assert/strict";
import test from "node:test";
import { buildTradingViewEarningsEventConfig } from "./tradingview-widget-config";

test("TradingView earnings events remain off unless requested", () => {
  assert.deepEqual(buildTradingViewEarningsEventConfig("off", "3M"), {
    range: "3M",
    overrides: {},
  });
});

test("TradingView earnings markers and break lines are configured independently", () => {
  assert.deepEqual(buildTradingViewEarningsEventConfig("markers", "6M"), {
    range: "6M",
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": false,
    },
  });
  assert.deepEqual(buildTradingViewEarningsEventConfig("markers-and-breaks", "6M"), {
    range: "6M",
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": true,
    },
  });
});
