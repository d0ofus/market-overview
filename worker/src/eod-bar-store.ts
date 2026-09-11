import type { Env } from "./types";
import type { EodPriceBar } from "./eod-price-provider";

/** A bounded JSON parameter avoids hundreds of HTTP round trips and preserves
 * exact per-symbol trigger counts for concurrent-writer detection. */
export async function writeEodBars(env: Env, bars: EodPriceBar[]): Promise<Map<string, number>> {
  // The recent-table capacity model reserves primary prices only. Fallback
  // windows are written and verified by archiveMarketHistoryBars; accepting a
  // Yahoo row here would silently invalidate that model and its provenance.
  if (bars.some((bar) => bar.feed !== "sip" || bar.sourceProvider !== "alpaca" || bar.adjustment !== "split")) {
    throw new Error("eod-hot-store-requires-alpaca-sip-split; fallback-history-must-be-archived");
  }
  const changed = new Map<string, number>();
  for (let offset = 0; offset < bars.length; offset += 250) {
    const result = await env.MARKET_DATA_DB!.prepare(`INSERT INTO alpaca_daily_bars
      (feed,ticker,date,o,h,l,c,volume,reported_volume,reported_volume_collected_at,source_provider,adjustment,observed_at,fetched_at)
      SELECT json_extract(value,'$.feed'),json_extract(value,'$.ticker'),json_extract(value,'$.date'),
        json_extract(value,'$.o'),json_extract(value,'$.h'),json_extract(value,'$.l'),json_extract(value,'$.c'),
        json_extract(value,'$.volume'),json_extract(value,'$.reportedVolume'),json_extract(value,'$.reportedVolumeCollectedAt'),json_extract(value,'$.sourceProvider'),
        json_extract(value,'$.adjustment'),json_extract(value,'$.observedAt'),json_extract(value,'$.fetchedAt')
      FROM json_each(?) WHERE true
      ON CONFLICT(feed,ticker,date) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,
        volume=excluded.volume,reported_volume=excluded.reported_volume,source_provider=excluded.source_provider,
        reported_volume_collected_at=excluded.reported_volume_collected_at,
        adjustment=excluded.adjustment,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at
      WHERE alpaca_daily_bars.o IS NOT excluded.o OR alpaca_daily_bars.h IS NOT excluded.h
        OR alpaca_daily_bars.l IS NOT excluded.l OR alpaca_daily_bars.c IS NOT excluded.c
        OR alpaca_daily_bars.volume IS NOT excluded.volume OR alpaca_daily_bars.reported_volume IS NOT excluded.reported_volume
        OR alpaca_daily_bars.source_provider IS NOT excluded.source_provider OR alpaca_daily_bars.adjustment IS NOT excluded.adjustment
      RETURNING ticker`).bind(JSON.stringify(bars.slice(offset, offset + 250))).all<{ticker:string}>();
    for (const row of result.results) changed.set(row.ticker, (changed.get(row.ticker) ?? 0) + 1);
  }
  return changed;
}
