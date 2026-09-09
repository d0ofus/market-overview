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

export function assessEodMembershipEvidence(membership: EodMembershipEvidence, targetSession: string, calendarDates: string[]): {
  publishable: boolean; reason: string | null; ageSessions: number | null; degraded: boolean;
} {
  const unavailable = (reason: string) => ({ publishable: false, reason, ageSessions: null, degraded: true });
  if (!membership.versionId || !membership.sourceType || !sources[membership.universeId]?.includes(membership.sourceType)) {
    return unavailable("membership-source-unverified-or-unrelated");
  }
  if (!validDate(membership.sourceAsOfDate) || membership.sourceAsOfDate > targetSession) {
    return unavailable("membership-source-date-unavailable-or-future");
  }
  let evidenceDate = membership.sourceAsOfDate;
  if (membership.verifiedAt !== null) {
    const verifiedDate = membership.verifiedAt.slice(0, 10), time = Date.parse(membership.verifiedAt);
    if (!validDate(verifiedDate) || !Number.isFinite(time) || !/[T ]\d{2}:\d{2}/.test(membership.verifiedAt)
      || verifiedDate > targetSession || new Date(time).toISOString().slice(0, 10) > targetSession
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
