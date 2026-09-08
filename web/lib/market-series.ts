export type MarketSeriesPoint = { index: number; value: number; x: number; y: number };

/** The API's cached exchange calendar owns the axis. Missing publications keep
 * their session slot; a weekend, exceptional closure or future row cannot add
 * a synthetic session. Without a verified grid, only dated observations exist. */
export function alignMarketSessionRows<T extends { asOfDate: string }>(
  rows: readonly T[],
  exchangeSessionDates: readonly string[] | null | undefined,
  limit: number,
): Array<{ asOfDate: string; row: T | null }> {
  const byDate = new Map(rows.map((row) => [row.asOfDate, row]));
  const dates = [...new Set(exchangeSessionDates ?? rows.map((row) => row.asOfDate))]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().slice(-Math.max(1, Math.trunc(limit)));
  return dates.map((asOfDate) => ({ asOfDate, row: byDate.get(asOfDate) ?? null }));
}

/** Original index positions are retained, and missing observations break the line. */
export function marketSeriesSegments(values: Array<number | null>, width: number, height: number): MarketSeriesPoint[][] {
  const observed = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!observed.length) return [];
  const low = Math.min(...observed);
  const range = Math.max(...observed) - low || 1;
  const segments: MarketSeriesPoint[][] = [];
  let segment: MarketSeriesPoint[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ index, value, x: index / Math.max(1, values.length - 1) * width, y: height - (value - low) / range * height });
  });
  if (segment.length) segments.push(segment);
  return segments;
}
