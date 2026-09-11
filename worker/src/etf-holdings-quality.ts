import type { EtfConstituent } from "./etf";
import type { EtfSyncStatusRow } from "./etf-sync-status";

export type EtfHoldingAssetType = "equity" | "crypto" | "physical_commodity" | "cash" | "fund" | "money_market" | "derivative";
export type EtfLifecycle = { status: "liquidated"; lastTradingDate: string; liquidationDate: string; sourceUrl: string; confirmationUrl: string };
const CLOSED_FUNDS: Readonly<Record<string, EtfLifecycle>> = {
  EATZ: { status: "liquidated", lastTradingDate: "2026-04-30", liquidationDate: "2026-05-07",
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/1408970/000182912626003345/advisorshares-eatz_497.htm",
    confirmationUrl: "https://infomemo.theocc.com/infomemos?number=58928" },
};
/** Security-specific lifecycle facts; historical prices and membership remain retained. */
export function getEtfLifecycle(ticker: string): EtfLifecycle | null { return CLOSED_FUNDS[ticker.toUpperCase()] ?? null; }
export function closedEtfTickers(now:Date):string[] {
  const today=now.toISOString().slice(0,10);
  return Object.entries(CLOSED_FUNDS).filter(([,fund])=>fund.liquidationDate<=today).map(([ticker])=>ticker).sort();
}

export function etfHoldingAssetType(etfTicker: string, row: Pick<EtfConstituent, "ticker" | "name"> & { source?: string }): EtfHoldingAssetType {
  const ticker = row.ticker.toUpperCase(), name = row.name ?? "";
  if (row.source === "ssga:fund-data") {
    if (ticker === "-" && name === "US DOLLAR") return "cash";
    // The issuer reports this cash-equivalent fund without an equity ticker.
    // Retain its literal identifier/name; do not invent a tradable stock symbol.
    if (ticker === "-" && /^SSI US GOV MONEY MARKET(?: CLASS)?$/i.test(name.trim())) return "money_market";
    const future = /^(?:S\+P|S&P) E-?MINI .+ (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i.exec(name.trim());
    const contract = /^[A-Z]{1,4}([FGHJKMNQUVXZ])(\d{1,2})$/.exec(ticker);
    const months: Record<string, string> = { JAN: "F", FEB: "G", MAR: "H", APR: "J", MAY: "K", JUN: "M", JUL: "N", AUG: "Q", SEP: "U", OCT: "V", NOV: "X", DEC: "Z" };
    if (future && contract && months[future[1].toUpperCase()] === contract[1] && future[2].endsWith(contract[2])) return "derivative";
  }
  if ((etfTicker === "GLD" && ticker === "PHYSICAL-GOLD" && name === "Physical gold bullion" && row.source === "spdrgoldshares:physical-gold-archive")
    || (etfTicker === "SLV" && ticker === "PHYSICAL-SILVER" && name === "Physical silver bullion" && row.source === "ishares:holdings-csv")) return "physical_commodity";
  if (etfTicker === "IBIT" && ticker === "BTC" && name === "Bitcoin" && row.source === "ishares:single-asset") return "crypto";
  // USD/CASH can also be listed fund symbols. Require explicit currency/cash
  // identity rather than suppressing quotes solely from the ticker string.
  if ((ticker === "CASH" || ticker === "USD")
    && /^(?:US DOLLAR|U\.S\. DOLLAR|UNITED STATES DOLLAR|USD|CASH|CASH (?:AND|&) CASH EQUIVALENTS)$/i.test(name.trim())) return "cash";
  if (/\b(?:money market|treasury trust|liquidity fund|exchange.traded fund|ETF)\b/i.test(name)) return "fund";
  return "equity";
}

export function parseEtfHoldingsDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim(), iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const named = text.match(/\b(\d{1,2})[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ,]+(\d{4})\b/i);
  const month = named ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[2].toLowerCase()) + 1 : 0;
  const date = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`
    : named ? `${named[3]}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}` : null;
  const instant = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return date && Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date ? date : null;
}

export function etfHoldingsDateIssue(dates: readonly unknown[], now = new Date()): string | null {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return dates.some(value => { const date = parseEtfHoldingsDate(value); return date !== null && date > today; })
    ? "holdings-effective-date-future" : null;
}

/** Reject contamination; never repair an impossible list by rescaling weights. */
export function etfHoldingsIssue(etfTicker: string, rows: readonly (Pick<EtfConstituent, "ticker" | "name" | "weight"> & { source?: string })[]): string | null {
  if (rows.length > 10_000 || new Set(rows.map(row => row.ticker)).size !== rows.length) return "holdings-security-identity-invalid";
  if (rows.some(row => row.ticker === "-" && !["money_market", "cash"].includes(etfHoldingAssetType(etfTicker, row)))) return "holdings-security-identity-invalid";
  if (rows.some(row => !/^[A-Z0-9.\-]{1,20}$/.test(row.ticker) || (row.weight !== null && !Number.isFinite(row.weight)))) return "holdings-observation-invalid";
  // The issuer's Dec 2025 report disclosed 24 EATZ holdings. This generous
  // ceiling catches the audited 717-row consolidated export, not normal turnover.
  if (etfTicker === "EATZ" && rows.length > 100) return "holdings-cross-fund-contamination";
  if ((etfTicker === "GLD" || etfTicker === "SLV") && rows.some(row => !["physical_commodity", "cash"].includes(etfHoldingAssetType(etfTicker, row)))) {
    return "holdings-physical-asset-identity-invalid";
  }
  if (etfTicker === "IBIT" && rows.some(row => row.ticker === "BTC" && row.name === "Bitcoin" && etfHoldingAssetType(etfTicker, row) !== "crypto")) {
    return "holdings-crypto-asset-identity-invalid";
  }
  // Long-only holdings cannot have several hundred percent total weight.
  // Leave explicit leverage/inverse fund contracts outside this scoped check.
  const ordinary = etfTicker === "EATZ" || /^(?:XL[BCDEFIKPRUVY]|XLC|GLD|SLV|IWM|SPY|QQQ)$/.test(etfTicker);
  if (ordinary && (rows.some(row => row.weight !== null && (Math.abs(row.weight) > 100.5
    || (row.weight < 0 && etfHoldingAssetType(etfTicker, row) !== "derivative")))
    || rows.reduce((sum, row) => sum + (row.weight ?? 0), 0) > 105)) return "holdings-weights-inconsistent";
  return null;
}

export type StoredEtfHolding = EtfConstituent & { asOfDate: string | null; source: string; updatedAt: string | null };
export function prepareStoredEtfHoldings(etfTicker: string, rows: StoredEtfHolding[], status: EtfSyncStatusRow | null, now = new Date()) {
  const issue = etfHoldingsIssue(etfTicker, rows) ?? etfHoldingsDateIssue(rows.map(row => row.asOfDate), now), lifecycle = getEtfLifecycle(etfTicker);
  const closed = lifecycle && now.toISOString().slice(0, 10) >= lifecycle.liquidationDate;
  const dates = [...new Set(rows.map(row => parseEtfHoldingsDate(row.asOfDate)).filter((date): date is string => date !== null))].sort();
  const asOfDate = dates.length === 1 && rows.every(row => parseEtfHoldingsDate(row.asOfDate) === dates[0]) ? dates[0] : null;
  const partial = status?.coverage === "partial" || status?.sourceTier === "partial";
  const stale = asOfDate !== null && now.getTime() - Date.parse(`${asOfDate}T00:00:00Z`) > 7 * 86400_000;
  const retained = issue ? [] : rows.map(row => ({ ...row, assetType: etfHoldingAssetType(etfTicker, row),
    weight: row.source === "ishares:single-asset" ? null : row.weight,
    chartEligible: !["physical_commodity", "cash", "crypto", "money_market", "derivative"].includes(etfHoldingAssetType(etfTicker, row)) }));
  const messages: string[] = [];
  if (issue) messages.push(`Cached holdings quarantined (${issue}); ${rows.length} stored rows require validated replacement.`);
  if (closed) messages.push(`${etfTicker} last traded ${lifecycle.lastTradingDate} and was liquidated ${lifecycle.liquidationDate}. Any validated holdings shown are historical.`);
  if (!issue && rows.length && !asOfDate) messages.push("The holdings effective date is unverified; the latest collection attempt is not its source date.");
  if (!issue && stale && !closed) messages.push(`Showing dated holdings from ${asOfDate}; a newer complete snapshot is unavailable.`);
  if (!issue && partial) messages.push("This provider supplied a partial holdings list.");
  if (status?.error) messages.push(status.error);
  if (!rows.length && !closed && !status?.error) messages.push("No validated cached holdings are available yet.");
  return { rows: retained, warning: messages.length ? messages.join(" ") : null,
    syncStatus: status ? { ...status, ...(issue ? { status: "quarantined", error: messages[0], recordsCount: 0,
      lastFullSyncedAt: null, quarantinedLastFullSyncedAt: status.lastFullSyncedAt ?? null } : {}), lifecycle: closed ? lifecycle : null } : null,
    holdings: { status: issue ? "quarantined" : closed ? "historical" : !rows.length ? "unavailable" : partial ? "partial" : !asOfDate ? "undated" : stale ? "stale" : "ready",
      asOfDate: issue ? null : asOfDate, lastFullSyncedAt: issue ? null : status?.lastFullSyncedAt ?? null,
      lastAttemptAt: status?.lastSyncedAt ?? null, storedRecords: rows.length, returnedRecords: retained.length,
      unavailableReason: issue, lifecycle: closed ? lifecycle : null } };
}
