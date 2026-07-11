import assert from "node:assert/strict";
import test from "node:test";
import {
  searchTradingViewStockFieldOptions,
  searchTradingViewStockFields,
} from "./tradingview-stock-field-search";

test("field search exposes fixed option metadata", () => {
  const result = searchTradingViewStockFields("symbol type", 10);
  const symbolType = result.rows.find((row) => row.value === "type");

  assert.ok(symbolType);
  assert.equal(symbolType.hasOptions, true);
  assert.ok(symbolType.optionCount >= 4);
});

test("option search returns indexed values for a selected TradingView field", () => {
  const result = searchTradingViewStockFieldOptions("type", "st", 50);

  assert.equal(result.field?.value, "type");
  assert.ok(result.rows.some((row) => row.value === "stock"));
  assert.ok(result.total >= result.rows.length);
});
