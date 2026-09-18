import { archiveMarketHistoryBars, loadVerifiedArchivedMarketHistory, marketHistoryBarsMateriallyEqual, type MarketHistoryBar } from "./market-history";
import { retentionDatabase } from "./eod-retention-database";
import type { Env } from "./types";

/** Exercise the actual archive/write/read-back path with one retained bar per
 * security. Recent rows remain intact; identical archived copies do not alter
 * analytical history or correction revisions. This is an operator qualification,
 * not a scheduled job or a substitute for real safe-pruning evidence. */
export async function qualifyRetentionArchiveBatch(env: Env, bars: MarketHistoryBar[]): Promise<{ verifiedBars: number; archiveWrites: number }> {
  if (!env.MARKET_DATA_DB || !env.MARKET_HISTORY_DB || bars.length > 25
    || new Set(bars.map(bar => `${bar.feed}:${bar.ticker}`)).size !== bars.length) {
    throw new Error("retention-qualification-invalid-batch");
  }
  let verified = 0;
  let archiveWrites = 0;
  for (const feed of ["sip", "yahoo-eod"] as const) {
    const selected = bars.filter(bar => bar.feed === feed);
    const concurrency = feed === "sip" ? 8 : 4;
    const archiveEnv = { ...env, MARKET_DATA_DB: retentionDatabase(env.MARKET_DATA_DB, concurrency),
      MARKET_HISTORY_DB: retentionDatabase(env.MARKET_HISTORY_DB, concurrency) };
    for (let index = 0; index < selected.length; index += concurrency) {
      const group = selected.slice(index, index + concurrency);
      const attempts = await Promise.allSettled(group.map(async bar => {
        const archived = await archiveMarketHistoryBars(archiveEnv, [bar], { verifiedHotRelocation: true });
        const retained = await loadVerifiedArchivedMarketHistory(archiveEnv,
          { tickers: [bar.ticker], feed, startDate: bar.date, endDate: bar.date });
        if (retained.length !== 1 || !marketHistoryBarsMateriallyEqual(bar, retained[0])) {
          throw new Error("retention-qualification-archive-parity");
        }
        return archived.rowsWritten > 0;
      }));
      const failure = attempts.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      archiveWrites += attempts.filter(result => result.status === "fulfilled" && result.value).length;
      // One indexed read per security also exercises the transaction request
      // slot needed by normal pruning, without deleting in-window prices.
      const hot = await env.MARKET_DATA_DB.batch<MarketHistoryBar>(group.map(bar => env.MARKET_DATA_DB!.prepare(
        `SELECT ticker,date,o,h,l,c,volume,reported_volume AS reportedVolume,
          reported_volume_collected_at AS reportedVolumeCollectedAt,feed,source_provider AS sourceProvider,
          adjustment,observed_at AS observedAt,fetched_at AS fetchedAt
         FROM alpaca_daily_bars WHERE feed=? AND ticker=? AND date=?`).bind(bar.feed, bar.ticker, bar.date)));
      for (let row = 0; row < group.length; row++) {
        if (hot[row].results.length !== 1 || !marketHistoryBarsMateriallyEqual(group[row], hot[row].results[0])) {
          throw new Error("retention-qualification-hot-row-changed");
        }
      }
      verified += group.length;
    }
  }
  if (verified !== bars.length) throw new Error("retention-qualification-unsupported-feed");
  return { verifiedBars: verified, archiveWrites };
}
