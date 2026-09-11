import { describe, expect, it } from "vitest";
import { assessEodMembershipEvidence, membershipSessionEndUtc, membershipVerificationDate } from "../src/eod-membership-evidence";

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
  it.each(["2026-09-09T04:00:00Z", "2026-09-08T23:59:00-12:00", "2026-09-00T00:00:00Z", "2026-08-27T21:00:00Z", "2026-09-08T24:00:00Z"])(
    "rejects future or invalid verification %s", (verifiedAt) => expect(check({ verifiedAt }).publishable).toBe(false),
  );
  it.each(["2026-09-09T00:15:00Z", "2026-09-09 00:15:00", "2026-09-09T10:15:00+10:00"])(
    "accepts actual New York evening verification across UTC midnight %s", (verifiedAt) => {
      expect(check({ verifiedAt })).toMatchObject({ publishable: true, ageSessions: 0, degraded: false });
      expect(membershipVerificationDate(verifiedAt)).toBe("2026-09-08");
    },
  );
  it("uses daylight-saving aware exclusive observation boundaries", () => {
    expect(membershipSessionEndUtc("2026-09-08")).toBe("2026-09-09T04:00:00.000Z");
    expect(membershipSessionEndUtc("2026-01-08")).toBe("2026-01-09T05:00:00.000Z");
    expect(membershipSessionEndUtc("2026-03-07")).toBe("2026-03-08T05:00:00.000Z");
    expect(membershipSessionEndUtc("2026-03-08")).toBe("2026-03-09T04:00:00.000Z");
    expect(membershipSessionEndUtc("2026-11-01")).toBe("2026-11-02T05:00:00.000Z");
  });
  it.each(["bundled-fallback", "official-etf-holdings-proxy", "legacy-import", ""])("rejects unrelated/unverified source %s", (sourceType) => {
    expect(check({ sourceType }).reason).toBe("membership-source-unverified-or-unrelated");
  });
  it("keeps missing provenance and insufficient calendar history unavailable", () => {
    expect(assessEodMembershipEvidence({ ...membership, sourceAsOfDate: null, verifiedAt: null }, "2026-09-08", calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence({ ...membership, verifiedAt: null }, "2026-09-08", calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence(membership, "2026-09-08", ["2026-09-08", "2026-09-08"]).publishable).toBe(false);
    expect(assessEodMembershipEvidence({ ...membership, verifiedAt: "2026-09-03T21:00:00Z" }, "2026-09-08", ["2026-09-08"]).publishable).toBe(false);
  });
  it("uses observation timestamps for an undated proxy without assigning a source date or backdating tomorrow's set", () => {
    expect(assessEodMembershipEvidence({...membership,sourceAsOfDate:null},"2026-09-08",calendar))
      .toMatchObject({publishable:true,ageSessions:0,degraded:false});
    expect(assessEodMembershipEvidence({...membership,sourceAsOfDate:null,verifiedAt:"2026-09-09T05:00:00Z"},"2026-09-08",calendar).publishable).toBe(false);
  });
  it("retains a dated issuer file's real later collection time and historical age", () => {
    const actual={universeId:"russell2000-core",versionId:"dated-issuer-version",sourceType:"official-etf-holdings-proxy",
      sourceAsOfDate:"2026-09-04",verifiedAt:"2026-09-09T05:00:00Z"};
    expect(assessEodMembershipEvidence(actual,"2026-09-08",calendar)).toMatchObject({publishable:true,ageSessions:1,degraded:true});
    expect(actual.verifiedAt).toBe("2026-09-09T05:00:00Z");
    expect(assessEodMembershipEvidence({...actual,sourceAsOfDate:"2026-09-09"},"2026-09-08",calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence({...actual,sourceAsOfDate:"2026-08-28"},"2026-09-08",calendar).publishable).toBe(false);
    expect(assessEodMembershipEvidence({...actual,verifiedAt:"2027-09-09T05:00:00Z"},"2026-09-08",calendar,
      new Date("2026-09-11T05:00:00Z")).reason).toBe("membership-verification-invalid-or-future");
  });
});
