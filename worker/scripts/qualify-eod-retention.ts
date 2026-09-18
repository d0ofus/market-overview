import { execFileSync } from "node:child_process";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { assertDailyReleaseBindings, loadDailyRelease, readDailyEvidence, sampleDailyStorage, writeDailyEvidence } from "../src/eod-daily-release";
import { collectEodCurrentHealth } from "../src/eod-current-health";
import { EOD_CATALOG_SCOPE } from "../src/eod-catalog-service";
import { eodHash } from "../src/eod-publication-service";
import { qualifyRetentionArchiveBatch } from "../src/eod-retention-qualification";
import type { MarketHistoryBar } from "../src/market-history";
import type { Env } from "../src/types";

const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`retention-qualification-missing:${name}`); return value; };
type State = { version: 1; session: string; catalogId: string; catalogHash: string; startedAt: string; updatedAt: string;
  completedAt: string | null; nextTicker: number; tickers: number; verifiedBars: number; archiveWrites: number; missingBars: number;
  activeMs: number; inputClock: number; productionRevision: string; qualificationRevision: string; status: string };

async function main() {
  if (process.env.EOD_RETENTION_QUALIFICATION !== "true") throw new Error("retention-qualification-explicit-mode-required");
  const productionRevision = required("EOD_PRODUCTION_CODE_REVISION");
  const qualificationRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN");
  const ids = [required("EOD_CORE_DATABASE_ID"), required("EOD_MARKET_DATABASE_ID"), required("EOD_HISTORY_DATABASE_ID"), required("EOD_OPS_DATABASE_ID")];
  if (new Set(ids).size !== 4) throw new Error("retention-qualification-binding-conflict");
  const rawOps = createEodD1Database({ accountId, token, databaseId: ids[3], allowedDatabaseIds: ids });
  const profile = resolveEodBudgetProfile("paid");
  const admission = createEodAdmission(rawOps, `retention-qualification:${productionRevision}`, { profile,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ accountId, token: required("CLOUDFLARE_EOD_ANALYTICS_TOKEN"), ops: rawOps, profile }) });
  const database = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds: ids, admission });
  const env = { DB: database(ids[0]), MARKET_DATA_DB: database(ids[1]), MARKET_HISTORY_DB: database(ids[2]), OPS_DB: database(ids[3]),
    EOD_BUDGET_PROFILE: "paid", EOD_CODE_REVISION: productionRevision, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true",
    EOD_ARCHIVE_PRUNE_ENABLED: "true", ALPACA_DAILY_FEED: "sip" } as Env;
  try {
    const release = await loadDailyRelease(env);
    if (!release) throw new Error("retention-qualification-release-required");
    if ([release.bindings.core, release.bindings.market, release.bindings.history, release.bindings.ops].some((id, index) => id !== ids[index])) {
      throw new Error("retention-qualification-release-binding-mismatch");
    }
    await assertDailyReleaseBindings(env, release);
    const health = await collectEodCurrentHealth(env);
    if (health.status !== "passed" || !health.expectedSession) throw new Error("retention-qualification-current-delivery-required");
    const storage = await sampleDailyStorage({ accountId, token, ops: env.OPS_DB! });
    if (storage.accountBytes >= 4_500_000_000) throw new Error("retention-qualification-optional-capacity-stop");
    const catalog = await env.MARKET_DATA_DB!.prepare("SELECT id,payload_json,payload_checksum FROM eod_publications WHERE scope=? AND session_date=? AND status='accepted' ORDER BY revision DESC LIMIT 1")
      .bind(EOD_CATALOG_SCOPE, health.expectedSession).first<{ id: string; payload_json: string; payload_checksum: string }>();
    const payload = JSON.parse(catalog?.payload_json ?? "null") as { rows: Array<[string, ...unknown[]]> };
    if (!catalog || !payload?.rows?.length || payload.rows.length > 10_000 || await eodHash(payload) !== catalog.payload_checksum) throw new Error("retention-qualification-catalog-invalid");
    const tickers = payload.rows.map(row => row[0]).sort();
    const key = `retention-qualification:${productionRevision}:${health.expectedSession}`;
    const clock = await env.MARKET_DATA_DB!.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
    if (!Number.isSafeInteger(clock)) throw new Error("retention-qualification-clock-unavailable");
    const saved = await readDailyEvidence<State>(env.OPS_DB!, key);
    if (saved && (saved.catalogId !== catalog.id || saved.catalogHash !== catalog.payload_checksum || saved.productionRevision !== productionRevision)) throw new Error("retention-qualification-inputs-changed");
    if (saved?.completedAt) {
      const previous = await readDailyEvidence<{ qualified: boolean }>(env.OPS_DB!, `${key}:result`);
      if (!previous?.qualified) throw new Error("retention-qualification-completed-without-passing-result");
      console.log(JSON.stringify(previous)); return;
    }
    const stamp = new Date().toISOString();
    const state: State = saved ?? { version: 1, session: health.expectedSession, catalogId: catalog.id, catalogHash: catalog.payload_checksum,
      startedAt: stamp, updatedAt: stamp, completedAt: null, nextTicker: 0, tickers: tickers.length, verifiedBars: 0, archiveWrites: 0, missingBars: 0,
      activeMs: 0, inputClock: clock!, productionRevision, qualificationRevision, status: "running" };
    const invocationStart = Date.now();
    let checkpointAt = invocationStart;
    const save = async () => { const now = Date.now(); state.activeMs += now - checkpointAt; checkpointAt = now;
      state.updatedAt = new Date(now).toISOString(); await writeDailyEvidence(env.OPS_DB!, key, state); };
    for (; state.nextTicker < tickers.length;) {
      if (Date.now() - invocationStart >= 70 * 60_000) { state.status = "time-slice-complete"; await save(); throw new Error("retention-qualification-time-slice-complete"); }
      if (state.nextTicker % 500 === 0) {
        const priority = await env.OPS_DB!.prepare(`SELECT id FROM eod_runs WHERE mode='active' AND purpose IN ('daily','reconcile')
          AND session_date>=? AND status IN ('queued','retrying','dispatching','dispatched','running') LIMIT 1`).bind(state.session).first();
        if (priority) { state.status = "daily-work-priority"; await save(); throw new Error("retention-qualification-daily-work-priority"); }
      }
      const selection = tickers.slice(state.nextTicker, state.nextTicker + 25);
      const bars = (await env.MARKET_DATA_DB!.prepare(`SELECT b.ticker,b.date,b.o,b.h,b.l,b.c,b.volume,b.reported_volume AS reportedVolume,
        b.reported_volume_collected_at AS reportedVolumeCollectedAt,b.feed,b.source_provider AS sourceProvider,
        b.adjustment,b.observed_at AS observedAt,b.fetched_at AS fetchedAt FROM alpaca_daily_bars b
        WHERE b.feed='sip' AND b.date=? AND b.ticker IN (SELECT value FROM json_each(?))
          AND NOT EXISTS(SELECT 1 FROM eod_adjustment_repairs r WHERE r.feed=b.feed AND r.ticker=b.ticker AND r.status='pending')
        ORDER BY b.ticker`).bind(state.session, JSON.stringify(selection)).all<MarketHistoryBar>()).results;
      const batch = await qualifyRetentionArchiveBatch(env, bars);
      state.verifiedBars += batch.verifiedBars;
      state.archiveWrites += batch.archiveWrites;
      state.missingBars += selection.length - bars.length;
      state.nextTicker += selection.length;
      await save();
      if (state.nextTicker % 250 === 0) console.log(JSON.stringify({ status: state.status, checkedSecurities: state.nextTicker,
        verifiedBars: state.verifiedBars, archiveWrites: state.archiveWrites, activeSeconds: Math.round(state.activeMs / 1000) }));
    }
    if (await env.MARKET_DATA_DB!.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision") !== state.inputClock) throw new Error("retention-qualification-input-clock-changed");
    state.completedAt = new Date().toISOString(); state.status = "completed"; await save();
    // Require room for the measured full-universe discovery/cleanup cycle and
    // an additional five-minute margin for actual indexed row deletion.
    const prune = await readDailyEvidence<{ startedAt: string; completedAt: string; deletedRows: number }>(env.OPS_DB!, "history-retention:state");
    const overheadMs = prune?.completedAt ? Date.parse(prune.completedAt) - Date.parse(prune.startedAt) : NaN;
    const qualified = Number.isFinite(overheadMs) && prune!.deletedRows > 0 && state.verifiedBars >= tickers.length * 0.95
      && state.archiveWrites >= state.verifiedBars * 0.95
      && state.activeMs + overheadMs + 5 * 60_000 <= 80 * 60_000;
    const result = { ...state, qualified, measuredRetentionMs: overheadMs, deletionMarginMs: 5 * 60_000,
      combinedBoundMs: state.activeMs + overheadMs + 5 * 60_000,
      qualificationKind: "full-universe-real-archive-copy-plus-real-retention-cycle-and-deletion-margin",
      recentRowsDeletedByQualification: 0 };
    await writeDailyEvidence(env.OPS_DB!, `${key}:result`, result);
    console.log(JSON.stringify(result));
    if (!qualified) process.exitCode = 1;
  } finally { await admission.flush(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message.slice(0, 500) : "retention-qualification-failed"); process.exitCode = 1; });
