import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { createStorageMigration } from "../src/market-storage-control";
import { verifyStorageExpansionBaseline } from "../src/market-storage-population-expansion";
import { canonicalStorageRows, storageHash, type StorageRow, type StorageTable } from "../src/market-storage-pages";

const identity = { id: "market-storage:expansion-baseline", sourceDatabaseId: "10000000-0000-4000-8000-000000000001",
  targetDatabaseId: "10000000-0000-4000-8000-000000000002", historyDatabaseId: "10000000-0000-4000-8000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const now = new Date("2026-09-11T22:00:00Z"), schemaHash = "b".repeat(64);
const pointers: StorageTable = { name: "market_history_block_pointers", key: ["feed", "ticker", "calendar_year"],
  columns: ["feed", "ticker", "calendar_year", "block_id", "previous_block_id", "updated_at"], sql: "" };
const blocks: StorageTable = { name: "market_history_blocks", key: ["id"], columns: ["id", "feed", "ticker", "calendar_year",
  "schema_version", "codec", "checksum", "row_count", "first_date", "last_date", "uncompressed_bytes", "created_at"], sql: "" };
describe("durable original archive inventory for an independent delta reference", { timeout: 30_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  beforeEach(() => { storage = createSqliteD1(); storage.migrate("ops-migrations"); }, 30_000);
  afterEach(() => storage.dispose());
  async function save(key: string, inputHash: string, value: unknown) {
    await storage.db.prepare(`INSERT INTO market_storage_checkpoints(migration_id,checkpoint_key,input_hash,payload_json,updated_at)
      VALUES(?,?,?,?,?)`).bind(identity.id, key, inputHash, JSON.stringify(value), now.toISOString()).run();
  }
  async function fixture(addedIn?: "pointers" | "blocks") {
    const run = await createStorageMigration(storage.db, identity, now), capture = { schemaHash, revision: 7 };
    const captureHash = await storageHash([identity, capture, "history-baseline-v1"]), stateHash = await storageHash([identity, "history-baseline-v1"]);
    await save("history-baseline:capture", stateHash, capture);
    const data = { pointers: Array.from({ length: 75 }, (_, index) => ({ feed: "sip", ticker: `OLD${String(index).padStart(3, "0")}`,
      calendar_year: 2025, block_id: `block${String(index).padStart(3, "0")}`, previous_block_id: null, updated_at: now.toISOString() })),
    blocks: Array.from({ length: 76 }, (_, index) => ({ id: `block${String(index).padStart(3, "0")}`, feed: "sip",
      ticker: `OLD${String(index).padStart(3, "0")}`, calendar_year: 2025, schema_version: 1, codec: "gzip-json-v1",
      checksum: "c".repeat(64), row_count: 250, first_date: "2025-01-02", last_date: "2025-12-31", uncompressed_bytes: 40_000,
      created_at: now.toISOString() })) };
    if (addedIn) data[addedIn][74].ticker = "NEW";
    data.pointers.sort((a, b) => a.ticker.localeCompare(b.ticker));
    const summaries: Array<{ rows: number; hash: string }> = [];
    for (const label of ["blocks", "pointers"] as const) {
      let hash = await storageHash([]), pages = 0;
      const values = data[label] as StorageRow[], table = label === "blocks" ? blocks : pointers;
      for (let offset = 0; offset <= values.length; offset += 50) {
        const page = values.slice(offset, offset + 50);
        await save(`history-baseline:${label}:page:${pages++}`, captureHash, page);
        hash = await storageHash([hash, canonicalStorageRows(table, page)]);
        if (page.length < 50) break;
      }
      await save(`history-baseline:${label}:cursor`, captureHash, { rows: values.length, pages, done: true, hash });
      summaries.push({ rows: values.length, hash });
    }
    const baselineHash = await storageHash(summaries);
    await save("history-baseline:complete", stateHash, { schemaVersion: 1, identity, capture, captureHash,
      blockRows: 76, blockPages: 2, pointerRows: 75, pointerPages: 2, hash: baselineHash });
    const sourceCapture = { schemaHash, revision: 0 }, targetCapture = { schemaHash, revision: 20 }, historyCapture = { schemaHash, revision: 30 };
    const copyHash = await storageHash([identity, sourceCapture, targetCapture, historyCapture, baselineHash, "verification-v1"]);
    await save("verification:complete", copyHash, { schemaVersion: 1, verified: true, identity, captureHash: copyHash,
      sourceCapture, targetCapture, historyCapture, archive: { baselinePointerRows: 75, baselineBlockRows: 76, baselineHash } });
    return { run, captureHash, baselineHash };
  }
  it("uses all 75 pointers and 76 blocks from durable evidence, independently of any local snapshot", async () => {
    const f = await fixture(), before = await storage.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all();
    const proof = await verifyStorageExpansionBaseline(storage.db, f.run, ["FVRR", "NEW"], now);
    expect(proof).toMatchObject({ migrationId: identity.id, baselineHash: f.baselineHash, pointerRows: 75,
      blockRows: 76, pointerPages: 2, blockPages: 2, checkedAt: now.toISOString() });
    expect((await storage.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all()).results).toEqual(before.results);
  });
  it.each(["pointers", "blocks"] as const)("refuses an added ticker retained in the original %s inventory", async kind => {
    const f = await fixture(kind);
    await expect(verifyStorageExpansionBaseline(storage.db, f.run, ["NEW"], now)).rejects.toThrow("original-archive-reference-required");
  });
  it("refuses missing pages and hashes from another capture epoch", async () => {
    const f = await fixture();
    await storage.db.prepare("UPDATE market_storage_checkpoints SET input_hash=? WHERE checkpoint_key='history-baseline:pointers:page:1'")
      .bind("f".repeat(64)).run();
    await expect(verifyStorageExpansionBaseline(storage.db, f.run, ["NEW"], now)).rejects.toThrow("baseline-checkpoint-missing-or-changed");
    await storage.db.prepare("DELETE FROM market_storage_checkpoints WHERE checkpoint_key='history-baseline:pointers:page:1'").run();
    await expect(verifyStorageExpansionBaseline(storage.db, f.run, ["NEW"], now)).rejects.toThrow("baseline-checkpoint-missing-or-changed");
  });
  it("detects a removed archive-only orphan even when the pointed inventory is intact", async () => {
    const f = await fixture();
    const key = "history-baseline:blocks:page:1";
    const value = JSON.parse((await storage.db.prepare("SELECT payload_json FROM market_storage_checkpoints WHERE checkpoint_key=?")
      .bind(key).first<string>("payload_json"))!) as StorageRow[];
    value.pop();
    await storage.db.prepare("UPDATE market_storage_checkpoints SET payload_json=? WHERE checkpoint_key=?").bind(JSON.stringify(value), key).run();
    await expect(verifyStorageExpansionBaseline(storage.db, f.run, ["NEW"], now)).rejects.toThrow("baseline-block-hash-mismatch");
  });
});
