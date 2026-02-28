const SEC_HEADERS = {
  "User-Agent": "market-command-centre/1.0 (contact: cryptonerdo123@gmail.com)",
  Accept: "application/json,text/plain,*/*",
};

export type ManagerDef = {
  id: string;
  name: string;
  cik: string;
};

export const MANAGER_DEFS: ManagerDef[] = [
  { id: "bridgewater", name: "Bridgewater Associates", cik: "0001350694" },
  { id: "scion", name: "Scion Asset Management", cik: "0001649339" },
  { id: "pershing", name: "Pershing Square Capital Management", cik: "0001336528" },
  { id: "citadel", name: "Citadel Advisors", cik: "0001423053" },
];

type FilingMeta = {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string;
};

export type SecHolding = {
  ticker: string | null;
  issuerName: string;
  valueUsd: number;
  shares: number | null;
  weightPct: number;
  cusip: string | null;
};

export type SecManagerSnapshot = {
  id: string;
  name: string;
  cik: string;
  reportQuarter: string;
  filedDate: string;
  totalValueUsd: number;
  totalHoldingsCount: number;
  holdings: SecHolding[];
};

function noLeadingZeros(cik: string): string {
  return String(Number(cik));
}

function quarterFromDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}

async function fetchLatest13fMeta(cik: string): Promise<FilingMeta | null> {
  const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`;
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    filings?: {
      recent?: {
        form?: string[];
        accessionNumber?: string[];
        filingDate?: string[];
        reportDate?: string[];
      };
    };
  };
  const recent = json.filings?.recent;
  if (!recent?.form || !recent.accessionNumber || !recent.filingDate) return null;
  for (let i = 0; i < recent.form.length; i += 1) {
    const form = recent.form[i];
    if (form !== "13F-HR" && form !== "13F-HR/A") continue;
    return {
      accessionNumber: recent.accessionNumber[i],
      form,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] ?? recent.filingDate[i],
    };
  }
  return null;
}

async function fetchInfoTableXml(cik: string, accession: string): Promise<string | null> {
  const accessionClean = accession.replace(/-/g, "");
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${noLeadingZeros(cik)}/${accessionClean}/index.json`;
  const res = await fetch(indexUrl, { headers: SEC_HEADERS });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    directory?: {
      item?: Array<{ name?: string }>;
    };
  };
  const files = json.directory?.item ?? [];
  const candidate =
    files.find((f) => f.name?.toLowerCase().includes("infotable") && f.name?.toLowerCase().endsWith(".xml"))?.name ??
    files.find((f) => f.name?.toLowerCase().endsWith(".xml"))?.name;
  if (!candidate) return null;
  const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${noLeadingZeros(cik)}/${accessionClean}/${candidate}`;
  const xmlRes = await fetch(xmlUrl, { headers: SEC_HEADERS });
  if (!xmlRes.ok) return null;
  return xmlRes.text();
}

function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = block.match(re);
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ?? null;
}

function parseInfoTable(xml: string): SecHolding[] {
  const blocks = [...xml.matchAll(/<infoTable>([\s\S]*?)<\/infoTable>/gi)].map((m) => m[1]);
  const rows = blocks.map((b) => {
    const issuer = tagText(b, "nameOfIssuer") ?? "Unknown";
    const valueRaw = Number(tagText(b, "value") ?? "0"); // in thousands
    const sharesRaw = Number(tagText(b, "sshPrnamt") ?? "0");
    const symbol = tagText(b, "symbol");
    const cusip = tagText(b, "cusip");
    return {
      ticker: symbol ? symbol.toUpperCase() : null,
      issuerName: issuer,
      valueUsd: valueRaw * 1000,
      shares: Number.isNaN(sharesRaw) ? null : sharesRaw,
      weightPct: 0,
      cusip,
    } as SecHolding;
  });
  const total = rows.reduce((a, b) => a + b.valueUsd, 0) || 1;
  return rows
    .map((r) => ({ ...r, weightPct: (r.valueUsd / total) * 100 }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

export async function fetchSec13fSnapshot(manager: ManagerDef): Promise<SecManagerSnapshot | null> {
  const meta = await fetchLatest13fMeta(manager.cik);
  if (!meta) return null;
  const xml = await fetchInfoTableXml(manager.cik, meta.accessionNumber);
  if (!xml) return null;
  const holdings = parseInfoTable(xml);
  const totalValue = holdings.reduce((a, b) => a + b.valueUsd, 0);
  return {
    id: manager.id,
    name: manager.name,
    cik: manager.cik,
    reportQuarter: quarterFromDate(meta.reportDate),
    filedDate: meta.filingDate,
    totalValueUsd: totalValue,
    totalHoldingsCount: holdings.length,
    holdings,
  };
}
