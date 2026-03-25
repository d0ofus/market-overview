import type { Env } from "../types";
import type {
  ResearchEvidenceInput,
  ResearchEvidenceRecord,
  ResearchFactorRecord,
  ResearchRankingRecord,
  ResearchRunListItem,
  ResearchRunRecord,
  ResearchRunTickerRecord,
  ResearchSnapshotRecord,
  ResearchRunRequest,
  ResolvedResearchProfile,
  ResearchRefreshMode,
  ResearchRankingMode,
} from "./types";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function uid() {
  return crypto.randomUUID();
}

function mapRun(row: any): ResearchRunRecord {
  return {
    id: String(row.id),
    sourceType: row.sourceType,
    sourceId: row.sourceId ?? null,
    sourceLabel: row.sourceLabel ?? null,
    status: row.status,
    profileId: String(row.profileId),
    profileVersionId: String(row.profileVersionId),
    requestedTickerCount: Number(row.requestedTickerCount ?? 0),
    completedTickerCount: Number(row.completedTickerCount ?? 0),
    failedTickerCount: Number(row.failedTickerCount ?? 0),
    deepDiveTopN: Number(row.deepDiveTopN ?? 0),
    refreshMode: row.refreshMode,
    rankingMode: row.rankingMode,
    inputJson: parseJson(row.inputJson, null),
    providerUsageJson: parseJson(row.providerUsageJson, null),
    provenanceJson: parseJson(row.provenanceJson, null),
    errorSummary: row.errorSummary ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapRunTicker(row: any): ResearchRunTickerRecord {
  return {
    id: String(row.id),
    runId: String(row.runId),
    ticker: String(row.ticker),
    sortOrder: Number(row.sortOrder ?? 0),
    companyName: row.companyName ?? null,
    exchange: row.exchange ?? null,
    secCik: row.secCik ?? null,
    irDomain: row.irDomain ?? null,
    status: row.status,
    attemptCount: Number(row.attemptCount ?? 0),
    lastError: row.lastError ?? null,
    previousSnapshotId: row.previousSnapshotId ?? null,
    snapshotId: row.snapshotId ?? null,
    rankingRowId: row.rankingRowId ?? null,
    normalizationJson: parseJson(row.normalizationJson, null),
    workingJson: parseJson(row.workingJson, null),
    stageMetricsJson: parseJson(row.stageMetricsJson, null),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapEvidence(row: any): ResearchEvidenceRecord {
  return {
    id: String(row.id),
    providerKey: row.providerKey,
    sourceKind: row.sourceKind,
    scopeKind: row.scopeKind,
    ticker: row.ticker ?? null,
    secCik: row.secCik ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    sourceDomain: row.sourceDomain ?? null,
    title: String(row.title ?? ""),
    publishedAt: row.publishedAt ?? null,
    retrievedAt: String(row.retrievedAt ?? ""),
    contentHash: String(row.contentHash ?? ""),
    cacheKey: String(row.cacheKey ?? ""),
    artifactSizeBytes: typeof row.artifactSizeBytes === "number" ? row.artifactSizeBytes : null,
    r2Key: row.r2Key ?? null,
    snippet: parseJson(row.snippetJson, null),
    metadata: parseJson(row.metadataJson, null),
    providerPayload: parseJson(row.providerPayloadJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapSnapshot(row: any): ResearchSnapshotRecord {
  return {
    id: String(row.id),
    runId: String(row.runId),
    runTickerId: String(row.runTickerId),
    ticker: String(row.ticker),
    profileId: String(row.profileId),
    profileVersionId: String(row.profileVersionId),
    previousSnapshotId: row.previousSnapshotId ?? null,
    schemaVersion: String(row.schemaVersion ?? "v1"),
    overallScore: typeof row.overallScore === "number" ? row.overallScore : null,
    attentionRank: typeof row.attentionRank === "number" ? row.attentionRank : null,
    confidenceLabel: row.confidenceLabel ?? null,
    confidenceScore: typeof row.confidenceScore === "number" ? row.confidenceScore : null,
    valuationLabel: row.valuationLabel ?? null,
    earningsQualityLabel: row.earningsQualityLabel ?? null,
    catalystFreshnessLabel: row.catalystFreshnessLabel ?? null,
    riskLabel: row.riskLabel ?? null,
    contradictionFlag: Boolean(row.contradictionFlag),
    thesisJson: parseJson(row.thesisJson, {}),
    changeJson: parseJson(row.changeJson, null),
    citationJson: parseJson(row.citationJson, null),
    modelOutputJson: parseJson(row.modelOutputJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapFactor(row: any): ResearchFactorRecord {
  return {
    id: String(row.id),
    snapshotId: String(row.snapshotId),
    ticker: String(row.ticker),
    factorKey: String(row.factorKey),
    score: Number(row.score ?? 0),
    direction: row.direction,
    confidenceScore: typeof row.confidenceScore === "number" ? row.confidenceScore : null,
    weightApplied: Number(row.weightApplied ?? 0),
    explanationJson: parseJson(row.explanationJson, null),
    supportingEvidenceIds: parseJson(row.supportingEvidenceIdsJson, []),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapRanking(row: any): ResearchRankingRecord {
  return {
    id: String(row.id),
    runId: String(row.runId),
    snapshotId: String(row.snapshotId),
    ticker: String(row.ticker),
    rank: Number(row.rank ?? 0),
    attentionScore: Number(row.attentionScore ?? 0),
    priorityBucket: row.priorityBucket,
    deepDiveRequested: Boolean(row.deepDiveRequested),
    deepDiveCompleted: Boolean(row.deepDiveCompleted),
    rankingJson: parseJson(row.rankingJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

export async function createResearchRun(env: Env, input: {
  request: ResearchRunRequest;
  profile: ResolvedResearchProfile;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string | null;
  tickers: string[];
  deepDiveTopN: number;
  refreshMode: ResearchRefreshMode;
  rankingMode: ResearchRankingMode;
}): Promise<ResearchRunRecord> {
  const runId = uid();
  const previousHeads = input.tickers.length > 0
    ? await env.DB.prepare(
      `SELECT ticker, latest_snapshot_id as latestSnapshotId FROM ticker_research_heads WHERE profile_id = ? AND ticker IN (${input.tickers.map(() => "?").join(",")})`,
    ).bind(input.profile.profile.id, ...input.tickers).all<{ ticker: string; latestSnapshotId: string | null }>()
    : { results: [] };
  const previousSnapshotByTicker = new Map((previousHeads.results ?? []).map((row) => [row.ticker.toUpperCase(), row.latestSnapshotId]));
  const statements = [
    env.DB.prepare(
      "INSERT INTO research_runs (id, source_type, source_id, source_label, status, profile_id, profile_version_id, requested_ticker_count, completed_ticker_count, failed_ticker_count, deep_dive_top_n, refresh_mode, ranking_mode, input_json, provenance_json, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)",
    ).bind(
      runId,
      input.sourceType,
      input.sourceId,
      input.sourceLabel,
      input.profile.profile.id,
      input.profile.version.id,
      input.tickers.length,
      input.deepDiveTopN,
      input.refreshMode,
      input.rankingMode,
      JSON.stringify(input.request),
      JSON.stringify({
        profileName: input.profile.profile.name,
        profileVersionNumber: input.profile.version.versionNumber,
        promptVersionIds: {
          haiku: input.profile.bundle.haiku.id,
          sonnetRank: input.profile.bundle.sonnetRank.id,
          sonnetDeepDive: input.profile.bundle.sonnetDeepDive.id,
        },
        rubricVersionId: input.profile.bundle.rubric.id,
        searchTemplateVersionId: input.profile.bundle.searchTemplate.id,
      }),
    ),
    ...input.tickers.map((ticker, index) => env.DB.prepare(
      "INSERT INTO research_run_tickers (id, run_id, ticker, sort_order, status, attempt_count, previous_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).bind(uid(), runId, ticker, index + 1, previousSnapshotByTicker.get(ticker) ?? null)),
  ];
  await env.DB.batch(statements);
  const run = await loadResearchRun(env, runId);
  if (!run) throw new Error("Failed to load created research run.");
  return run;
}

export async function listResearchRuns(env: Env, options?: {
  sourceType?: string | null;
  sourceId?: string | null;
  limit?: number;
}): Promise<ResearchRunListItem[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (options?.sourceType) {
    where.push("r.source_type = ?");
    bindings.push(options.sourceType);
  }
  if (options?.sourceId) {
    where.push("r.source_id = ?");
    bindings.push(options.sourceId);
  }
  const sql = [
    "SELECT r.id, r.source_type as sourceType, r.source_id as sourceId, r.source_label as sourceLabel, r.status, r.profile_id as profileId, r.profile_version_id as profileVersionId, r.requested_ticker_count as requestedTickerCount, r.completed_ticker_count as completedTickerCount, r.failed_ticker_count as failedTickerCount, r.deep_dive_top_n as deepDiveTopN, r.refresh_mode as refreshMode, r.ranking_mode as rankingMode, r.input_json as inputJson, r.provider_usage_json as providerUsageJson, r.provenance_json as provenanceJson, r.error_summary as errorSummary, r.started_at as startedAt, r.completed_at as completedAt, r.heartbeat_at as heartbeatAt, r.created_at as createdAt, r.updated_at as updatedAt, p.name as profileName, pv.version_number as profileVersionNumber",
    "FROM research_runs r",
    "LEFT JOIN research_profiles p ON p.id = r.profile_id",
    "LEFT JOIN research_profile_versions pv ON pv.id = r.profile_version_id",
    where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY r.created_at DESC",
    `LIMIT ${limit}`,
  ].filter(Boolean).join(" ");
  const rows = await env.DB.prepare(sql).bind(...bindings).all();
  return (rows.results ?? []).map((row: any) => ({
    run: mapRun(row),
    profileName: row.profileName ?? null,
    profileVersionNumber: typeof row.profileVersionNumber === "number" ? row.profileVersionNumber : null,
  }));
}

export async function loadResearchRun(env: Env, runId: string): Promise<ResearchRunRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, source_type as sourceType, source_id as sourceId, source_label as sourceLabel, status, profile_id as profileId, profile_version_id as profileVersionId, requested_ticker_count as requestedTickerCount, completed_ticker_count as completedTickerCount, failed_ticker_count as failedTickerCount, deep_dive_top_n as deepDiveTopN, refresh_mode as refreshMode, ranking_mode as rankingMode, input_json as inputJson, provider_usage_json as providerUsageJson, provenance_json as provenanceJson, error_summary as errorSummary, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_runs WHERE id = ? LIMIT 1",
  ).bind(runId).first();
  return row ? mapRun(row) : null;
}

export async function loadResearchRunTickers(env: Env, runId: string): Promise<ResearchRunTickerRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, attempt_count as attemptCount, last_error as lastError, previous_snapshot_id as previousSnapshotId, snapshot_id as snapshotId, ranking_row_id as rankingRowId, normalization_json as normalizationJson, working_json as workingJson, stage_metrics_json as stageMetricsJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_run_tickers WHERE run_id = ? ORDER BY sort_order ASC",
  ).bind(runId).all();
  return (rows.results ?? []).map(mapRunTicker);
}

export async function loadNextRunnableResearchTicker(env: Env, runId: string): Promise<ResearchRunTickerRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, attempt_count as attemptCount, last_error as lastError, previous_snapshot_id as previousSnapshotId, snapshot_id as snapshotId, ranking_row_id as rankingRowId, normalization_json as normalizationJson, working_json as workingJson, stage_metrics_json as stageMetricsJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_run_tickers WHERE run_id = ? AND status IN ('queued') ORDER BY sort_order ASC LIMIT 1",
  ).bind(runId).first();
  return row ? mapRunTicker(row) : null;
}

export async function claimNextRunnableResearchTicker(env: Env, runId: string): Promise<ResearchRunTickerRecord | null> {
  const row = await env.DB.prepare(
    `UPDATE research_run_tickers
     SET status = 'normalizing',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         heartbeat_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT id
       FROM research_run_tickers
       WHERE run_id = ? AND status = 'queued'
       ORDER BY sort_order ASC
       LIMIT 1
     )
     RETURNING
       id,
       run_id as runId,
       ticker,
       sort_order as sortOrder,
       company_name as companyName,
       exchange,
       sec_cik as secCik,
       ir_domain as irDomain,
       status,
       attempt_count as attemptCount,
       last_error as lastError,
       previous_snapshot_id as previousSnapshotId,
       snapshot_id as snapshotId,
       ranking_row_id as rankingRowId,
       normalization_json as normalizationJson,
       working_json as workingJson,
       stage_metrics_json as stageMetricsJson,
       started_at as startedAt,
       completed_at as completedAt,
       heartbeat_at as heartbeatAt,
       created_at as createdAt,
       updated_at as updatedAt`,
  ).bind(runId).first();
  return row ? mapRunTicker(row) : null;
}

export async function updateResearchRun(env: Env, runId: string, patch: {
  status?: string;
  providerUsageJson?: Record<string, unknown> | null;
  provenanceJson?: Record<string, unknown> | null;
  errorSummary?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  completedTickerCount?: number;
  failedTickerCount?: number;
}): Promise<void> {
  const current = await loadResearchRun(env, runId);
  if (!current) throw new Error("Research run not found.");
  await env.DB.prepare(
    "UPDATE research_runs SET status = ?, provider_usage_json = ?, provenance_json = ?, error_summary = ?, started_at = ?, completed_at = ?, heartbeat_at = CURRENT_TIMESTAMP, completed_ticker_count = ?, failed_ticker_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(
    patch.status ?? current.status,
    JSON.stringify(patch.providerUsageJson ?? current.providerUsageJson ?? null),
    JSON.stringify(patch.provenanceJson ?? current.provenanceJson ?? null),
    patch.errorSummary === undefined ? current.errorSummary : patch.errorSummary,
    patch.startedAt === undefined ? current.startedAt : patch.startedAt,
    patch.completedAt === undefined ? current.completedAt : patch.completedAt,
    patch.completedTickerCount ?? current.completedTickerCount,
    patch.failedTickerCount ?? current.failedTickerCount,
    runId,
  ).run();
}

export async function cancelResearchRun(env: Env, runId: string): Promise<ResearchRunRecord | null> {
  const current = await loadResearchRun(env, runId);
  if (!current) return null;
  if (current.status === "completed" || current.status === "partial" || current.status === "failed" || current.status === "cancelled") {
    return current;
  }
  const cancelledAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE research_runs SET status = 'cancelled', error_summary = ?, completed_at = COALESCE(completed_at, ?), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind("Cancelled by user.", cancelledAt, runId),
    env.DB.prepare(
      "UPDATE research_run_tickers SET status = 'cancelled', last_error = COALESCE(last_error, ?), completed_at = COALESCE(completed_at, ?), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status IN ('queued', 'normalizing', 'retrieving', 'extracting', 'ranking_ready', 'deep_dive')",
    ).bind("Cancelled by user.", cancelledAt, runId),
  ]);
  return loadResearchRun(env, runId);
}

export async function updateResearchRunHeartbeat(env: Env, runId: string): Promise<void> {
  await env.DB.prepare("UPDATE research_runs SET heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(runId).run();
}

export async function updateResearchRunTicker(env: Env, runTickerId: string, patch: {
  status?: string;
  companyName?: string | null;
  exchange?: string | null;
  secCik?: string | null;
  irDomain?: string | null;
  attemptCount?: number;
  lastError?: string | null;
  snapshotId?: string | null;
  rankingRowId?: string | null;
  normalizationJson?: Record<string, unknown> | null;
  workingJson?: Record<string, unknown> | null;
  stageMetricsJson?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
}): Promise<void> {
  const currentRow = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, attempt_count as attemptCount, last_error as lastError, previous_snapshot_id as previousSnapshotId, snapshot_id as snapshotId, ranking_row_id as rankingRowId, normalization_json as normalizationJson, working_json as workingJson, stage_metrics_json as stageMetricsJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_run_tickers WHERE id = ? LIMIT 1",
  ).bind(runTickerId).first();
  if (!currentRow) throw new Error("Research run ticker not found.");
  const current = mapRunTicker(currentRow);
  await env.DB.prepare(
    "UPDATE research_run_tickers SET company_name = ?, exchange = ?, sec_cik = ?, ir_domain = ?, status = ?, attempt_count = ?, last_error = ?, snapshot_id = ?, ranking_row_id = ?, normalization_json = ?, working_json = ?, stage_metrics_json = ?, started_at = ?, completed_at = ?, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(
    patch.companyName === undefined ? current.companyName : patch.companyName,
    patch.exchange === undefined ? current.exchange : patch.exchange,
    patch.secCik === undefined ? current.secCik : patch.secCik,
    patch.irDomain === undefined ? current.irDomain : patch.irDomain,
    patch.status ?? current.status,
    patch.attemptCount ?? current.attemptCount,
    patch.lastError === undefined ? current.lastError : patch.lastError,
    patch.snapshotId === undefined ? current.snapshotId : patch.snapshotId,
    patch.rankingRowId === undefined ? current.rankingRowId : patch.rankingRowId,
    JSON.stringify(patch.normalizationJson === undefined ? current.normalizationJson : patch.normalizationJson),
    JSON.stringify(patch.workingJson === undefined ? current.workingJson : patch.workingJson),
    JSON.stringify(patch.stageMetricsJson === undefined ? current.stageMetricsJson : patch.stageMetricsJson),
    patch.startedAt === undefined ? current.startedAt : patch.startedAt,
    patch.completedAt === undefined ? current.completedAt : patch.completedAt,
    runTickerId,
  ).run();
}

export async function findFreshEvidenceByCacheKey(env: Env, cacheKey: string, minRetrievedAtIso: string): Promise<ResearchEvidenceRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, provider_key as providerKey, source_kind as sourceKind, scope_kind as scopeKind, ticker, sec_cik as secCik, canonical_url as canonicalUrl, source_domain as sourceDomain, title, published_at as publishedAt, retrieved_at as retrievedAt, content_hash as contentHash, cache_key as cacheKey, artifact_size_bytes as artifactSizeBytes, r2_key as r2Key, snippet_json as snippetJson, metadata_json as metadataJson, provider_payload_json as providerPayloadJson, created_at as createdAt FROM research_evidence WHERE cache_key = ? AND retrieved_at >= ? LIMIT 1",
  ).bind(cacheKey, minRetrievedAtIso).first();
  return row ? mapEvidence(row) : null;
}

export async function insertResearchEvidence(env: Env, input: ResearchEvidenceInput): Promise<ResearchEvidenceRecord> {
  try {
    await env.DB.prepare(
      "INSERT INTO research_evidence (id, provider_key, source_kind, scope_kind, ticker, sec_cik, canonical_url, source_domain, title, published_at, retrieved_at, content_hash, cache_key, artifact_size_bytes, r2_key, snippet_json, metadata_json, provider_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      input.id,
      input.providerKey,
      input.sourceKind,
      input.scopeKind,
      input.ticker,
      input.secCik,
      input.canonicalUrl,
      input.sourceDomain,
      input.title,
      input.publishedAt,
      input.retrievedAt,
      input.contentHash,
      input.cacheKey,
      input.artifactSizeBytes,
      input.r2Key,
      JSON.stringify(input.snippet),
      JSON.stringify(input.metadata),
      JSON.stringify(input.providerPayload),
    ).run();
  } catch {
    // Unique cache-key collision: fall through to load current row.
  }
  const row = await env.DB.prepare(
    "SELECT id, provider_key as providerKey, source_kind as sourceKind, scope_kind as scopeKind, ticker, sec_cik as secCik, canonical_url as canonicalUrl, source_domain as sourceDomain, title, published_at as publishedAt, retrieved_at as retrievedAt, content_hash as contentHash, cache_key as cacheKey, artifact_size_bytes as artifactSizeBytes, r2_key as r2Key, snippet_json as snippetJson, metadata_json as metadataJson, provider_payload_json as providerPayloadJson, created_at as createdAt FROM research_evidence WHERE cache_key = ? LIMIT 1",
  ).bind(input.cacheKey).first();
  if (!row) throw new Error("Failed to persist research evidence.");
  return mapEvidence(row);
}

export async function linkResearchEvidence(env: Env, runId: string, runTickerId: string, evidenceId: string, role: string, sortOrder: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO research_run_evidence (id, run_id, run_ticker_id, evidence_id, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(uid(), runId, runTickerId, evidenceId, role, sortOrder).run();
}

export async function loadRunTickerEvidence(env: Env, runTickerId: string): Promise<ResearchEvidenceRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT e.id, e.provider_key as providerKey, e.source_kind as sourceKind, e.scope_kind as scopeKind, e.ticker, e.sec_cik as secCik, e.canonical_url as canonicalUrl, e.source_domain as sourceDomain, e.title, e.published_at as publishedAt, e.retrieved_at as retrievedAt, e.content_hash as contentHash, e.cache_key as cacheKey, e.artifact_size_bytes as artifactSizeBytes, e.r2_key as r2Key, e.snippet_json as snippetJson, e.metadata_json as metadataJson, e.provider_payload_json as providerPayloadJson, e.created_at as createdAt FROM research_run_evidence rre INNER JOIN research_evidence e ON e.id = rre.evidence_id WHERE rre.run_ticker_id = ? ORDER BY rre.sort_order ASC, e.published_at DESC, e.created_at DESC",
  ).bind(runTickerId).all();
  return (rows.results ?? []).map(mapEvidence);
}

export async function insertResearchSnapshot(env: Env, input: {
  runId: string;
  runTickerId: string;
  ticker: string;
  profileId: string;
  profileVersionId: string;
  previousSnapshotId?: string | null;
  overallScore?: number | null;
  attentionRank?: number | null;
  confidenceLabel?: string | null;
  confidenceScore?: number | null;
  valuationLabel?: string | null;
  earningsQualityLabel?: string | null;
  catalystFreshnessLabel?: string | null;
  riskLabel?: string | null;
  contradictionFlag?: boolean;
  thesisJson: Record<string, unknown>;
  changeJson?: Record<string, unknown> | null;
  citationJson?: Record<string, unknown> | null;
  modelOutputJson?: Record<string, unknown> | null;
}): Promise<ResearchSnapshotRecord> {
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_snapshots (id, run_id, run_ticker_id, ticker, profile_id, profile_version_id, previous_snapshot_id, overall_score, attention_rank, confidence_label, confidence_score, valuation_label, earnings_quality_label, catalyst_freshness_label, risk_label, contradiction_flag, thesis_json, change_json, citation_json, model_output_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    input.runId,
    input.runTickerId,
    input.ticker,
    input.profileId,
    input.profileVersionId,
    input.previousSnapshotId ?? null,
    input.overallScore ?? null,
    input.attentionRank ?? null,
    input.confidenceLabel ?? null,
    input.confidenceScore ?? null,
    input.valuationLabel ?? null,
    input.earningsQualityLabel ?? null,
    input.catalystFreshnessLabel ?? null,
    input.riskLabel ?? null,
    input.contradictionFlag ? 1 : 0,
    JSON.stringify(input.thesisJson),
    JSON.stringify(input.changeJson ?? null),
    JSON.stringify(input.citationJson ?? null),
    JSON.stringify(input.modelOutputJson ?? null),
  ).run();
  const snapshot = await loadResearchSnapshot(env, id);
  if (!snapshot) throw new Error("Failed to load inserted research snapshot.");
  return snapshot;
}

export async function insertResearchFactor(env: Env, input: {
  snapshotId: string;
  ticker: string;
  factorKey: string;
  score: number;
  direction: string;
  confidenceScore?: number | null;
  weightApplied: number;
  explanationJson?: Record<string, unknown> | null;
  supportingEvidenceIds?: string[];
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO research_factors (id, snapshot_id, ticker, factor_key, score, direction, confidence_score, weight_applied, explanation_json, supporting_evidence_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    uid(),
    input.snapshotId,
    input.ticker,
    input.factorKey,
    input.score,
    input.direction,
    input.confidenceScore ?? null,
    input.weightApplied,
    JSON.stringify(input.explanationJson ?? null),
    JSON.stringify(input.supportingEvidenceIds ?? []),
  ).run();
}

export async function insertResearchRanking(env: Env, input: {
  runId: string;
  snapshotId: string;
  ticker: string;
  rank: number;
  attentionScore: number;
  priorityBucket: string;
  deepDiveRequested: boolean;
  deepDiveCompleted: boolean;
  rankingJson?: Record<string, unknown> | null;
}): Promise<ResearchRankingRecord> {
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_rankings (id, run_id, snapshot_id, ticker, rank, attention_score, priority_bucket, deep_dive_requested, deep_dive_completed, ranking_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    input.runId,
    input.snapshotId,
    input.ticker,
    input.rank,
    input.attentionScore,
    input.priorityBucket,
    input.deepDiveRequested ? 1 : 0,
    input.deepDiveCompleted ? 1 : 0,
    JSON.stringify(input.rankingJson ?? null),
  ).run();
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, snapshot_id as snapshotId, ticker, rank, attention_score as attentionScore, priority_bucket as priorityBucket, deep_dive_requested as deepDiveRequested, deep_dive_completed as deepDiveCompleted, ranking_json as rankingJson, created_at as createdAt FROM research_rankings WHERE id = ? LIMIT 1",
  ).bind(id).first();
  if (!row) throw new Error("Failed to load inserted ranking.");
  return mapRanking(row);
}

export async function upsertTickerResearchHead(env: Env, ticker: string, profileId: string, snapshotId: string, runId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ticker_research_heads (ticker, profile_id, latest_snapshot_id, latest_run_id, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(ticker, profile_id) DO UPDATE SET latest_snapshot_id = excluded.latest_snapshot_id, latest_run_id = excluded.latest_run_id, updated_at = CURRENT_TIMESTAMP",
  ).bind(ticker, profileId, snapshotId, runId).run();
}

export async function loadResearchSnapshot(env: Env, snapshotId: string): Promise<ResearchSnapshotRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, run_ticker_id as runTickerId, ticker, profile_id as profileId, profile_version_id as profileVersionId, previous_snapshot_id as previousSnapshotId, schema_version as schemaVersion, overall_score as overallScore, attention_rank as attentionRank, confidence_label as confidenceLabel, confidence_score as confidenceScore, valuation_label as valuationLabel, earnings_quality_label as earningsQualityLabel, catalyst_freshness_label as catalystFreshnessLabel, risk_label as riskLabel, contradiction_flag as contradictionFlag, thesis_json as thesisJson, change_json as changeJson, citation_json as citationJson, model_output_json as modelOutputJson, created_at as createdAt FROM research_snapshots WHERE id = ? LIMIT 1",
  ).bind(snapshotId).first();
  return row ? mapSnapshot(row) : null;
}

export async function loadResearchSnapshotFactors(env: Env, snapshotId: string): Promise<ResearchFactorRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, snapshot_id as snapshotId, ticker, factor_key as factorKey, score, direction, confidence_score as confidenceScore, weight_applied as weightApplied, explanation_json as explanationJson, supporting_evidence_ids_json as supportingEvidenceIdsJson, created_at as createdAt FROM research_factors WHERE snapshot_id = ? ORDER BY factor_key ASC",
  ).bind(snapshotId).all();
  return (rows.results ?? []).map(mapFactor);
}

export async function loadResearchSnapshotEvidence(env: Env, snapshotId: string): Promise<ResearchEvidenceRecord[]> {
  const snapshot = await loadResearchSnapshot(env, snapshotId);
  if (!snapshot) return [];
  return loadRunTickerEvidence(env, snapshot.runTickerId);
}

export async function loadTickerResearchHistory(env: Env, ticker: string, profileId?: string | null, limit = 12): Promise<ResearchSnapshotRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id, run_id as runId, run_ticker_id as runTickerId, ticker, profile_id as profileId, profile_version_id as profileVersionId, previous_snapshot_id as previousSnapshotId, schema_version as schemaVersion, overall_score as overallScore, attention_rank as attentionRank, confidence_label as confidenceLabel, confidence_score as confidenceScore, valuation_label as valuationLabel, earnings_quality_label as earningsQualityLabel, catalyst_freshness_label as catalystFreshnessLabel, risk_label as riskLabel, contradiction_flag as contradictionFlag, thesis_json as thesisJson, change_json as changeJson, citation_json as citationJson, model_output_json as modelOutputJson, created_at as createdAt FROM research_snapshots WHERE ticker = ? ${profileId ? "AND profile_id = ?" : ""} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 25))}`,
  ).bind(...(profileId ? [ticker.toUpperCase(), profileId] : [ticker.toUpperCase()])).all();
  return (rows.results ?? []).map(mapSnapshot);
}

export async function loadRunRankings(env: Env, runId: string): Promise<ResearchRankingRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, snapshot_id as snapshotId, ticker, rank, attention_score as attentionScore, priority_bucket as priorityBucket, deep_dive_requested as deepDiveRequested, deep_dive_completed as deepDiveCompleted, ranking_json as rankingJson, created_at as createdAt FROM research_rankings WHERE run_id = ? ORDER BY rank ASC",
  ).bind(runId).all();
  return (rows.results ?? []).map(mapRanking);
}

export async function countRunTickerStatuses(env: Env, runId: string): Promise<{ completed: number; failed: number; rankingReady: number; queued: number; inProgress: number }> {
  const rows = await env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM research_run_tickers WHERE run_id = ? GROUP BY status",
  ).bind(runId).all<{ status: string; count: number }>();
  const counts = { completed: 0, failed: 0, rankingReady: 0, queued: 0, inProgress: 0 };
  for (const row of rows.results ?? []) {
    if (row.status === "completed") counts.completed = Number(row.count ?? 0);
    if (row.status === "failed") counts.failed = Number(row.count ?? 0);
    if (row.status === "ranking_ready") counts.rankingReady = Number(row.count ?? 0);
    if (row.status === "queued") counts.queued = Number(row.count ?? 0);
    if (row.status === "normalizing" || row.status === "retrieving" || row.status === "extracting") {
      counts.inProgress += Number(row.count ?? 0);
    }
  }
  return counts;
}

export async function listQueuedResearchRuns(env: Env, limit = 3): Promise<ResearchRunRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id, source_type as sourceType, source_id as sourceId, source_label as sourceLabel, status, profile_id as profileId, profile_version_id as profileVersionId, requested_ticker_count as requestedTickerCount, completed_ticker_count as completedTickerCount, failed_ticker_count as failedTickerCount, deep_dive_top_n as deepDiveTopN, refresh_mode as refreshMode, ranking_mode as rankingMode, input_json as inputJson, provider_usage_json as providerUsageJson, provenance_json as provenanceJson, error_summary as errorSummary, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(limit, 10))}`,
  ).all();
  return (rows.results ?? []).map(mapRun);
}
