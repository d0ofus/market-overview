import type { BreadthDashboardResponse } from "./api";

type Membership = BreadthDashboardResponse["universes"][number]["membership"];

export function breadthMembershipPresentation(membership: Membership): {
  label: string; severity: "normal" | "amber" | "red"; detail: string;
} {
  const age = typeof membership.sourceAgeSessions === "number" && Number.isFinite(membership.sourceAgeSessions)
    ? membership.sourceAgeSessions : null;
  if (membership.status === "missing" || membership.status === "invalid") {
    return { label: membership.status === "missing" ? "Membership unavailable" : "Membership invalid",
      severity: "red", detail: membership.degradationReason ?? "No validated membership is available." };
  }
  if (age !== null && age > 5) {
    return { label: "Membership verification expired", severity: "red",
      detail: `Verification was ${age} exchange sessions old at publication, beyond the 5-session limit.` };
  }
  if (membership.degraded || (age !== null && age > 0)) {
    return { label: "Degraded membership", severity: "amber",
      detail: membership.degradationReason ?? (age === null
        ? "Previously verified membership reused; verification age is unavailable."
        : `Previously verified membership reused; ${age} exchange session${age === 1 ? "" : "s"} old at publication (maximum 5).`) };
  }
  if (!membership.verifiedAt || age === null) {
    return { label: "Verification age unavailable", severity: "amber",
      detail: "Stored membership provenance is shown, but its verification time or exchange-session age is unavailable." };
  }
  return { label: "Verified for publication", severity: "normal", detail: "Membership was verified for the displayed publication session." };
}
