/** Missing provider/JSON values remain missing; empty strings and null are not zero. */
export function marketMetricValue(value: unknown, fallback: unknown = Number.NaN): number {
  const read = (input: unknown): number => {
    if (typeof input === "number") return Number.isFinite(input) ? input : Number.NaN;
    if (typeof input === "string" && input.trim()) {
      const parsed = Number(input);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    }
    return Number.NaN;
  };
  const primary = read(value);
  return Number.isFinite(primary) ? primary : read(fallback);
}
