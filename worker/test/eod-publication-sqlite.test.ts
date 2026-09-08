import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeEodPublication, type EodPublicationInput } from "../src/eod-publication-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("EOD publication transactions against real migrated SQLite", { timeout: 20_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  beforeEach(async () => {
    storage = createSqliteD1();
    storage.migrate("market-data-migrations");
    env = { DB: storage.db, MARKET_DATA_DB: storage.db } as Env;
    await storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume)
      VALUES('sip','AAA','2026-09-04',10,11,9,10.5,100)`).run();
  }, 30_000);
  afterEach(() => storage.dispose());
  const input = (overrides: Partial<EodPublicationInput> = {}): EodPublicationInput => ({
    scope: "overview:default", sessionDate: "2026-09-04", inputHash: "input-a", methodologyVersion: "test-v1",
    payload: { asOfDate: "2026-09-04", price: 10.5 }, promote: true,
    revisions: [{ feed: "sip", ticker: "AAA", revision: 1 }], ...overrides,
  });
  async function pointer() {
    return storage.db.prepare(`SELECT p.publication_id as id,v.revision,p.session_date as sessionDate
      FROM eod_publication_pointers p JOIN eod_publications v ON v.id=p.publication_id WHERE p.scope='overview:default'`)
      .first<{ id: string; revision: number; sessionDate: string }>();
  }

  it("keeps one immutable record on idempotent retry and preserves separate date history", async () => {
    const first = await storeEodPublication(env, input());
    expect(await storeEodPublication(env, input())).toBe(first);
    const next = await storeEodPublication(env, input({ sessionDate: "2026-09-08", inputHash: "input-b" }));
    expect(await pointer()).toMatchObject({ id: next, sessionDate: "2026-09-08" });
    expect(await storage.db.prepare("SELECT COUNT(*) as count FROM eod_publications").first()).toEqual({ count: 2 });
    await storeEodPublication(env, input({ sessionDate: "2026-09-03", inputHash: "input-old" }));
    expect(await pointer()).toMatchObject({ id: next });
  });

  it("stores a same-date correction as revision2 and retains revision1 history", async () => {
    const first = await storeEodPublication(env, input());
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE ticker='AAA'").run();
    const second = await storeEodPublication(env, input({ inputHash: "corrected", payload: { price: 10.75 },
      revisions: [{ feed: "sip", ticker: "AAA", revision: 2 }] }));
    expect(second).not.toBe(first);
    expect(await pointer()).toMatchObject({ id: second, revision: 2 });
    expect((await storage.db.prepare("SELECT revision,status FROM eod_publications ORDER BY revision").all()).results)
      .toEqual([{ revision: 1, status: "accepted" }, { revision: 2, status: "accepted" }]);
  });

  it("rejects a stale input manifest after an independent writer changes a source bar", async () => {
    const first = await storeEodPublication(env, input());
    await storage.db.prepare("UPDATE alpaca_daily_bars SET reported_volume=200 WHERE ticker='AAA'").run();
    await expect(storeEodPublication(env, input({ inputHash: "stale" }))).rejects.toThrow(/inputs-changed/);
    expect(await pointer()).toMatchObject({ id: first });
    expect(await storage.db.prepare("SELECT status FROM eod_publications WHERE status='candidate'").first())
      .toEqual({ status: "candidate" });
  });

  it("does not roll a same-date publication backward on an older accepted retry", async () => {
    await storeEodPublication(env, input());
    const newer = await storeEodPublication(env, input({ inputHash: "membership-revision-b", payload: { price: 10.5, members: 501 } }));
    // A historical retry may report supersession; it must never move the head backwards.
    await storeEodPublication(env, input()).catch(() => undefined);
    expect(await pointer()).toMatchObject({ id: newer, revision: 2 });
  });

  it("does not certify a previously accepted retry after its input revision changed", async () => {
    await storeEodPublication(env, input());
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE ticker='AAA'").run();
    await expect(storeEodPublication(env, input())).rejects.toThrow(/inputs-changed/);
  });

  it("rejects stale shadow candidates without promoting a pointer or certifying rollout evidence", async () => {
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE ticker='AAA'").run();
    await expect(storeEodPublication(env,input({promote:false}))).rejects.toThrow("publication-inputs-changed");
    expect(await pointer()).toBeNull();
    expect(await storage.db.prepare("SELECT status FROM eod_publications").first()).toEqual({status:"candidate"});
  });

  it("treats a methodology change as a distinct input even when callers reuse a price hash", async () => {
    const first = await storeEodPublication(env, input());
    const second = await storeEodPublication(env, input({ methodologyVersion: "test-v2" }));
    expect(second).not.toBe(first);
    expect(await pointer()).toMatchObject({ id: second, revision: 2 });
  });

  it("increments bar revisions atomically for manual value changes and deletions, not metadata-only refreshes", async () => {
    const revision = () => storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first();
    expect(await revision()).toEqual({ revision: 1 });
    await storage.db.prepare(`UPDATE alpaca_daily_bars SET fetched_at='2026-09-09',observed_at='2026-09-09',
      reported_volume_collected_at='2026-09-09' WHERE ticker='AAA'`).run();
    expect(await revision()).toEqual({ revision: 1 });
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=10.75 WHERE ticker='AAA'").run();
    expect(await revision()).toEqual({ revision: 2 });
    await storage.db.prepare("DELETE FROM alpaca_daily_bars WHERE ticker='AAA'").run();
    expect(await revision()).toEqual({ revision: 3 });
  });

  it.each([
    { feed: "sip", ticker: "BBB" },
    { feed: "yahoo-eod", ticker: "AAA" },
    { feed: "yahoo-eod", ticker: "BBB" },
  ])("invalidates both security manifests on a move to $feed/$ticker", async ({ feed, ticker }) => {
    const oldPublication = await storeEodPublication(env, input());
    const newInput = input({ scope: "breadth:sp500", inputHash: "missing-security",
      revisions: [{ feed, ticker, revision: 0 }] });
    const newPublication = await storeEodPublication(env, newInput);
    await storage.db.prepare("UPDATE alpaca_daily_bars SET feed=?,ticker=? WHERE feed='sip' AND ticker='AAA'")
      .bind(feed, ticker).run();
    expect(await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first())
      .toEqual({ revision: 2 });
    expect(await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed=? AND ticker=?").bind(feed, ticker).first())
      .toEqual({ revision: 1 });
    await expect(storeEodPublication(env, input())).rejects.toThrow(/inputs-changed/);
    await expect(storeEodPublication(env, newInput)).rejects.toThrow(/inputs-changed/);
    expect(await pointer()).toMatchObject({ id: oldPublication });
    expect(await storage.db.prepare("SELECT publication_id as id FROM eod_publication_pointers WHERE scope='breadth:sp500'").first())
      .toEqual({ id: newPublication });
  });

  it("invalidates a date-only move once and rejects its prior publication manifest", async () => {
    const first = await storeEodPublication(env, input());
    await storage.db.prepare("UPDATE alpaca_daily_bars SET date='2026-09-08' WHERE ticker='AAA'").run();
    expect(await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first())
      .toEqual({ revision: 2 });
    await expect(storeEodPublication(env, input())).rejects.toThrow(/inputs-changed/);
    expect(await pointer()).toMatchObject({ id: first });
  });
});
