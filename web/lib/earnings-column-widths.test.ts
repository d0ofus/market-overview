import assert from "node:assert/strict";
import test from "node:test";
import {
  GAP_COLUMN_WIDTH_SPECS,
  defaultColumnWidths,
  normalizeColumnWidths,
  resizeAdjacentColumnWidths,
  type ColumnWidthSpec,
} from "./earnings-column-widths";

const SPECS = {
  first: { defaultWidthPct: 50, minWidthPct: 20 },
  second: { defaultWidthPct: 30, minWidthPct: 15 },
  third: { defaultWidthPct: 20, minWidthPct: 10 },
} satisfies Record<string, ColumnWidthSpec>;

function total(widths: Record<string, number>): number {
  return Object.values(widths).reduce((sum, width) => sum + width, 0);
}

test("gap column defaults total 100 percent", () => {
  const widths = defaultColumnWidths(GAP_COLUMN_WIDTH_SPECS);
  assert.ok(Math.abs(total(widths) - 100) < 1e-9);
  assert.deepEqual(widths, {
    reportDate: 5,
    ticker: 4,
    companyName: 8,
    season: 4,
    epsSurprisePct: 4,
    epsSurprise: 4,
    epsActual: 4,
    epsEstimate: 4,
    gapSource: 5,
    qualifyingGapPct: 4,
    postmarketGapPct: 4,
    postmarketPrice: 5,
    postmarketVolume: 5,
    regularOpenGapPct: 4,
    reactionOpen: 7,
    avgDollarVolume30d: 5,
    marketCap: 5,
    sector: 6,
    industry: 8,
    exchange: 5,
  });
});

test("invalid persisted width data falls back to normalized defaults", () => {
  const defaults = defaultColumnWidths(SPECS);
  assert.deepEqual(normalizeColumnWidths("invalid", SPECS), defaults);
  assert.deepEqual(normalizeColumnWidths({ first: Number.NaN, second: -5 }, SPECS), defaults);
});

test("missing columns receive defaults and the complete map is renormalized", () => {
  const widths = normalizeColumnWidths({ first: 60, second: 40 }, SPECS);
  assert.ok(widths.third >= SPECS.third.minWidthPct);
  assert.ok(Math.abs(total(widths) - 100) < 1e-9);
});

test("resizing transfers width to the adjacent visible column", () => {
  const widths = defaultColumnWidths(SPECS);
  const resized = resizeAdjacentColumnWidths(widths, ["third", "first", "second"], "third", 5, SPECS);
  assert.equal(resized.third, widths.third + 5);
  assert.equal(resized.first, widths.first - 5);
  assert.equal(resized.second, widths.second);
  assert.ok(Math.abs(total(resized) - 100) < 1e-9);
});

test("resized widths round-trip through persisted JSON", () => {
  const widths = defaultColumnWidths(SPECS);
  const resized = resizeAdjacentColumnWidths(widths, ["first", "second", "third"], "first", 7, SPECS);
  const restored = normalizeColumnWidths(JSON.parse(JSON.stringify(resized)), SPECS);
  for (const key of Object.keys(SPECS) as Array<keyof typeof SPECS>) {
    assert.ok(Math.abs(restored[key] - resized[key]) < 1e-9);
  }
  assert.ok(Math.abs(total(restored) - 100) < 1e-9);
});

test("resizing clamps both columns at their configured minimums", () => {
  const widths = defaultColumnWidths(SPECS);
  const shrinkLeft = resizeAdjacentColumnWidths(widths, ["first", "second", "third"], "first", -100, SPECS);
  assert.equal(shrinkLeft.first, SPECS.first.minWidthPct);
  assert.ok(Math.abs(total(shrinkLeft) - 100) < 1e-9);

  const shrinkRight = resizeAdjacentColumnWidths(widths, ["first", "second", "third"], "first", 100, SPECS);
  assert.equal(shrinkRight.second, SPECS.second.minWidthPct);
  assert.ok(Math.abs(total(shrinkRight) - 100) < 1e-9);
});

test("the last column has no outgoing resize divider", () => {
  const widths = defaultColumnWidths(SPECS);
  assert.deepEqual(
    resizeAdjacentColumnWidths(widths, ["first", "second", "third"], "third", 5, SPECS),
    widths,
  );
});
