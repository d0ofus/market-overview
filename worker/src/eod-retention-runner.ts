import { archiveAndPruneMarketHistory, cleanupUnpointedHistoryBlocks, type HistoryMaintenanceCursor } from "./eod-history-maintenance";
import { refreshHistoryMaintenanceEvidence } from "./eod-history-capacity";
import { dailyRetentionEvidence, loadDailyRelease, readDailyEvidence, writeDailyEvidence } from "./eod-daily-release";
import { cleanupEodRunState } from "./eod-run-maintenance";
import { eodHash } from "./eod-publication-service";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import type { Env } from "./types";

type RetentionState = {
  version: 1; runId: string; startedAt: string; updatedAt: string; completedAt: string | null;
  sessionDate: string; tickers: string[]; tickerHash: string; feed: "sip" | "yahoo-eod";
  cursor: HistoryMaintenanceCursor | null; completedFeeds: string[];
  archivedRows: number; deletedRows: number; concurrentCorrections: number; deferredRepairs: string[];
};
export const EOD_RETENTION_STATE_KEY = "history-retention:state";

/** Retention has no provider dependency. Failed/interrupted runs resume the
 * same security selection, even when tomorrow's membership has changed. */
export async function runEodRetention(env: Env, runId: string, progress: (stage: string, value: unknown) => Promise<void>) {
  const deadline = Date.now() + 70 * 60_000;
  if (env.EOD_ARCHIVE_PRUNE_ENABLED !== "true") return { status: "disabled" };
  if (!env.OPS_DB || !env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB) throw new Error("eod-retention-bindings-required");
  const catalog = await env.MARKET_DATA_DB.prepare(`SELECT session_date AS sessionDate,payload_json AS payload,payload_checksum AS checksum
    FROM eod_publications WHERE scope=? AND status='accepted' ORDER BY session_date DESC,revision DESC LIMIT 1`)
    .bind(EOD_CATALOG_SCOPE).first<{ sessionDate: string; payload: string; checksum: string }>();
  if (!catalog) throw new Error("eod-retention-catalog-required");
  const payload = JSON.parse(catalog.payload) as { rows: Array<[string, ...unknown[]]> };
  if (await eodHash(payload) !== catalog.checksum || !Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 10_000) {
    throw new Error("eod-retention-catalog-invalid");
  }
  const currentTickers = payload.rows.map(row => row[0]).sort();
  const saved = await readDailyEvidence<RetentionState>(env.OPS_DB, EOD_RETENTION_STATE_KEY);
  if (saved && (saved.version !== 1 || await eodHash(saved.tickers) !== saved.tickerHash)) throw new Error("eod-retention-checkpoint-invalid");
  if (saved?.completedAt && saved.runId === runId) return { status: "complete", ...saved };
  const startedAt = new Date().toISOString();
  const state: RetentionState = saved && !saved.completedAt ? saved : {
    version: 1, runId, startedAt, updatedAt: startedAt, completedAt: null, sessionDate: catalog.sessionDate,
    tickers: currentTickers, tickerHash: await eodHash(currentTickers), feed: "sip", cursor: null, completedFeeds: [],
    archivedRows: 0, deletedRows: 0, concurrentCorrections: 0, deferredRepairs: [],
  };
  const save = async () => { state.updatedAt = new Date().toISOString(); await writeDailyEvidence(env.OPS_DB!, EOD_RETENTION_STATE_KEY, state); };
  await save();
  const release = await loadDailyRelease(env);
  const evidence = release ? await dailyRetentionEvidence(env, release)
    : await refreshHistoryMaintenanceEvidence(env, { tickers: state.tickers, codeRevision: env.EOD_CODE_REVISION ?? "" });
  for (const feed of ["sip", "yahoo-eod"] as const) {
    if (state.completedFeeds.includes(feed)) continue;
    if (state.feed !== feed) { state.feed = feed; state.cursor = null; }
    do {
      if (Date.now() >= deadline) throw new Error("eod-retention-time-slice-complete");
      await progress("archive-retention", { sessionDate: state.sessionDate, feed, cursor: state.cursor,
        symbols: state.tickers.length, archivedRows: state.archivedRows, deletedRows: state.deletedRows, startedAt: state.startedAt });
      const result = await archiveAndPruneMarketHistory(env, { tickers: state.tickers, endDate: state.sessionDate,
        catalogSessionDate: catalog.sessionDate, feed, cursor: state.cursor ?? undefined, maxRows: 500,
        hotSessions: evidence.hotSessions, capacity: evidence.capacity, readers: evidence.readers });
      state.cursor = result.cursor;
      state.archivedRows += result.archivedRows;
      state.deletedRows += result.deletedRows;
      state.concurrentCorrections += result.concurrentCorrections;
      state.deferredRepairs = [...new Set([...state.deferredRepairs, ...result.deferredRepairs ?? []])];
      if (!state.cursor) state.completedFeeds.push(feed);
      await save();
    } while (state.cursor);
  }
  await progress("retention-cleanup", { deletedRows: state.deletedRows });
  await cleanupEodRunState(env, { maxRows: 1000 });
  const gcState = await readDailyEvidence<{ cursor?: string | null }>(env.OPS_DB, "history-gc-cursor");
  const gc = await cleanupUnpointedHistoryBlocks(env, { cursor: gcState?.cursor ?? undefined, maxRows: 100 });
  await writeDailyEvidence(env.OPS_DB, "history-gc-cursor", { cursor: gc.cursor });
  state.completedAt = new Date().toISOString();
  await save();
  const { tickers: _tickers, ...summary } = state;
  return { status: "complete", ...summary, symbols: state.tickers.length, deletedBlocks: gc.deletedBlocks };
}
