import type { EodPublicationStatus, EodRecoveryStatus } from "./api";

export type RecoveryMilestone = { label: string; status: "complete" | "pending" | "blocked" | "outdated"; detail: string };
export type EodRecoveryView = {
  status: "pending" | "running" | "paused" | "complete";
  blocker: string | null; stage: string; nextRetry: string | null;
  lastReportAt: string | null; lastCheckedAt: string | null; reportFreshness: "current" | "outdated" | "unavailable";
  computerNeeded: "yes" | "no" | "unknown" | "when recovery resumes"; computerDetail: string;
  monitoringCount: number | null; requiredSessions: 3; milestones: RecoveryMilestone[];
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
  "three-trading-session-monitoring-remains": "Collecting three trading sessions of delivery and finalized usage evidence.",
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
function tradingDate(value: string): boolean {
  if (!calendarDate(value)) return false;
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** The server supplies exchange-session evidence. Never convert calendar days
 * elapsed into progress, or treat a completed local command as verified setup. */
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
  const currentPolicy = monitoring?.version === 2 && monitoring.policyVersion === "three-trading-sessions-v1" && monitoring.requiredSessions === 3
    && typeof monitoring.usageFinalizationCutoff === "string" && calendarDate(monitoring.usageFinalizationCutoff) && Array.isArray(monitoring.newerSessions);
  const count = currentPolicy && Number.isInteger(monitoring.consecutivePassedSessions)
    && monitoring.consecutivePassedSessions >= 0 && monitoring.consecutivePassedSessions <= 3 ? monitoring.consecutivePassedSessions : null;
  const monitorCurrent = Boolean(publicCurrent && currentPolicy && !monitoring?.stale && dateValid(monitoring?.checkedAt));
  const observedSessions = monitoring?.sessions.filter((session) => session.status === "passed" && tradingDate(session.sessionDate)
    && monitoring.usageFinalizationCutoff && session.sessionDate <= monitoring.usageFinalizationCutoff) ?? [];
  const monitored = Boolean(monitorCurrent && monitoring?.eligibleForRetirement && count === 3 && monitoring.reasons.length === 0
    && new Set(observedSessions.map((session) => session.sessionDate)).size === 3 && monitoring.sessions.length === 3
    && monitoring.newerSessions?.every((session) => session.status !== "failed"));
  const complete = Boolean(controllerMatches && controller?.status === "completed" && configured && monitored
    && publicCurrent && publications?.ready && publications.mode === "active" && publications.inputCorrectionsPending === false);
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
    else if (input.publicationError || !publications) blocker = "Publication and monitoring status is unavailable. Configuration is recorded; monitoring completion is unverified.";
    else if (!currentPolicy) blocker = "Awaiting a report for the current three-trading-session policy.";
    else if (!monitorCurrent) blocker = "The monitoring report is outdated. Awaiting a current delivery and usage check.";
    else if (publications.inputCorrectionsPending !== false) blocker = publications.inputCorrectionsPending === true
      ? "Corrected inputs are awaiting new publications." : "Publication correction status is unavailable.";
    else if (!publications.ready || publications.mode !== "active") blocker = "Current production delivery is not ready. Inspect the publication details below.";
    else if (monitoring?.newerSessions?.some((session) => session.status === "failed")) blocker = "A newer trading session failed its delivery check. Inspect the monitoring details below.";
    else blocker = monitored ? "Recovery completion has not been confirmed." : count === 3
      ? "Three sessions are reported, but remaining delivery or quota checks still need attention."
      : `${count ?? 0} of 3 trading sessions have passed. Awaiting delivery and finalized usage evidence.`;
  }
  const outdatedRecovery = Boolean(recovery && (!responseCurrent || (controller && !controllerCurrent)));
  const milestones: RecoveryMilestone[] = [
    { label: "Recovery cutover", status: activated && controllerMatches ? "complete" : outdatedRecovery ? "outdated" : "pending",
      detail: activated && controllerMatches ? `Production activation verified (${activation!.codeRevision.slice(0, 7)}).` : "The recovered database must be verified in production." },
    { label: "Configuration recorded", status: configured ? "complete" : configurationMismatch ? "blocked" : outdatedRecovery ? "outdated" : "pending",
      detail: configured ? `Recorded production revision ${configuration!.codeRevision!.slice(0, 7)}.` : "A separate production configuration check is required after cutover." },
    { label: "3 trading sessions", status: monitored ? "complete" : monitoring && (!publicCurrent || !monitorCurrent) ? "outdated" : "pending",
      detail: currentPolicy ? `${count ?? 0}/3 consecutive trading sessions reported${count === 3 && !monitored ? "; final checks pending" : ""}. Weekends and exchange holidays do not count.`
        : "Awaiting current three-session evidence. Weekends and exchange holidays do not count." },
  ];
  const computerNeeded = configured ? "no" : capacityPause ? "when recovery resumes" : responseCurrent && controllerCurrent ? "yes" : "unknown";
  return { status, blocker, stage: controller ? recoveryStageLabel(controller.stage) : "Awaiting a recovery report",
    nextRetry: dateValid(controller?.nextAttemptAt) ? controller.nextAttemptAt : null,
    lastReportAt: controller?.updatedAt ?? null, lastCheckedAt: recovery?.checkedAt ?? null,
    reportFreshness: !controller ? "unavailable" : controllerCurrent ? "current" : "outdated", computerNeeded,
    computerDetail: computerNeeded === "no" ? "The recovery computer is no longer needed for daily ingestion or monitoring; cloud jobs continue."
      : computerNeeded === "when recovery resumes" ? "The recovery computer will be needed when recovery resumes. Keeping it on does not clear this capacity pause."
      : computerNeeded === "yes" ? "Keep the recovery computer on and signed in until production configuration is recorded."
        : "Computer requirements are unverified until a current recovery report is available.",
    monitoringCount: count, requiredSessions: 3, milestones };
}
