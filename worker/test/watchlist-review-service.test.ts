import { describe, expect, it } from "vitest";
import {
  assertWatchlistReviewApplySetReady,
  buildWatchlistReviewCanonicalApplySet,
  buildWatchlistReviewExportPayload,
  checksumWatchlistReviewApplySet,
  normalizeWatchlistReviewImport,
  signWatchlistReviewWebhook,
  watchlistReviewExportCsv,
} from "../src/watchlist-review-service";

const NOW = "2026-06-12T14:00:00.000Z";

describe("watchlist review service helpers", () => {
  it("normalizes Hermes review-run imports and preserves compiler linkage", () => {
    const normalized = normalizeWatchlistReviewImport({
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
  });
});
