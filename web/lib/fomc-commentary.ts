import type { FomcCommentaryItem } from "@/lib/api";

export type FomcCommentaryMeetingGroup = {
  meetingDate: string;
  rateDecision: string | null;
  items: FomcCommentaryItem[];
};

function eventPriority(item: FomcCommentaryItem): number {
  return item.eventType === "press_conference" ? 0 : 1;
}

export function groupFomcCommentaryItems(
  items: FomcCommentaryItem[],
  meetingLimit = 2,
): FomcCommentaryMeetingGroup[] {
  const sorted = [...items].sort((left, right) => (
    right.meetingDate.localeCompare(left.meetingDate)
    || eventPriority(left) - eventPriority(right)
    || String(right.generatedAt ?? "").localeCompare(String(left.generatedAt ?? ""))
  ));
  const groups = new Map<string, FomcCommentaryMeetingGroup>();
  for (const item of sorted) {
    const existing = groups.get(item.meetingDate);
    if (existing) {
      existing.items.push(item);
      existing.rateDecision ??= item.rateDecision;
      continue;
    }
    if (groups.size >= Math.max(1, meetingLimit)) continue;
    groups.set(item.meetingDate, {
      meetingDate: item.meetingDate,
      rateDecision: item.rateDecision,
      items: [item],
    });
  }
  return Array.from(groups.values());
}
