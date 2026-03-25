export type ResearchActivityLevel = "info" | "warn" | "error";

export type ResearchActivityEntry = {
  at: string;
  level: ResearchActivityLevel;
  message: string;
};

const RESEARCH_ACTIVITY_LOG_LIMIT = 16;

function readActivityEntries(value: unknown): ResearchActivityEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<ResearchActivityEntry> | null | undefined;
      const message = typeof record?.message === "string" ? record.message.trim() : "";
      if (!message) return null;
      return {
        at: typeof record?.at === "string" && record.at.trim() ? record.at : new Date().toISOString(),
        level: record?.level === "warn" || record?.level === "error" ? record.level : "info",
        message,
      } satisfies ResearchActivityEntry;
    })
    .filter((item): item is ResearchActivityEntry => Boolean(item));
}

export function appendActivityPayload(
  payload: Record<string, unknown> | null | undefined,
  input: { message: string; level?: ResearchActivityLevel; at?: string },
  key = "activity",
): Record<string, unknown> {
  const at = input.at ?? new Date().toISOString();
  const entry: ResearchActivityEntry = {
    at,
    level: input.level ?? "info",
    message: input.message,
  };
  const existing = readActivityEntries((payload as { [key: string]: unknown } | null | undefined)?.[key]);
  return {
    ...(payload ?? {}),
    [key]: [...existing, entry].slice(-RESEARCH_ACTIVITY_LOG_LIMIT),
    lastActivityAt: at,
    lastActivityLevel: entry.level,
    lastActivityMessage: entry.message,
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function buildStaleRecoveryMessage(status: string, heartbeatAgeMs: number, attemptCount: number, maxAttempts: number): string {
  const nextAttempt = Math.min(attemptCount + 1, maxAttempts);
  return `Recovered stale ${humanizeStatus(status)} state after ${formatDuration(heartbeatAgeMs)} without a heartbeat; retrying attempt ${nextAttempt} of ${maxAttempts}.`;
}

export function buildStaleFailureMessage(status: string, heartbeatAgeMs: number, attemptCount: number, maxAttempts: number): string {
  return `Ticker processing became stale during ${humanizeStatus(status)} after ${formatDuration(heartbeatAgeMs)} without a heartbeat and exceeded the retry limit (${attemptCount}/${maxAttempts}).`;
}
