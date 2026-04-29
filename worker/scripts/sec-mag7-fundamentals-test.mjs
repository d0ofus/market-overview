#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAG7_TICKERS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"];
const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK";
const USER_AGENT = (process.env.SEC_USER_AGENT ?? "market-command-centre/1.0 contact: admin@example.com").trim();
const FETCH_DELAY_MS = Math.max(0, Number(process.env.SEC_FETCH_DELAY_MS ?? 150));
const MS_PER_DAY = 86_400_000;

const METRICS = {
  revenue: {
    label: "Revenue",
    outputKey: "revenue",
    tags: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
  },
  netIncome: {
    label: "Net Income",
    outputKey: "netIncome",
    tags: [
      "NetIncomeLoss",
      "ProfitLoss",
    ],
  },
};

const HEADERS = [
  "ticker",
  "companyName",
  "cik",
  "fiscalYear",
  "fiscalQuarter",
  "periodEnd",
  "filedAt",
  "form",
  "accession",
  "revenue",
  "netIncome",
  "revenueYoY",
  "revenueQoQ",
  "netIncomeYoY",
  "netIncomeQoQ",
  "revenueSourceTag",
  "netIncomeSourceTag",
  "derivation",
  "warnings",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPaddedCik(value) {
  return String(value ?? "").replace(/\D/g, "").padStart(10, "0");
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDate(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedDateText(value) {
  const text = dateText(value);
  const parsed = parseDate(text);
  if (parsed == null) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function durationDays(fact) {
  const start = parseDate(fact.start);
  const end = parseDate(fact.end);
  if (start == null || end == null || end < start) return null;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

function isQuarterDuration(fact) {
  const days = durationDays(fact);
  return days != null && days >= 70 && days <= 115;
}

function isAnnualDuration(fact) {
  const days = durationDays(fact);
  return days != null && days >= 330 && days <= 390;
}

function normalizeForm(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeFp(value) {
  return String(value ?? "").trim().toUpperCase();
}

function periodKey(fiscalYear, fiscalQuarter) {
  return `${fiscalYear}-Q${fiscalQuarter}`;
}

function previousQuarterKey(fiscalYear, fiscalQuarter) {
  if (fiscalQuarter === 1) return periodKey(fiscalYear - 1, 4);
  return periodKey(fiscalYear, fiscalQuarter - 1);
}

function yoyKey(fiscalYear, fiscalQuarter) {
  return periodKey(fiscalYear - 1, fiscalQuarter);
}

function formatNumber(value) {
  return isFiniteNumber(value) ? String(Math.round(value)) : "";
}

function formatPct(value) {
  return isFiniteNumber(value) ? value.toFixed(4) : "";
}

function pctChange(current, previous) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function quoteCsv(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.join(" | ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function rowToCsv(row) {
  return HEADERS.map((header) => quoteCsv(row[header])).join(",");
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json();
}

function buildTickerMap(companyTickersJson) {
  const byTicker = new Map();
  for (const entry of Object.values(companyTickersJson ?? {})) {
    const ticker = String(entry?.ticker ?? "").trim().toUpperCase();
    const cik = entry?.cik_str == null ? "" : toPaddedCik(entry.cik_str);
    const companyName = String(entry?.title ?? "").trim();
    if (!ticker || !cik || !companyName) continue;
    byTicker.set(ticker, { ticker, cik, companyName });
  }
  return byTicker;
}

function factsForTag(companyFactsJson, tag) {
  const tagNode = companyFactsJson?.facts?.["us-gaap"]?.[tag];
  const usdFacts = tagNode?.units?.USD;
  return Array.isArray(usdFacts) ? usdFacts : [];
}

function allMetricTags() {
  return Array.from(new Set(Object.values(METRICS).flatMap((metric) => metric.tags)));
}

function buildFiscalCalendar(companyFactsJson) {
  const annualEnds = new Map();
  const quarterEnds = new Map();

  for (const tag of allMetricTags()) {
    for (const fact of factsForTag(companyFactsJson, tag)) {
      const end = normalizedDateText(fact.end);
      const endTime = parseDate(end);
      const form = normalizeForm(fact.form);
      const fp = normalizeFp(fact.fp);
      if (!end || endTime == null || !isFiniteNumber(fact.val)) continue;

      if (isQuarterDuration(fact) && /^10-[QK]/.test(form)) {
        quarterEnds.set(end, endTime);
      }

      if (fp === "FY" && /^10-K/.test(form) && isAnnualDuration(fact)) {
        annualEnds.set(end, endTime);
      }
    }
  }

  const annualPeriods = Array.from(annualEnds.entries())
    .map(([end, endTime]) => ({
      end,
      endTime,
      // For MAG7, the fiscal year is the calendar year in which the fiscal year ends.
      fiscalYear: Number(end.slice(0, 4)),
    }))
    .sort((left, right) => left.endTime - right.endTime);

  const quarterPeriods = Array.from(quarterEnds.entries())
    .map(([end, endTime]) => ({ end, endTime }))
    .sort((left, right) => left.endTime - right.endTime);

  const periodsByEnd = new Map();
  for (let index = 0; index < annualPeriods.length; index += 1) {
    const annual = annualPeriods[index];
    const previousAnnualEnd = annualPeriods[index - 1]?.endTime ?? Number.NEGATIVE_INFINITY;
    const inYearQuarterEnds = quarterPeriods
      .filter((quarter) => quarter.endTime > previousAnnualEnd && quarter.endTime <= annual.endTime)
      .map((quarter) => quarter.end)
      .filter((end) => end !== annual.end)
      .slice(0, 3);

    inYearQuarterEnds.forEach((end, quarterIndex) => {
      periodsByEnd.set(end, {
        fiscalYear: annual.fiscalYear,
        fiscalQuarter: quarterIndex + 1,
      });
    });

    periodsByEnd.set(annual.end, {
      fiscalYear: annual.fiscalYear,
      fiscalQuarter: 4,
    });
  }

  const latestAnnual = annualPeriods.at(-1);
  if (latestAnnual) {
    quarterPeriods
      .filter((quarter) => quarter.endTime > latestAnnual.endTime)
      .slice(0, 3)
      .forEach((quarter, quarterIndex) => {
        periodsByEnd.set(quarter.end, {
          fiscalYear: latestAnnual.fiscalYear + 1,
          fiscalQuarter: quarterIndex + 1,
        });
      });
  }

  return { periodsByEnd, annualPeriods };
}

function chooseBetterFact(left, right) {
  const leftFiled = parseDate(left.filed) ?? 0;
  const rightFiled = parseDate(right.filed) ?? 0;
  if (rightFiled !== leftFiled) return rightFiled > leftFiled ? right : left;
  const leftAccession = String(left.accn ?? "");
  const rightAccession = String(right.accn ?? "");
  return rightAccession.localeCompare(leftAccession) > 0 ? right : left;
}

function factToPoint(fact, tag, fiscalYear, fiscalQuarter, derivation = "direct") {
  return {
    value: fact.val,
    fiscalYear,
    fiscalQuarter,
    periodEnd: dateText(fact.end),
    filedAt: dateText(fact.filed),
    form: dateText(fact.form),
    accession: dateText(fact.accn),
    sourceTag: tag,
    derivation,
    warnings: [],
  };
}

function addPoint(points, point, metricLabel, warnings) {
  const key = periodKey(point.fiscalYear, point.fiscalQuarter);
  const existing = points.get(key);
  if (!existing) {
    points.set(key, point);
    return;
  }
  if (existing.sourceTag !== point.sourceTag) {
    return;
  }
  const selectedFact = chooseBetterFact(
    { val: existing.value, filed: existing.filedAt, accn: existing.accession },
    { val: point.value, filed: point.filedAt, accn: point.accession },
  );
  const selected = selectedFact.val === point.value && selectedFact.accn === point.accession ? point : existing;
  if (existing.value !== point.value) {
    warnings.push(`${metricLabel} duplicate conflict for ${key}; chose ${selected.sourceTag} filed ${selected.filedAt ?? "unknown"}.`);
  }
  points.set(key, selected);
}

function collectMetricPoints(companyFactsJson, metricConfig, fiscalCalendar) {
  const points = new Map();
  const warnings = [];

  for (const tag of metricConfig.tags) {
    const directByKey = new Map();
    const annualByYear = new Map();
    const tagFacts = factsForTag(companyFactsJson, tag);

    for (const fact of tagFacts) {
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

      const derivedValue = annualFact.val - q1.val - q2.val - q3.val;
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

function combineMetricRows(ticker, issuer, companyFactsJson) {
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
    const periodEnd = revenuePoint?.periodEnd ?? netIncomePoint?.periodEnd ?? null;
    const filedAt = revenuePoint?.filedAt ?? netIncomePoint?.filedAt ?? null;
    const form = revenuePoint?.form ?? netIncomePoint?.form ?? null;
    const accession = revenuePoint?.accession ?? netIncomePoint?.accession ?? null;
    const rowWarnings = [
      ...revenuePoint?.warnings ?? [],
      ...netIncomePoint?.warnings ?? [],
    ];
    if (!revenuePoint) rowWarnings.push("Revenue missing.");
    if (!netIncomePoint) rowWarnings.push("Net income missing.");
    return {
      ticker,
      companyName: issuer.companyName,
      cik: issuer.cik,
      fiscalYear,
      fiscalQuarter,
      key,
      periodEnd,
      filedAt,
      form,
      accession,
      revenue: revenuePoint?.value ?? null,
      netIncome: netIncomePoint?.value ?? null,
      revenueYoY: null,
      revenueQoQ: null,
      netIncomeYoY: null,
      netIncomeQoQ: null,
      revenueSourceTag: revenuePoint?.sourceTag ?? null,
      netIncomeSourceTag: netIncomePoint?.sourceTag ?? null,
      derivation: Array.from(new Set([
        revenuePoint?.derivation,
        netIncomePoint?.derivation,
      ].filter(Boolean))).join(" | "),
      warnings: rowWarnings,
      _periodTime: parseDate(periodEnd) ?? 0,
    };
  });

  const byKey = new Map(allRows.map((row) => [row.key, row]));
  for (const row of allRows) {
    const sameQuarterLastYear = byKey.get(yoyKey(row.fiscalYear, row.fiscalQuarter));
    const previousQuarter = byKey.get(previousQuarterKey(row.fiscalYear, row.fiscalQuarter));
    row.revenueYoY = pctChange(row.revenue, sameQuarterLastYear?.revenue ?? null);
    row.revenueQoQ = pctChange(row.revenue, previousQuarter?.revenue ?? null);
    row.netIncomeYoY = pctChange(row.netIncome, sameQuarterLastYear?.netIncome ?? null);
    row.netIncomeQoQ = pctChange(row.netIncome, previousQuarter?.netIncome ?? null);
  }

  const sorted = allRows
    .sort((left, right) => {
      if (right._periodTime !== left._periodTime) return right._periodTime - left._periodTime;
      if (right.fiscalYear !== left.fiscalYear) return right.fiscalYear - left.fiscalYear;
      return right.fiscalQuarter - left.fiscalQuarter;
    });

  const completeRows = sorted.filter((row) => isFiniteNumber(row.revenue) && isFiniteNumber(row.netIncome));
  const selectedRows = (completeRows.length >= 8 ? completeRows : sorted).slice(0, 8);

  return {
    rows: selectedRows.map(({ _periodTime, key, ...row }) => row),
    warnings: [...revenue.warnings, ...netIncome.warnings],
    coverage: {
      totalPeriodsFound: allRows.length,
      completePeriodsFound: completeRows.length,
      selectedPeriods: selectedRows.length,
      revenuePeriodsFound: revenue.points.size,
      netIncomePeriodsFound: netIncome.points.size,
    },
  };
}

function toOutputRows(rows) {
  return rows.map((row) => ({
    ...row,
    revenue: isFiniteNumber(row.revenue) ? Math.round(row.revenue) : null,
    netIncome: isFiniteNumber(row.netIncome) ? Math.round(row.netIncome) : null,
    revenueYoY: isFiniteNumber(row.revenueYoY) ? Number(row.revenueYoY.toFixed(4)) : null,
    revenueQoQ: isFiniteNumber(row.revenueQoQ) ? Number(row.revenueQoQ.toFixed(4)) : null,
    netIncomeYoY: isFiniteNumber(row.netIncomeYoY) ? Number(row.netIncomeYoY.toFixed(4)) : null,
    netIncomeQoQ: isFiniteNumber(row.netIncomeQoQ) ? Number(row.netIncomeQoQ.toFixed(4)) : null,
    warnings: row.warnings.join(" | "),
  }));
}

function rowsToCsv(rows) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    revenue: formatNumber(row.revenue),
    netIncome: formatNumber(row.netIncome),
    revenueYoY: formatPct(row.revenueYoY),
    revenueQoQ: formatPct(row.revenueQoQ),
    netIncomeYoY: formatPct(row.netIncomeYoY),
    netIncomeQoQ: formatPct(row.netIncomeQoQ),
  }));
  return [HEADERS.join(","), ...normalizedRows.map(rowToCsv)].join("\n") + "\n";
}

async function main() {
  const startedAt = Date.now();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const workerDir = path.resolve(scriptDir, "..");
  const outDir = path.join(workerDir, "tmp");
  await mkdir(outDir, { recursive: true });

  console.log(`Using SEC User-Agent: ${USER_AGENT}`);
  console.log(`Fetching SEC ticker map for ${MAG7_TICKERS.join(", ")}...`);
  const tickerMap = buildTickerMap(await fetchJson(COMPANY_TICKERS_URL, "SEC company tickers"));

  const rows = [];
  const summary = [];
  for (const ticker of MAG7_TICKERS) {
    const issuer = tickerMap.get(ticker);
    if (!issuer) {
      summary.push({
        ticker,
        status: "missing_cik",
        quarters: 0,
        warnings: ["Ticker was not found in SEC company_tickers.json."],
      });
      continue;
    }

    await sleep(FETCH_DELAY_MS);
    console.log(`Fetching companyfacts for ${ticker} (${issuer.cik})...`);
    const companyFacts = await fetchJson(`${COMPANY_FACTS_URL}${issuer.cik}.json`, `SEC companyfacts for ${ticker}`);
    const result = combineMetricRows(ticker, issuer, companyFacts);
    const outputRows = toOutputRows(result.rows);
    rows.push(...outputRows);

    const rowWarnings = outputRows.flatMap((row) => row.warnings ? [row.warnings] : []);
    const warnings = [...result.warnings, ...rowWarnings];
    const derivedQ4Count = outputRows.filter((row) => String(row.derivation).includes("derived_q4")).length;
    summary.push({
      ticker,
      companyName: issuer.companyName,
      cik: issuer.cik,
      status: outputRows.length >= 8 ? "ok" : "limited",
      selectedQuarters: outputRows.length,
      revenuePeriodsFound: result.coverage.revenuePeriodsFound,
      netIncomePeriodsFound: result.coverage.netIncomePeriodsFound,
      completePeriodsFound: result.coverage.completePeriodsFound,
      derivedQ4Count,
      warningCount: warnings.length,
      warnings,
    });
  }

  rows.sort((left, right) => {
    if (left.ticker !== right.ticker) return left.ticker.localeCompare(right.ticker);
    const leftDate = parseDate(left.periodEnd) ?? 0;
    const rightDate = parseDate(right.periodEnd) ?? 0;
    return rightDate - leftDate;
  });

  const generatedAt = new Date().toISOString();
  const output = {
    generatedAt,
    userAgent: USER_AGENT,
    tickers: MAG7_TICKERS,
    summary,
    rows,
  };

  const jsonPath = path.join(outDir, "sec-mag7-fundamentals.json");
  const csvPath = path.join(outDir, "sec-mag7-fundamentals.csv");
  await writeFile(jsonPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(csvPath, rowsToCsv(rows), "utf8");

  const runtimeSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log("\nMAG7 SEC fundamentals extraction summary");
  for (const item of summary) {
    console.log(
      [
        item.ticker,
        item.status,
        `${item.selectedQuarters ?? 0} selected quarters`,
        `${item.completePeriodsFound ?? 0} complete periods found`,
        `${item.derivedQ4Count ?? 0} derived Q4 rows`,
        `${item.warningCount ?? 0} warnings`,
      ].join(" | "),
    );
  }
  console.log(`\nWrote ${rows.length} rows to:`);
  console.log(`- ${csvPath}`);
  console.log(`- ${jsonPath}`);
  console.log(`Runtime: ${runtimeSeconds}s`);

  const failures = summary.filter((item) => item.status !== "ok");
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
