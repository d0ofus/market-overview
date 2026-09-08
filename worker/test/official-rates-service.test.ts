import { describe, expect, it } from "vitest";
import { normalizeOfficialRates } from "../src/official-rates-service";

describe("official New York Fed rate facts", () => {
  it("preserves the effective observation date independently from fetch time", () => {
    expect(normalizeOfficialRates({ refRates: [{ type: "EFFR", effectiveDate: "2026-09-04", percentRate: 3.63, targetRateFrom: 3.5, targetRateTo: 3.75 }] }, "2026-09-08T00:00:00Z"))
      .toMatchObject({ effectiveDate: "2026-09-04", fetchedAt: "2026-09-08T00:00:00Z", effr: 3.63, targetLower: 3.5, targetUpper: 3.75 });
  });
  it("rejects future dates and missing EFFR instead of making zero facts", () => {
    expect(normalizeOfficialRates({ refRates: [{ type: "EFFR", effectiveDate: "2026-09-09", percentRate: 3.6 }] }, "2026-09-08T00:00:00Z")).toBeNull();
    expect(normalizeOfficialRates({ refRates: [{ type: "EFFR", effectiveDate: "2026-09-04", percentRate: null }] }, "2026-09-08T00:00:00Z")).toBeNull();
  });
});
