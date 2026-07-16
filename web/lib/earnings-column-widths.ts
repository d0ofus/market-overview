export type ColumnWidthSpec = {
  defaultWidthPct: number;
  minWidthPct: number;
};

export const GAP_COLUMN_WIDTH_SPECS = {
  reportDate: { defaultWidthPct: 5, minWidthPct: 3 },
  ticker: { defaultWidthPct: 4, minWidthPct: 3 },
  companyName: { defaultWidthPct: 8, minWidthPct: 5 },
  season: { defaultWidthPct: 4, minWidthPct: 2.5 },
  epsSurprisePct: { defaultWidthPct: 4, minWidthPct: 2.5 },
  epsSurprise: { defaultWidthPct: 4, minWidthPct: 2.5 },
  epsActual: { defaultWidthPct: 4, minWidthPct: 2.5 },
  epsEstimate: { defaultWidthPct: 4, minWidthPct: 2.5 },
  gapSource: { defaultWidthPct: 5, minWidthPct: 3 },
  qualifyingGapPct: { defaultWidthPct: 4, minWidthPct: 2.5 },
  postmarketGapPct: { defaultWidthPct: 4, minWidthPct: 2.5 },
  postmarketPrice: { defaultWidthPct: 5, minWidthPct: 3 },
  postmarketVolume: { defaultWidthPct: 5, minWidthPct: 3 },
  regularOpenGapPct: { defaultWidthPct: 4, minWidthPct: 2.5 },
  reactionOpen: { defaultWidthPct: 7, minWidthPct: 4 },
  avgDollarVolume30d: { defaultWidthPct: 5, minWidthPct: 3 },
  marketCap: { defaultWidthPct: 5, minWidthPct: 3 },
  sector: { defaultWidthPct: 6, minWidthPct: 4 },
  industry: { defaultWidthPct: 8, minWidthPct: 5 },
  exchange: { defaultWidthPct: 5, minWidthPct: 3 },
} as const satisfies Record<string, ColumnWidthSpec>;

export type GapColumnWidthKey = keyof typeof GAP_COLUMN_WIDTH_SPECS;
export type ColumnWidthMap<Key extends string> = Record<Key, number>;

const TOTAL_WIDTH_PCT = 100;

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function defaultColumnWidths<Key extends string>(
  specs: Record<Key, ColumnWidthSpec>,
): ColumnWidthMap<Key> {
  return normalizeColumnWidths(null, specs);
}

export function normalizeColumnWidths<Key extends string>(
  stored: unknown,
  specs: Record<Key, ColumnWidthSpec>,
): ColumnWidthMap<Key> {
  const keys = Object.keys(specs) as Key[];
  const minTotal = keys.reduce((sum, key) => sum + specs[key].minWidthPct, 0);
  if (minTotal >= TOTAL_WIDTH_PCT) {
    throw new Error("Column minimum widths must total less than 100%.");
  }

  const clamped = {} as ColumnWidthMap<Key>;
  for (const key of keys) {
    const raw = recordValue(stored, key);
    const candidate = typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : specs[key].defaultWidthPct;
    clamped[key] = Math.max(specs[key].minWidthPct, candidate);
  }

  const targetFlexibleWidth = TOTAL_WIDTH_PCT - minTotal;
  const currentFlexibleWidth = keys.reduce(
    (sum, key) => sum + Math.max(0, clamped[key] - specs[key].minWidthPct),
    0,
  );
  const defaultFlexibleWidth = keys.reduce(
    (sum, key) => sum + Math.max(0, specs[key].defaultWidthPct - specs[key].minWidthPct),
    0,
  );

  const normalized = {} as ColumnWidthMap<Key>;
  for (const key of keys) {
    const flexibleWidth = currentFlexibleWidth > 0
      ? Math.max(0, clamped[key] - specs[key].minWidthPct)
      : Math.max(0, specs[key].defaultWidthPct - specs[key].minWidthPct);
    const flexibleTotal = currentFlexibleWidth > 0 ? currentFlexibleWidth : defaultFlexibleWidth;
    normalized[key] = specs[key].minWidthPct + (
      flexibleTotal > 0 ? flexibleWidth * targetFlexibleWidth / flexibleTotal : 0
    );
  }
  return normalized;
}

export function resizeAdjacentColumnWidths<Key extends string>(
  widths: ColumnWidthMap<Key>,
  orderedKeys: Key[],
  leftKey: Key,
  deltaPct: number,
  specs: Record<Key, ColumnWidthSpec>,
): ColumnWidthMap<Key> {
  const normalized = normalizeColumnWidths(widths, specs);
  const leftIndex = orderedKeys.indexOf(leftKey);
  const rightKey = orderedKeys[leftIndex + 1];
  if (leftIndex < 0 || !rightKey || !Number.isFinite(deltaPct)) return normalized;

  const minDelta = specs[leftKey].minWidthPct - normalized[leftKey];
  const maxDelta = normalized[rightKey] - specs[rightKey].minWidthPct;
  const clampedDelta = Math.min(maxDelta, Math.max(minDelta, deltaPct));
  return {
    ...normalized,
    [leftKey]: normalized[leftKey] + clampedDelta,
    [rightKey]: normalized[rightKey] - clampedDelta,
  };
}
