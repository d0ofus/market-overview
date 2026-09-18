import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { dailySchemaHash, loadDailyRelease, assertDailyReleaseBindings, writeDailyEvidence, dailyStorageStatus, type DailyRelease } from "../src/eod-daily-release";
import { eodHash } from "../src/eod-publication-service";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import type { Env } from "../src/types";

describe("daily production release identity", () => {
  it("keeps dated evidence, requires the approved revision/profile and rejects a frozen or changed binding", async () => {
    const storage=createSqliteD1();
    try {
      storage.migrate("ops-migrations");
      storage.script("CREATE TABLE market_storage_fence(id TEXT PRIMARY KEY,status TEXT,migration_id TEXT); INSERT INTO market_storage_fence VALUES('default','open','market-storage:test');");
      const revision="a".repeat(40),digest="b".repeat(64),date="2026-01-02T00:00:00Z",uuid="10000000-0000-4000-8000-000000000001";
      const schema=await dailySchemaHash(storage.db);
      const proof:DailyRelease={version:2,policy:"paid-daily-v2",budgetProfile:"paid",codeRevision:revision,methodologyVersion:EOD_METRICS_VERSION,
        approvedAt:date,migrationId:"market-storage:test",hotSessions:90,bindings:{core:uuid,market:uuid,source:uuid,history:uuid,ops:uuid},
        schemas:{market:schema,history:schema},sourceEvidence:[{key:"copy",hash:digest,recordedAt:date},{key:"readers",hash:digest,recordedAt:date}],
        readers:{contractVersion:1,checkedAt:date,consumers:[...MARKET_HISTORY_REQUIRED_CONSUMERS],parityPassed:true,codeRevision:revision},
        publicationSession:"2026-01-02",publicationIds:["1","2","3","4","5","6"],sharedTickerCount:6330,validationHash:digest};
      const env={DB:storage.db,MARKET_DATA_DB:storage.db,MARKET_HISTORY_DB:storage.db,OPS_DB:storage.db,EOD_CODE_REVISION:revision,EOD_BUDGET_PROFILE:"paid"} as Env;
      expect(await loadDailyRelease(env)).toBeNull();
      await writeDailyEvidence(storage.db,`daily-release:${revision}`,{proof,proofHash:await eodHash(proof)});
      expect((await loadDailyRelease(env))?.sourceEvidence[0].recordedAt).toBe(date);
      await expect(assertDailyReleaseBindings(env,proof)).resolves.toBeUndefined();
      await expect(loadDailyRelease({...env,EOD_BUDGET_PROFILE:"free"})).rejects.toThrow("eod-daily-release-integrity");
      expect(await loadDailyRelease({...env,EOD_CODE_REVISION:"c".repeat(40)})).toBeNull();
      await storage.db.prepare("UPDATE market_storage_fence SET status='frozen'").run();
      await expect(assertDailyReleaseBindings(env,proof)).rejects.toThrow("database-mismatch");
      await storage.db.prepare("UPDATE market_storage_fence SET status='open'").run();
      storage.script("CREATE INDEX changed_schema ON market_storage_fence(status);");
      await expect(assertDailyReleaseBindings(env,proof)).rejects.toThrow("database-mismatch");
      await writeDailyEvidence(storage.db,"daily-storage:current",{checkedAt:date,databases:[],accountBytes:0});
      expect((await dailyStorageStatus(env,new Date("2026-01-04T00:00:00Z"))).status).toBe("unmeasured");
    } finally { storage.dispose(); }
  });
});
