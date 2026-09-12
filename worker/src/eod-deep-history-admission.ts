import { eodHash } from "./eod-publication-service";

export const EOD_DEEP_HISTORY_MAX_SECURITIES = 4;
export const EOD_DEEP_HISTORY_MAX_OBSERVATIONS = 2_500;
const weekPrefix = "eod-deep-history-week:", policyPrefix = "eod-deep-history-policy:";
const dayMs = 86_400_000;
type Limits = { maxSecurities: number; maxObservations: number };
type Claim = { ticker: string; dates: string[] };
export type EodDeepHistoryBudget = Limits & { version: 1; weekStart: string; nextAttemptAt: string;
  policyHash: string; startAfter: string | null; lastTicker: string | null; claims: Claim[];
  observations: number; updatedAt: string; evidenceHash: string };
type Policy = Limits & { version: 1; effectiveWeek: string; registeredAt: string; evidenceHash: string };
export type EodDeepHistoryAdmission = { admitted: boolean; reason: "admitted" | "weekly-history-budget-deferred" | "history-request-exceeds-weekly-capacity";
  budget: EodDeepHistoryBudget };
function fail(reason: string): never { throw new Error(`eod-deep-history-${reason}`); }
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;
const tickerValid = (value: string) => /^[A-Z0-9^][A-Z0-9.^=_/-]{0,39}$/.test(value);
const limitsValid = (value: Limits) => Number.isInteger(value.maxSecurities) && value.maxSecurities >= 1
  && value.maxSecurities <= EOD_DEEP_HISTORY_MAX_SECURITIES && Number.isInteger(value.maxObservations)
  && value.maxObservations >= 1 && value.maxObservations <= EOD_DEEP_HISTORY_MAX_OBSERVATIONS;
export function eodDeepHistoryWeek(now = new Date()): { weekStart: string; nextAttemptAt: string } {
  if (!Number.isFinite(now.getTime())) fail("clock-invalid");
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = midnight - ((now.getUTCDay() + 6) % 7) * dayMs;
  return { weekStart: new Date(start).toISOString().slice(0, 10), nextAttemptAt: new Date(start + 7 * dayMs).toISOString() };
}
async function signed<T extends object>(fields: T): Promise<T & { evidenceHash: string }> {
  return { ...fields, evidenceHash: await eodHash(fields) };
}
async function decode<T extends { evidenceHash: string }>(text: string): Promise<T> {
  let value: T;
  try { value = JSON.parse(text) as T; } catch { return fail("record-invalid"); }
  if (!value || typeof value !== "object") fail("record-invalid");
  const { evidenceHash, ...fields } = value;
  if (!/^[a-f0-9]{64}$/.test(evidenceHash) || await eodHash(fields) !== evidenceHash) fail("record-integrity");
  return value;
}
const read = (ops: D1Database, id: string) => ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
async function policy(ops: D1Database, weekStart: string): Promise<Policy> {
  const value = await ops.prepare("SELECT id,evidence_json FROM eod_rollout_evidence WHERE id>=? AND id<=? ORDER BY id DESC LIMIT 1")
    .bind(policyPrefix, `${policyPrefix}${weekStart}`).first<{id:string;evidence_json:string}>();
  if (!value) return signed({ version: 1 as const, effectiveWeek: "1970-01-05", registeredAt: "1970-01-05T00:00:00.000Z",
    maxSecurities: EOD_DEEP_HISTORY_MAX_SECURITIES, maxObservations: EOD_DEEP_HISTORY_MAX_OBSERVATIONS });
  const result = await decode<Policy>(value.evidence_json);
  if (result.version !== 1 || !limitsValid(result) || !validDate(result.effectiveWeek)
    || eodDeepHistoryWeek(new Date(result.effectiveWeek)).weekStart !== result.effectiveWeek || result.effectiveWeek > weekStart
    || value.id !== `${policyPrefix}${result.effectiveWeek}` || !Number.isFinite(Date.parse(result.registeredAt))) fail("policy-invalid");
  return result;
}
/** Only future weeks can change limits. A reduced limit may be restored up to
 * the fixed reviewed maxima; existing claims and historical policies never change. */
export async function storeEodDeepHistoryPolicy(ops: D1Database, input: Limits & { effectiveWeek: string }, now = new Date()): Promise<Policy> {
  if (!limitsValid(input) || !validDate(input.effectiveWeek) || input.effectiveWeek <= eodDeepHistoryWeek(now).weekStart
    || eodDeepHistoryWeek(new Date(input.effectiveWeek)).weekStart !== input.effectiveWeek) fail("future-policy-required");
  const id = `${policyPrefix}${input.effectiveWeek}`, existing = await read(ops, id);
  if (existing) {
    const old = await decode<Policy>(existing);
    if (old.effectiveWeek !== input.effectiveWeek || old.maxSecurities !== input.maxSecurities || old.maxObservations !== input.maxObservations) fail("policy-conflict");
    return old;
  }
  const value = await signed({ version: 1 as const, ...input, registeredAt: now.toISOString() });
  await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(id, JSON.stringify(value), now.toISOString()).run();
  const saved = await read(ops, id);
  if (saved !== JSON.stringify(value)) fail("policy-conflict");
  return value;
}
async function validateBudget(value: EodDeepHistoryBudget): Promise<void> {
  if (value.version !== 1 || !limitsValid(value) || !validDate(value.weekStart)
    || eodDeepHistoryWeek(new Date(value.weekStart)).weekStart !== value.weekStart
    || eodDeepHistoryWeek(new Date(value.weekStart)).nextAttemptAt !== value.nextAttemptAt
    || !/^[a-f0-9]{64}$/.test(value.policyHash) || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.startAfter !== null && !tickerValid(value.startAfter)) || (value.lastTicker !== null && !tickerValid(value.lastTicker))
    || !Array.isArray(value.claims) || value.claims.length > value.maxSecurities
    || new Set(value.claims.map(row => row.ticker)).size !== value.claims.length
    || value.claims.some(row => !tickerValid(row.ticker) || !Array.isArray(row.dates) || !row.dates.length
      || row.dates.some((date, index) => !validDate(date) || (index > 0 && row.dates[index - 1] >= date)))
    || value.observations !== value.claims.reduce((sum, row) => sum + row.dates.length, 0)
    || value.observations > value.maxObservations) fail("budget-invalid");
}
export async function loadEodDeepHistoryBudget(ops: D1Database, now = new Date()): Promise<EodDeepHistoryBudget> {
  const period = eodDeepHistoryWeek(now), selected = await policy(ops, period.weekStart), existing = await read(ops, `${weekPrefix}${period.weekStart}`);
  if (existing) {
    const value = await decode<EodDeepHistoryBudget>(existing); await validateBudget(value);
    if (value.weekStart !== period.weekStart || value.policyHash !== selected.evidenceHash
      || value.maxSecurities !== selected.maxSecurities || value.maxObservations !== selected.maxObservations) fail("budget-policy-mismatch");
    return value;
  }
  const prior = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id>=? AND id<? ORDER BY id DESC LIMIT 1")
    .bind(weekPrefix, `${weekPrefix}${period.weekStart}`).first<string>("evidence_json");
  let startAfter: string | null = null;
  if (prior) { const value = await decode<EodDeepHistoryBudget>(prior); await validateBudget(value); startAfter = value.lastTicker; }
  return signed({ version: 1 as const, ...period, maxSecurities: selected.maxSecurities, maxObservations: selected.maxObservations,
    policyHash: selected.evidenceHash, startAfter, lastTicker: startAfter, claims: [], observations: 0, updatedAt: now.toISOString() });
}
export function eodDeepHistoryCanFit(budget: EodDeepHistoryBudget, ticker: string, dates: string[]): boolean {
  const old = budget.claims.find(row => row.ticker === ticker), known = new Set(old?.dates ?? []);
  return Boolean(old || budget.claims.length < budget.maxSecurities)
    && budget.observations + dates.filter(date => !known.has(date)).length <= budget.maxObservations;
}
/** One bounded Ops row is the atomic capacity ledger. No failed call refunds a
 * claim. Lost responses and repeated/deeper requests reuse the exact date union. */
export async function admitEodDeepHistory(ops: D1Database, input: { ticker: string; dates: string[] }, now = new Date()): Promise<EodDeepHistoryAdmission> {
  eodDeepHistoryWeek(now);
  const dates = [...new Set(input.dates)].sort();
  if (!tickerValid(input.ticker) || !dates.length || dates.length > EOD_DEEP_HISTORY_MAX_OBSERVATIONS + 1 || dates.some(date => !validDate(date) || date > now.toISOString().slice(0, 10))) fail("request-invalid");
  for (let attempt = 0; attempt < 6; attempt++) {
    const budget = await loadEodDeepHistoryBudget(ops, now);
    if (dates.length > budget.maxObservations) return { admitted: false, reason: "history-request-exceeds-weekly-capacity", budget };
    if (!eodDeepHistoryCanFit(budget, input.ticker, dates)) return { admitted: false, reason: "weekly-history-budget-deferred", budget };
    const prior = budget.claims.find(row => row.ticker === input.ticker), combined = [...new Set([...(prior?.dates ?? []), ...dates])].sort();
    if (prior && combined.length === prior.dates.length) return { admitted: true, reason: "admitted", budget };
    const { evidenceHash: _oldHash, ...fields } = budget;
    const claims = [...budget.claims.filter(row => row.ticker !== input.ticker), { ticker: input.ticker, dates: combined }].sort((a, b) => a.ticker.localeCompare(b.ticker));
    const next = await signed({ ...fields, claims, observations: claims.reduce((sum, row) => sum + row.dates.length, 0),
      lastTicker: prior ? budget.lastTicker : input.ticker, updatedAt: now.toISOString() });
    const id = `${weekPrefix}${budget.weekStart}`, oldText = await read(ops, id), nextText = JSON.stringify(next);
    if (oldText && (await decode<EodDeepHistoryBudget>(oldText)).evidenceHash !== budget.evidenceHash) continue;
    const result = oldText
      ? await ops.prepare("UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id")
        .bind(nextText, now.toISOString(), id, oldText).all()
      : await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id")
        .bind(id, nextText, now.toISOString()).all();
    if (result.results.length === 1) return { admitted: true, reason: "admitted", budget: next };
  }
  return fail("admission-contended");
}
