/** Retry categories are explicit: a query estimate or storage fault cannot be
 * fixed by waiting for midnight. Provider throttling is not a D1 daily quota. */
export function eodFailurePolicy(message: string, now = new Date()) {
  if (/^eod-d1-query-budget-estimate-exceeded(?:;|$)/.test(message)
    || message === "eod-query-exceeds-bounded-reservation") {
    return { status: "failed", code: "query-estimate-exceeded", nextAttemptAt: null } as const;
  }
  if (/^(?:eod-(?:d1-)?capacity|d1-capacity)/.test(message) || /; d1-capacity-exhausted$/.test(message)) {
    return { status: "failed", code: "storage-capacity", nextAttemptAt: null } as const;
  }
  if (/^eod-(?:account-)?(?:daily-)?budget-exhausted$/.test(message)
    || /^eod-d1-budget-exhausted(?:;|$)/.test(message) || /(?:^|; )d1-quota-exhausted$/.test(message)) {
    return { status: "retrying", code: "daily-quota-exhausted",
      nextAttemptAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)).toISOString() } as const;
  }
  // A rolling allowance does not reset at midnight; re-evaluate as old usage
  // leaves the window. This also keeps it distinct in the admin interface.
  if (message === "eod-rolling-budget-exhausted") {
    return { status: "retrying", code: "rolling-quota-exhausted",
      nextAttemptAt: new Date(now.getTime() + 6 * 60 * 60_000).toISOString() } as const;
  }
  const provider = /^(?:alpaca|yahoo|provider)[-:]/.test(message);
  return { status: "retrying", code: provider ? "provider-error" : "runner-error",
    nextAttemptAt: new Date(now.getTime() + 15 * 60_000).toISOString() } as const;
}
