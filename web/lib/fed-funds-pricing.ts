/** A zero directional move estimate does not mean a zero chance of no change. */
export function fedFundsPricingHeadline(probability: number | null | undefined, isCut: boolean): string {
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0) return "Unavailable";
  if (probability === 0) return "NO MOVE PRICED";
  return `${Math.round(probability)}% ${isCut ? "CUT" : "HIKE"}`;
}
