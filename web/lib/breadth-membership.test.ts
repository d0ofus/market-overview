import assert from "node:assert/strict";
import test from "node:test";
import { breadthMembershipPresentation } from "./breadth-membership";

const membership = { versionId: "version", source: "Official directory", sourceType: "official-directory",
  sourceUrl: null, sourceAsOfDate: "2026-09-04", status: "published-version" as const };

test("accepted publications visibly disclose reused membership and unknown verification", () => {
  const degraded = breadthMembershipPresentation({ ...membership, verifiedAt: "2026-09-04T20:30:00Z", sourceAgeSessions: 2, degraded: true });
  assert.equal(degraded.severity, "amber");
  assert.equal(degraded.label, "Degraded membership");
  assert.match(degraded.detail, /2 exchange sessions old at publication/);
  assert.equal(breadthMembershipPresentation(membership).label, "Verification age unavailable");
  assert.equal(breadthMembershipPresentation({ ...membership, verifiedAt: "2026-09-08T20:30:00Z", sourceAgeSessions: 0, degraded: false }).severity, "normal");
  assert.equal(breadthMembershipPresentation({ ...membership, status: "invalid" }).severity, "red");
  assert.equal(breadthMembershipPresentation({ ...membership, verifiedAt: "2026-09-01T20:30:00Z", sourceAgeSessions: 6 }).severity, "red");
});
