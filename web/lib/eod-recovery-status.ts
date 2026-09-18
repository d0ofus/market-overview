import type { EodPublicationStatus, EodRecoveryStatus } from "./api";

export type RecoveryMilestone = { label: string; status: "complete" | "pending" | "blocked" | "outdated"; detail: string };
export type EodRecoveryView = {
  status: "pending" | "running" | "paused" | "complete";
  blocker: string | null; stage: string; nextRetry: string | null;
  lastReportAt: string | null; lastCheckedAt: string | null; reportFreshness: "current" | "outdated" | "unavailable";
  computerNeeded: "yes" | "no" | "unknown" | "when recovery resumes"; computerDetail: string;
  monitoringCount: number | null; requiredSessions: 0; monitoringPolicyCurrent: boolean;
  currentHealth: "passed" | "failed" | "unverified"; milestones: RecoveryMilestone[];
};
const dateValid = (value: string | null | undefined): value is string => Boolean(value && Number.isFinite(Date.parse(value)));
const stageLabels: Record<string, string> = {
  "public-cutover": "Production cutover", "bootstrap": "Rebuilding the latest session", "copy": "Copying price history",
  "consumer-parity": "Checking historical readers", "storage-final-acceptance-required": "Checking production readiness",
  "configuration-recorded": "Production configuration recorded", "configuration": "Recording production configuration",
  "capacity-analysis": "Checking database capacity",
};
const reasonLabels: Record<string, string> = {
  "storage-local-quota-deferred": "Waiting for the next Cloudflare daily quota reset.",
  "storage-local-transient-retry": "A temporary service failure will be retried automatically.",
  "durable-github-stage-in-progress": "The GitHub recovery job is still working.",
  "runtime-candidate-await-actual-coordinator-window": "Waiting for an exchange update or morning recovery window.",
  "current-health-checks-remain": "Checking current publication, input revision and quota health.",
  "production-cutover-complete": "Production cutover is complete. Record and verify production configuration.",
  "three-trading-session-monitoring-remains": "Current publication and quota health must be verified; no observation period is required.",
  "storage-local-review-required": "Recovery is paused for review; inspect the detailed status below.",
  "storage-preflight-insufficient-headroom": "The proposed recent-price database does not leave enough free storage for safe operation. The storage layout must be revised and measured again.",
  "storage-preflight-insufficient-archive-headroom": "The history archive does not leave enough free storage for safe operation. Archive capacity must be resolved and measured again.",
  "storage-start-free-account-capacity-exceeded": "The proposed databases exceed the Cloudflare free-account storage allowance. The storage layout must fit within that allowance before recovery resumes.",
};
const capacityPauseReasons = new Set(["storage-preflight-insufficient-headroom", "storage-preflight-insufficient-archive-headroom", "storage-start-free-account-capacity-exceeded"]);
export function recoveryStageLabel(value: string): string {
  return stageLabels[value] ?? value.replace(/[-_]/g, " ");
}
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Recorded cutover/configuration establishes durable recovery completion.
 * Current operational health is separate and requires explicit fresh evidence. */
export function buildEodRecoveryView(input: {
  recovery: EodRecoveryStatus | null; publications: EodPublicationStatus | null;
  recoveryError?: string | null; publicationError?: string | null; now?: number;
}): EodRecoveryView {
  const now = input.now ?? Date.now(), recovery = input.recovery, controller = recovery?.controller, publications = input.publications;
  const responseCurrent = Boolean(recovery && !input.recoveryError && dateValid(recovery.checkedAt)
    && Date.parse(recovery.checkedAt) >= now - 5 * 60_000 && Date.parse(recovery.checkedAt) <= now + 60_000);
  const controllerCurrent = Boolean(responseCurrent && controller && !controller.stale && dateValid(controller.updatedAt)
    && Date.parse(controller.updatedAt) <= now + 60_000);
  const activation = recovery?.activation, configuration = recovery?.configuration;
  const activated = Boolean(responseCurrent && activation?.codeRevision && dateValid(activation.activatedAt));
  const controllerMatches = Boolean(controllerCurrent && activated && controller?.codeRevision === activation?.codeRevision);
  const configured = Boolean(activated && configuration?.status === "recorded" && configuration.codeRevision
    && configuration.activationCodeRevision === activation?.codeRevision && dateValid(configuration.recordedAt));
  const configurationMismatch = Boolean(responseCurrent && (configuration?.status === "mismatch"
    || (configuration?.status === "recorded" && activated && !configured)));
  const publicCurrent = Boolean(publications && !input.publicationError);
  const monitoring = publications?.monitoring;
  const currentPolicy = monitoring?.version === 3 && monitoring.policyVersion === "current-health-no-observation-v1" && monitoring.requiredSessions === 0;
  const count = currentPolicy && Number.isInteger(monitoring.consecutivePassedSessions)
    && monitoring.consecutivePassedSessions >= 0 ? monitoring.consecutivePassedSessions : null;
  const fresh = (value: string | null | undefined) => dateValid(value) && Date.parse(value) <= now + 60_000 && Date.parse(value) >= now - 300_000;
  const monitorCurrent = Boolean(publicCurrent && currentPolicy && !monitoring?.stale && fresh(monitoring?.checkedAt));
  const health = monitoring?.currentHealth, quota = health?.quota;
  const limits = publications?.budget?.limits ?? {
    eodDaily: { reads: 2_500_000, writes: 50_000 }, accountDaily: { reads: 4_500_000, writes: 90_000 }, rolling31: null,
  };
  const rolling = publications?.budget?.rolling31;
  const rollingValid = !limits.rolling31 || Boolean(rolling && fresh(rolling.sampledAt)
    && rolling.rowsRead + rolling.reservedReads <= limits.rolling31.reads
    && rolling.rowsWritten + rolling.reservedWrites <= limits.rolling31.writes);
  const quotaValid = Boolean(quota && Object.values(quota).every((value) => Number.isSafeInteger(value) && value >= 0)
    && quota.eodRowsRead + quota.reservedReads <= limits.eodDaily.reads && quota.eodRowsWritten + quota.reservedWrites <= limits.eodDaily.writes
    && quota.accountRowsRead + quota.reservedReads <= limits.accountDaily.reads && quota.accountRowsWritten + quota.reservedWrites <= limits.accountDaily.writes
    && rollingValid
    && quota.eodRowsRead <= quota.accountRowsRead && quota.eodRowsWritten <= quota.accountRowsWritten);
  const monitored = Boolean(monitorCurrent && monitoring?.eligibleForRetirement && monitoring.reasons.length === 0
    && health?.status === "passed" && health.reasons.length === 0 && health.expectedSession && calendarDate(health.expectedSession)
    && health.expectedSession === publications?.expectedSession && health.publicationCount === 6 && health.missingScopes.length === 0
    && health.completedRunId && health.inputCorrectionsPending === false && fresh(health.checkedAt) && fresh(health.quotaSampledAt)
    && health.usageDate === new Date(now).toISOString().slice(0,10) && quotaValid);
  const currentHealth: EodRecoveryView["currentHealth"] = monitored && publications?.ready && publications.mode === "active"
    && publications.inputCorrectionsPending === false ? "passed"
    : publicCurrent && (publications?.ready === false || publications?.inputCorrectionsPending === true
      || (monitorCurrent && health?.status === "failed")) ? "failed" : "unverified";
  const complete = Boolean(controllerMatches && controller?.status === "completed" && configured);
  const lastReportedPause = controller?.status === "paused";
  const capacityPause = Boolean(lastReportedPause && capacityPauseReasons.has(controller.reason));
  const status: EodRecoveryView["status"] = complete ? "complete" : lastReportedPause || configurationMismatch ? "paused"
    : controllerCurrent && controller?.status === "running" ? "running" : "pending";
  let blocker: string | null = null;
  if (!complete) {
    if (lastReportedPause) {
      blocker = reasonLabels[controller.reason] ?? (controller.reason ? recoveryStageLabel(controller.reason) : "Recovery is paused for review.");
      if (!controllerCurrent) blocker += ` Last reported ${controller.updatedAt}; current status is unverified.`;
    }
    else if (input.recoveryError) blocker = "Recovery status could not be refreshed. Last-known progress is shown; completion is unverified.";
    else if (!recovery || !controller) blocker = "No recovery controller report is available yet.";
    else if (!responseCurrent || !controllerCurrent) blocker = "The recovery report is outdated. Current progress and completion are unverified.";
    else if (configurationMismatch) blocker = "Recorded configuration does not match production. Review is required.";
    else if (controller.status === "paused" || controller.status === "running" || controller.status === "waiting") blocker = reasonLabels[controller.reason]
      ?? (controller.reason ? recoveryStageLabel(controller.reason) : "Recovery is still in progress.");
    else if (!activated || !controllerMatches) blocker = "Production cutover has not been verified against this recovery run.";
    else if (!configured) blocker = "The local recovery run finished, but production configuration has not been recorded and verified.";
    else blocker = "Recovery completion has not been confirmed.";
  }
  const outdatedRecovery = Boolean(recovery && (!responseCurrent || (controller && !controllerCurrent)));
  const milestones: RecoveryMilestone[] = [
    { label: "Recovery cutover", status: activated && controllerMatches ? "complete" : outdatedRecovery ? "outdated" : "pending",
      detail: activated && controllerMatches ? `Production activation verified (${activation!.codeRevision.slice(0, 7)}).` : "The recovered database must be verified in production." },
    { label: "Configuration recorded", status: configured ? "complete" : configurationMismatch ? "blocked" : outdatedRecovery ? "outdated" : "pending",
      detail: configured ? `Recorded production revision ${configuration!.codeRevision!.slice(0, 7)}.` : "A separate production configuration check is required after cutover." },
  ];
  const computerNeeded = configured || (publicCurrent && publications?.dailyOperation) ? "no" : capacityPause ? "when recovery resumes" : responseCurrent && controllerCurrent ? "yes" : "unknown";
  return { status, blocker, stage: controller ? recoveryStageLabel(controller.stage) : "Awaiting a recovery report",
    nextRetry: dateValid(controller?.nextAttemptAt) ? controller.nextAttemptAt : null,
    lastReportAt: controller?.updatedAt ?? null, lastCheckedAt: recovery?.checkedAt ?? null,
    reportFreshness: !controller ? "unavailable" : controllerCurrent ? "current" : "outdated", computerNeeded,
    computerDetail: computerNeeded === "no" ? "The recovery computer is no longer needed for daily ingestion or monitoring; cloud jobs continue."
      : computerNeeded === "when recovery resumes" ? "The recovery computer will be needed when recovery resumes. Keeping it on does not clear this capacity pause."
      : computerNeeded === "yes" ? "Keep the recovery computer on and signed in until production configuration is recorded."
        : "Computer requirements are unverified until a current recovery report is available.",
    monitoringCount: count, requiredSessions: 0, monitoringPolicyCurrent: currentPolicy, currentHealth, milestones };
}
