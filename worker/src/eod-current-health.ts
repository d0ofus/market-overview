import { z } from "zod";
import { eodDeadline, eodInputCorrectionStatus, EOD_PUBLICATION_SCOPES, expectedEodSession } from "./eod-coordinator";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import type { Env } from "./types";

const count = z.number().int().nonnegative().safe();
const publicActivationSchema = z.object({ version: z.literal(1), activatedAt: z.string().datetime({ offset: true }),
  codeRevision: z.string().regex(/^[a-f0-9]{40}$/i), marketDatabaseId: z.string().uuid(),
}).strict();
export const eodCurrentHealthSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }), codeRevision: z.string().nullable(),
  status: z.enum(["passed", "failed", "pending"]), expectedSession: z.string().nullable(),
  publicationCount: count, missingScopes: z.array(z.string()), completedRunId: z.string().nullable(),
  inputCorrectionsPending: z.boolean().nullable(), reasons: z.array(z.string()),
  usageDate: z.string(), quotaSampledAt: z.string().nullable(),
  quota: z.object({ eodRowsRead: count, eodRowsWritten: count, accountRowsRead: count, accountRowsWritten: count,
    reservedReads: count, reservedWrites: count }).nullable(),
}).strict();
export type EodCurrentHealth = z.infer<typeof eodCurrentHealthSchema>;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Current indexed control evidence only. No elapsed-session requirement, no
 * provider fetches, and no absent observations converted into success. Admission
 * still verifies live D1 capacities and cutover still verifies payloads/coverage. */
export async function collectEodCurrentHealth(env: Env, now = new Date()): Promise<EodCurrentHealth> {
  const result: EodCurrentHealth = { checkedAt: now.toISOString(), codeRevision: env.EOD_CODE_REVISION ?? null,
    status: "pending", expectedSession: null, publicationCount: 0, missingScopes: [...EOD_PUBLICATION_SCOPES],
    completedRunId: null, inputCorrectionsPending: null, reasons: [], usageDate: now.toISOString().slice(0, 10), quotaSampledAt: null, quota: null };
  if (!env.OPS_DB || !env.MARKET_DATA_DB) { result.reasons.push("current-health-bindings-unavailable"); return result; }
  if (env.EOD_RUNNER_MODE !== "active" || env.EOD_READ_ENABLED !== "true") result.reasons.push("public-eod-operation-not-active");
  if (!result.codeRevision || !/^[a-f0-9]{40}$/i.test(result.codeRevision)) result.reasons.push("current-code-revision-unavailable");
  result.expectedSession = await expectedEodSession(env, now);
  if (!result.expectedSession) result.reasons.push("exchange-calendar-unavailable");
  const calendar = result.expectedSession ? await env.MARKET_DATA_DB.prepare("SELECT close_at FROM market_calendar_sessions WHERE session_date=?")
    .bind(result.expectedSession).first<{ close_at: string }>() : null;
  const closeAt = calendar && result.expectedSession ? Date.parse(eodDeadline(result.expectedSession, calendar.close_at)) - 120 * 60_000 : NaN;
  const [pointers, corrections, activation, eod, account, local] = await Promise.all([
    env.MARKET_DATA_DB.prepare(`SELECT h.scope,h.publication_id,h.session_date,p.accepted_at,p.payload_checksum
      FROM eod_publication_pointers h JOIN eod_publications p ON p.id=h.publication_id
        AND p.scope=h.scope AND p.session_date=h.session_date AND p.status='accepted' AND p.methodology_version=?
      WHERE h.scope IN (SELECT value FROM json_each(?))`)
      .bind(EOD_METRICS_VERSION, JSON.stringify(EOD_PUBLICATION_SCOPES)).all<{ scope: string; publication_id: string; session_date: string; accepted_at: string | null; payload_checksum: string | null }>(),
    eodInputCorrectionStatus(env, result.expectedSession),
    env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='monitoring:public-activation'").first<string>("evidence_json"),
    env.OPS_DB.prepare("SELECT rows_read,rows_written,reserved_reads,reserved_writes FROM eod_usage WHERE usage_date=?")
      .bind(result.usageDate).first<{ rows_read: number; rows_written: number; reserved_reads: number; reserved_writes: number }>(),
    env.OPS_DB.prepare("SELECT rows_read,rows_written,sampled_at,error FROM eod_account_usage WHERE usage_date=?")
      .bind(result.usageDate).first<{ rows_read: number; rows_written: number; sampled_at: string; error: string | null }>(),
    env.OPS_DB.prepare("SELECT rows_read,rows_written FROM market_data_daily_usage WHERE usage_date=?")
      .bind(result.usageDate).first<{ rows_read: number; rows_written: number }>(),
  ]);
  const usable = pointers.results.filter((row) => row.session_date === result.expectedSession && row.accepted_at
    && Number.isFinite(Date.parse(row.accepted_at)) && Date.parse(row.accepted_at) <= now.getTime() && Date.parse(row.accepted_at) >= closeAt
    && typeof row.payload_checksum === "string" && /^[a-f0-9]{64}$/.test(row.payload_checksum));
  result.missingScopes = EOD_PUBLICATION_SCOPES.filter((scope) => !usable.some((row) => row.scope === scope));
  result.publicationCount = usable.length;
  if (result.missingScopes.length || usable.length !== EOD_PUBLICATION_SCOPES.length) result.reasons.push("current-publications-incomplete");
  result.completedRunId = corrections.completedRunId; result.inputCorrectionsPending = corrections.inputCorrectionsPending;
  if (corrections.inputCorrectionsPending !== false) result.reasons.push(corrections.inputCorrectionsPending ? "current-input-corrections-pending" : "current-input-state-unavailable");
  if (corrections.completedRunId) {
    const progress = await env.OPS_DB.prepare("SELECT progress_json FROM eod_runs WHERE id=?").bind(corrections.completedRunId).first<string>("progress_json");
    let published: unknown;
    try { published = JSON.parse(progress ?? "{}").published; } catch { published = null; }
    if (!Array.isArray(published) || published.length !== 6 || new Set(published).size !== 6
      || usable.some((row) => !published.includes(row.publication_id))) result.reasons.push("current-publication-run-mismatch");
  } else result.reasons.push("current-completed-run-unavailable");
  let activationValue: unknown = null;
  try { activationValue = activation ? JSON.parse(activation) : null; } catch { /* Unavailable remains a blocker. */ }
  const parsedActivation = publicActivationSchema.safeParse(activationValue);
  if (!parsedActivation.success || Date.parse(parsedActivation.data.activatedAt) > now.getTime()) result.reasons.push("public-activation-unverified");
  const values = eod && account && local ? [eod.rows_read, eod.rows_written, eod.reserved_reads, eod.reserved_writes,
    account.rows_read, account.rows_written, local.rows_read, local.rows_written] : [];
  result.quotaSampledAt = account?.sampled_at ?? null;
  if (values.length !== 8 || !values.every(valid) || account?.error) result.reasons.push("current-quota-unavailable");
  else {
    const age = now.getTime() - Date.parse(account!.sampled_at);
    if (!Number.isFinite(age) || age < 0 || age > 300_000) result.reasons.push("current-account-sample-stale");
    result.quota = { eodRowsRead: eod!.rows_read, eodRowsWritten: eod!.rows_written,
      accountRowsRead: Math.max(account!.rows_read, local!.rows_read), accountRowsWritten: Math.max(account!.rows_written, local!.rows_written),
      reservedReads: eod!.reserved_reads, reservedWrites: eod!.reserved_writes };
    const quota = result.quota;
    if (quota.eodRowsRead + quota.reservedReads > 2_500_000 || quota.eodRowsWritten + quota.reservedWrites > 50_000
      || quota.accountRowsRead + quota.reservedReads > 4_500_000 || quota.accountRowsWritten + quota.reservedWrites > 90_000
      || quota.eodRowsRead > quota.accountRowsRead || quota.eodRowsWritten > quota.accountRowsWritten) result.reasons.push("current-quota-headroom-unavailable");
  }
  result.status = result.reasons.length === 0 ? "passed" : result.reasons.some((reason) => /incomplete|mismatch|pending|headroom/.test(reason)) ? "failed" : "pending";
  return result;
}

export function isEodCurrentHealthReady(value: unknown, now = new Date()): value is EodCurrentHealth {
  const parsed = eodCurrentHealthSchema.safeParse(value);
  if (!parsed.success) return false;
  const health = parsed.data, age = now.getTime() - Date.parse(health.checkedAt), quotaAge = health.quotaSampledAt ? now.getTime() - Date.parse(health.quotaSampledAt) : NaN;
  return health.status === "passed" && health.reasons.length === 0 && health.expectedSession !== null
    && health.codeRevision !== null && /^[a-f0-9]{40}$/i.test(health.codeRevision)
    && /^\d{4}-\d{2}-\d{2}$/.test(health.expectedSession) && health.publicationCount === 6 && health.missingScopes.length === 0
    && health.completedRunId !== null && health.inputCorrectionsPending === false && health.quota !== null
    && health.usageDate === now.toISOString().slice(0, 10) && age >= 0 && age <= 300_000 && quotaAge >= 0 && quotaAge <= 300_000
    && health.quota.eodRowsRead + health.quota.reservedReads <= 2_500_000 && health.quota.eodRowsWritten + health.quota.reservedWrites <= 50_000
    && health.quota.accountRowsRead + health.quota.reservedReads <= 4_500_000 && health.quota.accountRowsWritten + health.quota.reservedWrites <= 90_000
    && health.quota.eodRowsRead <= health.quota.accountRowsRead && health.quota.eodRowsWritten <= health.quota.accountRowsWritten;
}
