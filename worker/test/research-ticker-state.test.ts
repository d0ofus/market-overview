import { describe, expect, it } from "vitest";
import { resetResearchTickerTransientState } from "../src/research/ticker-state";

describe("research ticker transient state", () => {
  it("clears persisted cards, rankings, and deep dives when an attempt is retried or fails", () => {
    expect(resetResearchTickerTransientState()).toEqual({
      snapshotId: null,
      rankingRowId: null,
      workingJson: {},
    });
  });
});
