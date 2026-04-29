import type { Env } from "./types";

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK";
const DEFAULT_SEC_USER_AGENT = "market-command-centre/1.0 contact: admin@example.com";
const MS_PER_DAY = 86_400_000;

type CompanyTickerEntry = {
  cik_str?: number;
  ticker?: string;
  title?: string;
};

type SecFact = {
  val?: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  end?: string;
  start?: string;
  accn?: string;
};

type SecFactsResponse = {
  facts?: Record<string, Record<string, { units?: Record<string, SecFact[]> }>>;
};

type Issuer = {
  ticker: string;
  cik: string;
  companyName: string;
};

export type FundamentalIssuer = Issuer;

type MetricConfig = {
  label: string;
  tags: string[];
};

type MetricPoint = {
  value: number;
  fiscalYear: number;
  fiscalQuarter: number;
  periodEnd: string | null;
  filedAt: string | null;
  form: string | null;
  accession: string | null;
  sourceTag: string;
  derivation: string;
  warnings: string[];
};

export type FundamentalQuarterRow = {
  ticker: string;
  cik: string;
  companyName: string | null;
  fiscalYear: number;
  fiscalQuarter: number;
  periodEnd: string;
  filedAt: string | null;
  form: string | null;
  accession: string | null;
  currency: string;
  revenue: number | null;
  netIncome: number | null;
  revenueYoY: number | null;
  revenueQoQ: number | null;
  netIncomeYoY: number | null;
  netIncomeQoQ: number | null;
  revenueSourceTag: string | null;
  netIncomeSourceTag: string | null;
  derivation: string | null;
  warnings: string[];
};

export type FundamentalsPayload = {
  ticker: string;
  schemaReady: boolean;
  issuer: {
    ticker: string;
    cik: string;
    companyName: string;
    lastRefreshedAt: string | null;
    status: string | null;
    lastError: string | null;
  } | null;
  rows: FundamentalQuarterRow[];
  warning: string | null;
};

export type FundamentalsRefreshResult = {
  ticker: string;
  cik: string;
  companyName: string;
  refreshedAt: string;
  rowsUpserted: number;
  selectedQuarters: number;
  completePeriodsFound: number;
  derivedQ4Count: number;
  warningCount: number;
  warnings: string[];
  latestPeriodEnd: string | null;
  latestFiledAt: string | null;
  skipped?: boolean;
};

export type FundamentalsRefreshOptions = {
  maxRows?: number;
  onlyIfNewerThanPeriodEnd?: string | null;
};

const METRICS: Record<"revenue" | "netIncome", MetricConfig> = {
  revenue: {
    label: "Revenue",
    tags: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
  },
  netIncome: {
    label: "Net Income",
    tags: [
      "NetIncomeLoss",
      "ProfitLoss",
    ],
  },
};

let companyTickerCache:
  | {
    expiresAt: number;
    byTicker: Map<string, Issuer>;
  }
  | null = null;

function fundamentalsDb(env: Env): D1Database | null {
  return env.FUNDAMENTALS_DB ?? null;
}

function normalizeTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function toPaddedCik(value: string | number): string {
  return String(value ?? "").replace(/\D/g, "").padStart(10, "0");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDate(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedDateText(value: unknown): string | null {
  const text = dateText(value);
  const parsed = parseDate(text);
  if (parsed == null) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function durationDays(fact: SecFact): number | null {
  const start = parseDate(fact.start);
  const end = parseDate(fact.end);
  if (start == null || end == null || end < start) return null;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

function isQuarterDuration(fact: SecFact): boolean {
  const days = durationDays(fact);
  return days != null && days >= 70 && days <= 115;
}

function isAnnualDuration(fact: SecFact): boolean {
  const days = durationDays(fact);
  return days != null && days >= 330 && days <= 390;
}

function normalizeForm(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeFp(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function periodKey(fiscalYear: number, fiscalQuarter: number): string {
  return `${fiscalYear}-Q${fiscalQuarter}`;
}

function previousQuarterKey(fiscalYear: number, fiscalQuarter: number): string {
  if (fiscalQuarter === 1) return periodKey(fiscalYear - 1, 4);
  return periodKey(fiscalYear, fiscalQuarter - 1);
}

function yoyKey(fiscalYear: number, fiscalQuarter: number): string {
  return periodKey(fiscalYear - 1, fiscalQuarter);
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function roundPct(value: number | null): number | null {
  return isFiniteNumber(value) ? Number(value.toFixed(4)) : null;
}

function allMetricTags(): string[] {
  return Array.from(new Set(Object.values(METRICS).flatMap((metric) => metric.tags)));
}

function factsForTag(companyFactsJson: SecFactsResponse, tag: string): SecFact[] {
  const usdFacts = companyFactsJson.facts?.["us-gaap"]?.[tag]?.units?.USD;
  return Array.isArray(usdFacts) ? usdFacts : [];
}

function buildFiscalCalendar(companyFactsJson: SecFactsResponse) {
  const annualEnds = new Map<string, number>();
  const quarterEnds = new Map<string, number>();

  for (const tag of allMetricTags()) {
    for (const fact of factsForTag(companyFactsJson, tag)) {
      const end = normalizedDateText(fact.end);
      const endTime = parseDate(end);
      const form = normalizeForm(fact.form);
      const fp = normalizeFp(fact.fp);
      if (!end || endTime == null || !isFiniteNumber(fact.val)) continue;

      if (isQuarterDuration(fact) && /^10-[QK]/.test(form)) quarterEnds.set(end, endTime);
      if (fp === "FY" && /^10-K/.test(form) && isAnnualDuration(fact)) annualEnds.set(end, endTime);
    }
  }

  const annualPeriods = Array.from(annualEnds.entries())
    .map(([end, endTime]) => ({ end, endTime, fiscalYear: Number(end.slice(0, 4)) }))
    .sort((left, right) => left.endTime - right.endTime);
  const quarterPeriods = Array.from(quarterEnds.entries())
    .map(([end, endTime]) => ({ end, endTime }))
    .sort((left, right) => left.endTime - right.endTime);

  const periodsByEnd = new Map<string, { fiscalYear: number; fiscalQuarter: number }>();
  for (let index = 0; index < annualPeriods.length; index += 1) {
    const annual = annualPeriods[index];
    const previousAnnualEnd = annualPeriods[index - 1]?.endTime ?? Number.NEGATIVE_INFINITY;
    const inYearQuarterEnds = quarterPeriods
      .filter((quarter) => quarter.endTime > previousAnnualEnd && quarter.endTime <= annual.endTime)
      .map((quarter) => quarter.end)
      .filter((end) => end !== annual.end)
      .slice(0, 3);

    inYearQuarterEnds.forEach((end, quarterIndex) => {
      periodsByEnd.set(end, { fiscalYear: annual.fiscalYear, fiscalQuarter: quarterIndex + 1 });
    });
    periodsByEnd.set(annual.end, { fiscalYear: annual.fiscalYear, fiscalQuarter: 4 });
  }

  const latestAnnual = annualPeriods.at(-1);
  if (latestAnnual) {
    quarterPeriods
      .filter((quarter) => quarter.endTime > latestAnnual.endTime)
      .slice(0, 3)
      .forEach((quarter, quarterIndex) => {
        periodsByEnd.set(quarter.end, { fiscalYear: latestAnnual.fiscalYear + 1, fiscalQuarter: quarterIndex + 1 });
      });
  }

  return { periodsByEnd };
}

function chooseBetterFact(left: SecFact, right: SecFact): SecFact {
  const leftFiled = parseDate(left.filed) ?? 0;
  const rightFiled = parseDate(right.filed) ?? 0;
  if (rightFiled !== leftFiled) return rightFiled > leftFiled ? right : left;
  const leftAccession = String(left.accn ?? "");
  const rightAccession = String(right.accn ?? "");
  return rightAccession.localeCompare(leftAccession) > 0 ? right : left;
}

function factToPoint(fact: SecFact, tag: string, fiscalYear: number, fiscalQuarter: number, derivation = "direct"): MetricPoint {
  return {
    value: fact.val!,
    fiscalYear,
    fiscalQuarter,
    periodEnd: normalizedDateText(fact.end),
    filedAt: dateText(fact.filed),
    form: dateText(fact.form),
    accession: dateText(fact.accn),
    sourceTag: tag,
    derivation,
    warnings: [],
  };
}

function addPoint(points: Map<string, MetricPoint>, point: MetricPoint, metricLabel: string, warnings: string[]) {
  const key = periodKey(point.fiscalYear, point.fiscalQuarter);
  const existing = points.get(key);
  if (!existing) {
    points.set(key, point);
    return;
  }
  if (existing.sourceTag !== point.sourceTag) return;
  const selectedFact = chooseBetterFact(
    { val: existing.value, filed: existing.filedAt ?? undefined, accn: existing.accession ?? undefined },
    { val: point.value, filed: point.filedAt ?? undefined, accn: point.accession ?? undefined },
  );
  const selected = selectedFact.val === point.value && selectedFact.accn === point.accession ? point : existing;
  if (existing.value !== point.value) {
    warnings.push(`${metricLabel} duplicate conflict for ${key}; chose ${selected.sourceTag} filed ${selected.filedAt ?? "unknown"}.`);
  }
  points.set(key, selected);
}

function collectMetricPoints(companyFactsJson: SecFactsResponse, metricConfig: MetricConfig, fiscalCalendar: ReturnType<typeof buildFiscalCalendar>) {
  const points = new Map<string, MetricPoint>();
  const warnings: string[] = [];

  for (const tag of metricConfig.tags) {
    const directByKey = new Map<string, SecFact>();
    const annualByYear = new Map<string, SecFact>();
    for (const fact of factsForTag(companyFactsJson, tag)) {
      const end = normalizedDateText(fact.end);
      const period = end ? fiscalCalendar.periodsByEnd.get(end) : null;
      if (!isFiniteNumber(fact.val) || !end || !period) continue;
      const form = normalizeForm(fact.form);
      const fp = normalizeFp(fact.fp);

      if (isQuarterDuration(fact) && /^10-[QK]/.test(form)) {
        if (period.fiscalQuarter <= 3 && !/^10-Q/.test(form)) continue;
        if (period.fiscalQuarter === 4 && !/^10-K/.test(form)) continue;
        const key = periodKey(period.fiscalYear, period.fiscalQuarter);
        const existing = directByKey.get(key);
        directByKey.set(key, existing ? chooseBetterFact(existing, fact) : fact);
        continue;
      }

      if (fp === "FY" && /^10-K/.test(form) && isAnnualDuration(fact)) {
        const key = periodKey(period.fiscalYear, 4);
        const existing = annualByYear.get(key);
        annualByYear.set(key, existing ? chooseBetterFact(existing, fact) : fact);
      }
    }

    for (const [key, fact] of directByKey.entries()) {
      const fiscalYear = Number(key.slice(0, key.indexOf("-")));
      const fiscalQuarter = Number(key.slice(key.indexOf("Q") + 1));
      addPoint(points, factToPoint(fact, tag, fiscalYear, fiscalQuarter), metricConfig.label, warnings);
    }

    for (const [q4Key, annualFact] of annualByYear.entries()) {
      const fiscalYear = Number(q4Key.slice(0, q4Key.indexOf("-")));
      if (directByKey.has(q4Key) || points.has(q4Key)) continue;
      const q1 = directByKey.get(periodKey(fiscalYear, 1));
      const q2 = directByKey.get(periodKey(fiscalYear, 2));
      const q3 = directByKey.get(periodKey(fiscalYear, 3));
      if (!q1 || !q2 || !q3) continue;

      const derivedValue = annualFact.val! - q1.val! - q2.val! - q3.val!;
      const derivedPoint = factToPoint(
        { ...annualFact, val: derivedValue },
        tag,
        fiscalYear,
        4,
        "derived_q4_from_fy_minus_q1_q2_q3",
      );
      derivedPoint.warnings.push(`${metricConfig.label} Q4 derived from annual FY less Q1-Q3 using ${tag}.`);
      addPoint(points, derivedPoint, metricConfig.label, warnings);
    }
  }

  return { points, warnings };
}

export function parseSecCompanyFundamentals(ticker: string, issuer: Issuer, companyFactsJson: SecFactsResponse) {
  const fiscalCalendar = buildFiscalCalendar(companyFactsJson);
  const revenue = collectMetricPoints(companyFactsJson, METRICS.revenue, fiscalCalendar);
  const netIncome = collectMetricPoints(companyFactsJson, METRICS.netIncome, fiscalCalendar);
  const allKeys = new Set([...revenue.points.keys(), ...netIncome.points.keys()]);
  const allRows = Array.from(allKeys).map((key) => {
    const [fiscalYearText, quarterText] = key.split("-Q");
    const fiscalYear = Number(fiscalYearText);
    const fiscalQuarter = Number(quarterText);
    const revenuePoint = revenue.points.get(key) ?? null;
    const netIncomePoint = netIncome.points.get(key) ?? null;
    const warnings = [...(revenuePoint?.warnings ?? []), ...(netIncomePoint?.warnings ?? [])];
    if (!revenuePoint) warnings.push("Revenue missing.");
    if (!netIncomePoint) warnings.push("Net income missing.");
    return {
      ticker: normalizeTicker(ticker),
      cik: issuer.cik,
      companyName: issuer.companyName,
      fiscalYear,
      fiscalQuarter,
      key,
      periodEnd: revenuePoint?.periodEnd ?? netIncomePoint?.periodEnd ?? "",
      filedAt: revenuePoint?.filedAt ?? netIncomePoint?.filedAt ?? null,
      form: revenuePoint?.form ?? netIncomePoint?.form ?? null,
      accession: revenuePoint?.accession ?? netIncomePoint?.accession ?? null,
      currency: "USD",
      revenue: revenuePoint?.value ?? null,
      netIncome: netIncomePoint?.value ?? null,
      revenueYoY: null as number | null,
      revenueQoQ: null as number | null,
      netIncomeYoY: null as number | null,
      netIncomeQoQ: null as number | null,
      revenueSourceTag: revenuePoint?.sourceTag ?? null,
      netIncomeSourceTag: netIncomePoint?.sourceTag ?? null,
      derivation: Array.from(new Set([revenuePoint?.derivation, netIncomePoint?.derivation].filter(Boolean))).join(" | ") || null,
      warnings,
      _periodTime: parseDate(revenuePoint?.periodEnd ?? netIncomePoint?.periodEnd) ?? 0,
    };
  });

  const byKey = new Map(allRows.map((row) => [row.key, row]));
  for (const row of allRows) {
    const sameQuarterLastYear = byKey.get(yoyKey(row.fiscalYear, row.fiscalQuarter));
    const previousQuarter = byKey.get(previousQuarterKey(row.fiscalYear, row.fiscalQuarter));
    row.revenueYoY = roundPct(pctChange(row.revenue, sameQuarterLastYear?.revenue ?? null));
    row.revenueQoQ = roundPct(pctChange(row.revenue, previousQuarter?.revenue ?? null));
    row.netIncomeYoY = roundPct(pctChange(row.netIncome, sameQuarterLastYear?.netIncome ?? null));
    row.netIncomeQoQ = roundPct(pctChange(row.netIncome, previousQuarter?.netIncome ?? null));
  }

  const rows = allRows
    .filter((row) => row.periodEnd)
    .sort((left, right) => {
      if (right._periodTime !== left._periodTime) return right._periodTime - left._periodTime;
      if (right.fiscalYear !== left.fiscalYear) return right.fiscalYear - left.fiscalYear;
      return right.fiscalQuarter - left.fiscalQuarter;
    });
  const completePeriodsFound = rows.filter((row) => isFiniteNumber(row.revenue) && isFiniteNumber(row.netIncome)).length;
  const warnings = [...revenue.warnings, ...netIncome.warnings, ...rows.flatMap((row) => row.warnings)];

  return {
    rows: rows.map(({ key, _periodTime, ...row }) => row satisfies FundamentalQuarterRow),
    completePeriodsFound,
    derivedQ4Count: rows.filter((row) => String(row.derivation ?? "").includes("derived_q4")).length,
    warnings,
  };
}

async function fetchJson<T>(url: string, env: Env, label: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": env.SEC_USER_AGENT?.trim() || DEFAULT_SEC_USER_AGENT,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

export async function loadFundamentalIssuerMap(env: Env): Promise<Map<string, FundamentalIssuer>> {
  const now = Date.now();
  if (companyTickerCache && companyTickerCache.expiresAt > now) return companyTickerCache.byTicker;
  const json = await fetchJson<Record<string, CompanyTickerEntry>>(COMPANY_TICKERS_URL, env, "SEC company tickers");
  const byTicker = new Map<string, Issuer>();
  for (const entry of Object.values(json ?? {})) {
    const ticker = normalizeTicker(entry?.ticker ?? "");
    const cik = entry?.cik_str == null ? "" : toPaddedCik(entry.cik_str);
    const companyName = String(entry?.title ?? "").trim();
    if (!ticker || !cik || !companyName) continue;
    byTicker.set(ticker, { ticker, cik, companyName });
  }
  companyTickerCache = { expiresAt: now + (6 * 60 * 60_000), byTicker };
  return byTicker;
}

export async function resolveFundamentalIssuer(ticker: string, env: Env): Promise<FundamentalIssuer | null> {
  const map = await loadFundamentalIssuerMap(env);
  return map.get(normalizeTicker(ticker)) ?? null;
}

async function hasFundamentalsSchema(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name IN ('fundamental_issuers', 'fundamental_quarters')",
  ).first<{ count: number }>();
  return Number(row?.count ?? 0) >= 2;
}

function decodeWarnings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function loadTickerFundamentals(env: Env, tickerInput: string, quarters = 8): Promise<FundamentalsPayload> {
  const ticker = normalizeTicker(tickerInput);
  const db = fundamentalsDb(env);
  if (!db) {
    return {
      ticker,
      schemaReady: false,
      issuer: null,
      rows: [],
      warning: "FUNDAMENTALS_DB binding is not configured.",
    };
  }
  if (!(await hasFundamentalsSchema(db))) {
    return {
      ticker,
      schemaReady: false,
      issuer: null,
      rows: [],
      warning: "Fundamentals schema is missing. Apply worker/fundamentals-migrations/0001_fundamentals.sql.",
    };
  }

  const issuer = await db.prepare(
    `SELECT ticker, cik, company_name as companyName, status, last_refreshed_at as lastRefreshedAt, last_error as lastError
     FROM fundamental_issuers WHERE ticker = ? LIMIT 1`,
  ).bind(ticker).first<{
    ticker: string;
    cik: string;
    companyName: string;
    status: string | null;
    lastRefreshedAt: string | null;
    lastError: string | null;
  }>();

  const limit = Math.max(1, Math.min(40, Number(quarters || 8)));
  const rowsResult = await db.prepare(
    `SELECT
      fq.ticker,
      fq.cik,
      fi.company_name as companyName,
      fq.fiscal_year as fiscalYear,
      fq.fiscal_quarter as fiscalQuarter,
      fq.period_end as periodEnd,
      fq.filed_at as filedAt,
      fq.form,
      fq.accession,
      fq.currency,
      fq.revenue,
      fq.net_income as netIncome,
      fq.revenue_yoy as revenueYoY,
      fq.revenue_qoq as revenueQoQ,
      fq.net_income_yoy as netIncomeYoY,
      fq.net_income_qoq as netIncomeQoQ,
      fq.revenue_source_tag as revenueSourceTag,
      fq.net_income_source_tag as netIncomeSourceTag,
      fq.derivation,
      fq.warnings_json as warningsJson
     FROM fundamental_quarters fq
     LEFT JOIN fundamental_issuers fi ON fi.ticker = fq.ticker
     WHERE fq.ticker = ?
     ORDER BY fq.period_end DESC
     LIMIT ?`,
  ).bind(ticker, limit).all<{
    ticker: string;
    cik: string;
    companyName: string | null;
    fiscalYear: number;
    fiscalQuarter: number;
    periodEnd: string;
    filedAt: string | null;
    form: string | null;
    accession: string | null;
    currency: string;
    revenue: number | null;
    netIncome: number | null;
    revenueYoY: number | null;
    revenueQoQ: number | null;
    netIncomeYoY: number | null;
    netIncomeQoQ: number | null;
    revenueSourceTag: string | null;
    netIncomeSourceTag: string | null;
    derivation: string | null;
    warningsJson: string | null;
  }>();

  const rows = (rowsResult.results ?? [])
    .map((row) => ({
      ...row,
      warnings: decodeWarnings(row.warningsJson),
    }))
    .map(({ warningsJson, ...row }) => row)
    .reverse();

  return {
    ticker,
    schemaReady: true,
    issuer: issuer ? {
      ticker: issuer.ticker,
      cik: issuer.cik,
      companyName: issuer.companyName,
      lastRefreshedAt: issuer.lastRefreshedAt,
      status: issuer.status,
      lastError: issuer.lastError,
    } : null,
    rows,
    warning: rows.length === 0 ? "No cached SEC fundamentals found for this ticker." : null,
  };
}

export async function loadLatestCachedFundamentalPeriod(env: Env, tickerInput: string): Promise<{ periodEnd: string | null; filedAt: string | null } | null> {
  const ticker = normalizeTicker(tickerInput);
  const db = fundamentalsDb(env);
  if (!db || !(await hasFundamentalsSchema(db))) return null;
  const row = await db.prepare(
    `SELECT period_end as periodEnd, filed_at as filedAt
     FROM fundamental_quarters
     WHERE ticker = ?
     ORDER BY period_end DESC
     LIMIT 1`,
  ).bind(ticker).first<{ periodEnd: string | null; filedAt: string | null }>();
  return row ?? null;
}

function latestParsedRow(rows: FundamentalQuarterRow[]): FundamentalQuarterRow | null {
  return rows[0] ?? null;
}

function normalizeMaxRows(value: number | null | undefined): number {
  return Math.max(1, Math.min(40, Number(value ?? 16)));
}

export async function refreshTickerFundamentals(
  env: Env,
  tickerInput: string,
  options: FundamentalsRefreshOptions = {},
): Promise<FundamentalsRefreshResult> {
  const ticker = normalizeTicker(tickerInput);
  const db = fundamentalsDb(env);
  if (!db) throw new Error("FUNDAMENTALS_DB binding is not configured.");
  if (!(await hasFundamentalsSchema(db))) {
    throw new Error("Fundamentals schema is missing. Apply worker/fundamentals-migrations/0001_fundamentals.sql.");
  }

  const issuer = await resolveFundamentalIssuer(ticker, env);
  if (!issuer) throw new Error(`SEC issuer mapping was not found for ${ticker}.`);

  const refreshedAt = new Date().toISOString();
  try {
    const companyFacts = await fetchJson<SecFactsResponse>(`${COMPANY_FACTS_URL}${issuer.cik}.json`, env, `SEC companyfacts for ${ticker}`);
    const parsed = parseSecCompanyFundamentals(ticker, issuer, companyFacts);
    const latest = latestParsedRow(parsed.rows);
    const latestPeriodEnd = latest?.periodEnd ?? null;
    const latestFiledAt = latest?.filedAt ?? null;
    const onlyIfNewerThan = options.onlyIfNewerThanPeriodEnd ?? null;
    if (onlyIfNewerThan && latestPeriodEnd && latestPeriodEnd <= onlyIfNewerThan) {
      return {
        ticker,
        cik: issuer.cik,
        companyName: issuer.companyName,
        refreshedAt,
        rowsUpserted: 0,
        selectedQuarters: 0,
        completePeriodsFound: 0,
        derivedQ4Count: 0,
        warningCount: parsed.warnings.length,
        warnings: parsed.warnings,
        latestPeriodEnd,
        latestFiledAt,
        skipped: true,
      };
    }

    const maxRows = normalizeMaxRows(options.maxRows);
    const selectedRows = parsed.rows.slice(0, maxRows);

    const statements = [
      db.prepare(
        `INSERT INTO fundamental_issuers (ticker, cik, company_name, status, last_refreshed_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, 'ok', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(ticker) DO UPDATE SET
           cik = excluded.cik,
           company_name = excluded.company_name,
           status = 'ok',
           last_refreshed_at = excluded.last_refreshed_at,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(ticker, issuer.cik, issuer.companyName, refreshedAt),
      ...selectedRows.map((row) => db.prepare(
        `INSERT INTO fundamental_quarters (
          ticker, cik, fiscal_year, fiscal_quarter, period_end, filed_at, form, accession, currency,
          revenue, net_income, revenue_yoy, revenue_qoq, net_income_yoy, net_income_qoq,
          revenue_source_tag, net_income_source_tag, derivation, warnings_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(ticker, fiscal_year, fiscal_quarter, period_end) DO UPDATE SET
          cik = excluded.cik,
          filed_at = excluded.filed_at,
          form = excluded.form,
          accession = excluded.accession,
          currency = excluded.currency,
          revenue = excluded.revenue,
          net_income = excluded.net_income,
          revenue_yoy = excluded.revenue_yoy,
          revenue_qoq = excluded.revenue_qoq,
          net_income_yoy = excluded.net_income_yoy,
          net_income_qoq = excluded.net_income_qoq,
          revenue_source_tag = excluded.revenue_source_tag,
          net_income_source_tag = excluded.net_income_source_tag,
          derivation = excluded.derivation,
          warnings_json = excluded.warnings_json,
          updated_at = CURRENT_TIMESTAMP`,
      ).bind(
        row.ticker,
        row.cik,
        row.fiscalYear,
        row.fiscalQuarter,
        row.periodEnd,
        row.filedAt,
        row.form,
        row.accession,
        row.currency,
        row.revenue,
        row.netIncome,
        row.revenueYoY,
        row.revenueQoQ,
        row.netIncomeYoY,
        row.netIncomeQoQ,
        row.revenueSourceTag,
        row.netIncomeSourceTag,
        row.derivation,
        JSON.stringify(row.warnings),
      )),
      db.prepare(
        `DELETE FROM fundamental_quarters
         WHERE ticker = ?
           AND rowid NOT IN (
             SELECT rowid FROM fundamental_quarters
             WHERE ticker = ?
             ORDER BY period_end DESC
             LIMIT ?
           )`,
      ).bind(ticker, ticker, maxRows),
    ];
    await db.batch(statements);

    return {
      ticker,
      cik: issuer.cik,
      companyName: issuer.companyName,
      refreshedAt,
      rowsUpserted: selectedRows.length,
      selectedQuarters: Math.min(8, selectedRows.length),
      completePeriodsFound: selectedRows.filter((row) => isFiniteNumber(row.revenue) && isFiniteNumber(row.netIncome)).length,
      derivedQ4Count: selectedRows.filter((row) => String(row.derivation ?? "").includes("derived_q4")).length,
      warningCount: parsed.warnings.length,
      warnings: parsed.warnings,
      latestPeriodEnd,
      latestFiledAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh fundamentals.";
    await db.prepare(
      `INSERT INTO fundamental_issuers (ticker, cik, company_name, status, last_refreshed_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'error', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(ticker) DO UPDATE SET
         status = 'error',
         last_refreshed_at = excluded.last_refreshed_at,
         last_error = excluded.last_error,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(ticker, issuer.cik, issuer.companyName, refreshedAt, message).run();
    throw error;
  }
}
