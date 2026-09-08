import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("EOD correction clock against real migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  beforeEach(() => { storage = createSqliteD1(); storage.migrate("market-data-migrations"); }, 30_000);
  afterEach(() => storage.dispose());
  const clock = () => storage.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<{revision:number}>();
  const insert = () => storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume)
    VALUES('sip','AAA','2026-09-04',10,11,9,10.5,100)`).run();

  it("tracks manual financial corrections and deletions while ignoring collection timestamps", async () => {
    expect(await clock()).toEqual({ revision: 0 });
    await insert();
    expect(await clock()).toEqual({ revision: 1 });
    await storage.db.prepare(`UPDATE alpaca_daily_bars SET fetched_at='2026-09-09',observed_at='2026-09-09',
      reported_volume_collected_at='2026-09-09' WHERE ticker='AAA'`).run();
    expect(await clock()).toEqual({ revision: 1 });
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE ticker='AAA'").run();
    expect(await clock()).toEqual({ revision: 2 });
    await storage.db.prepare("UPDATE alpaca_daily_bars SET reported_volume=123 WHERE ticker='AAA'").run();
    expect(await clock()).toEqual({ revision: 3 });
    await storage.db.prepare("DELETE FROM alpaca_daily_bars WHERE ticker='AAA'").run();
    expect(await clock()).toEqual({ revision: 4 });
  });

  it("tracks SIP/Yahoo archive fences but ignores unrelated feeds and revision timestamps", async () => {
    await storage.db.prepare("INSERT INTO eod_input_revisions(feed,ticker) VALUES('iex','AAA')").run();
    await storage.db.prepare("UPDATE eod_input_revisions SET revision=revision+1 WHERE feed='iex'").run();
    expect(await clock()).toEqual({ revision: 0 });
    for (const feed of ["sip", "yahoo-eod"]) {
      await storage.db.prepare(`INSERT INTO eod_input_revisions(feed,ticker) VALUES(?,'AAA')
        ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1`).bind(feed).run();
      await storage.db.prepare(`INSERT INTO eod_input_revisions(feed,ticker) VALUES(?,'AAA')
        ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1`).bind(feed).run();
    }
    expect(await clock()).toEqual({ revision: 4 });
    await storage.db.prepare("UPDATE eod_input_revisions SET updated_at='2026-09-09',revision=revision").run();
    expect(await clock()).toEqual({ revision: 4 });
  });

  it("observes both sides of a bar security move and one date-only correction", async () => {
    await insert();
    await storage.db.prepare("UPDATE alpaca_daily_bars SET feed='yahoo-eod',ticker='BBB' WHERE ticker='AAA'").run();
    expect(await clock()).toEqual({ revision: 3 });
    await storage.db.prepare("UPDATE alpaca_daily_bars SET date='2026-09-08' WHERE ticker='BBB'").run();
    expect(await clock()).toEqual({ revision: 4 });
  });

  it("also observes manual removal or identity changes of relevant revision records", async () => {
    await storage.db.prepare("INSERT INTO eod_input_revisions(feed,ticker) VALUES('iex','AAA')").run();
    await storage.db.prepare("UPDATE eod_input_revisions SET feed='sip' WHERE feed='iex'").run();
    expect(await clock()).toEqual({ revision: 1 });
    await storage.db.prepare("UPDATE eod_input_revisions SET ticker='BBB' WHERE feed='sip'").run();
    expect(await clock()).toEqual({ revision: 2 });
    await storage.db.prepare("DELETE FROM eod_input_revisions WHERE feed='sip'").run();
    expect(await clock()).toEqual({ revision: 3 });
  });

  it("does not let an unrelated relocation marker suppress a manual deletion", async () => {
    await insert();
    await storage.db.prepare(`INSERT INTO eod_history_relocations(feed,ticker,date,operation_id,bar_identity)
      VALUES('sip','AAA','2026-09-04','unrelated-operation','[999]')`).run();
    await storage.db.prepare("DELETE FROM alpaca_daily_bars WHERE ticker='AAA'").run();
    expect(await clock()).toEqual({ revision: 2 });
    expect(await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first())
      .toEqual({ revision: 2 });
  });
});
