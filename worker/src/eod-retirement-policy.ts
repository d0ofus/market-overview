/** User-approved operating gate. Version changes invalidate cached eligibility
 * and submitted retirement proofs; they do not alter price retention, CPU or
 * account quota limits. Nontrading-day telemetry remains operational evidence. */
export const EOD_RETIREMENT_REQUIRED_SESSIONS = 0;
export const EOD_OPERATIONAL_HISTORY_SESSIONS = 3;
export const EOD_RETIREMENT_POLICY_VERSION = "current-health-no-observation-v1";
export const EOD_ROLLOUT_MONITOR_KEY = `monitoring:${EOD_RETIREMENT_POLICY_VERSION}`;
export const EOD_USAGE_FINALIZATION_DELAY_DAYS = 2;

/** Whole-day account analytics retain one additional UTC day for corrections.
 * Evaluate a fixed calendar cutoff, not whichever historical usage rows happen
 * to exist. This is operational history only and never gates retirement. */
export function eodRetirementSessionCutoff(expectedSession: string, now = new Date()): string {
  const expectedTime = Date.parse(`${expectedSession}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedSession) || !Number.isFinite(expectedTime)
    || new Date(expectedTime).toISOString().slice(0, 10) !== expectedSession || !Number.isFinite(now.getTime())) {
    throw new Error("eod-retirement-session-cutoff-invalid");
  }
  const finalized = new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
    - EOD_USAGE_FINALIZATION_DELAY_DAYS * 86_400_000).toISOString().slice(0, 10);
  return expectedSession < finalized ? expectedSession : finalized;
}
