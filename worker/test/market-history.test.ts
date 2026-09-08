import { describe, expect, it } from "vitest";
import {
  archiveMarketHistoryBars, decodeMarketHistoryBlock, encodeMarketHistoryBlock, loadMarketHistory,
  MarketHistoryIntegrityError, type MarketHistoryBar, type MarketHistoryBlock,
} from "../src/market-history";
import type { Env } from "../src/types";

function bar(date: string, close = 12.3456789012345, ticker = "AAA"): MarketHistoryBar {
  return {
    ticker, date, o: close - 0.25, h: close + 0.75, l: close - 0.5, c: close,
    volume: null, reportedVolume: null, feed: "sip", sourceProvider: "alpaca", adjustment: "split",
    observedAt: `${date}T04:00:00Z`, fetchedAt: "2026-09-08T08:05:06.123Z",
  };
}

function readerEnv(hot: MarketHistoryBar[], blocks?: MarketHistoryBlock[]): Env {
  const db = (rows: unknown[]) => ({
    prepare() {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        all: async () => ({ results: rows }),
      };
      return statement;
    },
  });
  return {
    DB: db([]), MARKET_DATA_DB: db(hot),
    ...(blocks ? { MARKET_HISTORY_DB: db(blocks.map((block) => ({ ...block, verifiedAt: "2026-09-08T00:00:00Z" }))) } : {}),
    ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split",
  } as unknown as Env;
}

function writableArchive() {
  const blocks = new Map<string, MarketHistoryBlock>();
  const pointers = new Map<string, { id: string; previous: string | null }>();
  const state = { corruptReadback: false, conflict: false, writes: 0 };
  const key = (feed: unknown, ticker: unknown, year: unknown) => `${feed}:${ticker}:${year}`;
  function prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { args = values; return statement; },
      async all() {
        const tickers = JSON.parse(String(args[1])) as string[];
        return { results: Array.from(pointers, ([identity, pointer]) => {
          const block = blocks.get(pointer.id)!;
          return identity.startsWith(`${args[0]}:`) && tickers.includes(block.ticker)
            ? { ...block, previousBlockId: pointer.previous } : null;
        }).filter(Boolean), meta: { rows_read: pointers.size } };
      },
      async first() {
        const block = blocks.get(String(args[0]));
        return block ? { ...block, ...(state.corruptReadback ? { payloadBase64: "corrupt" } : {}) } : null;
      },
      async run() {
        let changes = 0;
        if (sql.startsWith("INSERT OR IGNORE INTO market_history_blocks")) {
          if (!blocks.has(String(args[0]))) {
            blocks.set(String(args[0]), {
              id: String(args[0]), feed: String(args[1]), ticker: String(args[2]), calendarYear: Number(args[3]),
              schemaVersion: Number(args[4]), codec: String(args[5]), checksum: String(args[6]), rowCount: Number(args[7]),
              firstDate: String(args[8]), lastDate: String(args[9]), uncompressedBytes: Number(args[10]), payloadBase64: String(args[11]),
            });
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE market_history_blocks")) {
          const block = blocks.get(String(args[1]));
          if (block && block.checksum === args[2]) { block.verifiedAt = String(args[0]); changes = 1; }
        } else if (sql.startsWith("INSERT INTO market_history_block_pointers")) {
          const identity = key(args[0], args[1], args[2]);
          const current = pointers.get(identity);
          if (!state.conflict && (!current || current.id === args[5])) {
            pointers.set(identity, { id: String(args[3]), previous: current?.id ?? null });
            changes = 1;
          }
        } else if (sql.startsWith("DELETE FROM market_history_blocks")) {
          const id = String(args[0]);
          if (!Array.from(pointers.values()).some((pointer) => pointer.id === id || pointer.previous === id)) changes = Number(blocks.delete(id));
        } else throw new Error(`Unexpected archive write: ${sql}`);
        state.writes += changes;
        return { meta: { changes, rows_read: 1, rows_written: changes } };
      },
    };
    return statement;
  }
  const db = { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  } } as unknown as D1Database;
  return { db, blocks, pointers, state };
}

describe("lossless verified market history", () => {
  it("round trips every OHLCV and provenance field without rounding or replacing nulls", async () => {
    const rows = [bar("2025-01-02"), { ...bar("2025-01-03", 0.000000123456789), volume: 9_007_199_254_740_990 }];
    const block = await encodeMarketHistoryBlock(rows);
    expect(await decodeMarketHistoryBlock(block)).toEqual(rows);
    expect(block.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect((await encodeMarketHistoryBlock([...rows].reverse())).checksum).toBe(block.checksum);
  });

  it("rejects corrupted payloads, checksum changes and dishonest manifests", async () => {
    const block = await encodeMarketHistoryBlock([bar("2025-01-02")]);
    for (const invalid of [
      { ...block, payloadBase64: "broken" }, { ...block, checksum: "0".repeat(64) },
      { ...block, rowCount: 2 }, { ...block, ticker: "BBB" },
      { ...block, uncompressedBytes: 8 }, { ...block, schemaVersion: 2 },
    ]) {
      await expect(decodeMarketHistoryBlock(invalid)).rejects.toBeInstanceOf(MarketHistoryIntegrityError);
    }
  });

  it("rejects mixed securities/years, invalid dates and duplicate dates before storage", async () => {
    for (const rows of [
      [bar("2025-01-02"), bar("2026-01-02")],
      [bar("2025-01-02"), bar("2025-01-03", 10, "BBB")],
      [bar("2025-02-30")], [bar("2025-01-02"), bar("2025-01-02")],
    ]) await expect(encodeMarketHistoryBlock(rows)).rejects.toBeInstanceOf(MarketHistoryIntegrityError);
  });

  it("merges archived and hot history, giving hot corrections precedence before trailing limits", async () => {
    const archived = await encodeMarketHistoryBlock([bar("2025-01-02", 10), bar("2025-01-03", 11), bar("2025-01-06", 12)]);
    const corrected = bar("2025-01-06", 13);
    const latest = bar("2025-01-07", 14);
    const env = readerEnv([corrected, latest], [archived]);
    expect(await loadMarketHistory(env, { tickers: ["aaa"], limitPerTicker: 3 })).toEqual([
      bar("2025-01-03", 11), corrected, latest,
    ]);
    expect(await loadMarketHistory(env, { tickers: ["AAA"], startDate: "2025-01-03", endDate: "2025-01-06" })).toEqual([
      bar("2025-01-03", 11), corrected,
    ]);
  });

  it("uses archive observations newer than hot history even when hot already fills the requested count", async () => {
    const archived = await encodeMarketHistoryBlock([bar("2025-01-06", 12)]);
    const env = readerEnv([bar("2025-01-02", 10), bar("2025-01-03", 11)], [archived]);
    expect((await loadMarketHistory(env, { tickers: ["AAA"], limitPerTicker: 2 })).map((row) => row.date))
      .toEqual(["2025-01-03", "2025-01-06"]);
  });

  it("preserves hot-only behavior when the archive binding is absent", async () => {
    const rows = [bar("2025-01-02"), bar("2025-01-03")];
    expect(await loadMarketHistory(readerEnv(rows), { tickers: ["AAA"] })).toEqual(rows);
  });

  it("preserves 1,300 closes across year blocks for 5Y, 2Y and MAX consumers", async () => {
    const rows = Array.from({ length: 1_300 }, (_, index) => {
      const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
      return bar(date, 10 + index / 100);
    });
    const historical = rows.slice(0, -260);
    const years = Array.from(new Set(historical.map((row) => row.date.slice(0, 4))));
    const blocks = await Promise.all(years.map((year) => encodeMarketHistoryBlock(historical.filter((row) => row.date.startsWith(year)))));
    const env = readerEnv(rows.slice(-260), blocks);
    expect(await loadMarketHistory(env, { tickers: ["AAA"], limitPerTicker: 1_291 })).toEqual(rows.slice(-1_291));
    expect(await loadMarketHistory(env, { tickers: ["AAA"], limitPerTicker: 520 })).toEqual(rows.slice(-520));
    expect(await loadMarketHistory(env, { tickers: ["AAA"] })).toEqual(rows);
  });

  it("does not substitute a mismatched source or adjustment from an archive", async () => {
    const archived = await encodeMarketHistoryBlock([{ ...bar("2025-01-02"), adjustment: "raw" }]);
    expect(await loadMarketHistory(readerEnv([], [archived]), { tickers: ["AAA"], sourceProvider: "alpaca", adjustment: "split" }))
      .toEqual([]);
  });

  it("promotes only verified read-back blocks, preserves older rows and bounds previous revisions", async () => {
    const archive = writableArchive();
    const env = { ...readerEnv([]), MARKET_HISTORY_DB: archive.db };
    const first = bar("2025-01-02", 10);
    await archiveMarketHistoryBars(env, [first]);
    const unchangedWrites = archive.state.writes;
    await archiveMarketHistoryBars(env, [first]);
    expect(archive.state.writes).toBe(unchangedWrites);
    await archiveMarketHistoryBars(env, [{ ...first, fetchedAt: "2026-09-09T00:00:00Z", observedAt: "2026-09-09T00:00:00Z" }]);
    expect(archive.state.writes).toBe(unchangedWrites);
    expect(await loadMarketHistory(env, { tickers: ["AAA"] })).toEqual([first]);
    await archiveMarketHistoryBars(env, [bar("2025-01-03", 11)]);
    await archiveMarketHistoryBars(env, [bar("2025-01-03", 12)]);
    expect(await loadMarketHistory(env, { tickers: ["AAA"] })).toEqual([first, bar("2025-01-03", 12)]);
    expect(archive.blocks.size).toBe(2);
    expect(Array.from(archive.blocks.values()).every((block) => Boolean(block.verifiedAt))).toBe(true);
  });

  it("creates a new verified revision for a raw-volume correction even when the close is unchanged", async () => {
    const archive = writableArchive();
    const env = { ...readerEnv([]), MARKET_HISTORY_DB: archive.db };
    const first = bar("2025-01-02", 10);
    await archiveMarketHistoryBars(env, [first]);
    const oldWrites = archive.state.writes;
    const corrected = { ...first, reportedVolume: 9000, fetchedAt: "2026-09-09T00:00:00Z" };
    await archiveMarketHistoryBars(env, [corrected]);
    expect(archive.state.writes).toBeGreaterThan(oldWrites);
    expect(await loadMarketHistory(env, { tickers: ["AAA"] })).toEqual([corrected]);
  });

  it("refuses corrupt read-back and concurrent pointer changes before certifying an archive", async () => {
    for (const failure of ["corruptReadback", "conflict"] as const) {
      const archive = writableArchive();
      archive.state[failure] = true;
      await expect(archiveMarketHistoryBars({ ...readerEnv([]), MARKET_HISTORY_DB: archive.db }, [bar("2025-01-02")]))
        .rejects.toBeInstanceOf(MarketHistoryIntegrityError);
      expect(archive.pointers.size).toBe(0);
    }
  });
});
