import assert from "node:assert/strict";
import test from "node:test";
import { alignMarketSessionRows, marketSeriesSegments } from "./market-series";

test("missing dates break lines without compressing the time axis or inventing zeros", () => {
  const segments = marketSeriesSegments([100, 101, null, 103, null, 105], 100, 20);
  assert.deepEqual(segments.map((segment) => segment.map((point) => point.index)), [[0, 1], [3], [5]]);
  assert.equal(segments[1][0].x, 60);
  assert.equal(segments[2][0].x, 100);
  assert.deepEqual(marketSeriesSegments([null, null], 100, 20), []);
});

test("actual cached sessions preserve missing publications and exclude exceptional closures and future dates", () => {
  const rows = [
    { asOfDate: "2025-01-08", value: 10 }, { asOfDate: "2025-01-09", value: 999 },
    { asOfDate: "2025-01-13", value: null }, { asOfDate: "2025-01-14", value: 15 },
    { asOfDate: "2025-01-15", value: 999 },
  ];
  const grid = alignMarketSessionRows(rows, ["2025-01-08", "2025-01-10", "2025-01-13", "2025-01-14"], 90);
  assert.deepEqual(grid.map((point) => point.asOfDate), ["2025-01-08", "2025-01-10", "2025-01-13", "2025-01-14"]);
  assert.deepEqual(grid.map((point) => point.row?.value ?? null), [10, null, null, 15]);
  assert.equal(grid[1].row, null);
  assert.equal(grid[2].row?.value, null);
  assert.deepEqual(alignMarketSessionRows(rows, [], 90), []);
});
