import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { runEodRetention, EOD_RETENTION_STATE_KEY } from "../src/eod-retention-runner";
import * as maintenance from "../src/eod-history-maintenance";
import * as capacity from "../src/eod-history-capacity";
import * as cleanup from "../src/eod-run-maintenance";
import { eodHash } from "../src/eod-publication-service";
import { readDailyEvidence } from "../src/eod-daily-release";
import type { Env } from "../src/types";

afterEach(()=>vi.restoreAllMocks());
describe("provider-free resumable retention", () => {
  it("keeps the saved population and cursor across interruption and membership changes", async () => {
    const storage=createSqliteD1();
    try {
      storage.migrate("ops-migrations");
      storage.script("CREATE TABLE eod_publications(scope TEXT,session_date TEXT,payload_json TEXT,payload_checksum TEXT,status TEXT,revision INTEGER);");
      const insert=async(tickers:string[],date:string)=>{
        const payload={rows:tickers.map(ticker=>[ticker])};
        await storage.db.prepare("INSERT INTO eod_publications VALUES('history:catalog',?,?,?,'accepted',1)")
          .bind(date,JSON.stringify(payload),await eodHash(payload)).run();
      };
      await insert(["AAA","BBB"],"2026-09-11");
      const env={DB:storage.db,MARKET_DATA_DB:storage.db,MARKET_HISTORY_DB:storage.db,OPS_DB:storage.db,
        EOD_ARCHIVE_PRUNE_ENABLED:"true"} as Env;
      const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("retention must not call a provider"));
      vi.spyOn(capacity,"refreshHistoryMaintenanceEvidence").mockResolvedValue({hotSessions:90,capacity:{} as never,readers:{} as never,sample:{} as never});
      vi.spyOn(cleanup,"cleanupEodRunState").mockResolvedValue({} as never);
      vi.spyOn(maintenance,"cleanupUnpointedHistoryBlocks").mockResolvedValue({status:"complete",cursor:null,deletedBlocks:2});
      const prune=vi.spyOn(maintenance,"archiveAndPruneMarketHistory")
        .mockResolvedValueOnce({status:"partial",cursor:{tickerIndex:1,afterDate:"2025-01-02"},archivedRows:500,deletedRows:500,concurrentCorrections:0})
        .mockRejectedValueOnce(new Error("d1-request-timeout"));
      await expect(runEodRetention(env,"first",async()=>{})).rejects.toThrow("d1-request-timeout");
      expect(await readDailyEvidence(storage.db,EOD_RETENTION_STATE_KEY)).toMatchObject({tickers:["AAA","BBB"],deletedRows:500,cursor:{tickerIndex:1}});
      await insert(["AAA","CCC"],"2026-09-14");
      prune.mockResolvedValue({status:"complete",cursor:null,archivedRows:1,deletedRows:1,concurrentCorrections:0});
      expect(await runEodRetention(env,"second",async()=>{})).toMatchObject({status:"complete",symbols:2,deletedRows:502});
      expect(prune.mock.calls[2][1]).toMatchObject({tickers:["AAA","BBB"],endDate:"2026-09-11",catalogSessionDate:"2026-09-14",cursor:{tickerIndex:1,afterDate:"2025-01-02"}});
      expect(fetch).not.toHaveBeenCalled();
    } finally { storage.dispose(); }
  });
});
