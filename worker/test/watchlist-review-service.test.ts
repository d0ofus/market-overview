import { describe, expect, it } from "vitest";
import {
  assertWatchlistReviewApplySetReady,
  buildWatchlistReviewCanonicalApplySet,
  claimWatchlistReviewApplyDispatch,
  buildWatchlistReviewExportPayload,
  checksumWatchlistReviewApplySet,
  normalizeWatchlistReviewImport,
  recordWatchlistReviewTelegramConfirmationRequested,
  resolveWatchlistReviewCandidateApplyOutcomes,
  signHermesGenericWebhook,
  signWatchlistReviewWebhook,
  watchlistReviewExportCsv,
} from "../src/watchlist-review-service";

const NOW = "2026-06-12T14:00:00.000Z";

function createDispatchEnv(status = "waiting_for_hermes") {
  const events: Array<{ eventType: string; actor: string; payloadJson: string }> = [];
  const dispatch = {
    id: "dispatch-1",
    runId: "run-1",
    approvalRevision: 2,
    checksum: "a".repeat(64),
    idempotencyKey: `watchlist-review:run-1:2:${"a".repeat(64)}`,
    status,
    approvedCount: 1,
    skippedCount: 0,
    destructiveCount: 0,
    approvedSetJson: JSON.stringify({
      runId: "run-1",
      prepId: "prep-1",
      sourceWatchlistName: "Daily Scans",
      sourceWatchlistId: null,
      watchlistSetId: "set-1",
      watchlistRunId: "compile-run-1",
      createdAt: NOW,
      generatedBy: "hermes",
      analysisVersion: "v0.1",
      changes: [
        {
          candidateId: "candidate-1",
          ticker: "AAPL",
          tvSymbol: "NASDAQ:AAPL",
          companyName: "Apple Inc.",
          currentFlag: "blue",
          finalFlag: "red",
          finalAction: "move_flag",
          recommendationType: "BLUE_TO_RED",
          destructiveAction: false,
          destructiveConfirmed: false,
          approvedBy: "tester",
          approvedAt: NOW,
          reason: "test",
          rollbackHint: "restore",
        },
      ],
    }),
    payloadPreviewJson: "{}",
    resultJson: null,
    requestedAt: NOW,
    webhookSentAt: NOW,
    webhookFailedAt: null,
    webhookResponseStatus: 200,
    claimOwner: null as string | null,
    claimedAt: null as string | null,
    heartbeatAt: null as string | null,
    claimExpiresAt: null as string | null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM watchlist_review_apply_dispatches") && args[0] === dispatch.id) {
                return dispatch;
              }
              return null;
            },
            async run() {
              if (sql.includes("UPDATE watchlist_review_apply_dispatches") && sql.includes("status = 'claimed'")) {
                const [
                  claimOwner,
                  claimedAt,
                  heartbeatAt,
                  claimExpiresAt,
                  updatedAt,
                  dispatchId,
                  approvalRevision,
                  checksum,
                  idempotencyKey,
                  now,
                ] = args;
                const liveClaim = dispatch.status === "claimed"
                  && dispatch.claimExpiresAt
                  && Date.parse(dispatch.claimExpiresAt) > Date.parse(String(now));
                const claimable = ["approved_ready", "dispatching", "waiting_for_hermes", "webhook_failed"].includes(String(dispatch.status))
                  || (dispatch.status === "claimed" && !liveClaim);
                if (
                  dispatchId === dispatch.id
                  && approvalRevision === dispatch.approvalRevision
                  && checksum === dispatch.checksum
                  && idempotencyKey === dispatch.idempotencyKey
                  && claimable
                ) {
                  dispatch.status = "claimed";
                  dispatch.claimOwner = String(claimOwner);
                  dispatch.claimedAt = String(claimedAt);
                  dispatch.heartbeatAt = String(heartbeatAt);
                  dispatch.claimExpiresAt = String(claimExpiresAt);
                  dispatch.updatedAt = String(updatedAt);
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (sql.includes("UPDATE watchlist_review_apply_dispatches") && sql.includes("heartbeat_at")) {
                dispatch.heartbeatAt = String(args[0]);
                dispatch.claimExpiresAt = String(args[1]);
                dispatch.updatedAt = String(args[2]);
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO watchlist_review_events")) {
                events.push({
                  eventType: String(args[4]),
                  actor: String(args[9]),
                  payloadJson: String(args[10]),
                });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { env: { DB: db } as any, dispatch, events };
}

describe("watchlist review service helpers", () => {
  it("normalizes Hermes review-run imports and preserves compiler linkage", () => {
    const normalized = normalizeWatchlistReviewImport({
      prepId: "prep-1",
      analysisDispatchId: "analysis-dispatch-1",
      analysisMetadata: { provider: "alpaca", feed: "iex", expectedAsOfDate: "2026-06-12" },
      watchlistSetId: "compiler-set-1",
      watchlistRunId: "compile-run-1",
      run: {
        id: "watchlist-review-2026-06-12",
        source_watchlist_name: "WatchlistComp-Daily Scans_06_11",
        total_tickers_scanned: 222,
        analysis_version: "v0.1",
      },
      candidates: [
        {
          ticker: "cat",
          company_name: "Caterpillar Inc.",
          current_flag: "blue",
          proposed_flag: "red",
          confidence: 82,
          reasons: ["ATH multi-peak pivot"],
          metrics: { distance_to_20dma: 0.5 },
          sector_context: { sector: "Industrials", focus_now: false },
          data_freshness: {
            latest_bar_date: "2026-06-11",
            expected_latest_session: "2026-06-11",
            is_stale: false,
            source: "tradingview",
          },
          analysis_source: "full_chart_vision",
        },
        {
          ticker: "OLDX",
          current_flag: "orange",
          proposed_flag: "remove",
          reasons: "Requires chart confirmation before removal.",
          destructive_action: true,
        },
      ],
    }, NOW);

    expect(normalized.run.id).toBe("watchlist-review-2026-06-12");
    expect(normalized.run.prepId).toBe("prep-1");
    expect(normalized.run.analysisDispatchId).toBe("analysis-dispatch-1");
    expect(normalized.run.analysisMetadata).toMatchObject({ provider: "alpaca", feed: "iex" });
    expect(normalized.run.watchlistSetId).toBe("compiler-set-1");
    expect(normalized.run.watchlistRunId).toBe("compile-run-1");
    expect(normalized.run.totalTickersScanned).toBe(222);
    expect(normalized.run.summaryCounts.blue_to_red).toBe(1);
    expect(normalized.run.summaryCounts.unflag).toBe(1);
    expect(normalized.candidates[0]).toMatchObject({
      ticker: "CAT",
      currentFlag: "blue",
      proposedFlag: "red",
      recommendationType: "BLUE_TO_RED",
      confidence: 0.82,
      analysisSource: "full_chart_vision",
    });
    expect(normalized.candidates[1]).toMatchObject({
      ticker: "OLDX",
      proposedFlag: "remove",
      recommendationType: "ANY_TO_UNFLAG",
      destructiveAction: true,
    });
  });

  it("blocks destructive approved exports until candidate and export confirmations are present", () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-confirm" },
      candidates: [
        {
          ticker: "DRFT",
          current_flag: "yellow",
          proposed_flag: "remove",
          destructive_action: true,
          status: "approved",
          reasons: ["Support invalidation needs chart confirmation."],
        },
      ],
    }, NOW);

    expect(() => buildWatchlistReviewExportPayload(run, candidates, { approvedBy: "authorized-user" }, NOW))
      .toThrow(/lack candidate confirmation/i);

    const candidateConfirmed = candidates.map((candidate) => ({ ...candidate, destructiveConfirmed: true }));
    expect(() => buildWatchlistReviewExportPayload(run, candidateConfirmed, { approvedBy: "authorized-user" }, NOW))
      .toThrow(/requires explicit export confirmation/i);
  });

  it("exports approved JSON and CSV rows for Hermes apply step", () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-export" },
      candidates: [
        {
          ticker: "DAL",
          current_flag: "blue",
          proposed_flag: "red",
          status: "approved",
          reasons: ["Near CP zone", "Strong RS"],
        },
        {
          ticker: "DRFT",
          current_flag: "yellow",
          proposed_flag: "remove",
          destructive_action: true,
          status: "approved",
          reasons: ["Decisive support invalidation"],
        },
      ],
    }, NOW);

    const confirmedCandidates = candidates.map((candidate) => ({
      ...candidate,
      destructiveConfirmed: candidate.destructiveAction,
    }));
    const payload = buildWatchlistReviewExportPayload(
      run,
      confirmedCandidates,
      { approvedBy: "authorized-user", destructiveConfirmed: true },
      NOW,
    );

    expect(payload.approvedCount).toBe(2);
    expect(payload.destructiveCount).toBe(1);
    expect(payload.rows[0]).toMatchObject({
      run_id: "watchlist-review-export",
      ticker: "DAL",
      current_flag: "blue",
      proposed_flag: "red",
      recommendation_type: "BLUE_TO_RED",
      approved_by: "authorized-user",
      destructive_action: false,
    });
    expect(payload.rows[1].rollback_hint).toContain("Restore DRFT");
    expect(payload.csv).toContain("run_id,ticker,current_flag,proposed_flag");
    expect(watchlistReviewExportCsv(payload.rows)).toBe(payload.csv);
  });

  it("builds a canonical Hermes apply set from approved real changes only", () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-apply-set" },
      candidates: [
        {
          ticker: "DAL",
          current_flag: "blue",
          proposed_flag: "red",
          status: "approved",
          tv_symbol: "NYSE:DAL",
          reasons: ["Near CP zone"],
        },
        {
          ticker: "CTVA",
          current_flag: "yellow",
          proposed_flag: "orange",
          status: "approved",
          reasons: ["Monitor group no-op"],
        },
        {
          ticker: "DLR",
          current_flag: "blue",
          proposed_flag: "keep",
          status: "approved",
        },
        {
          ticker: "SKIP",
          current_flag: "blue",
          proposed_flag: "red",
          status: "skipped",
        },
      ],
    }, NOW);

    const applySet = buildWatchlistReviewCanonicalApplySet(run, candidates, "tester");

    expect(applySet.changes).toHaveLength(1);
    expect(applySet.changes[0]).toMatchObject({
      ticker: "DAL",
      tvSymbol: "NYSE:DAL",
      currentFlag: "blue",
      finalFlag: "red",
      finalAction: "move_flag",
      approvedBy: "tester",
    });
  });

  it("blocks canonical apply sets with unconfirmed destructive changes", () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-apply-destructive" },
      candidates: [
        {
          ticker: "DRFT",
          current_flag: "blue",
          proposed_flag: "remove",
          destructive_action: true,
          status: "approved",
        },
      ],
    }, NOW);

    const applySet = buildWatchlistReviewCanonicalApplySet(run, candidates, "tester");

    expect(() => assertWatchlistReviewApplySetReady(applySet, { approvedBy: "tester", destructiveConfirmed: true }))
      .toThrow(/lack candidate confirmation/i);

    const confirmedApplySet = {
      ...applySet,
      changes: applySet.changes.map((change) => ({ ...change, destructiveConfirmed: true })),
    };

    expect(() => assertWatchlistReviewApplySetReady(confirmedApplySet, { approvedBy: "tester" }))
      .toThrow(/requires final dispatch confirmation/i);
    expect(() => assertWatchlistReviewApplySetReady(confirmedApplySet, { approvedBy: "tester", destructiveConfirmed: true }))
      .not.toThrow();
  });

  it("generates deterministic apply-set checksums and HMAC webhook signatures", async () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-checksum" },
      candidates: [
        {
          ticker: "CAT",
          current_flag: "blue",
          proposed_flag: "red",
          status: "approved",
          reasons: ["ATH pivot"],
        },
      ],
    }, NOW);
    const applySet = buildWatchlistReviewCanonicalApplySet(run, candidates, "tester");

    const first = await checksumWatchlistReviewApplySet(applySet);
    const second = await checksumWatchlistReviewApplySet({
      ...applySet,
      changes: [...applySet.changes],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);

    const signature = await signWatchlistReviewWebhook(JSON.stringify({ event: "watchlist_review.ready_to_apply" }), NOW, "secret");
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    await expect(signWatchlistReviewWebhook(JSON.stringify({ event: "watchlist_review.ready_to_apply" }), NOW, "secret"))
      .resolves.toBe(signature);

    const hermesSignature = await signHermesGenericWebhook(JSON.stringify({ event: "watchlist_review.ready_to_apply" }), "secret");
    expect(hermesSignature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps partial apply results conservatively by candidateId and ticker fallback", () => {
    const { run, candidates } = normalizeWatchlistReviewImport({
      run: { id: "watchlist-review-partial" },
      candidates: [
        { ticker: "AAA", current_flag: "blue", proposed_flag: "red", status: "approved" },
        { ticker: "BBB", current_flag: "blue", proposed_flag: "red", status: "approved" },
        { ticker: "CCC", current_flag: "blue", proposed_flag: "red", status: "approved" },
      ],
    }, NOW);
    const applySet = buildWatchlistReviewCanonicalApplySet(run, candidates, "tester");

    const outcomes = resolveWatchlistReviewCandidateApplyOutcomes(applySet.changes, {
      approvalRevision: 1,
      checksum: "a".repeat(64),
      idempotencyKey: "watchlist-review:watchlist-review-partial:1:checksum",
      status: "partial_failed",
      results: [
        { candidateId: applySet.changes[0].candidateId, status: "applied", message: "ok" },
        { ticker: "BBB", status: "failed", message: "TV flag menu not found" },
      ],
    });

    expect(outcomes.get(applySet.changes[0].candidateId)).toMatchObject({ status: "applied", message: "ok" });
    expect(outcomes.get(applySet.changes[1].candidateId)).toMatchObject({ status: "failed", message: "TV flag menu not found" });
    expect(outcomes.get(applySet.changes[2].candidateId)).toMatchObject({ status: "failed" });
  });

  it("atomically claims a dispatch once and returns the frozen apply set", async () => {
    const { env } = createDispatchEnv();
    const input = {
      claimOwner: "hermes-default-1",
      leaseSeconds: 600,
      approvalRevision: 2,
      checksum: "a".repeat(64),
      idempotencyKey: `watchlist-review:run-1:2:${"a".repeat(64)}`,
    };

    const first = await claimWatchlistReviewApplyDispatch(env, "dispatch-1", input);
    const second = await claimWatchlistReviewApplyDispatch(env, "dispatch-1", { ...input, claimOwner: "hermes-default-2" });

    expect(first).toMatchObject({
      ok: true,
      claimed: true,
      dispatchId: "dispatch-1",
      runId: "run-1",
      status: "claimed",
      claimOwner: "hermes-default-1",
    });
    expect(first.approvedApplySet?.prepId).toBe("prep-1");
    expect(second).toMatchObject({
      ok: true,
      claimed: false,
      status: "already_claimed",
      claimOwner: "hermes-default-1",
    });
  });

  it("does not claim terminal dispatches", async () => {
    const { env } = createDispatchEnv("applied");

    const result = await claimWatchlistReviewApplyDispatch(env, "dispatch-1", {
      claimOwner: "hermes-default-1",
      approvalRevision: 2,
      checksum: "a".repeat(64),
      idempotencyKey: `watchlist-review:run-1:2:${"a".repeat(64)}`,
    });

    expect(result).toMatchObject({ claimed: false, status: "terminal" });
  });

  it("requires matching claimOwner for Telegram confirmation audit events", async () => {
    const { env, events } = createDispatchEnv();
    const claim = {
      claimOwner: "hermes-default-1",
      approvalRevision: 2,
      checksum: "a".repeat(64),
      idempotencyKey: `watchlist-review:run-1:2:${"a".repeat(64)}`,
    };
    await claimWatchlistReviewApplyDispatch(env, "dispatch-1", claim);

    await expect(recordWatchlistReviewTelegramConfirmationRequested(env, "dispatch-1", {
      claimOwner: "hermes-default-2",
      channel: "telegram",
      summary: {},
    })).rejects.toThrow(/claimOwner/i);

    await recordWatchlistReviewTelegramConfirmationRequested(env, "dispatch-1", {
      claimOwner: "hermes-default-1",
      channel: "telegram",
      summary: { blue_to_red: ["AAPL"] },
    });

    expect(events.map((event) => event.eventType)).toContain("telegram_confirmation_requested");
  });
});
