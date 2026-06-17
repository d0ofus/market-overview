import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimWatchlistReviewAnalysisDispatch,
  createWatchlistReviewAnalysisDispatch,
  listWatchlistReviewAnalysisReadyDispatches,
  updateWatchlistReviewAnalysisDispatchStatus,
  type WatchlistReviewAnalysisDispatchStatus,
} from "../src/watchlist-review-analysis-dispatch-service";
import type { WatchlistReviewPrepSummary } from "../src/watchlist-review-prep-service";

const NOW = "2026-06-12T14:00:00.000Z";

function createPrep(overrides: Partial<WatchlistReviewPrepSummary> = {}): WatchlistReviewPrepSummary {
  return {
    prepId: "watchlist-review-prep-2026-06-12-test",
    source: "watchlist-compiler",
    sourceSetId: "set-1",
    sourceSetName: "Daily Scans",
    watchlistName: "Daily Scans",
    watchlistRunId: "compile-run-1",
    symbolCount: 2,
    lookbackBars: 260,
    expectedAsOfDate: "2026-06-12",
    provider: { primary: "alpaca", feed: "iex", adjustment: "all", fallbackEnabled: true, fallbacks: ["stooq"] },
    coverage: { complete: 2, stale: 0, missing: 0, coveragePct: 100 },
    status: "ready",
    warnings: [],
    timing: { refreshMs: 0, dbReadMs: 1, totalMs: 2, requestedSymbols: 2, refreshedSymbols: 0, skippedFreshSymbols: 2 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createAnalysisEnv(options: { raceStatusUpdateClaimOwner?: string } = {}) {
  const prep = createPrep();
  const dispatches = new Map<string, any>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM watchlist_review_analysis_dispatches")) {
                return dispatches.get(String(args[0])) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("JOIN watchlist_review_preps")) {
                const rows = Array.from(dispatches.values()).filter((dispatch) => (
                  ["queued", "waiting_for_hermes", "webhook_failed"].includes(dispatch.status)
                  || (["claimed", "running"].includes(dispatch.status) && dispatch.claimExpiresAt && Date.parse(dispatch.claimExpiresAt) <= Date.parse(String(args[0])))
                ));
                return { results: rows.map((dispatch) => ({ ...dispatch, symbolCount: prep.symbolCount, expectedAsOfDate: prep.expectedAsOfDate })) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO watchlist_review_analysis_dispatches")) {
                dispatches.set(String(args[0]), {
                  id: args[0],
                  prepId: args[1],
                  source: args[2],
                  sourceSetId: args[3],
                  sourceSetName: args[4],
                  watchlistName: args[5],
                  watchlistRunId: args[6],
                  status: "dispatching",
                  idempotencyKey: args[7],
                  payloadChecksum: args[8],
                  payloadPreviewJson: args[9],
                  claimOwner: null,
                  claimedAt: null,
                  claimExpiresAt: null,
                  heartbeatAt: null,
                  requestedAt: args[10],
                  webhookSentAt: null,
                  webhookFailedAt: null,
                  webhookResponseStatus: null,
                  startedAt: null,
                  completedAt: null,
                  failedAt: null,
                  error: null,
                  resultJson: null,
                  createdReviewRunId: null,
                  createdAt: args[11],
                  updatedAt: args[12],
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("webhook_sent_at")) {
                const dispatch = dispatches.get(String(args[6]));
                dispatch.status = args[0];
                dispatch.webhookSentAt = args[1];
                dispatch.webhookFailedAt = args[2];
                dispatch.webhookResponseStatus = args[3];
                dispatch.error = args[4];
                dispatch.updatedAt = args[5];
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("status = 'claimed'")) {
                const dispatch = dispatches.get(String(args[5]));
                const claimable = ["queued", "dispatching", "waiting_for_hermes", "webhook_failed"].includes(dispatch.status)
                  || (["claimed", "running"].includes(dispatch.status) && dispatch.claimExpiresAt && Date.parse(dispatch.claimExpiresAt) <= Date.parse(String(args[8])));
                if (claimable && args[6] === dispatch.idempotencyKey && args[7] === dispatch.payloadChecksum) {
                  dispatch.status = "claimed";
                  dispatch.claimOwner = args[0];
                  dispatch.claimedAt = args[1];
                  dispatch.heartbeatAt = args[2];
                  dispatch.claimExpiresAt = args[3];
                  dispatch.error = null;
                  dispatch.updatedAt = args[4];
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (sql.includes("started_at = COALESCE")) {
                const dispatch = dispatches.get(String(args[11]));
                if (options.raceStatusUpdateClaimOwner) dispatch.claimOwner = options.raceStatusUpdateClaimOwner;
                const canUpdate = dispatch
                  && args[12] === dispatch.claimOwner
                  && args[13] === dispatch.idempotencyKey
                  && args[14] === dispatch.payloadChecksum
                  && ["claimed", "running"].includes(dispatch.status);
                if (!canUpdate) return { success: true, meta: { changes: 0 } };
                dispatch.status = args[0] as WatchlistReviewAnalysisDispatchStatus;
                dispatch.heartbeatAt = args[1];
                if (args[3]) dispatch.claimExpiresAt = args[3];
                dispatch.startedAt = dispatch.startedAt ?? args[4];
                dispatch.completedAt = args[5] ?? dispatch.completedAt;
                dispatch.failedAt = args[6] ?? dispatch.failedAt;
                dispatch.createdReviewRunId = args[7] ?? dispatch.createdReviewRunId;
                dispatch.resultJson = args[8] ?? dispatch.resultJson;
                dispatch.error = args[9];
                dispatch.updatedAt = args[10];
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return {
    env: {
      DB: db,
      MARKET_OVERVIEW_PUBLIC_URL: "https://market.example",
    } as any,
    prep,
    dispatches,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("watchlist review analysis dispatch service", () => {
  it("creates a pollable dispatch without embedding OHLCV in the webhook payload", async () => {
    const { env, prep } = createAnalysisEnv();

    const result = await createWatchlistReviewAnalysisDispatch(env, prep, { origin: "https://market.example" });

    expect(result.summary).toMatchObject({
      prepId: prep.prepId,
      status: "queued",
      webhookStatus: "not_configured",
    });
    expect(result.dispatch.payloadPreview).toMatchObject({
      type: "watchlist_review_analysis",
      prepId: prep.prepId,
      barsUrl: `https://market.example/api/watchlist-review/preps/${prep.prepId}/bars`,
    });
    expect(JSON.stringify(result.dispatch.payloadPreview)).not.toContain("\"bars\"");
    expect(JSON.stringify(result.dispatch.payloadPreview)).not.toContain("ALPACA");

    const ready = await listWatchlistReviewAnalysisReadyDispatches(env, { origin: "https://market.example" });
    expect(ready.dispatches).toHaveLength(1);
    expect(ready.dispatches[0]).toMatchObject({ dispatchId: result.dispatch.id, prepId: prep.prepId, symbolCount: 2 });
  });

  it("keeps webhook failures poller-visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const { env, prep } = createAnalysisEnv();
    env.HERMES_WATCHLIST_ANALYSIS_WEBHOOK_URL = "https://hermes.example/webhook";
    env.HERMES_WATCHLIST_ANALYSIS_WEBHOOK_SECRET = "secret";

    const result = await createWatchlistReviewAnalysisDispatch(env, prep, { origin: "https://market.example" });
    const ready = await listWatchlistReviewAnalysisReadyDispatches(env, { origin: "https://market.example" });

    expect(result.summary).toMatchObject({ status: "webhook_failed", webhookStatus: "failed" });
    expect(ready.dispatches.map((row) => row.dispatchId)).toContain(result.dispatch.id);
  });

  it("uses the apply webhook config when analysis webhook config is omitted", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { env, prep } = createAnalysisEnv();
    env.HERMES_WATCHLIST_APPLY_WEBHOOK_URL = "https://hermes.example/apply";
    env.HERMES_WATCHLIST_APPLY_WEBHOOK_SECRET = "shared-secret";

    const result = await createWatchlistReviewAnalysisDispatch(env, prep, { origin: "https://market.example" });

    expect(result.summary).toMatchObject({ status: "waiting_for_hermes", webhookStatus: "sent" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hermes.example/apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-market-overview-signature": expect.any(String),
          "x-webhook-signature": expect.any(String),
        }),
      }),
    );
  });

  it("claims once, blocks a live second claim, and reclaims after expiry", async () => {
    const { env, prep, dispatches } = createAnalysisEnv();
    const created = await createWatchlistReviewAnalysisDispatch(env, prep);
    const input = {
      claimOwner: "hermes-1",
      leaseSeconds: 900,
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
    };

    const first = await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, input);
    const second = await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, { ...input, claimOwner: "hermes-2" });
    dispatches.get(created.dispatch.id).claimExpiresAt = "2026-01-01T00:00:00.000Z";
    const reclaimed = await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, { ...input, claimOwner: "hermes-3" });

    expect(first).toMatchObject({ claimed: true, status: "claimed", claimOwner: "hermes-1" });
    expect(first.prep?.barsUrl).toContain(`/api/watchlist-review/preps/${prep.prepId}/bars`);
    expect(second).toMatchObject({ claimed: false, status: "already_claimed", claimOwner: "hermes-1" });
    expect(reclaimed).toMatchObject({ claimed: true, status: "claimed", claimOwner: "hermes-3" });
  });

  it("does not claim terminal jobs and rejects checksum mismatches", async () => {
    const { env, prep, dispatches } = createAnalysisEnv();
    const created = await createWatchlistReviewAnalysisDispatch(env, prep);
    dispatches.get(created.dispatch.id).status = "completed";

    const terminal = await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
    });
    dispatches.get(created.dispatch.id).status = "queued";
    const mismatch = await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: "bad-checksum",
    });

    expect(terminal).toMatchObject({ claimed: false, status: "terminal" });
    expect(mismatch).toMatchObject({ claimed: false, status: "checksum_mismatch" });
  });

  it("rejects stale analysis status updates when the dispatch claim changes between load and update", async () => {
    const { env, prep } = createAnalysisEnv({ raceStatusUpdateClaimOwner: "hermes-2" });
    const created = await createWatchlistReviewAnalysisDispatch(env, prep);
    await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
    });

    await expect(updateWatchlistReviewAnalysisDispatchStatus(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
      status: "running",
    })).rejects.toThrow(/stale|claim/i);
  });

  it("requires the active claim owner for status updates and stores completion result metadata", async () => {
    const { env, prep } = createAnalysisEnv();
    const created = await createWatchlistReviewAnalysisDispatch(env, prep);
    await claimWatchlistReviewAnalysisDispatch(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
    });

    await expect(updateWatchlistReviewAnalysisDispatchStatus(env, created.dispatch.id, {
      claimOwner: "hermes-2",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
      status: "running",
    })).rejects.toThrow(/claimOwner/i);

    const running = await updateWatchlistReviewAnalysisDispatchStatus(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
      status: "running",
    });
    const completed = await updateWatchlistReviewAnalysisDispatchStatus(env, created.dispatch.id, {
      claimOwner: "hermes-1",
      idempotencyKey: created.dispatch.idempotencyKey,
      payloadChecksum: created.dispatch.payloadChecksum,
      status: "completed",
      createdReviewRunId: "review-run-1",
      result: { importedCandidates: 35, analysisSource: "app_ohlcv_local_chart_vision" },
    });

    expect(running.dispatch.status).toBe("running");
    expect(completed.dispatch).toMatchObject({
      status: "completed",
      createdReviewRunId: "review-run-1",
    });
    expect(completed.dispatch.result).toMatchObject({
      result: { importedCandidates: 35, analysisSource: "app_ohlcv_local_chart_vision" },
    });
  });
});
