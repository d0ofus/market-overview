import { zonedParts } from "./refresh-timing";

/** Page publication checks frozen provenance again: persisted legacy inputs and
 * manually reconstructed runs must not bypass the current membership loader. */
export type EodMembershipEvidence = {
  universeId: string; versionId: string; sourceType: string | null;
  sourceAsOfDate: string | null; verifiedAt: string | null;
};
const sources: Record<string, readonly string[]> = {
  "sp500-core": ["wikipedia-derived-public-proxy", "public-index-constituents-proxy"],
  "nasdaq-core": ["public-common-stock-proxy"],
  "nyse-core": ["public-common-stock-proxy"],
  "overall-market-proxy": ["public-common-stock-proxy"],
  "russell2000-core": ["official-etf-holdings-proxy"],
};
function validDate(date: string | null): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

export function isEodMembershipSourceVerified(universeId: string, sourceType: string | null | undefined): boolean {
  return Boolean(sourceType && sources[universeId]?.includes(sourceType));
}

/** SQLite CURRENT_TIMESTAMP is UTC; ISO timestamps must carry their offset.
 * Verification belongs to the New York civil day, including after UTC midnight. */
export function membershipVerificationTime(value: string | null | undefined): number | null {
  if (!value || !validDate(value.slice(0, 10))) return null;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
  const normalized = sqlite ? `${value.replace(" ", "T")}Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

export function membershipVerificationDate(value: string | null | undefined): string | null {
  const time = membershipVerificationTime(value);
  return time === null ? null : zonedParts(new Date(time), "America/New_York").localDate;
}

/** Exclusive UTC boundary for versions observed during the target NY day.
 * US DST changes at 02:00; the offset at target-day noon also applies at its end. */
export function membershipSessionEndUtc(targetSession: string): string {
  if (!validDate(targetSession)) throw new Error("membership-session-date-invalid");
  const noon = new Date(`${targetSession}T12:00:00Z`);
  const offsetMinutes = zonedParts(noon, "America/New_York").minutesOfDay - 12 * 60;
  return new Date(noon.getTime() + (12 * 60 - offsetMinutes) * 60_000).toISOString();
}

export function assessEodMembershipEvidence(membership: EodMembershipEvidence, targetSession: string, calendarDates: string[]): {
  publishable: boolean; reason: string | null; ageSessions: number | null; degraded: boolean;
} {
  const unavailable = (reason: string) => ({ publishable: false, reason, ageSessions: null, degraded: true });
  if (!membership.versionId || !isEodMembershipSourceVerified(membership.universeId, membership.sourceType)) {
    return unavailable("membership-source-unverified-or-unrelated");
  }
  if (!validDate(membership.sourceAsOfDate) || membership.sourceAsOfDate > targetSession) {
    return unavailable("membership-source-date-unavailable-or-future");
  }
  let evidenceDate = membership.sourceAsOfDate;
  if (membership.verifiedAt !== null) {
    const verifiedDate = membershipVerificationDate(membership.verifiedAt);
    if (!verifiedDate || verifiedDate > targetSession
      || verifiedDate < membership.sourceAsOfDate) return unavailable("membership-verification-invalid-or-future");
    evidenceDate = verifiedDate;
  }
  if (!validDate(targetSession) || calendarDates.at(-1) !== targetSession
    || calendarDates.some((date, index) => !validDate(date) || (index > 0 && calendarDates[index - 1]! >= date))
    || (calendarDates[0]! > evidenceDate && calendarDates.length <= 5)) {
    return unavailable("membership-exchange-calendar-incomplete");
  }
  const ageSessions = calendarDates.filter((date) => date > evidenceDate).length;
  return { publishable: ageSessions <= 5, reason: ageSessions > 5 ? "membership-verification-expired" : null,
    ageSessions, degraded: ageSessions > 0 };
}
