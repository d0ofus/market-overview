import type { Env } from "./types";
import {
  signHermesGenericWebhook,
  signWatchlistReviewWebhook,
  WatchlistReviewSchemaMissingError,
} from "./watchlist-review-service";
import {
  type WatchlistReviewPrepSummary,
} from "./watchlist-review-prep-service";

export type WatchlistReviewAnalysisDispatchStatus =
  | "queued"
  | "dispatching"
  | "waiting_for_hermes"
  | "webhook_failed"
  | "claimed"
  | "running"
  | "completed"
  | "partial_failed"
  | "failed"
  | "cancelled";

export type WatchlistReviewAnalysisWebhookStatus = "sent" | "not_configured" | "failed" | "already_pending";

export type WatchlistReviewAnalysisWebhookResult = {
  attempted: boolean;
  status: WatchlistReviewAnalysisWebhookStatus;
  responseStatus: number | null;
  error: string | null;
};

export type WatchlistReviewAnalysisDispatch = {
  id: string;
  prepId: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  status: WatchlistReviewAnalysisDispatchStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  payloadPreview: Record<string, unknown>;
  claimOwner: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  heartbeatAt: string | null;
  requestedAt: string;
  webhookSentAt: string | null;
  webhookFailedAt: string | null;
  webhookResponseStatus: number | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdReviewRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewAnalysisDispatchSummary = {
  dispatchId: string;
  prepId: string;
  status: WatchlistReviewAnalysisDispatchStatus;
  webhookStatus: WatchlistReviewAnalysisWebhookStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  createdReviewRunId: string | null;
  requestedAt: string;
  updatedAt: string;
  error: string | null;
};

export type WatchlistReviewAnalysisReadyRow = {
  dispatchId: string;
  prepId: string;
  status: WatchlistReviewAnalysisDispatchStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  sourceSetName: string | null;
  watchlistName: string | null;
  symbolCount: number;
  expectedAsOfDate: string;
  createdAt: string;
  barsUrl: string;
};

export type WatchlistReviewAnalysisClaimInput = {
  claimOwner: string;
  leaseSeconds?: number;
  idempotencyKey: string;
  payloadChecksum: string;
};

export type WatchlistReviewAnalysisClaimResult = {
  ok: true;
  claimed: boolean;
  dispatchId: string;
  prepId: string | null;
  status: WatchlistReviewAnalysisDispatchStatus | "not_found" | "checksum_mismatch" | "already_claimed" | "already_running" | "terminal";
  claimOwner: string | null;
  claimExpiresAt: string | null;
  dispatch: WatchlistReviewAnalysisDispatch | null;
  prep: { prepId: string; barsUrl: string } | null;
};

export type WatchlistReviewAnalysisStatusInput = {
  claimOwner: string;
  leaseSeconds?: number;
  idempotencyKey: string;
  payloadChecksum: string;
  status: "running" | "completed" | "partial_failed" | "failed" | "cancelled";
  createdReviewRunId?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
};

type AnalysisDispatchRow = {
  id: string;
  prepId: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  status: WatchlistReviewAnalysisDispatchStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  payloadPreviewJson: string | null;
  claimOwner: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  heartbeatAt: string | null;
  requestedAt: string;
  webhookSentAt: string | null;
  webhookFailedAt: string | null;
  webhookResponseStatus: number | string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  resultJson: string | null;
  createdReviewRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ReadyRow = AnalysisDispatchRow & {
  symbolCount: number | string | null;
  expectedAsOfDate: string | null;
};

const TERMINAL_STATUSES = new Set<WatchlistReviewAnalysisDispatchStatus>(["completed", "partial_failed", "failed", "cancelled"]);
const CLAIM_TTL_MS = 15 * 60_000;

const DISPATCH_SELECT = `
  SELECT
    id,
    prep_id as prepId,
    source,
    source_set_id as sourceSetId,
    source_set_name as sourceSetName,
    watchlist_name as watchlistName,
    watchlist_run_id as watchlistRunId,
    status,
    idempotency_key as idempotencyKey,
    payload_checksum as payloadChecksum,
    payload_preview_json as payloadPreviewJson,
    claim_owner as claimOwner,
    claimed_at as claimedAt,
    claim_expires_at as claimExpiresAt,
    heartbeat_at as heartbeatAt,
    requested_at as requestedAt,
    webhook_sent_at as webhookSentAt,
    webhook_failed_at as webhookFailedAt,
    webhook_response_status as webhookResponseStatus,
    started_at as startedAt,
    completed_at as completedAt,
    failed_at as failedAt,
    error,
    result_json as resultJson,
    created_review_run_id as createdReviewRunId,
    created_at as createdAt,
    updated_at as updatedAt
  FROM watchlist_review_analysis_dispatches
`;

function numberOr(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value: unknown, max = 240): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checksumValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return hex(digest);
}

function isSchemaMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /watchlist_review_analysis_dispatches|analysis_dispatch_id|analysis_metadata_json/i.test(message)
    && /no such table|no such column|not found|missing/i.test(message);
}

function claimExpiresAt(nowIso: string, leaseSeconds = CLAIM_TTL_MS / 1000): string {
  return new Date(Date.parse(nowIso) + Math.max(60, Math.trunc(leaseSeconds)) * 1000).toISOString();
}

function prepBarsUrl(origin: string, prepId: string): string {
  return `${origin.replace(/\/$/, "")}/api/watchlist-review/preps/${encodeURIComponent(prepId)}/bars`;
}

function redactedWebhookError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Webhook request failed.");
  return message.replace(/(bearer|token|secret|key)\s+[A-Za-z0-9._:-]+/gi, "$1 [redacted]").slice(0, 400);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function mapDispatchRow(row: AnalysisDispatchRow): WatchlistReviewAnalysisDispatch {
  return {
    id: row.id,
    prepId: row.prepId,
    source: row.source,
    sourceSetId: row.sourceSetId ?? null,
    sourceSetName: row.sourceSetName ?? null,
    watchlistName: row.watchlistName ?? null,
    watchlistRunId: row.watchlistRunId ?? null,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    payloadChecksum: row.payloadChecksum,
    payloadPreview: parseJson<Record<string, unknown>>(row.payloadPreviewJson, {}),
    claimOwner: row.claimOwner ?? null,
    claimedAt: row.claimedAt ?? null,
    claimExpiresAt: row.claimExpiresAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    requestedAt: row.requestedAt,
    webhookSentAt: row.webhookSentAt ?? null,
    webhookFailedAt: row.webhookFailedAt ?? null,
    webhookResponseStatus: row.webhookResponseStatus == null ? null : Math.trunc(numberOr(row.webhookResponseStatus, 0)),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    failedAt: row.failedAt ?? null,
    error: row.error ?? null,
    result: parseJson<Record<string, unknown> | null>(row.resultJson, null),
    createdReviewRunId: row.createdReviewRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function webhookStatusFromDispatch(dispatch: WatchlistReviewAnalysisDispatch): WatchlistReviewAnalysisWebhookStatus {
  if (dispatch.webhookSentAt) return "sent";
  if (dispatch.webhookFailedAt) return "failed";
  return "not_configured";
}

export function summarizeWatchlistReviewAnalysisDispatch(
  dispatch: WatchlistReviewAnalysisDispatch,
  webhookStatus?: WatchlistReviewAnalysisWebhookStatus,
): WatchlistReviewAnalysisDispatchSummary {
  return {
    dispatchId: dispatch.id,
    prepId: dispatch.prepId,
    status: dispatch.status,
    webhookStatus: webhookStatus ?? webhookStatusFromDispatch(dispatch),
    idempotencyKey: dispatch.idempotencyKey,
    payloadChecksum: dispatch.payloadChecksum,
    claimOwner: dispatch.claimOwner,
    claimExpiresAt: dispatch.claimExpiresAt,
    createdReviewRunId: dispatch.createdReviewRunId,
    requestedAt: dispatch.requestedAt,
    updatedAt: dispatch.updatedAt,
    error: dispatch.error,
  };
}

async function loadDispatchRow(env: Env, dispatchId: string): Promise<AnalysisDispatchRow | null> {
  return await env.DB.prepare(`${DISPATCH_SELECT} WHERE id = ? LIMIT 1`).bind(dispatchId).first<AnalysisDispatchRow>();
}

export async function loadWatchlistReviewAnalysisDispatch(
  env: Env,
  dispatchId: string,
): Promise<WatchlistReviewAnalysisDispatch | null> {
  try {
    const row = await loadDispatchRow(env, dispatchId);
    return row ? mapDispatchRow(row) : null;
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

async function sendHermesAnalysisWebhook(
  env: Env,
  payload: Record<string, unknown>,
): Promise<WatchlistReviewAnalysisWebhookResult> {
  const url = cleanText(env.HERMES_WATCHLIST_ANALYSIS_WEBHOOK_URL, 1000)
    ?? cleanText(env.HERMES_WATCHLIST_APPLY_WEBHOOK_URL, 1000);
  const secret = cleanText(env.HERMES_WATCHLIST_ANALYSIS_WEBHOOK_SECRET, 1000)
    ?? cleanText(env.HERMES_WATCHLIST_APPLY_WEBHOOK_SECRET, 1000);
  if (!url || !secret) {
    return {
      attempted: false,
      status: "not_configured",
      responseStatus: null,
      error: url && !secret ? "Hermes watchlist analysis/apply webhook secret is not configured." : null,
    };
  }

  const rawBody = JSON.stringify(payload);
  const backoffs = [0, 250, 1000];
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  for (let index = 0; index < backoffs.length; index += 1) {
    if (backoffs[index] > 0) await delay(backoffs[index]);
    const timestamp = new Date().toISOString();
    const signature = await signWatchlistReviewWebhook(rawBody, timestamp, secret);
    const hermesSignature = await signHermesGenericWebhook(rawBody, secret);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-market-overview-timestamp": timestamp,
          "x-market-overview-signature": signature,
          "x-webhook-signature": hermesSignature,
        },
        body: rawBody,
        signal: timeoutSignal(5000),
      });
      lastStatus = response.status;
      if (response.ok) return { attempted: true, status: "sent", responseStatus: response.status, error: null };
      lastError = `Hermes analysis webhook returned ${response.status}.`;
    } catch (error) {
      lastError = redactedWebhookError(error);
    }
  }
  return { attempted: true, status: "failed", responseStatus: lastStatus, error: lastError ?? "Hermes analysis webhook failed." };
}

function finalStatusFromWebhook(status: WatchlistReviewAnalysisWebhookStatus): WatchlistReviewAnalysisDispatchStatus {
  if (status === "sent") return "waiting_for_hermes";
  if (status === "failed") return "webhook_failed";
  return "queued";
}

function buildAnalysisWebhookPayload(
  prep: WatchlistReviewPrepSummary,
  dispatchId: string,
  origin: string,
  payloadChecksum: string,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    type: "watchlist_review_analysis",
    event: "watchlist_review_analysis.requested",
    event_type: "watchlist_review_analysis",
    dispatchId,
    prepId: prep.prepId,
    idempotencyKey,
    payloadChecksum,
    source: prep.source,
    sourceSetId: prep.sourceSetId,
    sourceSetName: prep.sourceSetName,
    watchlistName: prep.watchlistName,
    watchlistRunId: prep.watchlistRunId,
    symbolCount: prep.symbolCount,
    expectedAsOfDate: prep.expectedAsOfDate,
    provider: prep.provider,
    coverage: prep.coverage,
    barsUrl: prepBarsUrl(origin, prep.prepId),
  };
}

export async function createWatchlistReviewAnalysisDispatch(
  env: Env,
  prep: WatchlistReviewPrepSummary,
  options: { origin?: string } = {},
): Promise<{ ok: true; dispatch: WatchlistReviewAnalysisDispatch; summary: WatchlistReviewAnalysisDispatchSummary; webhook: WatchlistReviewAnalysisWebhookResult }> {
  try {
    if (prep.status === "blocked") throw new Error("Cannot enqueue Hermes analysis for a blocked watchlist review prep.");
    const now = new Date().toISOString();
    const dispatchId = crypto.randomUUID();
    const configuredOrigin = cleanText(env.MARKET_OVERVIEW_PUBLIC_URL, 1000);
    const origin = configuredOrigin || options.origin || "https://market-overview-nu.vercel.app";
    const checksumSeed = {
      type: "watchlist_review_analysis",
      dispatchId,
      prepId: prep.prepId,
      source: prep.source,
      sourceSetId: prep.sourceSetId,
      watchlistRunId: prep.watchlistRunId,
      symbolCount: prep.symbolCount,
      expectedAsOfDate: prep.expectedAsOfDate,
      barsUrl: prepBarsUrl(origin, prep.prepId),
    };
    const payloadChecksum = await checksumValue(checksumSeed);
    const idempotencyKey = `watchlist-review-analysis:${prep.prepId}:${payloadChecksum}`;
    const payload = buildAnalysisWebhookPayload(prep, dispatchId, origin, payloadChecksum, idempotencyKey);

    await env.DB.prepare(
      `INSERT INTO watchlist_review_analysis_dispatches
         (id, prep_id, source, source_set_id, source_set_name, watchlist_name, watchlist_run_id, status,
          idempotency_key, payload_checksum, payload_preview_json, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      dispatchId,
      prep.prepId,
      prep.source,
      prep.sourceSetId,
      prep.sourceSetName,
      prep.watchlistName,
      prep.watchlistRunId,
      idempotencyKey,
      payloadChecksum,
      stableJson(payload),
      now,
      now,
      now,
    ).run();

    const webhook = await sendHermesAnalysisWebhook(env, payload);
    const finalizedAt = new Date().toISOString();
    const finalStatus = finalStatusFromWebhook(webhook.status);
    await env.DB.prepare(
      `UPDATE watchlist_review_analysis_dispatches
          SET status = ?,
              webhook_sent_at = ?,
              webhook_failed_at = ?,
              webhook_response_status = ?,
              error = ?,
              updated_at = ?
        WHERE id = ?`,
    ).bind(
      finalStatus,
      webhook.status === "sent" ? finalizedAt : null,
      webhook.status === "failed" ? finalizedAt : null,
      webhook.responseStatus,
      webhook.error,
      finalizedAt,
      dispatchId,
    ).run();

    const dispatch = await loadWatchlistReviewAnalysisDispatch(env, dispatchId);
    if (!dispatch) throw new Error("Watchlist review analysis dispatch was not persisted.");
    return {
      ok: true,
      dispatch,
      summary: summarizeWatchlistReviewAnalysisDispatch(dispatch, webhook.status),
      webhook,
    };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function listWatchlistReviewAnalysisReadyDispatches(
  env: Env,
  options: { limit?: number; olderThanSeconds?: number; origin?: string } = {},
): Promise<{ ok: true; dispatches: WatchlistReviewAnalysisReadyRow[] }> {
  try {
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
    const now = new Date();
    const olderThan = new Date(now.getTime() - Math.max(0, Math.trunc(options.olderThanSeconds ?? 0)) * 1000).toISOString();
    const origin = options.origin ?? "https://market-overview-nu.vercel.app";
    const rows = await env.DB.prepare(
      `SELECT
         d.id,
         d.prep_id as prepId,
         d.source,
         d.source_set_id as sourceSetId,
         d.source_set_name as sourceSetName,
         d.watchlist_name as watchlistName,
         d.watchlist_run_id as watchlistRunId,
         d.status,
         d.idempotency_key as idempotencyKey,
         d.payload_checksum as payloadChecksum,
         d.payload_preview_json as payloadPreviewJson,
         d.claim_owner as claimOwner,
         d.claimed_at as claimedAt,
         d.claim_expires_at as claimExpiresAt,
         d.heartbeat_at as heartbeatAt,
         d.requested_at as requestedAt,
         d.webhook_sent_at as webhookSentAt,
         d.webhook_failed_at as webhookFailedAt,
         d.webhook_response_status as webhookResponseStatus,
         d.started_at as startedAt,
         d.completed_at as completedAt,
         d.failed_at as failedAt,
         d.error,
         d.result_json as resultJson,
         d.created_review_run_id as createdReviewRunId,
         d.created_at as createdAt,
         d.updated_at as updatedAt,
         p.symbol_count as symbolCount,
         p.expected_as_of_date as expectedAsOfDate
       FROM watchlist_review_analysis_dispatches d
       JOIN watchlist_review_preps p ON p.id = d.prep_id
       WHERE (
           d.status IN ('queued', 'waiting_for_hermes', 'webhook_failed')
           OR (d.status IN ('claimed', 'running') AND d.claim_expires_at IS NOT NULL AND datetime(d.claim_expires_at) <= datetime(?))
         )
         AND datetime(d.requested_at) <= datetime(?)
       ORDER BY datetime(d.requested_at) ASC
       LIMIT ?`,
    ).bind(now.toISOString(), olderThan, limit).all<ReadyRow>();
    return {
      ok: true,
      dispatches: (rows.results ?? []).map((row) => ({
        dispatchId: row.id,
        prepId: row.prepId,
        status: row.status,
        idempotencyKey: row.idempotencyKey,
        payloadChecksum: row.payloadChecksum,
        sourceSetName: row.sourceSetName ?? null,
        watchlistName: row.watchlistName ?? null,
        symbolCount: Math.max(0, Math.trunc(numberOr(row.symbolCount, 0))),
        expectedAsOfDate: row.expectedAsOfDate ?? "",
        createdAt: row.createdAt,
        barsUrl: prepBarsUrl(origin, row.prepId),
      })),
    };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

function claimResult(
  dispatch: WatchlistReviewAnalysisDispatch | null,
  status: WatchlistReviewAnalysisClaimResult["status"],
): WatchlistReviewAnalysisClaimResult {
  return {
    ok: true,
    claimed: false,
    dispatchId: dispatch?.id ?? "",
    prepId: dispatch?.prepId ?? null,
    status,
    claimOwner: dispatch?.claimOwner ?? null,
    claimExpiresAt: dispatch?.claimExpiresAt ?? null,
    dispatch,
    prep: null,
  };
}

export async function claimWatchlistReviewAnalysisDispatch(
  env: Env,
  dispatchId: string,
  input: WatchlistReviewAnalysisClaimInput,
  options: { origin?: string } = {},
): Promise<WatchlistReviewAnalysisClaimResult> {
  try {
    const dispatch = await loadWatchlistReviewAnalysisDispatch(env, dispatchId);
    if (!dispatch) return { ...claimResult(null, "not_found"), dispatchId };
    if (input.idempotencyKey !== dispatch.idempotencyKey || input.payloadChecksum !== dispatch.payloadChecksum) {
      return { ...claimResult(dispatch, "checksum_mismatch"), dispatchId: dispatch.id };
    }
    if (TERMINAL_STATUSES.has(dispatch.status)) return { ...claimResult(dispatch, "terminal"), dispatchId: dispatch.id };
    const now = new Date().toISOString();
    const liveLease = dispatch.claimExpiresAt && Date.parse(dispatch.claimExpiresAt) > Date.parse(now);
    if (dispatch.status === "claimed" && liveLease) return { ...claimResult(dispatch, "already_claimed"), dispatchId: dispatch.id };
    if (dispatch.status === "running" && liveLease) return { ...claimResult(dispatch, "already_running"), dispatchId: dispatch.id };

    const nextClaimExpiresAt = claimExpiresAt(now, input.leaseSeconds ?? 900);
    const result = await env.DB.prepare(
      `UPDATE watchlist_review_analysis_dispatches
          SET status = 'claimed',
              claim_owner = ?,
              claimed_at = ?,
              heartbeat_at = ?,
              claim_expires_at = ?,
              error = NULL,
              updated_at = ?
        WHERE id = ?
          AND idempotency_key = ?
          AND payload_checksum = ?
          AND (
            status IN ('queued', 'dispatching', 'waiting_for_hermes', 'webhook_failed')
            OR (status IN ('claimed', 'running') AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) <= datetime(?))
          )`,
    ).bind(
      input.claimOwner,
      now,
      now,
      nextClaimExpiresAt,
      now,
      dispatch.id,
      dispatch.idempotencyKey,
      dispatch.payloadChecksum,
      now,
    ).run();
    const changed = Number(result.meta?.changes ?? 0) > 0;
    const nextDispatch = await loadWatchlistReviewAnalysisDispatch(env, dispatch.id);
    if (!changed || !nextDispatch) return { ...claimResult(nextDispatch ?? dispatch, "already_claimed"), dispatchId: dispatch.id };
    const configuredOrigin = cleanText(env.MARKET_OVERVIEW_PUBLIC_URL, 1000);
    const origin = configuredOrigin || options.origin || "https://market-overview-nu.vercel.app";
    return {
      ok: true,
      claimed: true,
      dispatchId: nextDispatch.id,
      prepId: nextDispatch.prepId,
      status: nextDispatch.status,
      claimOwner: nextDispatch.claimOwner,
      claimExpiresAt: nextDispatch.claimExpiresAt,
      dispatch: nextDispatch,
      prep: { prepId: nextDispatch.prepId, barsUrl: prepBarsUrl(origin, nextDispatch.prepId) },
    };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function updateWatchlistReviewAnalysisDispatchStatus(
  env: Env,
  dispatchId: string,
  input: WatchlistReviewAnalysisStatusInput,
): Promise<{ ok: true; dispatch: WatchlistReviewAnalysisDispatch; summary: WatchlistReviewAnalysisDispatchSummary }> {
  try {
    const dispatch = await loadWatchlistReviewAnalysisDispatch(env, dispatchId);
    if (!dispatch) throw new Error("Watchlist review analysis dispatch not found.");
    if (input.idempotencyKey !== dispatch.idempotencyKey || input.payloadChecksum !== dispatch.payloadChecksum) {
      throw new Error("Analysis dispatch idempotency key or checksum is stale.");
    }
    if (!dispatch.claimOwner) throw new Error("Analysis dispatch must be claimed before status updates.");
    if (input.claimOwner !== dispatch.claimOwner) throw new Error("Analysis dispatch claimOwner does not match the active claim.");
    if (TERMINAL_STATUSES.has(dispatch.status)) {
      if (dispatch.status === input.status) {
        return { ok: true, dispatch, summary: summarizeWatchlistReviewAnalysisDispatch(dispatch) };
      }
      throw new Error("Analysis dispatch is already terminal.");
    }
    if (!["claimed", "running"].includes(dispatch.status)) {
      throw new Error("Analysis dispatch must be claimed before it can run or complete.");
    }

    const now = new Date().toISOString();
    const terminal = input.status !== "running";
    const completedAt = input.status === "completed" || input.status === "partial_failed" ? now : null;
    const failedAt = input.status === "failed" || input.status === "cancelled" ? now : null;
    const resultJson = terminal
      ? stableJson({
        status: input.status,
        createdReviewRunId: input.createdReviewRunId ?? null,
        result: input.result ?? null,
        error: input.error ?? null,
        receivedAt: now,
      })
      : null;
    await env.DB.prepare(
      `UPDATE watchlist_review_analysis_dispatches
          SET status = ?,
              heartbeat_at = ?,
              claim_expires_at = CASE WHEN ? = 'running' THEN ? ELSE claim_expires_at END,
              started_at = COALESCE(started_at, ?),
              completed_at = COALESCE(?, completed_at),
              failed_at = COALESCE(?, failed_at),
              created_review_run_id = COALESCE(?, created_review_run_id),
              result_json = COALESCE(?, result_json),
              error = ?,
              updated_at = ?
        WHERE id = ?`,
    ).bind(
      input.status,
      now,
      input.status,
      input.status === "running" ? claimExpiresAt(now, input.leaseSeconds ?? 900) : null,
      now,
      completedAt,
      failedAt,
      cleanText(input.createdReviewRunId, 180),
      resultJson,
      cleanText(input.error, 1000),
      now,
      dispatch.id,
    ).run();
    const nextDispatch = await loadWatchlistReviewAnalysisDispatch(env, dispatch.id);
    if (!nextDispatch) throw new Error("Watchlist review analysis dispatch not found after status update.");
    return { ok: true, dispatch: nextDispatch, summary: summarizeWatchlistReviewAnalysisDispatch(nextDispatch) };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function createWatchlistReviewPrepWithOptionalAnalysisDispatch(
  env: Env,
  prep: WatchlistReviewPrepSummary,
  input: { enqueueHermesAnalysis?: boolean },
  options: { origin?: string } = {},
): Promise<{ prep: WatchlistReviewPrepSummary; analysisDispatch: WatchlistReviewAnalysisDispatchSummary | null }> {
  if (!input.enqueueHermesAnalysis || prep.status === "blocked") return { prep, analysisDispatch: null };
  const result = await createWatchlistReviewAnalysisDispatch(env, prep, options);
  return { prep, analysisDispatch: result.summary };
}
