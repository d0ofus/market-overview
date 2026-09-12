import { writeFileSync } from "node:fs";
import { createCapacityLocalSqlite } from "./eod-capacity-local-sqlite";
import { STORAGE_TABLES } from "../src/market-storage-schema";
import { assertReviewedStorageSchema } from "../src/market-storage-copy";
import { assertReviewedStorageHistorySchema } from "../src/market-storage-verification";
import { readStoragePage, readStoragePricePage, storageRowKey, quoteStorageIdentifier, type StorageTable, type StorageRow, type StorageCell } from "../src/market-storage-pages";
import { decodeMarketHistoryBlock, type MarketHistoryBlock } from "../src/market-history";
import { eodHash } from "../src/eod-publication-service";

const ledger: StorageTable = { name: "d1_migrations", columns: ["id", "name", "applied_at"], key: ["id"], sql: "" };
const fence: StorageTable = { name: "market_storage_fence", columns: ["id", "status", "revision", "migration_id", "code_revision", "schema_hash", "snapshot_revision", "frozen_at", "released_at"], key: ["id"], sql: "" };
export const CAPACITY_HISTORY_TABLES: StorageTable[] = [
  { name: "market_history_blocks", columns: ["id", "feed", "ticker", "calendar_year", "schema_version", "codec", "checksum", "row_count", "first_date", "last_date", "uncompressed_bytes", "payload_base64", "created_at", "verified_at"], key: ["id"], sql: "" },
  { name: "market_history_block_pointers", columns: ["feed", "ticker", "calendar_year", "block_id", "previous_block_id", "updated_at"], key: ["feed", "ticker", "calendar_year"], sql: "" },
];
type Local = ReturnType<typeof createCapacityLocalSqlite>;
async function insertRows(local: Local, table: StorageTable, rows: StorageRow[], replace = false): Promise<void> {
  const sql = `INSERT ${replace ? "OR REPLACE " : ""}INTO ${quoteStorageIdentifier(table.name)} (${table.columns.map(quoteStorageIdentifier).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`;
  if (rows.length) await local.db.batch(rows.map((row) => local.db.prepare(sql).bind(...table.columns.map((name) => row[name]))));
}

/** All remote access is through the caller's admitted databases. The caller
 * validates monotonic guards around this entire read-only capture. Local files
 * are disposable measurement inputs, never an authoritative history store. */
export async function captureCapacityDatabase(input: {
  db: D1Database; kind: "market" | "history"; file: string;
  progress: (value: { table: string; rows: number; hash: string }) => Promise<void>;
  assertCurrent: () => Promise<void>;
}): Promise<{ rows: number; hash: string }> {
  if (input.kind === "market") await assertReviewedStorageSchema(input.db); else await assertReviewedStorageHistorySchema(input.db);
  const schema = await input.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name")
    .all<{ type: string; name: string; sql: string }>();
  const objects = schema.results.filter((row) => !row.name.startsWith("sqlite_") && !row.name.startsWith("_cf_"));
  const tables = [...(input.kind === "market" ? STORAGE_TABLES : CAPACITY_HISTORY_TABLES), fence,
    ...(objects.some((row) => row.type === "table" && row.name === ledger.name) ? [ledger] : [])];
  if (objects.filter((row) => row.type === "table").some((row) => !tables.some((table) => table.name === row.name))) {
    throw new Error("eod-capacity-capture-table-not-reviewed");
  }
  const local = createCapacityLocalSqlite(input.file);
  let rows = 0, hash = await eodHash([]);
  try {
    await local.script(objects.filter((row) => row.type === "table").map((row) => row.sql + ";").join("\n"));
    // Real indexes are installed before inserting so the resulting fixture
    // includes their physical allocation. Triggers wait until all data exists.
    await local.script(objects.filter((row) => row.type === "index").map((row) => row.sql + ";").join("\n"));
    for (const table of tables) {
      let cursor: StorageCell[] | null = null;
      for (;;) {
        let page: StorageRow[];
        if (table.name === "market_history_blocks") {
          // Read bounded metadata first, then transport at most 6 MiB of exact
          // payloads in a batch. Large valid blocks cannot overflow REST limits.
          const metadata: StorageTable = { ...table, columns: ["id", "uncompressed_bytes"] };
          const ids = await readStoragePage(input.db, metadata, cursor, 16);
          const loaded: StorageRow[] = [];
          let offset = 0;
          while (offset < ids.length) {
            const selected: StorageRow[] = [];
            let bound = 0;
            // Retain the eight-statement transport bound; exact primary-key
            // reads use the existing narrow accounting class below.
            while (offset < ids.length && selected.length < 8) {
              const estimate = Math.max(4096, Number(ids[offset].uncompressed_bytes) * 2 + 4096);
              if (selected.length && bound + estimate > 6_000_000) break;
              selected.push(ids[offset++]); bound += estimate;
            }
            const response = await input.db.batch<StorageRow>(selected.map((row) => input.db.prepare(
              `SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM market_history_blocks WHERE id=? /* storage-archive-point-read */`).bind(row.id)));
            for (let index = 0; index < response.length; index++) {
              const result = response[index].results;
              if (result.length !== 1 || result[0].id !== selected[index].id) throw new Error("eod-capacity-capture-block-disappeared");
              loaded.push(result[0]);
            }
          }
          page = loaded;
        } else page = table.name === "alpaca_daily_bars" ? await readStoragePricePage(input.db, cursor) : await readStoragePage(input.db, table, cursor, 250);
        await insertRows(local, table, page);
        if (page.length) cursor = storageRowKey(table, page.at(-1)!);
        hash = await eodHash([hash, table.name, page]); rows += page.length;
        if (rows % 10_000 < page.length) {
          await input.assertCurrent();
          await input.progress({ table: table.name, rows, hash });
        }
        if (page.length < (table.name === "market_history_blocks" ? 16 : table.name === "alpaca_daily_bars" ? 1000 : 250)) break;
      }
      await input.progress({ table: table.name, rows, hash });
    }
    await local.script(objects.filter((row) => row.type === "trigger").map((row) => row.sql + ";").join("\n"));
    await input.assertCurrent();
  } finally { await local.close(); }
  writeFileSync(`${input.file}.metadata.json`, JSON.stringify({ complete: true, finishedAt: new Date().toISOString(),
    purpose: "capacity-renewal", consistentFrozenCapture: false, cutoverEvidence: false, rows, hash }));
  return { rows, hash };
}

/** Build an independent full-history reference: decode the captured pointed
 * archive directly, then overlay captured hot rows by their real primary key.
 * This deliberately does not call loadMarketHistory to construct its own oracle.
 * Every actual application reader is subsequently run against this reference. */
export async function flattenCapacityHistory(input: { market: Local; history: Local; reference: Local;
  progress: (rows: number) => Promise<void> }): Promise<void> {
  const needed = ["alpaca_daily_bars", "eod_input_revisions", "eod_adjustment_repairs"];
  const tables = needed.map((name) => STORAGE_TABLES.find((table) => table.name === name)!);
  await input.reference.script(tables.map((table) => table.sql + ";").join("\n"));
  const prices = tables[0];
  let after: StorageCell[] | null = null, rows = 0;
  const pointers = CAPACITY_HISTORY_TABLES[1];
  for (;;) {
    const page = await readStoragePage(input.history.db, pointers, after, 8);
    for (const pointer of page) {
      const block = await input.history.db.prepare(`SELECT id,feed,ticker,calendar_year AS calendarYear,schema_version AS schemaVersion,
        codec,checksum,row_count AS rowCount,first_date AS firstDate,last_date AS lastDate,uncompressed_bytes AS uncompressedBytes,
        payload_base64 AS payloadBase64,verified_at AS verifiedAt FROM market_history_blocks WHERE id=?`).bind(pointer.block_id).first<MarketHistoryBlock>();
      if (!block || !block.verifiedAt || block.feed !== pointer.feed || block.ticker !== pointer.ticker || block.calendarYear !== pointer.calendar_year) {
        throw new Error("eod-capacity-reference-pointer-invalid");
      }
      const decoded = await decodeMarketHistoryBlock(block);
      const values: StorageRow[] = decoded.map((bar) => ({ feed: bar.feed, ticker: bar.ticker, date: bar.date,
        o: bar.o, h: bar.h, l: bar.l, c: bar.c, volume: bar.volume, fetched_at: bar.fetchedAt,
        source_provider: bar.sourceProvider, adjustment: bar.adjustment, observed_at: bar.observedAt,
        reported_volume: bar.reportedVolume ?? null, reported_volume_collected_at: bar.reportedVolumeCollectedAt ?? null }));
      await insertRows(input.reference, prices, values); rows += values.length;
    }
    if (page.length) after = storageRowKey(pointers, page.at(-1)!);
    if (rows % 25_000 < 8 * 366) await input.progress(rows);
    if (page.length < 8) break;
  }
  for (const table of tables) {
    after = null;
    for (;;) {
      const page = await readStoragePage(input.market.db, table, after, 250);
      await insertRows(input.reference, table, page, table.name === "alpaca_daily_bars");
      if (page.length) after = storageRowKey(table, page.at(-1)!);
      if (page.length < 250) break;
    }
  }
  await input.progress(rows);
}
