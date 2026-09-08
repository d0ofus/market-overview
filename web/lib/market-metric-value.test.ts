import assert from "node:assert/strict";
import test from "node:test";
import { marketMetricValue } from "./market-metric-value";

test("null, blank, missing and invalid JSON metrics never become zero", () => {
  for (const value of [null, undefined, "", " ", "N/A", false, Number.NaN, Infinity]) {
    assert.ok(Number.isNaN(marketMetricValue(value, null)));
  }
  assert.equal(marketMetricValue(0), 0);
  assert.equal(marketMetricValue("0"), 0);
  assert.equal(marketMetricValue(null, -2.5), -2.5);
});
