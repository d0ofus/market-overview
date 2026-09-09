import { describe, expect, it } from "vitest";
import { assessEodMembershipEvidence } from "../src/eod-membership-evidence";

const calendar = ["2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08"];
const membership = { universeId: "sp500-core", versionId: "immutable-version", sourceType: "wikipedia-derived-public-proxy",
  sourceAsOfDate: "2026-08-28", verifiedAt: "2026-09-08T21:00:00Z" };
const check = (patch: Partial<typeof membership> = {}) => assessEodMembershipEvidence({ ...membership, ...patch }, "2026-09-08", calendar);

describe("frozen membership evidence at publication", () => {
  it("uses fresh verification of an unchanged immutable list and does not redate its source", () => {
    expect(check()).toEqual({ publishable: true, reason: null, ageSessions: 0, degraded: false });
    expect(membership.sourceAsOfDate).toBe("2026-08-28");
  });
  it("allows at most five actual exchange sessions, skipping the weekend and Labor Day", () => {
    expect(check({ verifiedAt: "2026-08-31T21:00:00Z" })).toMatchObject({ publishable: true, ageSessions: 5, degraded: true });
    expect(check({ verifiedAt: "2026-08-28T21:00:00Z" })).toMatchObject({ publishable: false, ageSessions: 6 });
  });
  it("does not interpret a future immutable source date as age zero", () => {
    expect(check({ sourceAsOfDate: "2026-09-09" }).reason).toBe("membership-source-date-unavailable-or-future");
  });
  it.each(["2026-09-09T00:00:00Z", "2026-09-08T23:59:00-12:00", "2026-09-00T00:00:00Z", "2026-08-27T21:00:00Z"])(
    "rejects future or invalid verification %s", (verifiedAt) => expect(check({ verifiedAt }).publishable).toBe(false),
  );
  it.each(["bundled-fallback", "official-etf-holdings-proxy", "legacy-import", ""])("rejects unrelated/unverified source %s", (sourceType) => {
    expect(check({ sourceType }).reason).toBe("membership-source-unverified-or-unrelated");
  });
  it("keeps missing provenance and insufficient calendar history unavailable", () => {
    expect(assessEodMembershipEvidence({ ...membership, sourceAsOfDate: null }, "2026-09-08", calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence({ ...membership, verifiedAt: null }, "2026-09-08", calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence(membership, "2026-09-08", ["2026-09-08", "2026-09-08"]).publishable).toBe(false);
    expect(assessEodMembershipEvidence({ ...membership, verifiedAt: "2026-09-03T21:00:00Z" }, "2026-09-08", ["2026-09-08"]).publishable).toBe(false);
  });
});
