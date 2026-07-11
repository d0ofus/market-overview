import assert from "node:assert/strict";
import test from "node:test";
import { extractRowOptions } from "./generate-tradingview-stock-fields.mjs";

test("extractRowOptions preserves fixed TradingView value lists", () => {
  const valuesCell = `
    <ul>
      <li><code>dr</code> <small>Depositary receipt</small></li>
      <li><code>fund</code> <small>Fund</small></li>
      <li><code>stock</code> <small>Common stock</small></li>
      <li><code>structured</code></li>
    </ul>
  `;

  assert.deepEqual(extractRowOptions(valuesCell), [
    { value: "dr", label: "Depositary receipt" },
    { value: "fund", label: "Fund" },
    { value: "stock", label: "Common stock" },
    { value: "structured" },
  ]);
});
