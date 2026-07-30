import assert from "node:assert/strict";
import test from "node:test";
import type { FomcCommentaryItem } from "@/lib/api";
import { groupFomcCommentaryItems } from "@/lib/fomc-commentary";

function commentaryItem(
  id: string,
  eventType: FomcCommentaryItem["eventType"],
  meetingDate: string,
  releaseDate: string,
): FomcCommentaryItem {
  return {
    id,
    eventType,
    meetingDate,
    releaseDate,
    sourceUrl: `https://www.federalreserve.gov/${id}`,
    sourceTitle: null,
    statementUrl: null,
    transcriptUrl: eventType === "press_conference" ? `https://www.federalreserve.gov/${id}.pdf` : null,
    transcriptKind: eventType === "press_conference" ? "full_transcript" : null,
    rateDecision: "Held at 3.50%–3.75%",
    sourceMode: "official",
    status: "ready",
    summaryMarkdown: null,
    highlights: [],
    tradingReadThrough: null,
    citationSources: [],
    generatedAt: null,
    provider: "gemini",
    model: "gemini-test",
    error: null,
  };
}

test("groups FOMC commentary by descending meeting date, not release date", () => {
  const groups = groupFomcCommentaryItems([
    commentaryItem("june-minutes", "minutes", "2026-06-17", "2026-07-30"),
    commentaryItem("april-press", "press_conference", "2026-04-29", "2026-04-29"),
    commentaryItem("july-press", "press_conference", "2026-07-29", "2026-07-29"),
    commentaryItem("june-press", "press_conference", "2026-06-17", "2026-06-17"),
  ], 2);

  assert.deepEqual(groups.map((group) => group.meetingDate), ["2026-07-29", "2026-06-17"]);
  assert.deepEqual(groups[1]?.items.map((item) => item.eventType), ["press_conference", "minutes"]);
});
