import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("EOD migration deployment parsing", () => {
  it.each(["\n", "\r\n"])("executes every Wrangler-split statement with line ending %j", async (lineEnding) => {
    const storage = createSqliteD1();
    try {
      const directory = resolve(process.cwd(), "market-data-migrations");
      const filename = "0008_eod_publications.sql";
      const prior = readdirSync(directory).filter((name) => name.endsWith(".sql") && name < filename).sort();
      storage.script(prior.map((name) => readFileSync(resolve(directory, name), "utf8")).join("\n"));
      const sql = readFileSync(resolve(directory, filename), "utf8").replace(/\r?\n/g, lineEnding);
      // SQLite executescript alone accepts SQL that Wrangler's compound-token
      // splitter misreads. Execute its actual output as individual statements.
      const statements = unstable_splitSqlQuery(sql);
      expect(statements).toHaveLength(18);
      expect(statements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(6);
      await storage.db.batch(statements.map((statement) => storage.db.prepare(statement)));
      expect((await storage.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).results)
        .toEqual([
          { name: "eod_bar_delete" }, { name: "eod_bar_insert" }, { name: "eod_bar_update" },
          { name: "eod_revision_clock_delete" }, { name: "eod_revision_clock_insert" }, { name: "eod_revision_clock_update" },
        ]);
      await storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume)
        VALUES('sip','AAA','2026-09-08',10,11,9,10.5,100)`).run();
      await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE feed='sip' AND ticker='AAA'").run();
      await storage.db.prepare("DELETE FROM alpaca_daily_bars WHERE feed='sip' AND ticker='AAA'").run();
      expect(await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first())
        .toEqual({ revision: 3 });
      expect(await storage.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first())
        .toEqual({ revision: 3 });
    } finally {
      storage.dispose();
    }
  });
});
