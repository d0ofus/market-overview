import { getMarketDataDb } from "./market-data-db";
import type { MarketHistoryBar } from "./market-history";
import type { Env } from "./types";

export const EOD_CATALOG_SCOPE = "history:catalog";
export const EOD_CATALOG_METHODOLOGY_VERSION = "sip-history-catalog-v1";

export type EodCatalogRow = {
  ticker: string;
  barCount: number;
  firstDate: string | null;
  lastDate: string | null;
  price: number | null;
  avgDollarVolume20d: number | null;
  sourceRevision: number;
  previousPrice: number | null;
  volume: number | null;
  avgVolume30d: number | null;
  compatibility?: { previousDate: string | null; trend5d: number | null; trendWindowStartDate: string | null };
};
/** Counts are unknown while a retained adjustment repair is incomplete. This
 * variant cannot be mistaken for a valid security with zero observations. */
export type EodCatalogUnavailableRow = {
  ticker: string; sourceRevision: number; unavailableReason: "adjustment-repair-incomplete"; compatibility?: undefined;
};
export type EodCatalogCheckpointRow = EodCatalogRow | EodCatalogUnavailableRow;
export type EodCatalogUnavailableTuple = [string, null, null, null, null, null, number, null, null, null, "adjustment-repair-incomplete"];
export type EodCatalogTuple = [string, number, string | null, string | null, number | null,
  number | null, number, number | null, number | null, number | null];
/** Pure boundary shared by readers and acceptance; unavailable is not empty. */
export function decodeEodCatalogUnavailableTuple(tuple: unknown): EodCatalogUnavailableRow | null {
  if (!Array.isArray(tuple) || tuple.length<=10) return null;
  if (tuple.length!==11 || typeof tuple[0]!=="string" || !tuple[0] || tuple[0]!==tuple[0].trim().toUpperCase()
    || !Number.isSafeInteger(tuple[6]) || tuple[6]<0 || tuple[10]!=="adjustment-repair-incomplete"
    || ![1,2,3,4,5,7,8,9].every((index) => tuple[index]===null)) {
    throw new EodCatalogUnavailableError("invalid unavailable metadata row");
  }
  return {ticker:tuple[0],sourceRevision:tuple[6],unavailableReason:"adjustment-repair-incomplete"};
}
export type EodCatalogPayload = {
  schemaVersion: 1;
  sessionDate: string;
  methodologyVersion: typeof EOD_CATALOG_METHODOLOGY_VERSION;
  rows: Array<EodCatalogTuple | EodCatalogUnavailableTuple>;
  compatibility?: { schemaVersion: 1; rows: Array<[string, string | null, number | null, string | null]> };
};

/** Input is the once-loaded, merged retained SIP history through the target
 * session. Preserve the old prefilter's full count and observed-bar windows. */
export function buildEodCatalogRow(tickerInput: string, bars: MarketHistoryBar[], sourceRevision: number): EodCatalogRow {
  const ticker = tickerInput.trim().toUpperCase();
  const byDate = new Map(bars.filter((bar) => bar.ticker.toUpperCase() === ticker
    && bar.feed === "sip" && bar.sourceProvider === "alpaca" && bar.adjustment === "split"
    && Number.isFinite(bar.c) && bar.c > 0).map((bar) => [bar.date, bar]));
  const canonical = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const recent20 = canonical.slice(-20);
  const volumes30 = canonical.slice(-30).map((bar) => bar.volume)
    .filter((volume): volume is number => typeof volume === "number" && Number.isFinite(volume));
  return {
    ticker, barCount: canonical.length, firstDate: canonical[0]?.date ?? null,
    lastDate: canonical.at(-1)?.date ?? null, price: canonical.at(-1)?.c ?? null,
    avgDollarVolume20d: recent20.length
      ? recent20.reduce((sum, bar) => sum + bar.c * (bar.volume ?? 0), 0) / recent20.length : null,
    sourceRevision, previousPrice: canonical.at(-2)?.c ?? null, volume: canonical.at(-1)?.volume ?? null,
    avgVolume30d: volumes30.length ? volumes30.reduce((sum, volume) => sum + volume, 0) / volumes30.length : null,
    compatibility: { previousDate: canonical.at(-2)?.date ?? null,
      trend5d: canonical.length >= 7 ? (canonical.at(-1)!.c / canonical.at(-6)!.c - 1) * 100 : null,
      trendWindowStartDate: canonical.length >= 7 ? canonical.at(-7)!.date : null },
  };
}

export function encodeEodCatalogPayload(sessionDate: string, rows: EodCatalogCheckpointRow[]): EodCatalogPayload {
  const sorted = [...rows].sort((left, right) => left.ticker.localeCompare(right.ticker));
  return {
    schemaVersion: 1, sessionDate, methodologyVersion: EOD_CATALOG_METHODOLOGY_VERSION,
    rows: sorted.map((row) => "unavailableReason" in row
      ? [row.ticker,null,null,null,null,null,row.sourceRevision,null,null,null,row.unavailableReason]
      : [row.ticker, row.barCount, row.firstDate, row.lastDate, row.price, row.avgDollarVolume20d,
      row.sourceRevision, row.previousPrice, row.volume, row.avgVolume30d,
    ]),
    compatibility: { schemaVersion: 1, rows: sorted.flatMap((row) => row.compatibility
      ? [[row.ticker, row.compatibility.previousDate, row.compatibility.trend5d, row.compatibility.trendWindowStartDate]] : []) },
  };
}

export class EodCatalogUnavailableError extends Error {
  readonly code = "eod-catalog-unavailable";
  constructor(message: string) { super(`EOD catalog unavailable: ${message}`); this.name = "EodCatalogUnavailableError"; }
}

/** One SQL request reads only compact metadata, never archive payloads or daily
 * bar rows. SQL parses the catalog once, then joins revisions for requested rows.
 * Older catalogs may outlive strictly later-session appends. Constant-size
 * revision evidence proves that exception; the latest accepted session remains
 * exact-revision only. A missing/stale catalog is not an empty universe. */
export async function loadEodCatalogRows(env: Env, tickersInput: readonly string[], sessionDate: string,
  options: { unavailableRows?: "omit" } = {}): Promise<Map<string, EodCatalogRow>> {
  const tickers = [...new Set(tickersInput.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  if (!tickers.length) return new Map();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new EodCatalogUnavailableError("invalid requested session");
  const result = await getMarketDataDb(env).prepare(
    `WITH publication AS MATERIALIZED (
       SELECT id, session_date, methodology_version, payload_codec, payload_json,
              json_extract(payload_json, '$.schemaVersion') AS schemaVersion,
              json_extract(payload_json, '$.sessionDate') AS payloadSession,
              json_extract(payload_json, '$.methodologyVersion') AS payloadMethodology,
              json_extract(payload_json, '$.compatibility.schemaVersion') AS compatibilityVersion,
              (SELECT MAX(session_date) FROM eod_publications
                WHERE scope='history:catalog' AND status='accepted') AS latestCatalogSession
         FROM eod_publications
        WHERE scope = 'history:catalog' AND session_date = ? AND status = 'accepted'
        ORDER BY revision DESC, created_at DESC, id DESC LIMIT 1
     ), catalog AS MATERIALIZED (
       SELECT value AS row_json, json_extract(value, '$[0]') AS ticker
         FROM publication, json_each(CASE WHEN payload_codec IS NULL OR payload_codec = 'json'
           THEN payload_json ELSE '{}' END, '$.rows')
        WHERE json_extract(value, '$[0]') IN (SELECT value FROM json_each(?))
     ), compatibility AS MATERIALIZED (
       SELECT value AS compatibility_json, json_extract(value, '$[0]') AS ticker
         FROM publication, json_each(CASE WHEN compatibilityVersion=1 THEN payload_json ELSE '{}' END, '$.compatibility.rows')
        WHERE json_extract(value, '$[0]') IN (SELECT value FROM json_each(?))
     )
     SELECT p.id AS publicationId, p.session_date AS sessionDate, p.methodology_version AS methodologyVersion,
            p.payload_codec AS payloadCodec, p.schemaVersion, p.payloadSession, p.payloadMethodology,
            p.latestCatalogSession, c.row_json AS rowJson, COALESCE(r.revision, 0) AS currentRevision,
            r.semantic_revision AS semanticRevision, r.last_correction_revision AS lastCorrectionRevision,
            r.append_high_water_date AS appendHighWaterDate, r.append_epoch_start_revision AS appendEpochStartRevision,
            r.append_epoch_start_date AS appendEpochStartDate, f.status AS repairStatus, x.compatibility_json AS compatibilityJson
       FROM publication p LEFT JOIN catalog c ON 1 = 1
       LEFT JOIN compatibility x ON x.ticker=c.ticker
       LEFT JOIN eod_input_revisions r ON r.feed = 'sip' AND r.ticker = c.ticker
       LEFT JOIN eod_adjustment_repairs f ON f.feed = 'sip' AND f.ticker = c.ticker /* eod-history-catalog-read */`,
  ).bind(sessionDate, JSON.stringify(tickers), JSON.stringify(tickers)).all<{
    publicationId: string; sessionDate: string; methodologyVersion: string; payloadCodec: string | null;
    schemaVersion: number | null; payloadSession: string | null; payloadMethodology: string | null;
    rowJson: string | null; currentRevision: number; repairStatus: string | null;
    latestCatalogSession: string; semanticRevision: number | null; lastCorrectionRevision: number | null;
    appendHighWaterDate: string | null; appendEpochStartRevision: number | null; appendEpochStartDate: string | null;
    compatibilityJson: string | null;
  }>();
  const first = result.results?.[0];
  if (!first) throw new EodCatalogUnavailableError(`no accepted full-catalog metadata for ${sessionDate}`);
  if (first.schemaVersion !== 1 || first.payloadSession !== sessionDate || first.sessionDate !== sessionDate
    || first.methodologyVersion !== EOD_CATALOG_METHODOLOGY_VERSION
    || first.payloadMethodology !== EOD_CATALOG_METHODOLOGY_VERSION
    || (first.payloadCodec !== null && first.payloadCodec !== "json")) {
    throw new EodCatalogUnavailableError("catalog schema or methodology is incompatible");
  }
  const rows = new Map<string, EodCatalogRow>();
  const seenTickers=new Set<string>();
  const numericOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
  for (const stored of result.results ?? []) {
    if (!stored.rowJson) continue;
    const tuple: unknown = JSON.parse(stored.rowJson);
    const unavailable=decodeEodCatalogUnavailableTuple(tuple);
    if (unavailable) {
      if (seenTickers.has(unavailable.ticker) || !tickers.includes(unavailable.ticker) || stored.compatibilityJson!=null) throw new EodCatalogUnavailableError("invalid unavailable metadata row");
      seenTickers.add(unavailable.ticker);
      if (options.unavailableRows==="omit") continue;
      throw new EodCatalogUnavailableError(`adjustment repair incomplete for ${unavailable.ticker}; retained history is quarantined`);
    }
    if (!Array.isArray(tuple) || tuple.length !== 10 || typeof tuple[0] !== "string"
      || !Number.isSafeInteger(tuple[1]) || tuple[1] < 0 || !Number.isSafeInteger(tuple[6]) || tuple[6] < 0
      || ![tuple[4], tuple[5], tuple[7], tuple[8], tuple[9]].every(numericOrNull)
      || ![tuple[2], tuple[3]].every((date) => date === null || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)))) {
      throw new EodCatalogUnavailableError("invalid compact metadata row");
    }
    const [ticker, barCount, firstDate, lastDate, price, avgDollarVolume20d, sourceRevision, previousPrice, volume, avgVolume30d] = tuple as EodCatalogTuple;
    if (seenTickers.has(ticker) || (lastDate !== null && lastDate > sessionDate)
      || (barCount === 0 ? firstDate !== null || lastDate !== null || price !== null
        : firstDate === null || lastDate === null || firstDate > lastDate || price === null || price <= 0)) {
      throw new EodCatalogUnavailableError(`inconsistent coverage for ${ticker}`);
    }
    seenTickers.add(ticker);
    // The append epoch contains strictly increasing dates. If this catalog
    // already captured that epoch through its requested session, all subsequent
    // epoch inserts must be later. A lagging/empty row only qualifies when the
    // entire epoch starts after its requested session; otherwise fail closed.
    const onlyLaterAppends = stored.latestCatalogSession > sessionDate
      && stored.currentRevision > sourceRevision && stored.semanticRevision === stored.currentRevision
      && stored.lastCorrectionRevision !== null && stored.lastCorrectionRevision <= sourceRevision
      && stored.appendEpochStartRevision !== null && stored.appendEpochStartRevision <= stored.currentRevision
      && stored.appendEpochStartDate !== null && stored.appendHighWaterDate !== null
      && stored.appendHighWaterDate > sessionDate
      && (stored.appendEpochStartDate > sessionDate
        || (lastDate === sessionDate && sourceRevision >= stored.appendEpochStartRevision));
    if (stored.repairStatus === "pending" || (sourceRevision !== stored.currentRevision && !onlyLaterAppends)) {
      if (options.unavailableRows === "omit") continue;
      throw new EodCatalogUnavailableError(`input revision changed or adjustment repair is pending for ${ticker}`);
    }
    let compatibility: EodCatalogRow["compatibility"];
    if (stored.compatibilityJson != null) {
      const extra: unknown = JSON.parse(stored.compatibilityJson);
      if (!Array.isArray(extra) || extra.length !== 4 || extra[0] !== ticker || !numericOrNull(extra[2])
        || ![extra[1], extra[3]].every((date) => date === null || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
          && firstDate !== null && date >= firstDate && lastDate !== null && date < lastDate))
        || (barCount >= 2 ? extra[1] === null || previousPrice === null : extra[1] !== null)
        || (barCount >= 7 ? extra[2] === null || extra[3] === null || extra[1] === null || extra[3] >= extra[1]
          : extra[2] !== null || extra[3] !== null)) {
        throw new EodCatalogUnavailableError(`invalid compatibility metadata for ${ticker}`);
      }
      compatibility = { previousDate: extra[1] as string | null, trend5d: extra[2] as number | null, trendWindowStartDate: extra[3] as string | null };
    }
    rows.set(ticker, { ticker, barCount, firstDate, lastDate, price, avgDollarVolume20d, sourceRevision, previousPrice, volume, avgVolume30d,
      ...(compatibility ? { compatibility } : {}) });
  }
  const missing = tickers.find((ticker) => !rows.has(ticker));
  if (missing && options.unavailableRows !== "omit") throw new EodCatalogUnavailableError(`requested ticker ${missing} was not included in the full-catalog attempt`);
  return rows;
}
