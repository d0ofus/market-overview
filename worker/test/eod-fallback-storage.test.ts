import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { assertYahooArchiveCapacity, reserveYahooArchiveBlock } from "../src/eod-fallback-storage";
import { EOD_YAHOO_ARCHIVE_TICKER_LIMIT } from "../src/eod-storage-layout";
import { archiveMarketHistoryBars, encodeMarketHistoryBlock, loadMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { writeEodBars } from "../src/eod-bar-store";
import type { Env } from "../src/types";

const bar = (ticker: string, feed = "yahoo-eod"): MarketHistoryBar & { reportedVolume: null } => ({
  ticker, feed, date: "2026-09-10", o: 100, h: 101, l: 99, c: 100, volume: 10, reportedVolume: null,
  sourceProvider: feed === "sip" ? "alpaca" : "yahoo", adjustment: "split", observedAt: null, fetchedAt: null,
});

describe("bounded secondary archive storage", () => {
  let history: ReturnType<typeof createSqliteD1>;
  beforeEach(() => { history = createSqliteD1(); history.migrate("history-migrations"); });
  afterEach(() => history.dispose());

  async function fillSlots() {
    // Capacity counts unpromoted blocks too; they occupy real storage and must
    // not let two first writers claim the same final slot.
    await history.db.prepare(`INSERT INTO market_history_blocks
      (id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
      SELECT value,'yahoo-eod',value,2026,1,'gzip-json-v1','fixture',1,'2026-09-10','2026-09-10',1,'fixture'
      FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: EOD_YAHOO_ARCHIVE_TICKER_LIMIT }, (_, i) => `S${i}`))).run();
  }

  it("counts staged identities, rejects overflow atomically, and allows corrections for an existing identity", async () => {
    await fillSlots();
    await expect(assertYahooArchiveCapacity(history.db, "NEW")).rejects.toThrow("yahoo-fallback-storage-full");
    await expect(reserveYahooArchiveBlock(history.db, await encodeMarketHistoryBlock([bar("NEW")]))).rejects.toThrow("yahoo-fallback-storage-full");
    await expect(assertYahooArchiveCapacity(history.db, "S0")).resolves.toBeUndefined();
    await reserveYahooArchiveBlock(history.db, await encodeMarketHistoryBlock([bar("S0")]));
    expect(await history.db.prepare("SELECT COUNT(DISTINCT ticker) AS count FROM market_history_blocks WHERE feed='yahoo-eod'").first())
      .toEqual({ count: EOD_YAHOO_ARCHIVE_TICKER_LIMIT });
  });

  it("leaves no repair fence when fallback admission fails and retains primary archive access", async () => {
    await fillSlots();
    const market = createSqliteD1();
    try {
      market.migrate("market-data-migrations");
      const env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: history.db, EOD_RUNNER_MODE: "active" } as Env;
      await expect(archiveMarketHistoryBars(env, [bar("NEW")])).rejects.toThrow("yahoo-fallback-storage-full");
      expect(await market.db.prepare("SELECT COUNT(*) AS count FROM eod_adjustment_repairs").first()).toEqual({ count: 0 });
      await archiveMarketHistoryBars(env, [bar("PRIMARY", "sip")]);
      expect(await loadMarketHistory(env, { tickers: ["PRIMARY"], feed: "sip" })).toHaveLength(1);
      await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,owner_token,updated_at) VALUES('yahoo-eod','S0','pending','2026-09-10','another-writer','2026-09-10T21:00:00Z')").run();
      await expect(archiveMarketHistoryBars(env, [bar("S0")])).rejects.toThrow("already has a pending adjustment repair");
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks WHERE feed='yahoo-eod' AND ticker='S0'").first())
        .toEqual({ count: 1 });
    } finally { market.dispose(); }
  });

  it("rejects an entire mixed-provider hot batch before issuing any SQL", async () => {
    const prepare = vi.fn();
    const env = { MARKET_DATA_DB: { prepare } } as unknown as Env;
    await expect(writeEodBars(env, [bar("PRIMARY", "sip"), { ...bar("FALLBACK"), feed: "sip" }]))
      .rejects.toThrow("eod-hot-store-requires-alpaca-sip-split");
    expect(prepare).not.toHaveBeenCalled();
  });
});
