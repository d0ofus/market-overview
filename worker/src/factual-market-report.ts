import type { MarketReportDataQuality, MarketReportSourceAudit } from "./market-report-common";
import type { Env, SnapshotResponse } from "./types";
import { getMarketDataDb } from "./market-data-db";
import { eodHash } from "./eod-publication-service";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";

export const FACTUAL_REPORT_PROVIDER = "factual";
export const FACTUAL_REPORT_MODEL = "verified-stored-data-v1";
export const EOD_REPORT_PUBLICATION_SOURCE = "Accepted EOD publication set";
const BREADTH_UNIVERSES = [
  ["sp500-core", "S&P 500 universe"], ["nasdaq-core", "NASDAQ universe"], ["nyse-core", "NYSE universe"],
  ["russell2000-core", "Russell 2000 universe"], ["overall-market-proxy", "Overall-market proxy universe"],
] as const;
const REPORT_SCOPES = ["overview:default", ...BREADTH_UNIVERSES.map(([id]) => `breadth:${id}`)];
const BREADTH_FIELDS = [
  ["advancers", "advancers", ""], ["decliners", "decliners", ""], ["unchanged", "unchanged", ""],
  ["totalVolume", "reported volume among observed members", ""],
  ["pctAbove20MA", "above 20-session SMA", "%"], ["pctAbove50MA", "above 50-session SMA", "%"],
  ["pctAbove200MA", "above 200-session SMA", "%"], ["new52WHighs", "252-session closing highs", ""],
  ["new20DHighs", "20-session closing highs", ""], ["new20DLows", "20-session closing lows", ""],
  ["medianReturn1D", "median 1D price return", "%"], ["medianReturn5D", "median rolling 5-session price return", "%"],
  ["stocksGtPos4Pct", "stocks up more than 4% in 1D", ""], ["stocksLtNeg4Pct", "stocks down more than 4% in 1D", ""],
] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function unavailableBreadthSummary(sessionDate: string): string {
  return BREADTH_UNIVERSES.map(([, name]) => `- ${name}: unavailable; no accepted breadth publication for ${sessionDate}.`).join("\n");
}

/** Reads immutable accepted revisions for one explicit session. Other scopes'
 * dates, provider failures and missing memberships cannot become current facts. */
export async function loadFactualBreadthEvidence(env: Env, sessionDate: string, overviewPublicationId?: string | null): Promise<{
  summary: string; identity: string; publicationIds: Record<string, string | null>; readAvailable: boolean;
  sourceAudit: MarketReportSourceAudit[]; dataQuality: MarketReportDataQuality[];
}> {
  type Row = EodStoredPayload & { id: string | null; scope: string; sessionDate: string | null; acceptedAt: string | null; checksum: string | null };
  const publicationIds: Record<string, string | null> = Object.fromEntries(REPORT_SCOPES.map((scope) => [scope, null]));
  const sourceAudit: MarketReportSourceAudit[] = [];
  const dataQuality: MarketReportDataQuality[] = [];
  const lines: string[] = [];
  let rows: Row[] = [];
  let readError: string | null = null;
  if (env.EOD_READ_ENABLED === "true") {
    try {
      rows = (await getMarketDataDb(env).prepare(`SELECT p.id,CAST(requested.value AS TEXT) as scope,p.session_date as sessionDate,p.accepted_at as acceptedAt,
        CASE WHEN requested.value<>'overview:default' THEN p.payload_json END as payload,
        p.payload_codec as payloadCodec,CASE WHEN requested.value<>'overview:default' THEN p.payload_base64 END as payloadBase64,
        p.payload_checksum as checksum FROM json_each(?) requested LEFT JOIN eod_publications p ON p.id=(
          SELECT id FROM eod_publications WHERE scope=requested.value AND session_date=? AND status='accepted'
          ORDER BY revision DESC,accepted_at DESC,id DESC LIMIT 1)`)
        .bind(JSON.stringify(REPORT_SCOPES), sessionDate).all<Row>()).results;
    } catch (error) { readError = error instanceof Error ? error.message : "Accepted breadth publication read failed."; }
  }
  for (const row of rows) if (row.id && row.sessionDate === sessionDate && REPORT_SCOPES.includes(row.scope)) publicationIds[row.scope] = row.id;
  // Use the Overview revision actually consumed by this report when supplied.
  if (overviewPublicationId !== undefined) publicationIds["overview:default"] = overviewPublicationId;
  for (const [universeId, name] of BREADTH_UNIVERSES) {
    const scope = `breadth:${universeId}`;
    const row = rows.find((item) => item.scope === scope && item.id && item.sessionDate === sessionDate);
    try {
      if (!row) throw new Error(readError ?? `No accepted breadth publication for ${sessionDate}.`);
      const payload = object(await decodeEodPayload(row));
      if (!row.checksum || await eodHash(payload) !== row.checksum || payload.asOfDate !== sessionDate || payload.universeId !== universeId) {
        throw new Error("Accepted breadth publication identity/checksum could not be verified.");
      }
      const metrics = object(payload.metrics), coverage = object(metrics.metricCoverage), membership = object(payload.membership);
      const fields = BREADTH_FIELDS.map(([key, label, suffix]) => {
        const observed = object(coverage[key]);
        const value = observed.status === "ready" && finite(metrics[key]) ? `${(metrics[key] as number).toFixed(2)}${suffix}` : "N/A";
        const bounds = finite(observed.lowerBound) && finite(observed.upperBound)
          ? `; bounds ${observed.lowerBound.toFixed(2)}–${observed.upperBound.toFixed(2)} ${observed.boundUnit === "percent" ? "%" : "count"}` : "";
        const counts = finite(observed.eligibleCount) && finite(observed.eligiblePopulation) && finite(observed.missingCount)
          ? ` [observed ${observed.eligibleCount}/${observed.eligiblePopulation} eligible; unresolved ${observed.missingCount}${bounds}]` : " [coverage unavailable]";
        return `${label}: ${value}${counts}`;
      });
      const provenance = `Universe members: ${finite(metrics.totalUniverseMembers) ? metrics.totalUniverseMembers : "unavailable"}. Membership source: ${typeof membership.source === "string" ? membership.source : "unavailable"}; type ${typeof membership.sourceType === "string" ? membership.sourceType : "unavailable"}; effective ${typeof membership.sourceAsOfDate === "string" ? membership.sourceAsOfDate : "unavailable"}; verified ${typeof membership.verifiedAt === "string" ? membership.verifiedAt : "unavailable"}. Price sources: ${typeof payload.dataSource === "string" ? payload.dataSource : "unavailable"}.`;
      lines.push(`- ${name}, session ${sessionDate}: ${fields.join("; ")}. ${provenance}`);
      sourceAudit.push({ sourceName: `Accepted EOD breadth: ${name}`, url: typeof membership.sourceUrl === "string" ? membership.sourceUrl : null,
        dataUsed: `Verified ${sessionDate} breadth metrics and their observed/eligible populations; closing-high windows use daily closes.`,
        timestamp: row.acceptedAt, note: `Breadth publication: ${row.id}; ${provenance}` });
      dataQuality.push({ metric: name, status: BREADTH_FIELDS.some(([key]) => object(coverage[key]).status !== "ready") ? "stale" : "ok",
        note: `Accepted ${sessionDate} publication ${row.id}. Suppressed metrics remain N/A; universe membership follows its declared source, including any proxy classification.` });
    } catch (error) {
      publicationIds[scope] = null;
      const reason = error instanceof Error ? error.message : "Breadth evidence unavailable.";
      lines.push(`- ${name}: unavailable for ${sessionDate}. ${reason}`);
      dataQuality.push({ metric: name, status: "unavailable", note: reason });
    }
  }
  const identity = JSON.stringify(REPORT_SCOPES.map((scope) => [scope, publicationIds[scope]]));
  sourceAudit.push({ sourceName: EOD_REPORT_PUBLICATION_SOURCE, url: null, dataUsed: `Independent accepted publication identities for ${sessionDate}.`,
    timestamp: rows.map((row) => row.acceptedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
    note: identity });
  return { summary: lines.join("\n"), identity, publicationIds, sourceAudit, dataQuality,
    readAvailable: env.EOD_READ_ENABLED === "true" && readError === null };
}

/** An explicitly configured free-tier project is opt-in; paid report/search keys are never reused. */
export function freeMarketReportEnv(env: Env): Env {
  const key = env.GEMINI_FREE_API_KEY?.trim();
  if (!key) throw new Error("Free AI enrichment is not configured; factual evidence is shown.");
  return { ...env, GEMINI_API_KEY: key, GEMINI_SEARCH_GROUNDING_ENABLED: "false" };
}

export function summarizeVerifiedOverview(snapshot: SnapshotResponse | null, expectedSession: string): string {
  if (!snapshot || snapshot.status === "empty" || snapshot.asOfDate !== expectedSession) {
    return `Overview evidence for ${expectedSession} is unavailable.${snapshot && snapshot.status !== "empty" ? ` The stored publication is dated ${snapshot.asOfDate}; its values are not used as current observations.` : ""}`;
  }
  const lines = [`EOD observations for ${snapshot.asOfDate}; publication ${snapshot.generatedAt}. Returns are price returns. 1W is a rolling five-session return, not necessarily the calendar-week return.`];
  for (const section of snapshot.sections) {
    for (const group of section.groups) {
      const rows = group.rows.map((row) => {
        const verified = row.currentData?.status === "fresh" && row.currentData.sessionDate === expectedSession;
        const metric = (field: string, value: number | null | undefined, suffix = ""): string =>
          verified && row.currentData?.fieldSources[field] && typeof value === "number" && Number.isFinite(value)
            ? `${value.toFixed(2)}${suffix}` : "N/A";
        return `${row.ticker}: close ${metric("price", row.price)}, 1D ${metric("change1d", row.change1d, "%")}, rolling 1W ${metric("change1w", row.change1w, "%")}, YTD ${metric("ytd", row.ytd, "%")}`;
      });
      lines.push(`- ${group.title}: ${rows.join("; ") || "N/A"}`);
    }
  }
  return lines.join("\n");
}

type Evidence = {
  dashboardSummary: string;
  breadthSummary?: string;
  fedWatchSummary: string;
  sourceAudit: MarketReportSourceAudit[];
  dataQuality: MarketReportDataQuality[];
};

const unavailable = "Unavailable from verified sources for this report. No estimate has been substituted.";

function sources(evidence: Evidence): string {
  const rows = evidence.sourceAudit.filter((source) => source.timestamp);
  return [
    ...rows.map((source) => `- ${source.sourceName}${source.url ? ` (${source.url})` : ""}; observed ${source.timestamp}.`),
    ...evidence.dataQuality.map((row) => `- ${row.metric}: ${row.status}. ${row.note}`),
  ].join("\n") || unavailable;
}

function groups(summary: string, pattern: RegExp): string {
  return summary.split("\n").filter((line) => line.startsWith("- ") && pattern.test(line)).join("\n") || unavailable;
}

export function buildFactualDailyReport(input: Evidence & {
  sessionDate: string;
  sessionLabel: string;
  reason: string;
}): string {
  const sections: Array<[string, string]> = [
    ["EXECUTIVE SUMMARY", `Factual report from available stored evidence. AI interpretation is unavailable. ${input.sessionLabel}\n\n${input.reason}`],
    ["MARKET HEALTH SCORE", "No model-generated health score is assigned. Coverage and source limitations are listed below."],
    ["MAJOR INDEX SNAPSHOT", groups(input.dashboardSummary, /Index|Global Indices|Country ETFs/i)],
    ["FIXED INCOME, DOLLAR & COMMODITIES", groups(input.dashboardSummary, /Metals|Energy|Dollar|Fixed Income|Bond/i)],
    ["ECONOMIC DATA RELEASED TODAY", unavailable],
    ["FED, CENTRAL BANKS & RATE EXPECTATIONS", input.fedWatchSummary],
    ["FISCAL, POLICY, POLITICAL & GEOPOLITICAL RISKS", unavailable],
    ["SECTOR & INDUSTRY PERFORMANCE", groups(input.dashboardSummary, /Sector ETFs|Thematic|Industry/i)],
    ["MARKET BREADTH & INTERNALS", input.breadthSummary ?? unavailableBreadthSummary(input.sessionDate)],
    ["PRICE ACTION & TECHNICAL ANALYSIS", input.dashboardSummary],
    ["VIX, VOLATILITY & OPTIONS", groups(input.dashboardSummary, /Volatility/i)],
    ["SENTIMENT & POSITIONING", unavailable],
    ["EARNINGS & SINGLE-STOCK CATALYSTS", unavailable],
    ["FORWARD CALENDAR", "Refer to the dated official FOMC sources in Macro Rates. Other upcoming events are unavailable from verified sources for this report."],
    ["SWING TRADER PLAYBOOK", "No trading interpretation or recommendation is generated in the factual report."],
    ["WHAT CHANGED VERSUS YESTERDAY", "The dated 1D figures above describe price changes only. No causal explanation is inferred."],
    ["FINAL MARKET VIEW", "Use the dates and coverage alongside each observation. Missing evidence remains unavailable."],
    ["SOURCE AUDIT", sources(input)],
  ];
  return [`# US Market State of Play - ${input.sessionDate}`, ...sections.map(([title, body], index) => `## ${index + 1}. ${title}\n\n${body}`)].join("\n\n");
}

export function buildFactualWeeklyReport(input: Evidence & {
  weekStart: string;
  weekEnd: string;
  reason: string;
  recentDailyCommentarySummary: string;
}): string {
  const sections: Array<[string, string]> = [
    ["Executive Summary", `Factual report for ${input.weekStart} to ${input.weekEnd}. AI interpretation is unavailable. ${input.reason}`],
    ["Market Tone & Breadth", `End-of-week breadth observations for ${input.weekEnd}; these are not weekly changes in breadth.\n\n${input.breadthSummary ?? unavailableBreadthSummary(input.weekEnd)}`],
    ["Sector Leadership", groups(input.dashboardSummary, /Sector ETFs/i)],
    ["Industry / Theme Movers", groups(input.dashboardSummary, /Thematic|Industry/i)],
    ["Key Stock Movers & Read-throughs", groups(input.dashboardSummary, /Market Leaders/i)],
    ["News and Macro Impact", `${input.fedWatchSummary}\n\n${unavailable}`],
    ["What To Watch Next Week", "Refer to the official event sources in Macro Rates. No unverified event dates or forecasts are generated."],
    ["Risks / Invalidation", "Missing or older source data limits this report. No trading interpretation is generated."],
    ["Data Freshness / Source Notes", `${input.dashboardSummary}\n\n${sources(input)}`],
  ];
  return [`# Weekly Market Review - ${input.weekStart} to ${input.weekEnd}`, ...sections.map(([title, body]) => `## ${title}\n\n${body}`)].join("\n\n");
}
