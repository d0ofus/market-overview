import { getMarketDataDb } from "./market-data-db";
import { countUsMarketTradingSessionsAfter } from "./market-calendar";
import { expectedEodSession } from "./eod-coordinator";
import type { Env, SnapshotReadyResponse } from "./types";
import { decodeEodPayload,encodeEodPayload,eodPayloadSummary,type EodStoredPayload } from "./eod-publication-codec";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";

export async function eodHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type EodPublicationInput = {
  scope: string;
  sessionDate: string;
  inputHash: string;
  methodologyVersion: string;
  payload: unknown;
  promote: boolean;
  // The final SQL transaction rejects inputs changed by any concurrent bar writer.
  revisions: Array<{ feed: string; ticker: string; revision: number }>;
};

export async function storeEodPublication(env: Env, input: EodPublicationInput): Promise<string> {
  const db = getMarketDataDb(env);
  // Methodology is part of input identity, including for callers that hash prices only.
  const inputHash = await eodHash([input.methodologyVersion, input.inputHash]);
  const id = await eodHash([input.scope, input.sessionDate, inputHash]);
  const now = new Date().toISOString();
  // Catalog prefilters are selected inside SQLite. Keep their compact tuples
  // queryable; page publications retain compressed full metric payloads.
  const catalog=input.scope===EOD_CATALOG_SCOPE;
  const payload = catalog ? JSON.stringify(input.payload) : eodPayloadSummary(input.payload);
  const encoded=catalog ? {payloadCodec:"json",payloadBase64:null} : await encodeEodPayload(input.payload);
  const payloadChecksum=await eodHash(input.payload);
  if (new TextEncoder().encode(payload).length > 1_500_000) throw new Error("publication-payload-too-large");
  const revisions = JSON.stringify(input.revisions);
  const unchanged = `NOT EXISTS (
    SELECT 1 FROM json_each(?) expected
    LEFT JOIN eod_input_revisions actual
      ON actual.feed=json_extract(expected.value,'$.feed')
     AND actual.ticker=json_extract(expected.value,'$.ticker')
    WHERE COALESCE(actual.revision,0) <> json_extract(expected.value,'$.revision')
      OR EXISTS(SELECT 1 FROM eod_adjustment_repairs repair
        WHERE repair.feed=json_extract(expected.value,'$.feed')
          AND repair.ticker=json_extract(expected.value,'$.ticker') AND repair.status='pending'))`;
  await db.prepare(
    `INSERT INTO eod_publications
     (id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_checksum,payload_codec,payload_base64,status,created_at)
     SELECT ?,?,?,COALESCE(MAX(revision),0)+1,?,?,?,?,?,?,'candidate',?
     FROM eod_publications WHERE scope=? AND session_date=?
     ON CONFLICT(scope,session_date,input_hash) DO NOTHING`,
  ).bind(id,input.scope,input.sessionDate,inputHash,input.methodologyVersion,payload,payloadChecksum,encoded.payloadCodec,encoded.payloadBase64,now,input.scope,input.sessionDate).run();
  const staged=await db.prepare("SELECT payload_json as payload,payload_checksum as checksum,payload_codec as payloadCodec,payload_base64 as payloadBase64 FROM eod_publications WHERE id=?")
    .bind(id).first<EodStoredPayload & {checksum:string}>();
  if (!staged || await eodHash(await decodeEodPayload(staged))!==staged.checksum) throw new Error("publication-readback-integrity-failed");
  const statements:D1PreparedStatement[]=[];
  if (input.promote) {
    statements.push(db.prepare(
      `UPDATE eod_publications SET status='accepted',accepted_at=COALESCE(accepted_at,?) WHERE id=? AND ${unchanged}`,
    ).bind(now,id,revisions));
    statements.push(db.prepare(
      `INSERT INTO eod_publication_pointers(scope,publication_id,session_date,published_at)
       SELECT scope,id,session_date,? FROM eod_publications WHERE id=? AND status='accepted' AND ${unchanged}
       ON CONFLICT(scope) DO UPDATE SET publication_id=excluded.publication_id,
         session_date=excluded.session_date,published_at=excluded.published_at
       WHERE excluded.session_date > eod_publication_pointers.session_date
          OR (excluded.session_date = eod_publication_pointers.session_date
            AND (SELECT revision FROM eod_publications WHERE id=excluded.publication_id)
              >= (SELECT revision FROM eod_publications WHERE id=eod_publication_pointers.publication_id))`,
    ).bind(now,id,revisions));
  }
  if (statements.length) await db.batch(statements);
  // Shadow evidence needs the same final source/fence validation as active
  // publications. A stale candidate must never certify a completed shadow run.
  const checked = await db.prepare(`SELECT status FROM eod_publications WHERE id=? AND ${unchanged}`).bind(id,revisions).first<{status:string}>();
  if (!checked || (input.promote ? checked.status!=="accepted" : !["candidate","accepted"].includes(checked.status))) {
    throw new Error("publication-inputs-changed");
  }
  return id;
}

export async function loadEodOverview(env: Env, configId = "default", date?: string): Promise<SnapshotReadyResponse | null> {
  if (env.EOD_READ_ENABLED !== "true") return null;
  const db = getMarketDataDb(env);
  const row = date
    ? await db.prepare(`SELECT id,payload_json as payload,payload_codec as payloadCodec,payload_base64 as payloadBase64 FROM eod_publications
        WHERE scope=? AND session_date=? AND status='accepted' ORDER BY revision DESC LIMIT 1`)
      .bind(`overview:${configId}`, date).first<EodStoredPayload & {id:string}>()
    : await db.prepare(`SELECT p.id,p.payload_json as payload,p.payload_codec as payloadCodec,p.payload_base64 as payloadBase64 FROM eod_publication_pointers h
        JOIN eod_publications p ON p.id=h.publication_id WHERE h.scope=? AND p.status='accepted'`)
      .bind(`overview:${configId}`).first<EodStoredPayload & {id:string}>();
  if (!row) return null;
  const data = await decodeEodPayload(row) as SnapshotReadyResponse;
  const now = new Date();
  const expected = date ?? await expectedEodSession(env, now);
  const stale = !expected || data.asOfDate !== expected;
  const sections = data.sections.map((section) => ({ ...section, groups: section.groups.map((group) => ({ ...group, rows: group.rows.map((item) => {
    const hasPrice = typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0;
    const actualDate = item.barDate ?? item.currentData?.sessionDate ?? data.asOfDate;
    const current = hasPrice && actualDate === expected;
    const quoteStatus = item.quoteFreshnessStatus === "unsupported" ? "unsupported" as const
      : !hasPrice ? "unavailable" as const : current ? "fresh" as const : "stale" as const;
    const publishedFailure=item.currentData?.reason?.includes("Source result:")
      ? ` Published ${data.asOfDate}: ${item.currentData.reason}` : "";
    const reason = !expected ? `The completed exchange session could not be verified; displayed data is dated ${actualDate}.`
      : !hasPrice ? `No verified price for ${expected}.${publishedFailure}`
      : current ? `Verified EOD close for ${actualDate}.` : `Displayed EOD price is dated ${actualDate}; expected ${expected}.`;
    const historyStatus = item.historyData?.seriesStatus;
    return {
      ...item, quoteFreshnessStatus: quoteStatus, quoteFreshnessReason: reason,
      barFreshnessStatus: quoteStatus, barFreshnessReason: reason,
      currentData: item.currentData ? { ...item.currentData, status: !hasPrice ? "unavailable" as const : current ? "fresh" as const : "stale" as const, reason } : item.currentData,
      historyData: item.historyData ? { ...item.historyData, status: quoteStatus, reason,
        seriesStatus: stale && historyStatus && historyStatus !== "unavailable" && historyStatus !== "unsupported" ? "stale" as const : historyStatus,
      } : item.historyData,
    };
  }) })) }));
  const uniqueRows = Array.from(new Map(sections.flatMap((section) => section.groups.flatMap((group) => group.rows)).map((item) => [item.ticker, item])).values());
  const currentCount = uniqueRows.filter((item) => item.quoteFreshnessStatus === "fresh").length;
  const partial = currentCount < uniqueRows.length || data.freshnessStatus === "partial";
  const barDates = uniqueRows.filter((item) => item.price !== null && item.barDate).map((item) => item.barDate!).sort();
  const sessionCount = stale && expected ? await db.prepare("SELECT COUNT(*) as count FROM market_calendar_sessions WHERE session_date > ? AND session_date <= ?")
    .bind(data.asOfDate, expected).first<{ count: number }>().catch(() => null) : null;
  return {
    ...data, sections, generationId: row.id, expectedAsOfDate: expected,
    servingState: stale ? "stale_fallback" : partial ? "degraded" : "ready",
    freshnessStatus: stale ? "stale" : partial ? "partial" : "fresh",
    freshnessCurrentCount: currentCount, freshnessEligibleCount: uniqueRows.length,
    freshnessCoveragePct: uniqueRows.length ? currentCount / uniqueRows.length * 100 : 0,
    freshnessMinBarDate: barDates[0] ?? null, freshnessMaxBarDate: barDates.at(-1) ?? null,
    freshnessCriticalMissingTickers: uniqueRows.filter((item) => ["SPY", "QQQ", "IWM", "DIA"].includes(item.ticker) && item.quoteFreshnessStatus !== "fresh").map((item) => item.ticker),
    staleTradingSessions: expected ? sessionCount?.count ?? countUsMarketTradingSessionsAfter(data.asOfDate, expected) : undefined,
    freshnessWarning: !expected ? `Displaying ${data.asOfDate}; the completed exchange session could not be verified from the calendar cache.`
      : stale ? `Displaying ${data.asOfDate}; expected ${expected}. Recovery remains pending.` : data.freshnessWarning,
  };
}
