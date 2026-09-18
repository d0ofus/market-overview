import { z } from "zod";
import { eodHash } from "./eod-publication-service";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import { eodStoragePolicy } from "./eod-storage-policy";
import type { Env } from "./types";
import type { HistoryCapacityEvidence, HistoryReaderEvidence } from "./eod-history-maintenance";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const dailyReleaseSchema = z.object({
  version: z.literal(2), policy: z.literal("paid-daily-v2"), budgetProfile: z.literal("paid"),
  codeRevision: z.string().regex(/^[a-f0-9]{40}$/), methodologyVersion: z.literal(EOD_METRICS_VERSION),
  approvedAt: timestamp, migrationId: z.string().startsWith("market-storage:"), hotSessions: z.literal(90),
  bindings: z.object({ core: z.string().uuid(), market: z.string().uuid(), history: z.string().uuid(), ops: z.string().uuid(), source: z.string().uuid() }).strict(),
  schemas: z.object({ market: hash, history: hash }).strict(),
  sourceEvidence: z.array(z.object({ key: z.string(), hash, recordedAt: timestamp }).strict()).min(2),
  readers: z.object({ contractVersion: z.literal(1), checkedAt: timestamp, consumers: z.array(z.string()),
    parityPassed: z.literal(true), codeRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  publicationSession: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), publicationIds: z.array(z.string()).length(6),
  sharedTickerCount: z.number().int().positive().max(10_000),
  validationHash: hash,
}).strict();
export type DailyRelease = z.infer<typeof dailyReleaseSchema>;
export async function readDailyEvidence<T>(ops: D1Database, id: string): Promise<T | null> {
  const row = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
  return row ? JSON.parse(row) as T : null;
}
export async function writeDailyEvidence(ops: D1Database, id: string, value: unknown, now = new Date()) {
  await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(id, JSON.stringify(value), now.toISOString()).run();
}
export async function loadDailyRelease(env: Env): Promise<DailyRelease | null> {
  if (!env.OPS_DB || !env.EOD_CODE_REVISION) return null;
  const stored = await readDailyEvidence<{ proof: unknown; proofHash: string }>(env.OPS_DB, `daily-release:${env.EOD_CODE_REVISION}`);
  if (!stored) return null;
  const proof = dailyReleaseSchema.parse(stored.proof);
  if (proof.codeRevision !== env.EOD_CODE_REVISION || proof.readers.codeRevision !== proof.codeRevision
    || env.EOD_BUDGET_PROFILE !== proof.budgetProfile || await eodHash(stored.proof) !== stored.proofHash
    || Date.parse(proof.approvedAt) > Date.now() || Date.parse(proof.readers.checkedAt) > Date.parse(proof.approvedAt)) {
    throw new Error("eod-daily-release-integrity");
  }
  return proof;
}
export async function dailySchemaHash(db: D1Database): Promise<string> {
  return eodHash((await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results);
}
/** Called before an active writer claims work, never from public page reads. */
export async function assertDailyReleaseBindings(env: Env, release: DailyRelease) {
  if (!env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) throw new Error("eod-daily-release-bindings");
  for (const [role, db] of [["market", env.MARKET_DATA_DB], ["history", env.MARKET_HISTORY_DB]] as const) {
    const fence = await db.prepare("SELECT status,migration_id FROM market_storage_fence WHERE id='default'").first<{ status: string; migration_id: string }>();
    if (fence?.status !== "open" || fence.migration_id !== release.migrationId || await dailySchemaHash(db) !== release.schemas[role]) {
      throw new Error("eod-daily-release-database-mismatch");
    }
  }
}
export type DailyStorageSample = { checkedAt: string; databases: Array<{ id: string; bytes: number }>; accountBytes: number };
export async function sampleDailyStorage(input: { accountId: string; token: string; ops: D1Database }, now = new Date()) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database?per_page=100`, {
    headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`eod-storage-sample-http-${response.status}`);
  const data = await response.json() as { success: boolean; result: Array<{ uuid: string; file_size: number }>; result_info?: { total_count?: number; total_pages?: number } };
  if (!data.success || !Array.isArray(data.result) || data.result.length >= 100 || (data.result_info?.total_pages ?? 1) > 1
    || (data.result_info?.total_count ?? data.result.length) > data.result.length
    || data.result.some((row) => !Number.isSafeInteger(row.file_size) || row.file_size < 0)) throw new Error("eod-storage-sample-incomplete");
  const databases = data.result.map((row) => ({ id: row.uuid, bytes: row.file_size }));
  const sample: DailyStorageSample = { checkedAt: now.toISOString(), databases, accountBytes: databases.reduce((sum, row) => sum + row.bytes, 0) };
  await writeDailyEvidence(input.ops, "daily-storage:current", sample, now);
  return sample;
}
export async function dailyStorageStatus(env: Env, now = new Date()) {
  const sample = env.OPS_DB ? await readDailyEvidence<DailyStorageSample>(env.OPS_DB, "daily-storage:current") : null;
  const limits = eodStoragePolicy(env.EOD_BUDGET_PROFILE);
  const fresh = sample && Date.parse(sample.checkedAt) <= now.getTime() && now.getTime() - Date.parse(sample.checkedAt) < 86_400_000;
  return { ...sample, limits, status: !fresh ? "unmeasured" : sample.accountBytes >= limits.accountOptionalStopBytes ? "critical"
    : sample.accountBytes >= limits.accountWarningBytes ? "warning" : "ready" };
}
/** Live physical sizes plus a bounded relocation allowance. This does not
 * claim that an old forecast was remeasured or expand any history window. */
export async function dailyRetentionEvidence(env: Env, release: DailyRelease, now = new Date()): Promise<{
  capacity: HistoryCapacityEvidence; readers: HistoryReaderEvidence; hotSessions: 90; feeds: readonly ["sip", "yahoo-eod"];
}> {
  const status = await dailyStorageStatus(env, now);
  if (status.status === "unmeasured") throw new Error("eod-storage-sample-unavailable");
  if (status.status === "critical") throw new Error("eod-capacity-optional-growth-stopped");
  const [market, history] = await Promise.all([env.MARKET_DATA_DB!.prepare("SELECT 1 AS history_capacity_probe").all(),
    env.MARKET_HISTORY_DB!.prepare("SELECT 1 AS history_capacity_probe").all()]);
  const marketBytes = market.meta.size_after, historyBytes = history.meta.size_after;
  if (![marketBytes, historyBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("eod-storage-size-unavailable");
  return { hotSessions: 90, readers: release.readers, feeds: ["sip", "yahoo-eod"], capacity: {
    measuredAt: now.toISOString(), marketDatabaseBytes: marketBytes, archiveDatabaseBytes: historyBytes,
    priceTableAndIndexBytes: 0, priceRows: 0, retainedPriceRows: 0, additionalArchiveBytes: 8_000_000,
    liveProjection: { marketBytes, archiveBytes: historyBytes + 8_000_000, baselineMeasuredAt: now.toISOString(),
      sampledRows: 0, populationSize: release.sharedTickerCount, remainingHotRows: 0, priceBytesPerRowBound: 0 },
  } };
}

export async function dailyOperationStatus(env: Env, now = new Date()) {
  const release = await loadDailyRelease(env);
  if (!release) return null;
  const storage = await dailyStorageStatus(env, now);
  const state = await readDailyEvidence<{ sessionDate: string; updatedAt: string; completedAt: string | null;
    startedAt: string; deletedRows: number; archivedRows: number; deferredRepairs: string[];
    tickers: string[]; feed: string; cursor: {tickerIndex:number} | null }>(env.OPS_DB!, "history-retention:state");
  return { codeRevision: release.codeRevision, approvedAt: release.approvedAt, hotSessions: release.hotSessions,
    storage: { status: storage.status, checkedAt: storage.checkedAt ?? null, accountBytes: storage.accountBytes ?? null,
      marketBytes: storage.databases?.find(row=>row.id===release.bindings.market)?.bytes ?? null,
      historyBytes: storage.databases?.find(row=>row.id===release.bindings.history)?.bytes ?? null, limits: storage.limits },
    maintenance: state ? { sessionDate: state.sessionDate, updatedAt: state.updatedAt, completedAt: state.completedAt,
      startedAt: state.startedAt, deletedRows: state.deletedRows, archivedRows: state.archivedRows,
      feed: state.feed, remainingSecurityChecks: state.completedAt ? 0 : Math.max(0,state.tickers.length-(state.cursor?.tickerIndex ?? 0)),
      deferredRepairCount: state.deferredRepairs.length, pending: !state.completedAt } : null };
}
