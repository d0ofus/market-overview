import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCapacityLocalSqlite } from "../scripts/eod-capacity-local-sqlite";
import { captureCapacityDatabase } from "../scripts/eod-capacity-capture";
import { captureStoragePopulationDelta, runStoragePopulationDeltaProof, loadStorageExpansionHistoryReceipt,
  storeStorageExpansionHistoryReceipt } from "../scripts/eod-population-expansion-operator";
import { STORAGE_TARGET_DDL, STORAGE_BUSINESS_DDL, copyStorageArchiveBlock } from "../src/market-storage-copy";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { releaseStorageVerificationFence, inspectStorageHistoryPointerIndexSchema } from "../src/market-storage-verification";
import { createStorageMigration, loadStorageMigration } from "../src/market-storage-control";
import { storageHash, canonicalStorageRows, type StorageTable, type StorageRow } from "../src/market-storage-pages";
import { verifyStorageExpansionBaseline } from "../src/market-storage-population-expansion";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import type { StoragePopulationPlan } from "../src/market-storage-population-plan";
import type { Env } from "../src/types";
import type { MarketHistoryBar } from "../src/market-history";

const identity = { id: "market-storage:expansion-operator", sourceDatabaseId: "10000000-0000-4000-8000-000000000001",
  targetDatabaseId: "10000000-0000-4000-8000-000000000002", historyDatabaseId: "10000000-0000-4000-8000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const added = ["APWC", "AVD", "EIM", "FVRR", "GFL", "HLSQ", "NEA", "NMZ", "TX", "USAS", "VIST"];
const populated = ["FVRR", "GFL", "TX", "USAS", "VIST"];
const pointerTable: StorageTable = { name: "market_history_block_pointers", key: ["feed", "ticker", "calendar_year"],
  columns: ["feed", "ticker", "calendar_year", "block_id", "previous_block_id", "updated_at"], sql: "" };
const blockTable: StorageTable = { name: "market_history_blocks", key: ["id"], columns: ["id", "feed", "ticker", "calendar_year",
  "schema_version", "codec", "checksum", "row_count", "first_date", "last_date", "uncompressed_bytes", "created_at"], sql: "" };

describe("explicit append-only population operator", { timeout: 180_000 }, () => {
  let directory: string;
  const locals: Array<ReturnType<typeof createCapacityLocalSqlite>> = [];
  const local = (name: string) => { const value = createCapacityLocalSqlite(join(directory, `${name}.sqlite`)); locals.push(value); return value; };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "eod-expansion-operator-test-")); });
  afterEach(async () => {
    await Promise.all(locals.splice(0).map(value => value.close()));
    const resolved = resolve(directory), base = resolve(tmpdir());
    if (!resolved.startsWith(base + (base.includes("\\") ? "\\" : "/")) || !resolved.includes("eod-expansion-operator-test-")) throw new Error("unsafe-cleanup");
    rmSync(resolved, { recursive: true, force: true });
  });
  async function fixture() {
    const source = local("source"), target = local("target"), history = local("history"), ops = local("ops");
    await ops.script(readdirSync(resolve("ops-migrations")).filter(name => name.endsWith(".sql")).sort()
      .map(name => readFileSync(resolve("ops-migrations", name), "utf8")).join("\n"));
    for (const db of [source, target]) {
      await db.script([...STORAGE_TARGET_DDL, ...STORAGE_BUSINESS_DDL].join(";\n"));
      await db.script("INSERT INTO market_storage_fence(id) VALUES('default'); INSERT INTO eod_input_clock(id,revision) VALUES('default',0);");
    }
    await history.script(readFileSync(resolve("history-migrations/0001_history.sql"), "utf8")
      + readFileSync(resolve("history-migrations/0002_market_storage_fence.sql"), "utf8"));
    const dates: string[] = [];
    for (const date = new Date(`${identity.sessionDate}T00:00:00Z`); dates.length < 544; date.setUTCDate(date.getUTCDate() - 1)) {
      if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    }
    const bar = (ticker: string, date: string, index: number): MarketHistoryBar => ({ ticker, date, feed: "sip", sourceProvider: "alpaca", adjustment: "split",
      o: 100 + index / 20, h: 102 + index / 20, l: 99 + index / 20, c: 101 + index / 20, volume: 1000,
      reportedVolume: null, reportedVolumeCollectedAt: null, observedAt: `${date}T21:00:00Z`, fetchedAt: `${date}T21:00:00Z` });
    // Actual full retained source histories: 524 + four*544; six members really have no source bars.
    const bars = populated.flatMap(ticker => dates.slice(ticker === "FVRR" ? 20 : 0).map((date, index) => bar(ticker, date, index)));
    await source.db.batch(bars.map(value => source.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,
      source_provider,adjustment,observed_at,fetched_at,reported_volume,reported_volume_collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(value.feed, value.ticker, value.date, value.o, value.h, value.l, value.c, value.volume,
        value.sourceProvider, value.adjustment, value.observedAt, value.fetchedAt, null, null)));
    await copyStorageArchiveBlock(history.db, [bar("OLD", "2026-09-04", 0)]);
    const captures = [];
    for (const db of [source, target, history]) {
      const plan = await prepareStorageSourceFence(db.db); await db.script(plan.statements.map(row => row.sql).join("\n"));
      captures.push(await freezeStorageSource(db.db, identity, plan.schemaHash));
    }
    const [sourceCapture, targetCapture, historyCapture] = captures;
    const pointers = (await history.db.prepare("SELECT * FROM market_history_block_pointers ORDER BY feed,ticker,calendar_year").all<StorageRow>()).results;
    const blocks = (await history.db.prepare(`SELECT ${blockTable.columns.join(",")} FROM market_history_blocks ORDER BY id`).all<StorageRow>()).results;
    const empty = await storageHash([]), pointerHash = await storageHash([empty, canonicalStorageRows(pointerTable, pointers)]),
      blockHash = await storageHash([empty, canonicalStorageRows(blockTable, blocks)]);
    const baselineHash = await storageHash([{ rows: blocks.length, hash: blockHash }, { rows: pointers.length, hash: pointerHash }]);
    const baselineCapture = await storageHash([identity, historyCapture, "history-baseline-v1"]);
    const copyHash = await storageHash([identity, sourceCapture, targetCapture, historyCapture, baselineHash, "verification-v1"]);
    await createStorageMigration(ops.db, identity);
    const store = async (key: string, inputHash: string, payload: unknown) => ops.db.prepare(`INSERT INTO market_storage_checkpoints
      (migration_id,checkpoint_key,input_hash,payload_json,updated_at) VALUES(?,?,?,?,?)`).bind(identity.id, key, inputHash, JSON.stringify(payload), new Date().toISOString()).run();
    await store("history-baseline:complete", await storageHash([identity, "history-baseline-v1"]), { schemaVersion: 1, identity,
      capture: historyCapture, captureHash: baselineCapture, blockRows: blocks.length, blockPages: 1, pointerRows: pointers.length, pointerPages: 1, hash: baselineHash });
    await store("history-baseline:capture", await storageHash([identity, "history-baseline-v1"]), historyCapture);
    await store("history-baseline:pointers:cursor", baselineCapture, { rows: pointers.length, pages: 1, done: true, hash: pointerHash });
    await store("history-baseline:blocks:cursor", baselineCapture, { rows: blocks.length, pages: 1, done: true, hash: blockHash });
    await store("history-baseline:pointers:page:0", baselineCapture, pointers);
    await store("history-baseline:blocks:page:0", baselineCapture, blocks);
    await store("verification:complete", copyHash, { schemaVersion: 1, verified: true, identity, captureHash: copyHash,
      sourceCapture, targetCapture, historyCapture, prices: { sourceRows: bars.length },
      archive: { baselineHash, baselinePointerRows: pointers.length, baselineBlockRows: blocks.length } });
    await releaseStorageVerificationFence(target.db, identity, targetCapture);
    await releaseStorageVerificationFence(history.db, identity, historyCapture);
    await history.script(readFileSync(resolve("history-migrations/0003_history_pointer_indexes.sql"), "utf8"));
    const amendment = await inspectStorageHistoryPointerIndexSchema(history.db, identity, historyCapture, { historyDatabaseId: identity.historyDatabaseId, policy: "indexed" });
    const groups = new Map<string, MarketHistoryBar[]>();
    for (const value of bars) { const key = `${value.ticker}:${value.date.slice(0, 4)}`; const group = groups.get(key) ?? []; group.push(value); groups.set(key, group); }
    for (const group of groups.values()) await copyStorageArchiveBlock(history.db, group);
    const run = (await loadStorageMigration(ops.db, identity.id))!;
    const fields = { identity, sourceCapture, targetCapture, historyCapture };
    const previousPlan = { planHash: "b".repeat(64), tickers: ["OLD"], calendarDates: dates,
      capture: { ...fields, captureHash: await storageHash(fields) } } as StoragePopulationPlan;
    const captureInput = { source: source.db, target: target.db, history: history.db, run, previousPlan, amendment };
    const captured = await captureStoragePopulationDelta(captureInput);
    const assertCapture = async () => expect(await captureStoragePopulationDelta(captureInput)).toEqual(captured);
    const sourceEnv = { DB: source.db, MARKET_DATA_DB: source.db } as Env;
    const targetEnv = { DB: target.db, MARKET_DATA_DB: target.db, MARKET_HISTORY_DB: history.db } as Env;
    const input = { ops: ops.db, run, previousPlan, nextInputsHash: "c".repeat(64), sourceEnv, targetEnv,
      capture: captured.capture, addedTickers: added, assertCapture, assertQuiescence: async () => undefined };
    return { source, target, history, ops, run, bars, input, captureInput, captured, baselineHash };
  }
  it("runs all ten actual readers only for the 11 additions and resumes immutable pages without redating old proof", async () => {
    const f = await fixture();
    const old = (await f.ops.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all()).results;
    const first = await runStoragePopulationDeltaProof({ ...f.input, maxPages: 1 });
    expect(first).toMatchObject({ complete: false, pageCount: 1, checkpoint: { nextTicker: 10 } });
    const resumed = await runStoragePopulationDeltaProof(f.input);
    expect(resumed).toMatchObject({ complete: true, pageCount: 2, evidence: { tickerCount: 11, history: { missing: 6 } } });
    expect(resumed.evidence!.checks["ticker-max"].observations).toBe(524 + 4 * 544);
    expect(Object.values(resumed.evidence!.checks).every(value => value.tickers === 11)).toBe(true);
    expect((await f.ops.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all()).results).toEqual(old);
    expect(await runStoragePopulationDeltaProof(f.input)).toEqual(resumed);
    await expect(verifyStorageExpansionBaseline(f.ops.db, f.run, ["OLD"])).rejects.toThrow("original-archive-reference-required");
  });
  it("does not persist a page on quota interruption, refuses corrupt durable pages, and checks the current revision", async () => {
    const f = await fixture();
    const quota = vi.fn(async () => { throw new Error("eod-resource-budget-exhausted"); });
    await expect(runStoragePopulationDeltaProof({ ...f.input, assertCapture: quota })).rejects.toThrow("eod-resource-budget-exhausted");
    expect(await f.ops.db.prepare("SELECT COUNT(*) AS n FROM eod_rollout_evidence").first<number>("n")).toBe(0);
    await runStoragePopulationDeltaProof({ ...f.input, maxPages: 1 });
    await f.ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.checkpoint.nextTicker',11)").run();
    await expect(runStoragePopulationDeltaProof(f.input)).rejects.toThrow("checkpoint-integrity");
    await f.target.db.prepare("UPDATE eod_input_clock SET revision=revision+1 WHERE id='default'").run();
    expect(await captureStoragePopulationDelta(f.captureInput)).not.toEqual(f.captured);
    await expect(runStoragePopulationDeltaProof(f.input)).rejects.toThrow();
  });
  it("recovers a lost Ops write acknowledgement from the actual stored page without repeating or redating it", async () => {
    const f = await fixture();
    let lose = true;
    const ops = { ...f.ops.db, prepare: (sql: string) => {
      const actual = f.ops.db.prepare(sql);
      if (!sql.startsWith("INSERT INTO eod_rollout_evidence")) return actual;
      return { bind: (...values: unknown[]) => ({ run: async () => {
        const result = await actual.bind(...values).run();
        if (lose) { lose = false; throw new Error("d1-network-error"); }
        return result;
      } }) };
    } } as D1Database;
    await expect(runStoragePopulationDeltaProof({ ...f.input, ops })).rejects.toThrow("d1-network-error");
    const first = (await f.ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results;
    expect(first).toHaveLength(1);
    const resumed = await runStoragePopulationDeltaProof(f.input);
    expect(resumed.complete).toBe(true);
    expect((await f.ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results[0]).toEqual(first[0]);
  });
  it("rejects a live writer, a changed guard literal and a tampered original archive page before accepting evidence", async () => {
    const f = await fixture();
    await expect(runStoragePopulationDeltaProof({ ...f.input, assertQuiescence: async () => { throw new Error("writer-present"); } })).rejects.toThrow("writer-present");
    await f.ops.db.prepare("UPDATE market_storage_checkpoints SET payload_json='[]' WHERE checkpoint_key='history-baseline:blocks:page:0'").run();
    await expect(runStoragePopulationDeltaProof(f.input)).rejects.toThrow("baseline-block-hash-mismatch");
    const plan = await prepareStorageSourceFence(f.target.db), guard = plan.statements[0].sql;
    const name = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(guard)![1];
    await f.target.script(`DROP TRIGGER ${name};` + guard.replace("'frozen'", "'fro zen'"));
    await expect(captureStoragePopulationDelta(f.captureInput)).rejects.toThrow("target-guards-changed");
  });
  it("captures all current retained revisions with real FK indexes and feeds the real full-population SQLite capacity oracle", async () => {
    const f = await fixture();
    // Preserve an old unpointed revision; it must contribute to the model too.
    await copyStorageArchiveBlock(f.history.db, [{ ...f.bars[0], c: f.bars[0].c + 0.25 }]);
    const captured = await captureStoragePopulationDelta(f.captureInput);
    const assertCurrent = async () => expect(await captureStoragePopulationDelta(f.captureInput)).toEqual(captured);
    const historyFile = join(directory, "captured-current-history.sqlite");
    const result = await captureCapacityDatabase({ db: f.history.db, kind: "history", file: historyFile, assertCurrent, progress: async () => undefined });
    expect(result.rows).toBeGreaterThan(25);
    const receiptIdentity = { migrationId: identity.id, codeRevision: identity.codeRevision, previousPlanHash: f.input.previousPlan.planHash,
      nextInputsHash: f.input.nextInputsHash, captureHash: captured.capture.captureHash, historyDatabaseId: identity.historyDatabaseId };
    const receiptFields = { directory, file: "history-1.sqlite", ...result,
      fileHash: createHash("sha256").update(readFileSync(historyFile)).digest("hex"), capturedAt: new Date().toISOString() };
    const receipt = await storeStorageExpansionHistoryReceipt(f.ops.db, receiptIdentity, receiptFields);
    expect(await loadStorageExpansionHistoryReceipt(f.ops.db, receiptIdentity)).toEqual(receipt);
    await expect(storeStorageExpansionHistoryReceipt(f.ops.db, receiptIdentity, { ...receiptFields, fileHash: "a".repeat(64) }))
      .rejects.toThrow("history-receipt-write-conflict");
    expect(await loadStorageExpansionHistoryReceipt(f.ops.db, receiptIdentity)).toEqual(receipt);
    expect(await loadStorageExpansionHistoryReceipt(f.ops.db, { ...receiptIdentity, captureHash: "e".repeat(64) })).toBeNull();
    const capturedDb = createCapacityLocalSqlite(historyFile); locals.push(capturedDb);
    expect((await capturedDb.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'idx_market_history_pointers_%' ORDER BY name").all()).results).toHaveLength(2);
    expect((await capturedDb.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results)
      .toEqual((await f.history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results);
    const sourceFile = join(directory, "source.sqlite"), tickerFile = join(directory, "tickers.json"), output = join(directory, "analysis.json");
    writeFileSync(sourceFile + ".metadata.json", JSON.stringify({ complete: true, finishedAt: new Date().toISOString(), purpose: "capacity-estimate", consistentFrozenCapture: false, cutoverEvidence: false }));
    writeFileSync(tickerFile, JSON.stringify({ tickers: ["OLD", ...added].sort() }));
    execFileSync("python", [resolve("scripts/analyze-eod-storage.py"), "--source-sqlite", sourceFile, "--history-sqlite", historyFile,
      "--tickers-json", tickerFile, "--session-date", identity.sessionDate, "--output", output],
    { windowsHide: true, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1_000_000 });
    const analysis = JSON.parse(readFileSync(output, "utf8"));
    const prepared = await prepareStoragePreflight({ analysis, identity, tickers: ["OLD", ...added].sort(),
      snapshotSource: { accountId: "d".repeat(32), sourceDatabaseId: identity.sourceDatabaseId, runId: "eod:shadow:2026-09-08:daily" },
      accountId: "d".repeat(32), sourceSchemaHash: f.captured.capture.sourceCapture.schemaHash, hotSessions: 90 });
    expect(prepared.evidence).toMatchObject({ hotSessions: 90, tickerCount: 12, planningReserveBytes: 64_000_000, productionAcceptance: false });
    expect(analysis.archive.existingBlocksVerified).toBe((await f.history.db.prepare("SELECT COUNT(*) AS n FROM market_history_blocks").first<number>("n")));
  });
});
