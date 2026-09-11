import { z } from "zod";
import { eodDeadline, EOD_PUBLICATION_SCOPES, expectedEodSession } from "./eod-coordinator";
import { fetchEodAccountUsage } from "./eod-account-usage";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import { eodRetirementSessionCutoff, EOD_RETIREMENT_POLICY_VERSION, EOD_RETIREMENT_REQUIRED_SESSIONS,
  EOD_OPERATIONAL_HISTORY_SESSIONS, EOD_ROLLOUT_MONITOR_KEY, EOD_USAGE_FINALIZATION_DELAY_DAYS } from "./eod-retirement-policy";
import { collectEodCurrentHealth, eodCurrentHealthSchema, isEodCurrentHealthReady, type EodCurrentHealth } from "./eod-current-health";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const USAGE_PREFIX = "monitoring:utc-usage:";
const counters = z.number().int().nonnegative().safe();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const timestamp = z.string().datetime({ offset: true });
const publicActivationSchema = z.object({ version: z.literal(1), activatedAt: timestamp,
  codeRevision: z.string().regex(/^[a-f0-9]{40}$/i), marketDatabaseId: z.string().uuid(),
}).strict();
const finalizedUsageSchema = z.object({
  version: z.literal(1), usageDate: date, sampledAt: timestamp, finalizedAfter: timestamp,
  source: z.literal("cloudflare-account-analytics-and-metered-ledgers"),
  eodRowsRead: counters, eodRowsWritten: counters, accountRowsRead: counters, accountRowsWritten: counters,
  reservedReads: z.literal(0), reservedWrites: z.literal(0),
}).strict();
export type EodFinalizedUsage = z.infer<typeof finalizedUsageSchema>;
type UsageRow = { rows_read: number; rows_written: number; reserved_reads?: number; reserved_writes?: number };
type PublishedScope = { scope: typeof EOD_PUBLICATION_SCOPES[number]; publicationId: string; acceptedAt: string };
export type EodSessionMonitoring = {
  sessionDate: string; closeAt: string; deadlineAt: string; runId: string | null;
  firstCompletePublicationAt: string | null; scopes: PublishedScope[];
  missingScopes: string[]; lateScopes: string[];
  status: "passed" | "failed" | "pending"; reasons: string[];
};
export type EodUsageMonitoring = {
  usageDate: string; requiredForRetirement: boolean;
  status: "passed" | "failed" | "pending"; reasons: string[]; evidence: EodFinalizedUsage | null;
};
export type EodRolloutMonitoring = {
  version: 3; policyVersion: typeof EOD_RETIREMENT_POLICY_VERSION; methodologyVersion: string; checkedAt: string; mode: string;
  requiredSessions: typeof EOD_RETIREMENT_REQUIRED_SESSIONS; consecutivePassedSessions: number; eligibleForRetirement: boolean;
  latestEvaluatedSession: string | null; sessions: EodSessionMonitoring[]; usageDays: EodUsageMonitoring[];
  usageFinalizationCutoff: string | null; newerSessions: EodSessionMonitoring[];
  currentHealth: EodCurrentHealth | null; operationalReasons: string[];
  reasons: string[]; stale?: boolean;
};

function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function validCounters(row: UsageRow | null): row is UsageRow {
  return row !== null && [row.rows_read, row.rows_written, row.reserved_reads ?? 0, row.reserved_writes ?? 0]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}
function usageReasons(evidence: EodFinalizedUsage): string[] {
  const reasons: string[] = [];
  if (evidence.eodRowsRead > 2_500_000 || evidence.eodRowsWritten > 50_000) reasons.push("eod-daily-budget-exceeded");
  if (evidence.accountRowsRead > 4_500_000 || evidence.accountRowsWritten > 90_000) reasons.push("account-daily-budget-exceeded");
  if (evidence.eodRowsRead > evidence.accountRowsRead || evidence.eodRowsWritten > evidence.accountRowsWritten) {
    reasons.push("account-usage-does-not-cover-eod");
  }
  return reasons;
}

/** A same-day sample cannot prove a whole UTC day's allowance. Wait a complete
 * additional UTC day for delayed analytics, retain real observation dates and
 * never decrease a previous high-water mark. Analytics remain provider-reported
 * usage estimates; the EOD side is settled D1 response metadata. */
export async function finalizeEodUsageDay(input: {
  accountId: string; token: string; ops: D1Database; usageDate: string; now?: Date; fetcher?: typeof fetch;
}): Promise<EodFinalizedUsage> {
  const now = input.now ?? new Date();
  if (!date.safeParse(input.usageDate).success) throw new Error("eod-monitor-invalid-usage-date");
  const finalizedAfter = new Date(Date.parse(`${input.usageDate}T00:00:00Z`) + EOD_USAGE_FINALIZATION_DELAY_DAYS * DAY_MS);
  if (now < finalizedAfter) throw new Error("eod-monitor-usage-day-not-finalizable");
  const [eod, local, previous] = await Promise.all([
    input.ops.prepare("SELECT rows_read,rows_written,reserved_reads,reserved_writes FROM eod_usage WHERE usage_date=?")
      .bind(input.usageDate).first<UsageRow>(),
    input.ops.prepare("SELECT rows_read,rows_written FROM market_data_daily_usage WHERE usage_date=?")
      .bind(input.usageDate).first<UsageRow>(),
    input.ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(`${USAGE_PREFIX}${input.usageDate}`).first<{ evidence_json: string }>(),
  ]);
  // Even weekend work must establish an explicit, measured ledger. Absence is
  // unknown rather than zero; outstanding reservations can still settle higher.
  if (!validCounters(eod) || !validCounters(local)) throw new Error("eod-monitor-usage-ledger-missing");
  if (eod.reserved_reads !== 0 || eod.reserved_writes !== 0) throw new Error("eod-monitor-usage-unsettled");
  const before = previous ? finalizedUsageSchema.safeParse(parseJson(previous.evidence_json)) : null;
  if (previous && (!before?.success || before.data.usageDate !== input.usageDate)) {
    throw new Error("eod-monitor-previous-usage-invalid");
  }
  const measured = await fetchEodAccountUsage(input);
  const prior = before?.success ? before.data : null;
  const evidence: EodFinalizedUsage = {
    version: 1, usageDate: input.usageDate, sampledAt: now.toISOString(), finalizedAfter: finalizedAfter.toISOString(),
    source: "cloudflare-account-analytics-and-metered-ledgers",
    eodRowsRead: Math.max(eod.rows_read, prior?.eodRowsRead ?? 0),
    eodRowsWritten: Math.max(eod.rows_written, prior?.eodRowsWritten ?? 0),
    accountRowsRead: Math.max(measured.rowsRead, local.rows_read, prior?.accountRowsRead ?? 0),
    accountRowsWritten: Math.max(measured.rowsWritten, local.rows_written, prior?.accountRowsWritten ?? 0),
    reservedReads: 0, reservedWrites: 0,
  };
  await input.ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(`${USAGE_PREFIX}${input.usageDate}`, JSON.stringify(evidence), now.toISOString()).run();
  return evidence;
}

/** Bounded startup/maintenance collection. Recheck recent closed buckets for
 * delayed corrections; older missing buckets are selected by explicit callers. */
export async function finalizeRecentEodUsage(input: {
  accountId: string; token: string; ops: D1Database; now?: Date; fetcher?: typeof fetch;
}): Promise<Array<{ usageDate: string; status: "recorded" | "pending"; reason?: string }>> {
  const now = input.now ?? new Date(), results: Array<{ usageDate: string; status: "recorded" | "pending"; reason?: string }> = [];
  const previousDate = (daysAgo: number) => new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - daysAgo * DAY_MS).toISOString().slice(0, 10);
  // One bounded recovery slot repairs older missed analytics after an outage;
  // two slots still recheck recent days for late account corrections.
  const missing = await input.ops.prepare(`SELECT usage_date FROM eod_usage WHERE usage_date>=? AND usage_date<=?
    AND NOT EXISTS (SELECT 1 FROM eod_rollout_evidence WHERE id=?||eod_usage.usage_date)
    ORDER BY usage_date LIMIT 1`).bind(previousDate(30), previousDate(EOD_USAGE_FINALIZATION_DELAY_DAYS + 2), USAGE_PREFIX).first<{ usage_date: string }>();
  const days = [previousDate(EOD_USAGE_FINALIZATION_DELAY_DAYS), previousDate(EOD_USAGE_FINALIZATION_DELAY_DAYS + 1),
    missing?.usage_date ?? previousDate(EOD_USAGE_FINALIZATION_DELAY_DAYS + 2)];
  for (const usageDate of days) {
    try { await finalizeEodUsageDay({ ...input, now, usageDate }); results.push({ usageDate, status: "recorded" }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Network/provider details and query text never become public diagnostics.
      const reason = /^eod-(?:monitor|account-usage)-[a-z-]+$/.test(message) ? message : "eod-monitor-usage-collection-failed";
      results.push({ usageDate, status: "pending", reason });
      // Respect admission deferrals: never hammer an exhausted quota for the
      // remaining dates merely to obtain monitoring data.
      if (/quota|budget|capacity/.test(message)) break;
    }
  }
  return results;
}

/** Collect evidence in GitHub/maintenance, not during public page reads.
 * Historical session outcomes use whole UTC-day usage and remain diagnostics.
 * Later corrections cannot erase or manufacture an on-time first publication. */
export async function collectEodRolloutMonitoring(env: Env, now = new Date()): Promise<EodRolloutMonitoring> {
  if (!env.OPS_DB || !env.MARKET_DATA_DB) throw new Error("eod-monitor-bindings-required");
  const result: EodRolloutMonitoring = {
    version: 3, policyVersion: EOD_RETIREMENT_POLICY_VERSION, methodologyVersion: EOD_METRICS_VERSION,
    checkedAt: now.toISOString(), mode: env.EOD_RUNNER_MODE ?? "disabled",
    requiredSessions: EOD_RETIREMENT_REQUIRED_SESSIONS, consecutivePassedSessions: 0, eligibleForRetirement: false,
    latestEvaluatedSession: null, sessions: [], usageDays: [], reasons: [], usageFinalizationCutoff: null, newerSessions: [],
    currentHealth: null, operationalReasons: [],
  };
  const expected = await expectedEodSession(env, now);
  if (!expected) result.reasons.push("exchange-calendar-unavailable");
  const cutoff = expected ? eodRetirementSessionCutoff(expected, now) : null;
  result.usageFinalizationCutoff = cutoff;
  const calendar = expected ? await env.MARKET_DATA_DB.prepare(`SELECT session_date AS sessionDate,close_at AS closeAt
    FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT ?`)
    .bind(cutoff, EOD_OPERATIONAL_HISTORY_SESSIONS).all<{ sessionDate: string; closeAt: string }>() : { results: [] };
  const closed = calendar.results.map((session) => ({ ...session, deadlineAt: eodDeadline(session.sessionDate, session.closeAt) }))
    .filter((session) => Date.parse(session.deadlineAt) <= now.getTime()).slice(0, EOD_OPERATIONAL_HISTORY_SESSIONS).reverse();
  // At most the two recent UTC dates can be newer than the finalization cutoff.
  // Observe their delivery separately while finalized usage remains pending.
  // All historical outcomes are informational under the no-observation policy.
  const recentCalendar = expected ? await env.MARKET_DATA_DB.prepare(`SELECT session_date AS sessionDate,close_at AS closeAt
    FROM market_calendar_sessions WHERE session_date>? AND session_date<=? ORDER BY session_date LIMIT ?`)
    .bind(cutoff, expected, EOD_USAGE_FINALIZATION_DELAY_DAYS + 1).all<{ sessionDate: string; closeAt: string }>() : { results: [] };
  const recentClosed = recentCalendar.results.map((session) => ({ ...session, deadlineAt: eodDeadline(session.sessionDate, session.closeAt) }))
    .filter((session) => Date.parse(session.deadlineAt) <= now.getTime());
  if (closed.length !== EOD_OPERATIONAL_HISTORY_SESSIONS) result.reasons.push("operational-calendar-history-incomplete");
  if (env.EOD_RUNNER_MODE !== "active") result.reasons.push("active-operation-not-started");
  if (env.EOD_READ_ENABLED !== "true") result.reasons.push("public-eod-reads-disabled");
  if (closed.length) {
    const observedSessions = [...closed, ...recentClosed];
    const first = closed[0]!.sessionDate, last = observedSessions.at(-1)!.sessionDate;
    result.latestEvaluatedSession = closed.at(-1)!.sessionDate;
    const [coverage, runs, publications, usage, activationRow] = await Promise.all([
      env.MARKET_DATA_DB.prepare("SELECT covered_start,covered_end FROM market_calendar_refresh_state WHERE id='default'")
        .first<{ covered_start: string; covered_end: string }>(),
      env.OPS_DB.prepare(`SELECT id,session_date FROM eod_runs WHERE mode='active' AND purpose='daily'
        AND session_date>=? AND session_date<=? ORDER BY session_date`).bind(first, last)
        .all<{ id: string; session_date: string }>(),
      env.MARKET_DATA_DB.prepare(`WITH first_acceptance AS (
        SELECT id,scope,session_date,accepted_at,ROW_NUMBER() OVER (
          PARTITION BY scope,session_date ORDER BY accepted_at,id) AS position
        FROM eod_publications WHERE scope IN (SELECT value FROM json_each(?))
          AND status='accepted' AND session_date>=? AND session_date<=?
          AND accepted_at IS NOT NULL AND methodology_version=?)
        SELECT id,scope,session_date,accepted_at FROM first_acceptance WHERE position=1`)
        .bind(JSON.stringify(EOD_PUBLICATION_SCOPES), first, last, EOD_METRICS_VERSION)
        .all<{ id: string; scope: PublishedScope["scope"]; session_date: string; accepted_at: string }>(),
      env.OPS_DB.prepare("SELECT id,evidence_json FROM eod_rollout_evidence WHERE id>=? AND id<=? ORDER BY id")
        .bind(`${USAGE_PREFIX}${first}`, `${USAGE_PREFIX}${last}`).all<{ id: string; evidence_json: string }>(),
      env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='monitoring:public-activation'")
        .first<{ evidence_json: string }>(),
    ]);
    const activation = publicActivationSchema.safeParse(activationRow ? parseJson(activationRow.evidence_json) : null);
    const activatedAt = activation.success ? Date.parse(activation.data.activatedAt) : null;
    if (activatedAt === null || activatedAt > now.getTime()) result.reasons.push("public-activation-evidence-missing-or-invalid");
    if (!coverage || coverage.covered_start > first || coverage.covered_end < expected!) {
      result.reasons.push("exchange-calendar-coverage-incomplete");
    }
    const usageByDate = new Map(usage.results.map((row) => [row.id.slice(USAGE_PREFIX.length), parseJson(row.evidence_json)]));
    const finalizedSessionDates = new Set(closed.map((session) => session.sessionDate));
    for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += DAY_MS) {
      const usageDate = new Date(time).toISOString().slice(0, 10), parsed = finalizedUsageSchema.safeParse(usageByDate.get(usageDate));
      const row: EodUsageMonitoring = { usageDate, requiredForRetirement: false, status: "pending", reasons: [], evidence: null };
      if (!parsed.success) row.reasons.push("finalized-utc-usage-missing");
      else if (parsed.data.usageDate !== usageDate || Date.parse(parsed.data.sampledAt) > now.getTime()
        || Date.parse(parsed.data.finalizedAfter) !== time + EOD_USAGE_FINALIZATION_DELAY_DAYS * DAY_MS
        || Date.parse(parsed.data.sampledAt) < time + EOD_USAGE_FINALIZATION_DELAY_DAYS * DAY_MS) row.reasons.push("finalized-utc-usage-invalid");
      else {
        row.evidence = parsed.data; row.reasons = usageReasons(parsed.data);
        row.status = row.reasons.length ? "failed" : "passed";
      }
      result.usageDays.push(row);
    }
    for (const session of observedSessions) {
      const rows = publications.results.filter((row) => row.session_date === session.sessionDate);
      const scopes = rows.map((row) => ({ scope: row.scope, publicationId: row.id, acceptedAt: row.accepted_at }));
      const missingScopes = EOD_PUBLICATION_SCOPES.filter((scope) => !scopes.some((row) => row.scope === scope));
      const closeAtUtc = Date.parse(session.deadlineAt) - 120 * 60_000;
      const lateScopes = scopes.filter((row) => !Number.isFinite(Date.parse(row.acceptedAt))
        || Date.parse(row.acceptedAt) > Date.parse(session.deadlineAt) || Date.parse(row.acceptedAt) < closeAtUtc).map((row) => row.scope);
      const runId = runs.results.find((run) => run.session_date === session.sessionDate)?.id ?? null;
      const reasons: string[] = [];
      if (!runId) reasons.push("active-daily-run-missing");
      if (activatedAt === null || activatedAt > Date.parse(session.deadlineAt)) reasons.push("public-publication-not-active-by-deadline");
      if (missingScopes.length) reasons.push("required-publication-scopes-missing");
      if (lateScopes.length) reasons.push("first-publication-deadline-missed-or-invalid");
      const deliveryFailed = reasons.length > 0;
      const day = result.usageDays.find((row) => row.usageDate === session.sessionDate)!;
      reasons.push(...day.reasons);
      const destination = finalizedSessionDates.has(session.sessionDate) ? result.sessions : result.newerSessions;
      destination.push({ ...session, runId, scopes, missingScopes, lateScopes, reasons,
        firstCompletePublicationAt: !missingScopes.length && scopes.every((row) => Number.isFinite(Date.parse(row.acceptedAt)))
          && activatedAt !== null
          ? new Date(Math.max(activatedAt, ...scopes.map((row) => Date.parse(row.acceptedAt)))).toISOString() : null,
        status: deliveryFailed || day.status === "failed" ? "failed" : day.status,
      });
    }
    for (const session of [...result.sessions].reverse()) {
      if (session.status !== "passed") break;
      result.consecutivePassedSessions++;
    }
    if (result.sessions.some((session) => session.status === "failed")) result.reasons.push("session-delivery-or-budget-failed");
    if (result.newerSessions.some((session) => session.status === "failed")) result.reasons.push("newer-session-delivery-failed");
    if (result.usageDays.some((day) => day.status === "pending")) result.reasons.push("finalized-utc-usage-pending");
    if (result.usageDays.some((day) => day.status === "failed")) result.reasons.push("utc-operating-budget-exceeded");
  }
  result.operationalReasons = result.reasons;
  result.currentHealth = await collectEodCurrentHealth(env, now);
  result.reasons = [...result.currentHealth.reasons];
  result.eligibleForRetirement = isEodCurrentHealthReady(result.currentHealth, now);
  await env.OPS_DB.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(EOD_ROLLOUT_MONITOR_KEY, JSON.stringify(result), now.toISOString()).run();
  return result;
}

/** One indexed control read for readiness/admin. It never initiates collection. */
export async function readEodRolloutMonitoring(env: Env, now = new Date()): Promise<EodRolloutMonitoring | null> {
  if (!env.OPS_DB) return null;
  const row = await env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(EOD_ROLLOUT_MONITOR_KEY).first<{ evidence_json: string }>();
  const value = row ? parseJson(row.evidence_json) as Partial<EodRolloutMonitoring> | null : null;
  if (!value || value.version !== 3 || value.policyVersion !== EOD_RETIREMENT_POLICY_VERSION
    || value.requiredSessions !== EOD_RETIREMENT_REQUIRED_SESSIONS || value.methodologyVersion !== EOD_METRICS_VERSION
    || !Array.isArray(value.sessions) || !Array.isArray(value.newerSessions) || !Array.isArray(value.usageDays) || !Array.isArray(value.reasons)
    || !(value.usageFinalizationCutoff === null || date.safeParse(value.usageFinalizationCutoff).success)
    || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  const stale = Date.parse(value.checkedAt) > now.getTime() || now.getTime() - Date.parse(value.checkedAt) > 30 * 60 * 60_000;
  const parsedHealth = eodCurrentHealthSchema.safeParse(value.currentHealth);
  const health = parsedHealth.success ? parsedHealth.data : null;
  // A valid health record can be stale. Discard the predicate's false-branch
  // narrowing so a failed readiness check does not erase that typed record.
  const currentHealthReady = Boolean(isEodCurrentHealthReady(health, now));
  const healthExpired = health?.status === "passed" && !currentHealthReady;
  const currentHealth = healthExpired ? { ...health!, status: "pending" as const,
    reasons: [...health!.reasons, "current-health-evidence-expired"] } : health;
  const reasons = [...value.reasons];
  if (stale) reasons.push("monitor-sample-stale");
  if (healthExpired) reasons.push("current-health-evidence-expired");
  if (!health) reasons.push("current-health-evidence-unavailable");
  return { ...value as EodRolloutMonitoring, stale,
    currentHealth, eligibleForRetirement: value.eligibleForRetirement === true && currentHealthReady
      && !stale && env.EOD_RUNNER_MODE === "active" && env.EOD_READ_ENABLED === "true",
    reasons,
  };
}
