import { decodeEodCatalogUnavailableTuple, type EodCatalogUnavailableRow } from "./eod-catalog-service";
import { computeEodBreadthMetrics, computeEodTickerMetrics, EOD_METRICS_VERSION, type EodTickerMetrics } from "./eod-metrics";
import { listingDateFor, validateFrozenListingEvidence } from "./eod-listing-evidence";
import { decodeEodPayload } from "./eod-publication-codec";
import { eodHash } from "./eod-publication-service";
import type { Env } from "./types";

const reason = "adjustment-repair-incomplete";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string") ? value : [];
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function fail(detail: string): never { throw new Error(`eod-catalog-quarantine-${detail}`); }
type Revision = { feed: string; ticker: string; revision: number };
export type EodCatalogQuarantineState = { row: EodCatalogUnavailableRow; revisions: Revision[]; pendingUpdatedAt: string };

/** Analytical unavailability never asserts zero retained history. The caller
 * checksums the full catalog and validates every healthy row separately. All
 * queries are bounded indexed control reads; no fenced price reader is opened. */
export async function validateEodCatalogQuarantineState(env: Env, input: {
  catalog: unknown; tickers: readonly string[]; sessionDate: string;
}): Promise<Map<string, EodCatalogQuarantineState>> {
  const catalog = object(input.catalog), rows = catalog.rows;
  if (!Array.isArray(rows)) fail("catalog-rows-missing");
  if (rows.some(row => !Array.isArray(row) || (row.length !== 10 && row.length !== 11))) fail("catalog-row-invalid");
  const marked = rows.map(decodeEodCatalogUnavailableTuple).filter((row): row is EodCatalogUnavailableRow => row !== null);
  const result = new Map<string, EodCatalogQuarantineState>();
  if (!marked.length) return result;
  if (!env.MARKET_DATA_DB || catalog.schemaVersion !== 1 || catalog.sessionDate !== input.sessionDate
    || input.tickers.length > 20_000 || new Set(input.tickers).size !== input.tickers.length
    || rows.length !== input.tickers.length || new Set(rows.map(row => Array.isArray(row) ? row[0] : null)).size !== input.tickers.length
    || rows.some(row => !Array.isArray(row) || !input.tickers.includes(row[0]))) fail("population-invalid");
  const compatibility = object(catalog.compatibility), compatibleRows = compatibility.rows;
  const markedTickers = new Set(marked.map(row => row.ticker));
  if (markedTickers.size !== marked.length || compatibility.schemaVersion !== 1 || !Array.isArray(compatibleRows)
    || compatibleRows.length !== input.tickers.length - marked.length
    || new Set(compatibleRows.map(row => Array.isArray(row) ? row[0] : null)).size !== compatibleRows.length
    || compatibleRows.some(row => !Array.isArray(row) || !input.tickers.includes(row[0]) || markedTickers.has(row[0]))) fail("compatibility-invalid");
  for (let offset = 0; offset < marked.length; offset += 100) {
    const chunk = marked.slice(offset, offset + 100);
    const states = await env.MARKET_DATA_DB.prepare(`SELECT CAST(t.value AS TEXT) AS ticker,CAST(f.value AS TEXT) AS feed,
      COALESCE(r.revision,0) AS revision,p.status,p.updated_at AS updatedAt
      FROM json_each(?) t CROSS JOIN json_each(?) f
      LEFT JOIN eod_input_revisions r ON r.feed=f.value AND r.ticker=t.value
      LEFT JOIN eod_adjustment_repairs p ON p.feed=f.value AND p.ticker=t.value`)
      .bind(JSON.stringify(chunk.map(row => row.ticker)), JSON.stringify(["sip", "yahoo-eod"]))
      .all<Revision & { status: string | null; updatedAt: string | null }>();
    if (states.results.length !== chunk.length * 2) fail("state-incomplete");
    for (const row of chunk) {
      const actual = states.results.filter(state => state.ticker === row.ticker), pending = actual.filter(state => state.status === "pending");
      if (actual.length !== 2 || new Set(actual.map(state => state.feed)).size !== 2 || actual.some(state => !count(state.revision))
        || actual.find(state => state.feed === "sip")?.revision !== row.sourceRevision || !pending.length
        || pending.some(state => !state.updatedAt || !Number.isFinite(Date.parse(state.updatedAt)) || Date.parse(state.updatedAt) > Date.now())) fail("pending-state-mismatch");
      result.set(row.ticker, { row, revisions: actual.map(({ feed, ticker, revision }) => ({ feed, ticker, revision })),
        pendingUpdatedAt: pending.map(state => state.updatedAt!).sort((a,b) => Date.parse(a)-Date.parse(b)).at(-1)! });
    }
  }
  return result;
}

/** Initial acceptance authenticates the producing checkpoint and recomputes
 * affected breadth payloads. Null markers alone cannot exempt a pending fence
 * or alter membership denominators. Original storage/consumer proofs are not
 * changed, recreated, or substituted by this analytical check. */
export async function validateEodCatalogQuarantines(env: Env, input: {
  catalog: unknown; runId: string; frozenInputs: unknown; sessionDate: string;
  pages: ReadonlyMap<string, Record<string, unknown>>;
}): Promise<Map<string, EodCatalogQuarantineState>> {
  const frozen = object(input.frozenInputs), tickers = strings(frozen.tickers), calendar = strings(frozen.calendarDates);
  const quarantined = await validateEodCatalogQuarantineState(env, { catalog: input.catalog, tickers, sessionDate: input.sessionDate });
  if (!quarantined.size) return quarantined;
  if (!env.OPS_DB || !calendar.length || calendar.at(-1) !== input.sessionDate || frozen.methodologyVersion !== EOD_METRICS_VERSION) fail("frozen-inputs-invalid");
  const listing = Object.hasOwn(frozen, "listingEvidence")
    ? await validateFrozenListingEvidence(frozen.listingEvidence, tickers, input.sessionDate, env.OPS_DB) : undefined;
  const memberships = Array.isArray(frozen.memberships) ? frozen.memberships.map(object) : [];
  const affected = memberships.filter(membership => strings(membership.members).some(ticker => quarantined.has(ticker)));
  const needed = new Set([...quarantined.keys(), ...affected.flatMap(membership => strings(membership.members))]);
  const keys = [...new Set(tickers.flatMap((ticker,index) => needed.has(ticker) ? [`features:${Math.floor(index / 25)}`] : []))];
  const features = new Map<string, EodTickerMetrics>();
  const signatureInput = await eodHash(listing ? [frozen.methodologyVersion,calendar,listing.evidenceHash] : [frozen.methodologyVersion,calendar]);
  for (let offset = 0; offset < keys.length; offset += 32) {
    const requested = keys.slice(offset, offset + 32);
    const checkpoints = await env.OPS_DB.prepare(`SELECT chunk_key,input_hash,payload_json,updated_at FROM eod_checkpoints
      WHERE run_id=? AND chunk_key IN (SELECT value FROM json_each(?))`)
      .bind(input.runId, JSON.stringify(requested)).all<{chunk_key:string;input_hash:string;payload_json:string;updated_at:string}>();
    if (checkpoints.results.length !== requested.length) fail("checkpoint-missing");
    for (const checkpoint of checkpoints.results) {
      const encoded = object(JSON.parse(checkpoint.payload_json));
      const payload = object(encoded.payloadCodec ? await decodeEodPayload({ payload:"{}",payloadCodec:String(encoded.payloadCodec),payloadBase64:String(encoded.payloadBase64) }) : encoded);
      const chunkIndex = Number(checkpoint.chunk_key.slice(9)), chunkTickers = tickers.slice(chunkIndex * 25,(chunkIndex + 1) * 25);
      const rows = Array.isArray(payload.features) ? payload.features : [], catalogRows = Array.isArray(payload.catalogRows) ? payload.catalogRows.map(object) : [];
      const revisions = Array.isArray(payload.revisions) ? payload.revisions.map(object) : [];
      if (rows.length !== chunkTickers.length || new Set(rows.map(row => Array.isArray(row) ? row[0] : null)).size !== chunkTickers.length
        || rows.some(row => !Array.isArray(row) || row.length !== 2 || !chunkTickers.includes(row[0]))
        || await eodHash([signatureInput,payload.revisions]) !== checkpoint.input_hash) fail("checkpoint-integrity");
      for (const entry of rows as Array<[string,EodTickerMetrics]>) {
        const [ticker,feature] = entry;
        if (feature.ticker !== ticker || feature.sessionDate !== input.sessionDate || feature.methodologyVersion !== EOD_METRICS_VERSION) fail("checkpoint-feature-identity");
        features.set(ticker,feature);
        const state = quarantined.get(ticker); if (!state) continue;
        const expected = { ...computeEodTickerMetrics({ ticker,targetSession:input.sessionDate,calendarDates:calendar,bars:[],
          ...(listing ? {explainHistory:true,verifiedListingDate:listingDateFor(listing,ticker)} : {}) }), unavailableReason:reason };
        const expectedCatalog = { ticker,sourceRevision:state.row.sourceRevision,unavailableReason:reason };
        const matchingCatalog = catalogRows.filter(row => row.ticker === ticker), matchingRevisions = revisions.filter(row => row.ticker === ticker);
        if (await eodHash(feature) !== await eodHash(expected) || object(payload.errors)[ticker] !== reason
          || matchingCatalog.length !== 1 || await eodHash(matchingCatalog[0]) !== await eodHash(expectedCatalog)
          || !Number.isFinite(Date.parse(checkpoint.updated_at)) || Date.parse(checkpoint.updated_at) > Date.now()
          || Date.parse(checkpoint.updated_at) < Date.parse(state.pendingUpdatedAt)
          || matchingRevisions.length !== 2 || state.revisions.some(actual => !matchingRevisions.some(row => row.feed === actual.feed && row.revision === actual.revision))) fail("checkpoint-quarantine-mismatch");
      }
    }
  }
  for (const membership of affected) {
    const members = strings(membership.members), scope = `breadth:${membership.universeId}`, page = input.pages.get(scope);
    if (!page || members.some(ticker => !features.has(ticker))) fail("breadth-inputs-missing");
    const calculated = computeEodBreadthMetrics({ universeId:String(membership.universeId),targetSession:input.sessionDate,calendarDates:calendar,
      members:members.map(ticker => ({ticker,...(listing ? {verifiedListingDate:listingDateFor(listing,ticker)} : {})})),bars:[],features });
    if (!calculated.publishable) fail("breadth-quarantine-mismatch");
    for (const [key,value] of Object.entries(calculated)) {
      if (await eodHash(value) !== await eodHash(page[key])) fail("breadth-quarantine-mismatch");
    }
  }
  const overview = object(input.pages.get("overview:default")), sections = Array.isArray(overview.sections) ? overview.sections.map(object) : [];
  for (const section of sections) for (const group of Array.isArray(section.groups) ? section.groups.map(object) : []) {
    for (const row of Array.isArray(group.rows) ? group.rows.map(object) : []) {
      if (!quarantined.has(String(row.ticker))) continue;
      const fields = ["price","change1d","change1w","change5d","change21d","change3m","change6m","ytd","pctFrom52wHigh","above20Sma","above50Sma","above200Sma",
        "sparkline","relativeStrength30dVsSpy","barDate","quotePrice","quoteChange1d","quoteSource","quoteFetchedAt","rankKey"];
      const current = object(row.currentData), history = object(row.historyData);
      if (fields.some(key => row[key] !== null) || current.status !== "unavailable" || current.sessionDate !== input.sessionDate
        || history.status !== "unavailable" || history.sessionDate !== input.sessionDate || history.seriesStatus !== "unavailable"
        || !String(current.reason).includes(reason) || Object.keys(object(current.fieldSources)).length !== 0
        || ["quoteSource","performanceSource","smaSource","fetchedAt"].some(key => current[key] !== null)
        || ["barDate","source","seriesSource","seriesThroughDate"].some(key => history[key] !== null)) fail("overview-quarantine-mismatch");
    }
  }
  return quarantined;
}
