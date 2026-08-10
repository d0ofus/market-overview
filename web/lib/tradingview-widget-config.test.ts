import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTradingViewEarningsEventConfig,
  buildTradingViewSizingConfig,
  buildTradingViewTimingConfig,
} from "./tradingview-widget-config";

test("TradingView sizing follows its container without fixed dimensions", () => {
  const config = buildTradingViewSizingConfig();
  assert.deepEqual(config, { autosize: true });
  assert.equal("width" in config, false);
  assert.equal("height" in config, false);
});

test("TradingView timing is daily and does not serialize an adaptive range", () => {
  const config = buildTradingViewTimingConfig();
  assert.deepEqual(config, { interval: "D" });
  assert.equal("range" in config, false);
});

test("TradingView earnings events remain off unless requested", () => {
  assert.deepEqual(buildTradingViewEarningsEventConfig("off"), {
    overrides: {},
  });
});

test("TradingView earnings markers and break lines are configured independently", () => {
  assert.deepEqual(buildTradingViewEarningsEventConfig("markers"), {
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": false,
    },
  });
  assert.deepEqual(buildTradingViewEarningsEventConfig("markers-and-breaks"), {
    overrides: {
      "mainSeriesProperties.esdShowEarnings": true,
      "mainSeriesProperties.esdShowBreaks": true,
    },
  });
});
