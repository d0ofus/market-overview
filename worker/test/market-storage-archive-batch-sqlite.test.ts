import { describe, expect, it } from "vitest";
import { copyStorageArchiveBlock, copyStorageArchiveBlocks } from "../src/market-storage-copy";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import type { MarketHistoryBar } from "../src/market-history";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { estimateEodQueries, type EodSql } from "../src/eod-d1-rest";

const bar=(ticker:string,close=10):MarketHistoryBar => ({feed:"sip",ticker,date:"2026-09-08",o:close,h:close,l:close,c:close,
  volume:null,reportedVolume:null,reportedVolumeCollectedAt:null,sourceProvider:"alpaca",adjustment:"split",observedAt:null,fetchedAt:"2026-09-09"});

describe("bounded archive copy transport against real SQLite", () => {
  it("verifies sixteen independent blocks within transport/admission limits and replays an ambiguous committed promotion", async () => {
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      history.script((await prepareStorageSourceFence(history.db)).statements.map(({sql}) => sql).join("\n"));
      const groups=Array.from({length:16},(_,index) => [bar(`TEST${index}`)]);
      const requestSizes:number[]=[];
      let interrupt=true;
      const wrapped={...history.db,batch:async <T>(statements:D1PreparedStatement[]) => {
        requestSizes.push(statements.length);
        expect(statements.length).toBeLessThanOrEqual(40);
        const estimate=estimateEodQueries(statements as unknown as EodSql[]);
        expect(estimate.reads).toBeLessThanOrEqual(250_000);
        expect(estimate.writes).toBeLessThanOrEqual(10_000);
        const result=await history.db.batch<T>(statements);
        if (interrupt && requestSizes.length===3) throw new Error("d1-network-error");
        return result;
      }} as D1Database;
      await expect(copyStorageArchiveBlocks(wrapped,groups)).rejects.toThrow("d1-network-error");
      expect(requestSizes).toEqual([16,32,32]);
      const pointers=await history.db.prepare("SELECT block_id,previous_block_id FROM market_history_block_pointers ORDER BY ticker").all();
      expect(pointers.results).toHaveLength(16);
      interrupt=false;requestSizes.length=0;
      const result=await copyStorageArchiveBlocks(wrapped,groups);
      expect(result).toHaveLength(16);
      expect(requestSizes).toEqual([16,16,16]);
      expect((await history.db.prepare("SELECT block_id,previous_block_id FROM market_history_block_pointers ORDER BY ticker").all()).results)
        .toEqual(pointers.results);
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(16);
      requestSizes.length=0;
      await copyStorageArchiveBlocks(wrapped,groups.map((rows) => rows.map((row) => ({...row,o:11,h:11,l:11,c:11}))));
      expect(requestSizes).toEqual([16,32,32,16]);
    } finally {history.dispose();}
  },20_000);

  it("rejects a lost pointer comparison even when guards and another group report successful writes", async () => {
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      history.script((await prepareStorageSourceFence(history.db)).statements.map(({sql}) => sql).join("\n"));
      let calls=0,competitor:string|undefined;
      const wrapped={...history.db,batch:async <T>(statements:D1PreparedStatement[]) => {
        if (++calls===3) competitor=(await copyStorageArchiveBlock(history.db,[bar("AAA",20)])).id;
        return history.db.batch<T>(statements);
      }} as D1Database;
      await expect(copyStorageArchiveBlocks(wrapped,[[bar("AAA")],[bar("BBB")]]))
        .rejects.toThrow("storage-archive-concurrent-change");
      expect(await history.db.prepare("SELECT block_id FROM market_history_block_pointers WHERE ticker='AAA'").first("block_id"))
        .toBe(competitor);
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(3);
      // No partial-success result escapes. Replay preserves all revisions and
      // validates the frozen source values before advancing its caller's cursor.
      expect(await copyStorageArchiveBlocks(history.db,[[bar("AAA")],[bar("BBB")]])).toHaveLength(2);
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(3);
    } finally {history.dispose();}
  },20_000);

  it("rejects duplicate years and oversized groups before database writes", async () => {
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      await expect(copyStorageArchiveBlocks(history.db,[[bar("AAA")],[bar("AAA")]])).rejects.toThrow("storage-archive-duplicate-year");
      await expect(copyStorageArchiveBlocks(history.db,Array.from({length:17},(_,index) => [bar(`TEST${index}`)])))
        .rejects.toThrow("storage-archive-invalid-batch");
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(0);
    } finally {history.dispose();}
  });

  it("checks every staged block before promoting any pointer", async () => {
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      history.script(`CREATE TRIGGER corrupt_second_archive AFTER INSERT ON market_history_blocks
        WHEN NEW.ticker='BBB' BEGIN UPDATE market_history_blocks SET checksum='invalid' WHERE id=NEW.id; END;`);
      await expect(copyStorageArchiveBlocks(history.db,[[bar("AAA")],[bar("BBB")]]))
        .rejects.toThrow("storage-archive-readback-missing");
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(2);
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_block_pointers").first("count")).toBe(0);
    } finally {history.dispose();}
  });
});
