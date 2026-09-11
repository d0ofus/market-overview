export type EodBudgetProfileName = "free" | "paid";
export type EodBudgetProfile = {
  name: EodBudgetProfileName;
  eodDaily: { reads: number; writes: number };
  accountDaily: { reads: number; writes: number };
  rolling31: { reads: number; writes: number } | null;
  runtime: { httpCpuMs: number; coordinatorCpuMs: number; queriesPerInvocation: number; queryDurationMs: number };
};
const profiles: Record<EodBudgetProfileName, EodBudgetProfile> = {
  free: { name: "free", eodDaily: { reads: 2_500_000, writes: 50_000 },
    accountDaily: { reads: 4_500_000, writes: 90_000 }, rolling31: null,
    runtime: { httpCpuMs: 10, coordinatorCpuMs: 10, queriesPerInvocation: 50, queryDurationMs: 30_000 } },
  paid: { name: "paid", eodDaily: { reads: 1_000_000_000, writes: 8_000_000 },
    accountDaily: { reads: 1_500_000_000, writes: 10_000_000 }, rolling31: { reads: 20_000_000_000, writes: 35_000_000 },
    runtime: { httpCpuMs: 1_000, coordinatorCpuMs: 1_000, queriesPerInvocation: 300, queryDurationMs: 30_000 } },
};
/** Explicit configuration only. Paid is an application spending ceiling, not
 * permission to change storage layout or infer the Cloudflare billing plan. */
export function resolveEodBudgetProfile(value?: string): EodBudgetProfile {
  const name = value?.trim() || "free";
  if (name !== "free" && name !== "paid") throw new Error("eod-budget-profile-invalid");
  return profiles[name];
}
export function eodBudgetWindow(now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  return { start: new Date(Date.parse(`${end}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10), end,
    freshAfter: new Date(now.getTime() - 300_000).toISOString(), now: now.toISOString() };
}
export type EodRollingUsage = { windowStart: string; windowEnd: string; sampledAt: string;
  rowsRead: number; rowsWritten: number; reservedReads: number; reservedWrites: number };

export async function loadEodRollingUsage(ops: D1Database, profile: EodBudgetProfile, now = new Date()): Promise<EodRollingUsage | null> {
  if (!profile.rolling31) return null;
  const window = eodBudgetWindow(now);
  const row = await ops.prepare(`SELECT COUNT(*) AS days,MIN(a.sampled_at) AS sampledAt,
    SUM(CASE WHEN a.error IS NULL AND a.sampled_at>=? AND a.sampled_at<=? AND date(a.usage_date)=a.usage_date
      AND a.rows_read>=0 AND a.rows_written>=0 AND COALESCE(l.rows_read,0)>=0 AND COALESCE(l.rows_written,0)>=0
      AND COALESCE(e.reserved_reads,0)>=0 AND COALESCE(e.reserved_writes,0)>=0 THEN 1 ELSE 0 END) AS freshDays,
    SUM(MAX(a.rows_read,COALESCE(l.rows_read,0))) AS rowsRead,SUM(MAX(a.rows_written,COALESCE(l.rows_written,0))) AS rowsWritten,
    SUM(COALESCE(e.reserved_reads,0)) AS reservedReads,SUM(COALESCE(e.reserved_writes,0)) AS reservedWrites
    FROM eod_account_usage a LEFT JOIN market_data_daily_usage l ON l.usage_date=a.usage_date
    LEFT JOIN eod_usage e ON e.usage_date=a.usage_date WHERE a.usage_date>=? AND a.usage_date<=?`)
    .bind(window.freshAfter, window.now, window.start, window.end)
    .first<{ days: number; freshDays: number; sampledAt: string; rowsRead: number; rowsWritten: number; reservedReads: number; reservedWrites: number }>();
  if (!row || row.days !== 31 || row.freshDays !== 31
    || ![row.rowsRead,row.rowsWritten,row.reservedReads,row.reservedWrites].every((value) => Number.isSafeInteger(value) && value>=0)) {
    throw new Error("eod-account-window-unavailable");
  }
  return { windowStart: window.start, windowEnd: window.end, sampledAt: row.sampledAt,
    rowsRead: row.rowsRead, rowsWritten: row.rowsWritten, reservedReads: row.reservedReads, reservedWrites: row.reservedWrites };
}
export async function assertEodRollingBudget(ops: D1Database, profile: EodBudgetProfile, now = new Date(),
  needed: { reads: number; writes: number } = { reads: 0, writes: 0 }): Promise<EodRollingUsage | null> {
  const usage = await loadEodRollingUsage(ops, profile, now);
  if (usage && profile.rolling31 && (usage.rowsRead+usage.reservedReads+needed.reads>profile.rolling31.reads
    || usage.rowsWritten+usage.reservedWrites+needed.writes>profile.rolling31.writes)) throw new Error("eod-rolling-budget-exhausted");
  return usage;
}

/** Cheap cached ledger reads only; a page poll never calls provider analytics or writes. */
export async function readEodBudgetStatus(ops: D1Database | undefined, profile: EodBudgetProfile, now = new Date()) {
  type Daily = { eodRowsRead: number | null; eodRowsWritten: number | null; reservedReads: number | null; reservedWrites: number | null;
    accountRowsRead: number | null; accountRowsWritten: number | null; sampledAt: string | null };
  const result: { profile: EodBudgetProfileName; limits: Omit<EodBudgetProfile, "name">; usageDate: string;
    daily: Daily | null; rolling31: EodRollingUsage | null; unavailableReason: string | null } = {
    profile: profile.name, limits: { eodDaily: profile.eodDaily, accountDaily: profile.accountDaily, rolling31: profile.rolling31, runtime: profile.runtime },
    usageDate: now.toISOString().slice(0, 10), daily: null, rolling31: null, unavailableReason: null,
  };
  if (!ops) { result.unavailableReason = "eod-ops-unbound"; return result; }
  try {
    const row = await ops.prepare(`SELECT e.rows_read AS eodRowsRead,e.rows_written AS eodRowsWritten,
      e.reserved_reads AS reservedReads,e.reserved_writes AS reservedWrites,
      MAX(a.rows_read,COALESCE(l.rows_read,0)) AS accountRowsRead,MAX(a.rows_written,COALESCE(l.rows_written,0)) AS accountRowsWritten,
      a.sampled_at AS sampledAt,a.error FROM (SELECT ? AS usage_date) d
      LEFT JOIN eod_usage e ON e.usage_date=d.usage_date LEFT JOIN eod_account_usage a ON a.usage_date=d.usage_date
      LEFT JOIN market_data_daily_usage l ON l.usage_date=d.usage_date`).bind(result.usageDate).first<Daily & { error: string | null }>();
    if (row) { const { error, ...daily } = row; result.daily = daily;
      const age = row.sampledAt ? now.getTime() - Date.parse(row.sampledAt) : NaN;
      if (error || !Number.isFinite(age) || age < 0 || age > 300_000 || row.accountRowsRead === null || row.accountRowsWritten === null) {
        result.unavailableReason = "eod-account-usage-unavailable";
      }
    } else result.unavailableReason = "eod-account-usage-unavailable";
    result.rolling31 = await loadEodRollingUsage(ops, profile, now);
  } catch { result.unavailableReason = profile.rolling31 ? "eod-account-window-unavailable" : "eod-account-usage-unavailable"; }
  return result;
}
