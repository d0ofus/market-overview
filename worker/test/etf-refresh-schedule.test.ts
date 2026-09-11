import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDueEtfRefreshTickers } from "../src/etf-refresh-schedule";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-09-11T16:00:00Z");
const fixtures: ReturnType<typeof createSqliteD1>[] = [];
function fixture(metadata = true) {
  const sqlite = createSqliteD1();
  fixtures.push(sqlite);
  // Use the actual Core schema without the unrelated watchlist/symbol seed rows.
  sqlite.script(readFileSync("migrations/0006_etf_watchlists_and_constituents.sql", "utf8").split("INSERT OR IGNORE")[0]);
  if (metadata) sqlite.script(readFileSync("migrations/0051_etf_sync_metadata.sql", "utf8"));
  return sqlite;
}
async function add(db: D1Database, ticker: string, options: {
  attempt?: string; status?: string; sourceDate?: string | null;
  fullAt?: string; metadata?: boolean; empty?: boolean;
} = {}) {
  await db.prepare("INSERT INTO etf_watchlists(list_type,ticker,fund_name) VALUES('sector',?,?)").bind(ticker, ticker).run();
  if (!options.empty) {
    await db.prepare("INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,source,as_of_date) VALUES(?,?,'AAPL','issuer',?)")
      .bind(ticker, ticker, options.sourceDate === undefined ? "2026-08-20" : options.sourceDate).run();
  }
  if (options.attempt) {
    await db.prepare("INSERT INTO etf_constituent_sync_status(etf_ticker,last_synced_at,status,records_count) VALUES(?,?,?,?)")
      .bind(ticker, options.attempt, options.status ?? "success", options.empty ? 0 : 1).run();
    if (options.metadata !== false && options.fullAt) {
      await db.prepare("UPDATE etf_constituent_sync_status SET last_full_synced_at=? WHERE etf_ticker=?")
        .bind(options.fullAt, ticker).run();
    }
  }
}
afterEach(() => { for (const sqlite of fixtures.splice(0)) sqlite.dispose(); });

describe("ETF refresh scheduling against the real Core schema", () => {
  it("orders every eligible fund fairly so persistent failures cannot starve an older full snapshot", async () => {
    const { db } = fixture();
    for (const ticker of ["BAD1", "BAD2", "BAD3", "BAD4", "BAD5"]) {
      await add(db, ticker, { status: "error", attempt: "2026-09-11T08:00:00Z" });
    }
    await add(db, "XLC", { attempt: "2026-08-20T12:00:00Z" });
    const selected = await loadDueEtfRefreshTickers(db, { now: NOW });
    expect(selected).toEqual(["XLC", "BAD1", "BAD2", "BAD3", "BAD4"]);
    await db.prepare("UPDATE etf_constituent_sync_status SET last_synced_at=? WHERE etf_ticker IN ('XLC','BAD1','BAD2','BAD3','BAD4')")
      .bind(NOW.toISOString()).run();
    expect(await loadDueEtfRefreshTickers(db, { now: NOW })).toEqual(["BAD5"]);
  });

  it("retries errors, partials and empty results only after six hours", async () => {
    const { db } = fixture();
    await add(db, "ERROR", { status: "error", attempt: "2026-09-11T10:00:01Z" });
    await add(db, "PARTIAL", { status: "partial", attempt: "2026-09-11T10:00:00Z", fullAt: "2026-08-01T00:00:00Z" });
    await add(db, "EMPTY", { empty: true, attempt: "2026-09-11T10:00:00Z" });
    expect(await loadDueEtfRefreshTickers(db, { now: NOW })).toEqual(["EMPTY", "PARTIAL"]);
    expect(await loadDueEtfRefreshTickers(db, { now: new Date(NOW.getTime() + 1000) })).toEqual(["EMPTY", "PARTIAL", "ERROR"]);
  });

  it("uses the source date and retained full age, pacing unchanged stale snapshots at most daily", async () => {
    const { db } = fixture();
    await add(db, "OLD_SOURCE", { attempt: "2026-09-10T16:00:00Z", fullAt: "2026-09-10T16:00:00Z" });
    await add(db, "RECHECKED", { attempt: "2026-09-10T16:00:01Z", fullAt: "2026-09-10T16:00:01Z" });
    await add(db, "OLD_FULL", { attempt: "2026-09-10T16:00:00Z", fullAt: "2026-08-01T00:00:00Z", sourceDate: "2026-09-10" });
    expect(await loadDueEtfRefreshTickers(db, { now: NOW })).toEqual(["OLD_FULL", "OLD_SOURCE"]);
  });

  it("excludes known liquidated funds before the limit", async () => {
    const { db } = fixture();
    await add(db, "EATZ", { empty: true });
    await add(db, "XLC", { attempt: "2026-08-20T12:00:00Z" });
    expect(await loadDueEtfRefreshTickers(db, { now: NOW, batchLimit: 1 })).toEqual(["XLC"]);
  });

  it("honors explicit stale-day overrides and treats undated/future sources as needing refresh", async () => {
    const { db } = fixture();
    await add(db, "TEN_DAYS", { attempt: "2026-09-01T12:00:00Z", sourceDate: "2026-09-01" });
    await add(db, "UNDATED", { attempt: "2026-09-10T12:00:00Z", sourceDate: null });
    await add(db, "FUTURE", { attempt: "2026-09-10T12:00:00Z", sourceDate: "2026-09-12" });
    expect(await loadDueEtfRefreshTickers(db, { now: NOW })).toEqual(["TEN_DAYS", "FUTURE", "UNDATED"]);
    expect(await loadDueEtfRefreshTickers(db, { now: NOW, staleDays: 14 })).toEqual(["FUTURE", "UNDATED"]);
  });

  it("supports the legacy metadata schema without retrying quota failures", async () => {
    const { db } = fixture(false);
    await add(db, "XLC", { attempt: "2026-08-20T12:00:00Z", metadata: false });
    expect(await loadDueEtfRefreshTickers(db, { now: NOW })).toEqual(["XLC"]);
    const all = vi.fn().mockRejectedValue(new Error("D1 daily read quota exhausted"));
    const failedDb = { prepare: vi.fn(() => ({ bind: () => ({ all }) })) } as unknown as D1Database;
    await expect(loadDueEtfRefreshTickers(failedDb, { now: NOW })).rejects.toThrow("quota exhausted");
    expect(all).toHaveBeenCalledTimes(1);
  });
});
