import { describe, expect, it } from "vitest";
import { appendActivityPayload, buildStaleFailureMessage, buildStaleRecoveryMessage } from "../src/research/progress";

describe("research progress helpers", () => {
  it("appends and truncates activity entries", () => {
    let payload: Record<string, unknown> | null = null;
    for (let index = 0; index < 20; index += 1) {
      payload = appendActivityPayload(payload, {
        message: `event-${index}`,
        at: `2026-03-25T10:00:${String(index).padStart(2, "0")}Z`,
      });
    }

    const activity = Array.isArray(payload?.activity) ? payload.activity as Array<{ message: string }> : [];
    expect(activity).toHaveLength(16);
    expect(activity[0]?.message).toBe("event-4");
    expect(activity.at(-1)?.message).toBe("event-19");
    expect(payload?.lastActivityMessage).toBe("event-19");
  });

  it("builds descriptive stale recovery and failure messages", () => {
    expect(buildStaleRecoveryMessage("extracting", 95_000, 1, 3)).toContain("retrying attempt 2 of 3");
    expect(buildStaleRecoveryMessage("extracting", 95_000, 1, 3)).toContain("extracting");
    expect(buildStaleFailureMessage("retrieving", 130_000, 3, 3)).toContain("exceeded the retry limit (3/3)");
    expect(buildStaleFailureMessage("retrieving", 130_000, 3, 3)).toContain("retrieving");
  });
});
