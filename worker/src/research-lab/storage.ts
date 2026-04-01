import type { Env } from "../types";
import {
  RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID,
  RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID,
} from "./constants";
import type {
  ResearchLabEvidenceProfileRecord,
  ResearchLabEvidenceRecord,
  ResearchLabMemoryHeadRecord,
  ResearchLabOutputRecord,
  ResearchLabPromptConfigRecord,
  ResearchLabRunCreateRequest,
  ResearchLabRunEventRecord,
  ResearchLabRunItemRecord,
  ResearchLabRunListRow,
  ResearchLabRunRecord,
  ResearchLabSourceType,
  ResearchLabTickerHistoryEntry,
} from "./types";

function uid() {
  return crypto.randomUUID();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapPromptConfig(row: Record<string, unknown>): ResearchLabPromptConfigRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: typeof row.description === "string" ? row.description : null,
    configFamily: String(row.configFamily ?? ""),
    modelFamily: String(row.modelFamily ?? ""),
    systemPrompt: String(row.systemPrompt ?? ""),
    schemaVersion: String(row.schemaVersion ?? ""),
    isDefault: Boolean(row.isDefault),
    synthesisConfigJson: parseJson(row.synthesisConfigJson, {}),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapEvidenceProfile(row: Record<string, unknown>): ResearchLabEvidenceProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: typeof row.description === "string" ? row.description : null,
    configFamily: String(row.configFamily ?? ""),
    isDefault: Boolean(row.isDefault),
    queryConfigJson: parseJson(row.queryConfigJson, {}),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapRun(row: Record<string, unknown>): ResearchLabRunRecord {
  return {
    id: String(row.id),
    sourceType: String(row.sourceType ?? "manual") as ResearchLabSourceType,
    sourceId: typeof row.sourceId === "string" ? row.sourceId : null,
    sourceLabel: typeof row.sourceLabel === "string" ? row.sourceLabel : null,
    promptConfigId: typeof row.promptConfigId === "string" ? row.promptConfigId : null,
    evidenceProfileId: typeof row.evidenceProfileId === "string" ? row.evidenceProfileId : null,
    status: String(row.status ?? "queued") as ResearchLabRunRecord["status"],
    requestedTickerCount: Number(row.requestedTickerCount ?? 0),
    completedTickerCount: Number(row.completedTickerCount ?? 0),
    failedTickerCount: Number(row.failedTickerCount ?? 0),
    inputJson: parseJson(row.inputJson, null),
    providerUsageJson: parseJson(row.providerUsageJson, null),
    metadataJson: parseJson(row.metadataJson, null),
    errorSummary: typeof row.errorSummary === "string" ? row.errorSummary : null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
    heartbeatAt: typeof row.heartbeatAt === "string" ? row.heartbeatAt : null,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapRunItem(row: Record<string, unknown>): ResearchLabRunItemRecord {
  return {
    id: String(row.id),
    runId: String(row.runId ?? ""),
    ticker: String(row.ticker ?? ""),
    sortOrder: Number(row.sortOrder ?? 0),
    companyName: typeof row.companyName === "string" ? row.companyName : null,
    exchange: typeof row.exchange === "string" ? row.exchange : null,
    secCik: typeof row.secCik === "string" ? row.secCik : null,
    irDomain: typeof row.irDomain === "string" ? row.irDomain : null,
    status: String(row.status ?? "queued") as ResearchLabRunItemRecord["status"],
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    memoryOutputId: typeof row.memoryOutputId === "string" ? row.memoryOutputId : null,
    gatherProviderKey: typeof row.gatherProviderKey === "string" ? row.gatherProviderKey : null,
    gatherModel: typeof row.gatherModel === "string" ? row.gatherModel : null,
    gatherUsageJson: parseJson(row.gatherUsageJson, null),
    gatherLatencyMs: row.gatherLatencyMs == null ? null : Number(row.gatherLatencyMs),
    synthProviderKey: typeof row.synthProviderKey === "string" ? row.synthProviderKey : null,
    synthModel: typeof row.synthModel === "string" ? row.synthModel : null,
    synthUsageJson: parseJson(row.synthUsageJson, null),
    synthLatencyMs: row.synthLatencyMs == null ? null : Number(row.synthLatencyMs),
    metadataJson: parseJson(row.metadataJson, null),
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
    heartbeatAt: typeof row.heartbeatAt === "string" ? row.heartbeatAt : null,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapEvent(row: Record<string, unknown>): ResearchLabRunEventRecord {
  return {
    id: String(row.id),
    runId: String(row.runId ?? ""),
    runItemId: typeof row.runItemId === "string" ? row.runItemId : null,
    ticker: typeof row.ticker === "string" ? row.ticker : null,
    eventType: String(row.eventType ?? "run_created") as ResearchLabRunEventRecord["eventType"],
    level: String(row.level ?? "info") as ResearchLabRunEventRecord["level"],
    message: String(row.message ?? ""),
    contextJson: parseJson(row.contextJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapEvidence(row: Record<string, unknown>): ResearchLabEvidenceRecord {
  return {
    id: String(row.id),
    runId: String(row.runId ?? ""),
    runItemId: String(row.runItemId ?? ""),
    ticker: String(row.ticker ?? ""),
    providerKey: String(row.providerKey ?? "perplexity") as ResearchLabEvidenceRecord["providerKey"],
    evidenceKind: String(row.evidenceKind ?? "news_catalysts") as ResearchLabEvidenceRecord["evidenceKind"],
    queryLabel: String(row.queryLabel ?? ""),
    canonicalUrl: typeof row.canonicalUrl === "string" ? row.canonicalUrl : null,
    sourceDomain: typeof row.sourceDomain === "string" ? row.sourceDomain : null,
    title: String(row.title ?? ""),
    publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : null,
    summary: String(row.summary ?? ""),
    excerpt: typeof row.excerpt === "string" ? row.excerpt : null,
    bullets: parseJson<string[]>(row.bulletsJson, []),
    contentHash: String(row.contentHash ?? ""),
    providerPayloadJson: parseJson(row.providerPayloadJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapOutput(row: Record<string, unknown>): ResearchLabOutputRecord {
  return {
    id: String(row.id),
    runId: String(row.runId ?? ""),
    runItemId: String(row.runItemId ?? ""),
    ticker: String(row.ticker ?? ""),
    promptConfigId: typeof row.promptConfigId === "string" ? row.promptConfigId : null,
    evidenceProfileId: typeof row.evidenceProfileId === "string" ? row.evidenceProfileId : null,
    priorOutputId: typeof row.priorOutputId === "string" ? row.priorOutputId : null,
    synthesisJson: parseJson(row.synthesisJson, null) as ResearchLabOutputRecord["synthesisJson"],
    memorySummaryJson: parseJson(row.memorySummaryJson, null) as ResearchLabOutputRecord["memorySummaryJson"],
    deltaJson: parseJson(row.deltaJson, null),
    sourceEvidenceIds: parseJson<string[]>(row.sourceEvidenceIdsJson, []),
    model: String(row.model ?? ""),
    usageJson: parseJson(row.usageJson, null),
    createdAt: String(row.createdAt ?? ""),
  };
}

export async function loadResearchLabPromptConfig(env: Env, id?: string | null): Promise<ResearchLabPromptConfigRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, description, config_family as configFamily, model_family as modelFamily, system_prompt as systemPrompt, schema_version as schemaVersion, is_default as isDefault, synthesis_config_json as synthesisConfigJson, created_at as createdAt, updated_at as updatedAt FROM research_lab_prompt_configs WHERE id = ? LIMIT 1",
  ).bind(id ?? RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID).first<Record<string, unknown>>();
  return row ? mapPromptConfig(row) : null;
}

export async function loadDefaultResearchLabPromptConfig(env: Env): Promise<ResearchLabPromptConfigRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, description, config_family as configFamily, model_family as modelFamily, system_prompt as systemPrompt, schema_version as schemaVersion, is_default as isDefault, synthesis_config_json as synthesisConfigJson, created_at as createdAt, updated_at as updatedAt FROM research_lab_prompt_configs WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1",
  ).first<Record<string, unknown>>();
  return row ? mapPromptConfig(row) : null;
}

export async function loadResearchLabEvidenceProfile(env: Env, id?: string | null): Promise<ResearchLabEvidenceProfileRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, description, config_family as configFamily, is_default as isDefault, query_config_json as queryConfigJson, created_at as createdAt, updated_at as updatedAt FROM research_lab_evidence_profiles WHERE id = ? LIMIT 1",
  ).bind(id ?? RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID).first<Record<string, unknown>>();
  return row ? mapEvidenceProfile(row) : null;
}

export async function loadDefaultResearchLabEvidenceProfile(env: Env): Promise<ResearchLabEvidenceProfileRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, description, config_family as configFamily, is_default as isDefault, query_config_json as queryConfigJson, created_at as createdAt, updated_at as updatedAt FROM research_lab_evidence_profiles WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1",
  ).first<Record<string, unknown>>();
  return row ? mapEvidenceProfile(row) : null;
}

export async function createResearchLabRun(env: Env, input: {
  request: ResearchLabRunCreateRequest;
  tickers: string[];
  sourceType?: ResearchLabSourceType;
  sourceId?: string | null;
  sourceLabel?: string | null;
  promptConfigId: string | null;
  evidenceProfileId: string | null;
}): Promise<ResearchLabRunRecord> {
  const runId = uid();
  const statements = [
    env.DB.prepare(
      "INSERT INTO research_lab_runs (id, source_type, source_id, source_label, prompt_config_id, evidence_profile_id, status, requested_ticker_count, completed_ticker_count, failed_ticker_count, input_json, provider_usage_json, metadata_json, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?, NULL, NULL, CURRENT_TIMESTAMP)",
    ).bind(
      runId,
      input.sourceType ?? "manual",
      input.sourceId ?? null,
      input.sourceLabel ?? "Research Lab",
      input.promptConfigId,
      input.evidenceProfileId,
      input.tickers.length,
      JSON.stringify(input.request),
    ),
    ...input.tickers.map((ticker, index) => env.DB.prepare(
      "INSERT INTO research_lab_run_items (id, run_id, ticker, sort_order, status) VALUES (?, ?, ?, ?, 'queued')",
    ).bind(uid(), runId, ticker, index + 1)),
  ];
  await env.DB.batch(statements);
  const run = await loadResearchLabRun(env, runId);
  if (!run) throw new Error("Failed to load created research lab run.");
  return run;
}

export async function listResearchLabRuns(env: Env, limit = 10): Promise<ResearchLabRunListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.source_type as sourceType, r.source_id as sourceId, r.source_label as sourceLabel, r.prompt_config_id as promptConfigId, r.evidence_profile_id as evidenceProfileId, r.status, r.requested_ticker_count as requestedTickerCount, r.completed_ticker_count as completedTickerCount, r.failed_ticker_count as failedTickerCount, r.input_json as inputJson, r.provider_usage_json as providerUsageJson, r.metadata_json as metadataJson, r.error_summary as errorSummary, r.started_at as startedAt, r.completed_at as completedAt, r.heartbeat_at as heartbeatAt, r.created_at as createdAt, r.updated_at as updatedAt, pc.name as promptConfigName, ep.name as evidenceProfileName FROM research_lab_runs r LEFT JOIN research_lab_prompt_configs pc ON pc.id = r.prompt_config_id LEFT JOIN research_lab_evidence_profiles ep ON ep.id = r.evidence_profile_id ORDER BY r.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 25))}`,
  ).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    run: mapRun(row),
    promptConfigName: typeof row.promptConfigName === "string" ? row.promptConfigName : null,
    evidenceProfileName: typeof row.evidenceProfileName === "string" ? row.evidenceProfileName : null,
  }));
}

export async function loadResearchLabRun(env: Env, runId: string): Promise<ResearchLabRunRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, source_type as sourceType, source_id as sourceId, source_label as sourceLabel, prompt_config_id as promptConfigId, evidence_profile_id as evidenceProfileId, status, requested_ticker_count as requestedTickerCount, completed_ticker_count as completedTickerCount, failed_ticker_count as failedTickerCount, input_json as inputJson, provider_usage_json as providerUsageJson, metadata_json as metadataJson, error_summary as errorSummary, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_lab_runs WHERE id = ? LIMIT 1",
  ).bind(runId).first<Record<string, unknown>>();
  return row ? mapRun(row) : null;
}

export async function loadResearchLabRunItems(env: Env, runId: string): Promise<ResearchLabRunItemRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, last_error as lastError, memory_output_id as memoryOutputId, gather_provider_key as gatherProviderKey, gather_model as gatherModel, gather_usage_json as gatherUsageJson, gather_latency_ms as gatherLatencyMs, synth_provider_key as synthProviderKey, synth_model as synthModel, synth_usage_json as synthUsageJson, synth_latency_ms as synthLatencyMs, metadata_json as metadataJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_lab_run_items WHERE run_id = ? ORDER BY sort_order ASC",
  ).bind(runId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapRunItem);
}

export async function loadResearchLabRunEvents(env: Env, runId: string, limit = 100): Promise<ResearchLabRunEventRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id, run_id as runId, run_item_id as runItemId, ticker, event_type as eventType, level, message, context_json as contextJson, created_at as createdAt FROM research_lab_run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  ).bind(runId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapEvent);
}

export async function loadResearchLabEvidenceForRunItem(env: Env, runItemId: string): Promise<ResearchLabEvidenceRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, provider_key as providerKey, evidence_kind as evidenceKind, query_label as queryLabel, canonical_url as canonicalUrl, source_domain as sourceDomain, title, published_at as publishedAt, summary, excerpt, bullets_json as bulletsJson, content_hash as contentHash, provider_payload_json as providerPayloadJson, created_at as createdAt FROM research_lab_evidence WHERE run_item_id = ? ORDER BY created_at ASC",
  ).bind(runItemId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapEvidence);
}

export async function loadResearchLabEvidenceForRun(env: Env, runId: string): Promise<ResearchLabEvidenceRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, provider_key as providerKey, evidence_kind as evidenceKind, query_label as queryLabel, canonical_url as canonicalUrl, source_domain as sourceDomain, title, published_at as publishedAt, summary, excerpt, bullets_json as bulletsJson, content_hash as contentHash, provider_payload_json as providerPayloadJson, created_at as createdAt FROM research_lab_evidence WHERE run_id = ? ORDER BY created_at ASC",
  ).bind(runId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapEvidence);
}

export async function loadResearchLabOutputsForRun(env: Env, runId: string): Promise<ResearchLabOutputRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, prompt_config_id as promptConfigId, evidence_profile_id as evidenceProfileId, prior_output_id as priorOutputId, synthesis_json as synthesisJson, memory_summary_json as memorySummaryJson, delta_json as deltaJson, source_evidence_ids_json as sourceEvidenceIdsJson, model, usage_json as usageJson, created_at as createdAt FROM research_lab_outputs WHERE run_id = ? ORDER BY created_at ASC",
  ).bind(runId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapOutput);
}

export async function loadResearchLabOutputForRunItem(env: Env, runItemId: string): Promise<ResearchLabOutputRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, prompt_config_id as promptConfigId, evidence_profile_id as evidenceProfileId, prior_output_id as priorOutputId, synthesis_json as synthesisJson, memory_summary_json as memorySummaryJson, delta_json as deltaJson, source_evidence_ids_json as sourceEvidenceIdsJson, model, usage_json as usageJson, created_at as createdAt FROM research_lab_outputs WHERE run_item_id = ? LIMIT 1",
  ).bind(runItemId).first<Record<string, unknown>>();
  return row ? mapOutput(row) : null;
}

export async function loadLatestResearchLabOutputForTicker(
  env: Env,
  ticker: string,
  promptConfigFamily: string,
): Promise<ResearchLabOutputRecord | null> {
  const row = await env.DB.prepare(
    "SELECT o.id, o.run_id as runId, o.run_item_id as runItemId, o.ticker, o.prompt_config_id as promptConfigId, o.evidence_profile_id as evidenceProfileId, o.prior_output_id as priorOutputId, o.synthesis_json as synthesisJson, o.memory_summary_json as memorySummaryJson, o.delta_json as deltaJson, o.source_evidence_ids_json as sourceEvidenceIdsJson, o.model, o.usage_json as usageJson, o.created_at as createdAt FROM research_lab_memory_heads h INNER JOIN research_lab_outputs o ON o.id = h.latest_output_id WHERE h.ticker = ? AND h.prompt_config_family = ? LIMIT 1",
  ).bind(ticker.toUpperCase(), promptConfigFamily).first<Record<string, unknown>>();
  return row ? mapOutput(row) : null;
}

export async function loadResearchLabTickerHistory(env: Env, ticker: string, limit = 12): Promise<ResearchLabTickerHistoryEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.run_id as runId, o.run_item_id as runItemId, o.ticker, o.prompt_config_id as promptConfigId, o.evidence_profile_id as evidenceProfileId, o.prior_output_id as priorOutputId, o.synthesis_json as synthesisJson, o.memory_summary_json as memorySummaryJson, o.delta_json as deltaJson, o.source_evidence_ids_json as sourceEvidenceIdsJson, o.model, o.usage_json as usageJson, o.created_at as createdAt, r.id as runRowId, r.source_type as sourceType, r.source_id as sourceId, r.source_label as sourceLabel, r.prompt_config_id as runPromptConfigId, r.evidence_profile_id as runEvidenceProfileId, r.status as runStatus, r.requested_ticker_count as requestedTickerCount, r.completed_ticker_count as completedTickerCount, r.failed_ticker_count as failedTickerCount, r.input_json as inputJson, r.provider_usage_json as providerUsageJson, r.metadata_json as metadataJson, r.error_summary as errorSummary, r.started_at as startedAt, r.completed_at as completedAt, r.heartbeat_at as heartbeatAt, r.created_at as runCreatedAt, r.updated_at as runUpdatedAt FROM research_lab_outputs o LEFT JOIN research_lab_runs r ON r.id = o.run_id WHERE o.ticker = ? ORDER BY o.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 25))}`,
  ).bind(ticker.toUpperCase()).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    output: mapOutput(row),
    run: row.runRowId ? mapRun({
      id: row.runRowId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceLabel: row.sourceLabel,
      promptConfigId: row.runPromptConfigId,
      evidenceProfileId: row.runEvidenceProfileId,
      status: row.runStatus,
      requestedTickerCount: row.requestedTickerCount,
      completedTickerCount: row.completedTickerCount,
      failedTickerCount: row.failedTickerCount,
      inputJson: row.inputJson,
      providerUsageJson: row.providerUsageJson,
      metadataJson: row.metadataJson,
      errorSummary: row.errorSummary,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      heartbeatAt: row.heartbeatAt,
      createdAt: row.runCreatedAt,
      updatedAt: row.runUpdatedAt,
    }) : null,
  }));
}

export async function updateResearchLabRun(env: Env, runId: string, patch: Partial<{
  status: ResearchLabRunRecord["status"];
  completedTickerCount: number;
  failedTickerCount: number;
  providerUsageJson: Record<string, unknown> | null;
  metadataJson: Record<string, unknown> | null;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
}>): Promise<ResearchLabRunRecord | null> {
  const current = await loadResearchLabRun(env, runId);
  if (!current) return null;
  await env.DB.prepare(
    "UPDATE research_lab_runs SET status = ?, completed_ticker_count = ?, failed_ticker_count = ?, provider_usage_json = ?, metadata_json = ?, error_summary = ?, started_at = ?, completed_at = ?, heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(
    patch.status ?? current.status,
    patch.completedTickerCount ?? current.completedTickerCount,
    patch.failedTickerCount ?? current.failedTickerCount,
    JSON.stringify(patch.providerUsageJson ?? current.providerUsageJson ?? null),
    JSON.stringify(patch.metadataJson ?? current.metadataJson ?? null),
    patch.errorSummary ?? current.errorSummary,
    patch.startedAt ?? current.startedAt,
    patch.completedAt ?? current.completedAt,
    patch.heartbeatAt ?? current.heartbeatAt ?? new Date().toISOString(),
    runId,
  ).run();
  return loadResearchLabRun(env, runId);
}

export async function updateResearchLabRunHeartbeat(env: Env, runId: string, heartbeatAt = new Date().toISOString()) {
  await env.DB.prepare(
    "UPDATE research_lab_runs SET heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(heartbeatAt, runId).run();
}

export async function updateResearchLabRunItemHeartbeat(env: Env, runItemId: string, heartbeatAt = new Date().toISOString()) {
  await env.DB.prepare(
    "UPDATE research_lab_run_items SET heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(heartbeatAt, runItemId).run();
}

export async function cancelResearchLabRun(env: Env, runId: string): Promise<ResearchLabRunRecord | null> {
  const current = await loadResearchLabRun(env, runId);
  if (!current) return null;
  if (current.status === "completed" || current.status === "partial" || current.status === "failed" || current.status === "cancelled") {
    return current;
  }
  const cancelledAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE research_lab_run_items SET status = 'failed', last_error = COALESCE(last_error, ?), completed_at = COALESCE(completed_at, ?), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status IN ('queued', 'memory_loading', 'gathering', 'gathering_failed', 'synthesizing', 'synthesizing_failed', 'persisting')",
    ).bind("Cancelled by user.", cancelledAt, runId),
    env.DB.prepare(
      "UPDATE research_lab_runs SET status = 'cancelled', error_summary = COALESCE(error_summary, ?), completed_at = COALESCE(completed_at, ?), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind("Cancelled by user.", cancelledAt, runId),
  ]);
  const items = await loadResearchLabRunItems(env, runId);
  await env.DB.prepare(
    "UPDATE research_lab_runs SET completed_ticker_count = ?, failed_ticker_count = ? WHERE id = ?",
  ).bind(
    items.filter((item) => item.status === "completed").length,
    items.filter((item) => item.status === "failed").length,
    runId,
  ).run();
  return loadResearchLabRun(env, runId);
}

export async function tryAcquireResearchLabRunExecution(
  env: Env,
  runId: string,
  executionToken: string,
  staleBeforeIso: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE research_lab_runs
     SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.executionToken', ?, '$.executionAcquiredAt', CURRENT_TIMESTAMP),
         heartbeat_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status IN ('queued', 'running')
       AND (
         json_extract(COALESCE(metadata_json, '{}'), '$.executionToken') IS NULL
         OR heartbeat_at IS NULL
         OR datetime(heartbeat_at) <= datetime(?)
       )`,
  ).bind(executionToken, runId, staleBeforeIso).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function claimNextQueuedResearchLabRunItem(env: Env, runId: string): Promise<ResearchLabRunItemRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM research_lab_run_items WHERE run_id = ? AND status = 'queued' ORDER BY sort_order ASC LIMIT 1",
  ).bind(runId).first<{ id: string }>();
  if (!row?.id) return null;
  await env.DB.prepare(
    "UPDATE research_lab_run_items SET status = 'memory_loading', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'",
  ).bind(row.id).run();
  const items = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, last_error as lastError, memory_output_id as memoryOutputId, gather_provider_key as gatherProviderKey, gather_model as gatherModel, gather_usage_json as gatherUsageJson, gather_latency_ms as gatherLatencyMs, synth_provider_key as synthProviderKey, synth_model as synthModel, synth_usage_json as synthUsageJson, synth_latency_ms as synthLatencyMs, metadata_json as metadataJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_lab_run_items WHERE id = ? LIMIT 1",
  ).bind(row.id).all<Record<string, unknown>>();
  return items.results?.[0] ? mapRunItem(items.results[0]) : null;
}

export async function updateResearchLabRunItem(env: Env, runItemId: string, patch: Partial<{
  ticker: string;
  companyName: string | null;
  exchange: string | null;
  secCik: string | null;
  irDomain: string | null;
  status: ResearchLabRunItemRecord["status"];
  lastError: string | null;
  memoryOutputId: string | null;
  gatherProviderKey: string | null;
  gatherModel: string | null;
  gatherUsageJson: Record<string, unknown> | null;
  gatherLatencyMs: number | null;
  synthProviderKey: string | null;
  synthModel: string | null;
  synthUsageJson: Record<string, unknown> | null;
  synthLatencyMs: number | null;
  metadataJson: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
}>): Promise<ResearchLabRunItemRecord | null> {
  const currentRows = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, last_error as lastError, memory_output_id as memoryOutputId, gather_provider_key as gatherProviderKey, gather_model as gatherModel, gather_usage_json as gatherUsageJson, gather_latency_ms as gatherLatencyMs, synth_provider_key as synthProviderKey, synth_model as synthModel, synth_usage_json as synthUsageJson, synth_latency_ms as synthLatencyMs, metadata_json as metadataJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_lab_run_items WHERE id = ? LIMIT 1",
  ).bind(runItemId).all<Record<string, unknown>>();
  const current = currentRows.results?.[0] ? mapRunItem(currentRows.results[0]) : null;
  if (!current) return null;
  await env.DB.prepare(
    "UPDATE research_lab_run_items SET ticker = ?, company_name = ?, exchange = ?, sec_cik = ?, ir_domain = ?, status = ?, last_error = ?, memory_output_id = ?, gather_provider_key = ?, gather_model = ?, gather_usage_json = ?, gather_latency_ms = ?, synth_provider_key = ?, synth_model = ?, synth_usage_json = ?, synth_latency_ms = ?, metadata_json = ?, started_at = ?, completed_at = ?, heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(
    patch.ticker ?? current.ticker,
    patch.companyName ?? current.companyName,
    patch.exchange ?? current.exchange,
    patch.secCik ?? current.secCik,
    patch.irDomain ?? current.irDomain,
    patch.status ?? current.status,
    patch.lastError ?? current.lastError,
    patch.memoryOutputId ?? current.memoryOutputId,
    patch.gatherProviderKey ?? current.gatherProviderKey,
    patch.gatherModel ?? current.gatherModel,
    JSON.stringify(patch.gatherUsageJson ?? current.gatherUsageJson ?? null),
    patch.gatherLatencyMs ?? current.gatherLatencyMs,
    patch.synthProviderKey ?? current.synthProviderKey,
    patch.synthModel ?? current.synthModel,
    JSON.stringify(patch.synthUsageJson ?? current.synthUsageJson ?? null),
    patch.synthLatencyMs ?? current.synthLatencyMs,
    JSON.stringify(patch.metadataJson ?? current.metadataJson ?? null),
    patch.startedAt ?? current.startedAt,
    patch.completedAt ?? current.completedAt,
    patch.heartbeatAt ?? current.heartbeatAt ?? new Date().toISOString(),
    runItemId,
  ).run();
  const updatedRows = await env.DB.prepare(
    "SELECT id, run_id as runId, ticker, sort_order as sortOrder, company_name as companyName, exchange, sec_cik as secCik, ir_domain as irDomain, status, last_error as lastError, memory_output_id as memoryOutputId, gather_provider_key as gatherProviderKey, gather_model as gatherModel, gather_usage_json as gatherUsageJson, gather_latency_ms as gatherLatencyMs, synth_provider_key as synthProviderKey, synth_model as synthModel, synth_usage_json as synthUsageJson, synth_latency_ms as synthLatencyMs, metadata_json as metadataJson, started_at as startedAt, completed_at as completedAt, heartbeat_at as heartbeatAt, created_at as createdAt, updated_at as updatedAt FROM research_lab_run_items WHERE id = ? LIMIT 1",
  ).bind(runItemId).all<Record<string, unknown>>();
  return updatedRows.results?.[0] ? mapRunItem(updatedRows.results[0]) : null;
}

export async function insertResearchLabRunEvent(env: Env, input: {
  runId: string;
  runItemId?: string | null;
  ticker?: string | null;
  eventType: ResearchLabRunEventRecord["eventType"];
  level: ResearchLabRunEventRecord["level"];
  message: string;
  contextJson?: Record<string, unknown> | null;
}): Promise<ResearchLabRunEventRecord> {
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_lab_run_events (id, run_id, run_item_id, ticker, event_type, level, message, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    input.runId,
    input.runItemId ?? null,
    input.ticker ?? null,
    input.eventType,
    input.level,
    input.message,
    JSON.stringify(input.contextJson ?? null),
  ).run();
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, event_type as eventType, level, message, context_json as contextJson, created_at as createdAt FROM research_lab_run_events WHERE id = ? LIMIT 1",
  ).bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error("Failed to load inserted research lab event.");
  return mapEvent(row);
}

export async function insertResearchLabEvidence(env: Env, evidence: ResearchLabEvidenceRecord[]): Promise<void> {
  if (evidence.length === 0) return;
  await env.DB.batch(evidence.map((record) => env.DB.prepare(
    "INSERT INTO research_lab_evidence (id, run_id, run_item_id, ticker, provider_key, evidence_kind, query_label, canonical_url, source_domain, title, published_at, summary, excerpt, bullets_json, content_hash, provider_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    record.id,
    record.runId,
    record.runItemId,
    record.ticker,
    record.providerKey,
    record.evidenceKind,
    record.queryLabel,
    record.canonicalUrl,
    record.sourceDomain,
    record.title,
    record.publishedAt,
    record.summary,
    record.excerpt,
    JSON.stringify(record.bullets),
    record.contentHash,
    JSON.stringify(record.providerPayloadJson ?? null),
  )));
}

export async function insertResearchLabOutput(env: Env, input: {
  runId: string;
  runItemId: string;
  ticker: string;
  promptConfigId: string | null;
  evidenceProfileId: string | null;
  priorOutputId: string | null;
  synthesisJson: ResearchLabOutputRecord["synthesisJson"];
  memorySummaryJson: ResearchLabOutputRecord["memorySummaryJson"];
  deltaJson: ResearchLabOutputRecord["deltaJson"];
  sourceEvidenceIds: string[];
  model: string;
  usageJson: Record<string, unknown> | null;
}): Promise<ResearchLabOutputRecord> {
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_lab_outputs (id, run_id, run_item_id, ticker, prompt_config_id, evidence_profile_id, prior_output_id, synthesis_json, memory_summary_json, delta_json, source_evidence_ids_json, model, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    input.runId,
    input.runItemId,
    input.ticker,
    input.promptConfigId,
    input.evidenceProfileId,
    input.priorOutputId,
    JSON.stringify(input.synthesisJson),
    JSON.stringify(input.memorySummaryJson),
    JSON.stringify(input.deltaJson ?? null),
    JSON.stringify(input.sourceEvidenceIds),
    input.model,
    JSON.stringify(input.usageJson ?? null),
  ).run();
  const row = await env.DB.prepare(
    "SELECT id, run_id as runId, run_item_id as runItemId, ticker, prompt_config_id as promptConfigId, evidence_profile_id as evidenceProfileId, prior_output_id as priorOutputId, synthesis_json as synthesisJson, memory_summary_json as memorySummaryJson, delta_json as deltaJson, source_evidence_ids_json as sourceEvidenceIdsJson, model, usage_json as usageJson, created_at as createdAt FROM research_lab_outputs WHERE id = ? LIMIT 1",
  ).bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error("Failed to load inserted research lab output.");
  return mapOutput(row);
}

export async function upsertResearchLabMemoryHead(env: Env, head: ResearchLabMemoryHeadRecord): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO research_lab_memory_heads (ticker, prompt_config_family, latest_output_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(ticker, prompt_config_family) DO UPDATE SET latest_output_id = excluded.latest_output_id, updated_at = CURRENT_TIMESTAMP",
  ).bind(head.ticker.toUpperCase(), head.promptConfigFamily, head.latestOutputId).run();
}
