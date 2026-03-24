import type { Env } from "../../types";

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

type CompanyTickerEntry = {
  cik_str?: number;
  ticker?: string;
  title?: string;
};

type SecRecentFilings = {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  act?: string[];
  form?: string[];
  fileNumber?: string[];
  filmNumber?: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
};

type SecFactsResponse = {
  facts?: Record<string, Record<string, Record<string, Array<{
    val?: number;
    fy?: number;
    fp?: string;
    form?: string;
    filed?: string;
    end?: string;
    frame?: string;
  }>>>>;
};

export type SecResolvedIssuer = {
  ticker: string;
  cik: string;
  companyName: string;
};

export type SecFilingItem = {
  accessionNumber: string;
  form: string;
  filingDate: string | null;
  reportDate: string | null;
  primaryDocument: string | null;
  primaryDocDescription: string | null;
  items: string | null;
};

export type SecStructuredFact = {
  key: string;
  label: string;
  unit: string;
  value: number;
  form: string | null;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  filedAt: string | null;
  periodEnd: string | null;
};

let companyTickerCache:
  | {
    expiresAt: number;
    byTicker: Map<string, SecResolvedIssuer>;
  }
  | null = null;

function secHeaders(env: Env): Record<string, string> {
  return {
    "User-Agent": env.SEC_USER_AGENT?.trim() || "market-command-centre/1.0 (contact: admin@example.com)",
    Accept: "application/json,text/plain,*/*",
  };
}

function toPaddedCik(value: string | number): string {
  return String(value).replace(/\D/g, "").padStart(10, "0");
}

async function loadCompanyTickerMap(env: Env): Promise<Map<string, SecResolvedIssuer>> {
  const now = Date.now();
  if (companyTickerCache && companyTickerCache.expiresAt > now) return companyTickerCache.byTicker;
  const res = await fetch(COMPANY_TICKERS_URL, { headers: secHeaders(env) });
  if (!res.ok) throw new Error(`SEC company tickers request failed (${res.status}).`);
  const json = await res.json() as Record<string, CompanyTickerEntry>;
  const byTicker = new Map<string, SecResolvedIssuer>();
  Object.values(json).forEach((entry) => {
    const ticker = String(entry.ticker ?? "").trim().toUpperCase();
    const cik = entry.cik_str != null ? toPaddedCik(entry.cik_str) : "";
    const companyName = String(entry.title ?? "").trim();
    if (!ticker || !cik || !companyName) return;
    byTicker.set(ticker, { ticker, cik, companyName });
  });
  companyTickerCache = {
    expiresAt: now + (6 * 60 * 60_000),
    byTicker,
  };
  return byTicker;
}

export async function resolveIssuer(ticker: string, env: Env): Promise<SecResolvedIssuer | null> {
  const map = await loadCompanyTickerMap(env);
  return map.get(ticker.trim().toUpperCase()) ?? null;
}

export async function fetchRecentFilings(cik: string, env: Env, limit = 6): Promise<SecFilingItem[]> {
  const url = `https://data.sec.gov/submissions/CIK${toPaddedCik(cik)}.json`;
  const res = await fetch(url, { headers: secHeaders(env) });
  if (!res.ok) throw new Error(`SEC submissions request failed (${res.status}).`);
  const json = await res.json() as { filings?: { recent?: SecRecentFilings } };
  const recent = json.filings?.recent;
  const forms = recent?.form ?? [];
  const results: SecFilingItem[] = [];
  for (let index = 0; index < forms.length; index += 1) {
    const form = String(forms[index] ?? "").trim();
    if (!form) continue;
    if (!/^(10-K|10-Q|8-K|6-K|20-F|DEF 14A)$/i.test(form)) continue;
    results.push({
      accessionNumber: String(recent?.accessionNumber?.[index] ?? ""),
      form,
      filingDate: recent?.filingDate?.[index] ?? null,
      reportDate: recent?.reportDate?.[index] ?? null,
      primaryDocument: recent?.primaryDocument?.[index] ?? null,
      primaryDocDescription: recent?.primaryDocDescription?.[index] ?? null,
      items: recent?.items?.[index] ?? null,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function selectLatestFactEntries(
  facts: SecFactsResponse,
  candidates: Array<{ key: string; label: string; unitPreference: string[] }>,
): SecStructuredFact[] {
  const usGaap = facts.facts?.["us-gaap"] ?? {};
  return candidates.flatMap((candidate) => {
    const factNode = usGaap[candidate.key] ?? {};
    for (const unit of candidate.unitPreference) {
      const items = Array.isArray(factNode[unit]) ? factNode[unit] : [];
      const latest = [...items]
        .filter((entry) => typeof entry?.val === "number")
        .sort((left, right) => Date.parse(right.filed ?? right.end ?? "") - Date.parse(left.filed ?? left.end ?? ""))[0];
      if (!latest || typeof latest.val !== "number") continue;
      return [{
        key: candidate.key,
        label: candidate.label,
        unit,
        value: latest.val,
        form: latest.form ?? null,
        fiscalYear: typeof latest.fy === "number" ? latest.fy : null,
        fiscalPeriod: latest.fp ?? null,
        filedAt: latest.filed ?? null,
        periodEnd: latest.end ?? null,
      }];
    }
    return [];
  });
}

export async function fetchStructuredFacts(cik: string, env: Env): Promise<SecStructuredFact[]> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${toPaddedCik(cik)}.json`;
  const res = await fetch(url, { headers: secHeaders(env) });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`SEC company facts request failed (${res.status}).`);
  }
  const json = await res.json() as SecFactsResponse;
  return selectLatestFactEntries(json, [
    { key: "Revenues", label: "Revenue", unitPreference: ["USD"] },
    { key: "NetIncomeLoss", label: "Net Income", unitPreference: ["USD"] },
    { key: "EarningsPerShareDiluted", label: "Diluted EPS", unitPreference: ["USD/shares"] },
    { key: "NetCashProvidedByUsedInOperatingActivities", label: "Operating Cash Flow", unitPreference: ["USD"] },
    { key: "GrossProfit", label: "Gross Profit", unitPreference: ["USD"] },
  ]);
}
