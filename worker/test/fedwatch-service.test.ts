import { describe, expect, it } from "vitest";
import {
  isSnapshotFresh,
  normalizeRateProbabilityPayload,
} from "../src/fedwatch-service";

describe("fed funds rate service helpers", () => {
  it("normalizes the RateProbability latest payload into summary rows and comparison series", () => {
    const payload = {
      today: {
        as_of: "2026-03-23",
        "current band": "3.50 - 3.75",
        midpoint: 3.625,
        most_recent_effr: 3.64,
        assumed_move_bps: 25,
        rows: [
          {
            meeting: "Apr 29, 2026",
            meeting_iso: "2026-04-29",
            implied_rate_post_meeting: 3.65,
            prob_move_pct: 10,
            prob_is_cut: false,
            num_moves: 0.1,
            num_moves_is_cut: false,
            change_bps: 2.5,
          },
          {
            meeting: "Jun 17, 2026",
            meeting_iso: "2026-06-17",
            implied_rate_post_meeting: 3.66,
            prob_move_pct: 4,
            prob_is_cut: false,
            num_moves: 0.14,
            num_moves_is_cut: false,
            change_bps: 3.5,
          },
        ],
      },
      ago_1w: {
        used_date: "2026-03-16",
        effr: 3.64,
        label: "1w ago (2026-03-16)",
        rows: [
          { meeting: "Mar 18, 2026", meeting_iso: "2026-03-18", implied: 3.623 },
          { meeting: "Apr 29, 2026", meeting_iso: "2026-04-29", implied: 3.625 },
        ],
      },
      ago_3w: {
        used_date: "2026-03-02",
        effr: 3.64,
        label: "3w ago (2026-03-02)",
        rows: [
          { meeting: "Mar 18, 2026", meeting_iso: "2026-03-18", implied: 3.62 },
        ],
      },
    };

    const normalized = normalizeRateProbabilityPayload(payload, "2026-03-24T00:00:00.000Z");

    expect(normalized?.sourceUrl).toBe("https://rateprobability.com/fed");
    expect(normalized?.currentBand).toBe("3.50 - 3.75");
    expect(normalized?.midpoint).toBe(3.625);
    expect(normalized?.rows).toHaveLength(2);
    expect(normalized?.rows[0]?.meetingIso).toBe("2026-04-29");
    expect(normalized?.rows[0]?.probIsCut).toBe(false);
    expect(normalized?.comparisons).toHaveLength(2);
    expect(normalized?.comparisons[0]?.key).toBe("ago_1w");
    expect(normalized?.comparisons[0]?.rows[1]?.implied).toBe(3.625);
  });

  it("returns null when required current rows are missing", () => {
    expect(normalizeRateProbabilityPayload({ today: { rows: [] } }, "2026-03-24T00:00:00.000Z")).toBeNull();
  });

  it("treats recent snapshots as fresh on an hourly cache window", () => {
    const freshAt = new Date().toISOString();
    const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

    expect(isSnapshotFresh(freshAt)).toBe(true);
    expect(isSnapshotFresh(staleAt)).toBe(false);
  });
});
